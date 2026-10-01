import { expect, request, test, type Page } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { API, als, registrieren, seiteFuer, type Sitzung } from './lib';

const blatt = (s: Page) => s.getByRole('dialog');
const DATEI = '/tmp/claude-0/-home-user-Initiative/b3e47b8f-e30a-5e75-8af6-6e58f2fcbe7c/scratchpad/ergebnis-events/pruefer-ui/viele.json';

async function aufbau(): Promise<{ a: Sitzung; ks: Sitzung[]; g1: { id: string }; g2: { id: string } }> {
  if (existsSync(DATEI)) return JSON.parse(readFileSync(DATEI, 'utf8'));
  const http = await request.newContext();
  const a = await registrieren(http, 'va', 'Vera Viele');
  const ks: Sitzung[] = [];
  for (let i = 1; i <= 130; i += 1) ks.push(await registrieren(http, `vk${i}`, `Person ${String(i).padStart(3, '0')}`));
  const g1 = await (await http.post(`${API}/conversations`, { headers: als(a), data: { type: 'group', title: 'Erste Hälfte', memberIds: ks.slice(0, 65).map((k) => k.user.id) } })).json();
  const g2 = await (await http.post(`${API}/conversations`, { headers: als(a), data: { type: 'group', title: 'Zweite Hälfte', memberIds: ks.slice(65).map((k) => k.user.id) } })).json();
  const r = { a, ks, g1, g2 };
  writeFileSync(DATEI, JSON.stringify(r));
  return r;
}

test('V1: 130 Kontakte – Gruppen, Vorschau, Speichern, 375 px', async ({ browser }) => {
  test.setTimeout(280_000);
  const { a, ks } = await aufbau();
  const seite = await seiteFuer(browser, a, 'http://localhost:5183', 375, 812);
  await seite.goto('/kalender');
  await seite.getByRole('button', { name: /Neuer Termin/ }).click();
  await expect(blatt(seite)).toBeVisible();
  await seite.locator('#cal-title').fill('Viele ' + Date.now());
  const liste = blatt(seite).getByRole('group', { name: 'Personen', exact: true });
  await expect(liste.getByRole('checkbox').first()).toBeVisible({ timeout: 15000 });
  await blatt(seite).getByRole('button', { name: 'Alle Kontakte einladen' }).click();
  await blatt(seite).getByRole('button', { name: /Auch in „Zweite Hälfte“ posten/ }).click();
  console.log('V1 Vorschau:', JSON.stringify(await blatt(seite).getByRole('status', { name: 'Was mit der Einladung geschieht' }).innerText()));
  console.log('V1 Chip:', JSON.stringify(await blatt(seite).locator('li.cal-einl-chip').allInnerTexts()));
  await blatt(seite).getByRole('button', { name: 'Alle Personen anzeigen' }).click().catch(() => {});
  await blatt(seite).locator('li.cal-einl-chip').scrollIntoViewIfNeeded();
  await seite.screenshot({ path: 'viele-375-chip.png' });
  const t4 = Date.now();
  await blatt(seite).getByRole('button', { name: 'Termin erstellen' }).click();
  const toast = await seite.getByText(/Termin erstellt/).first().innerText({ timeout: 90000 });
  console.log('V1 Speichern ms', Date.now() - t4, JSON.stringify(toast));
});

test('V2: Terminseite – nachträglich einladen mit 130 Kontakten', async ({ browser }) => {
  test.setTimeout(200_000);
  const { a, ks } = await aufbau();
  const http = await request.newContext();
  const t = Date.now() + 86_400_000;
  const r = await http.post(`${API}/calendar/events`, {
    headers: als(a),
    data: { title: 'V2 ' + t, startsAt: new Date(t).toISOString(), endsAt: new Date(t + 3_600_000).toISOString(), attendeeIds: ks.slice(0, 10).map((k) => k.user.id), zustellung: { senden: false, einzelchats: false, gruppenChatIds: [] }, clientId: 'v2' + t },
  });
  expect(r.status()).toBe(201);
  const ev = await r.json();
  const seite = await seiteFuer(browser, a, 'http://localhost:5183', 375, 812);
  await seite.goto(`/kalender/termin/${ev.id}`);
  await seite.getByText('Jemanden einladen').click();
  const feld = seite.locator('details.cal-invite');
  await expect(feld.getByRole('group', { name: 'Personen', exact: true })).toBeVisible({ timeout: 15000 });
  console.log('V2 Zähler:', JSON.stringify(await feld.locator('.cal-einl-zahl').innerText()));
  console.log('V2 Vorschau leer:', JSON.stringify(await feld.locator('.cal-einl-vorschau').innerText()));
  await feld.getByRole('button', { name: 'Alle Kontakte einladen' }).click();
  console.log('V2 nach Alle Zähler:', JSON.stringify(await feld.locator('.cal-einl-zahl').innerText()));
  console.log('V2 nach Alle Vorschau:', JSON.stringify(await feld.locator('.cal-einl-vorschau').innerText()));
  const knopf = feld.getByRole('button', { name: /Personen einladen|^Einladen$/ });
  console.log('V2 Knopf:', JSON.stringify(await knopf.innerText()));
  await feld.screenshot({ path: 'v2-feld.png' });
});
