# API-Referenz

Alles unter `/api/v1`. Die Rust-API (`apps/api`) ist die Quelle der Wahrheit;
`packages/shared` spiegelt denselben Vertrag für die PWA, und
`apps/web/src/lib/api.ts` ist der getippte Client, den alle Frontend-Module
benutzen.

```
Basis-URL:   {PUBLIC_API_URL}/api/v1        z. B. https://initiative-api.fly.dev/api/v1
WebSocket:   {PUBLIC_API_URL}/ws            außerhalb des Präfixes
Healthcheck: {PUBLIC_API_URL}/healthz       außerhalb des Präfixes
```

## Grundregeln

- **Format**: JSON in beide Richtungen, Feldnamen in **camelCase**, Zeitangaben
  als RFC 3339 in UTC (`2026-08-24T10:00:00Z`), IDs als **UUID v7** – zeitlich
  sortierbar, deshalb funktioniert Keyset-Pagination ohne Extra-Index.
- **Authentifizierung**: `Authorization: Bearer <accessToken>`.
  Wo kein Header möglich ist (WebSocket-Upgrade, Downloads), wird auch
  `?token=…` bzw. `?access_token=…` akzeptiert.
- **Listen** antworten immer als `{ "items": [...], "nextCursor": "…" | null }`.
  Fehlt `nextCursor`, ist die Liste vollständig.
- **Löschen** antwortet mit `204` ohne Rumpf, **Anlegen** mit `201`.
- **Schreiben** geht über REST, **Lesen im Betrieb** über den WebSocket. REST
  wird nur beim Kaltstart und zum Nachladen älterer Nachrichten gebraucht.

## Authentifizierung im Detail

|                  |                                                                                  |
| ---------------- | -------------------------------------------------------------------------------- |
| Passwort-Hash    | Argon2id                                                                         |
| Access-Token     | HS256-JWT, **15 Minuten** (`ACCESS_TOKEN_TTL`)                                   |
| Refresh-Token    | 48 Zufallsbytes, nur als SHA-256-Hash gespeichert, **rotiert bei jedem Refresh** |
| Refresh-Laufzeit | 60 Tage (`REFRESH_TOKEN_TTL_DAYS`)                                               |

```bash
# 1. Anmelden
curl -X POST https://api.example.com/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"anna","password":"passwort123"}'
```

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIs…",
  "expiresIn": 900,
  "refreshToken": "9f2c…",
  "user": { "id": "018f…", "username": "anna", "displayName": "Anna Berger", "…": "…" }
}
```

```bash
# 2. Damit arbeiten
curl https://api.example.com/api/v1/conversations \
  -H "authorization: Bearer $ACCESS_TOKEN"

# 3. Vor Ablauf erneuern – der alte Refresh-Token ist danach entwertet
curl -X POST https://api.example.com/api/v1/auth/refresh \
  -H 'content-type: application/json' \
  -d '{"refreshToken":"9f2c…"}'
```

Der Client in `apps/web/src/lib/api.ts` erneuert automatisch, sobald weniger als
30 Sekunden Restlaufzeit bleiben, und wiederholt eine `401` genau einmal nach
einem Refresh.

---

## Fehlerstruktur

Jeder Fehler – egal aus welchem Modul – sieht gleich aus:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "Eingabe konnte nicht verarbeitet werden",
    "details": [
      { "path": "username", "message": "mindestens 3 Zeichen" },
      { "path": "password", "message": "mindestens 8 Zeichen" }
    ]
  }
}
```

`details` fehlt, wenn es nichts zu ergänzen gibt.

| HTTP | `code`                   | Wann                                                                                           |
| ---- | ------------------------ | ---------------------------------------------------------------------------------------------- |
| 400  | `bad_request`            | Anfrage ergibt fachlich keinen Sinn (unbekanntes Spiel, ungültiger Zug, veralteter Spielstand) |
| 401  | `unauthorized`           | Kein, abgelaufenes oder falsches Token (`Nicht angemeldet`, `Sitzung abgelaufen`)              |
| 403  | `forbidden`              | Angemeldet, aber nicht berechtigt (kein Chat-Mitglied, fremder Anhang)                         |
| 404  | `not_found`              | Objekt existiert nicht – oder darf nicht einmal erahnt werden                                  |
| 409  | `conflict`               | Kollision, z. B. Benutzername vergeben                                                         |
| 413  | `payload_too_large`      | Datei über dem Limit der jeweiligen Art                                                        |
| 415  | `unsupported_media_type` | MIME-Typ für diese Anhangsart nicht erlaubt                                                    |
| 422  | `validation_failed`      | Feldprüfung fehlgeschlagen, `details` nennt jedes Feld                                         |
| 500  | `internal_error`         | Unerwartet. Details stehen nur im Serverlog, nie in der Antwort                                |

