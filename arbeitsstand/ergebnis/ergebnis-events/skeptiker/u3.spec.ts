import { expect, request, test } from '@playwright/test';
import { API, als, registrieren, seiteFuer } from './lib';

const blatt = (s) => s.getByRole('dialog');
const liste = (s) => blatt(s).getByRole('group', { name: 'Personen', exact: true });
const vorschau = (s) => blatt(s).getByRole('status', { name: 'Was mit der Einladung geschieht' });
const jetztPlus = (h) => new Date(Date.now() + h * 3_600_000).toISOString();

async function termin(http, a, daten) {
  const r = await http.post(`${API}/calendar/events`, {
    headers: als(a),
    data: { title: daten.title, startsAt: jetztPlus(30), endsAt: jetztPlus(31), clientId: 'z' + Math.random().toString(36).slice(2), ...daten.extra },
  });
  expect(r.status(), await r.text()).toBe(201);
  return (await r.json()).termin ?? (await r.json());
}

test('U24: archivierter Einzelchat in der Vorschau', async ({ browser, baseURL }) => {
  const http = await request.newContext();
  const a = await registrieren(http, 'sk24a');
  const k1 = await registrieren(http, 'sk24b');
  const k2 = await registrieren(http, 'sk24c');
  await http.post(`${API}/conversations`, { headers: als(a), data: { type: 'group', title: 'G24', memberIds: [k1.user.id, k2.user.id] } });
  const dm = await (await http.post(`${API}/conversations`, { headers: als(a), data: { type: 'direct', memberIds: [k1.user.id] } })).json();
  const ar = await http.patch(`${API}/conversations/${dm.id}`, { headers: als(a), data: { archived: true } });
  console.log('U24 archiviert:', ar.status());
  const seite = await seiteFuer(browser, a, baseURL!);
  await seite.goto(`${baseURL}/kalender`);
  await seite.getByRole('button', { name: /Neuer Termin/ }).click();
  await expect(blatt(seite)).toBeVisible();
  await seite.locator('#cal-title').fill('Arch');
  await liste(seite).getByRole('checkbox', { name: new RegExp(k1.user.displayName) }).check({ timeout: 15000 });
  console.log('U24 Vorschau:', JSON.stringify(await vorschau(seite).innerText()));
  // Was der Server wirklich tut
  const r = await http.post(`${API}/calendar/events`, {
    headers: als(a),
    data: { title: 'Arch2', startsAt: jetztPlus(30), endsAt: jetztPlus(31), attendeeIds: [k1.user.id], zustellung: { senden: true, einzelchats: true, gruppenChatIds: [] } },
  });
  console.log('U24 Server:', JSON.stringify((await r.json()).zustellung));
});

test('U25: Gruppenkarten laden scheitert', async ({ browser, baseURL }) => {
  const http = await request.newContext();
  const a = await registrieren(http, 'sk25a');
  const b = await registrieren(http, 'sk25b');
  const c = await registrieren(http, 'sk25c');
  await http.post(`${API}/conversations`, { headers: als(a), data: { type: 'group', title: 'Erste Gruppe', memberIds: [b.user.id] } });
  const g2 = await (await http.post(`${API}/conversations`, { headers: als(a), data: { type: 'group', title: 'Zweite Gruppe', memberIds: [b.user.id, c.user.id] } })).json();
  const r = await http.post(`${API}/calendar/events`, {
    headers: als(a),
    data: { title: 'Gruppenfehler', startsAt: jetztPlus(30), endsAt: jetztPlus(31), attendeeIds: [b.user.id], zustellung: { senden: true, einzelchats: true, gruppenChatIds: [] } },
  });
  const t = (await r.json()).id ?? (await r.json()).termin?.id;
  const seite = await seiteFuer(browser, a, baseURL!);
  await seite.route(/\/calendar\/events\/[^/]+\/zustellung$/, (route) => route.request().method() === 'GET' ? route.fulfill({ status: 500, body: '{"error":{"code":"internal","message":"x"}}', contentType: 'application/json' }) : route.continue());
  await seite.goto(`${baseURL}/kalender/termin/${t}`);
  await seite.getByRole('button', { name: 'Termin bearbeiten' }).first().click();
  await expect(blatt(seite)).toBeVisible();
  await seite.waitForTimeout(3500);
  const text = await blatt(seite).innerText();
  console.log('U25 zeigt "werden geladen":', /Gruppenkarten werden geladen/.test(text), ' "Erneut versuchen":', /Erneut versuchen/.test(text));
  await blatt(seite).getByRole('button', { name: /Gruppenchat …/ }).click();
  await blatt(seite).getByRole('button', { name: /Zweite Gruppe/ }).click();
  console.log('U25 Chip-Text:', JSON.stringify((await blatt(seite).locator('.cal-einl-chip').allInnerTexts())));
  console.log('U25 Vorschau:', JSON.stringify(await vorschau(seite).innerText()));
  await blatt(seite).getByRole('button', { name: 'Änderungen speichern' }).click();
  await seite.waitForTimeout(2500);
  const z = await (await http.get(`${API}/calendar/events/${t}/zustellung`, { headers: als(a) })).json();
  console.log('U25 Gruppenkarten nach Speichern:', JSON.stringify(z.gruppen), 'Toast:', await seite.locator('[role=status],[role=alert]').allInnerTexts());
  const msgs = await (await http.get(`${API}/conversations/${g2.id}/messages`, { headers: als(a) })).json();
  console.log('U25 Karten in Zweite Gruppe:', msgs.items.filter((m) => m.type === 'event').length);
});

