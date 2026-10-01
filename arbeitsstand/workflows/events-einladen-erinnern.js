export const meta = {
  name: 'events-einladen-erinnern',
  description: 'Termine: Einladen (alle Personen, Gruppenchat, Zustellung in Gruppen- und Einzelchats, Synchronität) und Erinnerungen an ausstehende Antworten – API, Datenbank, Oberfläche im Hauptbaum',
  phases: [
    { title: 'Bestand', detail: 'Was gibt es schon? Durch Ausführen belegen' },
    { title: 'Entwurf', detail: 'Modell, Zustellung, Oberfläche, Abnahmekriterien' },
    { title: 'Bauen', detail: 'API und Datenbank, dann Oberfläche' },
    { title: 'Prüfen', detail: 'Prüfer mit je einer Linse' },
    { title: 'Gegenprobe', detail: 'Jeder Befund wird zu widerlegen versucht' },
    { title: 'Beheben', detail: 'Bestätigtes beheben, testen, committen' },
    { title: 'Abnahme', detail: 'Mehrnutzer-Test über beide Teile' },
  ],
}

const S = '/tmp/claude-0/-home-user-Initiative/b3e47b8f-e30a-5e75-8af6-6e58f2fcbe7c/scratchpad'
const DIR = '/home/user/Initiative'
const BASIS = 'd786eab'
const FUSS = 'Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01XgRwauwg73maopdhZbXcy7'
const ERG = `${S}/ergebnis-events`

const REGELN = `
Du arbeitest an einer kommerziellen, deutschsprachigen PWA (pnpm-Workspace im Repo ${DIR}: apps/web = Vite/React/TypeScript, apps/api = Rust/axum/sqlx/Postgres, packages/shared). Lies ZUERST ${S}/anforderungen-2.md – der Wunsch des Anwenders wörtlich, die Grundsätze und die verbindliche Auslegung (Abschnitte „Events: Einladen" und „Events: Erinnern").

ARBEITSBAUM: der HAUPTBAUM ${DIR}, Zweig claude/initiative-pwa-messenger-4b5ms6 (Ausgangspunkt ${BASIS}). Hier arbeitest nur du (neben dir arbeiten andere Agenten in EIGENEN Arbeitsbäumen unter ${S}/wt-* an anderen Themen – fasse diese nie an). Committe nur deine Dateien, gezielt mit  git add <Pfade> . Nichts pushen, keinen PR. Nichts installieren, keine neuen Abhängigkeiten (Rust-Crates und npm-Pakete).

GRUNDSÄTZE (hart): nur MIT/Apache-2.0/BSD; keine fremden Skripte/Server/kostenpflichtigen APIs; alles auf dem eigenen Server bzw. im Gerät. Deutsch: Bezeichner, Kommentare (sie erklären das WARUM, wie im Bestand), Oberflächentexte, Fehlertexte des Servers. Passe Stil, Kommentardichte, Namen und Idiome dem umgebenden Code an. Keine Modell- oder Werkzeugnamen in Code, Kommentaren oder Commits.

WERKZEUGE:
- Web (in ${DIR}/apps/web): npx tsc -p tsconfig.json --noEmit · npx prettier --check/--write <Dateien> · npx vitest run <Datei> (ganze Suite nur am Ende, ~30 s) · Browser-Tests: Dev-Server auf Port 5183 läuft (nach grösseren Änderungen neu starten mit  bash ${S}/vite-neu.sh ${DIR}/apps/web 5183 ${ERG}/vite.log ), dann  npx playwright test -c ${S}/pw/pw-main.config.ts e2e/<datei> -g "<name>" . Tests mit Anmeldung registrieren ihre Nutzer selbst gegen die API (Beispiel: e2e/termine.spec.ts).
- API (in ${DIR}/apps/api): cargo build / cargo test / cargo clippy --all-targets -- -D warnings (das Repo prüft Clippy streng). Die Datenbank (Postgres, DATABASE_URL ist gesetzt) ist die lokale Entwicklungsdatenbank; Migrationen in apps/api/migrations laufen beim Start des Servers (migrate.rs). Neue Migrationen: fortlaufende Nummer (die nächste ist 0023; das Erinnerungsthema nimmt 0024), idempotent und rückwärtsverträglich schreiben, ein Fremdschlüssel/Index-Stil wie in den bestehenden. Server neu starten:  bash ${S}/api-neu.sh ${ERG}/api.log  (Port 8080; andere Agenten nutzen ihn für Tests, halte Ausfälle kurz).
- Die Maschine hat nur 4 Kerne, die mit anderen Arbeiten geteilt werden: gezielt testen, keine Endlosschleifen, keine Hintergrundprozesse zurücklassen (ausser Dev-Server und API).
- Hilfsdateien, Skizzen, Messungen, Berichte nach ${ERG}/ (nicht ins Repo).

COMMITS: deutsche Nachricht (Betreff knapp, Rumpf erklärt das Warum), am Ende genau diese zwei Zeilen:
${FUSS}
`

