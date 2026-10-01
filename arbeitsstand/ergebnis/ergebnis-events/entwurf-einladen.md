# Entwurf: Termine – Einladen (Thema 21)

Stand: Hauptbaum `/home/user/Initiative`, Zweig `claude/initiative-pwa-messenger-4b5ms6`, Ausgangspunkt `d786eab`.
Kein Produktivcode geändert. Grundlage: `bestand-einladen.md` (Belege S1–S13 dort) und das erneute Lesen des Codes.
Die Migration unten wurde in einem Wegwerf-Schema der Entwicklungsdatenbank erprobt (Abschnitt 3.3); Hilfsdateien liegen in
`ergebnis-events/entwurf/` (`0023_einladen.sql`, `probe-0023.sql`). Pfade relativ zum Repository, wenn nicht anders angegeben.

---

## 0. Kurzfassung: die Entscheidungen

| # | Frage | Entscheidung |
|---|---|---|
| 1 | Was heisst „verfügbar“? | **Kontakte**: Personen, die mit mir mindestens einen nicht archivierten Chat teilen (Gruppe oder Einzel), ohne mich. Abgeleitet **im Gerät** aus dem Chat-Speicher (`members[].user`), kein neuer Endpunkt. Das Suchfeld **filtert** diese Liste sofort; ab 2 Zeichen ergänzt es zusätzlich Treffer des Serververzeichnisses (`GET /users?q=`, unverändert) unter „Weitere Personen auf diesem Server“. |
| 2 | Sortierung/Laden | „Personen aus gemeinsamen Chats zuerst, dann alphabetisch“ ist mit Kontakten **von selbst erfüllt**: Die Liste enthält nur solche Personen; Verzeichnistreffer stehen darunter. Innerhalb der Kontakte alphabetisch (deutsche Sortierung, ohne Gross-/Kleinschreibung), **stabil** – Gewählte springen nicht nach oben. Darstellung in 100er-Schritten („Weitere anzeigen“), kein Nachladen vom Server. Umschalter „Alle · Gewählte“ zum Prüfen der Auswahl. |
| 3 | Wann gilt ein Gruppenchat als „gewählt“? | **Nur ausdrücklich**: über die Schnellwahl „Gruppenchat …“ oder den Vorschlags-Chip „Auch in Gruppe X posten“. **Nie automatisch.** „Alle“ wählt Personen, **keinen** Gruppenchat. |
| 4 | Wann kommt die Karte in den Gruppenchat? | Gruppenchat gewählt **und** Schalter „dort posten“ an **und** alle Mitglieder eingeladen. Die Oberfläche zeigt das live, der **Server erzwingt** es und meldet in der Antwort, was er ausgelassen hat (`ausgelassen`). |
| 5 | Einzelchats | Jede eingeladene Person bekommt eine Karte im Einzelchat mit dem Ersteller (auch wenn sie zusätzlich im Gruppenchat steht). Schalter „Einzelchats“ (Vorgabe an) und Hauptschalter „Einladung im Chat senden“ (Vorgabe an). Fehlt der Einzelchat, legt ihn der Server in **einer** Transaktion an. |
| 6 | Sichtbarkeit | **Nur Teilnehmerzeile (und Ersteller).** Die Chat-Mitgliedschaft gibt keinen Zugang mehr; ein Chat ist nur noch ein **Ort**, an dem eine Karte steht. Gilt für Liste, Detail, Zusage, Notizen, Unterlagen, Ausgaben, Kalender-Abo, Datei-Zugriff, Rundruf. |
| 7 | Datenmodell | Neue Tabelle `event_placements` (eine Zeile je Karte: Termin, Chat, Nachricht, Art `gruppe`/`einzel`, Person), `event_attendees.eingeladen_am`, `calendar_events.stand` + `client_id`. Migration **0023**, erprobt und idempotent. |
| 8 | Person entfernen | Zugang endet sofort. Ihre **Einzelkarte wird gelöscht**. Eine **Gruppenkarte bleibt** (sonst verlören die anderen ihre einzige Karte) und zeigt jedem Nicht-Eingeladenen nur „Termin nicht verfügbar“ (Server entfernt `event` **und** `metadata.eventId` aus der Fassung für ihn). |
| 9 | Löschen / Absagen | **Löschen** = Termin und **alle Karten** weg (Nachrichten als gelöscht markiert, wie `unplace_poll`). **Absagen** (neu, `PATCH status: cancelled`) = Karten bleiben, zeigen „Abgesagt“, Zusagen gesperrt, eine Benachrichtigung je Person. |
| 10 | Keine doppelte Benachrichtigung | Alle Einladungskarten werden **stumm** angelegt (`silent: true`). Die Einladung löst **einen** Push je Person aus, über **einen** gewählten Chat: Einzelchat, sonst der erste Gruppenchat; ein stummgeschalteter Chat wird übersprungen, sind alle stumm, kommt keiner. |
| 11 | Synchron | Daten: eine Tabelle, schon synchron. Neu: ein **Trichter im Client** (`terminEreignisse`), der jeden Rundruf, jede REST-Antwort und jeden Hinweis nimmt und **alle** Karten in **allen** Chats im Speicher (und im IndexedDB-Cache) nachführt; dazu `stand` als Reihenfolge-Zähler. |
| 12 | Rückwärtsverträglich | Neues Feld `zustellung` im Anlegen/Ändern. **Fehlt es**, gilt das alte Verhalten Wort für Wort (`conversationId`, leere `attendeeIds` = alle aus dem Chat, eine Karte). Termin aus Umfrage und Terminfindung bleiben so. |
| 13 | Atomarität | Zwei Phasen: (1) **eine Transaktion** für Termin, Teilnehmer, Einzelchats, reservierte Karten-Zeilen; (2) Nachrichten nach dem Commit, je Karte idempotent. Scheitert Phase 2 teilweise, bleibt der Termin gültig, `zustellung.ausstehend` sagt es, `POST …/zustellung/nachliefern` holt nach. |
| 14 | Fremde Karten | `EventExpander` prüft den **Betrachter**; `POST /messages` mit `eventId` wird abgelehnt; `ausspielen` liefert Karten an Nicht-Eingeladene nur in gekürzter Fassung. |
| 15 | Abhängigkeiten | Keine neuen Crates, keine neuen npm-Pakete. `PersonenWahl` bleibt **unangetastet**; es entsteht eine neue Komponente. |

---

## 1. Ausgangslage und zusätzliche Funde

Der Bestand (`bestand-einladen.md`) ist richtig; beim Entwerfen sind sechs weitere Dinge aufgefallen, die der Entwurf mitlöst:

1. **Die Karte verrät mehr, als ihr Betrachter darf – auf zwei Wegen.**
   `hydrate_messages` (`services/messages.rs:65`) füllt `event` aus **jeder** Nachricht mit `metadata.eventId`, gleich welchen Typs, und `create_message`
   hydriert **für den Absender** und spielt genau diese Fassung an **alle** Empfänger aus (`ausspielen`, `:389`). Sitzt je ein Nicht-Eingeladener in einem Chat mit
   der Karte (Beitritt in der Sekunde des Sendens, freigegebener Altverlauf, eingeschleuste Karte, S12), bekommt er Titel, Ort und Teilnehmerliste – und über
   `metadata.eventId` die Kennung, mit der der **ohne Anmeldung** abrufbare `event.ics` (`modules/calendar.rs`, „Kennung als Berechtigung“) den ganzen Termin liefert.
2. **Der Rundruf bricht bei vielen Eingeladenen ab.** `RealtimeBus::publish` (`realtime/bus.rs:77`) macht bei `REALTIME_BUS=postgres` aus jeder Nutzlast über
   7000 Byte einen `sync.hint` **ohne Termin-Kennung**; der Client kennt für Termine keine Reaktion darauf (`state/chat.ts:556` lädt nur Chats). Ein Termin mit
   rund 70 Eingeladenen überschreitet die Grenze (Teilnehmerzeile ≈ 86 Byte, Kopf ≈ 650 Byte). Die Empfängerliste (`user_ids`, 39 Byte je Person) steht zusätzlich in
   demselben NOTIFY: Bei 180 Personen sprengt sie die 7000 Byte **allein**. Mit `REALTIME_BUS=memory` (Vorgabe in `docker-compose.yml`) tritt nichts davon auf; `koyeb.yaml` erlaubt aber zwei Instanzen.
3. **Keine Reihenfolge für Zusagen.** `rsvp` schreibt `event_attendees`, berührt aber `calendar_events.updated_at` nicht. Zwei fast gleichzeitige Antworten können
   ihre Rundrufe vertauscht ausliefern; die ältere Fassung überschreibt die neuere, bis zum nächsten Ereignis. Der Client hat keinen Zähler, an dem er das erkennt.
4. **`create_event` ist N Anweisungen** (`services/calendar.rs:229`: ein `insert` je Teilnehmer) **ohne Transaktion**. Bei 100 Eingeladenen sind das 100 Runden, und ein
   Abbruch mittendrin hinterlässt einen halben Termin.
5. **Der Editor holt jede Person einzeln** (`EventEditor.tsx:191`, `GET /users/:id`), obwohl `/users/batch` und `state/leute.ts` existieren und die Namen im Chat-Speicher stehen.
6. **Einzelchats haben keine Eindeutigkeit** (`find_direct_conversation`, `services/conversations.rs:398`: `limit 1` ohne `order by`; kein Unique-Index für das Paar).
   Zwei gleichzeitige Anlegevorgänge erzeugen zwei Chats – bei 100 Einladungen wird das wahrscheinlich.

Zur Prüfung „darf der Bestand einen Einzelchat anlegen?“ (Auftragspunkt): `POST /conversations` (`modules/conversations.rs:86-131`) erlaubt **jedem** angemeldeten Konto einen Direktchat mit **jedem
existierenden** Konto; geprüft wird nur „Person existiert“ und „nicht mit sich selbst“. Es gibt **keine Sperrliste** und **keinen deaktivierten Zustand** (`users` hat keine solche Spalte; `git grep -i
"gesperrt\|blocked\|deactivated"` findet nur „Registrierung ist deaktiviert“). Gelöschte Konten (`DELETE /users/me`, `delete from users`) sind ganz fort, ihre Kennung ist „unbekannt“. Der Server legt den Einzelchat
also nach **derselben Regel** an, die schon heute für jeden gilt. Die Prüfung sitzt künftig an **einer** Stelle (`einzelchats_sichern`, 5.3), damit eine spätere Sperre dort eingehängt wird und nicht an drei Orten.

---

## 2. Die Regeln (verbindlich für alles Folgende)

**R1 – Wer den Termin sieht.** Der Ersteller und jede Person mit Zeile in `event_attendees`. Sonst niemand. Kein Chat, keine Rolle, kein Verlauf verleiht Zugang.
Gilt einheitlich für: Liste, Detail, Zusage, Vorkommen, Notizen, Dokumente, Ausgaben am Termin, Kalender-Abo, Datei-Zugriff, Rundruf, Karte.

**R2 – Was eine Karte ist.** Ein **Ort**, an dem der Termin angezeigt wird, nicht ein Zugang. Jede Karte ist eine `event`-Nachricht mit **einer Zeile** in `event_placements`.
Sie zeigt jedem Betrachter seinen **eigenen** Zustand; wer nicht Teilnehmer ist, sieht „Termin nicht verfügbar“ und bekommt weder `event` noch `metadata.eventId` (Abschnitt 4.9).

**R3 – Wohin die Einladung geht.** Bei Anlegen (und bei späterem Hinzufügen, nur für die **neu** Hinzugefügten):

```
Einzelkarte(n):  für jede eingeladene Person, wenn senden && einzelchats      (Chat: Ersteller ↔ Person)
Gruppenkarte:    für jeden ausdrücklich gewählten Gruppenchat G, wenn senden && posten(G)
                 && alle Mitglieder von G (ausser dem Ersteller) sind eingeladen
```

Nie in einen Gruppenchat, der nicht ausdrücklich gewählt wurde – auch nicht, wenn zufällig alle seine Mitglieder eingeladen sind.

**R4 – Genau eine Benachrichtigung je Person und Einladung**, unabhängig davon, in wie vielen Chats die Karte steht (Abschnitt 5.4).

**R5 – Das Verhältnis Termin ↔ Gruppenchat.** `calendar_events.conversation_id` ist der **erste** Gruppenchat mit Karte (Anzeige „💬 Chat“, Filter „Termine dieses Chats“), sonst `NULL`.
Er ist **nie** Zugang. Ein Termin ohne Gruppenkarte hat `conversation_id = NULL`, auch wenn er viele Eingeladene und Einzelkarten hat.

---

## 3. a) Datenmodell und Migration 0023

### 3.1 Tabellen und Spalten

| Objekt | Zweck |
|---|---|
| `event_placements` (neu) | Eine Zeile je Karte. `art = 'gruppe'`: Karte im Gruppenchat. `art = 'einzel'`: Karte im Einzelchat Ersteller ↔ `user_id`. `message_id` ist **leer, solange die Nachricht noch nicht angelegt ist** („reserviert“) – daran erkennt `nachliefern`, was aussteht. Eindeutig je `(event_id, conversation_id)` und je `(event_id, user_id)` bei `einzel`. |
| `event_attendees.eingeladen_am` (neu) | Wann diese Person eingeladen wurde. Bezugspunkt für „nach einer Weile erinnern“ (Thema 22, Migration 0024). Bestand: Anlegezeitpunkt des Termins; Rückgefüllte (5.) und Neue: `now()`. |
| `calendar_events.stand` (neu, `bigint`, 0) | Zähler, der bei **jedem** Rundruf hochgezählt wird; Clients verwerfen Rundrufe mit kleinerem Stand (Abschnitt 5.6). |
| `calendar_events.client_id` (neu, `text`) | Wiederholungsschutz beim Anlegen, eindeutig je `(created_by, client_id)` (4.6). |
| `calendar_events.conversation_id` | Bleibt, Bedeutung nach R5; Fremdschlüssel von `on delete cascade` auf `on delete set null`. |
| `calendar_events.message_id` | Bleibt, wird weiter mit der **ersten** Karte beschrieben (Rückfall auf den alten Stand bliebe lauffähig), sonst von nichts gelesen. |

### 3.2 Die Migration (`apps/api/migrations/0023_einladen.sql`)

Erprobt (Abschnitt 3.3). Kommentarkopf im Stil von `0016`/`0005`: erklärt das Warum. Der Wortlaut steht in `ergebnis-events/entwurf/0023_einladen.sql`; hier der Kern:

