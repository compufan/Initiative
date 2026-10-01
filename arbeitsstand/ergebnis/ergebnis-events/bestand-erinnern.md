# Bestandsaufnahme: Erinnern an ausstehende Antworten (Thema 22)

Stand: Hauptbaum `/home/user/Initiative`, Zweig `claude/initiative-pwa-messenger-4b5ms6`, Ausgangspunkt `d786eab`.
Nur gelesen und gemessen, kein Produktivcode geändert. Alle Pfade relativ zu `/home/user/Initiative`.
Belege der Läufe: `probe-erinnern.sh` / `probe-erinnern.ausgabe` und `probe-sichtbar.sh` / `probe-sichtbar.ausgabe` in diesem Ordner
(legen Testkonten in der Entwicklungsdatenbank an, wie die Browser-Tests auch).

## 0. Kurzfassung

1. Es gibt im Server **zwei** zeitgesteuerte Dienste (Müll-Aufräumer, Auslagerung), beide als `tokio::spawn`-Schleife aus `main.rs`. Keiner kennt Termine oder Nachrichten.
   Das Muster taugt als Vorlage, hat aber **keinen Schutz gegen mehrere Instanzen** und seine Schleife wird nicht getestet (nur der Durchgang).
2. Die „Erinnerungen pro Termin" (`reminder_minutes`) werden **von niemandem ausgeliefert**. Ausser in die `.ics`-Ausgabe (`VALARM`) wird der Wert nirgends gelesen:
   kein Server-Dienst, kein Push mit Art `event`, kein Service-Worker-Zeitgeber, kein Client-Zeitgeber. Wer den Termin nicht in eine Kalender-App übernommen hat
   (Abo-Link oder `event.ics`), bekommt **nie** eine Erinnerung, obwohl der Editor „Deine Kalender-App erinnert dich rechtzeitig" sagt. **Lücke, belegt (Abschnitt 2).**
3. Für „in den Einzelchats erinnern" fehlen die Grundlagen fast vollständig: kein Einladezeitpunkt je Person, keine Einstellung am Termin,
   keine Zuordnung Termin ↔ Einzelchat ↔ Karte, und Eingeladene ausserhalb des Termin-Chats können den Termin gar nicht öffnen oder zusagen (403, **belegt**).
4. Zwei Funde ausserhalb des Auftrags, die das Thema „Einladen" (Thema 21) und die Erinnerungskarte direkt treffen: **403 für Eingeladene ausserhalb des Chats** (Abschnitt 5.1)
   und **Termin-Karte mit fremder `eventId` zeigt den ganzen Termin** (Abschnitt 5.2).

## 1. Zeitgesteuerte Dienste im Bestand

| Was | Wo | Takt | Start | Test |
|---|---|---|---|---|
| Müll-Aufräumer (`storage_muell`) | `apps/api/src/storage/muell.rs:99-112` (`starten`), Durchgang `:38-97` (`aufraeumen`) | 300 s, in `main.rs:104` fest verdrahtet | `main.rs:101-105`, sofort beim Start, nach den Migrationen | `apps/api/tests/muell.rs` ruft `aufraeumen(&pool,&storage)` direkt auf |
| Auslagerung (kalte Ablage) | `apps/api/src/services/auslagern.rs:778-802` (`starten`), Durchgang `:736-776` (`durchgang`) | `TAKT_S = 900` (`:497`), erster Lauf nach 60 s (`:796`) | `main.rs:119-123`; ohne `KALT_TREIBER` sagt er es einmal und beendet die Aufgabe (`:785-788`) | `tests/auslagern.rs`, `tests/dateiaktionen.rs` rufen `durchgang(...)` mit eigenen Grenzen auf |
| Realtime-Zuhörer | `state.rs:99-103` (`spawn_realtime_listener`), `realtime/bus.rs` | dauerhaft (LISTEN) | `main.rs:88` | über `REALTIME_BUS=memory` umgangen |
| Nebenbei: Aufräumen alter Uploads / Tokens | `modules/media.rs:153-161`, `modules/auth.rs:316,396` | bei Gelegenheit, als `tokio::spawn` am Ende einer Anfrage | – | – |

Merkmale, an denen sich ein Erinnerungsdienst ausrichten sollte:

* **Form**: `pub async fn durchgang(...) -> Bilanz` (testbar, ohne Schlafen) plus `pub fn starten(...)` mit `tokio::spawn(async move { loop { durchgang; sleep(takt) } })`
  (`muell.rs:100-111`, `auslagern.rs:784-801`). Fehler werden je Zeile protokolliert, nie mit `?` nach oben gereicht, die Schleife stirbt nicht an einem Datenbankfehler.
* **Start**: in `main.rs` **nach** `migrate::hochfahren` (`main.rs:68-87`) und vor `app::build` (`:125`). Der Kommentar `:93-96` begründet das (Tabelle gibt es beim allerersten Start sonst noch nicht).
  Weder `AppState::new` noch `AppState::from_pool` (`state.rs:51-82`) starten Dienste; Tests bekommen also nie einen laufenden Dienst, sondern rufen den Durchgang selbst auf.
