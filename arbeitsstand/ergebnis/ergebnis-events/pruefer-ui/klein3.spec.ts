import { expect, request, test } from '@playwright/test';
import { API, als, registrieren, seiteFuer, type Sitzung } from './lib';

test('K3: „Gewählt“-Ansicht bleibt hängen, wenn der Umschalter verschwindet', async ({ browser }) => {
  const http = await request.newContext();
  const a = await registrieren(http, 'ma', 'Mia Ersteller');
  const ks: Sitzung[] = [];
  for (let i = 1; i <= 12; i += 1) ks.push(await registrieren(http, `mk${i}`, `Kontakt ${String(i).padStart(2, '0')}`));
  await http.post(`${API}/conversations`, { headers: als(a), data: { type: 'group', title: 'Zwölfer', memberIds: ks.map((k) => k.user.id) } });
  const t = Date.now() + 86_400_000;
  const m = t - (t % 60000);
  const e1 = await (await http.post(`${API}/calendar/events`, { headers: als(a), data: { title: 'M1', startsAt: new Date(m).toISOString(), endsAt: new Date(m + 3_600_000).toISOString(), attendeeIds: [ks[11].user.id], zustellung: { senden: false, einzelchats: false, gruppenChatIds: [] }, clientId: 'm1' + t } })).json();
  const seite = await seiteFuer(browser, a, 'http://localhost:5183', 375, 812);
  await seite.goto(`/kalender/termin/${e1.id}`);
  await seite.getByText('Jemanden einladen').click();
  const feld = seite.locator('details.cal-invite');
  const liste = feld.getByRole('group', { name: 'Personen', exact: true });
  await expect(liste.getByRole('checkbox')).toHaveCount(11, { timeout: 15000 });
  for (const n of ['01', '02', '03', '04']) await liste.getByRole('checkbox', { name: new RegExp(`Kontakt ${n}`) }).check();
  await feld.getByRole('button', { name: 'Nur gewählte Personen anzeigen' }).click();
  console.log('K3 Gewählt-Ansicht Zeilen:', await liste.getByRole('checkbox').count());
  await feld.getByRole('button', { name: /Personen einladen/ }).click();
  await expect(seite.getByText('4 eingeladen.')).toBeVisible({ timeout: 15000 });
  await seite.waitForTimeout(800);
  console.log('K3 nach dem Einladen: Umschalter vorhanden =', await feld.getByRole('group', { name: 'Anzeige' }).count());
  console.log('K3 nach dem Einladen: Zeilen =', await feld.getByRole('group', { name: 'Personen', exact: true }).getByRole('checkbox').count());
  console.log('K3 Zähler:', JSON.stringify(await feld.locator('.cal-einl-zahl').innerText()));
  console.log('K3 Feldtext:', JSON.stringify((await feld.innerText()).slice(0, 300)));
});