Der Client ergänzt zwei eigene Codes, die nie vom Server kommen:
`offline` (Status `0`, kein Netz) und `request_failed` (Antwort war kein JSON).

---

## Auth

| Methode | Pfad                          | Auth   | Request-Body                                       | Antwort                          |
| ------- | ----------------------------- | ------ | -------------------------------------------------- | -------------------------------- |
| POST    | `/auth/register`              | –      | `{ username, password, displayName, inviteCode? }` | `201` `AuthSession`              |
| POST    | `/auth/login`                 | –      | `{ username, password }`                           | `200` `AuthSession`              |
| POST    | `/auth/refresh`               | –      | `{ refreshToken }`                                 | `200` `AuthSession` (neues Paar) |
| POST    | `/auth/logout`                | –      | `{ refreshToken }`                                 | `204`                            |
| GET     | `/auth/me`                    | Bearer | –                                                  | `200` `SelfUser`                 |
| POST    | `/auth/password`              | Bearer | `{ currentPassword, newPassword }`                 | `204`                            |
| POST    | `/auth/calendar-token/rotate` | Bearer | –                                                  | `200` `{ calendarToken }`        |

`inviteCode` ist nur bei `REGISTRATION_MODE=invite` nötig; bei `closed` lehnt die
Registrierung grundsätzlich ab. `rotate` entwertet das alte ICS-Abo – praktisch,
wenn der Feed-Link irgendwo gelandet ist, wo er nicht hingehört.

**AuthSession**

```json
{
  "accessToken": "…",
  "expiresIn": 900,
  "refreshToken": "…",
  "user": { "…": "SelfUser" }
}
```

**SelfUser** = `User` + `calendarToken` + `settings` (freies JSON-Objekt der PWA).

**User**

```json
{
  "id": "018f…",
  "username": "anna",
  "displayName": "Anna Berger",
  "avatarUrl": "https://api.example.com/api/v1/media/018f…",
  "bio": "Wandert gern.",
  "accent": "#4f7cff",
  "lastSeenAt": "2026-08-24T09:58:12Z",
  "createdAt": "2026-06-01T12:00:00Z"
}
```

## Benutzer

| Methode | Pfad          | Auth   | Request                                                  | Antwort                   |
| ------- | ------------- | ------ | -------------------------------------------------------- | ------------------------- |
| GET     | `/users`      | Bearer | Query `q` (Pflicht), `limit` (Standard 20)               | `200` `{ items: User[] }` |
| GET     | `/users/{id}` | Bearer | –                                                        | `200` `User`              |
| PATCH   | `/users/me`   | Bearer | `{ displayName?, bio?, avatarAttachmentId?, settings? }` | `200` `SelfUser`          |

`bio` und `avatarAttachmentId` verstehen `null` als „löschen"; fehlt das Feld,
bleibt es unverändert. Eine Profiländerung wird als `user.updated` an alle
Kontakte gesendet.

## Chats

| Methode | Pfad                                   | Auth   | Request                                                                 | Antwort                                                           |
| ------- | -------------------------------------- | ------ | ----------------------------------------------------------------------- | ----------------------------------------------------------------- |
| GET     | `/conversations`                       | Bearer | Query `archived` (`true`/`false`)                                       | `200` `{ items: Conversation[] }`                                 |
| POST    | `/conversations`                       | Bearer | `{ type: 'direct'\|'group', memberIds[], title?, avatarAttachmentId? }` | `201` `Conversation` (`200`, wenn der Direktchat schon existiert) |
| GET     | `/conversations/{id}`                  | Bearer | –                                                                       | `200` `Conversation`                                              |
| PATCH   | `/conversations/{id}`                  | Bearer | `{ title?, avatarAttachmentId?, mutedUntil?, archived? }`               | `200` `Conversation`                                              |
| POST    | `/conversations/{id}/members`          | Bearer | `{ memberIds[] }`                                                       | `200` `Conversation`                                              |
| PATCH   | `/conversations/{id}/members/{userId}` | Bearer | `{ role?, nickname? }`                                                  | `200` `Conversation`                                              |
| DELETE  | `/conversations/{id}/members/{userId}` | Bearer | –                                                                       | `204`                                                             |
| POST    | `/conversations/{id}/read`             | Bearer | `{ messageId }`                                                         | `200` `{ ok: true }`                                              |

