# API-Verträge: Termine – Einladen (für die Oberfläche)

Stand: Hauptbaum `/home/user/Initiative`, Zweig `claude/initiative-pwa-messenger-4b5ms6`, nach Teil 1 (API und Datenbank).
Alles hier ist **gebaut und getestet** (`apps/api/tests/einladen*.rs`, Lauf gegen Port 8080: `einladen-neu-lauf.mjs`, 55/55).
Die Typen stehen im gemeinsamen Paket (`packages/shared`): `CalendarEventDto.stand`, `ZustellungDto`, `TerminAntwort`,
`ZustellungStandDto`, `zustellungSchema`, `zustellungAendernSchema`, `createEventSchema` (+ `zustellung`, `clientId`),
`updateEventSchema` (+ `zustellung`, `status`), `event.deleted.grund`, `sync.hint.eventId`, die Grenzen in `LIMITS`
(`einladungenMax` 200, `einladungGruppenMax` 10, `eventClientIdMax` 64) und die **Vorschau-Rechnung**
`zustellungPlanen` (`util/zustellung.ts`, dieselben Testfälle wie der Server: `testdaten/zustellung.json`).

Alle Pfade mit Präfix `/api/v1`. Alle Fehler: `{ "error": { "code", "message", "details"? } }`, `message` deutsch.

---

## 1. Die Regeln in einem Absatz

Wer den Termin sieht, bestimmt **allein die Teilnehmerliste** (plus Ersteller). Ein Chat, in dem eine Karte steht, verleiht **keinen** Zugang.
Eine **Karte** ist eine `event`-Nachricht, die den Termin *anzeigt*: im Gruppenchat (`gruppe`) oder im Einzelchat Ersteller ↔ Person (`einzel`).
Wer nicht eingeladen ist, bekommt überall `404` (Detail, Zusage, Notizen, Dokumente, Vorkommen, Ausgaben), sieht den Termin nicht in Liste und Kalender-Abo
und sieht eine Karte in seinem Chat **ohne** `event` und **ohne** `metadata.eventId` („Termin nicht verfügbar“).

**Wohin die Einladung geht** (beim Anlegen; beim Ändern nur für die neu Hinzugefügten):

| Karte | Wann |
|---|---|
| Einzelkarte je eingeladener Person | `senden && einzelchats` |
| Gruppenkarte in Gruppenchat G | G steht **ausdrücklich** in `gruppenChatIds` **und** `senden` **und** alle Mitglieder von G (ausser dem Ersteller) sind eingeladen |

Nie in einen Gruppenchat, der nicht ausdrücklich gewählt wurde – „Alle“ wählt Personen, **keinen** Gruppenchat.
Fehlt der Einzelchat, legt ihn der Server an (in derselben Transaktion wie der Termin).

---

## 2. Anlegen: `POST /calendar/events`

```jsonc
{
  "title": "Grillen", "startsAt": "2026-10-04T16:00:00Z", "endsAt": "2026-10-04T20:00:00Z",   // wie bisher
  "location": "…", "description": "…", "allDay": false, "rrule": null, "color": null, "reminderMinutes": [60],

  "attendeeIds": ["uuid", "…"],        // MIT zustellung: die VOLLE Liste, ohne mich; leer = niemand. Höchstens 200.
  "zustellung": {                      // Fehlt dieses Feld: alter Weg (siehe unten)
    "senden": true,                    // false: niemand bekommt Karte oder Mitteilung; nur Kalender. Vorgabe true
    "einzelchats": true,               // Karte in die Einzelchats. Vorgabe true
    "gruppenChatIds": ["uuid"]         // höchstens 10, nur Gruppenchats, in denen ich Mitglied bin. Vorgabe []
  },
  "clientId": "uuidv7"                 // optional, höchstens 64 Zeichen: Wiederholungsschutz
}
```

**Antwort** `201` (bei Wiederholung mit gleicher `clientId`: `200`) – der Termin auf oberster Ebene, dazu:

```jsonc
{
  "id": "…", "conversationId": "G-oder-null", "stand": 2, "attendees": [ … ], "…": "…",
  "zustellung": {
    "gruppen":          [{ "conversationId": "G", "nachrichtId": "uuid-oder-null" }], // alle Gruppenkarten, die jetzt stehen
    "einzelchats":      7,   // Einzelkarten, die DIESE Anfrage zugestellt hat
    "neueEinzelchats":  2,   // davon Chats, die dafür neu angelegt wurden
    "ausgelassen":      [{ "conversationId": "G2", "fehlend": ["uuid", "…"] }],  // gewünscht, aber nicht alle Mitglieder eingeladen (höchstens 5 Kennungen)
    "ausstehend":       0,   // reservierte Karten ohne Nachricht (Teilausfall) → nachliefern
    "benachrichtigt":   7    // Personen, denen eine Mitteilung ging (0, wenn der Server keinen Push hat)
  }
}
```

* `conversationId` des Termins = der **erste Gruppenchat mit Karte**, sonst `null` (auch bei vielen Einzelkarten). Nie ein Zugang.
* `ausgelassen` ist **kein Fehler**: Der Server erzwingt dieselbe Regel, die die Vorschau (`zustellungPlanen`) schon vorher zeigt.
* Die Person selbst in `attendeeIds` wird still ignoriert, Doppelte zusammengeführt. Der Ersteller ist immer dabei (Antwort `yes`).
* **Alter Weg** (Feld `zustellung` fehlt; ältere App-Stände, „Termin aus Umfrage“, Terminfindung): `conversationId` bestimmt den Chat,
  alle seine Mitglieder werden eingeladen, **eine** Karte kommt dorthin (`announce`), sonst nichts. Die Antwort hat **kein** `zustellung`.
  Mit `zustellung` wird `conversationId` nicht gelesen; ist er gesetzt und steht nicht unter `gruppenChatIds` → `400`.

**Wiederholungsschutz:** `clientId` beim Öffnen des Blatts mit `uuidv7()` erzeugen und für alle Wiederholungen **derselben Eingabe** behalten.
Die zweite Anfrage liefert `200` mit dem vorhandenen Termin (und `zustellung` aus dem Stand der Tabelle) – ohne neue Karten, ohne zweite Mitteilung.
Der Schlüssel bleibt auch nach dem Löschen des Termins vergeben (`409 Dieser Termin wurde bereits gelöscht`).

**Vorbelegungen der Oberfläche** (Regel des Anwenders, alles sichtbar und abwählbar):
aus dem Composer im **Gruppenchat**: `attendeeIds` = alle Mitglieder ohne mich, `gruppenChatIds: [Chat]`, `einzelchats: true`;
aus einem **Einzelchat**: `attendeeIds: [Gegenüber]`; sonst niemand gewählt.

---

## 3. Ändern: `PATCH /calendar/events/{id}`

Alle Felder optional (`null` löscht `description`/`location`/`rrule`/`color`, fehlend = unverändert). Zusätzlich zu den bisherigen:

```jsonc
{
  "attendeeIds": ["uuid", "…"],   // SOLLZUSTAND der Eingeladenen ohne Ersteller. Wer fehlt, wird ausgeladen.
  "zustellung": {
    "senden": true,               // gilt für die NEU Hinzugefügten dieser Anfrage (und neue Gruppen). Vorgabe true
    "einzelchats": true,          // dito. Vorgabe true
    "gruppenChatIds": ["uuid"]    // SOLLZUSTAND der Gruppenkarten. FEHLT das Feld: unverändert!
  },
  "status": "cancelled"           // oder "confirmed" (Absagen / Wiederaufnehmen)
}
```

**Antwort** `200`: der Termin; `zustellung` (wie oben) nur, wenn `attendeeIds` **oder** `zustellung` gesendet wurde.
Zustellung-Zahlen beziehen sich auf diese Anfrage; `gruppen` zeigt alle Gruppenkarten, die jetzt stehen.

Was geschieht:

* **Hinzugefügte** (in `attendeeIds`, vorher nicht eingeladen): Teilnehmerzeile (`eingeladen_am` = jetzt), Einzelkarte (neuer Einzelchat, falls nötig), **eine** Mitteilung – und nur sie.
  Bestehende Teilnehmer bekommen weder neue Karte noch neue Mitteilung. Mit `zustellung.senden: false` kommen sie nur in den Kalender.
* **Entfernte**: Zugang endet **sofort** (`404` auf allem). Ihre **Einzelkarte wird gelöscht** (`message.deleted` an Ersteller und Person).
  Eine **Gruppenkarte bleibt** stehen (sonst verlören die anderen Mitglieder ihre einzige Karte) und zeigt dem Entfernten nichts.
  Er bekommt `event.deleted` mit `grund: "ausgeladen"`, **keine** Mitteilung.
