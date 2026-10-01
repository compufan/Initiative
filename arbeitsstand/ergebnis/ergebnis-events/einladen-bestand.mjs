// Bestandsaufnahme "Einladen" gegen den laufenden Server (Port 8080).
//
// Aufruf:  node einladen-bestand.mjs            (schreibt einladen-bestand-lauf.json daneben)
// Umgebung: E2E_API_URL (Standard http://localhost:8080)
//
// Vier Nutzer A-D, ein Gruppenchat G (A, B, C), Einzelchats AB, AC, BC, AD.
// D ist NICHT in G. Jeder Nutzer hat einen Websocket, damit sichtbar wird, was
// der Server in Echtzeit ausspielt (message.new / message.updated / event.updated
// / event.deleted). Das Skript ist wiederverwendbar: Folgearbeiten koennen die
// Hilfen (`aufbau`, `karten`, `sicht`) uebernehmen und eigene Szenarien anhaengen.
//
// Nur Node >= 22 (globales fetch und WebSocket), keine Abhaengigkeiten.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WURZEL = process.env.E2E_API_URL ?? 'http://localhost:8080';
const API = `${WURZEL}/api/v1`;
const HIER = dirname(fileURLToPath(import.meta.url));

const schlafen = (ms) => new Promise((fertig) => setTimeout(fertig, ms));

