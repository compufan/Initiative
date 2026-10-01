// Prüfer-Lauf: Wettläufe (Zusage gegen Ausladen, doppeltes Anlegen mit gleichem Schlüssel).
// Nutzer pwA (Ersteller), pwB, pwC. Nur Node >= 22.

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
  const a = await aufruf(null, 'POST', '/auth/register', {
    username: `pw${vorsatz}${zufall}`,
    password: 'passwort123',
    displayName: `PW ${vorsatz.toUpperCase()} ${zufall}`,
  });
  if (a.status >= 300) throw new Error(`Registrierung ${vorsatz}: ${a.status}`);
  return { id: a.json.user.id, token: a.json.accessToken };
}
const beginn = () => new Date(Date.now() + 5 * 86_400_000);
const termin = (titel, extra = {}) => {
  const b = beginn();
  return { title: titel, startsAt: b.toISOString(), endsAt: new Date(b.getTime() + 3_600_000).toISOString(), ...extra };
};

async function main() {
  const A = await registrieren('a');
  const B = await registrieren('b');
  const C = await registrieren('c');

  // ---------------------------------------------------------- 1 Zusage gegen Ausladen
  console.log('# 1 Zusage von C gegen gleichzeitiges Ausladen von C (nur Kalender, keine Karten)');
  let wiederauferstanden = 0;
  const N = 120;
  const treffer = [];
  for (let i = 0; i < N; i += 1) {
    const e = await aufruf(A.token, 'POST', '/calendar/events', termin(`Wettlauf ${i}`, {
      attendeeIds: [B.id, C.id],
      zustellung: { senden: false, einzelchats: false, gruppenChatIds: [] },
    }));
    const id = e.json.id;
    const versatz = (i % 12) - 3; // C ist 3 ms früher bis 8 ms später dran
    const p = (async () => {
      if (versatz > 0) await schlafen(versatz);
      return aufruf(A.token, 'PATCH', `/calendar/events/${id}`, {
        attendeeIds: [B.id],
        zustellung: { senden: false, einzelchats: false },
      });
    })();
    const r = (async () => {
      if (versatz < 0) await schlafen(-versatz);
      return aufruf(C.token, 'POST', `/calendar/events/${id}/rsvp`, { status: 'yes' });
    })();
    const [pa, ra] = await Promise.all([p, r]);
    const danach = await aufruf(A.token, 'GET', `/calendar/events/${id}`);
    const cDrin = danach.json.attendees.some((x) => x.userId === C.id);
    // C darf nur drin sein, wenn das Ausladen fehlgeschlagen ist.
    if (cDrin && pa.status === 200) {
      wiederauferstanden += 1;
      treffer.push({ i, versatz, patch: pa.status, rsvp: ra.status, patchHatC: pa.json.attendees.some((x) => x.userId === C.id) });
    }
    const cSieht = await aufruf(C.token, 'GET', `/calendar/events/${id}`);
    if (cDrin && pa.status === 200 && cSieht.status !== 200) console.log('  (C sieht den Termin nicht, obwohl drin?)');
  }
  console.log(`  Ausladen erfolgreich, C danach dennoch Teilnehmer: ${wiederauferstanden} von ${N}`);
  console.log('  Treffer:', JSON.stringify(treffer.slice(0, 6)));

  // ---------------------------------------------------------- 2 Doppeltes Anlegen mit gleichem Schlüssel
  console.log('# 2 Zwei gleichzeitige Anlegen mit gleichem clientId');
  const viele = [];
  for (let i = 0; i < 12; i += 1) viele.push((await registrieren('x')).id);
  const clientId = `pw-${Math.random().toString(36).slice(2)}`;
  const koerper = termin('Doppelt', {
    attendeeIds: viele,
    zustellung: { senden: true, einzelchats: true, gruppenChatIds: [] },
    clientId,
  });
  const [r1, r2] = await Promise.all([
    aufruf(A.token, 'POST', '/calendar/events', koerper),
    (async () => {
      await schlafen(15);
      return aufruf(A.token, 'POST', '/calendar/events', koerper);
    })(),
  ]);
  console.log('  erste :', r1.status, JSON.stringify(r1.json.zustellung));
  console.log('  zweite:', r2.status, JSON.stringify(r2.json.zustellung));
  console.log('  gleicher Termin:', r1.json.id === r2.json.id);

  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
