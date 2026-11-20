import {
  expect,
  request,
  test,
  type APIRequestContext,
  type Browser,
  type Page,
} from '@playwright/test';

/**
 * Gruppenverwaltung, Einladungslinks, Chatliste je Person, Sperren,
 * Privatsphäre und Geräteliste – mit zwei und drei Browsern gegen den echten
 * Server.
 *
 *  - Umbenennen und Beschreibung in der Chat-Info; die anderen sehen die
 *    Systemzeile.
 *  - Ein Einladungslink zeigt vor dem Beitritt nichts aus dem Chat; danach
 *    sieht man ab dem Beitritt.
 *  - Zum Admin machen, „nur Admins senden“.
 *  - Chatliste: anheften, als ungelesen markieren, Filter, Ordner, Archiv
 *    per Taste, Wischen per Finger.
 *  - Blockieren, „zuletzt online: niemand“, Geräte abmelden.
 */

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:8080';
const API = `${API_URL}/api/v1`;

interface Sitzung {
  accessToken: string;
  refreshToken: string;
  user: { id: string; displayName: string; username: string };
}

function kopf(wer: Sitzung) {
  return { authorization: `Bearer ${wer.accessToken}` };
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

async function anmelden(http: APIRequestContext, wer: Sitzung): Promise<Sitzung> {
  const antwort = await http.post(`${API}/auth/login`, {
    data: { username: wer.user.username, password: 'passwort123' },
  });
  expect(antwort.ok(), `Anmelden: ${antwort.status()}`).toBeTruthy();
  return antwort.json();
}

async function seiteFuer(browser: Browser, sitzung: Sitzung, pfad = '/chats'): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/chats');
  await page.evaluate((werte) => localStorage.setItem('initiative.tokens', JSON.stringify(werte)), {
    accessToken: sitzung.accessToken,
    refreshToken: sitzung.refreshToken,
    expiresAt: Date.now() + 3_600_000,
  });
  await page.goto(pfad);
  return page;
}

async function chatAnlegen(
  http: APIRequestContext,
  von: Sitzung,
  andere: Sitzung[],
  titel?: string,
): Promise<string> {
  const antwort = await http.post(`${API}/conversations`, {
    headers: kopf(von),
    data: titel
      ? { type: 'group', title: titel, memberIds: andere.map((s) => s.user.id) }
      : { type: 'direct', memberIds: andere.map((s) => s.user.id) },
  });
  expect(antwort.ok(), `Chat: ${antwort.status()}`).toBeTruthy();
  return (await antwort.json()).id;
}

async function senden(http: APIRequestContext, von: Sitzung, chat: string, text: string) {
  return http.post(`${API}/conversations/${chat}/messages`, {
    headers: kopf(von),
    data: { type: 'text', body: text },
  });
}

async function infoOeffnen(page: Page) {
  await page.getByRole('button', { name: 'Chat-Info öffnen' }).click();
  await expect(page.getByRole('dialog', { name: 'Chat-Info' })).toBeVisible();
}