const BESTAND_SCHEMA = {
  type: 'object',
  properties: {
    datei: { type: 'string' },
    zusammenfassung: { type: 'string' },
    luecken: { type: 'array', items: { type: 'string' } },
  },
  required: ['datei', 'zusammenfassung', 'luecken'],
}
const ENTWURF_SCHEMA = {
  type: 'object',
  properties: {
    datei: { type: 'string' },
    zusammenfassung: { type: 'string' },
    abnahmekriterien: { type: 'array', items: { type: 'string' } },
    risiken: { type: 'array', items: { type: 'string' } },
  },
  required: ['datei', 'zusammenfassung', 'abnahmekriterien'],
}
const BAU_SCHEMA = {
  type: 'object',
  properties: {
    commits: { type: 'array', items: { type: 'string' } },
    dateien: { type: 'array', items: { type: 'string' } },
    tests: { type: 'string' },
    abweichungen: { type: 'string' },
    offen: { type: 'string' },
  },
  required: ['commits', 'tests'],
}
const BEFUNDE_SCHEMA = {
  type: 'object',
  properties: {
    befunde: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          titel: { type: 'string' },
          datei: { type: 'string' },
          zeile: { type: 'number' },
          schwere: { type: 'string', enum: ['hoch', 'mittel', 'niedrig'] },
          szenario: { type: 'string' },
          vorschlag: { type: 'string' },
        },
        required: ['titel', 'datei', 'zeile', 'schwere', 'szenario', 'vorschlag'],
      },
    },
  },
  required: ['befunde'],
}
const URTEILE_SCHEMA = {
  type: 'object',
  properties: {
    urteile: {
      type: 'array',
      items: {
        type: 'object',
        properties: { titel: { type: 'string' }, echt: { type: 'boolean' }, begruendung: { type: 'string' } },
        required: ['titel', 'echt', 'begruendung'],
      },
    },
  },
  required: ['urteile'],
}
const BEHOBEN_SCHEMA = {
  type: 'object',
  properties: {
    commits: { type: 'array', items: { type: 'string' } },
    je_befund: { type: 'array', items: { type: 'object', properties: { titel: { type: 'string' }, ergebnis: { type: 'string' } }, required: ['titel', 'ergebnis'] } },
    tests: { type: 'string' },
  },
  required: ['commits', 'je_befund', 'tests'],
}

/* ------------------------------------------------------------ Aufträge */

const BESTAND_EINLADEN = `
THEMA EINLADEN – BESTANDSAUFNAHME (nur lesen und ausführen, keinen Produktivcode ändern).

Der Anwender wünscht (siehe anforderungen-2.md): In der Einladung zu Terminen (a) die Liste ALLER verfügbaren Personen immer unter dem Feld, auch ohne Suche; (b) Schnellwahl „Alle", „Gruppenchat …" (dessen Mitglieder, danach einzelne abwählbar); (c) sind alle Mitglieder eines Gruppenchats eingeladen, kommt die Einladung in den Gruppenchat UND in die Einzelchats mit den einzelnen Personen, SYNCHRON; sonst nur in die Einzelchats. „Beides ist eventuell schon umgesetzt."

Stelle fest, was der Bestand davon tut – durch LESEN und durch AUSFÜHREN, nicht durch Vermuten:
1. API (apps/api/src): modules/calendar.rs (create, update, rsvp, ausladen, assert_visible/assert_editable), services/calendar.rs (create_event: Teilnehmer = attendee_ids + Ersteller + alle Mitglieder des Chats; eine "event"-Nachricht im Chat; calendar_events.message_id; broadcast_event; EventExpander), services/messages.rs (NewMessage::entity, Expander, Benachrichtigungen/Push), services/conversations.rs (Einzelchats: finden/anlegen? Regeln, Sperren), services/notify.rs, modules/polls.rs (Termin aus Umfrage nutzt create_event), dto.rs, realtime (event_updated), Migrationen (calendar_events, event_attendees, messages). Wer sieht einen Termin (Liste/Detail)? Was geschieht bei Änderung der Teilnehmerliste (update)? Bei Löschen (messages?)?
2. Web (apps/web/src): modules/calendar/EventEditor.tsx (Feld „Eingeladen", Chatauswahl, „Im Chat ankündigen"), components/PersonenWahl.tsx (Vorschläge, Suche, gewählte Personen, woher kommen Personen: api.users.* – gibt es einen Weg, ALLE verfügbaren Personen zu listen? Was heisst „verfügbar": alle Nutzer des Servers, Kontakte, Mitglieder gemeinsamer Chats?), EventBubble.tsx, RsvpButtons.tsx, useCalendarEvents.ts und der Chat-Speicher (state/chat.ts): aktualisiert event_updated ALLE Karten mit derselben Termin-Kennung, auch in anderen Chats?
3. AUSFÜHREN gegen den laufenden Server (Port 8080): ein Skript (Node/Playwright APIRequestContext, Vorlage e2e/termine.spec.ts) registriert vier Nutzer A–D, legt einen Gruppenchat mit A, B, C und Einzelchats an, erzeugt Termine (mit conversationId, mit attendeeIds, beides, keins) und beantwortet die Fragen: Welche Nachrichten entstehen in welchen Chats? Wer sieht den Termin, wenn Mitglieder des Gruppenchats nicht eingeladen sind? Was tut eine Zusage über die Karte im Einzelchat mit der Karte im Gruppenchat (Status, Zähler, Broadcast)? Lege das Skript nach ${ERG}/ ab, damit Folgearbeiten es wiederverwenden.
4. Schreibe ${ERG}/bestand-einladen.md: eine Tabelle „Anforderung → erfüllt? (ja/teilweise/nein) → Beleg (Datei:Zeile oder Lauf)", dazu Erkenntnisse, die den Entwurf prägen (z.B. dass ein Termin heute an EINEN Chat gebunden ist, dass eine Auswahl nur erweitern kann, was bei Mehrfachkarten mit Push passiert: bekommt jemand für dieselbe Einladung zwei Benachrichtigungen?).
Gib die Datei, eine Zusammenfassung und die Liste der Lücken zurück.`

