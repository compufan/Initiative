import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';
import { API, als, registrieren, seiteFuer, type Sitzung } from './lib';

test.describe.configure({ mode: 'serial' });

let http: APIRequestContext;
let a: Sitzung;
let ks: Sitzung[] = [];
let g: { id: string };
let g2: { id: string };
let direkt: { id: string };

const blatt = (s: Page) => s.getByRole('dialog');
const zeit = () => {
  const t = Date.now() + 86_400_000;
  return { startsAt: new Date(t).toISOString(), endsAt: new Date(t + 3_600_000).toISOString() };
};

async function editorOeffnen(seite: Page, titel: string) {
  await seite.goto('/kalender');
  await seite.getByRole('button', { name: /Neuer Termin/ }).click();
  await expect(blatt(seite)).toBeVisible();
  await seite.locator('#cal-title').fill(titel);
}

test.beforeAll(async () => {
  http = await request.newContext();
  a = await registrieren(http, 'ua', 'Aaa Ersteller');
  for (let i = 1; i <= 12; i += 1) ks.push(await registrieren(http, `uk${i}`, `Kontakt ${String(i).padStart(2, '0')}`));
  g = await (await http.post(`${API}/conversations`, { headers: als(a), data: { type: 'group', title: 'Probegruppe', memberIds: ks.map((k) => k.user.id) } })).json();
  g2 = await (await http.post(`${API}/conversations`, { headers: als(a), data: { type: 'group', title: 'Zweite Gruppe', memberIds: [ks[0].user.id] } })).json();
  direkt = await (await http.post(`${API}/conversations`, { headers: als(a), data: { type: 'direct', memberIds: [ks[0].user.id] } })).json();
  const r = await http.patch(`${API}/conversations/${direkt.id}`, { headers: als(a), data: { archived: true } });
  console.log('archivieren', r.status());
});

test('P1: archivierter Einzelchat – Vorschau sagt „neu angelegt“, der Server legt keinen an', async ({ browser }) => {
  const seite = await seiteFuer(browser, a, 'http://localhost:5183');
  await editorOeffnen(seite, 'P1');
  const liste = blatt(seite).getByRole('group', { name: 'Personen', exact: true });
  await liste.getByRole('checkbox', { name: /Kontakt 01/ }).check();
  const vor = await blatt(seite).getByRole('status', { name: 'Was mit der Einladung geschieht' }).innerText();
  console.log('P1 Vorschau:', JSON.stringify(vor));
  const r = await http.post(`${API}/calendar/events`, {
    headers: als(a),
    data: { title: 'P1api', ...zeit(), attendeeIds: [ks[0].user.id], zustellung: { senden: true, einzelchats: true, gruppenChatIds: [] }, clientId: 'p1' + Date.now() },
  });
  const t = await r.json();
  console.log('P1 Server:', r.status(), JSON.stringify(t.zustellung));
});

test('P2: Ansicht „Gewählt“ ohne Auswahl – leere Fläche; Fokus nach dem Abwählen', async ({ browser }) => {
  const seite = await seiteFuer(browser, a, 'http://localhost:5183');
  await editorOeffnen(seite, 'P2');
  const liste = blatt(seite).getByRole('group', { name: 'Personen', exact: true });
  await expect(liste.getByRole('checkbox')).toHaveCount(12, { timeout: 15000 });
  await blatt(seite).getByRole('button', { name: 'Nur gewählte Personen anzeigen' }).click();
  console.log('P2 leere Liste, Text:', JSON.stringify(await liste.innerText()));
  await blatt(seite).getByRole('button', { name: 'Alle Personen anzeigen' }).click();
  await liste.getByRole('checkbox', { name: /Kontakt 03/ }).check();
  await blatt(seite).getByRole('button', { name: 'Nur gewählte Personen anzeigen' }).click();
  const cb = liste.getByRole('checkbox', { name: /Kontakt 03/ });
  await cb.focus();
  await seite.keyboard.press('Space');
  const aktiv = await seite.evaluate(() => document.activeElement?.tagName + '.' + (document.activeElement as HTMLElement | null)?.className);
  console.log('P2 Fokus nach Abwählen:', aktiv);
});

