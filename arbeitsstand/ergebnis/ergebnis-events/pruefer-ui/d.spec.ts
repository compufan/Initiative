import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';
import { API, als, seiteFuer, type Sitzung } from './lib';

test.describe.configure({ mode: 'serial' });
const W = 'http://localhost:5183';
const blatt = (s: Page) => s.getByRole('dialog');
let http: APIRequestContext;
let p: Sitzung;

test.beforeAll(async () => {
  http = await request.newContext();
  const r = await http.post(`${API}/auth/login`, { data: { username: process.env.PRU_USER!, password: 'passwort123' } });
  p = await r.json();
});

async function anlegenUndBearbeiten(s: Page, titel: string, optionen: (s: Page) => Promise<void>) {
  await s.goto(`${W}/kalender`);
  await s.getByRole('button', { name: /Neuer Termin/ }).click();
  await expect(blatt(s)).toBeVisible();
  await s.locator('#cal-title').fill(titel);
  await optionen(s);
  await blatt(s).getByRole('button', { name: 'Termin erstellen' }).click();
  await expect(s.getByText(/Termin erstellt/)).toBeVisible({ timeout: 15_000 });
  const l = await (await http.get(`${API}/calendar/events`, { headers: als(p) })).json();
  const t = l.items.find((e: any) => e.title === titel);
  expect(t).toBeTruthy();
  console.log(`  ${titel}: startsAt=${t.startsAt} endsAt=${t.endsAt} allDay=${t.allDay} rrule=${t.rrule}`);
  await s.goto(`${W}/kalender/termin/${t.id}`);
  await expect(s.getByText(titel).first()).toBeVisible({ timeout: 15_000 });
  await s.getByRole('button', { name: '✎ Termin bearbeiten' }).click();
  await expect(blatt(s)).toBeVisible();
  await s.waitForTimeout(800);
  const v = blatt(s).getByRole('status', { name: 'Was mit der Einladung geschieht' });
  return JSON.stringify(await v.innerText());
}

test('D1 UI-Termin, unverändert bearbeiten: kommt „Zeit geändert“?', async ({ browser }) => {
  const s = await seiteFuer(browser, p, W);
  const t = Date.now();
  console.log('D1 normal:', await anlegenUndBearbeiten(s, `Pruefer-D-normal-${t}`, async () => {}));
  console.log('D1 ganztägig:', await anlegenUndBearbeiten(s, `Pruefer-D-ganz-${t}`, async (x) => {
    await blatt(x).getByText('Ganztägig').click();
  }));
  console.log('D1 wöchentlich:', await anlegenUndBearbeiten(s, `Pruefer-D-woche-${t}`, async (x) => {
    await blatt(x).locator('select').first().selectOption('WEEKLY').catch(async () => {
      await blatt(x).getByRole('button', { name: 'Wöchentlich' }).click();
    });
  }));
  await s.context().close();
});
