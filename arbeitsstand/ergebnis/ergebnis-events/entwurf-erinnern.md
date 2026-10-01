# Entwurf: Termine – Erinnern an ausstehende Antworten (Thema 22)

Stand: Hauptbaum `/home/user/Initiative`, Zweig `claude/initiative-pwa-messenger-4b5ms6`, Kopf `7640262`.
Der Ausgangspunkt `d786eab` aus dem Auftrag ist überholt: **Das Einladen (Thema 21) ist inzwischen umgesetzt** (Commits `00da3ff` … `7640262`).
Dieser Entwurf baut auf dem Code auf, wie er jetzt steht – nicht auf `bestand-erinnern.md`, das den Stand davor beschreibt. Kein Produktivcode geändert.
Grundlage: `bestand-erinnern.md`, `entwurf-einladen.md` und das erneute Lesen des Codes (Belege unten).
Die Migration und die zentrale Abfrage wurden in einem Wegwerf-Schema der Entwicklungsdatenbank erprobt (Abschnitt 14);
die Hilfsdateien liegen in `ergebnis-events/entwurf-erinnern/` (`0024_erinnern.sql`, `anspruch.sql`, `probe-0024.sql`, `parallel-lauf.sh`, `plan.sql`).
Pfade relativ zum Repository, wenn nicht anders angegeben.

---

## 0. Kurzfassung: die Entscheidungen

| # | Frage | Entscheidung |
|---|---|---|
| 1 | Einstellung | Je Termin, nur der Ersteller: **aus** (Vorgabe) oder **an** mit *Abstand* und *Anzahl*. Der Abstand gilt für die erste Erinnerung **und** zwischen allen weiteren („im gleichen Abstand“). Vorgaben 1 Tag, 2 Tage, 3 Tage, 1 Woche (Voreinstellung beim Einschalten: 2 Tage), dazu „Eigene Dauer“ in ganzen Stunden. Anzahl: einmal, zweimal, dreimal, 5-mal, „bis zum Termin“. |
| 2 | Grenzen | Abstand **12 Stunden bis 30 Tage (720 h)**, Anzahl **1 bis 10**, „bis zum Termin“ heisst höchstens 10. Zwischen zwei Erinnerungen an dieselbe Person zum selben Termin liegen **immer mindestens 12 Stunden** – auch wenn die Einstellung geändert wird. Der Server prüft, die Oberfläche spiegelt. |
| 3 | Kurz vor Beginn | **Nie in den letzten 2 Stunden vor dem Beginn und nie danach.** Beginnt der Termin vor der ersten fälligen Erinnerung, kommt keine – ohne Sonderfall im Code, es folgt aus der Regel. Die Oberfläche sagt es vor dem Speichern („Bis zum Beginn passen 2 Erinnerungen“ / „… es wird keine gesendet“). |
| 4 | Wiederholtermine | Bezug ist der **erste Termin der Serie** (`starts_at`). Ist er vorbei, kommt keine Erinnerung mehr. Begründung: Die Antwort gilt serienweit, und die Serie lässt sich serverseitig nicht verlässlich „ab jetzt“ ausrollen (`expand_occurrences`: höchstens 500 Schritte ab Serienbeginn). |
| 5 | Ganztägige | Beginn = `starts_at` minus 12 Stunden (der Editor legt Ganztägiges auf 12:00 Ortszeit; zwölf Stunden früher ist der Tagesbeginn des Erstellers). Letzte Erinnerung also spätestens 2 Stunden vor dem Tag. |
| 6 | Wer | Nur Personen mit Status **`pending`**, nur dort, wo **schon eine Einzelkarte der Einladung zugestellt ist** (`event_placements.art = 'einzel'`, `message_id` gesetzt), beide noch Mitglied des Einzelchats. **Nie** der Gruppenchat, nie der Ersteller. Der Dienst legt keinen Einzelchat an. „Vielleicht“ ist eine Antwort und beendet das Erinnern. |
| 7 | Datenmodell | Zwei Spalten-Gruppen: `calendar_events.erinnern_nach_std / erinnern_anzahl / erinnern_seit` und eine **Tabelle `event_erinnerungen`** (eine Zeile je Erinnerung). Zähler und Zeitstempel je Teilnehmer **folgen aus den Zeilen** (Anzahl, jüngste). Migration **0024**, idempotent, erprobt. |
| 8 | Beanspruchen | **Eine SQL-Anweisung** wählt die Fälligen und trägt sie ein (`insert … select … on conflict do nothing returning`). Der Eindeutigkeits-Schlüssel (Termin, Person, Nummer) entscheidet, welche Instanz gewinnt – keine Sperre über das Senden hinweg, kein Anführer. Erst danach wird gesendet; bricht das ab, bleibt die Zeile **offen** und wird nachgeholt (höchstens dreimal). |
| 9 | Der Dienst | `services/erinnern.rs` mit `durchgang(&AppState, jetzt)` (Zeit als Parameter) und `starten(AppState)`; Takt **300 s** (`ERINNERN_TAKT_S`, 0 = aus), Start in `main.rs` nach den Migrationen. Je Durchgang **höchstens eine Erinnerung je Person**, höchstens 100. Jeder Durchgang läuft in einer eigenen Aufgabe: Eine Panik beendet nur ihn. |
| 10 | Nachricht | Eine **`event`-Karte mit Zusatz** (`metadata.erinnerung = {nummer}`), **stumm** angelegt, Text „Erinnerung: Du hast noch nicht auf „X“ geantwortet.“, Absender der **Ersteller** – ausdrücklich als **automatische Erinnerung** gekennzeichnet (Banner in der Karte). Keine neue Nachrichtenart, keine Systemnachricht (Gründe in Abschnitt 6.1). |
| 11 | Push | **Eine** Mitteilung je Erinnerung, über den Einzelchat (Stummschaltung, Vorschau-Einstellung und Push-Schalter der Person gelten), Kennzeichen `termin:{id}` ersetzt die stehende Mitteilung zum Termin. |
| 12 | Synchron | Die Erinnerungskarte ist eine `event`-Nachricht mit `eventId`: Zu-/Absage in ihr gilt in **allen** Karten, und der Chat-Speicher führt sie nach – ohne neuen Client-Code. |
| 13 | Änderung der Einstellung | **Jede Änderung startet die Uhr neu** (`erinnern_seit = jetzt`): Die nächste Erinnerung kommt frühestens eine Frist danach. Die **Zählung wird nie zurückgesetzt** (sonst liesse sich die Obergrenze durch Umschalten umgehen); neue Einladung = neue Zählung. |
| 14 | Anzeige | Einstellung: Terminblatt (Ersteller, beim Anlegen und Bearbeiten). Detailansicht: für alle „Erinnerungen an Ausstehende: nach 2 Tagen, bis zu 3-mal“, für den Ersteller zusätzlich je Person „2 von 3 gesendet“ und wer **nicht erinnert werden kann**. |
| 15 | Tests ohne Hintertür | Rust-Tests rufen `durchgang(state, jetzt)` in **einem Schema je Test**. Der Browser-Test löst den Dienst über ein **eigenes Programm** aus (`src/bin/erinnern_einmal.rs`), das **nicht ins Produktionsabbild** kommt – kein HTTP-Weg, kein Schalter in der Konfiguration. |
| 16 | Abhängigkeiten | Keine neuen Crates, keine neuen npm-Pakete. |

---

## 1. Ausgangslage: was da ist und worauf der Entwurf aufbaut

Belege aus dem Code **nach** dem Einladen (Dateien im Repository gelesen):

1. **Die Karten je Person gibt es.** `event_placements` (Migration 0023): `art = 'einzel'`, `user_id`, `conversation_id`, `message_id` (leer bis zur Zustellung). Eine Einzelkarte je Person (Teil-Eindeutigkeit `event_placements_person_idx`).
   `services/einladen.rs`: Plan, Zwei-Phasen-Anlegen, `offene_karten_zustellen`, `nachliefern`, `aendern_vorbereiten`, `termin_loeschen`.
2. **Der Einladezeitpunkt je Person gibt es:** `event_attendees.eingeladen_am` (Name steht damit fest; der frühere Vorschlag `eingeladen_at` entfällt). Bei jeder (Wieder-)Einladung `now()`.
3. **Absagen gibt es:** `PATCH status: cancelled` setzt `calendar_events.status` (`modules/calendar.rs`, `update`), `rsvp` antwortet dann `409`. Löschen räumt alle Karten ab (`einladen::termin_loeschen`).
4. **Sichtbarkeit nur über die Teilnehmerzeile** (`assert_attendee`), `EventExpander` prüft den Betrachter, `ausspielen` kürzt für Nicht-Eingeladene. Eine Erinnerungsnachricht im Einzelchat ist damit für den Eingeladenen lesbar (er ist Teilnehmer) – der 403-Fund aus `bestand-erinnern.md` 5.1 ist behoben.
5. **Eine Mitteilung je Person, nicht je Karte:** Einladungskarten sind stumm (`NewMessage::einladung`, `silent: true`), die Mitteilung kommt gesondert (`notify::benachrichtige_einladung`, `push_ziel`). Der Push lässt sich am Ausgang mitschneiden (`PushService::mitschneiden`, `push/mod.rs`).
6. **Der Rundruf trägt einen Stand** (`melde_termin`, `calendar_events.stand`); der Client führt über `terminEreignisse` **alle** `event`-Karten in **allen** Chats nach (`state/chat.ts`, `terminAbgleichen`).
7. **Zeitgesteuerte Dienste** (unverändert, `bestand-erinnern.md` Abschnitt 1): `storage/muell.rs` (`aufraeumen` + `starten`, 300 s) und `services/auslagern.rs` (`durchgang` + `starten`, 900 s) als `tokio::spawn`-Schleifen aus `main.rs:101-123`, **ohne Schutz gegen mehrere Instanzen** (dort unkritisch, weil Löschen idempotent ist), Schleife nicht getestet.
   `koyeb.yaml` erlaubt **zwei Instanzen**, `docs/DEPLOYMENT.md:153` nennt `postgres` als Bus für „mehrere Instanzen“ – der Erinnerungsdienst **muss** damit umgehen.
8. **Die „Erinnerungen pro Termin“ (`reminder_minutes`) liefert weiterhin niemand ausser der Kalender-App aus** (`.ics`-`VALARM`). Das ist eine **andere** Sache (Alarm vor dem Termin, für alle gleich) und nicht Teil dieses Auftrags. Der Dienst hier ist die Zeitgeber-Grundlage, auf der sie später sitzen könnte (Abschnitt 13, Punkt 8).
9. **Nachrichten:** `messages.type` hat keine Prüfbedingung, `MESSAGE_TYPES` steht doppelt (`constants.rs`, `packages/shared/src/constants.ts`, Gleichlauftest in `shared.test.ts`). Der Client darf `eventId` nicht in `metadata` senden (`modules/messages.rs`, `send_message`) – ein gefälschtes `metadata.erinnerung` ist ihm damit **unmöglich**, es hängt an `eventId`.
   Idempotenz: `create_message` ist über `(conversation_id, sender_id, client_id)` wiederholbar (Unique-Index `messages_client_id_idx`, per `pg_indexes` bestätigt).
10. **`system`-Nachrichten haben ebenfalls einen Absender** (den *Handelnden*: `NewMessage::system(conv, actor, …)`). Es gibt im Bestand **keine** absenderlose Automatik und kein Bot-Konto. Eine absenderlose Nachricht (`sender_id` leer) gälte im Web als „meine“ (`MessageBubble.tsx:40`) und als ungelesen für **alle**, auch den Ersteller (`services/conversations.rs:211`), und der Idempotenz-Index unterscheidet `NULL`-Absender nicht.

Eigenheiten, die den Entwurf formen:

* **Zeitzone gibt es nicht** (Datenbank `timestamptz`, kein Profilfeld): Abstände sind **Dauern in Stunden**, keine Uhrzeiten, kein Text mit Uhrzeit.
* **Die Testdatenbank ist geteilt.** Ein Dienst, der **alle** fälligen Termine abfragt, sieht Zeilen fremder Tests; `tests/auslagern.rs` löst das mit **einem Schema je Test** – derselbe Weg hier.
* **`rsvp` erlaubt `pending`** (`RSVP_STATUSES`): Wer seine Antwort zurücknimmt, ist wieder offen und wird wieder erinnert (Abstand ab der letzten Erinnerung). `responded_at` entscheidet nichts, der **Status** entscheidet.

---

## 2. Die Regeln (verbindlich für alles Folgende)

**E1 – Wer erinnert wird.** Eine Person, die (a) Teilnehmerzeile mit `status = 'pending'` hat, (b) nicht der Ersteller ist, (c) eine **zugestellte Einzelkarte** des Termins im Einzelchat mit dem Ersteller hat, (d) in diesem Chat noch Mitglied ist, wie auch der Ersteller.

**E2 – Wann.** `fällig = max(eingeladen_am, erinnern_seit, jüngste Erinnerung) + Abstand`. Gesendet wird, wenn `fällig ≤ jetzt`, die Anzahl nicht erreicht ist (`< min(Anzahl | 10, 10)`) und `jetzt ≤ Beginn − 2 h`. `Beginn = starts_at` (Ganztägig: `starts_at − 12 h`).

**E3 – Nur solange der Termin gilt.** `deleted_at` leer, `status = 'confirmed'` (nicht `planning`, nicht `cancelled`), `created_by` gesetzt.

**E4 – Nie mehr als eine je Person und Durchgang**, nie nachgeholt „je versäumtem Abstand“: Die Beanspruchung setzt die Uhr auf *jetzt*.

**E5 – Eine Erinnerung ist eine Nachricht im Einzelchat, eine Mitteilung auf dem Gerät – sonst nichts.** Kein Rundruf `event.updated` an die Person, kein Eintrag im Gruppenchat. (Der Dienst meldet nach dem Durchgang den Termin je betroffenem Termin **einmal** – für die Zähleranzeige des Erstellers, Abschnitt 6.5.)

**E6 – Wer antwortet, hört auf.** Jede Antwort ausser „offen“ (`yes`, `no`, `maybe`) beendet das Erinnern für diese Person sofort und ohne weiteres Zutun: Die Bedingung E1(a) wird falsch.

---

## 3. a) Die Einstellung je Termin

### 3.1 Werte und Grenzen

| Feld | Bedeutung | Grenzen | Vorgabe |
|---|---|---|---|
| `erinnern.nachStunden` | Stunden bis zur ersten Erinnerung **und** zwischen den folgenden | **12 … 720** (ganze Stunden; 30 Tage) | beim Einschalten 48 |
| `erinnern.anzahl` | Wie oft höchstens, **je Person und Termin insgesamt** | **1 … 10**, `null` = „bis zum Termin“ (**gedeckelt auf 10**) | beim Einschalten 3 |
| ganze Einstellung | – | `null`/fehlend = **aus** | **aus** |