`mutedUntil` und `archived` gelten **pro Mitglied**, nicht für den ganzen Chat:
Wer stummschaltet, stört damit niemanden sonst. `mutedUntil: null` hebt die
Stummschaltung auf. Sich selbst zu entfernen bedeutet „Gruppe verlassen".

**Conversation**

```json
{
  "id": "018f…",
  "type": "group",
  "title": "Wandergruppe",
  "avatarUrl": null,
  "createdBy": "018f…",
  "createdAt": "2026-06-01T12:00:00Z",
  "updatedAt": "2026-08-24T09:00:00Z",
  "members": [
    {
      "userId": "018f…",
      "role": "owner",
      "joinedAt": "2026-06-01T12:00:00Z",
      "nickname": null,
      "lastReadMessageId": "018f…",
      "user": { "…": "User" }
    }
  ],
  "lastMessage": { "…": "Message" },
  "unreadCount": 3,
  "mutedUntil": null,
  "archived": false
}
```

## Nachrichten

| Methode | Pfad                           | Auth   | Request                                                              | Antwort                                  |
| ------- | ------------------------------ | ------ | -------------------------------------------------------------------- | ---------------------------------------- |
| GET     | `/conversations/{id}/messages` | Bearer | Query `limit` (Standard 50, max 100), `before`, `after`              | `200` `{ items: Message[], nextCursor }` |
| POST    | `/conversations/{id}/messages` | Bearer | `{ type?, body?, attachmentIds?, replyToId?, clientId?, metadata? }` | `201` `Message`                          |
| GET     | `/messages/{id}`               | Bearer | –                                                                    | `200` `Message`                          |
| PATCH   | `/messages/{id}`               | Bearer | `{ body }`                                                           | `200` `Message`                          |
| DELETE  | `/messages/{id}`               | Bearer | –                                                                    | `204`                                    |
| PUT     | `/messages/{id}/reactions`     | Bearer | `{ emoji }`                                                          | `200` `{ reactions: Reaction[] }`        |
| DELETE  | `/messages/{id}/reactions`     | Bearer | Query `emoji`                                                        | `200` `{ reactions: Reaction[] }`        |
| GET     | `/search/messages`             | Bearer | Query `q` (Pflicht), `conversationId?`, `limit?`                     | `200` `{ items: Message[] }`             |

**Blättern.** `before=<messageId>` liefert ältere Nachrichten (rückwärts),
`after=<messageId>` neuere (zum Aufholen nach einer Trennung). `nextCursor` wird
nur beim Rückwärtsblättern gesetzt und enthält die ID der ältesten gelieferten
Nachricht.

**Idempotenz.** `clientId` ist eine vom Client erzeugte Kennung. Wird dieselbe
Nachricht zweimal gesendet – etwa weil die Outbox nach einem Verbindungsabbruch
erneut zuschlägt – kommt die bereits gespeicherte Nachricht zurück, statt einer
zweiten.

**Typen**: `text`, `image`, `video`, `audio`, `file`, `sticker`, `poll`, `event`,
`game`, `system`. `system` kann nicht gesendet werden – das macht der Server bei
Ereignissen wie „X ist der Gruppe beigetreten".

Eine Nachricht braucht mindestens eines von: Text, Anhang oder einen Bezug in
`metadata` (`stickerId`, `pollId`, `eventId`, `gameSessionId`). Grenzen:
Text max. 8000 Zeichen, max. 10 Anhänge.

**Message**

```json
{
  "id": "018f…",
  "conversationId": "018f…",
  "senderId": "018f…",
  "type": "image",
  "body": "Aussicht vom Gipfel",
  "attachments": [{ "…": "Attachment" }],
  "replyToId": null,
  "replyTo": null,
  "metadata": {},
  "reactions": [{ "emoji": "👍", "userIds": ["018f…"] }],
  "clientId": "c-8f21…",
  "createdAt": "2026-08-24T09:00:00Z",
  "editedAt": null,
  "deletedAt": null
}
```

Nachrichten mit Bezug tragen zusätzlich das aufgelöste Objekt: `poll`, `event`,
`game` oder `sticker`. Das erledigen die **Message-Expander** der Module – der
Messenger-Kern weiß nichts von Umfragen oder Spielen (siehe
[EXTENDING.md](EXTENDING.md)).