* **`gruppenChatIds`**: neu in der Liste → Karte (wenn alle Mitglieder eingeladen, sonst unter `ausgelassen`); nicht mehr in der Liste → Gruppenkarte gelöscht.
  Bestehende Karten bleiben, auch wenn inzwischen Mitglieder fehlen.
  **Der Editor darf `gruppenChatIds` erst senden, wenn er `GET …/zustellung` (unten) geladen hat** – sonst wählte er bestehende Karten versehentlich ab.
* **Zeit/Ort** (`startsAt`, `endsAt`, `allDay`, `rrule`, `location`; nicht der Titel): keine neue Einladung, keine neue Karte, die Karten zeigen den neuen Stand;
  **eine** Mitteilung je Teilnehmer ausser Auslöser, Antwort `no` und den gerade erst Eingeladenen („… – Zeit geändert“ / „Ort geändert“ / „Zeit und Ort geändert“),
  gedrosselt auf **3 je 10 Minuten und Termin** (weitere werden still in die Karten geschrieben). Bestehende Antworten **bleiben**.
* **Absagen** (`status: "cancelled"`): Termin bleibt, Karten bleiben und zeigen `event.status === 'cancelled'` („Abgesagt“), **Zusagen sind gesperrt** (`409`),
  Mitteilung an alle ausser Auslöser und `no`. `status: "confirmed"` nimmt ihn wieder auf (keine zweite Mitteilung). Ein Termin in Abstimmung (`planning`) lässt sich nicht absagen (`400`).

**Wer darf was**

| | Ersteller | Gruppen-Admin (eingeladen, Gruppenkarte seines Chats) | übrige Eingeladene |
|---|---|---|---|
| Inhalt, Zeit, Ort, Titel ändern, Absagen, Löschen | ja | ja | `403` |
| Einladungen ändern (`attendeeIds`, `zustellung`), Ausladen, `…/zustellung` | ja | `403` „Nur wer den Termin angelegt hat, kann Einladungen ändern“ | `403` |
| Zusagen | ja | ja | ja |

Die Oberfläche blendet „Einladungen ändern“ nur für den Ersteller ein (`EventDetailScreen`: `isCreator`).

### Detailseite: „Jemanden einladen“

`PATCH { "attendeeIds": [bisherige (ohne mich) ∪ neue], "zustellung": { "senden": true, "einzelchats": true } }`. Antwort mit `zustellung.benachrichtigt` (Anzahl).

### Ausladen einer Person: `DELETE /calendar/events/{id}/attendees/{userId}`

Nur Ersteller (`403` sonst), nicht sich selbst (`400`). Antwort wie `PATCH` (Termin + `zustellung`). Dieselbe Wirkung wie oben „Entfernte“.

---

## 4. Löschen: `DELETE /calendar/events/{id}` → `204`

Ersteller oder Gruppen-Admin (siehe Tabelle). Termin **und alle Karten** sind weg: Die Nachrichten werden als gelöscht markiert (wie jede gelöschte Nachricht:
„Diese Nachricht wurde gelöscht“), `message.deleted` je Karte an deren Empfänger, `event.deleted { grund: "geloescht" }` an alle Teilnehmer.
Mitteilung „📅 Entfällt: …“ nur an Teilnehmer mit Antwort `yes`/`maybe` (nicht an den Auslöser).
**Absagen** ist der freundliche Weg, **Löschen** der Aufräumweg (Test-Termin, Vertipper): In der Oberfläche beides nebeneinander beschriften.

---

## 5. Zusagen: `POST /calendar/events/{id}/rsvp` → `200` Termin

Unverändert im Körper (`{ status }`). Nur Ersteller/Eingeladene (sonst `404`); bei abgesagtem Termin `409` „Der Termin ist abgesagt.“
Eine Zusage in **irgendeiner** Karte, am Termin oder im Kalender ist **dieselbe Operation** und wirkt überall.

---

## 6. Wo steht der Termin? `GET /calendar/events/{id}/zustellung` (nur Ersteller)

```jsonc
{ "gruppen": [{ "conversationId": "G", "nachrichtId": "uuid-oder-null" }],
  "einzelNutzerIds": ["uuid"],   // wer schon eine Einzelkarte hat
  "ausstehend": 0 }
```

Der Editor füllt daraus beim Bearbeiten die Gruppen-Chips und weiss, wer schon eine Einzelkarte hat.
Bis die Antwort da ist: Platzhalterzeile und `gruppenChatIds` **nicht** mitschicken.