* **Warum Stunden und nicht Minuten:** „nach einer Weile“ ist keine Minutenfrage; ganze Stunden vermeiden Randfälle und lassen sich in der Oberfläche als „2 Tage“ oder „36 Stunden“ sagen. Vorgaben: **24, 48, 72, 168**.
* **Warum Untergrenze 12 h:** Zwei Erinnerungen am Tag sind Nachfassen, mehr ist Belästigung – die Grenze schützt den **Empfänger**, der keinen Einfluss auf die Einstellung hat. Sie gilt auch für den Server (API-Clients).
* **Warum Obergrenze 30 Tage:** Wer länger als einen Monat wartet, erinnert nicht mehr, sondern vergisst.
* **Warum „bis zum Termin“ gedeckelt:** Ein Abstand von einem Tag bei einem Termin in 90 Tagen wären 90 Nachrichten. Zehn ist die harte Obergrenze (`ERINNERN_ANZAHL_MAX`); die Oberfläche sagt „höchstens 10-mal“ dazu.
* **Warum die Anzahl nie zurückgesetzt wird:** Eine Obergrenze, die sich durch Aus- und Einschalten erneuern liesse, wäre keine.
* **Tipp in der Oberfläche für „Eigene Dauer“:** Vielfache von 24 Stunden erinnern zur selben Tageszeit wie die Einladung (und damit meist tagsüber). Ruhezeiten gibt es nicht, weil keine Zeitzone bekannt ist (Risiko 7).

Konstanten (`apps/api/src/constants.rs`, gespiegelt in `packages/shared/src/constants.ts` `LIMITS`, **Gleichlauftest**, Abschnitt 9):
`ERINNERN_NACH_STD_MIN = 12`, `ERINNERN_NACH_STD_MAX = 720`, `ERINNERN_ANZAHL_MAX = 10`, `ERINNERN_RESERVE_STD = 2`.

### 3.2 Sonderfälle (jeweils mit Begründung)

| Fall | Verhalten | Warum |
|---|---|---|
| Termin beginnt in **weniger als** dem Abstand | Keine Erinnerung; der Editor schreibt „Der Termin beginnt vor der ersten Erinnerung – es wird keine gesendet.“ | Eine Erinnerung nach dem Beginn ist sinnlos, eine „kurz vorher“ wäre eine zweite, nicht gewünschte Funktion (Alarm vor dem Termin = `reminder_minutes`). Kein Sonderfall im Code: `jetzt ≤ Beginn − 2 h` wird nie wahr, solange die Frist nicht um ist. |
| Erinnerung fiele in die **letzten 2 Stunden** | Entfällt | Eine Bitte um Antwort kurz vor dem Beginn hilft der Planung nicht mehr, sie ist Lärm. Grenze inklusive: bei `jetzt = Beginn − 2 h` kommt sie noch, eine Sekunde später nicht. |
| **Wiederholtermin** | Bezug ist `starts_at` (der erste Termin der Serie). Danach keine Erinnerung mehr. | Die Antwort gilt **serienweit** (`event_attendees` hat einen Schlüssel je Person und Termin, nicht je Wiederholung); „vor jeder Wiederholung erneut“ wäre Dauerbelästigung. „Ab der nächsten Wiederholung“ lässt sich serverseitig nicht verlässlich rechnen: `recurrence.rs` `expand_occurrences` begrenzt auf 500 Schritte ab Serienbeginn, bei einer alten täglichen Serie fände sie nichts. Der Editor sagt bei Serien: „Bei Wiederholungen gilt der erste Termin der Serie.“ |
| Person wird zu einer **laufenden Serie** eingeladen (erster Termin vorbei) | Keine Erinnerung. | Folge der vorigen Zeile, bewusst: besser gar nicht als falsch. Als Risiko 4 aufgeführt. |
| **Ganztägig** | `Beginn = starts_at − 12 h` | Der Editor legt Ganztägiges auf 12:00 Ortszeit (`EventEditor.tsx`, `noonOf`); zwölf Stunden früher ist der Beginn des Tages **in der Zeitzone des Erstellers**, ohne dass der Server sie kennt. Termine aus der Umfrage oder aus anderen Wegen können abweichen – dann kommt die letzte Erinnerung ein paar Stunden früher oder später, nie nach dem Tag. |
| **Terminfindung** (`status = planning`) | Einstellen abgelehnt (400), Erinnern aus. | Es gibt noch keinen Zeitpunkt; die Frage dort lautet „Wann?“, nicht „Kommst du?“ – beantwortet wird sie in der Abstimmung. |
| **Abgesagt** (`cancelled`) | Stoppt. Wiederaufnahme startet die Uhr neu. | Eine Erinnerung an etwas Abgesagtes ist falsch; nach der Wiederaufnahme soll nicht sofort eine Welle kommen. |
| **„Vielleicht“** | Beendet das Erinnern. | Es ist eine Antwort; wer unentschlossen ist, hat sich gemeldet. Ohne diese Regel gäbe es für Unentschlossene keinen Weg, das Erinnern zu beenden, ausser sich auszutragen. (Die Karte sagt es: „… endet mit deiner Antwort“.) |
| **Zurück auf „offen“** (`rsvp pending`) | Erinnert wieder, frühestens eine Frist nach der **letzten Erinnerung**; die Zählung läuft weiter. | Folgt aus E2, ohne Sonderlogik. |
| **Keine Einzelkarte** (Einzelchats beim Einladen abgewählt, Gruppenkarte allein) | Keine Erinnerung an diese Person. Der Ersteller sieht in der Detailansicht, **wer** nicht erinnert werden kann („kein Einzelchat mit der Einladung“). | Er hat beim Einladen ausdrücklich keine Einzelchats gewollt. Der Dienst legt keinen an: Das wäre eine Nebenwirkung, die der Ersteller abgewählt hat (und `einzelchats_bremsen` ist die Drossel des Einladens, nicht des Dienstes). |
| **Ersteller verlassen / gelöscht** | Keine Erinnerung. | Absender wäre ein Nichtmitglied bzw. `NULL`. |
| **Einladung ohne Nachricht** (`senden: false`) | Keine Einzelkarte, also keine Erinnerung; der Editor sperrt den Schalter mit Hinweis. | Wer „niemand bekommt eine Nachricht“ gewählt hat, will auch keine spätere. |

### 3.3 Validierung

**Server** (`modules/calendar.rs`; deutsche Texte über `Validator`/`AppError`):

| Fall | Status | Text |
|---|---|---|
| `nachStunden` < 12 | 400 | „Die Erinnerung braucht mindestens 12 Stunden Abstand.“ |
| `nachStunden` > 720 | 400 | „Höchstens 30 Tage (720 Stunden) Abstand.“ |
| `anzahl` < 1 | 400 | „Mindestens eine Erinnerung.“ |
| `anzahl` > 10 | 400 | „Höchstens 10 Erinnerungen.“ |
| Nicht-Ersteller ändert die Einstellung | 403 | „Nur wer den Termin angelegt hat, kann Erinnerungen einstellen“ (Nicht-Eingeladene: 404, wie `nur_ersteller`) |
| Termin in Abstimmung | 400 | „Solange über den Zeitpunkt abgestimmt wird, lässt sich keine Erinnerung einstellen – lege zuerst den Zeitpunkt fest.“ |
| Termin abgesagt | – | **erlaubt** (man darf die Einstellung vor einer Wiederaufnahme ändern) |
| `erinnern` bei Termin ohne Einzelkarten | – | **erlaubt**, wirkt nur auf die, die eine haben (3.2). Der Server weiss beim Anlegen nicht, wer „Einzelkarte“ sein wird. |

Reine Funktion `erinnern::pruefen(nach_std, anzahl) -> AppResult<()>` (Einheitentest U1). Zod-Schema `erinnernSchema` im gemeinsamen Paket mit denselben Grenzen.

**Oberfläche** (Abschnitt 8): Die Eingabe „Eigene Dauer“ ist ein Zahlenfeld mit `min`/`max`; **ungültig** → Fehlertext am Feld („Mindestens 12 Stunden.“ / „Höchstens 720 Stunden (30 Tage).“), Speichern gesperrt. Auswahl aus Vorgaben kann nicht ungültig sein.

### 3.4 Was bei einer Änderung der Einstellung geschieht, wenn schon Erinnerungen gelaufen sind

| Änderung | Wirkung |
|---|---|
| aus → an | Uhr startet (`erinnern_seit = jetzt`). Frühere Zählung bleibt (Anzahl insgesamt). Niemand bekommt sofort etwas. |
| an → aus | Nichts mehr. Gesendete Karten und die Zählung bleiben. |
| Abstand geändert | Uhr startet neu: nächste Erinnerung frühestens **Abstand (neu) nach der Änderung** und nach der letzten Erinnerung. |
| Anzahl erhöht (auch wenn sie schon erreicht war) | Uhr startet neu; weiter bis zur neuen Obergrenze. Keine sofortige Welle. |
| Anzahl gesenkt unter die schon gesendeten | Keine weiteren; nichts wird zurückgeholt. |
| Termin später verschoben | Zählung und Uhr bleiben; es passt mehr bis zum Beginn. |
| Termin früher verschoben (in die Reserve / vor die Frist) | Keine weiteren (E2). |
| Absage → Wiederaufnahme | Uhr startet neu (`erinnern_seit = jetzt`). |
| Person ausgeladen | Ihre Erinnerungskarten werden wie die Einzelkarte als „gelöscht“ markiert, die Zeilen verschwinden mit der Teilnehmerzeile; **eine spätere neue Einladung beginnt bei null**. |
| Termin gelöscht | Alle Erinnerungskarten als gelöscht markiert, Zeilen entfernt. |
| Einstellung gespeichert **ohne** Änderung (nur Titel geändert) | Nichts: `erinnern_seit` wird nur bei einem **tatsächlichen** Unterschied gesetzt (Vergleich gegen die gesperrte Zeile im `PATCH`). |

Daraus folgt eine Invariante, die ein Test absichert (R13): **Zwischen zwei Erinnerungen derselben Person zum selben Termin liegen immer mindestens `ERINNERN_NACH_STD_MIN` Stunden.** Beweisskizze: Die Fälligkeit ist `max(…, jüngste) + Abstand` mit Abstand ≥ 12 h; jede Änderung setzt `erinnern_seit` auf *jetzt*, nie zurück.

---

## 4. b) Datenmodell und Migration 0024

### 4.1 Objekte

| Objekt | Zweck |
|---|---|
| `calendar_events.erinnern_nach_std` (`integer`, leer = aus) | Abstand. |
| `calendar_events.erinnern_anzahl` (`smallint`, leer = „bis zum Termin“, nur bei eingeschaltetem Erinnern) | Obergrenze je Person. |
| `calendar_events.erinnern_seit` (`timestamptz`) | Seit wann die Einstellung gilt; Anker der Uhr. Gesetzt **genau dann**, wenn `erinnern_nach_std` gesetzt ist. |
| Prüfbedingung `calendar_events_erinnern_check` | `(nach_std is null) = (seit is null)` und `anzahl is null or nach_std is not null`: kein halber Zustand. |
| Teilindex `calendar_events_erinnern_idx (starts_at) where erinnern_nach_std is not null and deleted_at is null` | Die Abfrage der Fälligen beginnt bei den wenigen Terminen mit Erinnerung. |
| Tabelle `event_erinnerungen` | Eine Zeile je Erinnerung: `id`, `event_id`, `user_id`, `nummer`, `conversation_id`, `message_id` (leer bis zur Zustellung), `beansprucht_am`, `versuche`. Fremdschlüssel `(event_id, user_id)` → `event_attendees` **on delete cascade**; `conversation_id` → `conversations` cascade; `message_id` → `messages` set null. Eindeutig `(event_id, user_id, nummer)`. |
| `event_erinnerungen_nummer_idx` (unique) | **Das Beanspruchen**: Jede Nummer geht genau einmal an. |
| `event_erinnerungen_nachricht_idx`, `event_erinnerungen_offen_idx (beansprucht_am) where message_id is null` | Aufräumen und Nachholen finden ihre Zeilen billig. |

Der Wortlaut mit Kommentarkopf im Stil von `0016`/`0023` steht in `ergebnis-events/entwurf-erinnern/0024_erinnern.sql` (Auszug unten, Abschnitt 4.2). Namensgebung wie 0023: `_am` für Zeitpunkte, `erinnern_` als Präfix, damit sich die Spalten nicht mit `reminder_minutes` (Alarm in der Kalender-App) verwechseln lassen.

### 4.2 Die Migration (`apps/api/migrations/0024_erinnern.sql`)

```sql
alter table calendar_events
  add column if not exists erinnern_nach_std integer check (erinnern_nach_std > 0),
  add column if not exists erinnern_anzahl   smallint check (erinnern_anzahl > 0),
  add column if not exists erinnern_seit     timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'calendar_events_erinnern_check'
                    and conrelid = 'calendar_events'::regclass) then
    alter table calendar_events add constraint calendar_events_erinnern_check
      check ((erinnern_nach_std is null) = (erinnern_seit is null)
             and (erinnern_anzahl is null or erinnern_nach_std is not null));
  end if;
end $$;

create index if not exists calendar_events_erinnern_idx
  on calendar_events (starts_at)
  where erinnern_nach_std is not null and deleted_at is null;

create table if not exists event_erinnerungen (
  id              uuid        primary key,
  event_id        uuid        not null,
  user_id         uuid        not null,
  nummer          smallint    not null check (nummer > 0),
  conversation_id uuid        not null references conversations (id) on delete cascade,
  message_id      uuid        references messages (id) on delete set null,
  beansprucht_am  timestamptz not null,
  versuche        smallint    not null default 0,
  foreign key (event_id, user_id)
    references event_attendees (event_id, user_id) on delete cascade
);
create unique index if not exists event_erinnerungen_nummer_idx
  on event_erinnerungen (event_id, user_id, nummer);
create index if not exists event_erinnerungen_nachricht_idx
  on event_erinnerungen (message_id) where message_id is not null;
create index if not exists event_erinnerungen_offen_idx
  on event_erinnerungen (beansprucht_am) where message_id is null;
```

Begründungen für den Kommentarkopf (stehen in der Datei):

* **Rückwärtsverträglich:** Alles `if not exists`; nichts wird zurückgefüllt. **Bestandstermine bleiben stumm** – leere Einstellung heisst aus. Ein älterer Stand der Anwendung liest die neuen Spalten nicht (sqlx-`FromRow` ignoriert fremde Spalten) und läuft unverändert.
* **Warum die Grenzen nicht in der Datenbank stehen:** Nur „die Zahl bedeutet etwas“ (`> 0`). 12/720/10 gehören in den Code (eine Quelle, gespiegelt, getestet); wer sie später ändert, soll nicht dafür migrieren müssen.
* **Warum Tabelle statt Zähler an `event_attendees`:** Siehe Abschnitt 11, Alternative 1. Kurz: Zähler und „zuletzt“ **folgen** aus den Zeilen; die Zeile trägt zusätzlich **welche Nachricht** es war (ohne sie ist beim Ausladen und Löschen nicht aufzuräumen), und der Schlüssel macht das Beanspruchen atomar, ohne dass jemand eine Sperre über das Senden halten muss.
* **Warum die Zeile VOR der Nachricht entsteht:** wie `event_placements` (0023): Bricht das Zustellen ab, steht sichtbar, was aussteht; der Schlüssel der Nachricht ist die `id` der Zeile, ein zweiter Anlauf legt keine zweite Karte an.
* **Warum `message_id ... on delete set null`:** Eine hart gelöschte Nachricht (Konto-Löschung der Gegenseite räumt die Teilnehmerzeile und damit diese Zeile ohnehin ab) soll die Zeile nicht blockieren. Eine **leere** `message_id` bedeutet „offen“; das Nachholen ist auf einen Tag und drei Versuche begrenzt, ein theoretisch verwaister Eintrag wird also nicht ewig versucht.
* **Warum die `id` ein Zufallswert ist (`gen_random_uuid()`, Postgres ≥ 13, im Kern; Vorgabe ist 16):** Das Haus nimmt sonst UUID v7 aus der Anwendung, weil sie zeitlich sortieren. Diese Kennung sortiert nichts, sie ist nur der Schlüssel der Nachricht – und nur so geht **Auswahl und Beanspruchen in einer Anweisung** (Abschnitt 5.3).