const BESTAND_ERINNERN = `
THEMA ERINNERN – BESTANDSAUFNAHME (nur lesen und ausführen, keinen Produktivcode ändern).

Der Anwender wünscht (siehe anforderungen-2.md): „Man sollte einstellen können, ob in den Einzelchats nach einer Weile (auch mehrfach) erinnert werden soll, falls Einladungen noch ausstehen."

Stelle fest, was der Bestand hat:
1. Gibt es im Server einen Dienst, der zeitgesteuert etwas tut (apps/api/src/storage/muell.rs "starten(pool, storage, takt)", services/auslagern.rs, main.rs/lib.rs/state.rs)? Wie wird er gestartet, konfiguriert (config.rs), getestet?
2. Die vorhandenen „Erinnerungen pro Termin" (calendar_events.reminder_minutes, Web: EventEditor): Wer liefert sie aus? Gibt es IRGENDWO einen Auslöser (Server-Dienst, services/notify.rs „event reminder", Client-Code, Service Worker apps/web/src/sw oder ähnlich, Push in apps/api/src/push)? Wenn nein: Die Erinnerungen vor dem Termin werden nie geliefert – das ist eine Lücke, die du belegen und dem Lead berichten sollst (nicht beheben).
3. Wie entsteht eine Nachricht und eine Benachrichtigung (services/messages.rs, push/, notify.rs); gibt es Nachrichten ohne Absender oder „System"-Nachrichten; wie werden Nachrichtenarten im Web dargestellt (modules/messenger: Registry, Blasen, EventBubble)? Wie ist der Einzelchat zwischen zwei Nutzern modelliert (services/conversations.rs)?
4. Der Status der Antwort (event_attendees.status = pending/yes/no/maybe, responded_at), und Wiederholtermine (rrule).
5. Schreibe ${ERG}/bestand-erinnern.md mit Belegen (Datei:Zeile), Erkenntnissen und Stolpersteinen (Zeitgeber, mehrere Serverinstanzen, Neustart, Mehrfachsendung, Zeitzonen, Nachholen).
Gib die Datei, eine Zusammenfassung und die Liste der Lücken zurück.`

