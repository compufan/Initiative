// Prüfer: Löschen, während Phase 2 (Karten zustellen) noch läuft. Nutzer plA + 40 plX.
const WURZEL = process.env.E2E_API_URL ?? 'http://localhost:8080';
const API = `${WURZEL}/api/v1`;
const schlafen = (ms) => new Promise((f) => setTimeout(f, ms));
async function aufruf(token, methode, pfad, body) {
  const antwort = await fetch(`${API}${pfad}`, {
    method: methode,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await antwort.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: antwort.status, json };
}
async function registrieren(v) {
  const z = Math.random().toString(36).slice(2, 8);
  const a = await aufruf(null, 'POST', '/auth/register', { username: `pl${v}${z}`, password: 'passwort123', displayName: `PL ${v} ${z}` });
  if (a.status >= 300) throw new Error(`Registrierung ${a.status}`);
  return { id: a.json.user.id, token: a.json.accessToken };
}
const A = await registrieren('a');
const X = [];
for (let i = 0; i < 40; i += 1) X.push(await registrieren('x'));
const titel = `Loeschen ${Math.random().toString(36).slice(2, 8)}`;
const b = new Date(Date.now() + 5 * 86_400_000);
const url = new URL('/ws', WURZEL.replace(/^http/, 'ws'));
url.searchParams.set('token', A.token);
const ws = new WebSocket(url);
let erster = null;
const fertig = new Promise((f) => { erster = f; });
ws.addEventListener('message', (n) => {
  try { const e = JSON.parse(String(n.data)); if (e.type === 'message.new' && e.payload.message?.type === 'event') erster(e.payload.message.metadata.eventId); } catch {}
});
await new Promise((f) => ws.addEventListener('open', f, { once: true }));
const post = aufruf(A.token, 'POST', '/calendar/events', {
  title: titel, startsAt: b.toISOString(), endsAt: new Date(b.getTime() + 3_600_000).toISOString(),
  attendeeIds: X.map((x) => x.id), zustellung: { senden: true, einzelchats: true, gruppenChatIds: [] },
});
const id = await fertig;
console.log('erste Karte angekommen, Phase 2 läuft noch; lösche …', id);
const del = await aufruf(A.token, 'DELETE', `/calendar/events/${id}`);
console.log('DELETE', del.status);
const r = await post;
console.log('POST fertig:', r.status, JSON.stringify(r.json.zustellung));
await schlafen(500);
console.log('EVENT', id);
process.exit(0);