```sql
-- 1. Wann wurde eingeladen? (Block mit Prüfung: not null erst nach dem Füllen)
do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = current_schema()
                    and table_name = 'event_attendees' and column_name = 'eingeladen_am') then
    alter table event_attendees add column eingeladen_am timestamptz;
    update event_attendees ea set eingeladen_am = e.created_at
      from calendar_events e where e.id = ea.event_id;
    update event_attendees set eingeladen_am = now() where eingeladen_am is null;
    alter table event_attendees alter column eingeladen_am set default now();
    alter table event_attendees alter column eingeladen_am set not null;
  end if;
end $$;

-- 2. Stand und Wiederholungsschutz
alter table calendar_events add column if not exists stand bigint not null default 0;
alter table calendar_events add column if not exists client_id text;
create unique index if not exists calendar_events_client_id_idx
  on calendar_events (created_by, client_id) where client_id is not null;

-- 3. Der Chat reisst den Termin nicht mehr mit
do $$
begin
  alter table calendar_events drop constraint if exists calendar_events_conversation_id_fkey;
  alter table calendar_events add constraint calendar_events_conversation_id_fkey
    foreign key (conversation_id) references conversations (id) on delete set null;
exception when duplicate_object then null;
end $$;

-- 4. Die Karten eines Termins
create table if not exists event_placements (
  id              uuid primary key,
  event_id        uuid        not null references calendar_events (id) on delete cascade,
  conversation_id uuid        not null references conversations (id) on delete cascade,
  message_id      uuid references messages (id) on delete set null,
  art             text        not null check (art in ('gruppe', 'einzel')),
  user_id         uuid references users (id) on delete cascade,      -- nur bei 'einzel'
  created_by      uuid references users (id) on delete set null,
  created_at      timestamptz not null default now(),
  check ((art = 'einzel') = (user_id is not null))
);
create unique index if not exists event_placements_chat_idx   on event_placements (event_id, conversation_id);
create unique index if not exists event_placements_person_idx on event_placements (event_id, user_id) where art = 'einzel';
create index if not exists event_placements_conversation_idx  on event_placements (conversation_id);
create index if not exists event_placements_message_idx       on event_placements (message_id) where message_id is not null;

-- 5. Wer bisher nur über den Chat Zugang hatte, wird Teilnehmer (heutige Mitglieder, Zusage „offen“)
insert into event_attendees (event_id, user_id, status)
select e.id, cm.user_id, 'pending'
  from calendar_events e
  join conversation_members cm on cm.conversation_id = e.conversation_id
 where e.conversation_id is not null and e.deleted_at is null
on conflict (event_id, user_id) do nothing;

-- 6. Vorhandene Karten eintragen – aus den Nachrichten selbst (message_id kennt nur die erste).
--    Vergleich über den Text der Kennung: ein Schlüssel, der keine UUID ist, darf nicht abbrechen.
insert into event_placements (id, event_id, conversation_id, message_id, art, user_id, created_by, created_at)
select md5('event_placements:' || m.id::text)::uuid, e.id, m.conversation_id, m.id,
       case when k.einzel then 'einzel' else 'gruppe' end,
       case when k.einzel then k.gegenueber end, m.sender_id, m.created_at
  from messages m
  join calendar_events e on e.id::text = m.metadata ->> 'eventId'
  join lateral (
    select c.type = 'direct'
             and (select count(*) from conversation_members x where x.conversation_id = c.id) = 2
             and exists (select 1 from conversation_members x
                          where x.conversation_id = c.id and x.user_id = e.created_by) as einzel,
           (select x.user_id from conversation_members x
             where x.conversation_id = c.id and x.user_id <> e.created_by limit 1) as gegenueber
      from conversations c where c.id = m.conversation_id
  ) k on true
 where m.type = 'event' and m.deleted_at is null and e.deleted_at is null
 order by m.id
on conflict do nothing;
```

Begründungen, die in den Kommentarkopf gehören:

* **Warum eine Tabelle und nicht `message_ids uuid[]` am Termin:** Jede Karte braucht ihren Chat, ihre Art und ihre Person; Löschen, Nachliefern, Erinnern (Thema 22) und „Wo steht dieser Termin?“ sind Abfragen **nach Zeilen**. Vorbild im Haus: `poll_placements` (`0005_events.sql:16`).
* **Warum „reserviert, dann geliefert“:** Bricht das Senden der Nachrichten ab, steht die Absicht in der Tabelle; ein zweiter Anlauf legt keine zweite Karte an (Unique-Index + fester `client_id` der Nachricht, 5.2).
* **Warum Rückfüllen aus Nachrichten:** Die Nachrichtenschnittstelle liess bisher beliebig viele Karten je Termin zu (S8); `message_id` kennt nur die erste.
* **Warum Mitglieder zu Teilnehmern werden:** „Bestehende Termine bleiben unverändert sichtbar“. **Bewusste Änderung:** Wer **nach** dem Einspielen einer Gruppe beitritt, sieht ältere Termine nicht mehr (heute schon sieht er deren Karte wegen `sieht_ab` nicht, aber Detail, Notizen und Unterlagen schon – S11). Das ist die neue Regel R1.
* **Kein `gen_random_uuid()`/Erweiterung:** Die Kennungen der rückgefüllten Zeilen sind aus der Nachrichten-Kennung abgeleitet (`md5(...)::uuid`) und damit auch beim zweiten Durchlauf dieselben; neue Zeilen bekommen UUID v7 aus der Anwendung wie überall.

### 3.3 Was erprobt wurde

Kopie von `calendar_events` (34 Zeilen) und `event_attendees` (90) in ein Wegwerf-Schema, Rest aus `public`, Migration zweimal ausgeführt: erster Lauf **94** Teilnehmerzeilen (+4 aus Chatmitgliedschaft),
**26** Karten (**10** `einzel`, **16** `gruppe`), `eingeladen_am` nirgends leer, Fremdschlüssel `calendar_events_conversation_id_fkey` jetzt `set null`; **zweiter Lauf: 0 neue Zeilen**, keine Fehler. Schema wieder entfernt, `public` unberührt.
Gemessen wurde nicht die Laufzeit auf grossem Bestand: Der Schritt 6 liest `messages` einmal sequentiell (kein Index auf `type`); bei Millionen Nachrichten ein einmaliger Lauf von Sekunden – in `DEPLOYMENT.md` vermerken. Schritt 3 nimmt kurz eine Sperre auf `calendar_events`.

### 3.4 Löschverhalten

| Ereignis | Wirkung |
|---|---|
| Termin gelöscht (`deleted_at`) | `event_placements`-Zeilen werden vom Dienst **gelöscht**, die Nachrichten als gelöscht markiert (5.8). `event_attendees` bleiben (wie heute). |
| Termin hart gelöscht | Kaskade auf `event_placements`, `event_attendees`, Notizen usw. |
| Chat gelöscht | Gibt es nicht. Würde es eingeführt: Zeilen in `event_placements` kaskadieren, der Termin **bleibt** (`conversation_id → NULL`). |
| Konto der Person gelöscht | `event_attendees` und `event_placements` (`user_id`) kaskadieren; die Karte bleibt als Nachricht im Einzelchat des Erstellers stehen (wie jede Nachricht eines gelöschten Gegenübers). |
| Person verlässt/wird entfernt aus Gruppe | Keine Wirkung auf den Termin (Teilnehmerzeile bleibt). Die Gruppenkarte bleibt im Chat; ist die Person nicht mehr Mitglied, sieht sie sie nicht mehr. |
| Chat archiviert | Nur je Mitglied (`archived`); berührt Termine nicht. Eine Karte in einem archivierten Einzelchat bleibt dort, der Push kommt trotzdem (Stummschaltung ist `muted_until`, nicht `archived`). |

### 3.5 Schnittstelle zu Thema 22 (Migration 0024, Erinnern)

Thema 22 baut auf `event_attendees.eingeladen_am` (Bezugspunkt), `event_placements` (`art='einzel'`, `user_id`, `conversation_id`, `message_id`: **wohin** die Erinnerung geht und ob dort schon eine Karte steht) und
`calendar_events.status = 'cancelled'` (Abbruchbedingung, hier erstmals gesetzt, 5.9) auf. Eine eigene Tabelle `event_einladungen` ist **nicht nötig**: Zähler und Zeitstempel je Person
(`erinnert_anzahl`, `zuletzt_erinnert_am`) gehören als Spalten an `event_attendees` (Entscheidung dort). Namensabstimmung: Dieser Entwurf nennt die Spalte `eingeladen_am`; der Erinnerungsentwurf schrieb `eingeladen_at` – **eine** Schreibweise wählen, die Migration 0024 darf `add column if not exists` ohne Schaden wiederholen.
Der Dienst „Einzelchat finden/anlegen“ (5.3) ist derselbe, den das Erinnern braucht, falls der Einzelchat fehlt.

---

## 4. b) API-Verträge

### 4.1 Anlegen: `POST /calendar/events`

Neu und **optional**:

```jsonc
{
  "title": "Grillen", "startsAt": "…", "endsAt": "…", "location": "…",          // wie bisher
  "attendeeIds": ["uuid", …],        // bisher: Zusatz zu „alle aus dem Chat“. Mit `zustellung`: die VOLLE Liste ohne mich; leer = niemand
  "zustellung": {                    // Fehlt dieses Feld, gilt das alte Verhalten (Modus „alt“)
    "senden": true,                  // false: niemand bekommt eine Karte oder Benachrichtigung; nur Kalender
    "einzelchats": true,             // Karte in die Einzelchats (Vorgabe true)
    "gruppenChatIds": ["uuid", …]    // Gruppenchats, in die die Karte soll (Vorgabe: keiner); höchstens 10
  },
  "clientId": "uuid-v7"              // Wiederholungsschutz, höchstens 64 Zeichen
}
```

Zwei Modi, **am Vorhandensein von `zustellung` erkannt**:

| | Modus „alt“ (kein `zustellung`) | Modus „ausdrücklich“ |
|---|---|---|
| Teilnehmer | `attendeeIds` ∪ Ersteller ∪ **alle Mitglieder von `conversationId`** | genau `attendeeIds` ∪ Ersteller; der Chat fügt **nichts** hinzu |
| Karten | eine Karte in `conversationId`, wenn `announce` (Vorgabe: ja, wenn Chat) | nach R3 |
| `conversationId` | bestimmt den Chat | wird nicht gelesen; ist es gesetzt und nicht in `gruppenChatIds` → 400 |
| `announce` | wie bisher | wird nicht gelesen |
| Einzelchats | keine | nach `einzelchats` |
| Benachrichtigung | wie bisher (`create_message`, nicht stumm) | eine je Person (5.4) |

Alle bisherigen Aufrufer – ältere PWA-Stände im Cache, `modules/polls.rs:384` („Termin aus Umfrage“), `create_planning` (`modules/calendar.rs:672`), `bin/seed.rs:121` – bleiben im Modus „alt“ und ändern ihr Verhalten nicht.
Auch der Modus „alt“ **trägt seine Karte in `event_placements` ein** (Art `gruppe`, bzw. `einzel` in einem Zweierchat), damit Synchronität, Löschen und Erinnern für Bestand und Neues eine Quelle haben.

### 4.2 Antwort

`201` (bei Wiederholung mit gleicher `clientId`: `200`) mit der bisherigen `CalendarEventDto` **als oberste Ebene**, im Modus „ausdrücklich“ um **einen** Schlüssel ergänzt:

```jsonc
{ …CalendarEventDto…, "stand": 7,
  "zustellung": {
    "gruppen":        [{ "conversationId": "…", "nachrichtId": "…" }],
    "einzelchats":    7,            // Karten in Einzelchats
    "neueEinzelchats": 2,           // davon neu angelegt
    "ausgelassen":    [{ "conversationId": "…", "fehlend": ["uuid", …] }],   // gewünscht, aber nicht alle Mitglieder eingeladen (höchstens 5 Kennungen)
    "ausstehend":     0,            // Karten, die (noch) nicht zugestellt sind
    "benachrichtigt": 7 } }
```

Umsetzung: `struct TerminAntwort { #[serde(flatten)] termin: CalendarEventDto, #[serde(skip_serializing_if = "Option::is_none")] zustellung: Option<ZustellungDto> }`. Ältere Clients lesen die Ebene darunter und ignorieren den Rest.
`CalendarEventDto` bekommt `stand: i64` (Clients verwerfen Ältere, 5.6).

### 4.3 Ändern: `PATCH /calendar/events/{id}`

Zusätzlich zu den bisherigen Feldern (alle optional):

| Feld | Bedeutung |
|---|---|
| `attendeeIds` | **Sollzustand** der Eingeladenen (ohne Ersteller), wie seit dem letzten Fix. Unterschied zum Ist: Hinzugefügte → Einzelkarte + Benachrichtigung (R3, nur für sie); Entfernte → Zugang endet, Einzelkarte gelöscht (5.7). |
| `zustellung.senden` / `.einzelchats` | Gelten für die **neu Hinzugefügten** dieser Anfrage. Fehlt `zustellung` ganz (ältere Clients): Vorgabe `senden: true, einzelchats: true`, Gruppen **unverändert**. |
| `zustellung.gruppenChatIds` | **Sollzustand** der Gruppenkarten. **Fehlt das Feld: unverändert** (wichtig: Der Editor sendet es erst, wenn er die bestehenden Gruppenkarten geladen hat, sonst würde er sie versehentlich abwählen). Neu in der Liste → Karte (wenn alle Mitglieder eingeladen, sonst `ausgelassen`); nicht mehr in der Liste → Gruppenkarte gelöscht; **bestehende Karten bleiben, auch wenn inzwischen Mitglieder fehlen** (5.7). |
| `status` | `confirmed` \| `cancelled` (Absagen/Wiederaufnehmen, 5.9). Nicht aus/nach `planning`. |

Antwort wie 4.2 (mit `zustellung`, wenn `zustellung` oder `attendeeIds` gesendet wurde).

### 4.4 Weitere Routen

| Route | Zweck | Wer |
|---|---|---|
| `GET /calendar/events/{id}/zustellung` | Wo steht der Termin? `{ gruppen: [{conversationId, nachrichtId}], einzelNutzerIds: [uuid], ausstehend }` – der Editor füllt daraus die Gruppen-Chips und weiss, wer schon eine Einzelkarte hat. | Ersteller |
| `POST /calendar/events/{id}/zustellung/nachliefern` | Legt fehlende Nachrichten zu reservierten Zeilen an (idempotent). Antwort: `zustellung`. | Ersteller |
| `DELETE /calendar/events/{id}/attendees/{userId}` | Bleibt; nutzt denselben Dienst wie `PATCH` (Einzelkarte, Rundruf `event.deleted` mit Grund). | Ersteller (bisher: auch Gruppen-Admins, siehe 4.5) |
| `POST /calendar/events/{id}/rsvp` | Bleibt. Nur Ersteller/Eingeladene (R1); bei `cancelled`: `409`. | Teilnehmer |

### 4.5 Berechtigungen

