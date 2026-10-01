import { expect, request, test, type Page } from '@playwright/test';
import { API, als, registrieren, seiteFuer } from './lib';

const blatt = (s: Page) => s.getByRole('dialog');
const SHOT = '/tmp/claude-0/-home-user-Initiative/b3e47b8f-e30a-5e75-8af6-6e58f2fcbe7c/scratchpad/ergebnis-events/pruefer-ui/';

test('K1: alle schon eingeladen / Nicht-Kontakt abwählen / Esc im Gruppenfeld', async ({ browser }) => {
  const http = await request.newContext();
  const a = await registrieren(http, 'ka', 'Kai Ersteller');
  const k1 = await registrieren(http, 'kk1', 'Kontakt Eins');
  const k2 = await registrieren(http, 'kk2', 'Kontakt Zwei');
  const x = await registrieren(http, 'kx', 'Xaver Fremd');
  await http.post(`${API}/conversations`, { headers: als(a), data: { type: 'group', title: 'Kleine Gruppe', memberIds: [k1.user.id, k2.user.id] } });
  const t = Date.now() + 86_400_000;
  const zeit = { startsAt: new Date(t - (t % 60000)).toISOString(), endsAt: new Date(t - (t % 60000) + 3_600_000).toISOString() };
  const e1 = await (await http.post(`${API}/calendar/events`, { headers: als(a), data: { title: 'K1 alle', ...zeit, attendeeIds: [k1.user.id, k2.user.id], zustellung: { senden: false, einzelchats: false, gruppenChatIds: [] }, clientId: 'k1' + t } })).json();
  const e2 = await (await http.post(`${API}/calendar/events`, { headers: als(a), data: { title: 'K2 fremd', ...zeit, attendeeIds: [k1.user.id, x.user.id], zustellung: { senden: false, einzelchats: false, gruppenChatIds: [] }, clientId: 'k2' + t } })).json();
  expect(e1.id && e2.id).toBeTruthy();

  const seite = await seiteFuer(browser, a, 'http://localhost:5183', 375, 812);

  // (y) alle Kontakte schon eingeladen
  await seite.goto(`/kalender/termin/${e1.id}`);
  await seite.getByText('Jemanden einladen').click();
  const feld = seite.locator('details.cal-invite');
  await expect(feld.locator('.cal-einl-zahl')).toBeVisible({ timeout: 15000 });
  await seite.waitForTimeout(500);
  console.log('K1(y):', JSON.stringify((await feld.innerText()).slice(0, 400)));

  // (b) Nicht-Kontakt abwählen
  await seite.goto(`/kalender/termin/${e2.id}`);
  await seite.getByRole('button', { name: '✎ Termin bearbeiten' }).click();
  await expect(blatt(seite)).toBeVisible();
  const weitere = blatt(seite).getByRole('group', { name: 'Weitere Personen', exact: true });
  await expect(weitere.getByRole('checkbox')).toHaveCount(1, { timeout: 15000 });
  console.log('K1(b) vorher:', JSON.stringify(await weitere.innerText()));
  await weitere.getByRole('checkbox').click();
  await seite.waitForTimeout(300);
  console.log('K1(b) nach Abwählen: Zeilen in Weitere =', await blatt(seite).getByRole('group', { name: 'Weitere Personen', exact: true }).count());
  console.log('K1(b) Vorschau:', JSON.stringify(await blatt(seite).getByRole('status', { name: 'Was mit der Einladung geschieht' }).innerText()));

  // (o) Esc im Gruppenfeld
  await blatt(seite).getByRole('button', { name: /Gruppenchat …/ }).click();
  await expect(blatt(seite).getByRole('group', { name: 'Gruppenchat wählen' })).toBeVisible();
  await seite.keyboard.press('Escape');
  await seite.waitForTimeout(500);
  console.log('K1(o) Blatt nach Esc noch offen?', await blatt(seite).count());
});
