import { call, konto, in3Tagen, msgs } from './lib.mjs';
const a = await konto('pfdel'), b = await konto('pfdelb');
const g = (await call('POST', '/conversations', a.token, { type: 'group', title: 'PFD', memberIds: [b.id] })).body;
let r = await call('POST', '/calendar/events', a.token, { title: 'Karte weg', ...in3Tagen(), attendeeIds: [b.id], zustellung: { gruppenChatIds: [g.id] } });
const id = r.body.id;
console.log('anlegen', r.status, JSON.stringify(r.body.zustellung));
const karte = (await msgs(a, g.id)).find(m => m.type === 'event');
// Ersteller loescht SEINE Karte im Gruppenchat
r = await call('DELETE', `/messages/${karte.id}`, a.token);
console.log('Karte loeschen (Ersteller)', r.status);
console.log('B sieht Karte in G:', (await msgs(b, g.id)).filter(m => m.type === 'event' && !m.deletedAt).length);
let z = await call('GET', `/calendar/events/${id}/zustellung`, a.token);
console.log('zustellung lesen:', JSON.stringify(z.body));
// Editor: schickt gruppenChatIds [G] unveraendert -> nichts; Nachliefern?
r = await call('PATCH', `/calendar/events/${id}`, a.token, { zustellung: { gruppenChatIds: [g.id] } });
console.log('PATCH gruppenChatIds=[G]', r.status, 'Karten in G danach:', (await msgs(b, g.id)).filter(m => m.type === 'event' && !m.deletedAt).length);
r = await call('POST', `/calendar/events/${id}/zustellung/nachliefern`, a.token);
console.log('nachliefern', r.status, JSON.stringify(r.body.zustellung), 'Karten in G danach:', (await msgs(b, g.id)).filter(m => m.type === 'event' && !m.deletedAt).length);
// Termin loeschen: Rundruf/Fehler?
r = await call('DELETE', `/calendar/events/${id}`, a.token);
console.log('Termin loeschen', r.status);