test('Gruppe verwalten, per Link beitreten ohne Einblick vorher, Admin machen', async ({
  browser,
}) => {
  const http = await request.newContext();
  const anna = await registrieren(http, 'gva');
  const bodo = await registrieren(http, 'gvb');
  const cleo = await registrieren(http, 'gvc');
  const gruppe = await chatAnlegen(http, anna, [bodo], 'Runde');
  expect((await senden(http, anna, gruppe, 'Geheimplan vor dem Link')).ok()).toBeTruthy();

  const seiteA = await seiteFuer(browser, anna, `/chats/${gruppe}`);
  const seiteB = await seiteFuer(browser, bodo, `/chats/${gruppe}`);
  await expect(seiteB.getByText('Geheimplan vor dem Link')).toBeVisible({ timeout: 15_000 });

  // Umbenennen und Beschreibung.
  await infoOeffnen(seiteA);
  await seiteA.getByRole('button', { name: /Name und Beschreibung/ }).click();
  await seiteA.getByLabel('Gruppenname').fill('Grillrunde');
  await seiteA.getByLabel('Beschreibung').fill('Samstags am See.');
  await seiteA.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(seiteA.getByText('Samstags am See.')).toBeVisible();
  // Bodo sieht die Systemzeile, ohne neu zu laden.
  await expect(seiteB.getByText(/in „Grillrunde“ umbenannt/)).toBeVisible({ timeout: 15_000 });

  // Einladungslink erstellen.
  await seiteA.getByRole('button', { name: /Einladungslink erstellen/ }).click();
  await seiteA.getByRole('button', { name: 'Link erstellen' }).click();
  const adresse = (await seiteA.locator('.gv-link code').first().textContent()) ?? '';
  expect(adresse).toContain('/join/');
  const token = adresse.split('/join/')[1]!;

  // Cleo: Vorschau ohne Inhalt, dann beitreten.
  const seiteC = await seiteFuer(browser, cleo, `/join/${token}`);
  await expect(seiteC.getByRole('heading', { name: 'Grillrunde' })).toBeVisible({ timeout: 15_000 });
  await expect(seiteC.getByText('2 Mitglieder')).toBeVisible();
  await expect(seiteC.getByText('Geheimplan vor dem Link')).toHaveCount(0);
  await seiteC.getByRole('button', { name: 'Gruppe beitreten' }).click();
  await expect(seiteC).toHaveURL(new RegExp(`/chats/${gruppe}`));
  await expect(seiteC.getByText(/über einen Einladungslink beigetreten/)).toBeVisible({
    timeout: 15_000,
  });
  await expect(seiteC.getByText('Geheimplan vor dem Link')).toHaveCount(0);

  // Bodo zum Admin machen – im Mitglied-Blatt.
  await seiteA.getByRole('button', { name: new RegExp(`${bodo.user.displayName}, Mitglied`) }).click();
  await seiteA.getByRole('button', { name: /Zum Admin machen/ }).click();
  await expect(seiteB.getByText(/zum Admin gemacht/)).toBeVisible({ timeout: 15_000 });

  // Nur Admins senden: Cleo (Mitglied) kann nicht mehr schreiben.
  await seiteA.getByRole('switch', { name: /Nur Admins dürfen senden/ }).click();
  await expect(seiteA.getByRole('switch', { name: /Nur Admins dürfen senden/ })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  expect((await senden(http, cleo, gruppe, 'darf ich?')).status()).toBe(403);
  expect((await senden(http, bodo, gruppe, 'Admin darf')).ok()).toBeTruthy();

  await http.dispose();
  for (const seite of [seiteA, seiteB, seiteC]) await seite.context().close();
});

test('Chatliste: anheften, ungelesen, Filter, Ordner, Archiv per Taste, Wischen', async ({
  browser,
}) => {
  const http = await request.newContext();
  const anna = await registrieren(http, 'cla');
  const bodo = await registrieren(http, 'clb');
  const cleo = await registrieren(http, 'clc');
  const mitBodo = await chatAnlegen(http, anna, [bodo]);
  const mitCleo = await chatAnlegen(http, anna, [cleo]);
  expect((await senden(http, anna, mitBodo, 'Hallo Bodo')).ok()).toBeTruthy();
  expect((await senden(http, anna, mitCleo, 'Hallo Cleo')).ok()).toBeTruthy();

  const seite = await seiteFuer(browser, anna);
  // Telefonbreite: Hier wird gewischt, und hier muss alles passen.
  await seite.setViewportSize({ width: 375, height: 740 });
  const zeile = (chat: string) => seite.locator(`a.chat-row[href="/chats/${chat}"]`);
  await expect(zeile(mitBodo)).toBeVisible({ timeout: 15_000 });

  // Anheften über das Menü der Zeile.
  await seite.getByRole('button', { name: `Aktionen für ${cleo.user.displayName}` }).click();
  await seite.getByRole('button', { name: /Anheften/ }).click();
  await expect(seite.locator('a.chat-row').first()).toHaveAttribute('href', `/chats/${mitCleo}`);
  await expect(zeile(mitCleo).getByLabel('angeheftet')).toBeVisible();

  // Als ungelesen markieren: Punkt, und der Filter „Ungelesen“ zeigt nur ihn.
  await seite.getByRole('button', { name: `Aktionen für ${bodo.user.displayName}` }).click();
  await seite.getByRole('button', { name: /Als ungelesen markieren/ }).click();
  await expect(zeile(mitBodo).getByLabel('als ungelesen markiert')).toBeVisible();
  await seite.getByRole('button', { name: /^Ungelesen/ }).click();
  await expect(zeile(mitBodo)).toBeVisible();
  await expect(zeile(mitCleo)).toHaveCount(0);
  // Öffnen setzt die Markierung zurück.
  await zeile(mitBodo).click();
  await expect(seite.getByText('Hallo Bodo')).toBeVisible();
  await seite.goto('/chats');
  await seite.getByRole('button', { name: 'Alle', exact: true }).click();
  await expect(zeile(mitBodo).getByLabel('als ungelesen markiert')).toHaveCount(0);

  // Wischen nach rechts (Finger): wieder als ungelesen.
  const wrap = seite.locator('.chat-row-wrap', { has: zeile(mitBodo) });
  const box = (await wrap.boundingBox())!;
  const y = box.y + box.height / 2;
  const x = box.x + 40;
  const zeiger = { pointerType: 'touch', isPrimary: true, pointerId: 7, bubbles: true };
  await wrap.dispatchEvent('pointerdown', { ...zeiger, clientX: x, clientY: y, button: 0 });
  await wrap.dispatchEvent('pointermove', { ...zeiger, clientX: x + 80, clientY: y });
  await wrap.dispatchEvent('pointermove', { ...zeiger, clientX: x + 160, clientY: y });
  await wrap.dispatchEvent('pointerup', { ...zeiger, clientX: x + 160, clientY: y });
  await expect(zeile(mitBodo).getByLabel('als ungelesen markiert')).toBeVisible();

  // Eigener Ordner mit Cleo.
  await seite.getByRole('button', { name: 'Neuer Ordner' }).click();
  await seite.getByLabel('Name').fill('Arbeit');
  await seite.getByRole('checkbox', { name: cleo.user.displayName }).check();
  await seite.getByRole('button', { name: /Ordner anlegen/ }).click();
  await expect(seite.getByRole('button', { name: /Arbeit/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(zeile(mitCleo)).toBeVisible();
  await expect(zeile(mitBodo)).toHaveCount(0);
  await seite.getByRole('button', { name: 'Alle', exact: true }).click();

  // Archivieren per Taste (Entf) – die Alternative zum Wischen nach links.
  await zeile(mitBodo).focus();
  await seite.keyboard.press('Delete');
  await expect(zeile(mitBodo)).toHaveCount(0);
  await seite.getByRole('button', { name: 'Archiv', exact: true }).click();
  await expect(zeile(mitBodo)).toBeVisible({ timeout: 15_000 });

  // 375 px: keine waagerechte Rolle der Seite.
  const breite = await seite.evaluate(() => document.documentElement.scrollWidth);
  expect(breite).toBeLessThanOrEqual(375);

  await http.dispose();
  await seite.context().close();
});

test('Blockieren, zuletzt online verbergen, andere Geräte abmelden', async ({ browser }) => {
  const http = await request.newContext();
  const anna = await registrieren(http, 'bla');
  const bodo = await registrieren(http, 'blb');
  const direkt = await chatAnlegen(http, anna, [bodo]);
  expect((await senden(http, anna, direkt, 'Hallo')).ok()).toBeTruthy();

  // Bodo: zuletzt online „Niemand“.
  const seiteB = await seiteFuer(browser, bodo, '/profil/einstellungen');
  const zuletzt = seiteB.getByRole('radiogroup', { name: 'Zuletzt online' });
  await zuletzt.getByRole('radio', { name: 'Niemand' }).click();
  await expect(zuletzt.getByRole('radio', { name: 'Niemand' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  const profil = await (
    await http.get(`${API}/users/${bodo.user.id}`, { headers: kopf(anna) })
  ).json();
  expect(profil.lastSeenAt).toBeNull();

  // Bodo blockiert Anna in der Chat-Info.
  await seiteB.goto(`/chats/${direkt}`);
  await infoOeffnen(seiteB);
  await seiteB.getByRole('button', { name: new RegExp(`${anna.user.displayName} blockieren`) }).click();
  await expect(
    seiteB.getByRole('button', { name: new RegExp(`${anna.user.displayName} freigeben`) }),
  ).toBeVisible();
  expect((await senden(http, anna, direkt, 'geht nicht')).status()).toBe(403);
  const suche = await (
    await http.get(`${API}/users?q=${bodo.user.username}`, { headers: kopf(anna) })
  ).json();
  expect(suche.items).toHaveLength(0);

  // Die Blockliste in den Einstellungen – und freigeben.
  await seiteB.goto('/profil/einstellungen');
  await seiteB.getByRole('button', { name: `${anna.user.displayName} freigeben` }).click();
  await expect(seiteB.getByText(/Niemand\. Blockieren kannst du/)).toBeVisible();
  expect((await senden(http, anna, direkt, 'wieder da')).ok()).toBeTruthy();

  // Geräte: Anna auf zwei Geräten, das erste meldet das zweite ab.
  const annaZwei = await anmelden(http, anna);
  const seiteA1 = await seiteFuer(browser, anna, '/profil/einstellungen');
  const seiteA2 = await seiteFuer(browser, annaZwei, '/chats');
  await expect(seiteA2.getByRole('heading', { name: 'Chats' })).toBeVisible({ timeout: 15_000 });
  const geraete = seiteA1.locator('#geraete');
  await expect(geraete.getByText('Dieses Gerät')).toBeVisible({ timeout: 15_000 });
  await geraete.getByRole('button', { name: 'Alle anderen Geräte abmelden' }).click();
  await geraete.getByRole('button', { name: /abmelden/ }).last().click();
  await expect(geraete.getByRole('button', { name: 'Alle anderen Geräte abmelden' })).toHaveCount(0);
  // Das zweite Gerät ist draussen: Sein Zugang gilt sofort nicht mehr.
  await seiteA2.reload();
  await expect(seiteA2.getByRole('button', { name: /Noch kein Konto|Anmelden/ }).first()).toBeVisible({
    timeout: 20_000,
  });

  await http.dispose();
  for (const seite of [seiteB, seiteA1, seiteA2]) await seite.context().close();
});
