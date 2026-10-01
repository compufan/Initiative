import { call, konto, in3Tagen, msgs } from './lib.mjs';
const a = await konto('pfpl'), b = await konto('pfplb'), c = await konto('pfplc'), w = await konto('pfplw');
const g = (await call('POST', '/conversations', a.token, { type: 'group', title: 'PFP', memberIds: [b.id, c.id] })).body;
const s = new Date(Date.now() + 5 * 864e5).toISOString(), s2 = new Date(Date.now() + 6 * 864e5).toISOString();
let r = await call('POST', '/calendar/planning', a.token, { conversationId: g.id, title: 'Wann?', slots: [{ startsAt: s }, { startsAt: s2 }] });
console.log('planning', r.status, r.body.status, 'att', r.body.attendees?.length, 'conv', r.body.conversationId === g.id);
const id = r.body.id;
// W hinzufuegen (alter Editor: attendeeIds komplett)
const ids = r.body.attendees.map(x => x.userId).filter(x => x !== a.id);
r = await call('PATCH', `/calendar/events/${id}`, a.token, { attendeeIds: [...ids, w.id] });
console.log('PATCH +W', r.status, JSON.stringify(r.body.zustellung));
const wChats = (await call('GET', '/conversations', w.token)).body.items;
console.log('W Chats', wChats.length);
for (const ch of wChats) {
  const m = (await msgs(w, ch.id)).filter(x => x.type === 'event');
  console.log(' W Karte:', m.length, m[0]?.event?.status, m[0]?.event?.title);
}
// Absagen in Abstimmung
r = await call('PATCH', `/calendar/events/${id}`, a.token, { status: 'cancelled' });
console.log('absagen planning', r.status, r.body?.error?.message);
// W rsvp auf planning
r = await call('POST', `/calendar/events/${id}/rsvp`, w.token, { status: 'yes' });
console.log('W rsvp planning', r.status);
// Poll: kann W abstimmen? 
const ev = (await call('GET', `/calendar/events/${id}`, w.token)).body;
console.log('W sieht pollId', ev.pollId ? 'ja' : 'nein');
const poll = await call('GET', `/polls/${ev.pollId}`, w.token);
console.log('W Poll lesen', poll.status);
