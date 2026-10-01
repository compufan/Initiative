import { expect, request, test } from '@playwright/test';
import { API, als, registrieren, seiteFuer } from './lib';

test('U2: Gewaehlt-Ansicht haengt', async ({ browser, baseURL }) => {
  const http = await request.newContext();
  const a = await registrieren(http, 'skd');
  const ks = [];
  for (let i = 0; i < 12; i += 1) ks.push(await registrieren(http, 'skk', `Kontakt ${String(i + 1).padStart(2, '0')}`));
  await http.post(`${API}/conversations`, { headers: als(a), data: { type: 'group', title: 'Gruppe 12', memberIds: ks.map((k) => k.user.id) } });
  const jetzt = Date.now() + 86_400_000;
  const r = await http.post(`${API}/calendar/events`, {
    headers: als(a),
    data: {
      title: 'Zwoelf', startsAt: new Date(jetzt).toISOString(), endsAt: new Date(jetzt + 3_600_000).toISOString(),
      attendeeIds: [ks[0].user.id], zustellung: { senden: true, einzelchats: true, gruppenChatIds: [] }, clientId: 'y' + Date.now(),
    },
  });
  expect(r.status()).toBe(201);
  const t = await r.json();
  const seite = await seiteFuer(browser, a, baseURL!, 375, 900);
  await seite.goto(`${baseURL}/kalender/termin/${t.id}`);
  await seite.getByText('Jemanden einladen').click();
  const feld = seite.locator('details.cal-invite');
  await expect(feld.getByRole('group', { name: 'Personen', exact: true })).toBeVisible({ timeout: 15000 });
  for (const n of ['02', '03', '04', '05']) await feld.getByRole('checkbox', { name: new RegExp(`Kontakt ${n}`) }).check();
  await feld.getByRole('button', { name: 'Nur gewählte Personen anzeigen' }).click();
  console.log('U2 vor Einladen Zeilen:', await feld.locator('.cal-einl-liste[aria-label="Personen"] label').count());
  await feld.getByRole('button', { name: /Personen einladen/ }).click();
  await seite.waitForTimeout(2500);
  console.log('U2 Zaehler:', JSON.stringify(await feld.locator('.cal-einl-zahl').innerText()));
  console.log('U2 Anzeige-Gruppe:', await feld.getByRole('group', { name: 'Anzeige' }).count());
  console.log('U2 Zeilen:', await feld.locator('.cal-einl-liste[aria-label="Personen"] label').count());
  console.log('U2 Listentext:', JSON.stringify(await feld.locator('.cal-einl-liste[aria-label="Personen"]').innerText()));
  // "Gewählt" ohne Auswahl, wenn Umschalter da ist (nicht bei <=8)
  // Esc im Gruppenfeld (Editor) wird separat geprüft
});