const ENTWURF_EINLADEN = `
THEMA EINLADEN – ENTWURF (noch kein Produktivcode). Bestand: ${ERG}/bestand-einladen.md (lies ihn zuerst, und den Code, auf den er verweist).

Schreibe ${ERG}/entwurf-einladen.md (deutsch, vollständig, umsetzbar). Gesetzt sind diese Regeln des Anwenders:
- Unter dem Feld „Eingeladen" stehen IMMER alle verfügbaren Personen als Liste (mit Häkchen), ohne dass gesucht werden muss; die Suche filtert nur. Lege fest, was „verfügbar" heisst (Server-Nutzer? nur wer sichtbar ist?) und wie die Liste geladen wird (Seitenweise bei vielen, Sortierung: Personen aus gemeinsamen Chats zuerst, dann alphabetisch; Datenschutz: was darf ein Nutzer über andere sehen – halte dich an das, was die Suche heute schon preisgibt).
- Schnellwahl: „Alle", „Niemand", „Gruppenchat …" (Auswahl eines Gruppenchats wählt seine Mitglieder; einzelne lassen sich danach abwählen; mehrere Gruppenchats möglich).
- ZUSTELLUNG: Sind ALLE Mitglieder eines Gruppenchats eingeladen (niemand abgewählt), kommt die Einladung in den Gruppenchat UND in die Einzelchats mit den einzelnen Personen. Sonst kommt sie nur in die Einzelchats. Lege fest: wann gilt ein Gruppenchat als „gewählt" (nur ausdrücklich über die Schnellwahl gewählt, oder automatisch jeder Gruppenchat, dessen Mitglieder alle eingeladen sind? Bedenke „Alle": nicht in jeden Gruppenchat posten!), die Oberfläche zeigt VOR dem Senden transparent, wohin die Einladung geht (welche Gruppenchats, wie viele Einzelchats), und der Anwender kann das Posten in einen Gruppenchat abwählen.
- Einzelchat: gibt es noch keinen, wird er angelegt (prüfe, ob das nach den Regeln des Bestands erlaubt ist: Sperren, gelöschte/deaktivierte Nutzer).
- SYNCHRON: Alle Karten desselben Termins zeigen denselben Stand; Zu-/Absage an einer Stelle gilt überall und aktualisiert alle Karten in Echtzeit. Belege aus dem Bestand, was schon stimmt, und ergänze, was fehlt.
- Keine doppelte Benachrichtigung: Wer die Einladung im Gruppenchat UND im Einzelchat bekommt, soll nicht zwei Pushes für dieselbe Einladung bekommen (lege fest, wie).
- Bearbeiten eines bestehenden Termins: Personen hinzufügen (Einzelchat-Karte, ggf. Gruppenchat) und entfernen (Verhalten der bereits gesendeten Karte, Sichtbarkeit!), Änderung der Zeit/des Ortes (Benachrichtigungen, nicht nochmal neu einladen).
- Löschen/Absagen des Termins: was geschieht mit den Karten in allen Chats.
- Sichtbarkeit: Wer einen Gruppenchat angehört, aber NICHT eingeladen ist, darf den Termin nicht sehen (Bestand bindet Termine an den Chat und lädt alle Mitglieder ein – das ändert sich: Ein Termin bindet nur dann an den Gruppenchat, wenn alle seine Mitglieder eingeladen sind und dort gepostet wird; prüfe alle Stellen, die auf conversation_id beruhen: Sichtbarkeit, Notizen, Dokumente, Rechte, Ausgaben, Umfragen, Kalender-Abo, Löschen/Archivieren des Chats).
- Rückwärtsverträglich: Bestehende Termine bleiben unverändert sichtbar; bisherige Anfragen (nur conversationId, leere attendeeIds = „alle aus dem Chat") und „Termin aus Umfrage" (modules/polls.rs) verhalten sich wie vorher. Neue Felder sind optional.
Der Entwurf legt fest:
 a) Datenmodell und Migration 0023 (z.B. eine Tabelle, die ALLE Einladungsnachrichten eines Termins festhält: event_id, message_id, conversation_id, Art; Rückfüllen der bestehenden calendar_events.message_id; Indizes; Löschverhalten).
 b) Die API-Verträge: Eingabe beim Anlegen/Ändern (neue optionale Felder, Namen, Validierung: Obergrenzen der Einladungszahl, nur Personen, die der Ersteller einladen darf), Antwort, Fehlertexte auf Deutsch, Berechtigungen, Atomarität (Transaktion, Teilfehler), Idempotenz bei Doppelsenden, Reihenfolge der Schritte, Leistung bei 100+ Eingeladenen (keine N+1-Schleifen).
 c) Die Zustellung im Einzelnen (Gruppenchat-Karte, Einzelchat-Karten, Anlegen der Einzelchats, Benachrichtigungen, Echtzeit-Ereignisse, was die Clients bekommen).
 d) Die Oberfläche: EventEditor „Eingeladen" neu (Liste, Suche, Schnellwahl, Zähler, Sende-Vorschau, Schalter „Einladung im Chat senden"), wiederverwendete Teile (components/PersonenWahl.tsx – andere Nutzer dieser Komponente: ShareSheet, ExpenseSheet – nicht kaputt machen: lieber eine neue Komponente), Tastatur/Screenreader, 375 px, Ladezustände/Fehler, Verhalten beim Bearbeiten.
 e) Tests: Rust (Einheit/Integration nach dem Stil des Bestands), Einheit im Web, Browser-Test mit mehreren Nutzern (Ersteller + drei Eingeladene + Gruppenchat): Schnellwahl, Abwählen, Zustellung, Synchronität, Sichtbarkeit.
 f) ABNAHMEKRITERIEN, jedes mit einem Test.
 g) Verworfene Alternativen und warum.
Gib Datei, Zusammenfassung, Abnahmekriterien und Risiken zurück.`

