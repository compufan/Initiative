import { call, konto, in3Tagen, msgs } from './lib.mjs';
const a = await konto('pfa'), b = await konto('pfb'), c = await konto('pfc'), w = await konto('pfw');
const g = (await call('POST', '/conversations', a.token, { type: 'group', title: 'PF', memberIds: [b.id, c.id] })).body;
// Alt: nur conversationId
let r = await call('POST', '/calendar/events', a.token, { title: 'Alt1', ...in3Tagen(), conversationId: g.id });
console.log('alt nur conversationId', r.status, 'attendees', r.body.attendees?.length, 'zustellung' in r.body, 'convId', r.body.conversationId === g.id);
// Alt: attendeeIds mit Aussenstehendem
r = await call('POST', '/calendar/events', a.token, { title: 'Alt2', ...in3Tagen(), conversationId: g.id, attendeeIds: [w.id] });
console.log('alt + W', r.status, r.body.attendees?.map(x => x.userId === w.id ? 'W' : 'x').join(','));
const alt2 = r.body;
// W sieht den Termin, aber hat keine Karte
const wd = await call('GET', `/calendar/events/${alt2.id}`, w.token);
console.log('W Detail', wd.status);
// Alt: leere attendeeIds + announce false
r = await call('POST', '/calendar/events', a.token, { title: 'Alt3', ...in3Tagen(), conversationId: g.id, attendeeIds: [], announce: false });
console.log('alt announce false', r.status, 'attendees', r.body.attendees?.length);
// Alt: PATCH eines Nicht-Erstellers (Admin?) b ist Member -> 403 erwartet
r = await call('PATCH', `/calendar/events/${alt2.id}`, b.token, { title: 'x' });
console.log('PATCH member', r.status, r.body?.error?.message);
// Alt: PATCH attendeeIds (alter Editor) vom Ersteller: bisherige + c
const ids = alt2.attendees.map(x => x.userId).filter(x => x !== a.id);
r = await call('PATCH', `/calendar/events/${alt2.id}`, a.token, { title: 'Alt2b', attendeeIds: ids });
console.log('PATCH attendeeIds gleich', r.status, JSON.stringify(r.body.zustellung));
// Alt: PATCH attendeeIds ohne W -> W ausgeladen
r = await call('PATCH', `/calendar/events/${alt2.id}`, a.token, { attendeeIds: ids.filter(x => x !== w.id) });
console.log('PATCH ohne W', r.status, r.body.attendees?.length, JSON.stringify(r.body.zustellung));
console.log('W Detail nach Ausladen', (await call('GET', `/calendar/events/${alt2.id}`, w.token)).status);
// Karten in G
const ms = (await msgs(a, g.id)).filter(m => m.type === 'event');
console.log('Karten in G', ms.length);