* **Was der Dienst bekommt**: `muell` nimmt `PgPool` + `Arc<dyn Storage>`, `auslagern` nimmt `PgPool`, `Arc<Speicher>`, `Arc<Config>`. Ein Erinnerungsdienst braucht `create_message`
  (`services/messages.rs:271`), also `&AppState`; `AppState` ist `Clone` (`state.rs:17`) und kann in die Aufgabe verschoben werden.
* **Konfiguration**: Takte sind **Konstanten im Code** (`main.rs:104`, `auslagern.rs:497`); `config.rs` kennt nur die Schwellen der Auslagerung (`kalt_*`, `config.rs:161-163`, gelesen `:433-438`).
  Kein Schalter zum Abschalten ausser `KALT_TREIBER`. Neue Umgebungsvariablen brauchen einen Eintrag in `config.rs` (`var`/`number`/`flag`), `docs/DEPLOYMENT.md` und ggf. `docker-compose.yml`.
* **Kein Schutz bei mehreren Instanzen**: Weder `for update skip locked` noch `pg_advisory_*` kommen im Code vor (nur sqlx' eigene Migrationssperre, `migrate.rs:68`, und `for update` in `verlauf.rs:206`).
  Müll-Aufräumer und Auslagerung sind dagegen nur deshalb unkritisch, weil Löschen idempotent ist bzw. der Zustand `wandert` die Zeile markiert. Eine **Nachricht** lässt sich nicht zurückholen.
* **Kein Abbruchsignal**: Nur `axum::serve` hat ein Herunterfahren (`main.rs:143`); die Hintergrundaufgaben werden einfach mit der Laufzeit beendet. `auslagern::starten` gibt ein `JoinHandle` zurück, das `main.rs` wegwirft.
* **Umfragen laufen ohne Zeitgeber**: `closes_at` wird beim Lesen ausgewertet (`services/polls.rs:87`), nicht von einem Dienst. Das Haus-Muster heisst also „lazy rechnen, wo es geht". Für Erinnerungen geht das nicht: Niemand liest in dem Augenblick.

Betrieb: `docker-compose.yml:84` `REALTIME_BUS=memory` (genau ein Prozess), `apps/api/fly.toml:44-46` `auto_stop_machines = "off"`, `min_machines_running = 1` (der Dienst läuft also dauernd),
`apps/api/koyeb.yaml:32-34` `scalings: min 1, max 2` (**zwei Instanzen möglich**), `docs/DEPLOYMENT.md:153` nennt `postgres` ausdrücklich „mehrere Instanzen".
Das laufende Entwicklungsprotokoll (`ergebnis-events/api.log`) zeigt beim Start nur: Migrationen, „Keine kalte Ablage", „API bereit", „realtime bus listening" – kein Termin-/Erinnerungsdienst.

## 2. Die vorhandenen „Erinnerungen pro Termin": wer liefert sie aus?

**Niemand ausser der Kalender-App des Empfängers – und nur, wenn sie den Termin kennt.**

Wo `reminder_minutes` vorkommt (vollständige Suche über alle versionierten Dateien, `git grep -i reminder`):

* Speicher: `migrations/0001_init.sql:199` (`jsonb`, Vorgabe `[]`), `db.rs:197`, `dto.rs:299`, `services/calendar.rs:43,182,222`, Schreiben `modules/calendar.rs:125,175,256,288,305`.
* Validierung: `packages/shared/src/schemas/calendar.ts:74-82` (höchstens 5 Werte, 0 bis 14 Tage).
* Oberfläche: `apps/web/src/modules/calendar/EventEditor.tsx:459-481` (Chips aus `REMINDER_OPTIONS` = 10 Min / 1 Std / 1 Tag, `helpers.ts:458-462`), Anzeige `EventDetailScreen.tsx:231-235`.
* **Einziger lesender Verbraucher**: die ICS-Ausgabe. `ical.rs:112-118` (Server) und `packages/shared/src/util/ics.ts:103-111` (Client-Kopie) schreiben je Wert einen
  `BEGIN:VALARM … TRIGGER:-PT{minutes}M`. Ausgeliefert über `GET /calendar/events/{id}/event.ics` (`modules/calendar.rs:531-544`, ohne Anmeldung, Kennung als Berechtigung) und
  den Abo-Feed `GET /calendar/{token}/feed.ics` (`:547-576`, `REFRESH-INTERVAL PT1H`).

Wo **kein** Auslöser existiert (jeweils geprüft):

* **Server-Dienst**: Es gibt keinen Zeitgeber, der Termine ansieht (Abschnitt 1, `grep tokio::spawn|interval|sleep` über `apps/api/src`: nur `muell`, `auslagern`, `bus`, `ws`-Heartbeat, `media`/`auth`-Aufräumen).
* **`services/notify.rs:152`**: Der Kommentar „Generic helper for modules (your turn, poll closed, event reminder …)" verspricht es, aber `notify_users` hat **genau einen** Aufrufer (`modules/games.rs:268`, „Du bist am Zug").
  „poll closed" und „event reminder" sind nie umgesetzt.