* **Einladungen ändern** (`attendeeIds`, `zustellung`, Ausladen, Nachliefern, Zustellung lesen): **nur der Ersteller.** Fehler `403` „Nur wer den Termin angelegt hat, kann Einladungen ändern“. Grund: Der Ersteller ist Absender aller Karten und Gegenüber aller Einzelchats; ein anderer Absender zerlegte die Synchronität und das Erinnern. Die Oberfläche blendet das schon heute nur für den Ersteller ein (`EventDetailScreen.tsx`, `isCreator`).
* **Inhalt ändern / Löschen / Absagen** (`assert_editable`): Ersteller **oder** ein Admin/Owner eines Gruppenchats, in dem der Termin eine `gruppe`-Karte hat **und** der zugleich Teilnehmer ist (heute: Admin des **einen** gebundenen Chats; unter R1 muss er dafür den Termin auch sehen dürfen, sonst bearbeitete er, was er nicht sehen darf).
* **Anlegen:** jedes Konto. Wen man einladen darf: jedes **existierende** Konto (Begründung 1); Drossel siehe 4.7.

### 4.6 Validierung, Fehlertexte, Idempotenz

Alle Texte deutsch, über `Validator`/`AppError` wie im Bestand.

| Fall | Status | Text |
|---|---|---|
| mehr als 200 Eingeladene | 400 | „Zu viele Eingeladene (höchstens 200).“ |
| unbekannte Kennung unter `attendeeIds` | 400 | „Unbekannte Personen unter den Eingeladenen.“ |
| mehr als 10 `gruppenChatIds` | 400 | „Zu viele Gruppenchats (höchstens 10).“ |
| Ersteller nicht Mitglied eines Gruppenchats (nur für **neue** Gruppenkarten; eine schon bestehende Karte darf der Ersteller auch nach seinem Austritt noch abwählen) | 403 | „Du bist kein Mitglied dieses Chats“ (Text von `assert_membership`) |
| Einzelchat als `gruppenChatIds` | 400 | „Nur Gruppenchats lassen sich als Ziel wählen.“ |
| `conversationId` neben `zustellung` passt nicht | 400 | „Bei „zustellung“ bestimmen die Gruppenchats den Chat des Termins.“ |
| Nicht-Ersteller ändert Einladungen | 403 | „Nur wer den Termin angelegt hat, kann Einladungen ändern“ |
| `status` ungültig / Absage in Abstimmung | 400 | „Ein Termin in Abstimmung lässt sich nicht absagen – lege zuerst den Zeitpunkt fest.“ |
| Zusage bei abgesagtem Termin | 409 | „Der Termin ist abgesagt.“ |
| Drossel | 429 | „Zu viele Einladungen in kurzer Zeit. Warte einen Moment.“ |
| `clientId` länger als 64 | 400 | über `Validator::length` |

Die Person selbst in `attendeeIds` wird **still ignoriert** (der Ersteller ist immer dabei). Doppelte Kennungen werden zusammengeführt.
Ein gewünschter Gruppenchat, dessen Mitglieder nicht alle eingeladen sind, ist **kein Fehler**, sondern erscheint in `ausgelassen` (R3 gilt für alle Aufrufer gleich; der Client zeigt dasselbe schon vorher).

**Idempotenz.**
* `POST` mit `clientId`: Existiert `(created_by, client_id)`, kehrt die Anfrage **vor jeder Wirkung** mit `200` und dem vorhandenen Termin (samt aus `event_placements` gerechneter `zustellung`) zurück. Der Editor erzeugt die `clientId` beim Öffnen des Blatts (`uuidv7()` aus `@initiative/shared`) und behält sie für alle Wiederholungen derselben Eingabe.
* Karten: Unique-Index `(event_id, conversation_id)`; die Nachricht trägt den festen `client_id = "karte:{placement_id}"` (`create_message` ist über `(conversation, sender, client_id)` idempotent, `services/messages.rs:279`). Die Platzierungs-Kennung (und nicht nur Termin+Chat) ist Teil des Schlüssels, damit eine **nach dem Ausladen wieder angelegte** Karte nicht die gelöschte Nachricht zurückbekommt.
* `PATCH` ist als Sollzustand wiederholbar; `nachliefern`, `rsvp` und `DELETE attendees` ebenfalls.

### 4.7 Grenzen, Drossel, Leistung bei 100+ Eingeladenen

**Obergrenzen** (`constants.rs` und `packages/shared` gleichlautend): `EINLADUNGEN_MAX = 200` (Zod hat bereits `.max(200)`), `EINLADUNG_GRUPPEN_MAX = 10`, `EINLADUNG_PARALLEL = 4` (gleichzeitige Nachrichten in Phase 2; der Pool hat `database_pool_max` Verbindungen, andere Anfragen brauchen Luft).

**Drossel** (`drossel.rs`, Regeln neben `SUCHEN`; Eimer je Konto, wie dort begründet nur je Instanz): `EINLADEN = neu(30, 1 h)` je Anfrage mit `zustellung` oder `attendeeIds`; `EINZELCHATS_NEU = neu(300, 1 h)` (je neuem Einzelchat ein Versuch; reicht der Vorrat nicht, `429` **vor** Phase 1); `TERMIN_AENDERUNG_PUSH = neu(3, 10 min)` je Termin (mehr Änderungs-Benachrichtigungen werden still in die Karten geschrieben).

**Anzahl der Anweisungen** (kein N+1; N = Eingeladene, G = gewünschte Gruppen):

| Schritt | Anweisungen | Wie |
|---|---|---|
| Personen prüfen | 1 | `select id from users where id = any($1)` |
| Gruppenchats prüfen | 2 | Art+Mitgliedschaft des Erstellers; alle Mitglieder aller `G` in einer Abfrage |
| vorhandene Einzelchats | 1 | `select distinct on (other.user_id) … order by other.user_id, c.created_at, c.id` (ältester je Person) |
| Sperren der Paare | 1 | `pg_advisory_xact_lock(hashtextextended('einzelchat:a:b',0))`, Schlüssel **sortiert**, eine Anweisung (verhindert Dubletten bei gleichzeitigem Anlegen) |
| fehlende Einzelchats anlegen | 2 | `insert … select from unnest($ids)` für `conversations`; `unnest($chat, $person)` für `conversation_members` (beide Mitglieder, `sieht_ab = now()`) |
| Termin | 1 | `insert` |
| Teilnehmer | 1 | `insert … select from unnest($ids)` |
| reservierte Karten | 1 | `insert into event_placements … unnest` |
| Commit | | |
| Phase 2 je Karte | ≈ 12 | `create_message` (Bestand), höchstens `EINLADUNG_PARALLEL` gleichzeitig (`futures_util::stream::buffer_unordered`, Crate ist schon Abhängigkeit) |
| Karten buchen | 1 | `update event_placements … from unnest($placement, $message)` |
| neue Chats melden | 2 je neuem Chat | `broadcast_conversation`, parallel begrenzt |
| Rundruf `event.updated` | 1 | **ein** `hub.publish` an alle Teilnehmer |
| Push | 1 + 1 je Person | Zielbestimmung in **einer** Abfrage, dann Versand im Hintergrund (`tokio::spawn`), nicht vor der Antwort |

Phase 1 ist damit **unabhängig von N** (rund zehn Anweisungen); Phase 2 wächst linear mit den Karten, aber begrenzt parallel und **nicht** innerhalb der Datenbank-Transaktion. Eine Sammelvariante von `create_message` (ein `insert` für alle Karten, eine Hydrierung) wäre die nächste Stufe; sie umginge den **einen** Einstieg für Nachrichten und ist nur nötig, wenn 200 Karten zu langsam werden.
Der Rundruf braucht die Bus-Korrekturen aus 5.6 (Stückelung der Empfängerliste, Hinweis mit Kennung), sonst gehen bei 70+ Eingeladenen auf dem Postgres-Bus die Live-Zusagen verloren.

### 4.8 Reihenfolge der Schritte (Anlegen, Modus „ausdrücklich“)

1. Drossel, Validierung der Felder (rein, ohne Datenbank), `clientId`-Wiederholung prüfen → ggf. `200` zurück.
2. Kontext laden (Personen, Gruppen, vorhandene Einzelchats – 4 Abfragen, 4.7).
3. **Plan rechnen** (`einladen::planen`, rein, 5.1): Gruppen ok/ausgelassen, Einzelkarten.
4. **Transaktion** (Phase 1): Sperren → Einzelchats anlegen → Termin → Teilnehmer (`eingeladen_am = now()`, Ersteller `yes`) → reservierte `event_placements` → `conversation_id`/`message_id` setzen → Commit. Jeder Fehler: Rollback, nichts bleibt.
5. **Phase 2** (nach Commit): neue Chats melden → Karten liefern (`silent: true`, fester `client_id`) → Zeilen buchen → `calendar_events.message_id` (erste Karte). Teilfehler werden gezählt und protokolliert (`tracing::warn!`), nicht geworfen.
6. `event.updated` an alle Teilnehmer (mit hochgezähltem `stand`).
7. Push im Hintergrund (5.4).
8. Antwort `201` mit `zustellung`.

Ändern (`PATCH`) folgt demselben Muster; Schritt 4 beginnt mit `select … from calendar_events where id = $1 for update` (zwei gleichzeitige Änderungen des Erstellers laufen hintereinander).

### 4.9 Jede Stelle, die heute an `conversation_id` hängt

| # | Stelle (heute) | Neu |
|---|---|---|
| 1 | `modules/calendar.rs:189` `assert_visible` (Chat-Zweig kehrt vorzeitig zurück; Teilnehmer-Zweig unerreichbar) | Ersteller **oder** Teilnehmerzeile, über `is_attendee`. Behebt den Fehler „Eingeladene von ausserhalb kommen nicht an ihren Termin“ (S2, S6, S7b). |
| 2 | `modules/calendar.rs:212` `assert_editable` (Admin irgendeines gebundenen Chats) | 4.5: Ersteller oder Admin eines Chats mit `gruppe`-Karte, der Teilnehmer ist. |
| 3 | `services/events.rs:25` `is_attendee` (Chat-Zweig „gehört allen im Chat“) | **Chat-Zweig entfällt.** Damit folgen Notizen, Dokumente, Ausgaben am Termin (`modules/expenses.rs:78/186/330` rufen `assert_attendee`) und die Notiz-Rechte `members` (`may_edit_note`, `erlaubt`) automatisch R1. |
| 4 | `services/events.rs:184` `attendee_count` (Rückfall: Chatmitglieder, wenn keine Teilnehmer) | Rückfall entfällt (`max(1)`); gezählt wird die Teilnehmerliste – die Zahl hinter „alle“ bei Listen-Punkten. |
| 5 | `services/calendar.rs:105` `load_events_for_user` (Verbund über `conversation_members`) | `created_by = $1 or exists (event_attendees)`; der Filter `conversationId` fragt `event_placements` (Termine, die in diesem Chat eine Karte haben) ∪ `e.conversation_id`. Damit folgt auch das **Kalender-Abo** (`feed_ics`). |
| 6 | `services/calendar.rs:284` `broadcast_event` und `modules/calendar.rs:360` `remove` (Empfänger: Teilnehmer ∪ Chatmitglieder) | Nur Teilnehmer; beim Entfernen/Löschen zusätzlich die Betroffenen (`event.deleted` mit Grund, 5.7/5.8). |
| 7 | `services/calendar.rs:297` `EventExpander` (`_viewer_id` ungenutzt) | Gibt `event` nur, wenn der Betrachter Ersteller/Teilnehmer ist (Kopf und Teilnehmerliste sind schon geladen, **keine** zusätzliche Abfrage). |
| 8 | `services/messages.rs:65` `hydrate_messages` | Hat eine `event`-Nachricht keine Expansion → `metadata = {}` (Kennung nicht ausliefern). Gilt auch für fremde Kennungen und Fehler des Expanders (fail closed). Ein Termin, der nie existierte, zeigt damit sofort „nicht verfügbar“ statt einen vergeblichen Abruf zu starten. |
| 9 | `services/messages.rs:389` `ausspielen` | Bei Nachrichten mit `event`: Empfänger, die nicht Teilnehmer sind, bekommen die gekürzte Fassung (`event = None`, `metadata = {}`) – derselbe Zweiteiler wie beim Zitat. Schliesst das Zeitfenster „Beitritt in der Sekunde des Sendens“. |
| 10 | `modules/messages.rs:159` `send_message` (`eventId` in `metadata` zählt als Inhalt) | `eventId` in `metadata` → `400` „Termin-Karten legt nur die Termin-Funktion an.“ (`type: event` ebenso). Kein Client sendet so etwas (Composer-Aktion „Termin“ geht über `POST /calendar/events`). |
| 11 | `services/zugriff.rs:193-204` und `:321-335` (Datei-Zugriff „termin“: Ersteller ∨ Chatmitglied ∨ Teilnehmer) | Chat-Zweig **entfällt** in beiden Abfragen (Zugriff und Kreis „wer darf das sehen“). |
| 12 | `modules/calendar.rs` `create_event_from_poll` (`polls.rs:384`), `create_planning` (`calendar.rs:672`) | Modus „alt“: alle Chatmitglieder werden Teilnehmer, eine Karte in `conversationId` (nur Terminumfrage, `create_planning` ohne Karte). Verhalten wie vorher; `confirm_event` (`calendar.rs:1508`) trägt Abstimmende aus Einzelchats weiter als Teilnehmer ein – sie **können jetzt** öffnen und zusagen (R1 behebt S2/S6). |
| 13 | `modules/calendar.rs:92` `list` mit `conversationId` (verlangt Mitgliedschaft, filtert `e.conversation_id`) | Mitgliedschaft bleibt Voraussetzung **für den Filter**; gefiltert wird über Karten (Zeile 5). |
| 14 | Ausgaben (`services/expenses.rs:72`, Sichtbarkeit `conversation`) | Eigenes Recht der **Ausgabe** (`expenses.conversation_id`), nicht des Termins – unverändert. Der Termin-Bereich „Ausgaben“ verlangt `assert_attendee` (Zeile 3). Bestehende Ausgaben einer später ausgeladenen Person bleiben nach ihrer eigenen Regel sichtbar (Risiko, Abschnitt 11). |
| 15 | Chat **archivieren/verlassen/löschen** | Siehe 3.4: keine Wirkung auf Termine; ein Chat-Austritt entzieht weder Teilnahme noch Zugang. |
| 16 | `event.ics` (Einzeltermin, **ohne Anmeldung**, Kennung als Berechtigung) | Unverändert. Die Kennung gelangt wegen Zeilen 7–9 nicht mehr an Nicht-Eingeladene. Härtung (signierter Link) bewusst **nicht** Teil dieses Entwurfs (Risiken). |
| 17 | `modules/users.rs:189` Datenexport (`meineTermine` nur `created_by`) | Unverändert (Art. 15: „was ich angelegt habe“). |

---

## 5. c) Die Zustellung im Einzelnen

### 5.1 Der Plan (reine Funktion, beidseitig gespiegelt)

