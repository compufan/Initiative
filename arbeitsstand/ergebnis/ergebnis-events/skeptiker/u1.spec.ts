import { expect, request, test } from '@playwright/test';
import { API, als, registrieren, seiteFuer } from './lib';

test('U1: nurNeue Vorschau und Keine-Kontakte', async ({ browser, baseURL }) => {
  const http = await request.newContext();
  const a = await registrieren(http, 'ska');
  const b = await registrieren(http, 'skb');
  const c = await registrieren(http, 'skc');
  await http.post(`${API}/conversations`, { headers: als(a), data: { type: 'group', title: 'Gruppe SK', memberIds: [b.user.id, c.user.id] } });
  const jetzt = Date.now() + 86_400_000;
  const r = await http.post(`${API}/calendar/events`, {
    headers: als(a),
    data: {
      title: 'Nachtrag', startsAt: new Date(jetzt).toISOString(), endsAt: new Date(jetzt + 3_600_000).toISOString(),
      attendeeIds: [b.user.id, c.user.id], zustellung: { senden: true, einzelchats: true, gruppenChatIds: [] }, clientId: 'x' + Date.now(),
    },
  });
  expect(r.status()).toBe(201);
  const t = await r.json();
  await http.post(`${API}/calendar/events/${t.id}/rsvp`, { headers: als(b), data: { status: 'yes' } });
  const seite = await seiteFuer(browser, a, baseURL!);
  await seite.goto(`${baseURL}/kalender/termin/${t.id}`);
  await seite.getByText('Jemanden einladen').click();
  const feld = seite.locator('details.cal-invite');
  await expect(feld.locator('.cal-einl-vorschau')).toBeAttached({ timeout: 15000 });
  await seite.waitForTimeout(800);
  console.log('U1 VORSCHAU:', JSON.stringify(await feld.locator('.cal-einl-vorschau').innerText()));
  console.log('U1 ZAEHLER:', JSON.stringify(await feld.locator('.cal-einl-zahl').innerText()));
  console.log('U1 FELD:', JSON.stringify((await feld.innerText()).slice(0, 400)));
});