* **Push**: `PushPayload.kind` kennt `'event'` (`packages/shared/src/schemas/push.ts:28`); der Server setzt nur `message`, `game`, `system`, `expense` (`notify.rs:127,143`, `modules/games.rs:278`, `modules/push.rs:106`, `services/expenses.rs:416`).
  Nie `event`.
* **Service Worker** `apps/web/src/sw.ts`: Ereignisse sind `install` (:39), `activate` (:43), `message` (:67, :238), `fetch` (:99), `push` (:266), `notificationclick` (:304). Kein `periodicsync`, kein `sync`, kein `showTrigger`/Notification-Trigger.
* **Client**: `git grep showNotification|periodicSync|TimestampTrigger|Notification\.` in `apps/web/src` trifft nur `lib/push.ts` (Anmeldung) und `sw.ts`. Die `setInterval`s im Client sind Tipp-Anzeige (`state/chat.ts:569`), Heartbeat, Fernsehbalken, Medien – nicht Termine.
* **Gemessen** (`probe-erinnern.ausgabe`): Termin in 3 Stunden mit `reminderMinutes [10,60,1440]` in einem Einzelchat angelegt. Bodo ist `pending`. Der Chat enthält nach 3 s und nach der Zusage genau eine Nachricht (`["event"]`).
  `event.ics` enthält drei `VALARM` (`TRIGGER:-PT10M`, `-PT60M`, `-PT1440M`). Das ist der gesamte Mechanismus.

Folgen:

* Der Editor-Satz „Deine Kalender-App erinnert dich rechtzeitig." (`EventEditor.tsx:479`) ist nur für Personen wahr, die den Abo-Link eingerichtet oder `event.ics` geladen haben. Für alle anderen Eingeladenen ist die Einstellung wirkungslos.
  Die Erinnerung gehört dabei dem **Ersteller-Wert für alle** (ein Satz Minuten am Termin), nicht dem Empfänger.