Gelöschte Nachrichten verschwinden nicht aus der Liste: `deletedAt` ist gesetzt,
`body` und `attachments` sind leer – so bleibt der Verlauf lückenlos.

## Medien

| Methode | Pfad                           | Auth           | Request                                                        | Antwort                                                  |
| ------- | ------------------------------ | -------------- | -------------------------------------------------------------- | -------------------------------------------------------- |
| POST    | `/media/uploads`               | Bearer         | `{ kind, mime, size, fileName? }`                              | `201` `CreateUploadResult`                               |
| POST    | `/media/uploads/{id}/data`     | Bearer         | `multipart/form-data`, Feld `file`                             | `200` `Attachment`                                       |
| POST    | `/media/uploads/{id}/complete` | Bearer         | `{ width?, height?, durationMs?, waveform?, previewDataUrl? }` | `200` `Attachment`                                       |
| GET     | `/media/{id}`                  | – (Capability) | Header `Range` erlaubt                                         | `200`/`206` Binärdaten oder `302` auf eine signierte URL |
| GET     | `/media/{id}/download`         | – (Capability) | –                                                              | wie oben, mit `Content-Disposition: attachment`          |
| DELETE  | `/media/{id}`                  | Bearer         | –                                                              | `204` (nur eigene, noch nicht gesendete Anhänge)         |

**Ablauf in drei Schritten**

```
1. POST /media/uploads          → { attachmentId, strategy, uploadUrl, headers, expiresAt }
2. strategy = "presigned"       → PUT uploadUrl mit den gelieferten headers (direkt zu R2/S3)
   strategy = "direct"          → POST uploadUrl als multipart/form-data, Feld "file"
3. POST /media/uploads/{id}/complete   → Maße, Dauer, Wellenform, Vorschau nachreichen
4. attachmentId in attachmentIds der Nachricht mitschicken
```

Bei `strategy: "direct"` (also `STORAGE_DRIVER=local`) erledigt Schritt 2 den
Abschluss gleich mit – Schritt 3 ist dann nur für Metadaten nötig.
`apps/web/src/lib/upload.ts` kapselt beide Wege.

**Arten und Grenzen**

| `kind`    | Max. Größe | Erlaubte MIME-Typen                                                              |
| --------- | ---------- | -------------------------------------------------------------------------------- |
| `image`   | 25 MB      | `image/jpeg`, `image/png`, `image/webp`, `image/gif`, `image/avif`, `image/heic` |
| `video`   | 200 MB     | `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska`                 |
| `audio`   | 50 MB      | `audio/webm`, `audio/ogg`, `audio/mpeg`, `audio/mp4`, `audio/aac`, `audio/wav`   |
| `file`    | 100 MB     | alle                                                                             |
| `sticker` | 2 MB       | `image/webp`, `image/png`                                                        |

**Warum `GET /media/{id}` ohne Token geht.** `<img src>`, `<video>` und der
Service-Worker-Cache können keinen `Authorization`-Header setzen. Die Anhang-ID
ist eine UUID v7 mit 74 Zufallsbits und wirkt als Capability-URL: Wer sie nicht
kennt, findet sie auch nicht. Mit R2/S3 antwortet der Endpunkt mit einer
Weiterleitung auf eine kurzlebige signierte URL (`SIGNED_URL_TTL`), lokal
streamt er selbst – inklusive `Range`-Unterstützung, damit man in ein Video
springen kann.

**Attachment**

```json
{
  "id": "018f…",
  "kind": "audio",
  "mime": "audio/webm",
  "size": 48213,
  "fileName": null,
  "width": null,
  "height": null,
  "durationMs": 7400,
  "waveform": [0.1, 0.8, 0.4],
  "previewDataUrl": null,
  "url": "https://api.example.com/api/v1/media/018f…",
  "status": "ready",
  "createdAt": "2026-08-24T09:00:00Z"
}
```

## Sticker