const ENTWURF_ERINNERN = `
THEMA ERINNERN – ENTWURF (noch kein Produktivcode). Bestand: ${ERG}/bestand-erinnern.md; der Entwurf zum Einladen: ${ERG}/entwurf-einladen.md (lies beide und den Code, auf den sie verweisen). Das Erinnern baut auf den Einzelchat-Karten des Einladens auf.

Schreibe ${ERG}/entwurf-erinnern.md (deutsch, vollständig, umsetzbar):
 a) Einstellung je Termin (nur Ersteller): aus/an; wann die erste Erinnerung kommt („nach einer Weile": Vorgaben wie nach 1 Tag, 2 Tagen, 3 Tagen, 1 Woche – lege sinnvolle Vorgaben und Grenzen fest, ggf. eigene Stunden) und wie oft insgesamt (auch mehrfach: z.B. einmal, zweimal, dreimal, bis zum Termin) im gleichen Abstand. Vorgabe: aus. Was ist mit Terminen, die in weniger als der eingestellten Zeit beginnen? Mit Wiederholterminen? Mit Ganztägigen? Validierung im Server (Obergrenzen, Mindestabstand, Gesamtzahl) und in der Oberfläche.
 b) Datenmodell und Migration 0024 (Spalten am Termin, Zähler und Zeitstempel je Teilnehmer, Indizes für die Abfrage der Fälligen, Verhalten bei Änderung der Einstellung, wenn schon Erinnerungen gelaufen sind).
 c) Der Dienst (Vorlage storage/muell.rs): Takt, Start in main.rs, Abfrage der Fälligen mit ATOMAREM Beanspruchen (mehrere Instanzen, Neustart: keine Doppelsendung; FOR UPDATE SKIP LOCKED oder UPDATE … RETURNING), Nachholen nach längerem Stillstand (höchstens EINE Erinnerung je Person und Durchlauf, nicht zehn auf einmal), Stoppbedingungen (geantwortet, nicht mehr eingeladen, Termin gelöscht/abgesagt/vorbei/Beginn erreicht, Anzahl erreicht), Fehlerbehandlung (eine kaputte Zeile hält den Dienst nicht an), Protokoll, Konfigurierbarkeit des Takts, TESTBARKEIT mit steuerbarer Uhr (Zeit als Parameter).
 d) Die Erinnerung selbst: NUR in den Einzelchats (nicht im Gruppenchat), nur an Personen mit Status „pending". Welche Nachrichtenart (neue Art „event_reminder" oder die Karte mit Zusatz), wer ist der Absender (Bestand prüfen: Nachricht vom Ersteller ausgegeben wäre eine Unterschiebung – wenn es System-/Automatiknachrichten gibt, nimm sie; sonst ausdrücklich als automatische Erinnerung gekennzeichnet), Text („Erinnerung: Du hast noch nicht auf „X" geantwortet."), Karte mit Zu-/Absage-Knöpfen, Benachrichtigung/Push (einmal), Darstellung im Web (messenger-Registry/Blasen), Datenschutz.
 e) Oberfläche: Einstellung im Terminblatt (EventEditor, beim Anlegen und Bearbeiten) und Anzeige in der Detailansicht („Erinnerungen an Ausstehende: nach 2 Tagen, bis zu 3-mal"; für den Ersteller auch, wie viele schon gesendet wurden), Texte, Barrierefreiheit, 375 px.
 f) Tests: Rust mit steuerbarer Uhr (Fälligkeit, Zählen, Stoppbedingungen, Doppelanspruch, Nachholen), Einheit im Web, Browser-Test (der Dienst lässt sich für den Test auslösen: Hook oder Test-Endpunkt nur unter Testkonfiguration – lege fest, wie, ohne eine Hintertür in Produktion).
 g) ABNAHMEKRITERIEN, jedes mit einem Test.
 h) Verworfene Alternativen und warum.
Gib Datei, Zusammenfassung, Abnahmekriterien und Risiken zurück.`

const BAU_API = (was, entwurf, migration) => `
THEMA ${was} – UMSETZUNG, TEIL 1: API UND DATENBANK.
Der Entwurf liegt unter ${entwurf}; lies ihn vollständig und halte dich daran (Abweichungen nur mit Grund, ins Ergebnis schreiben). Setze um: Migration ${migration}, DTOs, Dienste, Routen, Dienst/Zeitgeber falls vorgesehen, Benachrichtigungen, Echtzeit, Rust-Tests nach dem Stil des Bestands (auch Rückwärtsverträglichkeit: bisherige Anfragen, Termin aus Umfrage). Am Ende: cargo build, cargo clippy --all-targets -- -D warnings (sauber), cargo test (alles grün; wenn der Bestand Tests hat, die eine Datenbank brauchen: so laufen lassen, wie sie gedacht sind), den Server neu starten und mit einem kleinen Lauf gegen Port 8080 belegen, dass die neue Logik wirkt (Skript unter ${ERG}/). Committe (mehrere logische Commits). Die Oberfläche folgt im nächsten Schritt von einem anderen Agenten: halte die API-Verträge in ${ERG}/api-${was.toLowerCase()}.md fest (Endpunkte, JSON-Beispiele, Fehlerfälle), damit er sie nutzen kann. Bei Änderungen in packages/shared (Typen) auch dort anpassen.`

