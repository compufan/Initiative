import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';
import { API, als, seiteFuer, terminAnlegen, type Sitzung } from './lib';

const W = 'http://localhost:5183';
const blatt = (s: Page) => s.getByRole('dialog');
let http: APIRequestContext;

test('E1 Gruppenkarten laden scheitert: Chip hinzufügen und speichern', async ({ browser }) => {
  http = await request.newContext();
  const p: Sitzung = await (await http.post(`${API}/auth/login`, { data: { username: process.env.PRU_USER!, password: 'passwort123' } })).json();
  const l = await (await http.get(`${API}/conversations`, { headers: als(p) })).json();
  const gruppe = l.items.find((c: any) => c.type === 'group' && c.title === 'Probe');
  const t = await terminAnlegen(http, p, `Pruefer-E1-${Date.now()}`, {});
  const s = await seiteFuer(browser, p, W);
  await s.route(`**/api/v1/calendar/events/${t.id}/zustellung`, (r) =>
    r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' }),
  );
  await s.goto(`${W}/kalender/termin/${t.id}`);
  await expect(s.getByText(t.title).first()).toBeVisible({ timeout: 15_000 });
  await s.getByRole('button', { name: '✎ Termin bearbeiten' }).click();
  await expect(blatt(s)).toBeVisible();
  await blatt(s).getByRole('button', { name: /Gruppenchat …/ }).click();
  await blatt(s).getByRole('group', { name: 'Gruppenchat wählen' }).getByRole('button', { name: /Probe/ }).click();
  const v = blatt(s).getByRole('status', { name: 'Was mit der Einladung geschieht' });
  console.log('E1 Chip:', JSON.stringify(await blatt(s).getByRole('list', { name: 'Ausgewählte Gruppenchats' }).innerText()));
  console.log('E1 Vorschau:', JSON.stringify(await v.innerText()));
  console.log('E1 Abschnitt:', JSON.stringify(await blatt(s).getByRole('heading', { name: 'Gruppenchats' }).locator('xpath=following-sibling::*[1]').innerText()));
  await blatt(s).getByRole('button', { name: 'Änderungen speichern' }).click();
  await expect(s.getByText(/Termin gespeichert/)).toBeVisible({ timeout: 15_000 });
  const toast = await s.getByText(/Termin gespeichert/).first().innerText();
  console.log('E1 Toast:', JSON.stringify(toast));
  const nach = await (await http.get(`${API}/conversations/${gruppe.id}/messages`, { headers: als(p) })).json();
  const karten = nach.items.filter((m: any) => m.type === 'event' && m.metadata?.eventId === t.id && !m.deletedAt);
  console.log('E1 Karten im Gruppenchat nach Speichern:', karten.length);
  await s.context().close();
});
