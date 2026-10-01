// Kleiner Lauf gegen die laufende API (Port 8080): Wirkt die neue Einladungs-Logik?
//
// Aufruf:  node einladen-neu-lauf.mjs            (schreibt einladen-neu-lauf.json daneben)
// Umgebung: E2E_API_URL (Standard http://localhost:8080), DATABASE_URL (für das
//           Anlegen der 150 Konten des letzten Szenarios; ohne: übersprungen)
//
// Fünf Nutzer A-E, ein Gruppenchat G = {A, B, C, D}; E ist in keinem Chat mit den
// anderen. Jeder Nutzer hat einen Websocket, damit sichtbar wird, was der Server
// in Echtzeit ausspielt. Der Dev-Server läuft mit REALTIME_BUS=postgres – das
// letzte Szenario prüft daher auch den Bus (gestückelte Empfängerliste, Hinweis
// mit Kennung bei grosser Nutzlast).
//
// Nur Node >= 22 (globales fetch und WebSocket), keine Abhängigkeiten.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WURZEL = process.env.E2E_API_URL ?? 'http://localhost:8080';
const API = `${WURZEL}/api/v1`;
const HIER = dirname(fileURLToPath(import.meta.url));
const schlafen = (ms) => new Promise((fertig) => setTimeout(fertig, ms));

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
    username: `${vorsatz}${zufall}`,
    password: 'passwort123',
    displayName: `${vorsatz.toUpperCase()} ${zufall}`,
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
      eingang.push(JSON.parse(String(nachricht.data)));
    } catch {
      /* Herzschlag o. ä. */
    }
  });
  return {
    offen: new Promise((fertig) => socket.addEventListener('open', fertig, { once: true })),
    marke: () => eingang.splice(0, eingang.length),
    seit: () => eingang.slice(),
    zu: () => socket.close(),
  };
}

const K = {};
let G;
const ergebnis = { pruefungen: [], szenarien: {} };
let fehler = 0;
function pruefe(name, bedingung, einzelheit = '') {
  ergebnis.pruefungen.push({ name, ok: Boolean(bedingung), einzelheit });
  if (!bedingung) fehler += 1;
  console.log(`  ${bedingung ? 'OK  ' : 'FAIL'} ${name}${bedingung || !einzelheit ? '' : `  -> ${einzelheit}`}`);
}

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

/** Die Karten (nicht gelöschte Nachrichten) zu einem Termin im Chat, gelesen als `wer`. */
async function kartenIn(wer, chat, eventId) {
  const antwort = await aufruf(K[wer].token, 'GET', `/conversations/${chat}/messages`);
  return (antwort.json?.items ?? []).filter(
    (m) => m.type === 'event' && !m.deletedAt && m.metadata?.eventId === eventId,
  );
}
/** Alle Event-Nachrichten im Chat, auch ohne Kennung (für den Blick eines Nicht-Eingeladenen). */
async function eventNachrichten(wer, chat) {
  const antwort = await aufruf(K[wer].token, 'GET', `/conversations/${chat}/messages`);
  return (antwort.json?.items ?? []).filter((m) => m.type === 'event' && !m.deletedAt);
}
const einzel = {};
async function einzelChat(von, mit) {
  const antwort = await aufruf(K[von].token, 'POST', '/conversations', { type: 'direct', memberIds: [K[mit].id] });
  return antwort.json.id;
}
const typen = (name, eventId) => {
  const zaehler = {};
  for (const e of K[name].ws.seit()) {
    const betrifft = e.payload?.event?.id ?? e.payload?.eventId ?? e.payload?.message?.metadata?.eventId ?? null;
    if (eventId && betrifft !== eventId) continue;
    zaehler[e.type] = (zaehler[e.type] ?? 0) + 1;
  }
  return zaehler;
};