| Methode | Pfad                                        | Auth   | Request                                 | Antwort                                                  |
| ------- | ------------------------------------------- | ------ | --------------------------------------- | -------------------------------------------------------- |
| GET     | `/stickers/packs`                           | Bearer | –                                       | `200` `{ items: StickerPack[] }` (eigene + installierte) |
| POST    | `/stickers/packs`                           | Bearer | `{ name, isPublic? }`                   | `201` `StickerPack`                                      |
| GET     | `/stickers/discover`                        | Bearer | Query `q?`                              | `200` `{ items: StickerPack[] }` (öffentliche Pakete)    |
| GET     | `/stickers/packs/{id}`                      | Bearer | –                                       | `200` `StickerPack`                                      |
| PATCH   | `/stickers/packs/{id}`                      | Bearer | `{ name?, isPublic?, coverStickerId? }` | `200` `StickerPack`                                      |
| DELETE  | `/stickers/packs/{id}`                      | Bearer | –                                       | `204`                                                    |
| POST    | `/stickers/packs/{id}/stickers`             | Bearer | `{ attachmentId, emoji? }`              | `201` `StickerPack`                                      |
| DELETE  | `/stickers/packs/{id}/stickers/{stickerId}` | Bearer | –                                       | `204`                                                    |
| POST    | `/stickers/packs/{id}/install`              | Bearer | –                                       | `200` `StickerPack`                                      |
| DELETE  | `/stickers/packs/{id}/install`              | Bearer | –                                       | `204`                                                    |

Ändern und Löschen darf nur der Besitzer. Max. 120 Sticker pro Paket, Name max.
60 Zeichen. Der `attachmentId` muss ein Anhang sein, den **du selbst** hochgeladen
hast – sonst `403`. Anhänge der Art `sticker` dürfen 2 MB groß sein und müssen
`image/webp` oder `image/png` sein.

## Kalender

| Methode | Pfad                                 | Auth           | Request                                             | Antwort                                              |
| ------- | ------------------------------------ | -------------- | --------------------------------------------------- | ---------------------------------------------------- |
| GET     | `/calendar/events`                   | Bearer         | Query `from?`, `to?`, `conversationId?`             | `200` `{ items: CalendarEvent[] }`                   |
| POST    | `/calendar/events`                   | Bearer         | siehe unten                                         | `201` `CalendarEvent`                                |
| GET     | `/calendar/events/{id}`              | Bearer         | –                                                   | `200` `CalendarEvent`                                |
| PATCH   | `/calendar/events/{id}`              | Bearer         | Teilmenge der Anlegen-Felder                        | `200` `CalendarEvent`                                |
| DELETE  | `/calendar/events/{id}`              | Bearer         | –                                                   | `204`                                                |
| POST    | `/calendar/events/{id}/rsvp`         | Bearer         | `{ status: 'yes'\|'no'\|'maybe'\|'pending' }`       | `200` `CalendarEvent`                                |
| GET     | `/calendar/events/{id}/occurrences`  | Bearer         | Query `from?`, `to?` (Standard: jetzt bis +90 Tage) | `200` `{ items: [{ index, startsAt, endsAt }] }`     |
| GET     | `/calendar/events/{id}/event.ics`    | – (Capability) | –                                                   | `200` `text/calendar`, einzelner Termin zum Download |
| GET     | `/calendar/{calendarToken}/feed.ics` | – (Token)      | –                                                   | `200` `text/calendar`, persönliches Abo              |

**Termin anlegen**

```json
{
  "conversationId": "018f…",
  "title": "Wanderung Zugspitze",
  "description": "Treffpunkt am Parkplatz",
  "location": "Eibsee",
  "startsAt": "2026-09-05T06:00:00Z",
  "endsAt": "2026-09-05T16:00:00Z",
  "allDay": false,
  "rrule": "FREQ=WEEKLY;BYDAY=SA;COUNT=6",
  "color": "#4f7cff",
  "reminderMinutes": [60, 1440],
  "attendeeIds": ["018f…", "018f…"],
  "announce": true
}
```

`announce: true` (Standard bei gesetzter `conversationId`) schickt zusätzlich
eine Chat-Nachricht vom Typ `event` in den Chat. Ohne `conversationId` ist der
Termin privat. Serientermine werden über `rrule` (RFC 5545) beschrieben und
serverseitig in `/occurrences` aufgelöst.

`description`, `location`, `rrule` und `color` verstehen im PATCH `null` als
„löschen"; ein fehlendes Feld bleibt unverändert.

**ICS-Abo.** Der `calendarToken` steckt in `SelfUser`. Der Link
`{PUBLIC_API_URL}/api/v1/calendar/{calendarToken}/feed.ics` lässt sich in iOS,
Android, Google Kalender und Outlook als Abo eintragen; er liefert ein Jahr
rückwärts und zwei Jahre voraus. Wer den Link verliert, ruft
`POST /auth/calendar-token/rotate` auf.

## Umfragen und Terminfindung