/** Direkt in der Entwicklungsdatenbank nachsehen (nur Lesen). Ohne psql: null. */
function datenbank(sql) {
  try {
    return execFileSync('psql', [process.env.DATABASE_URL ?? '', '-tAc', sql], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}
const kennung = (id) => String(id).slice(-6);

async function aufruf(token, methode, pfad, body) {
  const antwort = await fetch(`${API}${pfad}`, {
    method: methode,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  const text = await antwort.text();
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

/** Ein Websocket je Nutzer; `seit()` liefert, was seit der letzten Marke kam. */
function lauschen(sitzung) {
  const url = new URL('/ws', WURZEL.replace(/^http/, 'ws'));
  url.searchParams.set('token', sitzung.accessToken);
  const socket = new WebSocket(url);
  const eingang = [];
  socket.addEventListener('message', (nachricht) => {
    try {
      const ereignis = JSON.parse(String(nachricht.data));
      if (['message.new', 'message.updated', 'event.updated', 'event.deleted'].includes(ereignis.type)) {
        eingang.push(ereignis);
      }
    } catch {
      /* Kein JSON: Herzschlag o. ae. */
    }
  });
  return {
    offen: new Promise((fertig) => socket.addEventListener('open', fertig, { once: true })),
    marke: () => eingang.splice(0, eingang.length),
    seit: () => eingang.slice(),
    zu: () => socket.close(),
  };
}

const K = {}; // K.A .. K.D: Sitzung, Kennung, Websocket
let G; // Gruppenchat A, B, C
const DM = {}; // DM.AB, DM.AC, DM.BC, DM.AD

const ergebnis = { szenarien: {}, funde: [] };
const protokoll = [];
function zeile(text = '') {
  protokoll.push(text);
  console.log(text);
}

async function aufbau() {
  for (const name of ['A', 'B', 'C', 'D']) {
    const sitzung = await registrieren(`eb${name.toLowerCase()}`);
    K[name] = { name, sitzung, id: sitzung.user.id, token: sitzung.accessToken, ws: lauschen(sitzung) };
  }
  await Promise.all(Object.values(K).map((k) => k.ws.offen));
  const grp = await aufruf(K.A.token, 'POST', '/conversations', {
    type: 'group',
    title: 'Gruppe ABC',
    memberIds: [K.B.id, K.C.id],
  });
  G = grp.json.id;
  const paare = { AB: ['A', 'B'], AC: ['A', 'C'], BC: ['B', 'C'], AD: ['A', 'D'] };
  for (const [schluessel, [von, mit]] of Object.entries(paare)) {
    const antwort = await aufruf(K[von].token, 'POST', '/conversations', {
      type: 'direct',
      memberIds: [K[mit].id],
    });
    DM[schluessel] = antwort.json.id;
  }
  await schlafen(300);
}

const zeitraum = () => {
  const von = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const bis = new Date(Date.now() + 120 * 86_400_000).toISOString();
  return { von, bis };
};

function neuerTermin(titel, extra = {}) {
  const beginn = new Date(Date.now() + 5 * 86_400_000);
  return {
    title: `${titel} ${Math.random().toString(36).slice(2, 6)}`,
    startsAt: beginn.toISOString(),
    endsAt: new Date(beginn.getTime() + 3_600_000).toISOString(),
    ...extra,
  };
}

/** Welche Chats tragen eine Karte zu diesem Termin? Gelesen als ein Mitglied des Chats. */
async function karten(eventId) {
  const leser = { G: 'A', AB: 'A', AC: 'A', BC: 'B', AD: 'A' };
  const ids = { G, ...DM };
  const treffer = {};
  for (const [schluessel, chat] of Object.entries(ids)) {
    const antwort = await aufruf(K[leser[schluessel]].token, 'GET', `/conversations/${chat}/messages`);
    const karten = (antwort.json?.items ?? []).filter(
      (m) => m.type === 'event' && m.metadata?.eventId === eventId,
    );
    if (karten.length > 0) treffer[schluessel] = karten.length;
  }
  return treffer;
}

/** Wer sieht den Termin: Liste, Detail, Notizen (= "Teilnehmer" im Sinn des Servers). */
async function sicht(eventId) {
  const { von, bis } = zeitraum();
  const aus = {};
  for (const k of Object.values(K)) {
    const liste = await aufruf(
      k.token,
      'GET',
      `/calendar/events?from=${encodeURIComponent(von)}&to=${encodeURIComponent(bis)}`,
    );
    const detail = await aufruf(k.token, 'GET', `/calendar/events/${eventId}`);
    const notizen = await aufruf(k.token, 'GET', `/calendar/events/${eventId}/notes`);
    aus[k.name] = {
      liste: (liste.json?.items ?? []).some((e) => e.id === eventId),
      detail: detail.status,
      notizen: notizen.status,
    };
  }
  return aus;
}

const kurz = (teilnehmer) =>
  (teilnehmer ?? [])
    .map((t) => `${Object.values(K).find((k) => k.id === t.userId)?.name ?? '?'}:${t.status}`)
    .sort()
    .join(' ');

/**
 * Was der Websocket eines Nutzers seit der Marke zu EINEM Termin gemeldet hat.
 * Gefiltert nach Termin-Kennung, weil Ereignisse vorheriger Schritte ueber den
 * Postgres-Bus verzoegert eintreffen koennen und sonst in den naechsten Schritt
 * hineinragen.
 */
function ereignisse(name, eventId) {
  const gruppe = {};
  for (const e of K[name].ws.seit()) {
    const betrifft =
      e.payload?.event?.id ?? e.payload?.eventId ?? e.payload?.message?.metadata?.eventId ?? null;
    if (eventId && betrifft !== eventId) continue;
    gruppe[e.type] = (gruppe[e.type] ?? 0) + 1;
  }
  return gruppe;
}
const echtzeitAlle = (eventId) => Object.fromEntries(Object.keys(K).map((n) => [n, ereignisse(n, eventId)]));

async function anlegen(beschreibung, koerper) {
  await schlafen(300);
  Object.values(K).forEach((k) => k.ws.marke());
  const antwort = await aufruf(K.A.token, 'POST', '/calendar/events', koerper);
  await schlafen(400);
  if (antwort.status !== 201) {
    zeile(`  !! Anlegen fehlgeschlagen: ${antwort.status} ${JSON.stringify(antwort.json)}`);
    return null;
  }
  const termin = antwort.json;
  const auf = await karten(termin.id);
  const gesehen = await sicht(termin.id);
  const echtzeit = echtzeitAlle(termin.id);
  const eintrag = {
    beschreibung,
    eingabe: {
      conversationId: koerper.conversationId ?? null,
      attendeeIds: (koerper.attendeeIds ?? []).map((id) => Object.values(K).find((k) => k.id === id)?.name),
      announce: koerper.announce ?? '(Vorgabe)',
    },
    teilnehmer: kurz(termin.attendees),
    karteInChats: Object.keys(auf).length ? auf : '(keine)',
    sicht: gesehen,
    echtzeit,
    eventId: termin.id,
    messageIdInDb: datenbank(`select message_id from calendar_events where id = '${termin.id}'`) || null,
  };
  zeile(`\n## ${beschreibung}`);
  zeile(`  Teilnehmer laut Server:   ${eintrag.teilnehmer}`);
  zeile(`  Karte (Nachricht) in:     ${JSON.stringify(eintrag.karteInChats)}   (calendar_events.message_id gesetzt: ${eintrag.messageIdInDb ? 'ja' : 'nein'})`);
  zeile(
    `  Sicht (Liste/Detail/Notizen): ` +
      Object.entries(gesehen)
        .map(([n, s]) => `${n}=${s.liste ? 'L' : '-'}/${s.detail}/${s.notizen}`)
        .join('  '),
  );
  zeile(`  Echtzeit je Nutzer:       ${JSON.stringify(echtzeit)}`);
  return { termin, eintrag };
}

async function main() {
  zeile('# Lauf: Einladen, Bestand');
  await aufbau();
  zeile(`Nutzer: ${Object.values(K).map((k) => `${k.name}=${kennung(k.id)}`).join(' ')}`);
  zeile(`Chats: G=${kennung(G)} ${Object.entries(DM).map(([s, id]) => `${s}=${kennung(id)}`).join(' ')}`);

  // --- 1: Chat G, ohne attendeeIds -----------------------------------------
  const s1 = await anlegen('S1: conversationId=G, ohne attendeeIds', neuerTermin('S1', { conversationId: G }));
  ergebnis.szenarien.S1 = s1?.eintrag;

  // --- 2: Chat G + attendeeIds [D] ------------------------------------------
  const s2 = await anlegen(
    'S2: conversationId=G, attendeeIds=[D] (D ist nicht in G)',
    neuerTermin('S2', { conversationId: G, attendeeIds: [K.D.id] }),
  );
  ergebnis.szenarien.S2 = s2?.eintrag;

  // --- 3: Chat G + attendeeIds [B]: kann eine Auswahl einschraenken? --------
  const s3 = await anlegen(
    'S3: conversationId=G, attendeeIds=[B] (C nicht genannt)',
    neuerTermin('S3', { conversationId: G, attendeeIds: [K.B.id] }),
  );
  ergebnis.szenarien.S3 = s3?.eintrag;

  // --- 4: kein Chat, attendeeIds [B, C], announce true -----------------------
  const s4 = await anlegen(
    'S4: kein Chat, attendeeIds=[B,C], announce=true',
    neuerTermin('S4', { attendeeIds: [K.B.id, K.C.id], announce: true }),
  );
  ergebnis.szenarien.S4 = s4?.eintrag;

  // --- 5: kein Chat, niemand ------------------------------------------------
  const s5 = await anlegen('S5: kein Chat, keine attendeeIds', neuerTermin('S5'));
  ergebnis.szenarien.S5 = s5?.eintrag;

  // --- 6: Einzelchat AB + attendeeIds [C, D] ----------------------------------
  const s6 = await anlegen(
    'S6: conversationId=AB, attendeeIds=[C,D]',
    neuerTermin('S6', { conversationId: DM.AB, attendeeIds: [K.C.id, K.D.id] }),
  );
  ergebnis.szenarien.S6 = s6?.eintrag;

  // --- 7: Chat G, announce=false ------------------------------------------------
  const s7 = await anlegen(
    'S7: conversationId=G, announce=false',
    neuerTermin('S7', { conversationId: G, announce: false }),
  );
  ergebnis.szenarien.S7 = s7?.eintrag;

  // --- 7b: Zusage durch Eingeladene, die nicht im Chat des Termins sitzen ----
  zeile('\n## S7b: Zusage durch Eingeladene, die NICHT Mitglied des Chats sind, an den der Termin gebunden ist');
  const probe = {};
  for (const [bez, name, termin] of [
    ['D in S2 (Chat G)', 'D', s2.termin],
    ['C in S6 (Chat AB)', 'C', s6.termin],
    ['D in S6 (Chat AB)', 'D', s6.termin],
  ]) {
    const detail = await aufruf(K[name].token, 'GET', `/calendar/events/${termin.id}`);
    const zusage = await aufruf(K[name].token, 'POST', `/calendar/events/${termin.id}/rsvp`, { status: 'yes' });
    probe[bez] = { detail: detail.status, rsvp: zusage.status, meldung: zusage.json?.error?.message ?? zusage.json?.message ?? null };
    zeile(`  ${bez}: Detail ${detail.status}, Zusage ${zusage.status}${probe[bez].meldung ? ` (${probe[bez].meldung})` : ''}`);
  }
  ergebnis.szenarien.S7b = probe;

  // --- 7c: nachtraeglich einladen (Detailansicht: PATCH attendeeIds) -----------
  zeile('\n## S7c: nachtraeglich einladen: A ladet D in S7 ein (PATCH attendeeIds), D ist nicht im Chat G');
  await schlafen(400);
  Object.values(K).forEach((k) => k.ws.marke());
  const nachtrag = await aufruf(K.A.token, 'PATCH', `/calendar/events/${s7.termin.id}`, {
    attendeeIds: [K.A.id, K.B.id, K.C.id, K.D.id],
  });
  await schlafen(400);
  const karteFuerD = await karten(s7.termin.id);
  zeile(`  PATCH: Status ${nachtrag.status}; Teilnehmer: ${kurz(nachtrag.json?.attendees)}`);
  zeile(`  Neue Nachrichten/Karten zu diesem Termin irgendwo: ${JSON.stringify(Object.keys(karteFuerD).length ? karteFuerD : '(keine)')}`);
  zeile(`  Echtzeit je Nutzer: ${JSON.stringify(echtzeitAlle(s7.termin.id))}  (D bekommt nur event.updated, keine Nachricht, keinen Push)`);
  ergebnis.szenarien.S7c = { teilnehmer: kurz(nachtrag.json?.attendees), karten: karteFuerD, echtzeit: echtzeitAlle(s7.termin.id) };

  // --- 8: Synchronitaet zweier Karten (Gruppe + Einzelchat) -----------------
  zeile('\n## S8: dieselbe Einladung als Karte in G UND in AB (zweite Karte per Nachrichtenweg)');
  const basis = s1.termin;
  Object.values(K).forEach((k) => k.ws.marke());
  const zweite = await aufruf(K.A.token, 'POST', `/conversations/${DM.AB}/messages`, {
    type: 'event',
    metadata: { eventId: basis.id },
    clientId: `zweite-${Date.now()}`,
  });
  await schlafen(300);
  zeile(
    `  A postet type=event, metadata.eventId=S1 in AB: Status ${zweite.status}; ` +
      `Karte traegt event=${zweite.json?.event ? 'ja' : 'nein'}, ` +
      `calendar_events.message_id zeigt weiter auf die erste Karte: ${
        datenbank(`select message_id = (select id from messages where conversation_id = '${G}' and metadata->>'eventId' = '${basis.id}') from calendar_events where id = '${basis.id}'`)
      } (t = ja)`,
  );
  zeile(`  Echtzeit nach der zweiten Karte, je Nutzer: ${JSON.stringify(echtzeitAlle(basis.id))}`);
  zeile('  -> jede Karte ist eine eigene Nachricht: zwei message.new, bei aktivem Push zwei Benachrichtigungen (Kennzeichen conversation:<Chat>).');

  Object.values(K).forEach((k) => k.ws.marke());
  const antwort = await aufruf(K.B.token, 'POST', `/calendar/events/${basis.id}/rsvp`, { status: 'maybe' });
  await schlafen(400);
  const inG = (await aufruf(K.A.token, 'GET', `/conversations/${G}/messages`)).json.items.find(
    (m) => m.type === 'event' && m.metadata?.eventId === basis.id,
  );
  const inAB = (await aufruf(K.A.token, 'GET', `/conversations/${DM.AB}/messages`)).json.items.find(
    (m) => m.type === 'event' && m.metadata?.eventId === basis.id,
  );
  zeile(`  B sagt "vielleicht" zu (RSVP ueber den Termin): Status ${antwort.status}`);
  zeile(`  Karte in G  (frisch geladen): ${kurz(inG?.event?.attendees)}`);
  zeile(`  Karte in AB (frisch geladen): ${kurz(inAB?.event?.attendees)}`);
  const echtzeit8 = echtzeitAlle(basis.id);
  zeile(`  Echtzeit je Nutzer nach der Zusage: ${JSON.stringify(echtzeit8)}`);
  const ereignisNutzlast = K.A.ws.seit().find((e) => e.type === 'event.updated');
  zeile(`  event.updated traegt: eventId=${kennung(ereignisNutzlast?.payload?.event?.id ?? '?')} (Schluessel: ${Object.keys(ereignisNutzlast?.payload ?? {}).join(',')}) - KEIN message.updated, die Karte wird nur ueber die Termin-Kennung nachgefuehrt`);
  ergebnis.szenarien.S8 = {
    zweiteKarteStatus: zweite.status,
    karteG: kurz(inG?.event?.attendees),
    karteAB: kurz(inAB?.event?.attendees),
    echtzeit: echtzeit8,
  };

  // --- 9: Abwaehlen bei einem Chat-Termin ---------------------------------
  await schlafen(500);
  zeile('\n## S9: Abwaehlen bei einem Termin MIT Chat (S3: Anna entfernt B und C aus attendeeIds)');
  const t3 = s3.termin;
  Object.values(K).forEach((k) => k.ws.marke());
  const abwahl = await aufruf(K.A.token, 'PATCH', `/calendar/events/${t3.id}`, { attendeeIds: [K.A.id] });
  await schlafen(300);
  zeile(`  PATCH attendeeIds=[A]: Status ${abwahl.status}; Teilnehmer danach: ${kurz(abwahl.json?.attendees)}`);
  const nach = await sicht(t3.id);
  zeile(
    `  Sicht danach (Liste/Detail/Notizen): ` +
      Object.entries(nach)
        .map(([n, s]) => `${n}=${s.liste ? 'L' : '-'}/${s.detail}/${s.notizen}`)
        .join('  '),
  );
  const bAntwort = await aufruf(K.B.token, 'POST', `/calendar/events/${t3.id}/rsvp`, { status: 'yes' });
  zeile(
    `  B (nicht mehr eingeladen, aber Chatmitglied) sagt trotzdem zu: Status ${bAntwort.status}; Teilnehmer: ${kurz(bAntwort.json?.attendees)}`,
  );
  ergebnis.szenarien.S9 = {
    teilnehmerNachAbwahl: kurz(abwahl.json?.attendees),
    sichtNachAbwahl: nach,
    rsvpNachAbwahl: { status: bAntwort.status, teilnehmer: kurz(bAntwort.json?.attendees) },
  };

  // --- 10: Ausladen bei einem Termin OHNE Chat ---------------------------------
  await schlafen(500);
  zeile('\n## S10: Ausladen bei einem Termin OHNE Chat (S4: Anna ladet B aus)');
  const t4 = s4.termin;
  Object.values(K).forEach((k) => k.ws.marke());
  const aus = await aufruf(K.A.token, 'DELETE', `/calendar/events/${t4.id}/attendees/${K.B.id}`);
  await schlafen(300);
  const nach4 = await sicht(t4.id);
  zeile(`  DELETE attendee B: Status ${aus.status}; Teilnehmer danach: ${kurz(aus.json?.attendees)}`);
  zeile(
    `  Sicht danach: ` +
      Object.entries(nach4)
        .map(([n, s]) => `${n}=${s.liste ? 'L' : '-'}/${s.detail}/${s.notizen}`)
        .join('  '),
  );
  zeile(`  Echtzeit danach (B erfaehrt vom Ausladen nichts): ${JSON.stringify(echtzeitAlle(t4.id))}`);
  ergebnis.szenarien.S10 = { teilnehmer: kurz(aus.json?.attendees), sicht: nach4 };

  // --- 11: Spaeteres Mitglied ------------------------------------------------
  zeile('\n## S11: Gruppe G2 (A, B), Termin mit Karte, danach kommt C als Mitglied dazu');
  const g2 = (
    await aufruf(K.A.token, 'POST', '/conversations', { type: 'group', title: 'Gruppe AB', memberIds: [K.B.id] })
  ).json.id;
  const t11 = (
    await aufruf(K.A.token, 'POST', '/calendar/events', neuerTermin('S11', { conversationId: g2 }))
  ).json;
  await aufruf(K.A.token, 'POST', `/conversations/${g2}/members`, { memberIds: [K.C.id] });
  await schlafen(300);
  const cListe = await aufruf(
    K.C.token,
    'GET',
    `/calendar/events?from=${encodeURIComponent(zeitraum().von)}&to=${encodeURIComponent(zeitraum().bis)}`,
  );
  const cDetail = await aufruf(K.C.token, 'GET', `/calendar/events/${t11.id}`);
  const cNotizen = await aufruf(K.C.token, 'GET', `/calendar/events/${t11.id}/notes`);
  const cKarten = await aufruf(K.C.token, 'GET', `/conversations/${g2}/messages`);
  zeile(
    `  C (spaeter Mitglied, sieht den Verlauf nicht): Liste=${(cListe.json.items ?? []).some((e) => e.id === t11.id)} Detail=${cDetail.status} Notizen=${cNotizen.status}; Karten im Verlauf sichtbar: ${(cKarten.json.items ?? []).filter((m) => m.type === 'event').length}; Teilnehmerliste des Termins: ${kurz(cDetail.json?.attendees)}`,
  );
  ergebnis.szenarien.S11 = {
    cListe: (cListe.json.items ?? []).some((e) => e.id === t11.id),
    cDetail: cDetail.status,
    cNotizen: cNotizen.status,
    cKartenImVerlauf: (cKarten.json.items ?? []).filter((m) => m.type === 'event').length,
  };

  // --- 12: Fremde eventId in eine Karte legen ----------------------------------
  zeile('\n## S12: D (unbeteiligt) legt die Kennung eines fremden Termins (S5: nur A) in eine Karte im Chat AD');
  const fremd = await aufruf(K.D.token, 'POST', `/conversations/${DM.AD}/messages`, {
    type: 'event',
    metadata: { eventId: s5.termin.id },
    clientId: `fremd-${Date.now()}`,
  });
  const direkt = await aufruf(K.D.token, 'GET', `/calendar/events/${s5.termin.id}`);
  zeile(
    `  Direktabruf durch D: ${direkt.status}; ueber die Karte: Status ${fremd.status}, event=${fremd.json?.event ? `"${fremd.json.event.title}" mit ${fremd.json.event.attendees.length} Teilnehmer(n)` : 'nein'}`,
  );
  ergebnis.szenarien.S12 = {
    direktabruf: direkt.status,
    karteStatus: fremd.status,
    karteTraegtTermin: Boolean(fremd.json?.event),
  };

  // --- 13: Loeschen ---------------------------------------------------------
  zeile('\n## S13: Termin S1 loeschen (Karten in G und AB)');
  Object.values(K).forEach((k) => k.ws.marke());
  const weg = await aufruf(K.A.token, 'DELETE', `/calendar/events/${basis.id}`);
  await schlafen(300);
  const kartenDanach = {};
  for (const [schluessel, chat] of Object.entries({ G, AB: DM.AB })) {
    const liste = await aufruf(K.A.token, 'GET', `/conversations/${chat}/messages`);
    const treffer = (liste.json?.items ?? []).filter(
      (m) => m.type === 'event' && m.metadata?.eventId === basis.id,
    );
    kartenDanach[schluessel] = treffer.map((m) => ({ gibtEsNoch: !m.deletedAt, traegtTermin: Boolean(m.event) }));
  }
  zeile(`  DELETE: Status ${weg.status}; Karten danach: ${JSON.stringify(kartenDanach)}`);
  zeile(`  Echtzeit je Nutzer: ${JSON.stringify(echtzeitAlle(basis.id))}`);
  ergebnis.szenarien.S13 = { status: weg.status, kartenDanach };

  Object.values(K).forEach((k) => k.ws.zu());
  writeFileSync(join(HIER, 'einladen-bestand-lauf.json'), JSON.stringify(ergebnis, null, 2));
  writeFileSync(join(HIER, 'einladen-bestand-lauf.txt'), protokoll.join('\n') + '\n');
  zeile('\nFertig. Protokoll: einladen-bestand-lauf.txt / .json');
  process.exit(0);
}

main().catch((fehler) => {
  console.error(fehler);
  process.exit(1);
});
