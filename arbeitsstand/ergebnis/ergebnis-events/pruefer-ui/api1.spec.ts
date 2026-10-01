import { expect, request, test } from '@playwright/test';
import { API, als, registrieren } from './lib';

test('A1: Bearbeiten, einzelchats=false – benachrichtigt der Server wirklich?', async () => {
  const http = await request.newContext();
  const a = await registrieren(http, 'na', 'Nina Ersteller');
  const k1 = await registrieren(http, 'nk1', 'Kontakt Eins');
  const k2 = await registrieren(http, 'nk2', 'Kontakt Zwei');
  await http.post(`${API}/conversations`, { headers: als(a), data: { type: 'group', title: 'G', memberIds: [k1.user.id, k2.user.id] } });
  const t = Date.now() + 86_400_000;
  const m = t - (t % 60000);
  const e = await (await http.post(`${API}/calendar/events`, { headers: als(a), data: { title: 'N1', startsAt: new Date(m).toISOString(), endsAt: new Date(m + 3_600_000).toISOString(), attendeeIds: [], zustellung: { senden: true, einzelchats: true, gruppenChatIds: [] }, clientId: 'n1' + t } })).json();
  const r = await http.patch(`${API}/calendar/events/${e.id}`, { headers: als(a), data: { attendeeIds: [k1.user.id], zustellung: { senden: true, einzelchats: false } } });
  console.log('A1 PATCH', r.status(), JSON.stringify((await r.json()).zustellung));
  const r2 = await http.post(`${API}/calendar/events`, { headers: als(a), data: { title: 'N2', startsAt: new Date(m).toISOString(), endsAt: new Date(m + 3_600_000).toISOString(), attendeeIds: [k2.user.id], zustellung: { senden: true, einzelchats: false, gruppenChatIds: [] }, clientId: 'n2' + t } });
  console.log('A1 POST einzelchats=false', r2.status(), JSON.stringify((await r2.json()).zustellung));
});
