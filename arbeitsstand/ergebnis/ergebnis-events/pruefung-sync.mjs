// Prüfer-Lauf "Synchronität und Echtzeit" gegen die API auf Port 8080.
// Nutzer: pzA (Ersteller), pzB, pzC, pzD, pzE; Gruppe G = {A,B,C,D}.
// Nur Node >= 22, keine Abhängigkeiten.

const WURZEL = process.env.E2E_API_URL ?? 'http://localhost:8080';
const API = `${WURZEL}/api/v1`;
const schlafen = (ms) => new Promise((f) => setTimeout(f, ms));

async function aufruf(token, methode, pfad, body) {
  const antwort = await fetch(`${API}${pfad}`, {
    method: methode,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await antwort.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: antwort.status, json };
}

async function registrieren(vorsatz) {
  const zufall = Math.random().toString(36).slice(2, 8);
  const antwort = await aufruf(null, 'POST', '/auth/register', {
    username: `pz${vorsatz}${zufall}`,
    password: 'passwort123',
    displayName: `PZ ${vorsatz.toUpperCase()} ${zufall}`,
  });
  if (antwort.status >= 300) throw new Error(`Registrierung ${vorsatz}: ${antwort.status}`);
  return antwort.json;
}

function lauschen(sitzung) {
  const url = new URL('/ws', WURZEL.replace(/^http/, 'ws'));
  url.searchParams.set('token', sitzung.accessToken);
  const socket = new WebSocket(url);
  const eingang = [];
  socket.addEventListener('message', (nachricht) => {
    try {
      eingang.push({ t: Date.now(), ...JSON.parse(String(nachricht.data)) });
    } catch {
      /* ignorieren */
    }
  });
  return {
    offen: new Promise((f) => socket.addEventListener('open', f, { once: true })),
    marke: () => eingang.splice(0, eingang.length),
    seit: () => eingang.slice(),
    zu: () => socket.close(),
  };
}

const K = {};
const beginn = () => new Date(Date.now() + 5 * 86_400_000);
function termin(titel, extra = {}) {
  const b = beginn();
  return {
    title: `${titel} ${Math.random().toString(36).slice(2, 6)}`,
    startsAt: b.toISOString(),
    endsAt: new Date(b.getTime() + 3_600_000).toISOString(),
    ...extra,
  };
}
const ergebnisse = [];
function pruefe(name, ok, einzelheit = '') {
  ergebnisse.push({ name, ok: Boolean(ok), einzelheit });
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${ok || !einzelheit ? '' : `  -> ${einzelheit}`}`);
}
const typen = (name, eventId) => {
  const z = {};
  for (const e of K[name].ws.seit()) {
    const b = e.payload?.event?.id ?? e.payload?.eventId ?? e.payload?.message?.metadata?.eventId ?? null;
    if (eventId && b !== eventId) continue;
    z[e.type] = (z[e.type] ?? 0) + 1;
  }
  return z;
};
const staende = (name, eventId) =>
  K[name].ws
    .seit()
    .filter((e) => e.type === 'event.updated' && e.payload.event.id === eventId)
    .map((e) => e.payload.event.stand);

async function nachrichten(wer, chat) {
  const a = await aufruf(K[wer].token, 'GET', `/conversations/${chat}/messages`);
  return a.json?.items ?? [];
}
async function karten(wer, chat, eventId) {
  return (await nachrichten(wer, chat)).filter(
    (m) => m.type === 'event' && !m.deletedAt && (m.metadata?.eventId === eventId || m.event?.id === eventId),
  );
}
async function einzelChat(von, mit) {
  const a = await aufruf(K[von].token, 'POST', '/conversations', { type: 'direct', memberIds: [K[mit].id] });
  return a.json.id;
}

async function main() {
  for (const n of ['a', 'b', 'c', 'd', 'e']) {
    const s = await registrieren(n);
    const name = n.toUpperCase();
    K[name] = { name, id: s.user.id, token: s.accessToken, ws: lauschen(s) };
  }
  await Promise.all(Object.values(K).map((k) => k.ws.offen));
  const grp = await aufruf(K.A.token, 'POST', '/conversations', {
    type: 'group',
    title: 'PZ Gruppe',
    memberIds: [K.B.id, K.C.id, K.D.id],
  });
  const G = grp.json.id;
  await schlafen(300);
  const alle = () => Object.values(K).forEach((k) => k.ws.marke());
  const dm = {};
  for (const n of ['B', 'C', 'D']) dm[n] = await einzelChat('A', n);

  // ------------------------------------------------------------------ 1
  console.log('# 1 Anlegen: Gruppe G + Einzelchats');
  alle();
  const c1 = await aufruf(K.A.token, 'POST', '/calendar/events', termin('Grillen', {
    attendeeIds: [K.B.id, K.C.id, K.D.id],
    zustellung: { senden: true, einzelchats: true, gruppenChatIds: [G] },
    clientId: `pz-${Math.random().toString(36).slice(2)}`,
  }));
  const E = c1.json.id;
  await schlafen(400);
  pruefe('Anlegen 201', c1.status === 201, JSON.stringify(c1.json).slice(0, 200));
  console.log('   B:', JSON.stringify(typen('B', E)), 'staende', JSON.stringify(staende('B', E)));
  console.log('   A:', JSON.stringify(typen('A', E)), 'staende', JSON.stringify(staende('A', E)));

  // ------------------------------------------------------------------ 2
  console.log('# 2 Zusage von B: alle Karten, alle Empfänger');
  alle();
  const r1 = await aufruf(K.B.token, 'POST', `/calendar/events/${E}/rsvp`, { status: 'yes' });
  await schlafen(300);
  for (const n of ['A', 'B', 'C', 'D']) {
    console.log(`   ${n}: stand`, JSON.stringify(staende(n, E)));
  }
  pruefe('B-Antwort trägt Stand', typeof r1.json.stand === 'number', JSON.stringify(r1.json.stand));
  for (const [wer, chat] of [['A', dm.B], ['B', dm.B], ['A', G], ['C', G], ['D', G]]) {
    const k = await karten(wer, chat, E);
    const b = k[0]?.event?.attendees.find((x) => x.userId === K.B.id);
    pruefe(`Karte in ${chat === G ? 'G' : 'DM-B'} für ${wer}: B=yes (Server-Sicht)`, b?.status === 'yes', JSON.stringify(b));
  }

  // ------------------------------------------------------------------ 3
  console.log('# 3 gleichzeitige Zusagen B,C,D (Reihenfolge der Rundrufe)');
  alle();
  const antworten = await Promise.all(
    ['B', 'C', 'D'].map((n) => aufruf(K[n].token, 'POST', `/calendar/events/${E}/rsvp`, { status: n === 'C' ? 'no' : 'maybe' })),
  );
  await schlafen(400);
  for (const n of ['A', 'B', 'C', 'D']) {
    const s = staende(n, E);
    const letzter = K[n].ws.seit().filter((e) => e.type === 'event.updated' && e.payload.event.id === E).at(-1);
    const maxStand = Math.max(...s);
    const maxFassung = K[n].ws.seit().filter((e) => e.type === 'event.updated' && e.payload.event.id === E && e.payload.event.stand === maxStand).at(-1);
    const st = Object.fromEntries(maxFassung.payload.event.attendees.map((x) => [x.userId.slice(0, 4), x.status]));
    console.log(`   ${n}: staende ${JSON.stringify(s)} monoton=${s.every((v, i) => i === 0 || v >= s[i - 1])} hoechste=${JSON.stringify(st)} letzteStand=${letzter?.payload.event.stand}`);
  }
  const antwStaende = antworten.map((a) => a.json.stand);
  console.log('   Antwort-Stände', JSON.stringify(antwStaende));

  // ------------------------------------------------------------------ 4
  console.log('# 4 C wird ausgeladen (Sollzustand B,D)');
  alle();
  const p1 = await aufruf(K.A.token, 'PATCH', `/calendar/events/${E}`, {
    attendeeIds: [K.B.id, K.D.id],
    zustellung: { senden: true, einzelchats: true },
  });
  await schlafen(400);
  console.log('   PATCH', p1.status, JSON.stringify(p1.json.zustellung));
  for (const n of ['A', 'B', 'C', 'D']) console.log(`   ${n}:`, JSON.stringify(typen(n, E)));
  const cEvent = K.C.ws.seit().filter((e) => e.type === 'event.deleted');
  console.log('   C event.deleted:', JSON.stringify(cEvent.map((e) => e.payload)));
  const gc = await karten('C', G, E);
  const gcAlle = (await nachrichten('C', G)).filter((m) => m.type === 'event' && !m.deletedAt);
  console.log('   C sieht in G event-Nachrichten:', gcAlle.length, 'mit Kennung', gcAlle.filter((m) => m.metadata?.eventId).length, 'mit event', gcAlle.filter((m) => m.event).length);
  const ga = await karten('A', G, E);
  pruefe('A: Gruppenkarte bleibt', ga.length === 1);
  pruefe('C: Gruppenkarte ohne Termin', gc.length === 0);
  const cdm = await karten('C', dm.C, E);
  pruefe('C: Einzelkarte weg', cdm.length === 0);
  const adm = await karten('A', dm.C, E);
  pruefe('A: Einzelkarte in DM-C weg', adm.length === 0);

  // ------------------------------------------------------------------ 5
  console.log('# 5 C wird wieder eingeladen');
  alle();
  const p2 = await aufruf(K.A.token, 'PATCH', `/calendar/events/${E}`, {
    attendeeIds: [K.B.id, K.C.id, K.D.id],
    zustellung: { senden: true, einzelchats: true },
  });
  await schlafen(400);
  console.log('   PATCH', p2.status, JSON.stringify(p2.json.zustellung));
  for (const n of ['A', 'B', 'C', 'D']) console.log(`   ${n}:`, JSON.stringify(typen(n, E)));
  const gc2 = await karten('C', G, E);
  pruefe('C: Gruppenkarte zeigt Termin wieder (Server)', gc2.length === 1 && gc2[0].event);
  const msgNewC = K.C.ws.seit().filter((e) => e.type === 'message.new');
  console.log('   C message.new:', msgNewC.length, ' -> Gruppenkarte nicht neu gesendet, nur Einzelkarte; event.updated für C:', staende('C', E));

  // ------------------------------------------------------------------ 6
  console.log('# 6 Absagen, Zusage -> 409, Wiederaufnehmen');
  alle();
  const ab = await aufruf(K.A.token, 'PATCH', `/calendar/events/${E}`, { status: 'cancelled' });
  await schlafen(300);
  const rs = await aufruf(K.B.token, 'POST', `/calendar/events/${E}/rsvp`, { status: 'yes' });
  pruefe('Absage 200', ab.status === 200);
  pruefe('Zusage bei Absage 409', rs.status === 409, String(rs.status));
  for (const n of ['B', 'C', 'D']) {
    const s = K[n].ws.seit().filter((e) => e.type === 'event.updated' && e.payload.event.id === E).at(-1);
    pruefe(`${n}: event.updated status cancelled`, s?.payload.event.status === 'cancelled');
  }
  await aufruf(K.A.token, 'PATCH', `/calendar/events/${E}`, { status: 'confirmed' });

  // ------------------------------------------------------------------ 7
  console.log('# 7 Löschen');
  alle();
  const del = await aufruf(K.A.token, 'DELETE', `/calendar/events/${E}`);
  await schlafen(400);
  pruefe('Löschen 204', del.status === 204, String(del.status));
  for (const n of ['A', 'B', 'C', 'D']) console.log(`   ${n}:`, JSON.stringify(typen(n)));
  for (const n of ['B', 'C', 'D']) {
    const k = await karten(n, G, E);
    const k2 = await karten(n, dm[n], E);
    pruefe(`${n}: keine Karte mehr`, k.length === 0 && k2.length === 0);
  }

  for (const k of Object.values(K)) k.ws.zu();
  const fehler = ergebnisse.filter((e) => !e.ok);
  console.log(`\n${ergebnisse.length - fehler.length}/${ergebnisse.length} OK`);
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