```rust
// services/einladen.rs – keine Datenbank, keine Uhr
pub struct Wunsch { pub senden: bool, pub einzelchats: bool, pub gruppen: Vec<Uuid> /* in Auswahlreihenfolge */ }
pub struct Plan {
    pub gruppen: Vec<Uuid>,                        // Karte wird gepostet
    pub ausgelassen: Vec<(Uuid, Vec<Uuid>)>,       // (Gruppenchat, fehlende Personen)
    pub einzel: Vec<Uuid>,                         // Personen mit Einzelkarte (ohne Ersteller)
}
pub fn planen(ersteller: Uuid, personen: &[Uuid], wunsch: &Wunsch,
              mitglieder: &HashMap<Uuid, Vec<Uuid>> /* Gruppenchat → Mitglieder */) -> Plan
```

* `senden == false` → alles leer.
* `gruppen`: jeder gewünschte Chat G mit `mitglieder[G] \ {ersteller} ⊆ personen` (leere Menge zählt als „alle eingeladen“); sonst `ausgelassen` mit den Fehlenden.
* `einzel`: `personen` (ohne Ersteller), wenn `einzelchats`, unabhängig von den Gruppen.
* Die TypeScript-Fassung steht in `packages/shared/src/util/zustellung.ts` (Spiegel wie `recurrence.ts`/`recurrence.rs`); **beide Tests lesen dieselbe Datei** `packages/shared/src/testdaten/zustellung.json` (Rust per `include_str!` im Integrationstest, nicht im Bibliothekscode). So gehen Vorschau und Server nicht auseinander.

### 5.2 Die Karten

* Konstruktor `NewMessage::einladung(chat, absender, event_id, platzierung_id)`: Art `event`, `metadata {eventId}`, **`silent: true`**, `client_id = "karte:{platzierung_id}"`.
* Absender ist immer der **Ersteller** (Gruppe wie Einzelchat). Dadurch ist die Karte im Einzelchat für den Eingeladenen „eingehend“, erzeugt beim Ersteller kein „ungelesen“ und trägt sein Gesicht.
* Nach `create_message` wird `event_placements.message_id` gesetzt (gebündelt, 4.7). Ungelesen-Zähler und „zuletzt geschrieben“ wandern mit jeder Karte mit (`touch_conversation`) – gewollt: Der Chat mit dem Ersteller zeigt die Einladung, die Chatliste „📅 Termin“.
* Die Karte kennt **keinen eigenen Stand**: Sie zeigt den Termin, den der Server dem Betrachter ausliefert (Expander, R2). Es wird **nie** `message.updated` für Terminkarten ausgespielt (`republish_message` bleibt für Umfragen), damit die Vorschauzeile nicht auf eine alte Karte springt (`state/chat.ts:384-388`) und kein Nicht-Teilnehmer eine fremde Fassung bekommt.

### 5.3 Einzelchats finden oder anlegen

`services/conversations.rs`:

```rust
pub struct Einzelchats { pub chat_von: HashMap<Uuid, Uuid> /* Person → Chat */, pub neu: Vec<Uuid> /* Chat-Kennungen */ }
pub async fn einzelchats_sichern(tx: &mut Transaction<'_, Postgres>, ersteller: Uuid, personen: &[Uuid]) -> AppResult<Einzelchats>
pub async fn neue_chats_melden(state: &AppState, ersteller: Uuid, neu: &[Uuid])     // nach dem Commit: conversation.updated
```

* **Regel „darf“:** Person existiert (schon in Schritt „Personen prüfen“). Keine Sperren/Deaktivierung im Bestand (Abschnitt 1); die Funktion ist der **eine** Ort, an dem eine künftige Regel einhängt.
* **Finden:** der **älteste** Einzelchat mit **beiden** als Mitglied (`order by c.created_at, c.id`). `find_direct_conversation` bekommt dieselbe Ordnung (heute `limit 1` ohne Reihenfolge), damit Handler und Dienst denselben Chat meinen.
  Einzelchats, die eine Seite verlassen hat (1 Mitglied), zählen nicht – wie heute.
* **Anlegen:** `conversations(type='direct', created_by=Ersteller)` und beide `conversation_members` mit `sieht_ab = now()` (wie `modules/conversations.rs:172`), Ersteller `owner`, Gegenüber `member`. Der Handler `POST /conversations` nutzt für den Direktfall denselben Dienst (Verhalten unverändert; keine Systemnachricht bei Direktchats).
* **Nebenwirkung, die die Vorschau sagt:** Wer jemanden einlädt, mit dem er nur in Gruppen schreibt – oder über die Suche jemand Fremden –, legt einen Einzelchat an, der beim Gegenüber erscheint. Das ist **nicht** neu (der Direktchat ist heute mit jedem Konto möglich), wird aber erstmals als Nebenwirkung einer Einladung ausgelöst: daher die Drossel `EINZELCHATS_NEU` und der Hinweis in der Sende-Vorschau („3 Personen sind nicht in deinen Chats – für sie entsteht ein neuer Einzelchat“).
* **Archivierte Einzelchats** werden verwendet (Mitgliedschaft besteht); die Karte erscheint dort, der Push kommt (Stummschaltung ≠ Archiv).

### 5.4 Benachrichtigungen: genau eine je Person

**Quelle der Doppelung im Bestand:** jede Karte ist eine eigene Nachricht, `create_message` ruft `notify_new_message` (`services/messages.rs:359`), Kennzeichen `conversation:<Chat>` – zwei Karten ergeben zwei Mitteilungen.

**Regel:** Alle Einladungskarten sind `silent`. `services/notify.rs` bekommt `benachrichtige_termin(state, termin, art, ziele)`; die Einladung ruft sie **einmal** mit allen Zielen. Zielbestimmung je Person (reine Funktion `push_ziel(dm: Option<Uuid>, gruppen: &[Uuid], stumm: &HashSet<Uuid>) -> Option<Uuid>`):

1. Kandidaten in dieser Reihenfolge: Einzelchat der Person, dann die Gruppenchats mit Karte, in denen sie Mitglied ist, in Auswahlreihenfolge.
2. Erster Kandidat, dessen Chat für diese Person **nicht** stummgeschaltet ist (`conversation_members.muted_until`).
3. Keiner frei → **keine** Mitteilung (die Person hat alles stumm geschaltet; das gilt).
4. Person ohne jede Karte (`senden: false`, `einzelchats: false` ohne Gruppe) → **keine** Einladungs-Mitteilung (sie findet den Termin im Kalender).

Filter wie im Bestand: `settings.notifications.push` (Vorgabe an), `previews`. Nutzlast (`PushPayload`, `kind: "event"`, das TypeScript-Schema kennt die Art schon):

| Anlass | Titel | Text | `url` | `tag` |
|---|---|---|---|---|
| Einladung | Name des Erstellers | „📅 Einladung: {Titel}“ | `/chats/{gewählter Chat}` (+ `conversationId`, `messageId` der Karte; der Service Worker unterdrückt die Anzeige, wenn dieser Chat offen ist, `sw.ts:283`) | `termin:{id}` |
| Zeit/Ort geändert | Name des Bearbeiters | „📅 {Titel} – Zeit geändert“ / „Ort geändert“ / „Zeit und Ort geändert“ | `/kalender/termin/{id}` | `termin:{id}` |
| Abgesagt | Name des Bearbeiters | „📅 Abgesagt: {Titel}“ | `/kalender/termin/{id}` | `termin:{id}` |
| Gelöscht | Name des Bearbeiters | „📅 Entfällt: {Titel}“ | `/kalender` | `termin:{id}` |

Mit ausgeschalteter Vorschau: Titel „Initiative“, Text „Neue Einladung“/„Terminänderung“. **Keine Uhrzeit im Servertext** (der Server kennt keine Zeitzone; die Karte formatiert im Gerät).
Gleiches `tag` ersetzt eine frühere Mitteilung desselben Termins – eine Änderung verdrängt die Einladung, statt sich zu stapeln. Versand im Hintergrund, Zielbestimmung in einer Abfrage:
`select u.id, u.settings, cm.conversation_id, cm.muted_until from users u left join conversation_members cm on cm.user_id = u.id and cm.conversation_id = any($chats) where u.id = any($users)`.

Änderungs-, Absage- und Löschmitteilungen gehen **nicht an den Auslöser** und **nicht an Personen mit Antwort `no`** (Löschen: nur an `yes`/`maybe`, weil nur diese planen); nicht über einen Chat-Kanal, also zählt die Stummschaltung eines Chats hier nicht, nur die globale Einstellung.
Da der Push im Entwicklungsbetrieb aus ist (`/healthz` → `push: false`), testet man die **Zielbestimmung** als reine Funktion und den **Versand** über eine Testnaht: `PushService` bekommt einen optionalen Mitschnitt (`PushService::mitschneiden() -> Arc<Mutex<Vec<(Uuid, PushPayload)>>>`; `enabled()` ist dann wahr, `send_to_users` schreibt mit, statt zu senden).

### 5.5 Echtzeit: wer bekommt was

| Ereignis | Empfänger | Zweck |
|---|---|---|
| `message.new` (Karte) | die Mitglieder des Chats mit `sieht_ab` ≤ jetzt (Bestand); Nicht-Teilnehmer nur gekürzt (4.9 Zeile 9) | Karte erscheint live |
| `conversation.updated` | beide Mitglieder jedes **neuen** Einzelchats | Chat erscheint in der Liste des Gegenübers |
| `event.updated` (volle `CalendarEventDto`, `stand`) | **Teilnehmer** (nicht mehr Chatmitglieder) | alle Karten, Detail, Kalender |
| `event.deleted` `{eventId, conversationId, grund}` | bei Ausladen: die Entfernten (`grund: "ausgeladen"`); bei Löschen: alle Teilnehmer (`grund: "geloescht"`) | Karten/Kalender lassen den Termin los; `grund` ist optional, ältere Clients lesen nur `eventId` |
| `message.deleted` | wie beim Löschen einer Nachricht (`empfaenger_fuer_nachricht`, **vor** dem Löschen bestimmt, `modules/messages.rs:353`) | gelöschte Karten verschwinden |
| `sync.hint` mit `eventId` | wenn eine Nutzlast zu gross für den Bus ist | Client holt den Termin selbst (5.6) |

### 5.6 Synchronität: was stimmt, was fehlt, was kommt

**Was schon stimmt (belegt):** Es gibt **einen** Zustand je Person (`event_attendees`), jede Antwort läuft über `rsvp` und ruft `broadcast_event`; `EventBubble` hält keinen eigenen Stand, sondern `useLiveEvent` (`useCalendarEvents.ts:92`) und hört auf `event.updated`/`event.deleted`; zwei Karten zum selben Termin sind auf der Datenseite identisch (S8: beide frisch geladen gleich).

**Was fehlt (Browserlauf `browser-karten.json`):** Eine Karte in einem **nicht geöffneten** Chat bleibt bis zum Neuladen alt; `message.event` im Speicher wird nie berührt (`state/chat.ts` kennt `event.updated` nicht); `refreshMessages` holt nur Neueres; ein Remount lädt nicht nach (`initial.id === eventId`, `useCalendarEvents.ts:109`). Dazu die Funde 2 und 3 aus Abschnitt 1.

**Was kommt:**

1. **Stand.** `broadcast_event` wird zu `melde_termin(state, id) -> AppResult<CalendarEventDto>`: `update calendar_events set stand = stand + 1 where id = $1 returning stand`, **danach** DTO laden, dann veröffentlichen, dieselbe DTO als Antwort zurückgeben. (Die 15 Aufrufer in `modules/calendar.rs` und `services/` ersetzen `load_event_dto + broadcast_event` durch den einen Aufruf.) Jede Fassung mit Stand *k* enthält alle Schreibvorgänge, die vor dem Hochzählen auf *k* committet waren; eine spätere Änderung hat ein höheres *k*. Clients nehmen nur Fassungen mit `stand >=` dem bekannten.
2. **Bus.** (a) In `RealtimeBus::publish` wird die Empfängerliste für Postgres **in Stücke zu höchstens 100 Kennungen** geteilt (39 Byte je Kennung ⇒ ≤ 3,9 KB), je Stück ein NOTIFY. (b) `Event::sync_hint` bekommt ein optionales `event_id`; beim Kürzen einer `event.updated`/`event.deleted`-Nutzlast wird die Kennung aus `payload.event.id`/`payload.eventId` in den Hinweis übernommen (bisher nur `conversationId`, das in diesen Nutzlasten nicht auf oberster Ebene steht).
3. **Client-Trichter** `apps/web/src/lib/terminEreignisse.ts` (ein Modul, keine Abhängigkeit):
   ```ts
   aktualisiert(event: CalendarEventDto): void     // REST-Antwort, event.updated, Hinweis-Nachladen
   entfernt(eventId: string, grund?: 'geloescht' | 'ausgeladen'): void
   auf(handler): () => void                        // für useLiveEvent, useCalendarEvents, Chat-Speicher
   neuer(a, b): CalendarEventDto                   // größerer stand gewinnt; ohne stand: b
   ```
   Er merkt sich je Termin den höchsten `stand` und verwirft Älteres. Gespeist wird er von `realtime.on('event.updated'|'event.deleted')`, von `sync.hint` mit `eventId` (Nachladen `GET /calendar/events/{id}`; `403`/`404` → `entfernt`; Streuung 0–800 ms, damit 100 Geräte nicht gleichzeitig fragen), und **von jeder eigenen REST-Antwort** (`RsvpButtons`, Editor `onSaved`, Einladen/Ausladen) – so stimmt die eigene Ansicht auch bei abgebrochener Verbindung.
4. **Chat-Speicher** (`state/chat.ts`): `terminEreignisse.auf(...)` ersetzt in **allen** Chats jede Nachricht mit `type === 'event' && metadata.eventId === id` durch `{...nachricht, event}` (nur betroffene Listen werden kopiert), schreibt sie per `cacheMessages` in IndexedDB zurück und setzt bei `entfernt` `event` auf `undefined` (Karte zeigt „Termin nicht verfügbar“ bzw. den Grund). `useLiveEvent` bekommt die Fassung über `initial`; sein Effekt (`[initial]`) übernimmt nur **neuere** (`neuer`).
5. `useCalendarEvents`/`useLiveEvent` hören auf den Trichter statt direkt auf `realtime.on` – dann erreicht auch das Nachladen nach einem Hinweis alle Ansichten.

Zusage **am Termin, in einer Karte im Einzelchat oder im Gruppenchat** ist damit **dieselbe Operation** (`POST …/rsvp`) und wirkt auf alle Karten, das Detail und den Kalender – live bei offener Verbindung, beim Zurückkehren in einen Chat ohne Neuladen.

### 5.7 Bearbeiten: hinzufügen, entfernen, Zeit/Ort

