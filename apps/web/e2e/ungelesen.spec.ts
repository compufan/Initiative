import { execSync } from 'node:child_process';

import {
  expect,
  request,
  test,
  type APIRequestContext,
  type Browser,
  type Page,
} from '@playwright/test';

/**
 * Gelesenes bleibt nicht „neu“, Eigenes war es nie.
 *
 * Gemeldet: Auch in der App gelesene Nachrichten kamen als Push und standen in
 * der Chatliste als neu da (sogar die eigenen). Zwei Browser, zwei Konten:
 *
 *  - Wer schreibt, sieht die eigene Nachricht nie als neu.
 *  - Wer den Chat offen hat, zählt 0 – in der Liste dahinter und auf dem
 *    Server – und der Server weiss, dass der Chat offen ist (kein Push).
 *  - Wer den Chat nicht offen hat, zählt hoch.
 *  - Liest dasselbe Konto auf einem zweiten Gerät, fällt der Zähler auch dort.
 */

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:8080';
const API = `${API_URL}/api/v1`;
const DB = process.env.E2E_DB_URL;

interface Sitzung {
  accessToken: string;
  refreshToken: string;
  user: { id: string; displayName: string };
}

async function registrieren(http: APIRequestContext, prefix: string): Promise<Sitzung> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const antwort = await http.post(`${API}/auth/register`, {
    data: {
      username: `${prefix}${suffix}`,
      password: 'passwort123',
      displayName: `${prefix.toUpperCase()} ${suffix}`,
    },
  });
  expect(antwort.ok(), `Registrierung: ${antwort.status()}`).toBeTruthy();
  return antwort.json();
}

async function seiteFuer(browser: Browser, sitzung: Sitzung, wurzel: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(wurzel);
  await page.evaluate((werte) => localStorage.setItem('initiative.tokens', JSON.stringify(werte)), {
    accessToken: sitzung.accessToken,
    refreshToken: sitzung.refreshToken,
    expiresAt: Date.now() + 3_600_000,
  });
  await page.goto(wurzel);
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible({ timeout: 15_000 });
  return page;
}

async function senden(http: APIRequestContext, von: Sitzung, chat: string, text: string) {
  const antwort = await http.post(`${API}/conversations/${chat}/messages`, {
    headers: { authorization: `Bearer ${von.accessToken}` },
    data: { type: 'text', body: text },
  });
  expect(antwort.ok(), `Senden: ${antwort.status()}`).toBeTruthy();
}

/** Was der Server für diese Person zählt. */
async function serverZaehler(http: APIRequestContext, wer: Sitzung, chat: string) {
  const antwort = await http.get(`${API}/conversations`, {
    headers: { authorization: `Bearer ${wer.accessToken}` },
  });
  const { items } = (await antwort.json()) as {
    items: Array<{ id: string; unreadCount: number }>;
  };
  return items.find((eintrag) => eintrag.id === chat)?.unreadCount;
}

function offeneChats(person: string): number | null {
  if (!DB) return null;
  const aus = execSync(
    `psql "${DB}" -tA -c "select count(*) from chat_offen where user_id = '${person}' and bis > now()"`,
  );
  return Number(aus.toString().trim());
}

const abzeichen = (seite: Page) => seite.locator('.chat-row .chat-badge');

test('Zähler: eigene nie, offener Chat 0, geschlossener hoch, zweites Gerät', async ({
  browser,
  baseURL,
}) => {
  const http = await request.newContext();
  const a = await registrieren(http, 'una');
  const b = await registrieren(http, 'unb');
  const antwort = await http.post(`${API}/conversations`, {
    headers: { authorization: `Bearer ${a.accessToken}` },
    data: { type: 'direct', memberIds: [b.user.id] },
  });
  expect(antwort.ok()).toBeTruthy();
  const chat = (await antwort.json()).id as string;

  const seiteA = await seiteFuer(browser, a, baseURL!);
  const seiteB = await seiteFuer(browser, b, baseURL!);
  const zeileA = seiteA.locator('.chat-row').first();
  const zeileB = seiteB.locator('.chat-row').first();

  // A schreibt, B hat die Liste offen: für B neu, für A nie.
  await senden(http, a, chat, 'erste');
  await expect(zeileB).toContainText('erste');
  await expect(abzeichen(seiteB)).toHaveText('1');
  await expect(zeileA).toContainText('erste');
  await expect(abzeichen(seiteA)).toHaveCount(0);
  expect(await serverZaehler(http, a, chat)).toBe(0);

  // A schreibt aus der App selbst (zweites Konto-Gerät wäre dasselbe): nie neu.
  await zeileA.click();
  const feld = seiteA.getByPlaceholder(/Nachricht/i);
  await feld.fill('von mir');
  await feld.press('Enter');
  await expect(seiteA.getByText('von mir')).toBeVisible();
  await seiteA.goBack();
  await expect(zeileA).toContainText('von mir');
  await expect(abzeichen(seiteA)).toHaveCount(0);

  // B öffnet den Chat: Zähler 0, der Server weiss es, der Chat gilt als offen.
  await zeileB.click();
  await expect(seiteB.getByText('erste')).toBeVisible();
  await expect.poll(() => serverZaehler(http, b, chat), { timeout: 10_000 }).toBe(0);
  if (DB) await expect.poll(() => offeneChats(b.user.id), { timeout: 10_000 }).toBe(1);

  // A schreibt, während B den Chat offen hat: B zählt nichts – auch nicht, wenn
  // er danach zur Liste zurückgeht, und der Server zählt ebenfalls 0.
  await senden(http, a, chat, 'zweite');
  await expect(seiteB.getByText('zweite')).toBeVisible();
  await expect.poll(() => serverZaehler(http, b, chat), { timeout: 10_000 }).toBe(0);
  await seiteB.goBack();
  await expect(zeileB).toContainText('zweite');
  await expect(abzeichen(seiteB)).toHaveCount(0);
  if (DB) await expect.poll(() => offeneChats(b.user.id), { timeout: 10_000 }).toBe(0);

  // B ist nicht (mehr) im Chat: die nächste Nachricht zählt.
  await senden(http, a, chat, 'dritte');
  await expect(abzeichen(seiteB)).toHaveText('1');
  expect(await serverZaehler(http, b, chat)).toBe(1);

  // Zweites Gerät von B liest: der Zähler fällt auf dem ersten Gerät.
  const seiteB2 = await seiteFuer(browser, b, baseURL!);
  await expect(abzeichen(seiteB2)).toHaveText('1');
  await seiteB2.locator('.chat-row').first().click();
  await expect(seiteB2.getByText('dritte')).toBeVisible();
  await expect(abzeichen(seiteB)).toHaveCount(0, { timeout: 10_000 });
});