### 4.3 Löschverhalten

| Ereignis | Wirkung |
|---|---|
| Person ausgeladen / trägt sich aus | Teilnehmerzeile weg → Zeilen in `event_erinnerungen` per Cascade weg. **Vorher** werden die Nachrichten der Erinnerungskarten als gelöscht markiert (`einladen::aendern_vorbereiten`, vor dem `delete from event_attendees`), `message.deleted` an die Beteiligten. |
| Termin gelöscht (`deleted_at`) | `einladen::termin_loeschen` markiert zusätzlich die Erinnerungskarten als gelöscht und löscht ihre Zeilen (eine Anweisung). Die Abfrage der Fälligen schliesst gelöschte Termine ohnehin aus. |
| Termin hart gelöscht | Cascade über `event_attendees` (und damit `event_erinnerungen`). |
| Konto der Person gelöscht | Teilnehmerzeile und Zeilen weg; die Nachrichten bleiben im Chat des Erstellers (wie jede Nachricht eines gelöschten Gegenübers). |
| Konto des Erstellers gelöscht | `created_by` wird leer → Abfrage schliesst aus; Karten bleiben als Nachrichten ohne Absender. |
| Chat verlassen | Keine Wirkung auf die Zeilen; die Abfrage verlangt die Mitgliedschaft beider und lässt die Person aus. |

---

## 5. c) Der Dienst

### 5.1 Form (Vorlage `storage/muell.rs`, und was anders sein muss)

Datei `apps/api/src/services/erinnern.rs`, Modul in `services/mod.rs`. Wie `muell`/`auslagern`: `pub async fn durchgang(...) -> Bilanz` (testbar, ohne Schlafen) plus `pub fn starten(...)` mit Schleife; Fehler je Zeile protokolliert, nie nach oben gereicht.

Anders als die Vorlage:

| | `muell`/`auslagern` | `erinnern` |
|---|---|---|
| Mehrere Instanzen | ungeschützt (unkritisch: Löschen/Wandern ist idempotent bzw. markiert) | **atomares Beanspruchen** in der Datenbank, jede Instanz darf laufen |
| Eine Nachricht lässt sich nicht zurückholen | – | Beanspruchen **vor** dem Senden; Senden mit festem Schlüssel; Nachholen offener Zeilen |
| Zeit | `Utc::now()` im Durchgang (`auslagern.rs`) bzw. keine | **`jetzt` als Parameter** (Vorbild: `gewicht(kandidat, jetzt)`, `auslagern.rs:122`) |
| Panik | beendet die Schleife still | **Jeder Durchgang in eigener Aufgabe**; `JoinError` wird protokolliert, die Schleife läuft weiter |
| Abschaltbar | nur über `KALT_TREIBER` | `ERINNERN_TAKT_S=0` |
| Test der Schleife | keiner | `starten` liefert `None` bei 0 (U3); der Durchgang selbst ist die geprüfte Einheit |

Signaturen:

```rust
pub struct Bilanz {
    pub beansprucht: usize,      // neu beanspruchte Erinnerungen
    pub zugestellt: usize,       // davon als Nachricht angelegt (inkl. nachgeholte)
    pub nachgeholt: usize,       // offene Zeilen früherer Durchgänge, jetzt zugestellt
    pub zurueckgenommen: usize,  // beansprucht, aber inzwischen nicht mehr gültig
    pub gescheitert: usize,      // Zustellen schlug fehl (Zeile bleibt offen)
}
pub async fn durchgang(state: &AppState, jetzt: DateTime<Utc>) -> Bilanz;
pub fn starten(state: AppState) -> Option<tokio::task::JoinHandle<()>>;   // None: ausgeschaltet
```

### 5.2 Takt, Start, Konfiguration

* **Takt: 300 s**, einstellbar `ERINNERN_TAKT_S` (`config.rs`, `number("ERINNERN_TAKT_S", 300)`; **0 = Dienst aus**; sonst auf 30 … 3600 geklemmt, eine Warnung beim Klemmen). Begründung: Die Fristen sind Stunden; fünf Minuten Verzug sind unmerklich, und im Leerlauf kostet ein Durchgang **eine** kleine Abfrage (Teilindex, Abschnitt 14: 34 ms bei 200 000 Terminen, 300 davon mit Erinnerung und 6000 Kandidaten – gemessen). Gleicher Takt wie der Müll-Aufräumer. 60 s verworfen: unnötig oft, und die Schranke „eine je Person und Durchgang“ verteilt Rückstände dann zu eng.
* **Start in `main.rs`** nach den Migrationen und nach `auslagern::starten` (Kommentar wie `main.rs:93-96`: vorher gäbe es die Tabelle beim allerersten Start noch nicht):

```rust
    /*
     * Der Erinnerungsdienst.
     *
     * Erst NACH den Migrationen: Vorher gibt es `event_erinnerungen` beim
     * allerersten Start noch nicht. Mehrere Instanzen dürfen laufen – wer eine
     * Erinnerung beansprucht, entscheidet die Datenbank, nicht der Zufall der
     * Uhren. `ERINNERN_TAKT_S=0` schaltet ihn ab.
     */
    initiative_api::services::erinnern::starten(state.clone());
```

* **Erster Durchgang 30 s nach dem Start** (Migrationen und die ersten Anfragen laufen; ein Dienst, der gleich Nachrichten schreibt, macht den Start langsamer – wie die 60 s der Auslagerung).
* **Die Uhr im Betrieb ist die der Datenbank:** `starten` fragt je Durchgang `select now()` ab und reicht es als `jetzt` herein (Rückfall `Utc::now()`, wenn die Abfrage scheitert). So rechnen **alle Instanzen mit derselben Uhr**, obwohl `durchgang` die Zeit als Parameter nimmt – Uhrabweichungen zwischen Maschinen sind damit ausgeschlossen (Bedenken aus `bestand-erinnern.md` Abschnitt 6.1).
* **Kein Abbruchsignal** (wie bei den anderen Diensten): Beim Herunterfahren stirbt die Aufgabe mit der Laufzeit. Das ist sicher, weil Beanspruchen und Senden wiederholbar sind (5.4).
* Dokumentation: `docs/DEPLOYMENT.md` (Tabelle der Umgebungswerte bei Zeile 133, dazu ein Satz bei `REALTIME_BUS` auf Zeile 153: Mit `memory` erreichen Nachrichten, die das Entwicklungsprogramm `erinnern_einmal` anlegt, die laufende API nicht live), `.env.example`.

### 5.3 Die Abfrage der Fälligen mit atomarem Beanspruchen

**Eine** Anweisung. Sie berechnet die Fälligen und trägt sie in `event_erinnerungen` ein; **was `on conflict` verliert, gehört einer anderen Instanz**. Bindungen: `$1` jetzt, `$2` Obergrenze (`ERINNERN_ANZAHL_MAX`), `$3` Reserve in Stunden, `$4` Stapel.

```sql
with kandidaten as (
  select e.id as event_id, a.user_id, p.conversation_id,
         coalesce(r.anzahl, 0) + 1 as nummer,
         greatest(a.eingeladen_am, e.erinnern_seit, r.zuletzt)
           + make_interval(hours => e.erinnern_nach_std) as faellig_am
    from calendar_events e
    join event_attendees a
      on a.event_id = e.id and a.status = 'pending' and a.user_id <> e.created_by
    join event_placements p                                  -- E1(c): zugestellte Einzelkarte
      on p.event_id = e.id and p.user_id = a.user_id
     and p.art = 'einzel' and p.message_id is not null
    join conversation_members mp                              -- E1(d): beide noch im Chat
      on mp.conversation_id = p.conversation_id and mp.user_id = a.user_id
    join conversation_members me
      on me.conversation_id = p.conversation_id and me.user_id = e.created_by
    left join lateral (
      select count(*)::int as anzahl, max(x.beansprucht_am) as zuletzt
        from event_erinnerungen x
       where x.event_id = a.event_id and x.user_id = a.user_id
    ) r on true
   where e.erinnern_nach_std is not null                      -- an
     and e.deleted_at is null
     and e.status = 'confirmed'                               -- E3
     and e.created_by is not null
     and coalesce(r.anzahl, 0) < least(coalesce(e.erinnern_anzahl, $2::int), $2::int)
     and $1 <= e.starts_at                                    -- E2: nicht in den letzten Stunden
                - case when e.all_day then interval '12 hours' else interval '0' end
                - make_interval(hours => $3::int)
),
je_person as (                                                -- E4: eine je Person und Durchgang
  select distinct on (user_id) *
    from kandidaten
   where faellig_am <= $1
   order by user_id, faellig_am, event_id
),
auswahl as (
  select * from je_person order by faellig_am, user_id limit $4::bigint
),
beansprucht as (
  insert into event_erinnerungen (id, event_id, user_id, nummer, conversation_id, beansprucht_am)
  select gen_random_uuid(), event_id, user_id, nummer, conversation_id, $1
    from auswahl
  on conflict (event_id, user_id, nummer) do nothing
  returning id, event_id, user_id, nummer, conversation_id
)
select b.id, b.event_id, b.user_id, b.nummer, b.conversation_id,
       e.title, e.created_by
  from beansprucht b
  join calendar_events e on e.id = b.event_id
 order by b.user_id
```

**Warum das atomar ist (und erprobt, Abschnitt 14):** Zwei Instanzen, die gleichzeitig dieselbe Auswahl sehen, versuchen beide, `(Termin, Person, 1)` einzutragen. Die zweite Einfügung **wartet** auf die erste (Postgres wartet bei `on conflict` auf den nicht festgeschriebenen Index-Eintrag) und überspringt die Zeile, sobald die erste festgeschrieben ist. Nach dem Festschreiben sieht jede spätere Anweisung die Zeile und rechnet `nummer = 2` und eine neue Fälligkeit – nichts doppelt. Rollt die erste zurück, bekommt die zweite die Zeile.
Gemessen: Sitzung 1 beansprucht 20 Zeilen und hält 3 s die Transaktion offen, Sitzung 2 (1 s später) beansprucht **0**, in der Tabelle stehen 20 Zeilen für 20 Personen.

Warum **keine** `for update skip locked`-Transaktion um das Senden: Siehe Alternative 8. Kurz: `create_message` nutzt den Pool, ist nicht transaktionsfähig; eine Sperre über das Senden hielte Zeile und Verbindung und liesse bei einem Absturz zwischen Senden und Festschreiben die Nachricht draussen, die Zeile aber frei – **doppelt** beim nächsten Mal. Hier ist die Reihenfolge andersherum: erst beanspruchen, dann senden.

Wie die Stopp-Bedingungen in der Abfrage stehen (alle am Server, keine am Client):

| Bedingung (E1–E3, Auftrag) | Wo |
|---|---|
| Person hat geantwortet | `a.status = 'pending'` |
| Person nicht mehr eingeladen | Teilnehmerzeile fehlt → Join leer (und Cascade auf die Zeilen) |
| Person/Ersteller nicht mehr im Chat | zwei `conversation_members`-Joins |
| Termin gelöscht | `e.deleted_at is null` |
| Termin abgesagt oder in Abstimmung | `e.status = 'confirmed'` |
| Beginn erreicht (auch Reserve) | `$1 <= Beginn − Reserve` |
| Anzahl erreicht | `r.anzahl < least(coalesce(Anzahl, Obergrenze), Obergrenze)` |
| Erinnern aus | `e.erinnern_nach_std is not null` |
| Keine Einzelkarte | Join auf `event_placements` |
| Ersteller fehlt | `e.created_by is not null` |

### 5.4 Der Durchgang

```
durchgang(state, jetzt):
  1. nachholen(state, jetzt)      offene Zeilen früherer Durchgänge: Nachricht fehlt, ≥ 2 min alt, < 1 Tag alt, versuche < 3
  2. beanspruchen(state, jetzt)   die Anweisung oben (höchstens STAPEL = 100)
  3. je Anspruch zustellen        höchstens 4 gleichzeitig (EINLADUNG_PARALLEL), jede für sich
  4. Mitteilungen                 gebündelt, einmal, im Hintergrund (Abschnitt 6.4)
  5. melde_termin je Termin       einmal je betroffenem Termin (stand + 1, Zähleranzeige des Erstellers)
  6. Bilanz zurückgeben, Protokoll schreiben
```

**Nachholen** (Schritt 1) beansprucht seinerseits atomar – `update … set versuche = versuche + 1 where id in (select … for update skip locked) returning …` –, damit zwei Instanzen dieselbe offene Zeile nicht gleichzeitig nachholen; die Wartezeit von 2 Minuten hält es von Zeilen fern, die eine andere Instanz gerade zustellt.

**Zustellen einer Zeile** (Schritt 3), jede Zeile für sich:

1. **Gilt es noch?** Eine Leseabfrage: Person weiterhin `pending`, Termin nicht gelöscht, `confirmed`. Sonst wird die **Beanspruchung zurückgenommen** (Zeile gelöscht, zählt nicht) – das schliesst das Fenster zwischen Auswahl und Senden, in dem jemand geantwortet haben kann.
2. **Nachricht** `create_message(NewMessage::erinnerung(…))` – stumm, fester Schlüssel `client_id = "erinnerung:{id der Zeile}"` (Abschnitt 6.2). Wiederholbar: Ein zweiter Anlauf liefert dieselbe Nachricht.
3. **Eintragen** `update event_erinnerungen set message_id = $2 where id = $1`.

Der Schlüssel hängt an der **Kennung der Zeile** und nicht an `(Termin, Person, Nummer)`: Wird jemand ausgeladen und später wieder eingeladen, beginnt die Zählung bei 1 – mit `…:{Nummer}` bekäme die neue Erinnerung die **gelöschte** Nachricht von damals zurück (dieselbe Falle, die `NewMessage::einladung` für die Einladungskarte beschreibt).

### 5.5 Nachholen nach längerem Stillstand

* **Eine Erinnerung je Person und Durchgang**, nie eine je versäumtem Abstand: Die Beanspruchung setzt `beansprucht_am = jetzt`, die Fälligkeit der nächsten ist `jetzt + Abstand`. Nach fünf Tagen Ausfall und einem Abstand von 24 Stunden kommt **eine** Erinnerung, die zweite einen Tag später (R6).
* **Nie nach dem Beginn und nie in der Reserve** (E2) – was der Ausfall verschluckt hat, ist verloren, nicht aufgeschoben.
* **Rückstau wird abgebaut, nicht gestaut:** Höchstens 100 Beanspruchungen je Durchgang, die ältesten Fälligkeiten zuerst; Rest im nächsten Takt. Eine Person mit mehreren fälligen Terminen bekommt sie in aufeinanderfolgenden Durchgängen (R7), nicht fünf auf einmal.