**Hinzufügen** (`attendeeIds` um X erweitert): Teilnehmerzeile (`eingeladen_am = now()`), Einzelchat finden/anlegen, Einzelkarte (`silent`), **eine** Einladungs-Mitteilung für X, `event.updated`. Bestehende Teilnehmer bekommen **keine** neue Einladung, keine Karte, keine Einladungs-Mitteilung. Erscheint in `zustellung.gruppenChatIds` ein **neuer** Gruppenchat und qualifiziert er sich, kommt dort eine Gruppenkarte dazu (Mitglieder, die schon eine Einzelkarte haben, bekommen **keine zweite** Mitteilung – sie sind ja nicht „neu eingeladen“).
Ist X Mitglied einer schon bestehenden Gruppenkarte, die X **nicht** sehen konnte (X trat nach der Karte bei oder war nicht eingeladen): X bekommt die Einzelkarte; die Gruppenkarte zeigt ihm ab jetzt den Termin (R2, Expander) – ohne neue Nachricht.

**Entfernen** (Ausladen, Abwählen):
* Teilnehmerzeile weg → sofort `403`/`404` auf Detail, Zusage, Notizen, Unterlagen, Ausgaben; Termin fehlt in Liste und Abo.
* **Einzelkarte wird gelöscht** (Nachricht `deleted_at`, `body`/`metadata` geleert wie beim Löschen, `message.deleted` an Ersteller und Person, Zeile in `event_placements` weg). Sie bleibt nicht als Platzhalter, weil der Ersteller sonst in seinem Chat mit X eine volle Karte sähe, während X „nicht verfügbar“ sieht. Im Chat steht danach – wie bei jeder gelöschten Nachricht – „Diese Nachricht wurde gelöscht“.
* **Gruppenkarte bleibt.** Würde sie gelöscht, verlören 29 Mitglieder ihre einzige Karte, weil ein Dreissigster abgewählt wurde (Gruppen-only-Zustellung). Die Entfernte sieht dort – wie jeder Nicht-Eingeladene – nur „Termin nicht verfügbar“, **ohne** `event` und **ohne** `metadata.eventId`. Die Karte verrät damit, dass es **irgendeinen** Termin-Beitrag gab; Titel, Ort, Zeit, Teilnehmer und Kennung nicht.
* `event.deleted { grund: "ausgeladen" }` an die Entfernte: ihr Kalender und ihre Karten im Speicher lassen den Termin los; die Karte zeigt „Du bist nicht mehr zu diesem Termin eingeladen.“ (nur in der laufenden Sitzung; nach Neuladen das neutrale „Termin nicht verfügbar“).
* Keine Benachrichtigung an die Entfernte (Stille ist hier die freundlichere Wahl; Alternative „Ausgeladen“-Push verworfen, Abschnitt 9).
* Aus einer Gruppe **abgewählt** (nicht mehr in `gruppenChatIds`): die Gruppenkarte wird gelöscht wie oben (ausdrückliche Handlung des Erstellers).

**Zeit/Ort ändern** (`startsAt`, `endsAt`, `allDay`, `rrule`, `location`):
* Keine neue Einladung, keine neue Karte: Die Karten zeigen den neuen Stand live (`event.updated`).
* **Eine** Mitteilung je Teilnehmer ausser Bearbeiter und Antwort `no` („Zeit geändert“/„Ort geändert“/„Zeit und Ort geändert“), gedrosselt mit `TERMIN_AENDERUNG_PUSH`. Wer in **derselben** Anfrage neu eingeladen wurde, bekommt nur die Einladung.
* Bestehende Antworten **bleiben** (kein Zurücksetzen auf „offen“): Ein Zurücksetzen löschte Information und liesse das Erinnern (Thema 22) alle erneut anmahnen. Die Mitteilung bittet um Prüfung.
* Der Titel zählt nicht als wesentliche Änderung.

### 5.8 Löschen

`DELETE /calendar/events/{id}` (Ersteller oder Admin nach 4.5):
1. Empfänger je Karte **vor** dem Löschen bestimmen (eine Abfrage über alle Karten-Nachrichten: `messages ⋈ conversation_members` mit `sieht_ab`).
2. Transaktion: `deleted_at = now()`; Nachrichten der Karten als gelöscht markieren (`update messages set deleted_at = now(), body = null, metadata = '{}' where id = any($1)`; Anhänge gibt es keine); `event_placements` löschen.
3. `message.deleted` je Karte an deren Empfänger; `event.deleted { grund: "geloescht" }` an alle Teilnehmer.
4. Mitteilung „Entfällt“ an Teilnehmer mit Antwort `yes`/`maybe` (ausser dem Auslöser).
Gruppenchats und Einzelchats zeigen danach „Diese Nachricht wurde gelöscht“ wie jede gelöschte Nachricht (kein Sonderzustand, keine Karte mit „Termin nicht verfügbar“, die niemand mehr erklären kann). Aus dem Bestand bleibende „tote Karten“ (S13) verschwinden damit.

### 5.9 Absagen (neu)

`PATCH { status: "cancelled" }`: Termin bleibt, `calendar_events.status = 'cancelled'` (Spalte und Anzeige existieren schon, `EventRow.tsx:40`, `KalenderScreen.tsx:36`; bisher setzte sie kein Code), `event.updated`, Mitteilung „Abgesagt“ an alle ausser Auslöser und `no`.
Karten **bleiben** und zeigen „Abgesagt“ (durchgestrichener Titel, keine Zu-/Absage-Knöpfe); Notizen/Unterlagen bleiben lesbar (Nachweis). `rsvp` → `409`. `PATCH { status: "confirmed" }` nimmt den Termin wieder auf (Mitteilung „Findet doch statt“ entfällt: die Karte aktualisiert sich, eine zweite Mitteilung wäre Lärm). Thema 22 bricht bei `cancelled` ab.
Absagen ist der **freundliche Weg**, Löschen der **Aufräumweg** (Test-Termin, Vertipper): In der Oberfläche stehen beide nebeneinander mit klarer Beschriftung.

---

## 6. d) Die Oberfläche

### 6.1 Bausteine und was wiederverwendet wird

| Datei (neu/geändert) | Inhalt |
|---|---|
| `apps/web/src/modules/calendar/EinladungsWahl.tsx` (neu) | **Die** Komponente für „Eingeladen“: Zähler, Schnellwahl, Suche, Liste, Gruppen-Chips, Sende-Vorschau, Hauptschalter. Zustandslos bis auf Suchtext, Anzeige-Filter und Aufklapp-Zustand; Wahl kommt/geht über Props. |
| `apps/web/src/modules/calendar/einladung.ts` (neu) | **Die gesamte Logik rein und ohne React** (testbar in der `node`-Umgebung von vitest): `kontakteAus`, `filtern`, `gruppenAus`, `gruppeWaehlen`, `gruppenStatus`, `vorgeschlageneGruppen`, `alleWaehlen`, `vorschau` (Texte), `anlegenBody`/`aendernBody` (Formular → API). Nutzt `zustellungPlanen` aus `@initiative/shared`. |
| `apps/web/src/modules/calendar/EventEditor.tsx` (geändert, **so klein wie möglich**) | Ersetzt den Block „Chat“-Auswahl, „Eingeladen“, „Im Chat ankündigen“ und den Nutzlast-Bau in `save()`; der Rest (Datum, Wiederholung, Farbe …) bleibt, weil Thema „Ort“ dieselbe Datei ändert (Risiko Merge). Entfernt `chatLeute`/`chatMitglieder`/die N `GET /users/:id`. |
| `EventDetailScreen.tsx` (geändert) | „Jemanden einladen“ nutzt `EinladungsWahl` im Modus `nurNeue`; „Termin absagen“ neben „Löschen“. |
| `EventBubble.tsx` (geändert) | Zustände: „Abgesagt“, „Du bist nicht mehr eingeladen“, Platzhalter ohne Kennung; Zusage über Trichter. |
| `KalenderScreen.tsx` (klein) | Facette „Chat“: ohne Gruppenkarte heisst es „Ohne Gruppenchat“ (mit Eingeladenen) statt „Nur für mich“. |
| `components/PersonenWahl.tsx` | **Unverändert.** Andere Nutzer: `ShareSheet`, `ExpenseSheet`, `ChatInfoSheet`, `NewChatSheet`, `EventNotes`, `NoteListe`. Diese Komponente hat ein anderes Modell (Vorschläge + Suche ergänzt, „fest“, „ausschluss“); ein Umbau riskierte sechs Aufrufer für einen siebten. Es wird nur der Typ `Person` mitgenutzt. |
| `lib/terminEreignisse.ts`, `state/chat.ts`, `modules/calendar/useCalendarEvents.ts` | Trichter und Speicher (5.6). |
| `lib/api.ts`, `packages/shared` | Typen/Schema: `ZustellungDto`, `zustellung` und `clientId` in `createEventSchema`/`updateEventSchema`, `stand` in `CalendarEventDto`, `grund` in `event.deleted`, `eventId` in `sync.hint`; `calendar.zustellung(id)`, `.nachliefern(id)`, `.absagen(id)`/`.wiederaufnehmen(id)`. |

### 6.2 Aufbau des Felds „Eingeladen“ (375 px, von oben nach unten)

```
Eingeladen                                     5 von 12 Personen
Du bist immer dabei.
[ Alle ]  [ Niemand ]  [ Gruppenchat … ▾ ]
( Person suchen …                                        )
( Alle 12 | Gewählt 5 )
 ☑ [A] Anna Adler   @anna
 ☐ [B] Ben Braun    @ben
 …                                   [ Weitere anzeigen (30) ]
 Weitere Personen auf diesem Server           (nur bei Suche ≥ 2 Zeichen)
 ☐ Clara Weiss  @clara   · nicht in deinen Chats
Gruppenchats
 ┌ Skatrunde · 5 von 5 eingeladen        [ dort posten ●─ ]  ✕
 └ Hütte · 4 von 6 – Dora, Emil fehlen → hier wird nicht gepostet   ✕
 ＋ Auch in „Familie“ posten (alle 4 sind gewählt)
Einladung im Chat senden                        [ ●─ ]
 • Gruppenchat „Skatrunde“: Karte
 • 12 Einzelchats (2 werden neu angelegt) · [ Einzelchats ●─ ]
 • Jede Person bekommt eine Benachrichtigung.
 • 1 Person ist nicht in deinen Chats: für sie entsteht ein neuer Einzelchat.
 • Alle Eingeladenen sehen, wer noch eingeladen ist und wie geantwortet wurde.
```

**Verhalten im Einzelnen**

* **Kontakte** = `kontakteAus(conversations, myId)`: Vereinigung der `members[].user` aller Chats im Speicher (nicht archiviert, höchstens 300 Chats, wie die Liste selbst), ohne mich, ohne Doppelte; Felder `id`, `displayName`, `username`, `avatarUrl`, `einzelchatId` (vorhandener Einzelchat, falls im Speicher). Nur diese Felder werden gezeigt – nichts, was die Suche nicht ohnehin preisgibt (kein `bio`, kein `lastSeenAt`). Die Liste verrät damit **nichts Neues**: Jede Person darin steht ohnehin in den Chats des Nutzers (`members[].user`, schon im Gerät) und ist über die gedrosselte Suche auffindbar; wer **keinen** gemeinsamen Chat hat, erscheint nur als Suchtreffer.
* **Zähler** `n von m Personen eingeladen` (`role="status"`, `aria-live="polite"`); `m` = Kontakte + gewählte Nicht-Kontakte. Der Ersteller zählt nicht mit, steht als Satz „Du bist immer dabei.“ darüber.
* **Alle:** wählt **alle Kontakte**, höchstens 200. Hat der Nutzer mehr, ist „Alle“ gesperrt mit Hinweis „Mehr als 200 Kontakte – wähle einen Gruppenchat oder einzelne Personen.“ (`alleWaehlen` liefert `{ids, abgeschnitten}`). **Wählt keinen Gruppenchat.** **Niemand:** leert Personen **und** Gruppen-Chips.
* **Gruppenchat …:** Aufklappfeld (Disclosure-Muster, `aria-expanded`/`aria-controls`) mit den nicht archivierten Gruppenchats (Titel, „5 Mitglieder“, Haken bei bereits gewählten). Wahl fügt die Mitglieder (ohne mich) zur Auswahl hinzu und legt den Chip an; erneutes Antippen entfernt nur den **Chip** – die Personen bleiben gewählt (Hinweis im Chip: „Die Personen bleiben gewählt.“). Würde die Wahl 200 übersteigen: Gruppe wird nicht übernommen, Hinweis „Dieser Gruppenchat hat N Mitglieder – mehr als 200 lassen sich nicht einladen.“
* **Gruppen-Chips:** `gruppenStatus` rechnet live aus Auswahl und Mitgliederliste (die Zahlen „5 von 5“ zählen die Mitglieder **einschliesslich des Erstellers**, der immer eingeladen ist): `vollständig` (Schalter „dort posten“ bedienbar, Vorgabe an) oder `unvollständig` (Schalter gesperrt, Satz „Dora, Emil fehlen → hier wird nicht gepostet“). Wer die Fehlenden wieder wählt, stellt den Zustand wieder her; der Schalter springt auf seinen letzten Stand.
* **Vorschlags-Chip** „＋ Auch in „X“ posten“: nur für Gruppen, deren Mitglieder **alle** gewählt sind und die nicht als Chip stehen, höchstens drei. Ein Antippen macht daraus einen Chip.
* **Suche:** `input type="search"` mit sichtbarem Label „Person suchen“. **Filtert sofort** die Liste (enthält, ohne Gross-/Kleinschreibung und ohne Akzente, über Anzeigename **und** Benutzername). Ab 2 Zeichen zusätzlich, verzögert (250 ms, abbrechbar, veraltete Antworten verworfen – dieselbe Sorgfalt wie in `PersonenWahl`), `GET /users?q=`; Treffer, die schon Kontakte sind, erscheinen nicht doppelt, der Rest unter „Weitere Personen auf diesem Server“ mit Hinweis „nicht in deinen Chats“. Nichts gefunden: „Niemand gefunden.“; Fehler/offline: „Die Suche ist gerade nicht möglich.“ mit „Erneut versuchen“. Bereits **gewählte Nicht-Kontakte** (aus früherer Einladung oder Suche) stehen immer in diesem Abschnitt, damit sie abwählbar bleiben; ihre Namen kommen gebündelt aus `useLeute.sicherstellen` (eine Anfrage, nicht N).
* **Anzeige „Alle · Gewählte“:** Umschalter (zwei `button`, `aria-pressed`) – „Gewählte“ zeigt nur die Haken; hilft bei langen Listen, ohne dass die Reihenfolge beim Anhaken springt.
* **Liste:** `role="group" aria-label="Personen"`, Zeilen sind `<label>` mit echtem Kontrollkästchen, Avatar, Name (`truncate`), `@Benutzername`; Höhe ≥ 44 px; scrollende Box (`max-height: 44vh`, wie `PersonenWahl`, damit „Speichern“ erreichbar bleibt); Zeilen memoisiert; erste 100, dann „Weitere anzeigen (n)“ in 100er-Schritten.
* **Sende-Vorschau** (`role="status"`, `aria-live="polite"`, `aria-atomic`): berechnet aus `zustellungPlanen` **vor dem Senden**: welche Gruppenchats eine Karte bekommen/warum nicht, wie viele Einzelchats (davon bis zu N neue – aus den Einzelchats im Speicher geschätzt; die Antwort nennt die genaue Zahl), Hinweis auf Nicht-Kontakte, Hinweis auf Sichtbarkeit der Teilnehmerliste. Hauptschalter **„Einladung im Chat senden“** (aus: „Niemand bekommt eine Nachricht. Die Eingeladenen sehen den Termin nur in ihrem Kalender.“); Unterschalter „Einzelchats“.
* **Vorbelegung:** aus dem Composer im **Gruppenchat** (`lockConversation`): Gruppe als Chip, alle Mitglieder gewählt, „dort posten“ an, „Einzelchats“ an – genau die Regel des Anwenders, alles sichtbar und abwählbar. Aus einem **Einzelchat**: die Gegenperson gewählt, kein Chip. Sonst: niemand gewählt, Hauptschalter an.
* **Ladezustand:** Solange `useChat.initialised` falsch und keine Chats im Speicher sind: „Kontakte werden geladen …“ (`Spinner`), „Alle“ gesperrt. **Leerer Zustand:** „Du hast noch keine Kontakte – such eine Person mit dem Suchfeld.“ **Fehler beim Speichern:** Toast mit dem Servertext (`ApiError.message`), Eingaben bleiben. **Teilzustellung:** Toast „Termin gespeichert – N Einladungen konnten nicht zugestellt werden.“ mit Knopf „Erneut zustellen“ (`nachliefern`).
* **Bearbeiten** (`event` gesetzt): vorbelegt mit den heutigen Teilnehmern (ohne Ersteller); Zeilen bestehender Teilnehmer zeigen ihre Antwort (Symbol + Text, nicht nur Farbe). Die Gruppen-Chips kommen aus `GET …/zustellung` (bis sie da sind: Platzhalterzeile, und `gruppenChatIds` wird **nicht** mitgeschickt). Die Vorschau beschreibt den **Unterschied**: „Neu eingeladen: 2 → Einzelchat-Karte und Benachrichtigung“, „Entfernt: 1 → verliert den Zugang, ihre Einzelchat-Karte wird gelöscht“ (hat sie zugesagt: zusätzlich „hatte zugesagt“), „Zeit/Ort geändert → alle Eingeladenen werden benachrichtigt“. Eine schon gepostete Gruppenkarte, der inzwischen Mitglieder fehlen, bleibt stehen; ihr Chip sagt „Karte steht bereits – Dora und Emil sehen sie nicht als Termin.“ „Niemand“ fragt im Bearbeiten-Modus nach („12 Personen werden ausgeladen“). Wer keine Änderung an den Einladungen macht, sendet weder `attendeeIds` noch `zustellung` (keine versehentliche Wirkung).
* **Detailseite:** „Jemanden einladen“ öffnet `EinladungsWahl` im Modus `nurNeue` (Kontakte minus bisher Eingeladene, keine Gruppen, „Einladen (n)“); der Knopf sendet `attendeeIds = bisher ∪ neue` mit `zustellung {senden, einzelchats}`. Ausladen bleibt das ✕ je Zeile (mit Rückfrage bei Zusage).