## 7. Nachliefern: `POST /calendar/events/{id}/zustellung/nachliefern` (nur Ersteller) → `200` Termin + `zustellung`

Legt fehlende Nachrichten zu reservierten Karten an (idempotent; ein zweiter Aufruf legt nichts an). Die Person, deren **erste** Karte jetzt ankommt, bekommt ihre Einladungs-Mitteilung
(`zustellung.benachrichtigt`). Anlass: `zustellung.ausstehend > 0` in der Antwort von Anlegen/Ändern → Toast „Termin gespeichert – N Einladungen konnten nicht zugestellt werden.“ mit Knopf „Erneut zustellen“.

---

## 8. Die Karte in der Nachrichtenliste

`message.type === 'event'`, `message.metadata.eventId`, `message.event` (der Termin **aus Sicht des Betrachters**).

| Zustand | Erkennbar an |
|---|---|
| normal | `event` gesetzt, `event.status` `confirmed`/`planning` |
| abgesagt | `event.status === 'cancelled'` → „Abgesagt“, durchgestrichener Titel, keine Zu-/Absage-Knöpfe |
| nicht verfügbar (nicht eingeladen, ausgeladen, Termin weg) | **`event` fehlt und `metadata.eventId` fehlt** → „Termin nicht verfügbar“ |
| gelöscht | `deletedAt` gesetzt → „Diese Nachricht wurde gelöscht“ |

Die Kennung ist nie im Verlauf, wenn der Betrachter nicht Teilnehmer ist (mit ihr liefert `event.ics` den ganzen Termin ohne Anmeldung).
**Der Server sendet nie `message.updated` für Terminkarten.** Die Karten ziehen ihren Stand aus `event.updated` (siehe 9); das ist die Aufgabe des Client-Trichters.

`POST /conversations/{id}/messages` mit `type: "event"` oder `metadata.eventId` ist **`400`** „Termin-Karten legt nur die Termin-Funktion an.“ – Karten legt nur der Server an.

---

## 9. Echtzeit

| Ereignis | Empfänger | Nutzlast | Zweck |
|---|---|---|---|
| `event.updated` | **Teilnehmer** (nicht mehr Chatmitglieder) und Ersteller | `{ event }` mit `event.stand` | alle Karten, Detail, Kalender nachführen |
| `event.deleted` | bei Löschen: alle Teilnehmer; bei Ausladen: die Entfernten | `{ eventId, conversationId, grund }` – `grund`: `"geloescht"` \| `"ausgeladen"` | Termin loslassen; bei `ausgeladen`: „Du bist nicht mehr zu diesem Termin eingeladen.“ (nur in der laufenden Sitzung) |
| `message.new` | Mitglieder des Chats; **Nicht-Teilnehmer in gekürzter Fassung** (ohne `event`, ohne `metadata.eventId`) | `{ message }` | Karte erscheint live |
| `message.deleted` | die Empfänger der gelöschten Karte | `{ conversationId, messageId }` | gelöschte Karten verschwinden |
| `conversation.updated` | beide Mitglieder jedes neu angelegten Einzelchats – **vor** der Karte | `{ conversation }` | Chat erscheint in der Liste des Gegenübers |
| `sync.hint` | wie das Ereignis, das zu gross für den Bus war | `{ scope, conversationId?, eventId? }` | Termin-Rundruf: `eventId` → `GET /calendar/events/{id}` (`403`/`404` → wie `event.deleted`); Nachricht: `conversationId` → Nachrichten neu laden |

**Reihenfolge – `stand`:** Jede Änderung (auch Zu- und Absagen) zählt `stand` hoch; jede `event.updated`/REST-Antwort trägt ihn.
**Der Client nimmt nur Fassungen mit `stand >=` dem bekannten** und verwirft Ältere – Rundrufe können einander überholen.
Antworten von `POST`/`PATCH`/`rsvp`/`confirm`/`DELETE attendees` tragen den frischen Stand. Antworten von Routen, die nur „melden“ (Sammlung verknüpfen, Notizen, Dokumente)
können einen Stand tragen, der **um eins hinter dem folgenden Rundruf** liegt – nimm das Maximum, nie ersetzen nach Ankunftsreihenfolge.