const BAU_WEB = (was, entwurf) => `
THEMA ${was} – UMSETZUNG, TEIL 2: OBERFLÄCHE UND BROWSER-TESTS.
Der Entwurf liegt unter ${entwurf}; die API ist fertig (siehe ${ERG}/api-${was.toLowerCase()}.md und den Code im Hauptbaum, der Server auf Port 8080 läuft mit der neuen Fassung – prüfe das, sonst starte ihn neu). Setze die Oberfläche vollständig um (apps/web/src/lib/api.ts Typen/Aufrufe, modules/calendar, ggf. components, messenger-Darstellung der Karten, Chat-Speicher, Client-Reaktion auf Echtzeit-Ereignisse), mit Einheitentests, und die Browser-Tests mit MEHREREN Nutzern aus dem Entwurf (Vorlage e2e/termine.spec.ts). Kurze Doku als Unterabschnitt im Abschnitt „Kalender" von docs/FEATURES.md (Einladen bzw. Erinnern; ehrlich, was geht und was nicht). Am Ende: tsc, prettier, ganze vitest-Suite, die Browser-Tests dieses Themas plus die bestehenden e2e/termine.spec.ts, e2e/events.spec.ts (falls vorhanden) und e2e/echtzeit.spec.ts grün, dann committen.`

const LINSEN_EINLADEN = [
  'API-Berechtigung und Datenschutz: Wer darf wen einladen, wer sieht den Termin (Nicht-Eingeladene eines Gruppenchats!), Einzelchat-Anlegen (Sperren, Missbrauch: „Alle" legt viele Chats an – Grenzen), Sichtbarkeit der Karten und des Expanders, Rechte bei Notizen/Dokumenten/Ausgaben/Umfragen, die an conversation_id hingen, SQL-Korrektheit, Transaktion und Teilfehler, Idempotenz bei Doppelsenden, Leistung bei vielen Eingeladenen.',
  'Synchronität und Echtzeit: Zu-/Absage an jeder Karte aktualisiert alle Karten in allen Chats (Broadcast-Zielgruppe, Client-Speicher), Bearbeiten der Einladungsliste (hinzufügen/entfernen, Zustand der alten Karten), Löschen/Absagen, doppelte Benachrichtigungen, Reihenfolge und Wettläufe, Verhalten bei Offline/Neuladen, alte Termine ohne die neue Tabelle (Rückfüllen).',
  'Oberfläche: Liste aller Personen ohne Suche, Schnellwahl (Alle/Niemand/Gruppenchat), Abwählen, Zähler, Sende-Vorschau (wohin geht die Einladung), Bearbeiten bestehender Termine, viele Personen (Leistung, Virtualisierung nicht nötig aber Ladezustände), Tastatur/Screenreader, 375 px, Texte; PersonenWahl-Nutzer (ShareSheet, ExpenseSheet) unverändert.',
  'Tests, Migration und Kompatibilität: Migration sicher und wiederholbar, Rückfüllen, alte Anfragen (nur conversationId; leere attendeeIds; Termin aus Umfrage), Rust-Tests und Browser-Tests aussagekräftig und stabil (keine Zeitabhängigkeit, keine Reihenfolgeabhängigkeit, Nutzer eindeutig), Doku stimmt mit dem Verhalten.',
]
const LINSEN_ERINNERN = [
  'Dienst: Fälligkeitsrechnung (Zeiten, Zählen, Abstand, Nachholen nach Stillstand: höchstens eine je Person und Durchlauf), ATOMARES Beanspruchen (zwei Instanzen, Neustart, Abbruch zwischen Beanspruchen und Senden: lieber einmal zu wenig als doppelt, aber nie stillschweigend für immer verloren – begründe), Stoppbedingungen (geantwortet, ausgeladen, gelöscht, abgesagt, vorbei), Wiederholtermine, Fehlerbehandlung, Indizes und Abfragekosten, Takt.',
  'Nachricht, Benachrichtigung, Datenschutz: nur Einzelchat, nur Ausstehende, Absender/Kennzeichnung, Push genau einmal, Darstellung im Web (Blase, Zu-/Absage-Knöpfe funktionieren aus der Erinnerung), keine Beeinflussung der Gruppenchat-Karte, Text und Tonfall, keine Unterschiebung im Namen des Erstellers.',
  'Oberfläche und Validierung: Einstellung im Terminblatt (Vorgaben, Grenzen, Bearbeiten, Anzeige in der Detailansicht), Validierung im Server UND Client, Texte, Barrierefreiheit, 375 px; Tests mit steuerbarer Uhr und Browser-Test aussagekräftig und ohne Hintertür in Produktion.',
]