### 6.3 Tastatur, Screenreader, 375 px

* Jede Bedienung per Tastatur: Schnellwahl-Knöpfe, Suchfeld, Anzeige-Umschalter, Zeilen (Leertaste), Chips (Enter), Schalter (`role="switch"`, `aria-checked`), „Weitere anzeigen“. Reihenfolge im DOM = Reihenfolge der Bildschirmlesers; beim Öffnen des Gruppenfelds wandert der Fokus auf die erste Zeile, beim Schliessen zurück zum Knopf.
* Namen: Gruppe „Personen“ und „Gruppenchats“ mit `aria-label`; Knöpfe sprechen ihre Wirkung aus („Alle Kontakte einladen“, „Niemand einladen“); der Zähler und die Vorschau sind **die einzigen** Live-Regionen (keine Häufung beim Tippen: Suchergebnisse melden nur „12 Personen gefunden“ nach Ablauf der Verzögerung).
* Farbe ist nie allein Träger (Zustand „unvollständig“, Antwort „hat zugesagt“ tragen Text/Symbol). Kontrast über die vorhandenen Tokens.
* 375 px: Schnellwahl `flex-wrap`, Chips brechen um, Namen `min-width: 0` + `truncate`, keine feste Breite, **kein horizontaler Seitenlauf**; Tippflächen ≥ 44 px (`min-height: 44px`). Stile in `modules/calendar/styles.css` mit Präfix `cal-einl-`; `global.css` bleibt unberührt (wegen `PersonenWahl`).

---

## 7. e) Tests

Regel: Jede Logik so schreiben, dass sie **ohne Browser** und **ohne React** prüfbar ist (vitest läuft in `node`, es gibt keine Komponententest-Bibliothek und es kommt keine); Komponenten und Zusammenspiel prüft Playwright.

### 7.1 Rust – Einheit (`#[cfg(test)]` in den Dateien)

| ID | Datei | Prüft |
|---|---|---|
| U1 | `services/einladen.rs` | `planen`: alle eingeladen → Gruppe + Einzel; eine Person fehlt → `ausgelassen` mit dieser Person, Einzel bleiben; mehrere Gruppen; Gruppe nur mit Ersteller; `senden=false` → leer; `einzelchats=false` → nur Gruppen; Person in zwei Gruppen; Ersteller in `personen` wird ignoriert; **gemeinsame Fälle** aus `zustellung.json`. |
| U2 | `services/notify.rs` | `push_ziel`: Einzelchat vor Gruppe; Einzelchat stumm → Gruppe; alle stumm → `None`; keine Karte → `None`; mehrere Gruppen in Auswahlreihenfolge. |
| U3 | `services/messages.rs` | `NewMessage::einladung` ist `silent`, hat `client_id = karte:{id}`, `metadata = {eventId}`. |
| U4 | `realtime/bus.rs` | Stückelung: 250 Empfänger → 3 Stücke à ≤ 100, jedes kodiert (bei 2 KB Nutzlast) < 7000 Byte; `sync_hint` trägt `eventId` bei `event.updated` und `event.deleted`. |
| U5 | `services/calendar.rs` | `wesentlich_geaendert(alt, neu)`: Zeit/Ort ja, Titel nein, Beschreibung nein; Text „Zeit“/„Ort“/„Zeit und Ort“. |
| U6 | `drossel.rs` | neue Regeln: Vorrat, Auffüllen (mit `erlaubt_um`, ohne zu warten). |

### 7.2 Rust – Integration (`apps/api/tests/einladen.rs`, Stil `verlaufsgrenze.rs`: eigener `Probe`, zufällige Kontonamen, Hub-Empfänger über `state.hub.register` für Echtzeit, Push über den Mitschnitt)

| ID | Name | Prüft |
|---|---|---|
| R1 | `alle_mitglieder_eingeladen_gruppenkarte_und_einzelkarten` | Gruppe G {A,B,C}, A legt an mit B,C und `gruppenChatIds [G]`: je **eine** Karte in G, AB, AC; `zustellung` stimmt; `conversationId = G`; `event_placements` hat 3 Zeilen mit Nachrichten. |
| R2 | `nicht_alle_eingeladen_nur_einzelkarten` | Nur B eingeladen, G gewünscht: G in `ausgelassen` (fehlt C), keine Karte in G, Karte in AB; `conversationId` leer. |
| R3 | `alle_waehlen_postet_in_keinen_gruppenchat` | A ist in G1, G2; lädt alle Kontakte ein, `gruppenChatIds []`: keine Karte in G1/G2, Einzelkarten ja. |
| R4 | `einzelchats_werden_angelegt_oder_wiederverwendet` | fehlender Chat wird angelegt (`neueEinzelchats`, `sieht_ab` gesetzt, beide sehen ihn in `GET /conversations`, `conversation.updated` kam an); vorhandener wird genutzt; bei **zwei** vorhandenen der **älteste**; archivierter wird genutzt; ein Einzelchat mit nur einem Mitglied zählt nicht. |
| R5 | `wer_nicht_eingeladen_ist_sieht_nichts` | D ist in G, nicht eingeladen: Liste, Detail, Zusage, Notizen, Dokumente, Ausgaben, Vorkommen, Kalender-Abo (ICS enthält den Titel nicht) jeweils ohne Zugang; bekommt keinen `event.updated`; Nachrichtenliste von G zeigt die Karte **ohne** `event` und **ohne** `metadata.eventId`; `message.new` an D (Hub) ohne `event`. |
| R6 | `eingeladene_ausserhalb_des_chats_koennen_oeffnen_und_zusagen` | Regression zu S2/S6/S7b: Detail 200, Zusage 200, Notizen 200, Dokumente 200. |
| R7 | `eine_zusage_gilt_in_allen_karten_und_geht_an_alle_eingeladenen` | B sagt in AB zu: Karte in G und AC (frisch geladen) gleich; `event.updated` an A, B, C mit gleichem `stand` und höherem als zuvor; **nicht** an D. Zweite Zusage → `stand` steigt. |
| R8 | `ein_push_je_person` | Mit Mitschnitt: Einladung an B,C in G + Einzelchats → **genau ein** Eintrag je Person, mit `url` des Einzelchats; ist AB für B stumm → Eintrag mit G; beides stumm → keiner; `einzelchats=false` → über G; `senden=false` → keiner. Es gibt keinen `notify_new_message`-Eintrag für die Karten. |
| R9 | `nachtraeglich_einladen_liefert_nur_an_die_neuen` | PATCH mit D: Karte in AD, Mitschnitt nur D; B, C ohne neue Nachricht; Teilnehmerzeile mit `eingeladen_am`; D kann öffnen. |
| R10 | `ausladen_beendet_zugang_entfernt_einzelkarte_laesst_gruppenkarte` | C entfernt: Zugang weg, AC-Karte gelöscht (`message.deleted`), G-Karte **bleibt** und zeigt C nur Platzhalter; C bekam `event.deleted` mit `grund "ausgeladen"`, keinen Push; Wieder-Einladen legt eine **neue** Einzelkarte an (nicht die gelöschte Nachricht). Gruppe **abgewählt** (`gruppenChatIds []`) → Gruppenkarte gelöscht. |
| R11 | `zeit_und_ort_aenderung_benachrichtigt_ohne_neue_karte` | Nach Änderung: keine neue Nachricht in irgendeinem Chat; Mitschnitt: ein Eintrag je Teilnehmer ausser Ersteller und `no`, Text „Zeit und Ort geändert“; Titeländerung → keiner; vier Änderungen innerhalb von 10 Minuten → nur die ersten drei lösen Mitteilungen aus. |
| R12 | `loeschen_entfernt_alle_karten` | Alle Karten als gelöscht, `message.deleted` an die richtigen Empfänger, `event.deleted` an alle Teilnehmer, Push nur an `yes`/`maybe`; `event_placements` leer. |
| R13 | `absagen_haelt_karten_und_sperrt_zusagen` | `status` `cancelled`: Karten unverändert da, Zusage `409`, Push an alle ausser `no`/Auslöser, `planning` nicht absagbar (400); `confirmed` nimmt wieder auf. |
| R14 | `altes_anlegen_bleibt_wie_es_war` | Anfrage nur mit `conversationId` (auch leere `attendeeIds`): alle Mitglieder Teilnehmer, **eine** Karte, **keine** Einzelkarten, Push wie bisher (Nachricht nicht stumm); ältere Erwartungen aus `tests/e2e.rs:686-760` laufen unverändert. |
| R15 | `termin_aus_umfrage_und_terminfindung_bleiben` | `POST /polls/{id}/event`: Teilnehmer = Abstimmende ∪ Chatmitglieder, Karte im Umfragechat; `POST /calendar/planning` + `confirm` wie bisher; Abstimmende aus Einzelchats können den Termin öffnen. |
| R16 | `fremde_termin_karte_zeigt_nichts_und_nachrichtenweg_ist_zu` | S12 nachgestellt: Karte mit fremder `eventId` im eigenen Chat → `POST /messages` mit `eventId` ist `400`; eine direkt in die Datenbank gelegte Karte liefert ohne Teilnahme kein `event`/keine Kennung. |
| R17 | `doppelsenden_und_nachliefern_sind_wiederholbar` | Zweimal dieselbe `clientId` → ein Termin (`200` beim zweiten), keine doppelten Karten/Mitschnitte; absichtlich unvollständige Zeilen (`message_id` leer) → `nachliefern` legt genau die fehlenden an, ein zweiter Aufruf nichts. |
| R18 | `grenzen_und_fehlertexte` | 201 Kennungen → 400 mit dem Text; unbekannte Person; 11 Gruppen; Einzelchat als Gruppe; fremde Gruppe (403); `conversationId` neben `zustellung`; Nicht-Ersteller ändert Einladungen (403); Drossel `429`. |
| R19 | `viele_eingeladene_bleiben_im_zeitrahmen` | 150 frische Konten, 150 Einzelchats: (a) **Phase 1** (öffentliche Funktion `einladen::phase_eins`, nur für Tests) führt mit 20 und mit 150 Personen **gleich viele** SQL-Anweisungen aus (±2) – gezählt über einen zählenden `tracing`-Layer auf dem Ziel `sqlx::query`, eingehängt mit `tracing::subscriber::set_default` auf einer `current_thread`-Laufzeit, damit parallele Tests nicht mitzählen; (b) der ganze Weg `POST` mit 150 Personen bleibt unter einer grosszügigen Grenze (Sekunden), alle 150 Karten und Einzelchats stehen da, `event.updated` wurde **einmal** veröffentlicht. |
| R20 | `nur_der_ersteller_aendert_einladungen` | Gruppen-Admin darf Titel/Zeit ändern und löschen (wenn Teilnehmer und Gruppenkarte), aber nicht einladen; Admin ohne Teilnahme: 403 auch beim Ändern. |
| M1 | `tests/einladen_migration.rs` (eigenes Schema wie `migrationen.rs`) | Migrationsliste bis 0022 gefiltert ausführen, Altbestand per SQL anlegen (Chat-Termin mit Karte, Einzelchat-Termin, Termin ohne Karte, Mitglied ohne Zeile, Karte mit Nicht-UUID-Schlüssel, zweite Karte, gelöschter Termin), dann 0023: Teilnehmerzeilen ergänzt (`pending`), `eingeladen_am` gesetzt (Termin-`created_at` bzw. Jetzt), Karten `einzel`/`gruppe` richtig, Duplikate übersprungen, **zweiter Lauf ändert nichts**, `conversation_id`-Regel `set null`. |