Mit `REALTIME_BUS=postgres` (auch der Dev-Server) kommt bei grossen Terminen (etwa ab 70 Eingeladenen) zum vollen Rundruf **zusätzlich** ein `sync.hint` mit `eventId`
(der Bus kürzt; lokale Sockets bekommen die volle Nutzlast, entfernte den Hinweis). Der Client muss beides verkraften: Ein Hinweis auf einen Termin, dessen Stand er schon hat, ist ein No-op
(Streuung 0–800 ms beim Nachladen, damit 100 Geräte nicht gleichzeitig fragen).

---

## 10. Mitteilungen (Web-Push)

Genau **eine** Einladungs-Mitteilung je Person, gleich in wie vielen Chats ihre Karte steht (Karten sind stumm). Gewählt wird der Einzelchat, sonst der erste Gruppenchat mit Karte,
**nie ein von der Person stummgeschalteter Chat**; sind alle stumm, kommt keine. `settings.notifications.push` und `.previews` werden beachtet.

| Anlass | `title` | `body` | `url` | `tag` | `kind` |
|---|---|---|---|---|---|
| Einladung | Name des Erstellers | „📅 Einladung: {Titel}“ | `/chats/{gewählter Chat}` (+ `conversationId`, `messageId` der Karte) | `termin:{id}` | `event` |
| Zeit/Ort geändert | Name des Bearbeiters | „📅 {Titel} – Zeit geändert“ / „Ort geändert“ / „Zeit und Ort geändert“ | `/kalender/termin/{id}` | `termin:{id}` | `event` |
| Abgesagt | Name des Bearbeiters | „📅 Abgesagt: {Titel}“ | `/kalender/termin/{id}` | `termin:{id}` | `event` |
| Gelöscht | Name des Bearbeiters | „📅 Entfällt: {Titel}“ | `/kalender` | `termin:{id}` | `event` |

Ohne Vorschau: `title` „Initiative“, `body` „Neue Einladung“ bzw. „Terminänderung“. Gleiches `tag` ersetzt eine frühere Mitteilung zum selben Termin.
Keine Mitteilung: an den Auslöser, an Personen mit Antwort `no` (Änderung/Absage), beim Ausladen, bei `senden: false`.
Im Entwicklungsbetrieb ist Push aus (`/healthz` → `push: false`): `zustellung.benachrichtigt` ist dann `0`.

---

## 11. Fehlerfälle (Text wörtlich)

| Fall | Status | `error.message` |
|---|---|---|
| mehr als 200 Eingeladene | 400 | Zu viele Eingeladene (höchstens 200). |
| unbekannte Kennung unter `attendeeIds` | 400 | Unbekannte Personen unter den Eingeladenen. |
| mehr als 10 `gruppenChatIds` | 400 | Zu viele Gruppenchats (höchstens 10). |
| Einzelchat unter `gruppenChatIds` | 400 | Nur Gruppenchats lassen sich als Ziel wählen. |
| Gruppenchat, in dem ich nicht Mitglied bin | 403 | Du bist kein Mitglied dieses Chats |
| Gruppenchat, den es nicht gibt | 404 | Chat nicht gefunden |
| `conversationId` neben `zustellung`, nicht unter den Gruppen | 400 | Bei „zustellung“ bestimmen die Gruppenchats den Chat des Termins. |
| Einladungen ändern, aber nicht Ersteller | 403 | Nur wer den Termin angelegt hat, kann Einladungen ändern |
| Inhalt ändern/löschen, aber weder Ersteller noch zuständiger Admin | 403 | Nur der Ersteller darf den Termin ändern |
| Sich selbst ausladen | 400 | Wer den Termin angelegt hat, kann sich nicht selbst ausladen |
| `status` weder `confirmed` noch `cancelled` | 400 | Ungültiger Status (erlaubt: confirmed, cancelled) |
| Absage eines Termins in Abstimmung | 400 | Ein Termin in Abstimmung lässt sich nicht absagen – lege zuerst den Zeitpunkt fest. |
| Bestätigen eines Termins in Abstimmung per `status` | 400 | Ein Termin in Abstimmung wird über die Terminfindung bestätigt. |
| Zusage bei abgesagtem Termin | 409 | Der Termin ist abgesagt. |
| `clientId` länger als 64 | 422 | (Validator: `clientId` – höchstens 64 Zeichen) |
| `clientId` eines gelöschten Termins | 409 | Dieser Termin wurde bereits gelöscht |
| mehr als 30 Anfragen mit `zustellung`/`attendeeIds` je Stunde | 429 | Zu viele Einladungen in kurzer Zeit. Warte einen Moment. |
| mehr als 300 neue Einzelchats je Stunde | 429 | Zu viele neue Chats in kurzer Zeit. Warte einen Moment. |
| Termin-Karte über den Nachrichtenweg | 400 | Termin-Karten legt nur die Termin-Funktion an. |
| nicht eingeladen (Detail, Zusage, Notizen, Dokumente, Vorkommen, Ausgaben) | 404 | Termin nicht gefunden |