### 5.6 Fehlerbehandlung

| Fehler | Wirkung |
|---|---|
| Beanspruchen scheitert (Datenbank weg) | Warnung, Durchgang endet, nächster Takt. |
| Zustellen einer Zeile scheitert | Warnung mit **Kennungen** (Termin, Person), nie Titel/Name. Zeile bleibt offen (`message_id` leer), **die anderen Zeilen laufen weiter**. Nachholen: nach ≥ 2 min, höchstens **dreimal**, nur innerhalb eines Tages. Danach bleibt sie liegen und **zählt als Versuch** (die Zählung bleibt konservativ: lieber eine Erinnerung zu wenig als zu viel). |
| Zeile gilt nicht mehr | Beanspruchung zurückgenommen (gelöscht), `zurueckgenommen += 1`. |
| Mitteilung (Push) scheitert | Im Hintergrund, protokolliert, ohne Folgen für die Nachricht. |
| `melde_termin` scheitert | Warnung. |
| Panik im Durchgang | Eigene Aufgabe → `JoinError` → `tracing::error!`; Schleife läuft weiter. |
| Eine „kaputte“ Zeile (z. B. Zustellen scheitert dauerhaft) | Blockiert niemanden: je Zeile isoliert; nach drei Nachholversuchen wird sie nicht mehr angefasst; die **Fälligkeit der Person** rechnet ab dem Versuch, es entsteht also keine enge Wiederholungsschleife. |

Bekannte Schwäche (Risiko 5): Ein Absturz **nach** dem Anlegen der Nachricht und **vor** dem Eintragen lässt die Zeile offen; das Nachholen findet die Nachricht über den festen Schlüssel wieder (kein Duplikat), aber der damalige Rundruf und Push fehlen – die Karte erscheint beim nächsten Laden des Chats, die Mitteilung kann doppelt oder gar nicht kommen (das `tag` ersetzt auf dem Gerät).

### 5.7 Protokoll

* Beim Start einmal: „Erinnerungsdienst läuft (Takt 300 s)“ bzw. „… ausgeschaltet (ERINNERN_TAKT_S=0)“.
* Je Durchgang **nur wenn etwas geschah**: `tracing::info!(beansprucht, zugestellt, nachgeholt, zurueckgenommen, gescheitert, "Erinnerungen")` (wie `Auslagerung`/`geloeschte Dateien weggeraeumt`).
* Fehler als `warn!` mit `termin = %id, person = %id`; Panik als `error!`. **Keine Titel, keine Namen, keine Nachrichtentexte** im Protokoll (Datenschutz, Abschnitt 6.6).

---

## 6. d) Die Erinnerung selbst

### 6.1 Welche Nachrichtenart

**Eine `event`-Karte mit Zusatz:** `type = "event"`, `metadata = { eventId, erinnerung: { nummer } }`, `body` = Erinnerungstext.

| Frage | Antwort |
|---|---|
| Karte mit Zu-/Absage-Knöpfen? | Ja – es ist dieselbe `EventBubble`: Datumsblock, Zeit, Ort, Zählung, Knöpfe. Die Person kann **in der Erinnerung** antworten. |
| Synchron? | Von selbst: `event`-Nachricht mit `eventId` → `EventExpander` hydriert sie, `terminAbgleichen` im Chat-Speicher führt sie in **allen** Chats nach, `ausspielen` kürzt sie für Nicht-Eingeladene. **Kein neuer Code** auf diesen Wegen. |
| Ältere App-Stände? | Rendern `EventBubble` (ohne Banner) und zeigen `body` als Absatz (`EventBubble.tsx`, `cal-bubble-body`) – der Text ist also auch dort sichtbar. |
| Fälschbar vom Client? | Nein: `send_message` weist jede Nachricht mit `eventId` in `metadata` und jeden `type: event` ab. |

**Verworfen** (Abschnitt 11): neue Art `event_reminder` (an sechs Stellen zu pflegen – `constants.rs`, `constants.ts`, beide Vorschauen, Sendeverbot, Expander, Trichter, Registrierung – und die Synchronität, die jetzt umsonst kommt, müsste nachgebaut werden); `system` mit `kind` (kann den Termin nicht hydrieren und keine Knöpfe zeigen, die Modulgrenze Nachrichten → Kalender müsste durchbrochen werden); Text im Namen des Erstellers (Unterschiebung).

### 6.2 Absender und Kennzeichnung

**Absender = Ersteller** (technisch), **ausdrücklich als automatische Erinnerung gekennzeichnet** (inhaltlich).

* Warum der Ersteller: Es gibt im Bestand **keine** absenderlose Automatik und kein Bot-Konto (Abschnitt 1, Punkt 10). Der Ersteller als Absender ist die einzige Wahl, bei der (a) der Eingeladene die Nachricht als **eingehend** sieht, (b) der Ersteller **kein „ungelesen“** bekommt, (c) der Push nur an den Eingeladenen geht (`notify` schliesst den Absender aus; hier ohnehin eigener Weg), (d) der Idempotenz-Index greift (er nimmt `sender_id` mit).
* **Warum das keine Unterschiebung ist:** Die Karte sagt es in **jedem** Zustand. Banner oben in der Karte: „🔔 Automatische Erinnerung“ (für den Empfänger mit Nummer: „🔔 Automatische Erinnerung · 2.“). Der Text ist **Sache der Oberfläche**, nicht des gespeicherten `body`: Der Empfänger liest „Du hast noch nicht auf „Grillen“ geantwortet.“, **solange er offen ist**; danach „Deine Antwort: Zugesagt.“ – eine gespeicherte Zeile würde nach der Antwort lügen. Der **Ersteller** liest dieselbe Karte als „Automatische Erinnerung an Ben“. Die Karte ist keine Blase mit Sprechtext, sondern eine Karte mit Kopfzeile.
* Der gespeicherte `body` („Erinnerung: Du hast noch nicht auf „X“ geantwortet.“) dient nur als Rückfall (ältere Clients) und für Vorschau/Mitteilung. Er enthält den Titel **zum Zeitpunkt der Erinnerung**; eine spätere Umbenennung zeigt die Karte live (aus `event`), der Rückfalltext bleibt alt.

### 6.3 Text und Zusammenbau

```rust
pub fn erinnerungstext(titel: &str) -> String {
    format!("Erinnerung: Du hast noch nicht auf „{titel}“ geantwortet.")
}

impl NewMessage {
    /// Die Karte einer Erinnerung – stumm, mit festem Schlüssel.
    pub fn erinnerung(chat: Uuid, ersteller: Uuid, event_id: Uuid,
                      zeile: Uuid, nummer: i16, titel: &str) -> Self {
        Self {
            client_id: Some(format!("erinnerung:{zeile}")),
            silent: true,
            body: Some(erinnerungstext(titel)),
            metadata: json!({ "eventId": event_id, "erinnerung": { "nummer": nummer } }),
            ..Self::entity(chat, ersteller, "event", "eventId", event_id)
        }
    }
}
```

* **Stumm**, aus demselben Grund wie die Einladungskarte: Die Mitteilung kommt **einmal, gesondert** (6.4), mit eigenem Text. `notify_new_message` würde „📅 Termin“ senden (`message_preview` kennt für `event` nur diesen Text) und das Kennzeichen `conversation:{chat}`.
* **Keine Uhrzeit im Text** (Zeitzone unbekannt); Zeit und Ort stehen in der Karte, die das Gerät formatiert.
* `MessageMetadata` im gemeinsamen Paket bekommt `erinnerung?: { nummer: number }` (als eigenes Feld, **nicht** unter `module`).
* **Chatliste/Vorschau:** `messagePreview` (TS) liefert für `event` mit `metadata.erinnerung` **„🔔 Erinnerung“** statt „📅 Termin“ (ein Zweig, ein Test; der Gleichlauftest mit Rust bleibt grün, weil er `event` ohne Metadaten prüft). `ChatListScreen` lässt für Erinnerungen das Präfix „Du: “ weg (der Ersteller hat sie nicht geschrieben). Rust braucht keine Änderung: Erinnerungen sind stumm und laufen nie durch `message_preview`.

### 6.4 Benachrichtigung (Push): einmal

`notify::benachrichtige_erinnerungen(state, &[Erinnert { termin_id, titel, person, chat, nachricht }])` – eine Funktion neben `benachrichtige_einladung`/`benachrichtige_termin`, **eine** Abfrage für alle Personen des Durchgangs (Einstellungen, Stummschaltung des Chats), Versand gebündelt im Hintergrund (`state.push.im_hintergrund`):

| | |
|---|---|
| Empfänger | Die erinnerte Person (nie der Ersteller). |
| Filter | `settings.notifications.push` (Vorgabe an) – wie überall; **Stummschaltung des Einzelchats** (`muted_until`) unterdrückt die Mitteilung, nicht die Nachricht (`push_ziel(Some(chat), &[], stumm)`); Vorschau-Einstellung (`previews`). |
| Mit Vorschau | Titel „Initiative“, Text „Erinnerung: Du hast noch nicht auf „X“ geantwortet.“ (gekürzt auf 140 Zeichen) |
| Ohne Vorschau | Titel „Initiative“, Text „Erinnerung an einen Termin“ |
| `kind` | `event` (das TypeScript-Schema kennt die Art, `push.ts`) |
| `url` / `conversationId` / `messageId` | `/chats/{Einzelchat}` / dieselbe / die Karte – der Service Worker unterdrückt die Anzeige, wenn der Chat offen und fokussiert ist (`sw.ts`, push-Ereignis). |
| `tag` | `termin:{id}` mit `renotify` (Service Worker): ersetzt die stehende Einladung **und** die vorige Erinnerung zum selben Termin – auf dem Gerät steht höchstens **eine** Mitteilung je Termin, die aber erneut klingelt. |

Titel „Initiative“ statt des Namens des Erstellers: Die Mitteilung kommt von der App, nicht von einer Person. Gleiches Nicht-Aufdrängen wie bei der Karte.
Die Nachricht selbst bleibt auch bei Stummschaltung, ausgeschaltetem Push und fehlenden Abos **im Chat** – die Mitteilung ist ein Zusatz.

### 6.5 Darstellung im Web (Registry und Blasen)

* **Registry unverändert:** `calendar/module.ts` registriert `event: EventBubble`; kein neuer Eintrag. Erinnerungen laufen durch dieselbe Blase.
* **`EventBubble.tsx`:** Kleiner Zweig `message.metadata.erinnerung`: Kopfzeile (`<p className="cal-bubble-erinnerung" role="note">`, Glocke `aria-hidden`) mit dem Text je Betrachter und Zustand (reine Funktion `erinnerungsZeile` in `erinnern.ts`, Abschnitt 8.5). Den Absatz `message.body` lässt die Blase bei Erinnerungen **aus** (er würde nach der Antwort lügen, s. o.). Alles andere – Karte, Knöpfe, Absage-Zustand, „Termin nicht verfügbar“ – bleibt.
* **Zähler für den Ersteller:** Die Anzeige lädt `GET …/erinnerungen` und lädt neu, wenn sich `event.stand` ändert (wie `ZustellungHinweis`). Damit der Stand nach einer Erinnerungswelle steigt, ruft der Dienst je betroffenem Termin **einmal** `melde_termin` (ein `event.updated` an die Teilnehmer, wie bei jeder Zusage). Ohne das wüsste die offene Detailseite des Erstellers bis zum nächsten Öffnen nichts von der Welle.
* **Chatliste:** „🔔 Erinnerung“, ohne „Du: “.
* **Kein Blasen-Menü-Sonderfall:** Antworten/Weiterleiten/Reaktionen wie bei der Einladungskarte; der Ersteller kann eine Erinnerung als eigene Nachricht für alle löschen (Hinweis „Diese Nachricht wurde gelöscht“, wie jede) – das ändert die Zählung nicht.

### 6.6 Datenschutz

* **Wer sieht was:** Eine Erinnerung steht nur im **Einzelchat** zwischen Ersteller und Eingeladenem – beide kennen den Termin. Niemand sonst sieht sie (Gruppenchat nie, Test R4). Für Nicht-Eingeladene gilt weiter die gekürzte Fassung (`ausspielen`).
* **Die Einstellung** (`erinnern`) sehen alle Teilnehmer – wie die Teilnehmerliste: Wer erinnert wird, soll wissen, dass und wie oft. **Wie oft jemand schon erinnert wurde** sieht **nur der Ersteller** (`GET …/erinnerungen`, `nur_ersteller`; für Nicht-Eingeladene 404). Der Rundruf `event.updated` und `CalendarEventDto.attendees` tragen **keine** Zähler.
* **Datensparsamkeit:** `event_erinnerungen` hält Kennungen und Zeitpunkte, keinen Text. Keine Auswertung, kein „Lesebestätigung“.
* **Löschung/Auskunft:** Konto der Person gelöscht → Zeilen per Cascade weg (R15); die Nachrichten sind Chat-Nachrichten und folgen der bestehenden Behandlung (Datenexport/Löschung in `modules/users.rs`/`datenschutz.rs` unverändert). Docs: `docs/SICHERHEIT.md` Abschnitt 3c bekommt einen Absatz.
* **Protokoll:** Nur Kennungen. Mitteilung ohne Vorschau nennt weder Termin noch Ersteller.
* **Missbrauch begrenzt:** ≥ 12 h Abstand, ≤ 10 je Person und Termin, nur wo die Einladung ankam, jede Antwort (auch „Vielleicht“) beendet es, die Person kann den Chat stummschalten oder sich austragen. Kein Weg für Fremde: Erinnert wird nur, wer eingeladen **wurde**.

---

## 7. API-Verträge

### 7.1 Einstellung (Anlegen und Ändern)

`POST /calendar/events` und `PATCH /calendar/events/{id}` bekommen ein optionales Feld:

```jsonc
"erinnern": { "nachStunden": 48, "anzahl": 3 }   // anzahl: null = bis zum Termin (höchstens 10)
"erinnern": null                                  // PATCH: aus. POST: wie weglassen
// fehlend: beim PATCH unverändert
```

* `UpdateEventInput.erinnern: Option<Option<ErinnernInput>>` (mit `super::double_option`, wie `description`).
* Änderung der Einstellung verlangt **den Ersteller** (`nur_ersteller`), nicht jeden, der Inhalt ändern darf: Der Ersteller ist die Stimme der Erinnerung; ein Gruppen-Admin ändert Zeit und Ort, aber nicht, wen der Ersteller wie oft anschreibt.
* Im `PATCH` wird `erinnern_seit` **genau dann** auf `now()` gesetzt, wenn sich `(nachStunden, anzahl)` gegenüber der gesperrten Zeile (`for update` ist schon da) **ändert** oder ein abgesagter Termin wiederaufgenommen wird **und** die Einstellung eingeschaltet ist; beim Ausschalten werden alle drei Spalten geleert (Prüfbedingung).
* `NewEvent.erinnern: Option<Erinnern>`; die Einfügung schreibt die drei Spalten (`erinnern_seit = now()` bei eingeschaltet). **Alle Aufrufer ausser dem Editor** (Umfrage, Terminfindung, `seed.rs`, ältere App-Stände) lassen es leer: kein Verhalten ändert sich.
* Die Antwort enthält die Einstellung im Termin:

