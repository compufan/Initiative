import { call, konto, in3Tagen } from './lib.mjs';
import { execSync } from 'node:child_process';
const sql = (q) => execSync(`psql "${process.env.DATABASE_URL}" -At -c "${q}"`).toString().trim();
const a = await konto('pfgap'), b = await konto('pfgapb');
const pre = 'pfgapx' + Math.random().toString(36).slice(2, 7);
sql(`insert into users (id, username, display_name, password_hash, calendar_token) select gen_random_uuid(), '${pre}'||i, '${pre}'||i, 'x', gen_random_uuid()::text from generate_series(1,100) i`);
const fake = sql(`select id from users where username like '${pre}%'`).split('\n');
const ws = new WebSocket(`ws://localhost:8080/ws?token=${b.token}`);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let frames = [];
ws.onmessage = (m) => { const f = JSON.parse(m.data); if (f.type === 'event.updated' || f.type === 'sync.hint') frames.push([f.type, performance.now()]); };
let r = await call('POST', '/calendar/events', a.token, { title: 'Gap', ...in3Tagen(), attendeeIds: [b.id, ...fake], zustellung: { einzelchats: false, gruppenChatIds: [] } });
const id = r.body.id;
const gaps = [];
for (let i = 0; i < 6; i++) {
  frames = [];
  await call('POST', `/calendar/events/${id}/rsvp`, b.token, { status: i % 2 ? 'yes' : 'maybe' });
  await new Promise(r => setTimeout(r, 400));
  const up = frames.find(f => f[0] === 'event.updated'), hint = frames.find(f => f[0] === 'sync.hint');
  gaps.push(up && hint ? `${frames.map(f=>f[0]).join('>')} gap=${(hint[1] - up[1]).toFixed(1)}ms` : 'n/a ' + frames.map(f=>f[0]));
}
console.log(gaps.join('\n'));
ws.close();
sql(`delete from calendar_events where id='${id}'`);
sql(`delete from users where username like '${pre}%' or id in ('${a.id}','${b.id}')`);