/* ---------------------------------------------------------- Bausteine */

async function pruefenBisBehoben(was, linsen, entwurfsdatei, stichwort) {
  phase('Prüfen')
  const listen = await parallel(
    linsen.map((linse, i) => () =>
      agent(
        `${REGELN}
DU BIST PRÜFER (nur lesen und ausführen, NICHTS ändern, nichts committen). Geprüft wird das Thema ${was}: alle Commits im Hauptbaum seit ${BASIS} zu diesem Thema (git -C ${DIR} log ${BASIS}..HEAD --stat; git -C ${DIR} diff ${BASIS}..HEAD -- <Pfade>). Der Entwurf: ${entwurfsdatei}. Die Anforderungen: ${S}/anforderungen-2.md.
DEINE LINSE: ${linse}
Suche konkrete Fehler mit Datei:Zeile und einem Szenario (Eingaben/Zustand → falsches Verhalten). Kein Stil, keine Spekulation ohne Mechanismus. Wo es geht, WEISE DEN FEHLER NACH (kurzer Lauf gegen den Server auf Port 8080 oder ein Test; Hilfsdateien nach ${ERG}/, nichts im Repo hinterlassen, Nutzer eindeutig benennen). Höchstens 10 Befunde, die schwersten zuerst.`,
        { label: `prüfen:${stichwort}:${i + 1}`, phase: 'Prüfen', schema: BEFUNDE_SCHEMA },
      ),
    ),
  )
  if (listen.some((l) => !l)) throw new Error(`Prüfer fehlgeschlagen: ${was}`)
  const alle = []
  const gesehen = new Set()
  for (const l of listen.filter(Boolean)) {
    for (const b of l.befunde || []) {
      const k = `${b.datei}|${b.titel}`
      if (gesehen.has(k)) continue
      gesehen.add(k)
      alle.push(b)
    }
  }
  if (!alle.length) return { befunde: 0, bestaetigt: 0, verworfen: [], behoben: null }

  phase('Gegenprobe')
  const u = await agent(
    `${REGELN}
DU BIST SKEPTIKER (nur lesen und ausführen, NICHTS ändern, nichts committen). Prüfer haben die folgenden Befunde zum Thema ${was} gemeldet. Versuche JEDEN zu WIDERLEGEN: lies die tatsächlichen Codewege, führe wo möglich einen Nachweis aus (Lauf gegen Port 8080 mit eigenen Nutzern). echt=true NUR, wenn du das Szenario wirklich bestätigen kannst; bei Zweifel echt=false. Titel unverändert lassen.

${JSON.stringify(alle, null, 2)}`,
    { label: `gegenprobe:${stichwort}`, phase: 'Gegenprobe', schema: URTEILE_SCHEMA },
  )
  if (!u) throw new Error(`Gegenprobe fehlgeschlagen: ${was}`)
  const urteile = (u && u.urteile) || []
  const bestaetigt = []
  const verworfen = []
  for (const b of alle) {
    const v = urteile.find((x) => x.titel === b.titel)
    if (v && v.echt) bestaetigt.push({ ...b, begruendung: v.begruendung })
    else verworfen.push({ titel: b.titel, grund: v ? v.begruendung : 'kein Urteil' })
  }
  if (!bestaetigt.length) return { befunde: alle.length, bestaetigt: 0, verworfen, behoben: null }

  phase('Beheben')
  const behoben = await agent(
    `${REGELN}
BEHEBEN. Die folgenden Befunde zum Thema ${was} sind von einem Skeptiker bestätigt worden. Behebe jeden: zuerst den Fehler nachstellen (Test, wo möglich), dann die KLEINSTE passende Änderung, dann prüfen. Wo du einen Befund nach genauem Hinsehen nicht für richtig hältst, schreibe das mit Begründung ins Ergebnis, statt etwas zu ändern. Am Ende cargo clippy --all-targets -- -D warnings, cargo test, tsc, prettier, ganze vitest-Suite und die Browser-Tests dieses Themas grün, Server neu gestartet, dann committen.

${JSON.stringify(bestaetigt, null, 2)}`,
    { label: `beheben:${stichwort}`, phase: 'Beheben', schema: BEHOBEN_SCHEMA },
  )
  if (!behoben) throw new Error(`Beheben fehlgeschlagen: ${was}`)
  return { befunde: alle.length, bestaetigt: bestaetigt.length, verworfen, behoben }
}