Die Drosseln gelten **je Konto und je Instanz**; im Dev-Server ist `RATE_LIMIT=false`.

---

## 12. Was der Client weiterhin selbst macht

* **„Verfügbare Personen“**: aus dem Chat-Speicher (`members[].user` aller nicht archivierten Chats, ohne mich); das Suchfeld filtert sie, `GET /users?q=` ergänzt ab 2 Zeichen. **Kein neuer Endpunkt.**
* **Vorschau vor dem Senden**: `zustellungPlanen(ersteller, personen, wunsch, mitglieder)` aus `@initiative/shared` – rechnet exakt, was der Server tun wird.
  Einzelchats, die neu entstehen, schätzt die Vorschau aus den Einzelchats im Speicher; die Antwort nennt die genaue Zahl (`neueEinzelchats`).
* **Nebenwirkung, die die Vorschau nennen muss:** Wer jemanden einlädt, mit dem er nur in Gruppen schreibt (oder einen Fremden aus der Suche), legt einen **neuen Einzelchat** an, der beim Gegenüber erscheint.
  Die Teilnehmerliste mit allen Antworten sehen alle Eingeladenen.

---

## 13. Rückwärtsverträglichkeit (was sich für ältere App-Stände ändert)

* Anfragen **ohne** `zustellung`: Verhalten wie vorher (alle Chatmitglieder eingeladen, **eine** Karte, nicht stumm, Antwort ohne `zustellung`). „Termin aus Umfrage“ und Terminfindung ändern sich nicht.
* **Sichtbarkeit** ist strenger: Chatmitglieder, die nicht Teilnehmer sind, sehen den Termin nicht mehr (auch keinen Altbestand: die Migration 0023 trägt die **heutigen** Chatmitglieder als Teilnehmer nach, wer später beitritt, sieht ältere Termine nicht).
  Dafür können **Eingeladene von ausserhalb des Chats** ihren Termin jetzt öffnen und zusagen (vorher `403`) – auch Abstimmende aus Einzelchats nach „Bestätigen“.
* Ein älterer Client, der `PATCH { attendeeIds }` schickt, löst für neu Hinzugefügte jetzt Einzelkarten und Mitteilungen aus (gewollt).
* `DELETE /calendar/events/{id}/attendees/{userId}` ist jetzt **nur Ersteller** (bisher auch Gruppen-Admins).
* `event.updated` geht nur noch an Teilnehmer; `CalendarEventDto.stand` ist neu (ältere Clients ignorieren es); `event.deleted` hat optional `grund`; `sync.hint` optional `eventId`.
* Fehlerstatus für Nicht-Eingeladene: `404` (vorher beim Detail `403`).

## 14. Daten (für Erinnern, Migration 0024)

* `event_attendees.eingeladen_am` (`timestamptz not null default now()`): Bezugspunkt für „nach einer Weile erinnern“. Bestand: Anlegezeitpunkt des Termins; Nachgetragene und neu Eingeladene: jetzt. **Schreibweise `eingeladen_am`** (nicht `eingeladen_at`).
* `event_placements` (`id`, `event_id`, `conversation_id`, `message_id` (leer = reserviert), `art` `gruppe`|`einzel`, `user_id` (nur `einzel`), `created_by`, `created_at`): wohin eine Erinnerung geht und ob dort schon eine Karte steht.
  Eindeutig je `(event_id, conversation_id)` und je `(event_id, user_id)` bei `einzel`.
* `calendar_events.stand`, `calendar_events.client_id`, `calendar_events.status = 'cancelled'` (Abbruchbedingung fürs Erinnern).
* Dienst „Einzelchat finden/anlegen“: `services::conversations::einzelchats_sichern(tx, ersteller, personen)` (findet den **ältesten** Einzelchat je Person, legt fehlende an, sperrt je Paar) – derselbe, den das Erinnern braucht.
* Testnaht für Mitteilungen: `state.push.mitschneiden()` (nur Tests; schreibt mit, statt zu senden).