```jsonc
"erinnern": { "nachStunden": 48, "anzahl": 3 }    // oder null
```

`CalendarEventDto.erinnern: Option<ErinnernDto>` (`nachStunden`, `anzahl`), gespiegelt in `packages/shared` (`CalendarEventDto.erinnern: ErinnernDto | null`). Ältere Clients ignorieren das Feld.

### 7.2 Stand der Erinnerungen (nur Ersteller)

`GET /calendar/events/{id}/erinnerungen`:

```jsonc
{ "aktiv": true,
  "hoechstens": 3,                                                         // wirksame Anzahl (1 … 10)
  "personen": [ { "userId": "…", "gesendet": 2, "zuletztAm": "2026-10-03T14:05:00Z" },
                { "userId": "…", "gesendet": 0, "zuletztAm": null } ],      // noch Ausstehende, die erinnert werden können
  "ohneEinzelchat": ["…"] }                                                // Ausstehende, die nicht erinnert werden können (E1 c, d)
```

`gesendet` zählt Zeilen mit Nachricht. 403/404 wie `zustellung_lesen`. Bei Terminen ohne Erinnern: `aktiv: false`, leere Listen.

### 7.3 Eingaben im gemeinsamen Paket

`erinnernSchema = z.object({ nachStunden: z.number().int().min(12).max(720), anzahl: z.number().int().min(1).max(10).nullable() })`, in `createEventSchema` als `erinnern: erinnernSchema.nullable().optional()` (gilt über `updateEventSchema` mit). `LIMITS.erinnernNachStdMin/Max`, `erinnernAnzahlMax`, `erinnernReserveStd` aus `constants.ts`.

---

## 8. e) Die Oberfläche

### 8.1 Bausteine

| Datei | Inhalt |
|---|---|
| `apps/web/src/modules/calendar/erinnern.ts` (neu) | **Die gesamte Logik rein und ohne React:** Vorgaben, `fristText`, `anzahlText`, `erinnernText`, `erinnernPruefen`, `erinnernBody` (Formular → API, nur bei Unterschied), `wirkungsHinweis`, `erinnerungsZeile`. Testbar in vitest (`node`). |
| `apps/web/src/modules/calendar/ErinnernWahl.tsx` (neu) | Der Block im Terminblatt: Schalter, zwei Auswahlgruppen, Zusammenfassung, Hinweise. Zustandslos bis auf die Eingabe „Eigene Dauer“. |
| `apps/web/src/modules/calendar/ErinnernStand.tsx` (neu) | Der Absatz für den Ersteller in der Detailansicht (Zähler je Person, „nicht erinnerbar“). |
| `EventEditor.tsx` | **Ein zusammenhängender Block**: Zustand `erinnern`, ein Feld im `body` von `save()`, ein Element im JSX direkt **nach** `EinladungsWahl`. Der Rest bleibt, weil die Themen „Ort“ und „Sammlung“ dieselbe Datei ändern (Risiko 9). |
| `EventDetailScreen.tsx` | Zeile „🔔 Erinnerungen an Ausstehende: …“ (nach der Zeile mit `reminderMinutes`), `<ErinnernStand>` im Ersteller-Teil. |
| `EventBubble.tsx` | Kopfzeile bei `metadata.erinnerung`. |
| `ChatListScreen.tsx`, `packages/shared/src/util/format.ts` | „🔔 Erinnerung“ ohne „Du: “. |
| `lib/api.ts` | `calendar.erinnerungen(id)`. |
| `modules/calendar/styles.css` | Stile mit Präfix `cal-erinn-` (`global.css` bleibt unberührt). |
| `packages/shared` | Typen (`ErinnernDto`, `ErinnernStandDto`, `MessageMetadata.erinnerung`), Schema, `LIMITS`, `util/erinnern.ts` (`erinnerungenBisBeginn`), Testfälle `testdaten/erinnern.json`. |

### 8.2 Aufbau im Terminblatt (375 px, nur Ersteller, beim Anlegen und Bearbeiten)

Direkt unter dem Feld „Eingeladen“ (die Erinnerung hängt an der Einladung). Nicht bei einer Terminfindung.

```
Erinnerung bei offener Antwort                       [ Ausstehende erinnern  ○─ ]
Aus: Wer nicht antwortet, wird nicht erinnert.                      (Schalter aus)

Erste Erinnerung nach                                              (Schalter an)
 (•) 1 Tag   ( ) 2 Tage   ( ) 3 Tage   ( ) 1 Woche   ( ) Eigene Dauer: [ 36 ] Stunden
Wie oft insgesamt
 ( ) Einmal  ( ) Zweimal  (•) Dreimal  ( ) 5-mal  ( ) Bis zum Termin (höchstens 10-mal)

Wer nach 2 Tagen noch nicht geantwortet hat, bekommt im Einzelchat eine automatische
Erinnerung – bis zu 3-mal, jeweils nach weiteren 2 Tagen. Wer antwortet, wird nicht mehr erinnert.
Bis zum Beginn passen 2 Erinnerungen.                                      (Hinweis, live)
Bearbeiten: Bisher gesendet: 4 Erinnerungen an 2 Personen. Eine Änderung startet die Uhr neu.
```

Verhalten:

* **Schalter** (`<input type="checkbox" role="switch">` im `cal-switch`-Muster der Datei), Beschriftung „Ausstehende erinnern“. Beim Einschalten: 2 Tage, Dreimal.
* **Auswahl als echte Optionsfelder** in `<fieldset>`/`<legend>` („Erste Erinnerung nach“, „Wie oft insgesamt“): Pfeiltasten und Screenreader-Verhalten kommen vom Browser; als Chips gestaltet (`cal-erinn-chip`, `:checked` und `:focus-visible` sichtbar). Gespeicherte Werte, die nicht zu den Vorgaben gehören (API-Clients: 36 h, 7-mal), erscheinen als **zusätzliche gewählte Option** bzw. in „Eigene Dauer“.
* **„Eigene Dauer“:** Zahlenfeld (`inputMode="numeric"`, `min=12`, `max=720`), Beschriftung „Stunden“, Fehlertext am Feld mit `aria-describedby`; Tipp „Vielfache von 24 Stunden erinnern zur selben Tageszeit wie die Einladung.“
* **Zusammenfassung** (`role="status"`, `aria-live="polite"`): `erinnernText` ausgeschrieben.
* **Wirkungshinweis** (live aus Beginn, Wiederholung, Ganztägig, „jetzt“ – `erinnerungenBisBeginn`): „Bis zum Beginn passen N Erinnerungen“ / **„Der Termin beginnt vor der ersten Erinnerung – es wird keine gesendet.“** / „Bei Wiederholungen gilt der erste Termin der Serie.“ / „Ganztägig: Die letzte Erinnerung kommt spätestens 2 Stunden vor Beginn des Tages.“ Für **Bearbeiten**: gerechnet ab jetzt (so kämen die Erinnerungen für jemanden, der jetzt eingeladen würde).
* **Gesperrt** (Schalter `disabled`, Hinweis darunter): beim Anlegen, wenn „Einladung im Chat senden“ oder „Einzelchats“ aus ist („Erinnerungen gehen in die Einzelchats – schalte „Einladung im Chat senden“ und „Einzelchats“ ein.“) oder niemand gewählt ist („Wähle zuerst Personen aus.“).
* **Speichern:** Anlegen sendet `erinnern` nur, wenn eingeschaltet. Bearbeiten sendet es **nur bei Unterschied** zur gespeicherten Einstellung (`erinnernBody`): ein Termin, an dem nur der Titel geändert wurde, setzt die Uhr nicht neu. Ausschalten sendet `erinnern: null`.
* **Zusatzzeile der Vorschau im Editor:** Ändert der Ersteller die Einstellung, nennt `EinladungsWahl.zusatzZeilen` (wie bei Zeit/Ort) „Erinnerungen: nach 2 Tagen, bis zu 3-mal – die Uhr beginnt jetzt neu.“
* **Beschriftung der bestehenden Gruppe „Erinnerungen“** (Kalender-App, `reminderMinutes`): Empfehlung, sie in **„Erinnerung vor dem Termin“** umzubenennen, damit die beiden Blöcke untereinander nicht verwechselt werden („Erinnerung vor dem Termin“ / „Erinnerung bei offener Antwort“). Kein Test hängt am alten Text (`git grep Erinnerung` in `e2e`/`src` trifft nur den Editor und zwei Kommentare).

### 8.3 Detailansicht

* **Für alle Teilnehmer**, wenn `event.erinnern` gesetzt ist, unter den bestehenden Terminfakten: „🔔 Erinnerungen an Ausstehende: nach 2 Tagen, bis zu 3-mal“ (`erinnernText`). Wer erinnert wird, soll wissen warum.
* **Für den Ersteller** zusätzlich ein Block `ErinnernStand` („Erinnerungen“), nur wenn eingeschaltet und mindestens eine Person aussteht:
  * je Person: Name, „2 von 3 gesendet · zuletzt am 3. Okt., 14:05“ bzw. „noch keine gesendet“ (bei „bis zum Termin“ ohne „von“);
  * **„Nicht erinnerbar:“** die Personen aus `ohneEinzelchat` mit der Begründung „kein Einzelchat mit der Einladung“ und dem Hinweis, dass sich das beim Einladen mit „Einzelchats“ ändern lässt;
  * lädt neu, wenn `event.stand` steigt.
* Ist niemand mehr offen: „Alle haben geantwortet.“ (statt einer leeren Liste).

### 8.4 Barrierefreiheit und 375 px

* Jede Bedienung per Tastatur (Schalter: Leertaste; Optionsfelder: Pfeile; Zahlenfeld). Namen: Gruppen über `legend`, Schalter und Felder sichtbar beschriftet. Zusammenfassung und Wirkungshinweis sind **die einzigen** Live-Regionen des Blocks (`aria-live="polite"`, `aria-atomic`), ohne Meldung bei jedem Tastendruck im Zahlenfeld (Meldung erst nach gültigem Wert).
* Farbe ist nie allein Träger: Zustand „keine Erinnerung möglich“ und „Fehler“ tragen Text.
* 375 px: Chips `flex-wrap`, `min-width: 0`, keine feste Breite, **kein seitliches Scrollen**; Tippflächen ≥ 44 px (`min-height: 44px`); die Kopfzeile der Erinnerungskarte bricht um.

### 8.5 Die reinen Funktionen (kurz)

```ts
fristText(std)      // 24 → "1 Tag", 48 → "2 Tagen" (Dativ nach „nach“), 168 → "1 Woche", 336 → "2 Wochen", 36 → "36 Stunden", 720 → "30 Tagen"
anzahlText(n)       // 1 → "einmal", 3 → "bis zu 3-mal", null → "bis zum Termin (höchstens 10-mal)"
erinnernText(e)     // "nach 2 Tagen, bis zu 3-mal"
erinnernPruefen(std, anzahl)   // null | Fehlertext – dieselben Grenzen wie der Server
erinnerungenBisBeginn({ ab, beginn, ganztaegig, nachStunden, anzahl })   // Anzahl; gespiegelt in Rust (gemeinsame Fälle)
erinnerungsZeile({ ichBinErsteller, partner, status, titel, nummer })    // Kopfzeile der Karte je Betrachter und Zustand
```

`erinnerungenBisBeginn` ist die **Vorschau-Rechnung** („passen N Erinnerungen“): `k` aus `ab + k·Frist ≤ Beginn − 2 h`, höchstens `min(Anzahl | 10, 10)`. Sie steht im gemeinsamen Paket (`util/erinnern.ts`) und wird mit **denselben Testfällen** (`testdaten/erinnern.json`) gegen den **echten Dienst** geprüft (R14) – wie `zustellung.json` beim Einladen. So rechnen Oberfläche und Server dasselbe.

---

## 9. f) Tests

Regel wie beim Einladen: Logik so schreiben, dass sie **ohne Browser und ohne React** prüfbar ist (vitest läuft in `node`; keine Komponententest-Bibliothek, es kommt keine). Zusammenspiel prüft Playwright.

### 9.1 Wie sich der Dienst auslösen lässt – ohne Hintertür

| Ebene | Weg |
|---|---|
| Rust-Integration | `erinnern::durchgang(&state, jetzt)` direkt, `jetzt` frei gewählt (Zukunft). **Ein Schema je Test** (`set search_path`, Migrationen hinein – wie `tests/auslagern.rs`), weil der Dienst **alle** Termine der Datenbank sieht und die geteilte Entwicklungsdatenbank fremde Zeilen enthält. Der Dienst bekommt `AppState::from_pool(pool, config)`; `AppState::new/from_pool` starten keine Dienste (`state.rs`), also läuft nie zwei Mal etwas. |
| Browser | **Das Programm `src/bin/erinnern_einmal.rs`:** `erinnern_einmal --plus-stunden 49` bzw. `--jetzt 2026-10-05T10:00:00Z`; liest die Konfiguration wie `seed.rs` (`dotenvy`, `Config::from_env`), führt **einen** Durchgang zu `Datenbankzeit + Stunden` aus und schreibt die `Bilanz` als eine Zeile JSON auf stdout. Der Playwright-Test ruft es mit `execFileSync` (Pfad `E2E_ERINNERN_BIN`, Vorgabe `apps/api/target/debug/erinnern_einmal`; fehlt es, bricht der Test mit „cargo build --bin erinnern_einmal“ ab). Die Nachrichten laufen über denselben Bus wie im Betrieb: Mit `REALTIME_BUS=postgres` (Vorgabe, `config.rs`) erreicht das `NOTIFY` des Programms die Browser der laufenden API **live**. |

**Warum das keine Hintertür ist:** (1) Es ist ein **eigenes Programm**, kein Weg im Server: Es gibt **keine HTTP-Route**, keinen Schalter in der Konfiguration, keinen Umgebungswert, der die Uhr des Servers verstellt. (2) Das **Produktionsabbild baut es nicht**: Der Dockerfile baut `--bin initiative-api --bin seed` (`apps/api/Dockerfile`), eine dritte Datei in `src/bin/` wird weder gebaut noch ausgeliefert; `cargo clippy --all-targets` und `cargo test` übersetzen sie trotzdem, sie bleibt also geprüft. (3) Wer es aufrufen kann, hat bereits Zugang zur Datenbank – mehr Macht gibt es nicht her. (4) Verworfene Alternativen in Abschnitt 11 (HTTP-Testroute: Der Wert `NODE_ENV` ist standardmässig `development`, `config.rs:306` – eine vergessene Variable in Produktion machte sie scharf).
Das Programm trägt eine Warnung im Kopf („nur für Entwicklung und Tests“) und im `--help`.

