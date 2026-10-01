import { call, konto, in3Tagen } from './lib.mjs';
import { execSync } from 'node:child_process';
const sql = (q) => execSync(`psql "${process.env.DATABASE_URL}" -At -c "${q}"`).toString().trim();
const a = await konto('pfbig'), b = await konto('pfbigb');
const g = (await call('POST', '/conversations', a.token, { type: 'group', title: 'PFBIG', memberIds: [b.id] })).body;
const pre = 'pfbigx' + Math.random().toString(36).slice(2, 7);
// 205 weitere Mitglieder ohne Anmeldung (Hash 'x'), direkt in die Tabelle – wie es ueber 'Mitglieder hinzufuegen' in Schritten zu 100 geschaehe
sql(`insert into users (id, username, display_name, password_hash, calendar_token) select gen_random_uuid(), '${pre}'||i, '${pre}'||i, 'x', gen_random_uuid()::text from generate_series(1,205) i`);
sql(`insert into conversation_members (conversation_id, user_id, role) select '${g.id}', id, 'member' from users where username like '${pre}%'`);
console.log('Mitglieder', sql(`select count(*) from conversation_members where conversation_id='${g.id}'`));
let r = await call('POST', '/calendar/events', a.token, { title: 'Gross alt', ...in3Tagen(), conversationId: g.id });
console.log('alt anlegen', r.status, 'attendees', r.body.attendees?.length);
const id = r.body.id;
r = await call('DELETE', `/calendar/events/${id}/attendees/${b.id}`, a.token);
console.log('Ausladen einer Person', r.status, JSON.stringify(r.body?.error));
r = await call('PATCH', `/calendar/events/${id}`, a.token, { attendeeIds: r.body?.attendees?.map?.(x=>x.userId) ?? [] });
console.log('PATCH attendeeIds=[] (alle ausladen)', r.status, JSON.stringify(r.body?.error ?? r.body?.attendees?.length));
// Aufraeumen
sql(`delete from calendar_events where id='${id}'`);
sql(`delete from conversations where id='${g.id}'`);
sql(`delete from users where username like '${pre}%' or id in ('${a.id}','${b.id}')`);
console.log('aufgeraeumt', sql(`select count(*) from users where username like '${pre}%'`));