| Methode | Pfad                      | Auth   | Request                                                     | Antwort                                |
| ------- | ------------------------- | ------ | ----------------------------------------------------------- | -------------------------------------- |
| POST    | `/polls`                  | Bearer | siehe unten                                                 | `201` `Poll`                           |
| GET     | `/polls/{id}`             | Bearer | –                                                           | `200` `Poll`                           |
| POST    | `/polls/{id}/vote`        | Bearer | `{ votes: [{ optionId, value? }] }`                         | `200` `Poll`                           |
| POST    | `/polls/{id}/options`     | Bearer | `{ label?, startsAt?, endsAt? }`                            | `201` `Poll`                           |
| POST    | `/polls/{id}/close`       | Bearer | –                                                           | `200` `Poll`                           |
| POST    | `/polls/{id}/reopen`      | Bearer | –                                                           | `200` `Poll`                           |
| GET     | `/polls/{id}/best-option` | Bearer | –                                                           | `200` `{ option: PollOption \| null }` |
| POST    | `/polls/{id}/event`       | Bearer | `{ optionId, title?, location?, description?, closePoll? }` | `201` `CalendarEvent`                  |

**Umfrage anlegen**

```json
{
  "conversationId": "018f…",
  "kind": "date",
  "question": "Wann passt es euch?",
  "description": null,
  "options": [
    { "startsAt": "2026-09-05T08:00:00Z", "endsAt": "2026-09-05T18:00:00Z" },
    { "startsAt": "2026-09-06T08:00:00Z", "endsAt": "2026-09-06T18:00:00Z" }
  ],
  "multiple": true,
  "anonymous": false,
  "allowAddOptions": true,
  "closesAt": null
}
```

- `kind: "choice"` – klassische Abstimmung, `options[].label` ist Pflicht,
  `value` ist immer `yes`.
- `kind: "date"` – Terminfindung, `options[].startsAt`/`endsAt` statt Label,
  `value` ist `yes`, `maybe` oder `no`.

`POST /polls/{id}/vote` **ersetzt** die Stimmen des Aufrufers vollständig – eine
leere Liste nimmt die Stimme zurück. Bei `multiple: false` zählt nur die erste.
`allowAddOptions` erlaubt allen Mitgliedern, Vorschläge zu ergänzen. Schließen
und wieder öffnen darf nur, wer die Umfrage erstellt hat. Höchstens 30 Optionen.

`POST /polls/{id}/event` macht aus dem Gewinner einen echten Termin, lädt alle
zu, die mit `yes` gestimmt haben, und schließt die Umfrage (`closePoll`, Standard
`true`). Der Termin merkt sich seine Herkunft in `sourcePollId`, die Umfrage das
Ergebnis in `createdEventId`.

**Poll** trägt neben Optionen und Stimmen eine fertige Auswertung:
`tally` (je Option `{ yes, maybe, no, score }`), `voterCount` und `myVotes`. Bei
`anonymous: true` liefert der Server nur Zahlen, keine Namen.

## Mini-Spiele

| Methode | Pfad                           | Auth   | Request                                     | Antwort                                 |
| ------- | ------------------------------ | ------ | ------------------------------------------- | --------------------------------------- |
| GET     | `/games`                       | –      | –                                           | `200` `{ items: GameInfo[] }` (Katalog) |
| GET     | `/games/sessions`              | Bearer | Query `conversationId?`, `status?`          | `200` `{ items: GameSession[] }`        |
| POST    | `/games/sessions`              | Bearer | `{ conversationId, gameKey, opponentIds? }` | `201` `GameSession`                     |
| GET     | `/games/sessions/{id}`         | Bearer | –                                           | `200` `GameSession`                     |
| POST    | `/games/sessions/{id}/join`    | Bearer | –                                           | `200` `GameSession`                     |
| POST    | `/games/sessions/{id}/moves`   | Bearer | `{ move, version? }`                        | `200` `GameSession`                     |
| POST    | `/games/sessions/{id}/abort`   | Bearer | –                                           | `200` `GameSession`                     |
| POST    | `/games/sessions/{id}/rematch` | Bearer | –                                           | `201` `GameSession` (neue Partie)       |

