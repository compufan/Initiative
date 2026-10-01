import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';
import { API, als, seiteFuer, terminAnlegen, type Sitzung } from './lib';

test.describe.configure({ mode: 'serial' });
const OUT = '/tmp/claude-0/-home-user-Initiative/b3e47b8f-e30a-5e75-8af6-6e58f2fcbe7c/scratchpad/ergebnis-events/pruefer-ui/';
const W = 'http://localhost:5183';
const blatt = (s: Page) => s.getByRole('dialog');

let http: APIRequestContext;
let p: Sitzung, p2: Sitzung;
let gruppe: { id: string; title: string };
let t1: { id: string; title: string };

async function login(name: string): Promise<Sitzung> {
  const r = await http.post(`${API}/auth/login`, { data: { username: name, password: 'passwort123' } });
  expect(r.ok(), `login ${name} ${r.status()}`).toBeTruthy();
  return r.json();
}

test.beforeAll(async () => {
  http = await request.newContext();
  p = await login(process.env.PRU_USER!);
  p2 = await login(process.env.PRU_USER2!);
  const l = await (await http.get(`${API}/conversations`, { headers: als(p) })).json();
  gruppe = l.items.find((c: any) => c.type === 'group' && c.title === 'Probe');
  expect(gruppe).toBeTruthy();
});

test('C1 Composer im Gruppenchat: Vorbelegung', async ({ browser }) => {
  const s = await seiteFuer(browser, p, W);
  await s.goto(`${W}/chats/${gruppe.id}`);
  await s.getByRole('button', { name: 'Mehr hinzufügen' }).click();
  await s.getByRole('button', { name: /Termin/ }).first().click();
  await expect(blatt(s)).toBeVisible();
  await s.waitForTimeout(800);
  const v = blatt(s).getByRole('status', { name: 'Was mit der Einladung geschieht' });
  console.log('C1 Vorschau:', JSON.stringify(await v.innerText()));
  console.log('C1 Chips:', JSON.stringify(await blatt(s).getByRole('list', { name: 'Ausgewählte Gruppenchats' }).innerText()));
  console.log('C1 Status-Regionen:', JSON.stringify(await blatt(s).getByRole('status').allInnerTexts())); await s.screenshot({ path: OUT + 'c1.png' });
  await s.context().close();
});

test('C2 Bearbeiten: Chip bei bestehender Karte', async ({ browser }) => {
  t1 = await terminAnlegen(http, p, `Pruefer-C ${Date.now()}`, {
    attendeeIds: [p2.user.id],
    zustellung: { senden: true, einzelchats: true, gruppenChatIds: [gruppe.id] },
  });
  const s = await seiteFuer(browser, p, W);
  await s.goto(`${W}/kalender/termin/${t1.id}`);
  await expect(s.getByText(t1.title).first()).toBeVisible({ timeout: 15_000 });
  await s.getByRole('button', { name: '✎ Termin bearbeiten' }).click();
  await expect(blatt(s)).toBeVisible();
  await expect(blatt(s).getByRole('list', { name: 'Ausgewählte Gruppenchats' })).toBeVisible({ timeout: 10_000 });
  console.log('C2 Chip:', JSON.stringify(await blatt(s).getByRole('list', { name: 'Ausgewählte Gruppenchats' }).innerText()));
  console.log('C2 Vorschau:', JSON.stringify(await blatt(s).getByRole('status', { name: 'Was mit der Einladung geschieht' }).innerText()));
  console.log('C2 Personenzeile:', JSON.stringify(await blatt(s).getByRole('group', { name: 'Personen', exact: true }).innerText()));
  await s.context().close();
});

test('C3 archivierter Einzelchat: Vorschau sagt „neu angelegt“', async ({ browser }) => {
  const l = await (await http.get(`${API}/conversations`, { headers: als(p) })).json();
  const einzel = l.items.find((c: any) => c.type === 'direct' && c.members.some((m: any) => m.userId === p2.user.id));
  expect(einzel, 'Einzelchat P-P2').toBeTruthy();
  const a = await http.patch(`${API}/conversations/${einzel.id}`, { headers: als(p), data: { archived: true } });
  expect(a.ok()).toBeTruthy();
  const s = await seiteFuer(browser, p, W);
  await s.goto(`${W}/kalender`);
  await s.getByRole('button', { name: /Neuer Termin/ }).click();
  await expect(blatt(s)).toBeVisible();
  await s.locator('#cal-title').fill('Pruefer-Archiv');
  const liste = blatt(s).getByRole('group', { name: 'Personen', exact: true });
  await liste.getByRole('checkbox', { name: new RegExp(p2.user.displayName) }).check();
  const v = blatt(s).getByRole('status', { name: 'Was mit der Einladung geschieht' });
  console.log('C3 Vorschau (Einzelchat archiviert):', JSON.stringify(await v.innerText()));
  // und was der Server tatsächlich macht
  const r = await http.post(`${API}/calendar/events`, {
    headers: als(p),
    data: {
      title: 'Pruefer-Archiv-API', startsAt: new Date(Date.now() + 86400000).toISOString(), endsAt: new Date(Date.now() + 90000000).toISOString(),
      attendeeIds: [p2.user.id], zustellung: { senden: true, einzelchats: true, gruppenChatIds: [] },
    },
  });
  const j = await r.json();
  console.log('C3 Server zustellung:', JSON.stringify(j.zustellung));
  // zurück
  await http.patch(`${API}/conversations/${einzel.id}`, { headers: als(p), data: { archived: false } });
  await s.context().close();
});