**Der Browser-Test beeinflusst den laufenden Dienst der Entwicklungs-API nicht:** Dessen Durchgänge rechnen mit der echten Zeit; die Test-Termine sind erst nach `+25 h` fällig. Läuft das Programm gleichzeitig mit dem Dienst, beanspruchen beide atomar (das ist der Punkt von 5.3).

### 9.2 Rust – Einheit (`#[cfg(test)]`)

| ID | Datei | Prüft |
|---|---|---|
| U1 | `services/erinnern.rs` | `pruefen`: 11 → Fehler, 12 ok, 720 ok, 721 → Fehler; `anzahl` 0/1/10/11/`None`; deutsche Texte. |
| U2 | `services/messages.rs` | `NewMessage::erinnerung`: `silent`, Art `event`, `client_id = erinnerung:{zeile}`, `metadata.eventId` und `.erinnerung.nummer`, Text „Erinnerung: Du hast noch nicht auf „X“ geantwortet.“ |
| U3 | `config.rs` | `ERINNERN_TAKT_S`: nicht gesetzt → 300; 0 → aus; 5 → 30; 99999 → 3600; Müll → 300. `starten` liefert bei 0 `None`. |
| U4 | `services/notify.rs` | Mitteilungstext: mit Vorschau/ohne; Kürzung; `tag`/`url`/`kind`; Stummschaltung/Push-Schalter filtern (reine Funktion `erinnerung_mitteilung`). |

### 9.3 Rust – Integration (`apps/api/tests/erinnern.rs`, ein Schema je Test, Stil `einladen.rs`: eigener `Probe`, Hub-Empfänger, Push über den Mitschnitt)

Aufbau je Test: Konten A (Ersteller), B, C, D; **Einzelchats AB, AC, AD** und Gruppenchat G; Termin über die API mit `zustellung` (Einzelkarten + Gruppenkarte) und `erinnern`; die Zeiten (`eingeladen_am`, `erinnern_seit`, `starts_at`) per SQL auf **feste Werte** gesetzt (`T0`), damit Grenzen sekundengenau prüfbar sind.

| ID | Name | Prüft |
|---|---|---|
| R1 | `faellig_nach_der_frist_und_nicht_vorher` | Frist 24 h: bei `T0+23h59m` nichts, bei `T0+24h` genau eine Karte je offener Person im **Einzelchat**: Art `event`, Absender A, `metadata.erinnerung.nummer = 1`, `eventId`, Text, stumm; Zeile in `event_erinnerungen` mit `message_id`. Erinnern aus (Bestandstermin, leere Spalten) → nie etwas. |
| R2 | `zaehlt_im_gleichen_abstand_und_hoert_bei_der_anzahl_auf` | Dreimal: Karten bei +24 h, +48 h, +72 h (Nummern 1–3), bei +96 h keine; Abstand wird ab der **tatsächlichen** Beanspruchung gerechnet; `anzahl = null` bei sehr fernem Termin → genau 10, dann nichts. |
| R3 | `stopp_bei_antwort_ausladen_loeschen_absage_und_beginn` | a) Antwort `yes`/`no`/`maybe` vor der Fälligkeit → nichts; `pending` zurück → weiter, frühestens eine Frist nach der letzten. b) Ausladen → nichts, Zeilen und Erinnerungskarten weg. c) Termin gelöscht / abgesagt / in Abstimmung → nichts; **Wiederaufnahme** → nicht sofort, frühestens eine Frist danach. d) Beginn: bei `Beginn − 2 h` **noch**, eine Sekunde später **nicht mehr**; Ganztägig: Grenze bei `starts_at − 12 h − 2 h`; Serie mit `starts_at` in der Vergangenheit → nichts. e) Ersteller gelöscht (`created_by` leer) → nichts. |
| R4 | `nur_einzelchats_nur_ausstehende_nur_mit_einzelkarte` | Gruppenchat G bekommt **keine** zusätzliche Nachricht; Person ohne zugestellte Einzelkarte (Einzelchats abgewählt) → nichts, erscheint in `ohneEinzelchat`; hat eine Person den Einzelchat verlassen oder der Ersteller → nichts; der Ersteller wird nie erinnert; Dritte (nicht eingeladen) sehen die Karte nicht; ein bestehender Einzelchat wird **nicht** neu angelegt. |
| R5 | `gleichzeitige_durchgaenge_beanspruchen_jede_erinnerung_einmal` | `#[tokio::test(flavor = "multi_thread")]`: **vier** gleichzeitige Durchgänge (zwei `AppState` über dasselbe Schema, also zwei „Instanzen“), zehn Runden mit frischen Terminen und 20 Personen: Je Person **genau eine** Karte und **genau eine** Zeile je Nummer; die Summe der `Bilanz.beansprucht` ist 20. |
| R6 | `nach_langem_stillstand_kommt_eine_erinnerung_je_person` | Frist 24 h, fünf Mal, Beginn in 60 Tagen; erster Durchgang bei `T0+30d`: genau eine je Person (Nummer 1), ein zweiter Durchgang mit derselben Zeit **nichts**, bei `+30d+23h` nichts, bei `+30d+24h` Nummer 2. |
| R7 | `mehrere_termine_einer_person_kommen_in_getrennten_durchgaengen` | Zwei Termine, beide fällig: Durchgang 1 → eine Karte, Durchgang 2 → die zweite; nie zwei im selben. |
| R8 | `eine_kaputte_zeile_haelt_die_anderen_nicht_auf` | In dem Test-Schema ein Auslöser, der das Einfügen der Karte in Chat AC scheitern lässt (`before insert on messages … raise exception`; der Aufbau ist im Test, nicht im Produktivcode): B bekommt seine, C scheitert (`Bilanz.gescheitert = 1`), D bekommt seine; die Zeile von C bleibt offen. Auslöser entfernt, Durchgang nach 3 min → nachgeholt. Nach drei fehlgeschlagenen Versuchen wird sie nicht mehr angefasst. |
| R9 | `offene_zeilen_werden_nachgeholt_hoechstens_dreimal` | Von Hand eingetragene offene Zeilen: 3 min alt → zugestellt (einmal; zweiter Durchgang nichts, kein Duplikat); 1 min alt → nicht angefasst; älter als ein Tag → nicht angefasst; `versuche = 3` → nicht angefasst. Zeile von jemandem, der inzwischen geantwortet hat → **zurückgenommen** (gelöscht). |
| R10 | `einstellung_pruefen_speichern_anzeigen` | POST/PATCH: Grenzen mit den Fehlertexten; Termin in Abstimmung → 400; Nicht-Ersteller → 403 (Gruppen-Admin ebenso), Nicht-Eingeladener → 404; `erinnern` im DTO (auch im Rundruf und in der Liste); gleiche Einstellung noch einmal gespeichert → `erinnern_seit` **unverändert**, geänderter Abstand/geänderte Anzahl/Wiederaufnahme → `erinnern_seit` neu; `null` → alle drei Spalten leer; `GET …/erinnerungen`: nur Ersteller, Zähler und `ohneEinzelchat` stimmen. |
| R11 | `ausladen_und_loeschen_raeumen_auf_und_wiedereinladen_zaehlt_neu` | Nach zwei Erinnerungen: Ausladen → beide Karten „gelöscht“ (`message.deleted` an die Beteiligten), Zeilen weg; Wiedereinladen → Zählung bei 0, die neue Erinnerung hat einen **neuen** Schlüssel und bekommt **nicht** die gelöschte Nachricht zurück. Termin löschen → alle Erinnerungskarten als gelöscht. |
| R12 | `eine_mitteilung_je_erinnerung` | Mitschnitt: je Erinnerung **ein** Eintrag an die Person (Text, `tag = termin:{id}`, `url = /chats/{Einzelchat}`, `kind = event`); Chat stumm → keiner, aber die Karte steht; Push-Schalter aus → keiner; Vorschau aus → „Erinnerung an einen Termin“ ohne Titel; **kein** `notify_new_message`-Eintrag (stumme Karte); `event.updated` an die Teilnehmer **einmal** je Termin und Durchgang. |
| R13 | `der_mindestabstand_haelt_bei_jeder_aenderung` | Folgen aus Durchgängen und Einstellungswechseln (Abstand verkürzen/verlängern, aus/an, Anzahl ändern, Absage/Wiederaufnahme): Zwischen zwei Zeilen derselben Person liegen immer ≥ 12 h; Änderungen lösen keine sofortige Erinnerung aus. |
| R14 | `die_gemeinsamen_faelle_aus_der_datei` | `packages/shared/src/testdaten/erinnern.json` (per `include_str!`): Fälle (Beginn nach h, ganztägig, Serie, Abstand, Anzahl → erwartete Anzahl, u. a. Randfälle Beginn−2 h inklusive, 20 h vor Beginn bei 24 h Abstand → 0, `null` → 10, ganztägig). Durchgänge zu den Fälligkeitszeitpunkten, gezählt wird die Zahl der Karten. **Derselbe Satz Fälle** prüft W2 in TypeScript. |
| R15 | `konto_loeschen_nimmt_die_zeilen_mit` | Konto der erinnerten Person gelöscht → Zeilen weg (Cascade), keine Waisen; Konto des Erstellers gelöscht → keine Erinnerung mehr, kein Fehler im Durchgang. |
| R16 | `rueckwaertsvertraeglich` | Termine ohne `erinnern` (alte Anfragen, Umfrage, Terminfindung) verhalten sich wie vorher; ein Durchgang über eine Datenbank ohne eingeschaltete Termine beansprucht nichts und stört `tests/einladen*.rs` nicht (laufen unverändert grün). |
| R17 | `erinnern_einmal_laeuft_gegen_ein_schema` | `std::process::Command` mit `CARGO_BIN_EXE_erinnern_einmal`, `DATABASE_URL` mit `options[search_path]=<Testschema>` (sqlx 0.8.6 liest das, `options/parse.rs:92-103`): `--plus-stunden 24` → JSON-Zeile mit `beansprucht: 2`, die Karten stehen im Schema; falsche Argumente → Exit-Code 2 und Hilfetext. |
| M1 | `tests/erinnern_migration.rs` (eigenes Schema wie `einladen_migration.rs`) | Migrationen bis 0023, Altbestand (Termine mit und ohne Teilnehmer), dann 0024 – **zweimal**: Spalten leer (aus), Tabelle da, nichts zurückgefüllt, zweiter Lauf ändert nichts; die Prüfbedingung lehnt halbe Zustände ab (`anzahl` ohne `nach_std`; `nach_std` ohne `seit`); Cascade: Teilnehmerzeile löschen nimmt die Zeilen mit. |

### 9.4 Web – Einheit (vitest, `node`)

| ID | Datei | Prüft |
|---|---|---|
| W1 | `modules/calendar/erinnern.test.ts` | `fristText`/`anzahlText`/`erinnernText` (Einzahl/Mehrzahl, Dativ, Woche, 36 Stunden, 30 Tage, `null`); `erinnernPruefen` (Grenzen, nicht ganzzahlig, leer); Vorgaben und Erkennung nicht-voreingestellter Werte; `erinnernBody`: unverändert → **kein** Feld, geändert → Feld, ausgeschaltet → `null`, neu angelegt und aus → kein Feld; `wirkungsHinweis`-Texte (keine passt / N passen / Serie / ganztägig). |
| W2 | `packages/shared/src/erinnern.test.ts` | `erinnerungenBisBeginn` gegen `testdaten/erinnern.json` (**dieselben Fälle wie R14**); `erinnernSchema` (Grenzen, `null`); `createEventSchema` nimmt `erinnern` an/ab; **Gleichlauf der Zahlen** mit `constants.rs` (`ERINNERN_NACH_STD_MIN/MAX`, `ERINNERN_ANZAHL_MAX`, `ERINNERN_RESERVE_STD`) – wie die Listen in `shared.test.ts`, die Rust-Datei wird gelesen. |
| W3 | `modules/calendar/erinnern.test.ts` | `erinnerungsZeile`: Empfänger offen / hat geantwortet / Ersteller; Termin abgesagt; mit/ohne Namen. |
| W4 | `packages/shared/src/shared.test.ts` (Ergänzung) | `messagePreview`: `event` mit `metadata.erinnerung` → „🔔 Erinnerung“, `event` ohne → „📅 Termin“; der vorhandene Gleichlauftest mit `constants.rs` bleibt grün. |
| W5 | `state/chat.termine.test.ts` (Ergänzung) | Eine Karte mit `metadata.erinnerung` wird von `terminAbgleichen`/`terminEntfernt` wie eine Einladungskarte nachgeführt (Zusage in einem Chat → `event` in beiden Karten); gelöschte Erinnerung bleibt gelöscht. |

### 9.5 Browser (Playwright, `apps/web/e2e/erinnern.spec.ts`)

Welt aus `einladenWelt.ts`: **A** (Ersteller), **B, C, D** (mit A in Gruppenchat G), **E** (fremd). Hilfsfunktion `erinnernEinmal(plusStunden)` ruft `erinnern_einmal`. Jeder Test baut seine eigene Welt.

| ID | Test | Schritte und Erwartung |
|---|---|---|
| B1 | `Vorgabe aus, einschalten, Hinweise, Speichern, Detailansicht` | A öffnet „Neuer Termin“: Block „Erinnerung bei offener Antwort“ **aus**, Optionen nicht sichtbar; ohne gewählte Personen gesperrt mit Hinweis; B, C wählen → Schalter frei; einschalten → „2 Tage“ und „Dreimal“ gewählt, Zusammenfassung „nach 2 Tagen … bis zu 3-mal“; „Eigene Dauer“ 11 → Fehlertext und Speichern gesperrt, 12 → ok; Termin in 20 h und „1 Tag“ → Hinweis „… keine Erinnerung“; Termin in 10 Tagen → „Bis zum Beginn passen 3 Erinnerungen“; speichern. Bs Detailseite zeigt „🔔 Erinnerungen an Ausstehende: nach 2 Tagen, bis zu 3-mal“, **ohne** Zähler-Block; As Detailseite zeigt den Block. |
| B2 | `Die Erinnerung kommt live im Einzelchat als Karte, die Antwort beendet sie` | Termin über die API (24 h, dreimal, B und C eingeladen). B und C haben ihren Einzelchat mit A **offen**, A die Chatliste. `erinnernEinmal(25)` → in Bs Browser erscheint **live** eine Karte mit Kopfzeile „Automatische Erinnerung“, Text „Du hast noch nicht auf „…“ geantwortet.“ und **den drei Antwortknöpfen**; in **G** erscheint **nichts**; As Chatliste zeigt „🔔 Erinnerung“ **ohne** „Du:“; A öffnet AB: dieselbe Karte als „Automatische Erinnerung an B“. B tippt „Ja“ **in der Erinnerung**: die Einladungskarte in AB, die Karte in G und die Erinnerung zeigen alle „zugesagt“ (synchron); die Kopfzeile sagt „Deine Antwort: Zugesagt.“ `erinnernEinmal(49)`: **C** bekommt die zweite, **B** keine. `erinnernEinmal(73)`: C die dritte. `erinnernEinmal(97)`: keine (Anzahl). Die Antwortzahlen in den JSON-Zeilen stimmen (`zugestellt` 2, 1, 1, 0). |
| B3 | `Zähler und „nicht erinnerbar“ in der Detailansicht des Erstellers` | Termin mit Einzelchats **aus** für D, mit Einzelchats für B: nach einem Lauf zeigt As Detailseite „B: 1 von 3 gesendet“ (live, ohne Neuladen – `melde_termin`) und „Nicht erinnerbar: D – kein Einzelchat mit der Einladung“; B sieht den Block nicht. |
| B4 | `Absagen stoppt, Wiederaufnehmen startet neu, Löschen räumt auf` | A sagt den Termin ab → Lauf → nichts; Wiederaufnehmen → Lauf bei `+Frist−1h` nichts; löschen → die Erinnerungskarte in Bs Chat steht als „Diese Nachricht wurde gelöscht“. |
| B5 | `Bearbeiten: Änderung startet die Uhr neu, ohne Änderung nicht` | A ändert nur den Titel → `erinnern_seit` unverändert (`GET …/erinnerungen` bzw. DTO; gleich viele Läufe); A ändert den Abstand → ein Lauf bei der alten Fälligkeit liefert **nichts** mehr. |
| B6 | `375 Pixel, Tastatur, Screenreader-Namen` | Viewport 375×812: `scrollWidth ≤ 375` im Blatt, in der Erinnerungskarte und im Detailblock; jede Option/jeder Schalter ≥ 44 px hoch; Bedienung **nur** mit Tastatur (Leertaste am Schalter, Pfeile in der Optionsgruppe, Zahlenfeld); `getByRole('group', { name: 'Erste Erinnerung nach' })`, `getByRole('radio', { name: '2 Tage' })`, `getByRole('switch', { name: 'Ausstehende erinnern' })`, `getByRole('status')` mit der Zusammenfassung. |
| B7 | `Regression: Einladen und die übrigen Karten laufen unverändert` | `e2e/einladen.spec.ts`, `termine.spec.ts`, `events.spec.ts` laufen grün (Block im Editor ändert nichts an Einladen, Speichern, Absagen). |