test('P3: Gruppenkarten laden scheitert – „wird geladen …“ bleibt, Wahl einer Gruppe wird still verworfen', async ({ browser }) => {
  const r = await http.post(`${API}/calendar/events`, {
    headers: als(a),
    data: { title: 'P3', ...zeit(), attendeeIds: [ks[0].user.id], zustellung: { senden: true, einzelchats: true, gruppenChatIds: [] }, clientId: 'p3' + Date.now() },
  });
  const t = await r.json();
  const seite = await seiteFuer(browser, a, 'http://localhost:5183');
  await seite.route('**/zustellung', (route) => (route.request().method() === 'GET' ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":{"code":"internal","message":"kaputt"}}' }) : route.continue()));
  await seite.goto(`/kalender/termin/${t.id}`);
  await seite.getByRole('button', { name: '✎ Termin bearbeiten' }).click();
  await expect(blatt(seite)).toBeVisible();
  await seite.waitForTimeout(3000);
  const text = await blatt(seite).locator('fieldset.cal-einl').innerText();
  console.log('P3 nach 3 s:', JSON.stringify(text.slice(0, 600)));
  await blatt(seite).getByRole('button', { name: /Gruppenchat …/ }).click();
  await blatt(seite).getByRole('group', { name: 'Gruppenchat wählen' }).getByRole('button', { name: /Zweite Gruppe/ }).click();
  console.log('P3 Chip:', JSON.stringify(await blatt(seite).locator('li.cal-einl-chip').allInnerTexts()));
  console.log('P3 Vorschau:', JSON.stringify(await blatt(seite).getByRole('status', { name: 'Was mit der Einladung geschieht' }).innerText()));
  await blatt(seite).getByRole('button', { name: 'Änderungen speichern' }).click();
  await seite.waitForTimeout(2500);
  const msgs = (await (await http.get(`${API}/conversations/${g2.id}/messages`, { headers: als(a) })).json()).items.filter((m: any) => m.type === 'event');
  console.log('P3 Karten in Zweite Gruppe nach Speichern:', msgs.length);
});

test('P4: Niemand beim Bearbeiten – Rückfragetext, Fokus', async ({ browser }) => {
  const r = await http.post(`${API}/calendar/events`, {
    headers: als(a),
    data: { title: 'P4', ...zeit(), attendeeIds: [ks[1].user.id], zustellung: { senden: true, einzelchats: true, gruppenChatIds: [] }, clientId: 'p4' + Date.now() },
  });
  const t = await r.json();
  const seite = await seiteFuer(browser, a, 'http://localhost:5183');
  await seite.goto(`/kalender/termin/${t.id}`);
  await seite.getByRole('button', { name: '✎ Termin bearbeiten' }).click();
  await expect(blatt(seite)).toBeVisible();
  await expect(blatt(seite).getByRole('checkbox', { name: /Kontakt 02/ })).toBeChecked({ timeout: 15000 });
  await blatt(seite).getByRole('button', { name: 'Niemand einladen' }).click();
  const frage = blatt(seite).getByRole('group', { name: 'Rückfrage' });
  console.log('P4 Frage:', JSON.stringify(await frage.innerText()));
  console.log('P4 Frage in Live-Region?', await frage.evaluate((el) => !!el.closest('[aria-live],[role=alert],[role=status]')));
  console.log('P4 Fokus:', await seite.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute('aria-label')));
});

test('P5: kalter Speicher – „keine Kontakte“ erscheint, solange die Chatliste noch lädt', async ({ browser }) => {
  const ctx = await browser.newContext();
  const seite = await ctx.newPage();
  await seite.goto('http://localhost:5183/');
  await seite.evaluate((w) => localStorage.setItem('initiative.tokens', JSON.stringify(w)), { accessToken: a.accessToken, refreshToken: a.refreshToken, expiresAt: Date.now() + 3_600_000 });
  await seite.route(/\/api\/v1\/conversations(\?|$)/, async (route) => {
    if (route.request().method() === 'GET') await new Promise((f) => setTimeout(f, 4000));
    await route.continue();
  });
  await seite.goto('http://localhost:5183/kalender');
  await seite.getByRole('button', { name: /Neuer Termin/ }).click();
  await expect(blatt(seite)).toBeVisible();
  await seite.waitForTimeout(800);
  console.log('P5 nach 0,8 s:', JSON.stringify((await blatt(seite).locator('fieldset.cal-einl').innerText()).slice(0, 300)));
  await seite.waitForTimeout(5000);
  console.log('P5 nach 6 s:', JSON.stringify((await blatt(seite).locator('fieldset.cal-einl').innerText()).slice(0, 200)));
  await ctx.close();
});
