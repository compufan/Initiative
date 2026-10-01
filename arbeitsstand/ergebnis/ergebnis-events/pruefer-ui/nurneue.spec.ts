import { expect, request, test } from '@playwright/test';
import { API, als, registrieren, seiteFuer } from './lib';

test('Nachträglich einladen: Vorschau auf der Terminseite', async ({ browser, baseURL }) => {
  const http = await request.newContext();
  const a = await registrieren(http, 'pa');
  const b = await registrieren(http, 'pb');
  const c = await registrieren(http, 'pc');
  const d = await registrieren(http, 'pd');
  const g = await (await http.post(`${API}/conversations`, { headers: als(a), data: { type: 'group', title: 'Gruppe PA', memberIds: [b.user.id, c.user.id, d.user.id] } })).json();
  const jetzt = Date.now() + 86_400_000;
  const r = await http.post(`${API}/calendar/events`, {
    headers: als(a),
    data: {
      title: 'Nachtrag', startsAt: new Date(jetzt).toISOString(), endsAt: new Date(jetzt + 3_600_000).toISOString(),
      attendeeIds: [b.user.id], zustellung: { senden: true, einzelchats: true, gruppenChatIds: [] }, clientId: 'x' + Date.now(),
    },
  });
  expect(r.status()).toBe(201);
  const t = await r.json();
  // B sagt zu
  const rs = await http.post(`${API}/calendar/events/${t.id}/rsvp`, { headers: als(b), data: { status: 'yes' } });
  expect(rs.ok()).toBeTruthy();
  const seite = await seiteFuer(browser, a, baseURL!);
  await seite.goto(`${baseURL}/kalender/termin/${t.id}`);
  await seite.getByText('Jemanden einladen').click();
  const feld = seite.locator('details.cal-invite');
  await expect(feld.getByRole('group', { name: 'Personen', exact: true })).toBeVisible({ timeout: 15000 });
  await seite.waitForTimeout(800);
  const text = await feld.locator('.cal-einl-vorschau').innerText();
  console.log('VORSCHAU (nichts gewählt):', JSON.stringify(text));
  await seite.screenshot({ path: 'nurneue.png', fullPage: true });
  await feld.getByRole('checkbox', { name: new RegExp(c.user.displayName) }).check();
  const text2 = await feld.locator('.cal-einl-vorschau').innerText();
  console.log('VORSCHAU (C gewählt):', JSON.stringify(text2));
});