### 7.3 Web – Einheit (vitest, `node`)

| ID | Datei | Prüft |
|---|---|---|
| W1 | `modules/calendar/einladung.test.ts` | `kontakteAus`: ohne mich, ohne Doppelte, nur nicht archivierte Chats, Einzelchats zählen, alphabetisch (Umlaute, `Ä` vor `B`, Gross/Klein), `einzelchatId`. |
| W2 | dito | `filtern`: Teilstring, ohne Akzente/Gross-Klein, über Benutzername; leer → alle; Reihenfolge stabil. |
| W3 | dito | `alleWaehlen`: alle Kontakte; über 200 → `abgeschnitten`; schon Gewählte bleiben; Nicht-Kontakte bleiben. |
| W4 | dito | `gruppeWaehlen`/`gruppenStatus`: Mitglieder hinzu, ohne mich; Abwählen eines Mitglieds → `unvollständig` mit `fehlen`; Wiederwahl → `vollständig`; zwei Gruppen mit Überschneidung; > 200 → `zuViele`. |
| W5 | dito | „Alle“ erzeugt **keinen** Gruppen-Chip; „Niemand“ leert beides. |
| W6 | dito + `packages/shared/src/zustellung.test.ts` | `zustellungPlanen` gegen `zustellung.json` (**dieselben Fälle wie U1**); `vorschau`-Texte für: Gruppe ja/nein (mit Namen), n Einzelchats/m neue, Hauptschalter aus, Nicht-Kontakte, leer; `vorgeschlageneGruppen` (höchstens 3, nur vollständig gewählte). |
| W7 | `state/chat.termine.test.ts` (Stil `chat.load.test.ts`, Mocks für `api`, `realtime`, `db`) | Trichter + Speicher: `aktualisiert` ersetzt `message.event` in **allen** Chats (auch nicht geöffneten) mit dieser `eventId`, lässt andere Nachrichten und Termine unberührt; ältere `stand` wird verworfen, gleiche/neuere übernommen; `entfernt` setzt `event` zurück; `cacheMessages` wird mit den geänderten Nachrichten aufgerufen; Wiederholung ist idempotent. |
| W8 | `lib/terminEreignisse.test.ts` | `sync.hint` mit `eventId` → ein Abruf (mehrfach gemeldet → einer), `403`/`404` → `entfernt`; Streuung per Fake-Zeitgeber. |
| W9 | `modules/calendar/einladung.test.ts` | `anlegenBody`: neue Anfrage enthält `zustellung` und `clientId`, **nie** `conversationId`/`announce`; `aendernBody`: ohne Einladungsänderung **weder** `attendeeIds` noch `zustellung`; `gruppenChatIds` fehlt, solange die Zustellung nicht geladen ist. |
| W10 | `modules/calendar/helpers.test.ts` (bestehend) | läuft unverändert (Regression). |

### 7.4 Browser (Playwright, `apps/web/e2e/einladen.spec.ts`)

Vier frische Konten über die API (Muster `termine.spec.ts`: `registrieren`, `seiteFuer`), **A** (Ersteller) und **B, C, D**; Gruppenchat **G = {A, B, C, D}**; ein fünftes Konto **E** ausserhalb aller Chats für die Verzeichnissuche. Je Konto eigener Browser-Kontext.