/* ------------------------------------------------------------- Ablauf */

phase('Bestand')
const bestaende = await parallel([
  () => agent(`${REGELN}\n${BESTAND_EINLADEN}`, { label: 'bestand:einladen', phase: 'Bestand', schema: BESTAND_SCHEMA }),
  () => agent(`${REGELN}\n${BESTAND_ERINNERN}`, { label: 'bestand:erinnern', phase: 'Bestand', schema: BESTAND_SCHEMA }),
])
log('Bestand: ' + JSON.stringify(bestaende.filter(Boolean).map((b) => b.zusammenfassung.slice(0, 200))))

/* ---- Einladen ---- */
phase('Entwurf')
const entwurfE = await agent(`${REGELN}\n${ENTWURF_EINLADEN}`, { label: 'entwurf:einladen', phase: 'Entwurf', schema: ENTWURF_SCHEMA })
if (!entwurfE || !entwurfE.datei) throw new Error('kein Entwurf zum Einladen')

phase('Bauen')
const apiE = await agent(`${REGELN}\n${BAU_API('EINLADEN', entwurfE.datei, '0023')}`, { label: 'bauen:einladen:api', phase: 'Bauen', schema: BAU_SCHEMA })
if (!apiE) throw new Error('Bauen fehlgeschlagen: apiE')
const webE = await agent(`${REGELN}\n${BAU_WEB('EINLADEN', entwurfE.datei)}`, { label: 'bauen:einladen:web', phase: 'Bauen', schema: BAU_SCHEMA })
if (!webE) throw new Error('Bauen fehlgeschlagen: webE')
const pruefungE = await pruefenBisBehoben('EINLADEN', LINSEN_EINLADEN, entwurfE.datei, 'einladen')

/* ---- Erinnern ---- */
phase('Entwurf')
const entwurfR = await agent(`${REGELN}\n${ENTWURF_ERINNERN}`, { label: 'entwurf:erinnern', phase: 'Entwurf', schema: ENTWURF_SCHEMA })
if (!entwurfR || !entwurfR.datei) throw new Error('kein Entwurf zum Erinnern')

phase('Bauen')
const apiR = await agent(`${REGELN}\n${BAU_API('ERINNERN', entwurfR.datei, '0024')}`, { label: 'bauen:erinnern:api', phase: 'Bauen', schema: BAU_SCHEMA })
if (!apiR) throw new Error('Bauen fehlgeschlagen: apiR')
const webR = await agent(`${REGELN}\n${BAU_WEB('ERINNERN', entwurfR.datei)}`, { label: 'bauen:erinnern:web', phase: 'Bauen', schema: BAU_SCHEMA })
if (!webR) throw new Error('Bauen fehlgeschlagen: webR')
const pruefungR = await pruefenBisBehoben('ERINNERN', LINSEN_ERINNERN, entwurfR.datei, 'erinnern')

/* ---- Abnahme über beide ---- */
phase('Abnahme')
const abnahme = await agent(
  `${REGELN}
ABNAHME über beide Themen (Einladen und Erinnern). Lies ${ERG}/entwurf-einladen.md und ${ERG}/entwurf-erinnern.md samt Abnahmekriterien. Fahre die KRITERIEN der Reihe nach durch – als ein Mehrnutzer-Lauf in der Oberfläche (Playwright, Ersteller plus drei Eingeladene plus Gruppenchat, 412×880, Bildschirmfotos nach ${ERG}/ und ANSEHEN): Liste ohne Suche, Schnellwahl, Abwählen, Sende-Vorschau, Zustellung in Gruppen- und Einzelchats (auch: nur Einzelchats, wenn jemand abgewählt ist), Zusage in einem Einzelchat aktualisiert die Gruppenkarte, Nicht-Eingeladene sehen nichts, Erinnerung (Dienst auslösen wie im Entwurf vorgesehen) nur an Ausstehende in Einzelchats, stoppt nach Antwort. Schreibe Fehlendes oder Falsches NICHT um, sondern melde es; behebe nur offensichtliche kleine Fehler direkt (mit Commit). Zum Schluss: ganze vitest-Suite, cargo test, clippy, und die Browser-Tests e2e/termine.spec.ts, e2e/echtzeit.spec.ts, e2e/messenger.spec.ts und die neuen. Ergebnis mit Zahlen und ehrlicher Liste dessen, was nicht erfüllt ist.`,
  { label: 'abnahme', phase: 'Abnahme', schema: BAU_SCHEMA },
)

return {
  bestaende: bestaende.filter(Boolean),
  einladen: { entwurf: entwurfE, api: apiE, web: webE, pruefung: pruefungE },
  erinnern: { entwurf: entwurfR, api: apiR, web: webR, pruefung: pruefungR },
  abnahme,
}
