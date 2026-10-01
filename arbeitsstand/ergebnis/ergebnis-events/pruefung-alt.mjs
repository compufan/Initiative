// Prüfer: der alte Weg (ohne zustellung) – Rückfüllen/Löschen/Ausladen. Nutzer paA..paD.
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
  const a = await aufruf(null, 'POST', '/auth/register', { username: `pa${v}${z}`, password: 'passwort123', displayName: `PA ${v} ${z}` });
  if (a.status >= 300) throw new Error(`Registrierung ${a.status}`);
  return { id: a.json.user.id, token: a.json.accessToken };
}
const A = await registrieren('a'), B = await registrieren('b'), C = await registrieren('c'), D = await registrieren('d');
const G = (await aufruf(A.token, 'POST', '/conversations', { type: 'group', title: 'PA', memberIds: [B.id, C.id] })).json.id;
const dmB = (await aufruf(A.token, 'POST', '/conversations', { type: 'direct', memberIds: [B.id] })).json.id;
const b0 = new Date(Date.now() + 5 * 86_400_000);
const koerper = (extra) => ({ title: `Alt ${Math.random().toString(36).slice(2, 6)}`, startsAt: b0.toISOString(), endsAt: new Date(b0.getTime() + 3_600_000).toISOString(), ...extra });
const kartenAnzahl = async (wer, chat, id) => ((await aufruf(wer.token, 'GET', `/conversations/${chat}/messages`)).json.items ?? []).filter((m) => m.type === 'event' && !m.deletedAt && (m.metadata?.eventId === id || m.event?.id === id)).length;

console.log('# alt im Gruppenchat');
const e1 = (await aufruf(A.token, 'POST', '/calendar/events', koerper({ conversationId: G }))).json;
console.log(' Teilnehmer', e1.attendees.length, 'Karten in G (B):', await kartenAnzahl(B, G, e1.id));
console.log(' zustellung:', JSON.stringify((await aufruf(A.token, 'GET', `/calendar/events/${e1.id}/zustellung`)).json));
// alter Client: Einladung eines Vierten, nur attendeeIds (bisher + neu), kein zustellung
const inv = await aufruf(A.token, 'PATCH', `/calendar/events/${e1.id}`, { attendeeIds: [B.id, C.id, D.id] });
console.log(' alter invite ->', inv.status, JSON.stringify(inv.json.zustellung));
const dmD = (await aufruf(D.token, 'POST', '/conversations', { type: 'direct', memberIds: [A.id] })).json.id;
console.log(' D hat Karte im DM:', await kartenAnzahl(D, dmD, e1.id), ' D sieht Gruppenkarte? (D nicht in G):', (await aufruf(D.token, 'GET', `/conversations/${G}/messages`)).status);
// RSVP von D wirkt
const rs = await aufruf(D.token, 'POST', `/calendar/events/${e1.id}/rsvp`, { status: 'yes' });
console.log(' D-Zusage', rs.status);
const k = ((await aufruf(B.token, 'GET', `/conversations/${G}/messages`)).json.items ?? []).find((m) => m.type === 'event');
console.log(' B sieht in G: D =', k.event.attendees.find((x) => x.userId === D.id)?.status);
// löschen
const del = await aufruf(A.token, 'DELETE', `/calendar/events/${e1.id}`);
console.log(' DELETE', del.status, ' Karten übrig: G(B)', await kartenAnzahl(B, G, e1.id), ' DM(D)', await kartenAnzahl(D, dmD, e1.id));

console.log('# alt im Einzelchat');
const e2 = (await aufruf(A.token, 'POST', '/calendar/events', koerper({ conversationId: dmB }))).json;
console.log(' Teilnehmer', e2.attendees.length, 'zustellung:', JSON.stringify((await aufruf(A.token, 'GET', `/calendar/events/${e2.id}/zustellung`)).json));
const aus = await aufruf(A.token, 'DELETE', `/calendar/events/${e2.id}/attendees/${B.id}`);
console.log(' B ausgeladen', aus.status, ' Karte in DM für A:', await kartenAnzahl(A, dmB, e2.id), ' für B:', await kartenAnzahl(B, dmB, e2.id));
process.exit(0);