Laufanweisung (wie im Auftrag): `cargo build --bin erinnern_einmal`, API neu starten (`api-neu.sh`), Dev-Server neu starten (`vite-neu.sh … 5183`), dann
`npx playwright test -c …/pw/pw-main.config.ts e2e/erinnern.spec.ts`. Der **Push** lässt sich im Browser nicht prüfen (Entwicklungsbetrieb ohne VAPID); dafür stehen U4 und R12.

---

## 10. g) Abnahmekriterien (jedes mit einem Test)

| # | Kriterium | Test |
|---|---|---|
| AK1 | **Vorgabe aus:** Ohne Einstellung wird nie erinnert – Bestandstermine bleiben nach der Migration stumm. | R1, R16, M1, B1 |
| AK2 | Der Ersteller stellt je Termin **aus/an**, den **Abstand** (Vorgaben 1 Tag, 2 Tage, 3 Tage, 1 Woche oder eigene Stunden) und die **Anzahl** (einmal, zweimal, dreimal, 5-mal, bis zum Termin) ein – beim Anlegen und Bearbeiten; die Einstellung steht im Termin und in der Detailansicht **für alle Teilnehmer**. | R10, B1, W1 |
| AK3 | **Grenzen und Validierung:** Abstand 12 h–720 h, Anzahl 1–10 (bis zum Termin gedeckelt auf 10), Abstimmung abgelehnt, nur Ersteller, deutsche Texte – im Server **und** in der Oberfläche; die Zahlen stehen in beiden Sprachen gleich. | U1, R10, W1, W2, B1 |
| AK4 | Die erste Erinnerung kommt **nach dem Abstand**, nicht vorher; zwischen zwei Erinnerungen derselben Person liegen immer **mindestens 12 Stunden**, auch nach Änderungen. | R1, R13 |
| AK5 | Die Erinnerungen folgen **im gleichen Abstand**; die **Anzahl** wird nicht überschritten; „bis zum Termin“ hört bei 10 auf. | R2, R14 |
| AK6 | **Kurz vor dem Beginn, kurz nach dem Beginn, in weniger als dem Abstand, ganztägig und bei Serien** verhält sich der Server wie festgelegt (Reserve 2 h inklusive Grenze; erster Termin der Serie; ganztägig −12 h); die Oberfläche **sagt es vor dem Speichern**. | R3 d, R14, W1, W2, B1 |
| AK7 | Das Erinnern **endet** bei Antwort (auch „Vielleicht“), Ausladen, Löschen, Absage, Beginn, erreichter Anzahl; **Wiederaufnahme** und jede Änderung der Einstellung starten die Uhr neu, ohne sofortige Welle. | R3, R13, B4, B5 |
| AK8 | Erinnert wird **nur im Einzelchat**, **nur an Ausstehende**, **nur dort, wo die Einzelkarte ankam**, nie im Gruppenchat, nie den Ersteller; der Dienst legt **keinen Einzelchat** an. | R4, B2 |
| AK9 | **Kein Doppelanspruch:** Mehrere gleichzeitige Durchgänge (mehrere Instanzen) und Wiederholungen mit derselben Zeit senden jede Erinnerung **genau einmal**. | R5, R6 |
| AK10 | **Nachholen:** Nach längerem Stillstand höchstens **eine** Erinnerung je Person und Durchgang; mehrere fällige Termine einer Person kommen in getrennten Durchgängen; nie nach dem Beginn. | R6, R7 |
| AK11 | **Eine kaputte Zeile hält den Dienst nicht an**; offene Zeilen werden höchstens dreimal nachgeholt; Beanspruchtes, das nicht mehr gilt, wird zurückgenommen. | R8, R9 |
| AK12 | Die Erinnerung ist eine **stumme `event`-Karte mit Zusatz**, Absender Ersteller, Text „Erinnerung: Du hast noch nicht auf „X“ geantwortet.“, und es geht **genau eine Mitteilung** je Erinnerung hinaus (Stummschaltung, Push-Schalter und Vorschau der Person gelten). | U2, U4, R1, R12 |
| AK13 | **Darstellung:** Die Karte trägt die Kopfzeile „Automatische Erinnerung“ (je Betrachter und Zustand), zeigt Zu-/Absage-Knöpfe, **die Antwort in ihr gilt in allen Karten, live**; die Chatliste zeigt „🔔 Erinnerung“ ohne „Du:“. | W3, W4, W5, B2 |
| AK14 | **Aufräumen:** Ausladen und Löschen entfernen die Erinnerungskarten; eine Wiedereinladung beginnt bei null und bekommt die gelöschte Nachricht nicht zurück. | R11, B4 |
| AK15 | Der Ersteller sieht in der Detailansicht **wie viele Erinnerungen je Person gesendet** wurden (live) und **wer nicht erinnert werden kann**; Teilnehmer sehen keine Zähler. | R10, B3 |
| AK16 | **Konfiguration und Start:** `ERINNERN_TAKT_S` (Vorgabe 300, 0 = aus, 30–3600 geklemmt); der Dienst startet nach den Migrationen und läuft je Instanz; eine Panik beendet nur den Durchgang. | U3, R16 |
| AK17 | Die **Migration 0024 ist idempotent**, füllt nichts zurück, hält die Prüfbedingung und räumt per Cascade auf. | M1 |
| AK18 | **Auslösen ohne Hintertür:** `erinnern_einmal` läuft gegen ein Schema, ist kein Teil des Produktionsabbilds und hat keinen HTTP-Weg. | R17, B2 |
| AK19 | **Client und Server rechnen dasselbe** („Bis zum Beginn passen N Erinnerungen“ = tatsächlich gesendete Zahl). | R14, W2 |
| AK20 | **Bedienbarkeit:** nur Tastatur, Namen für Screenreader, Live-Zusammenfassung, 375 px ohne seitliches Scrollen, Tippflächen ≥ 44 px. | B6 |
| AK21 | **Datenschutz:** Erinnerungen stehen nur im Einzelchat der beiden; Zähler nur für den Ersteller; keine Titel im Protokoll und nicht in der Mitteilung ohne Vorschau; Konto-Löschung nimmt die Zeilen mit. | R4, R10, R12, R15, U4 |
| AK22 | **Rückwärtsverträglich:** Anfragen und Termine ohne `erinnern` verhalten sich wie vorher; ältere Clients rendern die Karte (mit Text im Absatz); das Einladen läuft unverändert. | R16, B7, `tests/einladen*.rs` |

---

## 11. h) Verworfene Alternativen

| Alternative | Warum verworfen |
|---|---|
| **Zähler und Zeitstempel als Spalten an `event_attendees`** (`erinnert_anzahl`, `zuletzt_erinnert_am`), Beanspruchen per `update … where erinnert_anzahl = $alt returning` | Funktioniert atomar, aber: kein Platz für **welche Nachricht** (Aufräumen beim Ausladen/Löschen müsste Nachrichten über `metadata` suchen – `messages` hat dafür keinen Index), keine Kennung für die Idempotenz der Nachricht (nach einer Wiedereinladung zeigte ein Schlüssel `…:{n}` auf die gelöschte Karte), die „Neuzählung bei Wiedereinladung“ müsste von Hand geschrieben werden (hier gratis per Cascade). Preis der Tabelle: ein lateraler Zähler je Kandidat – gemessen 34 ms bei 6000 Kandidaten. |
| **Nur über einen festen `client_id` absichern („erst senden, dann buchen“)** (Vorschlag in `bestand-erinnern.md`) | Beide Instanzen senden; die zweite scheitert am Eindeutigkeits-Index – ein **Fehlerweg im Normalfall**, kein Beanspruchen, und die Mitteilung käme von beiden. Der Schlüssel `…:{Nummer}` ist nach einer Wiedereinladung falsch. Hier: Beanspruchen **vor** dem Senden, Schlüssel = Kennung der Zeile. |
| **`for update skip locked` in einer Transaktion um Auswahl, Senden und Buchen** | `create_message` nutzt den Pool, ist der Einstieg für Rundruf und Push und **nicht transaktionsfähig** (Begründung wie beim Einladen); die Sperre hielte Zeile und Verbindung über das Senden, ein Absturz zwischen Senden und Festschreiben lässt die Nachricht draussen und die Zeile frei – **doppelt** beim nächsten Mal. |
| **Anführer-Wahl / `pg_advisory_lock`** („nur eine Instanz läuft“) | Zusätzlicher Zustand, Ausfallfragen (wer übernimmt, wenn der Anführer hängt?), und es ginge um dieselbe Sicherheit, die der Schlüssel schon gibt. Jede Instanz darf laufen. |
| **Vorberechnete `naechste_erinnerung_am` je Person** (einfacher Bereichsindex) | Müsste an **jeder** Stelle gepflegt werden, die Teilnehmer anlegt (`anlegen`, `aendern_vorbereiten`, `confirm_event`, Migration, `seed`) und bei jeder Änderung der Einstellung alle Zeilen umschreiben. Eine vergessene Stelle heisst „wird nie erinnert“, ohne Fehler. Aus Ankern gerechnet (`eingeladen_am`, `erinnern_seit`, jüngste Erinnerung) ist es wartungsfrei und folgt jeder Einstellung sofort. |
| **Neue Nachrichtenart `event_reminder`** | Sechs Stellen (beide `MESSAGE_TYPES`, beide Vorschauen, Sendeverbot, Expander, Trichter, Registry) und die Synchronität der Karte, die die `event`-Art **umsonst** liefert, müsste nachgebaut werden; ältere Clients zeigten ohne Zusatz nur Text. Gewinn nur eine eigene Vorschau – die ein Zweig in `messagePreview` ebenso gibt. |
| **`system`-Nachricht mit `kind: "event.reminder"`** (Vorschlag in `bestand-erinnern.md` Abschnitt 6.10) | Eine Systemnachricht ist eine stille Zeile ohne Karte: kein Termin hydriert (`EventExpander` nimmt nur `event`), keine Knöpfe, kein Datum und Ort. Mit Erweiterung müsste `SystemBubble` (Modul Nachrichten) die Termin-Karte des Kalender-Moduls einbinden – ein Bruch der Modulgrenze. Auch sie trüge übrigens den **Handelnden** als Absender. |
| **Absenderlose Nachricht** (`sender_id` leer) | Gilt im Web als „meine“, zählt für **alle** als ungelesen und entgeht dem Idempotenz-Index (NULL ist nie gleich NULL). |
| **Eigenes „Initiative“-Konto als Absender** | Neue Konto-Art, ein Einzelchat zu **jedem** Nutzer, Berechtigungen, Anmeldung – und widerspräche „im Einzelchat mit dem Ersteller“. |
| **Text im Namen des Erstellers (`type: text`)** | Unterschiebung: Der Empfänger hielte „Du hast noch nicht geantwortet“ für eine Mitteilung des Erstellers. |
| **Mitteilungstitel = Name des Erstellers** | Wie oben: eine automatische Mitteilung trüge ein Gesicht. Titel „Initiative“. |
| **Erinnern in den Gruppenchat** | Nicht gewollt (Auftrag: nur Einzelchats) und Dauerbelästigung aller. |
| **Der Dienst legt fehlende Einzelchats an** | Der Ersteller hat beim Einladen „Einzelchats“ **abgewählt**; der Dienst setzte sich darüber hinweg und erzeugte Chats bei Personen, die der Ersteller nicht angeschrieben haben wollte. Stattdessen: Hinweis beim Ersteller („Nicht erinnerbar: …“). |
| **Feste Erinnerungszeiten („um 18 Uhr“) und Ruhezeiten** | Der Server kennt keine Zeitzone (kein Profilfeld). Abstände sind Dauern; Vielfache von 24 h landen zur Tageszeit der Einladung. Folgearbeit: Zeitzone im Profil. |
| **„Nächste Wiederholung“ als Bezug bei Serien** | `expand_occurrences` rechnet höchstens 500 Schritte ab Serienbeginn: bei einer alten täglichen Serie fände sie keinen Termin; die Antwort gilt serienweit; „vor jeder Wiederholung erneut“ wäre Dauerbelästigung. |
| **Zählung beim Ausschalten/Einschalten zurücksetzen** | Die Obergrenze liesse sich durch Umschalten umgehen. |
| **„Vielleicht“ weiter erinnern** | Es ist eine Antwort; sonst bliebe dem Unentschlossenen nur das Austragen. Ein eigener „Nicht mehr erinnern“-Knopf wäre eine Folgearbeit, falls „Vielleicht“ nicht reicht. |
| **Reserve 0 (auch kurz vor Beginn erinnern)** | Lärm: Eine Bitte um Antwort zwei Stunden vor dem Beginn hilft der Planung nicht mehr. |
| **Eine Sammelnachricht je Person („noch bei 3 Terminen offen“)** | Ein Dienstschritt mehr (Gruppieren, Text, Karte mit mehreren Terminen), die Synchronität der Einzelkarte ginge verloren. Stattdessen: höchstens eine Erinnerung je Person und Durchgang. |
| **Takt 60 s** | Unnötig oft für Fristen in Stunden; ein Rückstau würde enger gestaut. 300 s. |
| **HTTP-Testroute `POST /test/erinnern` hinter der Konfiguration** | Sie wäre in der **Produktions-Binary**; `NODE_ENV` ist standardmässig `development` (`config.rs:306`), eine vergessene Variable machte sie scharf. Ein eigenes Programm ist **nicht im Abbild**. |
| **Uhr des Servers per Umgebungswert verschieben** (`ERINNERN_ZEIT_VERSATZ`) | Wirkte auf den laufenden Dienst der Entwicklungs-API und könnte in Produktion versehentlich gesetzt sein. |
| **Browser-Test schiebt Zeilen per SQL in die Vergangenheit** | Playwright hat im Bestand keinen Datenbankzugang (`git grep` in `e2e` findet kein `pg`/`psql`); die Tests dürften Schemawissen kopieren, und der Dienst selbst bliebe ungeprüft. |
| **Einstellung je Person oder Gruppe von Personen** | Nicht gefordert („je Termin“); Mehraufwand in Datenmodell und Oberfläche. |
| **Schaltflächen „Erinnerung abschalten“ für den Empfänger** | Vorerst gedeckt durch „Vielleicht“, Stummschalten, Austragen; als Folgearbeit vermerkt. |
| **`Erinnerungen` des Alarms vor dem Termin (`reminder_minutes`) mitliefern** | Andere Funktion (für alle gleich, bezogen auf den Beginn); eigener Auftrag, der auf denselben Dienst aufsetzen kann (Risiko 8). |