Der Server ist **autoritativ**: `move` ist ein beliebiges JSON-Objekt, das die
Spielregel in `apps/api/src/games/` prüft. Ein ungültiger Zug ergibt `400` mit
einer verständlichen Meldung („Du bist nicht am Zug.", „Feld ist bereits
belegt."). `version` ist optional und schützt vor Doppelklicks und veralteten
Ansichten: Passt sie nicht zum aktuellen Stand, kommt
`400 – Der Spielstand hat sich geändert – bitte neu laden.` zurück.

Beim Anlegen wird automatisch eine Chat-Nachricht vom Typ `game` erzeugt. Wer am
Zug ist, bekommt eine Push-Benachrichtigung.

**GameSession**

```json
{
  "id": "018f…",
  "conversationId": "018f…",
  "messageId": "018f…",
  "gameKey": "tic-tac-toe",
  "status": "active",
  "players": [{ "userId": "018f…", "seat": 0, "joinedAt": "…" }],
  "state": {
    "board": [null, 0, null, "…"],
    "turn": 1,
    "winner": null,
    "draw": false,
    "line": null
  },
  "turnUserId": "018f…",
  "winnerUserIds": [],
  "createdBy": "018f…",
  "createdAt": "…",
  "updatedAt": "…",
  "version": 3
}
```

`status`: `open` (wartet auf Mitspieler) · `active` · `finished` · `aborted`.
`state` gehört dem jeweiligen Spiel – die Plattform schaut nicht hinein.

## Push

| Methode | Pfad                  | Auth   | Request                                            | Antwort                                               |
| ------- | --------------------- | ------ | -------------------------------------------------- | ----------------------------------------------------- |
| GET     | `/push/public-key`    | –      | –                                                  | `200` `{ publicKey: string\|null, enabled: boolean }` |
| POST    | `/push/subscriptions` | Bearer | `{ endpoint, keys: { p256dh, auth }, userAgent? }` | `201` `{ ok: true }`                                  |
| DELETE  | `/push/subscriptions` | Bearer | `{ endpoint }`                                     | `204`                                                 |
| POST    | `/push/test`          | Bearer | –                                                  | `200` `{ delivered: <Anzahl> }`                       |

Sind keine VAPID-Schlüssel gesetzt, meldet `/push/public-key` schlicht
`enabled: false` – die PWA blendet den Schalter dann aus, statt zu scheitern.
Ein `endpoint` ist eindeutig: Ein erneutes Abonnieren aktualisiert den
bestehenden Eintrag.

**PushPayload** (was im Service Worker ankommt, unter 4 KB):

```json
{
  "title": "Anna · Wandergruppe",
  "body": "Bringst du die Karte mit?",
  "tag": "conversation:018f…",
  "url": "/chats/018f…",
  "conversationId": "018f…",
  "messageId": "018f…",
  "kind": "message"
}
```

## Dienst-Endpunkte

| Methode | Pfad       | Auth | Antwort                                                                   |
| ------- | ---------- | ---- | ------------------------------------------------------------------------- |
| GET     | `/healthz` | –    | `200` `{ status, storage, bus, push, connections }`, `503` bei `degraded` |
| GET     | `/`        | –    | `200` `{ name, version, runtime, modules[], docs }`                       |

Beide liegen **außerhalb** von `/api/v1`.

---

## Realtime-Protokoll

```
wss://api.example.com/ws?token=<accessToken>
```

Der WebSocket akzeptiert das Access-Token nur als Query-Parameter (`token` oder
`access_token`) – ein Upgrade kann keine Header setzen. Ist es ungültig,
schließt der Server mit Code **4401**: Der Client soll das Token erneuern und
sich neu verbinden.

### Envelope

Beide Richtungen benutzen denselben Umschlag:

```json
{
  "v": 1,
  "type": "message.new",
  "ts": "2026-08-24T10:00:00.000Z",
  "payload": {}
}
```

**Unbekannte `type`-Werte werden ignoriert** – auf beiden Seiten. Ein neuer
Server bricht keinen alten Client, und ein neues Modul bringt einfach eigene
Ereignisse mit, ohne dass am Transport etwas geändert werden muss.

Alle 25 Sekunden sendet der Server einen WebSocket-Ping. Bleibt er aus, ist die
Verbindung tot und der Client baut sie neu auf.

### Server → Client

| `type`                 | `payload`                                       | Bedeutung                                                   |
| ---------------------- | ----------------------------------------------- | ----------------------------------------------------------- |
| `hello`                | `{ userId, connectionId, serverTime }`          | Erstes Frame nach dem Verbinden                             |
| `pong`                 | `{ ts }`                                        | Antwort auf `ping`                                          |
| `message.new`          | `{ message }`                                   | Neue Nachricht in einem deiner Chats                        |
| `message.updated`      | `{ message }`                                   | Nachricht bearbeitet                                        |
| `message.deleted`      | `{ conversationId, messageId }`                 | Nachricht gelöscht                                          |
| `message.reactions`    | `{ conversationId, messageId, reactions }`      | Reaktionen geändert                                         |
| `conversation.updated` | `{ conversation }`                              | Titel, Bild, Mitglieder, Stummschaltung, Archiv             |
| `conversation.removed` | `{ conversationId }`                            | Du bist kein Mitglied mehr                                  |
| `read.updated`         | `{ conversationId, userId, lastReadMessageId }` | Lesestand eines Mitglieds                                   |
| `typing`               | `{ conversationId, userId, until }`             | Jemand tippt, läuft nach `until` von selbst ab              |
| `presence`             | `{ userId, online, lastSeenAt }`                | Kontakt online oder offline                                 |
| `poll.updated`         | `{ poll }`                                      | Stimme, neue Option, geschlossen oder geöffnet              |
| `event.updated`        | `{ event }`                                     | Termin angelegt, geändert, Zu-/Absage                       |
| `event.deleted`        | `{ eventId, conversationId }`                   | Termin gelöscht                                             |
| `game.updated`         | `{ session }`                                   | Zug, Beitritt, Ende einer Partie                            |
| `user.updated`         | `{ user }`                                      | Ein Kontakt hat sein Profil geändert                        |
| `sync.hint`            | `{ scope, conversationId? }`                    | Nutzlast war zu groß für den Bus – bitte per REST nachladen |
| `error`                | `{ code, message }`                             | Fehler in einem Client-Ereignis                             |

### Client → Server

| `type`      | `payload`                       | Bedeutung                                                                          |
| ----------- | ------------------------------- | ---------------------------------------------------------------------------------- |
| `ping`      | `{}`                            | Lebenszeichen, beantwortet mit `pong`                                              |
| `typing`    | `{ conversationId, typing }`    | Tipp-Anzeige an oder aus (läuft nach 6 s ab)                                       |
| `read`      | `{ conversationId, messageId }` | Lesestand setzen – wirkt wie `POST /conversations/{id}/read`, aber ohne HTTP-Runde |
| `subscribe` | `{ conversationIds }`           | Interesse an bestimmten Chats bekunden                                             |

Der Server prüft bei jedem Ereignis die Mitgliedschaft; Ereignisse für fremde
Chats werden still verworfen. `read` setzt den Lesestand nur vorwärts – ein
älterer Wert wird ignoriert.

### Zustellung

Ereignisse gehen an alle Verbindungen der betroffenen Benutzer. Laufen mehrere
API-Instanzen, verteilt Postgres `LISTEN/NOTIFY` sie zwischen den Instanzen
(`REALTIME_BUS=postgres`). Die Nutzlast von `NOTIFY` ist begrenzt: Ist ein
Ereignis zu groß, kommt statt der Daten ein `sync.hint` – der Client lädt dann
per REST nach.

---

## Beispiel: Nachricht mit Foto senden

```bash
API=https://api.example.com/api/v1
TOKEN=$ACCESS_TOKEN
CHAT=018f…

# 1. Upload anmelden
UPLOAD=$(curl -s -X POST "$API/media/uploads" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"kind":"image","mime":"image/jpeg","size":184320,"fileName":"gipfel.jpg"}')

ID=$(echo "$UPLOAD" | jq -r .attachmentId)
URL=$(echo "$UPLOAD" | jq -r .uploadUrl)

# 2a. presigned (R2/S3)
curl -X PUT "$URL" -H 'content-type: image/jpeg' --data-binary @gipfel.jpg
# 2b. direct (STORAGE_DRIVER=local)
curl -X POST "$URL" -H "authorization: Bearer $TOKEN" -F "file=@gipfel.jpg"

# 3. Metadaten nachreichen
curl -s -X POST "$API/media/uploads/$ID/complete" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"width":1600,"height":1200}'

# 4. Senden
curl -s -X POST "$API/conversations/$CHAT/messages" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"type\":\"image\",\"body\":\"Aussicht\",\"attachmentIds\":[\"$ID\"],\"clientId\":\"c-$(date +%s)\"}"
```

---

## Weiterlesen

- [ARCHITECTURE.md](ARCHITECTURE.md) – warum die API so geschnitten ist
- [EXTENDING.md](EXTENDING.md) – eigene Endpunkte und Ereignisse ergänzen
- [DEPLOYMENT.md](DEPLOYMENT.md) – Umgebungsvariablen und Betrieb