| ID | Test | Schritte und Erwartung |
|---|---|---|
| B1 | `die Personenliste steht ohne Suche da` | A öffnet „Neuer Termin“ (Kalender): ohne zu tippen stehen B, C, D mit Kontrollkästchen da, „0 von 3 Personen“; Suchfeld leer; ein nicht verbundener Konto E steht **nicht** in der Liste. |
| B2 | `Suche filtert, Alle und Niemand wirken` | „B“-Name tippen → Liste schrumpft sofort; Suchfeld leeren; „Alle“ → 3 Haken, „3 von 3“, **kein** Gruppen-Chip; „Niemand“ → 0; E über Suchfeld (≥ 2 Zeichen) erscheint unter „Weitere Personen auf diesem Server“ und ist wählbar. |
| B3 | `Gruppenchat wählt Mitglieder, einzelne abwählbar, Vorschau ehrlich` | „Gruppenchat …“ → G → B, C, D gewählt, Chip „4 von 4“ (A zählt als Ersteller), Vorschau „Gruppenchat G: Karte · 3 Einzelchats“; D abwählen → Chip „unvollständig – D fehlt“, Vorschau „Gruppenchat G: nein (D fehlt)“, Einzelchats „2“; D wieder wählen → „Karte“; Schalter „dort posten“ aus → Vorschau „nein (abgewählt)“. |
| B4 | `Zustellung stimmt mit der Vorschau überein` | (a) G vollständig, posten an → nach „Termin erstellen“ liegt je **eine** Karte in G und in den Chats AB, AC, AD (per API gezählt **und** in B's Browser sichtbar); (b) Termin 2 nur mit B, C (G nicht gewählt) → **keine** Karte in G, je eine in AB, AC, keine in AD. Toast nennt die Zahlen der Antwort. |
| B5 | `wer im Gruppenchat, aber nicht eingeladen ist, sieht den Termin nicht` | Termin 2 (B, C): D öffnet `/kalender/termin/<id>` → „Termin nicht gefunden“/„kein Zugriff“; D's Kalender enthält ihn nicht; in G steht keine Karte. Termin 1, danach C ausgeladen: C sieht in G „Termin nicht verfügbar“ **ohne** Titel im DOM-Text und ohne `eventId` in der Nachricht (über `page.evaluate` am Speicher). |
| B6 | `die Zusage gilt in allen Karten, live und ohne Neuladen` | Termin 1. B öffnet AB (Einzelkarte), A ist auf der Chatliste, C in G. B tippt „Ja“ in AB. C's Karte in G zeigt ohne Neuladen „… zugesagt“ hochgezählt; A öffnet danach G **und** AC: beide zeigen denselben Zählerstand wie B's Karte in AB (Text gleich, `toHaveText`); B's Karte in G zeigt „Ja“ aktiv. Dann Neuladen von A: unverändert. |
| B7 | `Bearbeiten: einladen und ausladen` | A bearbeitet Termin 2: D hinzufügen → in D's Browser erscheint live der neue Chat AD mit Karte; C entfernen → C's AC-Karte verschwindet live, C's `/kalender/termin/<id>` → kein Zugriff; Vorschau im Editor nannte „Neu eingeladen: 1 · Entfernt: 1“ vorher. |
| B8 | `Absagen und Löschen` | Termin 1 absagen → alle Karten zeigen „Abgesagt“, keine Zusageknöpfe, B's „Ja“ (API) → 409; Termin 2 (nach B7: Eingeladene B und D) löschen → die Karten in AB und AD stehen bei A und bei B bzw. D als „gelöscht“ da. |
| B9 | `375 Pixel, Tastatur, Screenreader-Namen` | Viewport 375×812: `document.documentElement.scrollWidth <= 375`; jeder Knopf/jede Zeile im Feld ≥ 44 px hoch; Tab-Reihenfolge durch Schnellwahl → Suche → Liste → Chips → Schalter; Bedienung **nur** mit Tastatur (Leertaste in Zeile, Enter im Gruppenfeld); `getByRole('group', {name:'Personen'})`, `getByRole('switch', {name:'Einladung im Chat senden'})`, `getByRole('status')` mit „n von m Personen“. |
| B10 | `die übrigen Nutzer der PersonenWahl funktionieren` | Bestehende Specs `expenses.spec.ts`, `files.spec.ts`, `termine.spec.ts` (Notiz-Rechte, „Alle auswählen“ dort) laufen grün. |

Laufanweisung (wie im Auftrag): Dev-Server neu starten (`vite-neu.sh … 5183`), API neu starten (`api-neu.sh`), dann
`npx playwright test -c …/pw/pw-main.config.ts e2e/einladen.spec.ts`. Der Push lässt sich im Browser nicht prüfen (Entwicklungsbetrieb ohne VAPID); dafür stehen U2/R8.

---

## 8. f) Abnahmekriterien (jedes mit Test)

| # | Kriterium | Test |
|---|---|---|
| AK1 | Unter dem Feld „Eingeladen“ steht **ohne Suche** die Liste aller Kontakte mit Kontrollkästchen, auch wenn niemand gewählt ist. | B1, W1 |
| AK2 | Die Suche **filtert** die Liste sofort; Verzeichnistreffer (≥ 2 Zeichen) ergänzen sie nur unter „Weitere Personen“. | B2, W2 |
| AK3 | „Alle“ wählt alle Kontakte (höchstens 200, sonst gesperrt mit Hinweis), „Niemand“ leert. | B2, W3 |
| AK4 | „Gruppenchat …“ wählt dessen Mitglieder; einzelne lassen sich abwählen; mehrere Gruppen sind möglich. | B3, W4 |
| AK5 | Sind **alle** Mitglieder eines gewählten Gruppenchats eingeladen: Karte im Gruppenchat **und** in den Einzelchats. | R1, B4 |
| AK6 | Sonst nur in den Einzelchats; der Gruppenchat bekommt nichts. | R2, B4 |
| AK7 | „Alle“ und zufällig vollständig gewählte Gruppen posten **nie** in einen nicht ausdrücklich gewählten Gruppenchat. | R3, W5, B3 |
| AK8 | Vor dem Senden zeigt die Vorschau, wohin die Einladung geht (Gruppenchats, Anzahl Einzelchats, neue Chats); das Posten in einen Gruppenchat ist abwählbar; Vorschau und Server stimmen überein. | W6, B3, B4, U1 |
| AK9 | Fehlende Einzelchats werden angelegt, vorhandene (auch archivierte) wiederverwendet, bei Dubletten der älteste; eine Person ohne Konto wird abgelehnt; alles in **einer** Transaktion. | R4, R18 |
| AK10 | Wer zu einem Gruppenchat gehört, aber **nicht** eingeladen ist, sieht den Termin **nirgends**: Liste, Detail, Zusage, Notizen, Dokumente, Ausgaben, Kalender-Abo, Rundruf, Karte (Platzhalter ohne Inhalt und ohne Kennung). | R5, B5 |
| AK11 | Eingeladene ausserhalb des Termin-Chats können ihren Termin öffnen und zusagen (Fehler S2/S6/S7b behoben). | R6, R15 |
| AK12 | Zu-/Absage an **einer** Stelle gilt **überall**: alle Karten, Detail und Kalender zeigen denselben Stand, live. | R7, B6 |
| AK13 | Eine Karte in einem **nicht geöffneten** Chat stimmt beim Zurückkehren ohne Neuladen; ältere Rundrufe überschreiben neuere nicht. | W7, B6 |
| AK14 | Jede Person bekommt **genau eine** Einladungs-Mitteilung, auch wenn die Karte in Gruppen- und Einzelchat steht; eine Stummschaltung wird beachtet. | U2, R8 |
| AK15 | Nachträgliches **Einladen** liefert Karte + Mitteilung nur an die Neuen; Bestehende werden nicht erneut eingeladen. | R9, B7 |
| AK16 | **Entfernen** beendet den Zugang sofort, löscht die Einzelkarte, lässt die Gruppenkarte stehen (für den Entfernten leer) und sendet dem Entfernten `event.deleted` mit Grund; Wiedereinladen geht. | R10, B5, B7 |
| AK17 | **Zeit-/Ortsänderung** erzeugt keine neue Einladung, aber eine Mitteilung je Teilnehmer (nicht an `no`, nicht an den Auslöser); Antworten bleiben. | R11, U5 |
| AK18 | **Löschen** entfernt Termin und alle Karten; Mitteilung nur an `yes`/`maybe`. | R12, B8 |
| AK19 | **Absagen** hält die Karten („Abgesagt“), sperrt Zusagen (409) und benachrichtigt; Wiederaufnehmen geht. | R13, B8 |
| AK20 | **Rückwärtsverträglich:** Anfrage ohne `zustellung` verhält sich wie vorher; Termin aus Umfrage und Terminfindung unverändert; Bestandstermine bleiben für dieselben Personen sichtbar. | R14, R15, M1 |
| AK21 | Fremde Termin-Karten (S12) verraten nichts; der Nachrichtenweg für `eventId` ist zu. | R16 |
| AK22 | **Doppelsenden** erzeugt keinen zweiten Termin und keine zweiten Karten/Mitteilungen; unvollständige Zustellung lässt sich nachliefern. | R17 |
| AK23 | Grenzen und deutsche Fehlertexte (200 Personen, 10 Gruppen, Mitgliedschaft, Art des Chats, Berechtigung, Drossel). | R18, R20 |
| AK24 | Bei 150 Eingeladenen bleibt das Anlegen zügig; Phase 1 führt für 20 und 150 Personen gleich viele Anweisungen aus (keine Abfragen je Person). | R19 |
| AK25 | Live-Zusagen gehen auch bei Nutzlasten über 7000 Byte nicht verloren (Bus stückelt, Hinweis trägt die Termin-Kennung, Client lädt nach). | U4, W8 |
| AK26 | Die Migration 0023 ist **idempotent**, füllt Teilnehmer und Karten rück und ändert bei zweitem Lauf nichts. | M1 |
| AK27 | Bedienbarkeit: nur Tastatur, Screenreader-Namen, Live-Zähler, 375 px ohne seitliches Scrollen, Tippflächen ≥ 44 px, Lade-/Leer-/Fehlerzustände. | B9 |
| AK28 | `PersonenWahl` und ihre sechs anderen Nutzer sind unverändert. | B10, `tsc`, W10 |
| AK29 | Client und Server rechnen dieselbe Zustellung (gemeinsame Testfälle). | U1, W6 |
| AK30 | Nur der Ersteller ändert Einladungen; Gruppen-Admins ändern Inhalt nur als Teilnehmer mit Gruppenkarte. | R20 |

---

## 9. g) Verworfene Alternativen

| Alternative | Warum verworfen |
|---|---|
| „Verfügbar“ = **alle Konten des Servers**, seitenweise | Würde das Verzeichnis als Liste öffnen; die Suche ist bewusst gedrosselt (60/Minute, `modules/users.rs`), damit sich niemand das Verzeichnis abholt. Vor allem machte es „Alle“ zu „alle auf dem Server“ – eine Einladung an Fremde samt neuem Einzelchat mit jedem. Die Suche erreicht jeden einzeln weiterhin. Wiederaufgreifen, falls der Betreiber ein geschlossenes Verzeichnis will: Schalter in `Config`, Endpunkt `GET /users/kontakte` (Seite 100, Sortierung „gemeinsame Chats zuerst, dann alphabetisch“). |
| Endpunkt `GET /users/kontakte` (serverseitig, seitenweise) **jetzt** | Löst nur, was der Chat-Speicher nicht hat (archivierte Chats, > 300 Chats); kostet einen Endpunkt, Tests, Drossel und Doku und zeigt keine neue Information. Die Liste ist lokal sofort da und arbeitet offline. Schwelle zum Umstieg: Nutzer melden fehlende Kontakte. |
| Gruppenchat **automatisch** wählen, wenn alle Mitglieder gewählt sind | „Alle“ postete in jeden Gruppenchat (und in manche, in denen der Ersteller nie posten wollte); die Oberfläche könnte nichts mehr abwählen, ohne Personen abzuwählen. Stattdessen: ausdrücklich plus Vorschlags-Chip. |
| Gruppenkarte **löschen**, sobald jemand entfernt wird | Bei Zustellung nur in die Gruppe verlören alle anderen ihre einzige Karte. Stattdessen bleibt sie, der Server kürzt die Fassung für Nicht-Eingeladene. |
| Einzelkarte des Entfernten **als Platzhalter** stehen lassen | Der Ersteller sähe dort eine volle Karte, der Entfernte eine leere: zwei Wahrheiten in einem Chat. |
| Mehrere Karten über **`message.updated`** nachführen wie bei Umfragen (`broadcast_poll`) | Spielt jeder Karte den Stand **des Absenders** an alle Mitglieder aus (Leck, Fund 1) und lässt die Chatliste auf alte Karten springen (`state/chat.ts:384-388`). `event.updated` an Teilnehmer + Client-Trichter ist billiger und trifft auch Karten ohne Platzierungszeile. |
| **Ein** Feld `message_ids` am Termin | Keine Art, keine Person, keine Abfrage nach Chat; Löschen/Nachliefern/Erinnern müssten die Liste parsen. |
| Karten im **Modus „alt“** ebenfalls in Einzelchats senden | Bricht „bisherige Anfragen verhalten sich wie vorher“ und überschwemmt ältere Client-Stände (PWA-Cache) mit Einzelchats, die sie nicht erwarten. |
| Sichtbarkeit **weiter** über Chatmitgliedschaft **oder** Teilnahme, nur Abwahl merken (`ausgeschlossen`-Liste) | Zwei Quellen der Wahrheit, jede Stelle aus 4.9 müsste beide kennen; „Wer ist eingeladen“ hiesse `(Mitglieder − Ausgeschlossene) ∪ Teilnehmer` – und Spätbeitritte sähen alte Termine weiter. |
| Alles in **einer** Transaktion inklusive Nachrichten | `create_message` nutzt den Pool, ist der Einstieg für Rundruf und Push und nicht transaktionsfähig; ein Umbau betrifft jeden Nachrichtenweg. Zwei Phasen mit Reservierung geben dasselbe Ergebnis (nichts geht verloren, nichts doppelt). |
| Hintergrund-Zusteller (Warteschlange) | Es gibt keinen Dienst für Termine (`tokio::spawn` nur in Medien/Auslagern/Müll); Phase 2 im Antwortpfad (begrenzt parallel) ist bei ≤ 200 Personen Sekunden, nicht Minuten, und liefert eine ehrliche Antwort. Thema 22 baut ohnehin den periodischen Dienst. |
| `event.rsvp`-Delta-Ereignis (klein) statt voller `event.updated` | Zweiter Weg neben dem ersten; ältere Clients kennen ihn nicht und verlören Live-Zusagen. Der Hinweis mit Kennung + Stückelung löst das Grössenproblem ohne neuen Ereignistyp. |
| Antworten nach Zeit-/Ortsänderung auf „offen“ zurücksetzen | Löscht Information, löst bei jedem Tippfehler-Korrektur eine Antwortwelle aus und kollidiert mit dem Erinnern. |
| Push „Du wurdest ausgeladen“ | Stille ist der freundlichere Weg; wer nachsieht, findet die Karte weg. |
| **Testbibliothek** für Komponenten (Testing Library) | Neue Abhängigkeit verboten; Logik liegt in reinen Modulen, Zusammenspiel in Playwright. |
| `PersonenWahl` erweitern | Sechs weitere Nutzer mit anderem Modell; Regressionsrisiko; eigene Komponente ist kleiner als die Fallunterscheidung darin. |
| Teilnehmerliste vor den Eingeladenen **verbergen** | Nicht gefordert; Änderung der Sichtbarkeit innerhalb des Termins (heute sehen alle Teilnehmer alle Antworten). Die Vorschau sagt es ehrlich; als Folgearbeit vermerkt. |

---

## 10. Umsetzungsreihenfolge, Schnitte und Dateien

**Paket 1 – Sichtbarkeit und Fundamente (Rust).** Migration 0023; `is_attendee`, `assert_visible`, `assert_editable`, `load_events_for_user`, `zugriff.rs` (2 Stellen), `attendee_count`; `EventExpander`; Kürzen in `hydrate_messages`/`ausspielen`; `send_message` zu; Tests R5, R6, R16, M1. *Commit:* „Termine: Sichtbarkeit hängt nur an der Einladung, nicht am Chat“.
**Paket 2 – Karten und Einzelchats.** `event_placements`-Zugriff; `einzelchats_sichern` (+ `find_direct_conversation` mit Reihenfolge, Handler nutzt den Dienst); `einladen::planen`; `create_event` in zwei Phasen, `zustellung`, `clientId`, `TerminAntwort`, Modus „alt“ trägt Karten ein; `NewMessage::einladung`; Drossel; Tests U1, U3, R1–R4, R14, R15, R17, R18, R19. *Commit:* „Termine: Einladung in Gruppen- und Einzelchats mit Plan und Vorschau“.
**Paket 3 – Benachrichtigungen, Ändern, Löschen, Absagen.** `benachrichtige_termin`, `push_ziel`, Mitschnitt; `PATCH`-Diff (Einladen/Ausladen/Gruppen), Ausladen-Route, `zustellung`/`nachliefern`, Löschen mit Karten, Absagen/`409`; Tests U2, U5, R8–R13, R20. *Commit:* „Termine: eine Benachrichtigung je Person, Ändern, Absagen, Löschen mit Karten“.
**Paket 4 – Echtzeit.** `melde_termin` mit `stand`; Bus-Stückelung und Hinweis mit Kennung; `event.deleted` mit Grund; Tests U4, R7. *Commit:* „Echtzeit: Termin-Stand, gestückelte Empfängerliste, Hinweis mit Kennung“.
**Paket 5 – Client-Grundlage.** `packages/shared` (Typen, Schema, `zustellung.ts`, Testfälle), `lib/api.ts`, `lib/terminEreignisse.ts`, `state/chat.ts`, Hooks; Tests W7, W8, shared-Test. *Commit:* „Termin-Karten bleiben in allen Chats synchron“.
**Paket 6 – Oberfläche.** `einladung.ts` (+ W1–W6, W9), `EinladungsWahl.tsx`, `EventEditor.tsx`, `EventDetailScreen.tsx`, `EventBubble.tsx`, `KalenderScreen.tsx`, `styles.css`; Playwright B1–B10. *Commit:* „Termine: Personenliste, Schnellwahl und Sende-Vorschau im Editor“.
**Paket 7 – Doku.** `docs/API.md` (Tabelle Zeilen 477–488 + neue Routen + Felder), `docs/FEATURES.md` (Einladen, Absagen), `docs/SICHERHEIT.md` (Sichtbarkeit von Terminen), `docs/DEPLOYMENT.md` (Migration 0023, Laufzeit Schritt 6, Bus-Hinweis). *Commit:* „Doku: Einladen, Sichtbarkeit, Migration 0023“.

Jeder Schnitt muss für sich `cargo clippy --all-targets -- -D warnings`, `cargo test` (bzw. die betroffenen Dateien), `npx tsc -p tsconfig.json --noEmit`, `prettier --check` und die betroffenen Tests bestehen. Die Pakete 1–4 ändern das Verhalten **nur** für Anfragen mit `zustellung` und für die Sichtbarkeit; Paket 6 schaltet die Oberfläche auf den neuen Modus.

Weitere anzupassende Stellen: `apps/api/src/db.rs` (`CalendarEventRow.stand`/`client_id`, `EventAttendeeRow.eingeladen_am`), `apps/api/src/dto.rs` (`CalendarEventDto.stand`, `ZustellungDto`), `apps/api/src/bin/seed.rs:121` (`NewEvent` bekommt die neuen Felder), `modules/polls.rs:384`, `modules/calendar.rs:672` (Felder mit Vorgabewerten), `apps/api/src/services/mod.rs` (Modul `einladen`), `docker-compose.yml` unberührt.

---

## 11. Risiken und offene Punkte

1. **Sichtbarkeit ändert sich für spät Beigetretene.** Wer **nach** dem Einspielen einer Gruppe beitritt, sieht ältere Termine nicht mehr (Detail, Notizen, Unterlagen). Beabsichtigt (R1), laut Kommentar in `services/events.rs:43` früher ebenso beabsichtigt, aber **andersherum** – in `docs/FEATURES.md` und `docs/SICHERHEIT.md` ausdrücklich nennen (ein Änderungsprotokoll gibt es im Repository nicht). Gemeinsame Gruppen-Ausgaben mit Sichtbarkeit `conversation` bleiben für Ausgeladene sichtbar (eigene Regel der Ausgabe).
2. **Merge-Konflikte** mit den parallelen Themen „Ort als Adresse“ (Ortsfeld in `EventEditor.tsx`, Anzeige in `EventBubble.tsx`/`EventDetailScreen.tsx`) und „Sammlung verknüpfen“ (`EventCollection.tsx`, `EventEditor`): Der Entwurf hält seine Änderungen in `EventEditor.tsx` auf **einen zusammenhängenden Block** (Chat/Eingeladen/Ankündigen/`save()`-Nutzlast); `EventBubble` bekommt nur Zustandszweige. Vor dem Zusammenführen diese drei Dateien zuerst abgleichen.
3. **Einzelchats als neuer Nebenkanal.** Kein Blockieren im Bestand. Mitigation: Drossel (`EINLADEN`, `EINZELCHATS_NEU`), Obergrenze 200, Hinweis in der Vorschau, Schalter „Einzelchats“. Offen: Soll es eine Sperrfunktion geben? (`einzelchats_sichern` ist dafür die eine Stelle.) Die Drossel ist je Instanz (wie `drossel.rs` begründet).
4. **Bus bei > 70 Eingeladenen auf Postgres.** Ohne Paket 4 gehen Live-Zusagen verloren; mit Paket 4 fragen viele Geräte nach einem Hinweis nach (Streuung eingebaut). Mit `REALTIME_BUS=memory` tritt es nicht auf. Die Empfängerstückelung ändert gemeinsam genutzten Code (`realtime/bus.rs`) – Test U4 schützt.
5. **Push nicht messbar in der Entwicklung** (kein VAPID). Die Zielbestimmung ist rein (U2), der Versand über den Mitschnitt (R8) geprüft; das Verhalten auf echten Geräten (Ersetzen per `tag`, Unterdrücken bei offenem Chat) bleibt ein manueller Test vor der Veröffentlichung.
6. **Tombstones.** Ausladen und Löschen lassen im Einzelchat „Diese Nachricht wurde gelöscht“ zurück (wie jede gelöschte Nachricht). Wer das stört, braucht später ein „Nachricht ohne Spur entfernen“ für alle Nachrichtenarten – nicht Teil dieses Entwurfs.
7. **`event.ics` bleibt Kennung-als-Berechtigung.** Wer eine Termin-Kennung kennt (Link, früherer Zugang), liest den Termin ohne Anmeldung. Der Entwurf verhindert, dass neue Nicht-Eingeladene an die Kennung kommen; ein signierter, ablaufender Link wäre die Härtung (eigenes Thema).
8. **Teilnehmerliste ist für alle Eingeladenen sichtbar** (`CalendarEventDto.attendees`): Wer über Einzelchats Fremde einlädt, offenbart ihnen gegenseitig ihre Namen und Antworten. Die Vorschau sagt es; ein Schalter „Liste verbergen“ wäre eine Folgearbeit (Sichtbarkeit je Betrachter bräche die Ein-Nutzlast-Verteilung).
9. **Migration:** Schritt 6 liest `messages` sequentiell, Schritt 3 sperrt `calendar_events` kurz. Der Fremdschlüssel-Tausch in Schritt 3 läuft einmal; bei einem wieder eingespielten alten Stand der Anwendung bleibt alles lauffähig (alte Spalten unverändert, nur der Chat reisst den Termin nicht mehr mit).
10. **Alte Clients im Cache:** senden Anfragen im Modus „alt“ (keine Einzelkarten), kennen `stand`/`grund`/`eventId` im Hinweis nicht (ignorieren sie), zeigen für gekürzte Karten „Termin nicht verfügbar“ (die vorhandene Zweigfolge trägt das). Ein alter Client, der **PATCH mit `attendeeIds`** sendet, löst jetzt Einzelkarten + Mitteilungen aus (gewollt).
11. **Gleichzeitiges Anlegen von Einzelchats** (auch aus `POST /conversations`) ohne gemeinsamen Schlüssel kann weiterhin Dubletten erzeugen; der Dienst sperrt pro Paar; der Handler `POST /conversations` sperrt erst, sobald er ab Paket 2 denselben Dienst nutzt. Es gibt weiter **keinen** Unique-Index für das Paar (nicht einfach auszudrücken); `find` wählt deterministisch den ältesten.
12. **Geteilte Entwicklungsdatenbank:** Die Rust-Tests legen eigene Konten mit Zufallsnamen an (kein Schema je Test nötig); nur M1 braucht ein eigenes Schema (wie `migrationen.rs`). R19(b) misst Laufzeit – auf langsamer Hardware die Grenze grosszügig halten; R19(a) zählt Anweisungen und ist davon unabhängig.
13. **Was dieser Entwurf bewusst nicht tut:** Erinnerungen (Thema 22), Karten für Abstimmende aus `confirm_event` (sie können jetzt öffnen, bekommen aber keine neue Einzelkarte), Zeitzonen im Servertext, Sichtbarkeit der Teilnehmerliste je Betrachter, Sperrfunktion, `event.ics`-Härtung.

### Offene Entscheidungen für den Auftraggeber (mit Empfehlung)

* Soll **Absagen** jetzt mit umgesetzt werden (Paket 3, klein, löst „Löschen/Absagen“ und die Abbruchbedingung für Thema 22)? Empfehlung: ja. Weglassen spart nur `status` im PATCH und den Kartenzweig.
* **Vorbelegung „Einzelchats an“** beim Termin aus dem Gruppenchat (30 Mitglieder → 30 Einzelkarten)? Empfehlung: an (entspricht dem Wunsch), mit sichtbarem Schalter und der Zahl in der Vorschau.
* **Spalten-/Schreibweise** `eingeladen_am` (hier) gegen `eingeladen_at` (Erinnerungsentwurf): eine wählen.