---

## 12. Umsetzungsreihenfolge, Schnitte und Dateien

**Paket 1 – Dienst und Daten (Rust).** Migration 0024; `constants.rs`; `db.rs` (`CalendarEventRow` +3 Felder; Fixture in `services/calendar.rs` `tests` nachziehen); `config.rs` (`erinnern_takt_s`); `services/erinnern.rs` (Beanspruchen, Zustellen, Nachholen, Bilanz, `starten`); `NewMessage::erinnerung`; `main.rs`; `src/bin/erinnern_einmal.rs`; Tests U2, U3, R1–R9, R13, R14, R16, R17, M1 (die Einstellung wird in diesem Schnitt von den Tests per SQL gesetzt). *Commit:* „Erinnern: der Dienst beansprucht fällige Erinnerungen atomar und stellt sie in den Einzelchats zu“.
**Paket 2 – Einstellung, Aufräumen, Mitteilung (Rust).** `dto.rs` (`ErinnernDto`, `ErinnernStandDto`, `CalendarEventDto.erinnern`); `modules/calendar.rs` (Eingabe, `erinnern::pruefen`, Rechte, `PATCH`-Vergleich und `erinnern_seit`, `GET …/erinnerungen`); `services/calendar.rs` (`NewEvent.erinnern`, Einfügung, `to_event_dto`); `services/einladen.rs` (`aendern_vorbereiten`, `termin_loeschen` räumen Erinnerungskarten ab; `nachrichten_loeschen` wird `pub(super)`); `services/notify.rs` (`benachrichtige_erinnerungen`); `melde_termin` je Durchgang; alle `NewEvent`-Aufrufer (`polls.rs`, `create_planning`, `seed.rs`) mit `erinnern: None`; Tests U1, U4, R10, R11, R12, R15. *Commit:* „Erinnern: Einstellung am Termin, Aufräumen mit der Einladung, eine Mitteilung je Erinnerung“.
**Paket 3 – Gemeinsames Paket.** Typen, Schema, `LIMITS`, `util/erinnern.ts`, `testdaten/erinnern.json`, `messagePreview`, `MessageMetadata.erinnerung`; Tests W2, W4. *Commit:* „Gemeinsames Paket: Erinnern – Typen, Grenzen und Vorschau-Rechnung“.
**Paket 4 – Oberfläche.** `erinnern.ts` (+ W1, W3), `ErinnernWahl.tsx`, `ErinnernStand.tsx`, `EventEditor.tsx`, `EventDetailScreen.tsx`, `EventBubble.tsx`, `ChatListScreen.tsx`, `lib/api.ts`, `styles.css`; W5; Playwright B1–B7. *Commit:* „Termine: Erinnerung bei offener Antwort einstellen, sehen und in den Einzelchats lesen“.
**Paket 5 – Doku.** `docs/API.md` (Feld, Route, Nachrichten-Zusatz), `docs/FEATURES.md` (Erinnern; Hinweis, dass „Erinnerungen pro Termin“ der Kalender-App gehören), `docs/DEPLOYMENT.md` (`ERINNERN_TAKT_S`, mehrere Instanzen, Migration 0024, `erinnern_einmal` nur für Entwicklung), `docs/SICHERHEIT.md` (3c: Erinnerungen), `.env.example`. *Commit:* „Doku: Erinnern, Takt und Datenschutz“.

Jeder Schnitt besteht für sich: `cargo clippy --all-targets -- -D warnings`, `cargo test` (die betroffenen Dateien, plus `tests/einladen*.rs` als Regression), `npx tsc -p tsconfig.json --noEmit`, `prettier --check`, die betroffenen vitest-Dateien. Die Pakete 1 und 2 ändern das Verhalten **nur** für Termine **mit** Einstellung; Paket 4 schaltet die Oberfläche auf.

Weitere anzupassende Stellen: `apps/api/src/services/mod.rs` (Modul `erinnern`), `apps/api/src/lib.rs` (falls die Module dort aufgelistet sind), `apps/api/src/state.rs` unverändert (der Dienst bekommt `AppState` als Klon, wie `spawn_realtime_listener`).

---

## 13. Risiken und offene Punkte

1. **Absender ist der Ersteller, die Nachricht kommt von der App.** Die Kennzeichnung steht in der Karte (Kopfzeile je Betrachter und Zustand, `role="note"`); der Text wird **nicht** als Wort des Erstellers gespeichert, sondern von der Oberfläche formuliert. Ältere App-Stände zeigen den Rückfalltext im Absatz der Karte – ohne Kopfzeile, aber mit „Erinnerung: …“. Wer das für zu nah an einer Person hält, braucht ein App-Konto (Alternative verworfen, Abschnitt 11).
2. **Belästigung.** Begrenzt (≥ 12 h, ≤ 10, jede Antwort beendet, Stummschalten, Austragen), aber der Ersteller bestimmt, **dass** erinnert wird. Es gibt keinen „nicht mehr erinnern“-Knopf für den Empfänger – „Vielleicht“ ist der Ausweg und steht auf der Karte. Offen: ob das reicht.
3. **Nur wo die Einzelkarte ankam.** Wer beim Einladen „Einzelchats“ abgewählt hat, wird nie erinnert; der Ersteller sieht es in der Detailansicht. Gewollt, aber ein häufiger Fall könnte überraschen (z. B. „Alle aus der Gruppe“ mit Einzelchats aus).
4. **Laufende Serien.** Wer zu einer Serie eingeladen wird, deren erster Termin vorbei ist, wird nie erinnert (3.2). Eine „ab nächster Wiederholung“-Regel setzte eine verlässliche Rechnung der nächsten Wiederholung voraus (`expand_occurrences` hat 500 Schritte; Folgearbeit an `recurrence.rs`).
5. **Fenster beim Senden.** Ein Absturz **zwischen** Anlegen der Nachricht und Eintragen der `message_id` hinterlässt eine offene Zeile; das Nachholen findet die Nachricht wieder (fester Schlüssel, kein Duplikat), aber ohne Rundruf (die Karte erscheint beim nächsten Laden) und mit möglichem zweiten oder ausbleibendem Push. Ein Absturz **vor** dem Anlegen verliert nichts: nachgeholt.
6. **Zeit.** `jetzt` im Betrieb kommt aus der Datenbank (alle Instanzen gleich). Sommerzeit spielt keine Rolle (Dauern in Stunden). Die Fälligkeit rechnet ab der tatsächlichen Beanspruchung, nicht ab der geplanten: Pro Erinnerung ein Verzug bis zum Takt (≤ 5 min); bei 10 Erinnerungen höchstens 50 Minuten Drift – unerheblich.
7. **Tageszeit.** Ohne Zeitzone gibt es keine Ruhezeiten: Eine Erinnerung nach 12 oder 36 Stunden kann nachts eintreffen (Push-Mitteilungen sind am Gerät stummschaltbar; „Nicht stören“ gilt). Vielfache von 24 h treffen die Tageszeit der Einladung; die Oberfläche sagt es. Folgearbeit: Zeitzone im Profil, Ruhezeiten.
8. **Der Alarm vor dem Termin (`reminder_minutes`) bleibt unausgeliefert** (`bestand-erinnern.md` Abschnitt 2): Nur die `.ics`-Ausgabe liest ihn; `docs/FEATURES.md:707` und `README.md:74` versprechen mehr. Der Dienst hier ist die Grundlage; „vor dem Termin erinnern“ wäre eine zweite Art von Erinnerung auf demselben Dienst (eigener Auftrag). Empfehlung: bis dahin die Beschriftung im Editor auf „Erinnerung vor dem Termin (Kalender-App)“ ändern, damit sie nicht mit der neuen Funktion verwechselt wird (8.2).
9. **Merge-Konflikte** mit „Ort als Adresse“ (Ortsfeld in `EventEditor.tsx`, Anzeige in `EventBubble.tsx`/`EventDetailScreen.tsx`) und „Sammlung verknüpfen“ (`EventCollection.tsx`, `EventEditor`): Der Entwurf hält seine Änderungen im Editor auf **einen zusammenhängenden Block** (State, ein Feld im `body`, ein Element im JSX), in `EventBubble.tsx` auf einen **Zweig** über der Karte, in `EventDetailScreen.tsx` auf zwei **eingefügte** Elemente. Vor dem Zusammenführen diese drei Dateien zuerst abgleichen.
10. **Mehrere Instanzen im Leerlauf:** Jede Instanz fragt jeden Takt (eine kleine Abfrage über den Teilindex). Bei 2 Instanzen und 300 s ist das nicht messbar; wer es abstellen will, setzt `ERINNERN_TAKT_S=0` auf allen bis auf eine – sicher ist es so oder so.
11. **Rundruf je Welle:** `melde_termin` je betroffenem Termin und Durchgang erhöht `stand` und sendet die Termin-Fassung an **alle** Teilnehmer (bis 200). Das ist die Last einer Zusage, aber periodisch; die Stückelung des Bus aus dem Einladen trägt es. Alternative, falls es stört: Der Dienst meldet nur, wenn der Ersteller die Detailseite offen hat – das weiss der Server nicht; also bleibt der Rundruf.
12. **Tests auf der geteilten Entwicklungsdatenbank:** Ein Schema je Test (Migrationen ≈ 24 Dateien je Test: Sekunden). Das Schema wird zu Beginn verworfen und neu angelegt (nicht am Ende), damit ein abgebrochener Lauf nichts hinterlässt – wie `auslagern.rs`. Die vielen Testschemata sammeln sich in der Entwicklungsdatenbank (bereits heute `kaltprobe_*`, `aktionprobe_*`); der Name hängt am Testnamen, nicht an einer Zufallszahl.
13. **Das Programm `erinnern_einmal` braucht eine gebaute Binary und Datenbankzugang** im Browser-Test; im CI ein Schritt `cargo build --bin erinnern_einmal`. Der Test sagt es verständlich, wenn sie fehlt.
14. **Was dieser Entwurf bewusst nicht tut:** Erinnern **vor** dem Termin (Alarm), Ruhezeiten, Erinnern in Gruppenchats, Anlegen fehlender Einzelchats, Sammelnachrichten, Einstellung je Person, „Nicht mehr erinnern“ für den Empfänger, Erinnern bei laufenden Serien.

### Offene Entscheidungen für den Auftraggeber (mit Empfehlung)

* **Reserve vor dem Beginn: 2 Stunden** und **Mindestabstand 12 Stunden** – Zahlen, die sich ändern lassen (`constants.rs`, `LIMITS`, ein Test). Empfehlung: so lassen.
* **„Vielleicht“ beendet das Erinnern.** Empfehlung: ja (Abschnitt 3.2).
* **Bezug bei Serien: erster Termin.** Empfehlung: ja; Folgearbeit an `recurrence.rs`, wenn laufende Serien wichtig werden.
* **Kennzeichnung statt Konto:** Empfehlung wie entworfen (Karte mit Kopfzeile „Automatische Erinnerung“).
* **Beschriftung des bestehenden Blocks „Erinnerungen“** in „Erinnerung vor dem Termin“ ändern? Empfehlung: ja, im Paket 4.
* **Takt 300 s.** Empfehlung: so lassen; über `ERINNERN_TAKT_S` einstellbar.

---

## 14. Was erprobt wurde

Alles in einem **Wegwerf-Schema** `erinn_probe` der Entwicklungsdatenbank (Postgres 16.13; `public` unberührt; Schema jeweils wieder entfernt, `\dn` zeigt keines mehr).

* **Migration zweimal** (`probe-0024.sql`): Beim zweiten Lauf nur „already exists, skipping“-Hinweise, keine Fehler; `\d event_erinnerungen` und `\d calendar_events` zeigen Spalten, Prüfbedingungen (auch `calendar_events_erinnern_check`), Fremdschlüssel (Cascade auf `event_attendees`) und Indizes wie in Abschnitt 4.
* **Die Abfrage der Fälligen** (`anspruch.sql`, Szenario 24 h/3-mal, offen B und C, D hat zugesagt, E offen ohne Einzelkarte): bei `T0+23h` 0 Zeilen; bei `+24h` B und C (Nummer 1), **E nicht**; derselbe Durchgang noch einmal 0 Zeilen; `+48h` Nummer 2; nachdem C `yes` gesetzt hat, bei `+72h` nur B (Nummer 3); bei `+96h` keine (Anzahl 3 erreicht). Endstand der Tabelle: B 1, 2, 3 – C 1, 2.
* **Gleichzeitiger Anspruch** (`parallel-lauf.sh`, zwei `psql`-Sitzungen, die erste hält die Transaktion 3 s offen, die zweite startet 1 s später): Sitzung 1 beansprucht **20** Zeilen, Sitzung 2 **0**; in der Tabelle **20 Zeilen für 20 verschiedene Personen**.
* **Plan der Abfrage** (`plan.sql`, 200 000 Termine ohne Erinnerung, 300 mit Erinnerung, 6000 offene Personen, Einzelkarten und Mitgliedschaften): Der Teilindex `calendar_events_erinnern_idx` wird für die 300 gewählt (`Index Scan … rows=300`), die Einzelkarte über den Teil-Eindeutigkeits-Index, Mitgliedschaft über den Primärschlüssel; Ausführung **34 ms** für 6000 Kandidaten (die leere Tabelle `event_erinnerungen` wurde im Scratch-Schema noch sequentiell gelesen; im Betrieb greift `event_erinnerungen_nummer_idx`).
* **sqlx liest `options[search_path]` aus der URL** (`sqlx-postgres-0.8.6/src/options/parse.rs:92-103`) – Grundlage für R17.
* **Nicht erprobt (weil kein Code geschrieben wurde):** Rust-Übersetzung, Clippy, Web-Typen, Browser. Die Zuordnung der Stellen im Code (Abschnitte 1, 12) wurde durch Lesen belegt; die Aufrufer von `NewEvent` (`modules/calendar.rs` ×2, `modules/polls.rs`, `bin/seed.rs`) und die Fixture `services/calendar.rs` `tests::termin()` sind per `git grep` gezählt.