async function main() {
  console.log('# Lauf: Einladen, neue Logik');
  for (const n of ['a', 'b', 'c', 'd', 'e']) {
    const s = await registrieren(`en${n}`);
    const name = n.toUpperCase();
    K[name] = { name, id: s.user.id, token: s.accessToken, ws: lauschen(s) };
  }
  await Promise.all(Object.values(K).map((k) => k.ws.offen));
  const grp = await aufruf(K.A.token, 'POST', '/conversations', {
    type: 'group',
    title: 'Gruppe ABCD',
    memberIds: [K.B.id, K.C.id, K.D.id],
  });
  G = grp.json.id;
  await schlafen(300);
  const alleWs = () => Object.values(K).forEach((k) => k.ws.marke());

  // ---- 1. Alle Mitglieder von G eingeladen, G gewählt ------------------------
  console.log('\n## 1. Alle in G eingeladen, G gewählt: Gruppenkarte UND Einzelkarten');
  alleWs();
  const s1 = await aufruf(K.A.token, 'POST', '/calendar/events', termin('Grillen', {
    attendeeIds: [K.B.id, K.C.id, K.D.id],
    zustellung: { senden: true, einzelchats: true, gruppenChatIds: [G] },
  }));
  await schlafen(400);
  pruefe('201 und zustellung in der Antwort', s1.status === 201 && s1.json.zustellung, JSON.stringify(s1.json).slice(0, 200));
  const t1 = s1.json;
  pruefe('conversationId = G', t1.conversationId === G);
  pruefe('Gruppenkarte genannt', t1.zustellung.gruppen.length === 1 && t1.zustellung.gruppen[0].conversationId === G);
  pruefe('drei Einzelkarten, drei neue Chats', t1.zustellung.einzelchats === 3 && t1.zustellung.neueEinzelchats === 3);
  pruefe('nichts ausgelassen, nichts ausstehend', t1.zustellung.ausgelassen.length === 0 && t1.zustellung.ausstehend === 0);
  pruefe('eine Karte in G', (await kartenIn('A', G, t1.id)).length === 1);
  for (const p of ['B', 'C', 'D']) {
    einzel[p] = await einzelChat('A', p);
    pruefe(`eine Karte im Einzelchat A–${p}`, (await kartenIn('A', einzel[p], t1.id)).length === 1);
  }
  pruefe('B sieht ihre Karte mit dem Termin darin', (await kartenIn('B', einzel.B, t1.id))[0]?.event?.title === t1.title);
  ergebnis.szenarien.s1 = { zustellung: t1.zustellung, echtzeit: Object.fromEntries(Object.keys(K).map((n) => [n, typen(n, t1.id)])) };

  // ---- 2. D nicht eingeladen: die Gruppe fällt aus ----------------------------
  console.log('\n## 2. D nicht eingeladen: G wird ausgelassen, Einzelkarten bleiben, D sieht nichts');
  alleWs();
  const s2 = await aufruf(K.A.token, 'POST', '/calendar/events', termin('Nur zu dritt', {
    attendeeIds: [K.B.id, K.C.id],
    zustellung: { gruppenChatIds: [G] },
  }));
  await schlafen(400);
  const t2 = s2.json;
  pruefe('201', s2.status === 201, JSON.stringify(s2.json).slice(0, 200));
  pruefe('G ausgelassen, D fehlt', t2.zustellung.ausgelassen[0]?.conversationId === G && t2.zustellung.ausgelassen[0]?.fehlend?.[0] === K.D.id);
  pruefe('keine Karte in G', (await kartenIn('A', G, t2.id)).length === 0);
  pruefe('conversationId leer', t2.conversationId === null);
  pruefe('Karten in AB und AC', (await kartenIn('A', einzel.B, t2.id)).length === 1 && (await kartenIn('A', einzel.C, t2.id)).length === 1);
  pruefe('keine Karte in AD', (await kartenIn('A', einzel.D, t2.id)).length === 0);
  const dDetail = await aufruf(K.D.token, 'GET', `/calendar/events/${t2.id}`);
  pruefe('D: Detail 404', dDetail.status === 404, String(dDetail.status));
  const dRsvp = await aufruf(K.D.token, 'POST', `/calendar/events/${t2.id}/rsvp`, { status: 'yes' });
  pruefe('D: Zusage 404', dRsvp.status === 404, String(dRsvp.status));
  const dNotizen = await aufruf(K.D.token, 'GET', `/calendar/events/${t2.id}/notes`);
  pruefe('D: Notizen 404', dNotizen.status === 404, String(dNotizen.status));
  const von = new Date(Date.now() - 86_400_000).toISOString();
  const bis = new Date(Date.now() + 60 * 86_400_000).toISOString();
  const dListe = await aufruf(K.D.token, 'GET', `/calendar/events?from=${encodeURIComponent(von)}&to=${encodeURIComponent(bis)}`);
  pruefe('D: Liste ohne diesen Termin', !(dListe.json?.items ?? []).some((e) => e.id === t2.id));
  pruefe('D bekam keinen Rundruf zu diesem Termin', Object.keys(typen('D', t2.id)).length === 0, JSON.stringify(typen('D', t2.id)));

  // ---- 3. Eine Zusage gilt in allen Karten ------------------------------------
  console.log('\n## 3. B sagt in ihrer Einzelkarte zu – überall derselbe Stand, derselbe Rundruf');
  alleWs();
  const rsvp = await aufruf(K.B.token, 'POST', `/calendar/events/${t1.id}/rsvp`, { status: 'yes' });
  await schlafen(500);
  pruefe('200', rsvp.status === 200);
  const inG = (await kartenIn('C', G, t1.id))[0];
  const inAC = (await kartenIn('C', einzel.C, t1.id))[0];
  const inAD = (await kartenIn('D', einzel.D, t1.id))[0];
  const bStatus = (k) => k?.event?.attendees?.find((a) => a.userId === K.B.id)?.status;
  pruefe('Karte in G zeigt B: yes', bStatus(inG) === 'yes');
  pruefe('Karte in AC zeigt B: yes', bStatus(inAC) === 'yes');
  pruefe('Karte in AD zeigt B: yes', bStatus(inAD) === 'yes');
  const staende = {};
  for (const n of ['A', 'B', 'C', 'D']) {
    const e = K[n].ws.seit().filter((x) => x.type === 'event.updated' && x.payload.event.id === t1.id);
    staende[n] = e.map((x) => x.payload.event.stand);
  }
  pruefe('A, B, C, D bekamen je EINEN event.updated mit gleichem Stand',
    Object.values(staende).every((s) => s.length === 1) && new Set(Object.values(staende).map((s) => s[0])).size === 1,
    JSON.stringify(staende));
  pruefe('E (nicht eingeladen) bekam nichts', Object.keys(typen('E', t1.id)).length === 0);
  ergebnis.szenarien.s3 = { staende };

  // ---- 4. Ausladen -----------------------------------------------------------
  console.log('\n## 4. D wird ausgeladen: Zugang weg, Einzelkarte gelöscht, Gruppenkarte bleibt (für D leer)');
  alleWs();
  const karteAD = (await kartenIn('A', einzel.D, t1.id))[0];
  const s4 = await aufruf(K.A.token, 'PATCH', `/calendar/events/${t1.id}`, { attendeeIds: [K.B.id, K.C.id] });
  await schlafen(500);
  pruefe('200', s4.status === 200, JSON.stringify(s4.json).slice(0, 200));
  pruefe('D ist kein Teilnehmer mehr', !s4.json.attendees.some((a) => a.userId === K.D.id));
  pruefe('D: Detail 404', (await aufruf(K.D.token, 'GET', `/calendar/events/${t1.id}`)).status === 404);
  pruefe('Einzelkarte A–D gelöscht', (await kartenIn('A', einzel.D, t1.id)).length === 0 && Boolean(karteAD));
  const gD = await eventNachrichten('D', G);
  pruefe('Gruppenkarte bleibt, zeigt D aber nichts', gD.length >= 1 && gD.every((m) => !m.event && !m.metadata?.eventId), JSON.stringify(gD[0] ?? null).slice(0, 200));
  const gB = await kartenIn('B', G, t1.id);
  pruefe('B sieht die Gruppenkarte weiter mit Termin', gB.length === 1 && gB[0].event?.title === t1.title);
  const dTypen = typen('D', t1.id);
  const ausgeladen = K.D.ws.seit().find((x) => x.type === 'event.deleted' && x.payload.eventId === t1.id);
  pruefe('D bekam event.deleted mit Grund "ausgeladen"', ausgeladen?.payload?.grund === 'ausgeladen', JSON.stringify(dTypen));
  pruefe('D bekam kein event.updated', !dTypen['event.updated']);

  // ---- 5. Zeit/Ort ändern ----------------------------------------------------
  console.log('\n## 5. Ort ändern: keine neue Karte, nur der Stand');
  const vorher = await aufruf(K.A.token, 'GET', `/conversations/${einzel.B}/messages`);
  const nEvents = (x) => (x.json?.items ?? []).filter((m) => m.type === 'event').length;
  const s5 = await aufruf(K.A.token, 'PATCH', `/calendar/events/${t1.id}`, { location: 'Waldhütte' });
  pruefe('200', s5.status === 200 && s5.json.location === 'Waldhütte');
  const nachher = await aufruf(K.A.token, 'GET', `/conversations/${einzel.B}/messages`);
  pruefe('keine zusätzliche Karte in AB', nEvents(vorher) === nEvents(nachher));
  pruefe('Antworten bleiben (B: yes)', s5.json.attendees.find((a) => a.userId === K.B.id)?.status === 'yes');

  // ---- 6. Absagen ------------------------------------------------------------
  console.log('\n## 6. Absagen: Karten bleiben, Zusagen gesperrt; Wiederaufnehmen geht');
  const s6 = await aufruf(K.A.token, 'PATCH', `/calendar/events/${t1.id}`, { status: 'cancelled' });
  pruefe('200, status cancelled', s6.status === 200 && s6.json.status === 'cancelled');
  pruefe('Karte in G zeigt "cancelled"', (await kartenIn('B', G, t1.id))[0]?.event?.status === 'cancelled');
  const r6 = await aufruf(K.C.token, 'POST', `/calendar/events/${t1.id}/rsvp`, { status: 'yes' });
  pruefe('Zusage: 409', r6.status === 409 && r6.json?.error?.message === 'Der Termin ist abgesagt.', JSON.stringify(r6.json));
  const s6b = await aufruf(K.A.token, 'PATCH', `/calendar/events/${t1.id}`, { status: 'confirmed' });
  pruefe('Wiederaufnehmen', s6b.status === 200 && s6b.json.status === 'confirmed');
  pruefe('Zusage geht wieder', (await aufruf(K.C.token, 'POST', `/calendar/events/${t1.id}/rsvp`, { status: 'yes' })).status === 200);

  // ---- 7. Löschen ------------------------------------------------------------
  console.log('\n## 7. Löschen: alle Karten weg');
  alleWs();
  const del = await aufruf(K.A.token, 'DELETE', `/calendar/events/${t1.id}`);
  await schlafen(500);
  pruefe('204', del.status === 204);
  pruefe('keine Karte mehr in G, AB, AC', (await kartenIn('A', G, t1.id)).length + (await kartenIn('A', einzel.B, t1.id)).length + (await kartenIn('A', einzel.C, t1.id)).length === 0);
  const weg = K.C.ws.seit().filter((x) => x.type === 'message.deleted').length;
  pruefe('C bekam message.deleted für G und AC', weg === 2, String(weg));
  pruefe('C bekam event.deleted mit Grund "geloescht"', K.C.ws.seit().some((x) => x.type === 'event.deleted' && x.payload.grund === 'geloescht'));

  // ---- 8. Alter Weg ----------------------------------------------------------
  console.log('\n## 8. Alter Weg (nur conversationId): wie vorher');
  const s8 = await aufruf(K.A.token, 'POST', '/calendar/events', termin('Alt', { conversationId: G }));
  pruefe('201, keine zustellung in der Antwort', s8.status === 201 && !('zustellung' in s8.json));
  pruefe('alle vier Mitglieder eingeladen', s8.json.attendees.length === 4);
  pruefe('eine Karte in G', (await kartenIn('B', G, s8.json.id)).length === 1);
  pruefe('keine Einzelkarte', (await kartenIn('A', einzel.B, s8.json.id)).length === 0);

  // ---- 9. Wiederholungsschutz ------------------------------------------------
  console.log('\n## 9. Doppelsenden: derselbe Termin');
  const schluessel = crypto.randomUUID();
  const eingabe = termin('Einmalig', { attendeeIds: [K.B.id], zustellung: {}, clientId: schluessel });
  const a9 = await aufruf(K.A.token, 'POST', '/calendar/events', eingabe);
  const b9 = await aufruf(K.A.token, 'POST', '/calendar/events', eingabe);
  pruefe('201 dann 200, derselbe Termin', a9.status === 201 && b9.status === 200 && a9.json.id === b9.json.id, `${a9.status}/${b9.status}`);
  pruefe('nur eine Karte in AB', (await kartenIn('A', einzel.B, a9.json.id)).length === 1);

  // ---- 10. Viele Eingeladene über den Postgres-Bus ---------------------------
  console.log('\n## 10. 150 Eingeladene (Bus: postgres): Zeit, Karten, Rundruf');
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log('  (übersprungen: DATABASE_URL nicht gesetzt)');
  } else {
    const tag = Math.random().toString(36).slice(2, 8);
    const sql = `insert into users (id, username, display_name, password_hash, calendar_token)
      select gen_random_uuid(), 'v${tag}' || n, 'Viele ' || n, 'x', md5(random()::text || n::text)
        from generate_series(1, 150) n returning id`;
    const ids = execFileSync('psql', [url, '-tA', '-c', sql], { encoding: 'utf8' })
      .split('\n').map((z) => z.trim()).filter((z) => /^[0-9a-f-]{36}$/.test(z));
    // Einer der Eingeladenen hört mit – er braucht eine Sitzung: Wir nehmen E
    // als Mithörer und laden E zusätzlich ein.
    const alle = [...ids, K.E.id];
    alleWs();
    const t0 = Date.now();
    const v = await aufruf(K.A.token, 'POST', '/calendar/events', termin('Grosses Fest', {
      attendeeIds: alle,
      zustellung: { einzelchats: true, gruppenChatIds: [] },
    }));
    const dauer = Date.now() - t0;
    await schlafen(800);
    console.log(`  ${alle.length} Eingeladene: ${dauer} ms`);
    pruefe('201, 151 Einzelkarten zugestellt, nichts ausstehend',
      v.status === 201 && v.json.zustellung.einzelchats === 151 && v.json.zustellung.ausstehend === 0,
      JSON.stringify(v.json).slice(0, 300));
    const eTypen = typen('E', v.json?.id);
    pruefe('E (eingeladen) bekam den Termin-Rundruf: event.updated oder sync.hint mit Kennung',
      Boolean(eTypen['event.updated']) || K.E.ws.seit().some((x) => x.type === 'sync.hint' && x.payload.eventId === v.json.id),
      JSON.stringify(eTypen));
    const hinweis = K.E.ws.seit().filter((x) => x.type === 'sync.hint');
    console.log(`  Rundruf an E: ${JSON.stringify(eTypen)}, Hinweise: ${hinweis.map((h) => JSON.stringify(h.payload)).join(' ')}`);
    ergebnis.szenarien.s10 = { dauerMs: dauer, eTypen, hinweise: hinweis.map((h) => h.payload) };
    // Aufräumen: die 150 Testkonten wieder entfernen (Kaskade räumt Chats und Karten mit).
    execFileSync('psql', [url, '-tA', '-c', `delete from users where username like 'v${tag}%'`], { encoding: 'utf8' });
  }

  Object.values(K).forEach((k) => k.ws.zu());
  console.log(`\n${ergebnis.pruefungen.length - fehler} von ${ergebnis.pruefungen.length} Prüfungen bestanden.`);
  writeFileSync(join(HIER, 'einladen-neu-lauf.json'), JSON.stringify(ergebnis, null, 2));
  process.exit(fehler === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