test('U27: abgewählte Person von ausserhalb verschwindet', async ({ browser, baseURL }) => {
  const http = await request.newContext();
  const a = await registrieren(http, 'sk27a');
  const b = await registrieren(http, 'sk27b');
  const x = await registrieren(http, 'sk27x', 'Fremder X27');
  await http.post(`${API}/conversations`, { headers: als(a), data: { type: 'group', title: 'G27', memberIds: [b.user.id] } });
  const r = await http.post(`${API}/calendar/events`, {
    headers: als(a),
    data: { title: 'Fremd', startsAt: jetztPlus(30), endsAt: jetztPlus(31), attendeeIds: [b.user.id, x.user.id], zustellung: { senden: false, einzelchats: false, gruppenChatIds: [] } },
  });
  const j = await r.json();
  const t = j.id ?? j.termin?.id;
  const seite = await seiteFuer(browser, a, baseURL!);
  await seite.goto(`${baseURL}/kalender/termin/${t}`);
  await seite.getByRole('button', { name: 'Termin bearbeiten' }).first().click();
  await expect(blatt(seite)).toBeVisible();
  const weitere = blatt(seite).getByRole('group', { name: 'Weitere Personen' });
  await expect(weitere).toBeVisible({ timeout: 15000 });
  console.log('U27 vorher Zeilen:', await weitere.locator('label').count());
  await weitere.getByRole('checkbox', { name: /Fremder X27/ }).click();
  console.log('U27 nachher Zeilen:', await blatt(seite).getByRole('group', { name: 'Weitere Personen' }).count());
  console.log('U27 Vorschau:', JSON.stringify(await vorschau(seite).innerText()));
});

test('U28: Rückfrage Niemand', async ({ browser, baseURL }) => {
  const http = await request.newContext();
  const a = await registrieren(http, 'sk28a');
  const b = await registrieren(http, 'sk28b');
  await http.post(`${API}/conversations`, { headers: als(a), data: { type: 'group', title: 'G28', memberIds: [b.user.id] } });
  const r = await http.post(`${API}/calendar/events`, {
    headers: als(a),
    data: { title: 'Eins', startsAt: jetztPlus(30), endsAt: jetztPlus(31), attendeeIds: [b.user.id], zustellung: { senden: false, einzelchats: false, gruppenChatIds: [] } },
  });
  const j = await r.json();
  const t = j.id ?? j.termin?.id;
  const seite = await seiteFuer(browser, a, baseURL!);
  await seite.goto(`${baseURL}/kalender/termin/${t}`);
  await seite.getByRole('button', { name: 'Termin bearbeiten' }).first().click();
  await expect(blatt(seite)).toBeVisible();
  await expect(liste(seite).getByRole('checkbox').first()).toBeVisible({ timeout: 15000 });
  await blatt(seite).getByRole('button', { name: 'Niemand einladen' }).click();
  const frage = blatt(seite).getByRole('group', { name: 'Rückfrage' });
  console.log('U28 Text:', JSON.stringify(await frage.innerText()));
  console.log('U28 Fokus:', await seite.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName));
  console.log('U28 in Live-Region:', await frage.evaluate((e) => !!e.closest('[aria-live],[role=alert],[role=status]')));
  const ul = blatt(seite).locator('ul.cal-einl-vorschau');
  console.log('U28 ul role:', await ul.getAttribute('role'));
  console.log('U28 anzeige-Knöpfe: Text/aria-label:', 'siehe unten');
});

test('U29: kalter Start', async ({ browser, baseURL }) => {
  const http = await request.newContext();
  const a = await registrieren(http, 'sk29a');
  const b = await registrieren(http, 'sk29b');
  await http.post(`${API}/conversations`, { headers: als(a), data: { type: 'group', title: 'G29', memberIds: [b.user.id] } });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const seite = await ctx.newPage();
  await seite.goto(baseURL!);
  await seite.evaluate((werte) => localStorage.setItem('initiative.tokens', JSON.stringify(werte)), {
    accessToken: a.accessToken, refreshToken: a.refreshToken, expiresAt: Date.now() + 3_600_000,
  });
  await seite.route(/\/api\/v1\/conversations(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await new Promise((f) => setTimeout(f, 4000));
    await route.continue();
  });
  await seite.goto(`${baseURL}/kalender`);
  await seite.getByRole('button', { name: /Neuer Termin/ }).click();
  await expect(blatt(seite)).toBeVisible();
  await seite.waitForTimeout(800);
  console.log('U29 nach 0,8 s:', JSON.stringify((await blatt(seite).innerText()).replace(/\s+/g, ' ').slice(0, 500)));
  await seite.waitForTimeout(6000);
  console.log('U29 nach 6 s:', JSON.stringify((await liste(seite).count()) + ' Listen; Zähler: ' + (await blatt(seite).locator('.cal-einl-zahl').innerText())));
});