* `docs/FEATURES.md:706` („**Erinnerungen** pro Termin, zum Beispiel 1 Stunde und 1 Tag vorher.") und `README.md:74` versprechen mehr, als ausgeliefert wird.
* Für Termine mit `status = 'planning'` (vorläufiger Zeitpunkt, siehe `0005_events.sql:38-44`) stehen die `VALARM` mit im Feed, obwohl der Zeitpunkt noch nicht feststeht.
* Ganztägige Termine: `TRIGGER:-PT60M` bezieht sich auf `DTSTART;VALUE=DATE` (Mitternacht) – „1 Stunde vorher" heisst dort 23 Uhr am Vortag. Randfall, nicht Teil dieses Auftrags.

**Das ist die Lücke für den Lead; behoben wird sie hier nicht.** Sie hängt aber eng am Erinnerungsdienst: Wer ihn baut, hat die Zeitgeber-Grundlage, und „vor dem Termin erinnern" wäre dann eine zweite Art von Erinnerung auf demselben Dienst.

## 3. Nachricht, Benachrichtigung, Systemnachricht, Darstellung, Einzelchat

### Wie eine Nachricht entsteht

* Einziger Weg hinein: `services/messages.rs:271-363` `create_message(state, NewMessage)`. Schritte: Bereinigung, Idempotenz über `client_id` (`:279-298`), `insert` (`:314-329`), Anhänge, `touch_conversation` (`last_message_at`, `services/conversations.rs:124`),
  `hydrate_messages`, `ausspielen` (`:357`, `:389-430`: an alle Mitglieder, die hinter ihrer `sieht_ab`-Grenze liegen, über `state.hub.publish`), danach `notify_new_message` **falls nicht `silent`** (`:359-361`).
* Konstruktoren (`:215-265`): `text` (Absender, Text), `system(conv, actor, kind, targets)` (`:230-244`: `type "system"`, `body None`, `metadata.system {kind, actorId, targetIds}`, **`silent: true`**), `entity(conv, sender, type, key, id)` (`:246-264`, `silent: false`, `metadata {key: id}`, `body None`).
* Der Client darf **keine** `system`-Nachricht senden (`modules/messages.rs:172`). `MESSAGE_TYPES` steht doppelt (`constants.rs:12-15`, `packages/shared/src/constants.ts:8-28`) und wird von `shared.test.ts` auf Gleichlauf geprüft;
  dasselbe Test verlangt für jede neue Art (ausser `text`/`system`) gleiche Vorschautexte in `constants.rs:135-154` und `packages/shared/src/util/format.ts:28-50`. Eine **neue Nachrichtenart** wäre also Arbeit an sechs Stellen. `system` mit eigenem `kind` umgeht das.
* Termin-Karte heute: `services/calendar.rs:258-276` legt **eine** `event`-Nachricht im **einen** Chat des Termins an und merkt `message_id` (`:271`). Die Spalte wird sonst **nirgends gelesen** (`git grep message_id` in `modules/calendar.rs`/`services/calendar.rs`: nur dieses Schreiben; `CalendarEventDto` hat das Feld nicht).

### Nachrichten ohne Absender, Systemnachrichten

* `messages.sender_id` ist nullbar (`0001_init.sql:72`, `on delete set null`). `NewMessage.sender_id` ist `Option` (`messages.rs:204`); `create_message` kommt mit `None` zurecht (`:347` Betrachter `Uuid::nil`, `notify.rs:80-92` Absendername „Initiative").
  Kein Code legt sie absichtlich an; sie entstehen, wenn ein Konto gelöscht wird.
* **Im Web gilt eine Nachricht ohne Absender als „meine"**: `MessageBubble.tsx:40` `isMine = message.senderId == null || message.senderId === myId` (rechte Seite), `ChatListScreen.tsx:352` Vorschau-Präfix „Du: ".
  Ausserdem zählt `services/conversations.rs:211` (`m.sender_id is null or m.sender_id <> cm.user_id`) eine absenderlose Nachricht **für alle** als ungelesen, auch für den Ersteller.
  Eine absenderlose Erinnerung sähe also für den Eingeladenen wie seine eigene Nachricht aus. Absender = Ersteller des Termins vermeidet beides (er bekommt kein „ungelesen", der Eingeladene sieht sie als eingehend).
* `system`-Nachrichten entstehen heute bei Gruppengründung (`modules/conversations.rs:187-198`), Mitglieder hinzu/raus/austritt (`:401-410` u. a.). Sie sind **stumm** (`silent: true`).
* Darstellung im Web: `apps/web/src/modules/messenger/module.ts:42-45` registriert `text` und `system`; `MessageBubble.tsx:17-20` schlägt den Renderer nach Art nach, Unbekanntes fällt auf `TextBubble`;
  `system` wird ohne Blase gerendert (`:47-49`). `SystemBubble.tsx:19-40` kennt vier `kind`s (`conversation.created`, `members.added`, `member.left`, `member.removed`); bei einem unbekannten `kind` zeigt sie **`message.body`** (`:48-52`),
  sonst „Der Chat wurde aktualisiert". Die Chatliste zeigt für `system` den Körper ohne Präfix (`ChatListScreen.tsx:349-357`, `format.ts:28-50` Standardzweig).
* `event` wird von `apps/web/src/modules/calendar/module.ts:26` → `EventBubble.tsx:15-78` gerendert: Datumsblock, Zeit, Ort, **`message.body` als Absatz** (`:67-69`), Zählung, Zu-/Absage-Knöpfe. Die Karte hält **keinen eigenen Stand**: `useLiveEvent(eventId, message.event)`
  (`useCalendarEvents.ts:92-147`) hört auf `event.updated`/`event.deleted` mit derselben `eventId`. **Mehrere Karten zum selben Termin sind damit automatisch synchron**, Zusage an einer Stelle gilt überall (Voraussetzung: Zusage gelingt, siehe 5.1).
  Der Rundruf geht an Teilnehmer **plus** Chatmitglieder (`services/calendar.rs:284-294`).
* Die Zeit in der Karte formatiert der **Browser** (`helpers.ts:105-130`, `Intl.DateTimeFormat('de-DE')`, Ortszeit des Geräts). Der Server kennt keine Zeitzone (Abschnitt 6) und kann keine Uhrzeit sinnvoll in einen Text schreiben.

### Benachrichtigung (Push)

* `services/notify.rs:17-150` `notify_new_message`: nur wenn `state.push.enabled()` (VAPID gesetzt; in der Entwicklungsumgebung `push: false`, siehe `/healthz`). Empfänger = Mitglieder ohne den Absender (`:21-25`);
  Filter: stummgeschaltet (`muted_until`, `:53`), `settings.notifications.push` (`:58-63`), `previews` (`:65-73`). Titel: Absendername (Gruppe: „Name · Titel"), Text: `message_preview(type, body)` (`constants.rs:135-154`).
  **Für Typ `event` ist die Vorschau fest „📅 Termin" und ignoriert den Körper.** Eine Erinnerung als `event`-Karte käme also als „📅 Termin" auf den Sperrbildschirm; als `system`-Nachricht mit Körper wäre die Vorschau der Körper – aber `system` ist beim Konstruktor `silent`.
* `push/mod.rs:47-103` `send_to_users` verschickt an alle Geräte, entfernt tote Abos (404/410), `ttl` 43200 s (`:128`). `tag = conversation:{id}` mit `renotify` (`notify.rs:123`, `sw.ts:296-297`): eine neue Mitteilung desselben Chats ersetzt die stehende.
  Der Service Worker unterdrückt die Anzeige, wenn der Chat fokussiert offen ist (`sw.ts:283-290`).
* Eine stummgeschaltete Einzelchat-Mitgliedschaft unterdrückt nur den Push, nicht die Nachricht.

### Einzelchat zwischen zwei Nutzern

* `conversations.type in ('direct','group')` (`0001_init.sql:44-52`, Prüfbedingung). Ein Einzelchat ist eine Gruppe mit zwei `conversation_members`-Zeilen; `find_direct_conversation` (`services/conversations.rs:398-416`) sucht einen mit beiden Mitgliedern, **`limit 1` ohne `order by`**.
* **Keine Eindeutigkeit erzwungen**: kein Unique-Index für das Paar (`\d conversations` in der Entwicklungsdatenbank bestätigt). Zwei gleichzeitige `POST /conversations` erzeugen zwei Einzelchats.
* **Anlegen nur im Handler** (`modules/conversations.rs:86-203`, Suche `:118-131`), nicht als Dienstfunktion. Ein Dienst, der „den Einzelchat mit X" braucht, müsste das nachbauen oder herausziehen (Thema 21 wird dasselbe brauchen).
* **Einzelchats mit einem Mitglied existieren**: `remove_member` (`modules/conversations.rs:382-416`) erlaubt den Austritt auch aus `direct`; in der Entwicklungsdatenbank stehen zwei solche (`01a0f289-…`, `01a0f316-…`). Danach findet `find_direct_conversation` den alten nicht mehr, ein neuer Chat entsteht.
* Sichtgrenze: `conversation_members.sieht_ab` (`0016_verlaufsgrenze.sql`); alle Abfragen nach Nachrichten, Ungelesenem und Empfängern filtern darauf (`services/verlauf.rs:348-386`). Ein frisch angelegter Einzelchat setzt `sieht_ab = now()` (`modules/conversations.rs:172-173`), eine Erinnerung von jetzt ist also sichtbar.

## 4. Antwortstatus und Wiederholtermine

### `event_attendees`

* Schema `0001_init.sql:208-215`: `(event_id, user_id)` Primärschlüssel, `status in ('yes','no','maybe','pending')` (Vorgabe `pending`), `responded_at timestamptz null`. **Keine Spalte für den Einladezeitpunkt.**
* Schreiben:
  * `create_event` (`services/calendar.rs:197-256`): Menge = `attendeeIds` ∪ Ersteller ∪ **alle Mitglieder des Chats** (`:197-203`); Ersteller `yes`, sonst `pending` oder vorbelegt (aus Umfrage), `responded_at` nur bei Nicht-`pending`.
  * `PATCH` mit `attendeeIds` (`modules/calendar.rs:309-353`): neue → `pending` (`do nothing` bei Bestand), nicht Genannte (ausser Ersteller) werden **gelöscht**. **Keine Nachricht, kein Push, keine Karte** für neu Eingeladene (gemessen, `probe-sichtbar.ausgabe`: Chat bleibt `["event"]`).
  * `rsvp` (`modules/calendar.rs:432-459`): Upsert mit `responded_at = now()`. **`RSVP_STATUSES` enthält `pending`** (`constants.rs:19`, `constants.ts:40`): Jemand kann seine Antwort auf `pending` zurückstellen, dann ist `responded_at` gesetzt, der Status aber offen.
    **Ein Dienst muss am `status = 'pending'` filtern, nicht an `responded_at is null`.**
  * `confirm_event` (`:1508-1608`): Stimmen der Terminfindung werden zu Zu-/Absagen (`yes/no/maybe`, `responded_at = now()`).
  * `ausladen` (`:407-430`): Zeile löschen; Ersteller nicht ausladbar.
* „Noch nicht geantwortet" = `status = 'pending'`. `maybe` ist eine Antwort (Anwender: „falls Einladungen noch *ausstehen*"); ob „Vielleicht" weiter erinnert wird, ist eine Entscheidung (Empfehlung: nein).
* Ein Termin hat **eine** Antwort je Person für die ganze Serie (Schlüssel `(event_id, user_id)`), nicht je Wiederholung.
* `calendar_events.status`: `planning` | `confirmed` | `cancelled` (`0005_events.sql:38-44`). **`cancelled` wird von keinem Code gesetzt**, nur angezeigt (`EventRow.tsx:40`, `KalenderScreen.tsx:36`). „Absage des Termins" heisst heute **Löschen** (`modules/calendar.rs:360-390`, `deleted_at = now()`, Rundruf `event.deleted`).
  Bei `planning` trägt `starts_at` den frühesten Vorschlag, die Zusage bedeutet „grundsätzlich dabei" (`EventDetailScreen.tsx` Abschnitt „Grundsätzlich dabei?").

### Wiederholtermine

* `calendar_events.rrule` (Text, eingeschränktes RRULE: DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, BYDAY, COUNT, UNTIL); nichts wird in der Datenbank ausgerollt, sondern bei Bedarf gerechnet:
  Server `recurrence.rs:126-204` (`expand_occurrences`, höchstens 500 Schritte), Client-Spiegel `packages/shared/src/util/recurrence.ts:70-150`.
* **Gerechnet wird in UTC** (`recurrence.rs:126-133` `Duration::days/weeks`, `checked_add_months`; TS `setUTCDate`): Eine wöchentliche Serie um 18:00 Ortszeit wandert nach einem Sommerzeitwechsel um eine Stunde. Bestehendes Verhalten, nicht Teil dieses Auftrags, aber für „nächster Termin" relevant.
* `starts_at` ist der Beginn der **ersten** Wiederholung. Ganztägige Termine legt der Client auf 12:00 Ortszeit (`EventEditor.tsx`, `noonOf`).
* Folge für das Erinnern: Weil die Antwort serienweit gilt, wäre „vor jeder Wiederholung erneut erinnern" Dauerbelästigung. Empfehlung: Stopp bei `starts_at` der Serie (= Terminbeginn, wie in der verbindlichen Auslegung); Wiederholungen werden nicht einzeln gemahnt.

## 5. Weitere Funde, die Thema 21 und 22 direkt treffen

### 5.1 Eingeladene ausserhalb des Termin-Chats kommen nicht an den Termin (403) – belegt

`modules/calendar.rs:189-210` `assert_visible`: Ist `event.conversation_id` gesetzt, wird **nur** die Chat-Mitgliedschaft geprüft und sofort zurückgekehrt (`:197-200`); die Teilnehmerliste wird nur bei Terminen **ohne** Chat angesehen.
`GET /calendar/events/{id}` und `POST …/rsvp` nutzen das (`:231-239`, `:432-459`). Gemessen (`probe-sichtbar.ausgabe`): Carl ist per `attendeeIds` eingeladen (`pending`), steht nicht im Einzelchat des Termins.
Der Termin erscheint in seiner Liste (`services/calendar.rs:115-126` bezieht Teilnehmer ein), aber `GET by id` → **403** und `rsvp` → **403** „Du bist kein Mitglied dieses Chats".
Das gilt genauso für jede Person, die eine Erinnerungs- oder Einladungskarte in **ihrem** Einzelchat mit dem Ersteller bekommt, wenn der Termin an einen **anderen** Chat (etwa die Gruppe) gebunden ist und sie dort nicht Mitglied ist.
`services/events.rs:25-58` (`is_attendee`) prüft dagegen richtig beides (Teilnehmer **oder** Chatmitglied). Die Sichtprüfung der Termin-Routen weicht davon ab. Ohne Korrektur laufen Zu-/Absage-Knöpfe in Einzelchat-Karten ins Leere.

### 5.2 Termin-Karte mit fremder `eventId` – belegt

`services/calendar.rs:297-332` `EventExpander` ignoriert den Betrachter (`_viewer_id`, `:308`); der Client darf `type:"event"` mit beliebigem `metadata.eventId` in seinen eigenen Chat senden (`modules/messages.rs:153-200`, `has_entity` zählt `eventId`).
Gemessen: Dora (ohne jede Beziehung zum Termin) sendet eine Karte mit Annas `eventId` in einen Chat mit Carl; die Antwort enthält den **vollständigen Termin** (Titel, Teilnehmerzahl, Ersteller). Die Kennung ist eine v7-UUID, also nicht blind ratbar, aber aus jedem
weitergeleiteten Link oder früheren Chat bekannt. Wer Karten desselben Termins in mehrere Chats stellt (Thema 21), sollte den Expander mit einer Sichtprüfung absichern. Hier nur berichtet.

### 5.3 Kein Register der Karten eines Termins

Umfragen haben `poll_placements` (`0005_events.sql:14-31`) samt `broadcast_poll`/`republish_message`-Schleife über alle Auftritte (`services/polls.rs:332-359`), `place_poll` (`:508-547`) und `unplace_poll` (`:550-570`).
Termine haben nichts Vergleichbares: `message_id` ist einmalig, nie gelesen. Karten mehrerer Chats zu demselben Termin sind im Datenmodell nicht vorgesehen; die Synchronität kommt allein über die gemeinsame `eventId` (siehe 3). Für das Erinnern braucht es aber
„welche Karte/welcher Einzelchat gehört zu welcher Person" (Zustellung), schon um nicht zweimal dieselbe Erinnerung an dieselbe Stelle zu schicken und um die Einladungsdauer zu kennen.

### 5.4 Keine Benachrichtigung bei Einladung ohne Chat

`create_event` legt eine Karte nur an, wenn ein Chat gesetzt ist (`services/calendar.rs:258-259`). Ein Termin **ohne** Chat, aber mit `attendeeIds`, erzeugt weder Karte noch Push; die Eingeladenen finden ihn nur, wenn sie den Kalender öffnen.
(Belegt durch Lesen, nicht gemessen.)

## 6. Stolpersteine für einen Erinnerungsdienst

1. **Zeitgeber / Takt**: Die Dienste im Bestand schlafen nach der Arbeit (`loop { arbeit; sleep(takt) }`); kein `interval`, keine Drift-Korrektur – hier unerheblich. Ein Minutentakt reicht („nach einer Weile" = Stunden). Die Dauer eines Durchgangs ist durch eine Stapelgrösse zu begrenzen (Vorbild `STAPEL`, `muell.rs:32`, `auslagern.rs:494`).
   Erster Lauf nicht vor den Migrationen (`main.rs:93-96`). Ein paniktes `tokio::spawn` beendet die Schleife still; Bestand hat keine Überwachung. Vergleichszeit immer in SQL mit `now()` bilden, nicht mit der Uhr des Prozesses (zwei Instanzen, Uhrabweichung).
2. **Mehrere Instanzen** (`koyeb.yaml:32-34` bis 2, `DEPLOYMENT.md:153`): Jede Instanz startet den Dienst. Ohne Sperre erinnern beide. Möglich sind `for update skip locked` in einer Transaktion um Auswahl und Buchung, oder eine Buchung per
   `update … where … returning` **vor** dem Senden, oder ein **deterministischer `client_id`** der Nachricht: `create_message` ist idempotent über `(conversation_id, sender_id, client_id)` (`messages.rs:279-298`) und der Unique-Index `messages_client_id_idx` (`0001_init.sql:83-85`)
   schützt auch gegen den gleichzeitigen Fall. Das gilt nur mit Absender (Empfehlung oben) – der Index nimmt `sender_id` mit, `NULL`-Absender sind nach SQL-Regeln nie gleich.
3. **Neustart / Absturz**: Zustand gehört in die Datenbank (`erinnert_anzahl`, `zuletzt_erinnert_at`), nicht in den Speicher. Reihenfolge Senden ↔ Buchen: Bucht man vor dem Senden, geht bei einem Absturz eine Erinnerung verloren; sendet man vor dem Buchen, kommt sie doppelt.
   Mit deterministischem `client_id` ist „erst senden (idempotent), dann buchen" auch bei Absturz korrekt. Der Durchgang soll je Zeile Fehler schlucken und protokollieren (`muell.rs:74-93`), nie die Schleife abbrechen.
4. **Mehrfachsendung**: Zusätzlich zu 2/3 – `ausspielen` (`messages.rs:389-430`) und der Push-Weg laufen bei einer **nachgeholten** (Idempotenz-)Antwort nicht erneut (`:290-297` kehrt früh zurück). Gut für Doppelsendungen, schlecht, wenn ein erster Versuch zwischen `insert` und `ausspielen` abbrach: Die Nachricht steht, hat aber keinen Rundruf/Push bekommen.
5. **Zeitzonen**: Datenbank `timestamptz` (UTC). Nirgends wird eine Benutzerzeitzone gespeichert (`git grep -i timezone` ohne Treffer ausser Bibliotheksnutzung; `services/users.rs:33-35` Einstellungen kennen nur `theme`, `marke`, `locale`, `notifications`).
   Also: Abstände nur als **Dauer** (Stunden/Tage) rechnen, keine „nicht nachts"-Logik ohne neue Einstellung, und **keine Uhrzeit in einen Servertext schreiben** – die Karte (`EventBubble`) formatiert in der Ortszeit des Geräts. Serien werden in UTC gerechnet (Abschnitt 4).
6. **Nachholen**: Nach einem Ausfall sind viele Erinnerungen gleichzeitig fällig. Sinnvoll: **einmal** nachholen (nächster Termin `now() + Abstand`), nicht je versäumtem Abstand einmal; nie nach Terminbeginn; und eine Mindestreserve vor dem Beginn (Erinnern kurz vor Beginn ist Lärm). Der Stapel begrenzt die Last.
7. **Stoppbedingungen sind alle lesbar**: Antwort (`status <> 'pending'`), Ausladen (Zeile weg → Join fällt aus), Löschen (`deleted_at is not null`), Terminbeginn (`starts_at <= now()`; auch bei Serien der erste), Anzahl erreicht (Zähler), `status = 'planning'` (entscheidet der Lead; Empfehlung: nicht erinnern),
   `status = 'cancelled'` (wird heute nie gesetzt, trotzdem mitprüfen). Der Ersteller ist nie `pending`.
8. **Bezugspunkt fehlt**: „Nach einer Weile" braucht den Einladezeitpunkt je Person. `event_attendees` hat keinen (`0001_init.sql:208-214`); für per `PATCH` Nachgeladene gibt es auch kein Datum (`:309-353`). Abhilfe entweder `eingeladen_at` an `event_attendees`
   (Vorgabe `now()`, Bestand `created_at` des Termins) oder in der Zustellungstabelle.
9. **Wer schreibt, an wen**: Erinnerung geht in den Einzelchat **Ersteller ↔ Eingeladener** (`find_direct_conversation(created_by, user_id)`). Fehlt er, nicht stillschweigend anlegen, ausser Thema 21 legt ihn bei der Einladung an – dann ist es derselbe Weg.
   `created_by` ist nullbar (`on delete set null`): ohne Ersteller keine Erinnerung. Ersteller = Absender (kein „ungelesen" bei ihm, Push nur beim Eingeladenen, `notify.rs:21-25`).
10. **Darstellung**: `system` mit neuem `kind` (z. B. `event.reminder`) braucht nur einen Zweig in `SystemBubble.describe` und `silent: false` (der Konstruktor setzt `true`, `messages.rs:242`) – eine Körperzeile (`body`) als Rückfall zeigt `SystemBubble` ohnehin (`:48-52`). Als **Karte mit Zu-/Absage-Knöpfen**
    wäre es eine `event`-Nachricht (mit `body` als Text, `EventBubble.tsx:67-69`), nach 5.1 nur mit korrigierter Sichtprüfung nutzbar, und der Push-Text bliebe „📅 Termin" (`constants.rs:147`, Körper ignoriert).
11. **Tests**: Die Testdatenbank ist geteilt. Ein Dienst, der **alle** fälligen Termine abfragt, sieht Zeilen aus anderen Testbinärdateien (`tests/auslagern.rs:1-40`, `:308-360` löst das mit einem Schema je Test, `set search_path`). Entweder dasselbe Verfahren oder der Durchgang bekommt eine
    Einschränkung auf bestimmte Termin-Kennungen. Die Zeit **hereinreichen** (`durchgang(state, jetzt)`), nicht schlafen (Vorbild `gewicht(kandidat, jetzt)`, `auslagern.rs:119-126`, dort ausdrücklich begründet). Die Schleife `starten` selbst ist im Bestand ungetestet.
12. **Migration**: Nächste Nummer für dieses Thema ist 0024 (0023 gehört einem anderen Thema). Stil der bestehenden: `create table if not exists`, `add column if not exists`, Fremdschlüssel mit `on delete cascade`, erklärender Kommentarkopf (`0016`, `0005`). Bestandszeilen rückwärtsverträglich:
    neue Einstellung am Termin standardmässig **aus** (kein Nachrichtenregen bei Bestandsterminen nach dem Einspielen).

## 7. Skizze (Vorschlag, die Entscheidung liegt beim Lead)

* **Einstellung am Termin** (Spalten an `calendar_events` oder eigene Tabelle): `erinnern_nach_min` (null = aus), `erinnern_abstand_min`, `erinnern_hoechstens` (Anzahl). DTO `CalendarEventDto`, Zod `createEventSchema`/`updateEventSchema`, `modules/calendar.rs` (`CreateEventInput`, `UpdateEventInput`, `update`-SQL), `EventEditor.tsx` (neben den bestehenden „Erinnerungen"), `EventDetailScreen.tsx`.
* **Zustand je Person**: `event_einladungen(event_id, user_id, eingeladen_at, conversation_id, message_id, erinnert_anzahl, zuletzt_erinnert_at)`, Fremdschlüssel wie `event_attendees`. Gemeinsam mit Thema 21: Die Zustellung der Einladung legt die Zeile an, der Dienst liest sie.
* **Dienst**: `services/erinnern.rs` mit `pub async fn durchgang(state, jetzt) -> Bilanz` (auswählen, je Zeile senden, buchen) und `pub fn starten(state)`; in `main.rs` nach `auslagern::starten`. Auswahl in SQL, `for update skip locked`, `limit STAPEL`. Nachricht: Absender Ersteller, `client_id = erinnerung:{event}:{user}:{n}`, Art `system` (neuer `kind`) oder `event`-Karte.
* **Was der Dienst nicht tun soll**: Uhrzeiten als Text; Wiederholungen einzeln mahnen; Bestandstermine ohne ausdrückliche Einstellung anfassen.

## 8. Lückenliste (Kurzform)

Siehe Rückgabe des Auftrags. Die Reihenfolge nach Gewicht für das Thema:

1. Kein Auslöser für die bestehenden Erinnerungen vor dem Termin (nur `VALARM` in `.ics`).
2. Kein Dienst, der Termine ansieht; das Muster im Bestand ist nicht mehrinstanzsicher, seine Schleife ungetestet.
3. Kein Einladezeitpunkt je Person.
4. Keine Erinnerungs-Einstellung am Termin (Datenmodell, DTO, Schema, Editor, Detail).
5. Keine Zuordnung Termin ↔ Einzelchat ↔ Karte je Person; `calendar_events.message_id` wird nie gelesen.
6. `assert_visible`: Eingeladene ausserhalb des Termin-Chats bekommen 403 beim Öffnen und Zusagen.
7. `EventExpander` ohne Sichtprüfung (Karte mit fremder `eventId` zeigt den Termin).
8. Keine Systemnachrichtenart für Erinnerung; `NewMessage::system` ist stumm und ohne Körper; Push-Vorschau für `event` ist fest „📅 Termin".
9. `rsvp` erlaubt `pending`: Status, nicht `responded_at`, entscheidet.
10. `status = 'cancelled'` wird nie gesetzt (Absage = Löschen).
11. Einzelchat: keine Eindeutigkeit, `find_direct_conversation` ohne Reihenfolge, Direktchats mit einem Mitglied, Anlegen nur im Handler.
12. Keine Benutzerzeitzone; Serien in UTC.
13. Tests: geteilte Datenbank, Durchgang braucht Zeit-Parameter und Schema-Isolation.
14. Einladen durch `PATCH` oder ohne Chat löst weder Karte noch Benachrichtigung aus.
