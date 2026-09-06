# Architektur

Initiative ist **keine Messenger-App, sondern eine Plattform** – der Messenger ist
nur das erste Modul. Alles ist so geschnitten, dass ein neues Feature hinzugefügt
wird, ohne den Kern anzufassen – Dateien, Ausgaben und der Fotoeditor sind genau
so entstanden.

```
Initiative/
├── apps/
│   ├── api/          Rust-Backend (Axum + sqlx) – eine Binary im Container
│   └── web/          React-PWA (Vite) – statisch, von Caddy ausgeliefert
├── packages/
│   └── shared/       TypeScript-Contracts für die PWA (Typen, Zod-Schemas, Protokoll)
└── deploy/vps/       der Stapel, wie er auf dem eigenen Server läuft
```

Betrieben wird das als **ein** Docker-Compose-Stapel auf einem Server: Postgres,
API und PWA hinter einem Caddy, Dateien im Volume daneben. Getrennt betreiben
geht weiterhin, ist aber nicht mehr der empfohlene Weg –
[UMZUG.md](UMZUG.md) beschreibt den, der läuft.

Das Backend ist die **einzige Quelle der Wahrheit** für den API-Vertrag.
`packages/shared` spiegelt diesen Vertrag für die PWA: dieselben Feldnamen
(camelCase), dieselben Grenzwerte, dasselbe Realtime-Protokoll. Wer einen
Endpunkt ändert, ändert beides.

## Datenfluss

```
PWA  ──REST /api/v1──▶  Axum (Rust)  ──SQL──▶  Postgres (im Compose-Stapel)
 ▲                          │
 └──── WebSocket /ws ───────┘   Broadcast im Prozess oder über LISTEN/NOTIFY
                                Medien: lokale Platte, wahlweise S3/R2
                                Push: Web Push (VAPID) an Android & iOS 16.4+
```

- **Schreiben** geht immer über REST (idempotent per `clientId`).
- **Lesen im Betrieb** kommt über den WebSocket; REST wird nur beim Kaltstart
  und beim Nachladen älterer Nachrichten benutzt.
- **Medien** liefert die API selbst aus (`STORAGE_DRIVER=local`). Mit S3/R2
  laufen sie an ihr vorbei – presigned PUT und GET direkt beim Speicher.
- **Der Realtime-Bus** steht im Code auf `postgres` (LISTEN/NOTIFY), die
  mitgelieferte `docker-compose.yml` setzt ihn auf `memory`. Bei genau einem
  API-Prozess ist das die robustere Wahl: Der Datenbank-Bus schickt sonst
  jedes Ereignis über Postgres, auch wenn Sender und Empfänger derselbe
  Prozess sind – fällt der Kanal aus, steht die Echtzeit.

## Erweiterungspunkte

| Punkt            | Datei                                                       | Wofür                                        |
| ---------------- | ----------------------------------------------------------- | -------------------------------------------- |
| Backend-Modul    | `apps/api/src/modules/<name>.rs` + `modules/mod.rs`         | eigene REST-Routen                           |
| Message-Expander | `impl MessageExpander` + Eintrag in `services/expanders.rs` | eigene Entitäten in Nachrichten einbetten    |
| Frontend-Modul   | `apps/web/src/modules/<name>/module.ts` + `registry.ts`     | Routen, Tab, Chat-Bubbles, Composer-Aktionen |
| Mini-Spiel       | `apps/api/src/games/<name>.rs` + `games/mod.rs`             | Regeln (Server validiert autoritativ)        |
| Spielbrett       | `apps/web/src/modules/games/boards/`                        | Darstellung eines Spiels                     |

### Backend-Modul

```rust
// apps/api/src/modules/tasks.rs
pub fn router() -> Router<AppState> {
    Router::new().route("/tasks", get(list))
}

async fn list(State(state): State<AppState>, user: AuthUser) -> AppResult<Json<Vec<TaskRow>>> {
    Ok(Json(
        sqlx::query_as::<_, TaskRow>("select * from tasks where user_id = $1")
            .bind(user.id())
            .fetch_all(&state.pool)
            .await?,
    ))
}
```

Danach eine Zeile in `modules/mod.rs`: `.merge(tasks::router())`.
`AppState` enthält `pool`, `storage`, `hub` und `bus` (Realtime), `push`,
`drossel` (Ratenbegrenzung) und `config`.
Neue Tabellen kommen als nummerierte Datei nach `apps/api/migrations/` und
werden beim Start automatisch angewendet (sie sind in die Binary eingebettet).

### Frontend-Modul

```ts
export default defineWebModule({
  key: 'tasks',
  title: 'Aufgaben',
  nav: [{ path: '/aufgaben', label: 'Aufgaben', icon: '✅', order: 40 }],
  routes: [{ path: '/aufgaben', element: <TasksScreen /> }],
  messageRenderers: { task: TaskBubble },
  composerActions: [{ key: 'task', label: 'Aufgabe', icon: '✅', render: TaskComposer }],
});
```

## Datenmodell (Kurzfassung)

38 Tabellen, gruppiert nach dem, wozu sie gehören:

| Bereich          | Tabellen                                                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Konto            | `users` · `refresh_tokens` · `passkeys` · `webauthn_states` · `invite_codes` · `invite_redemptions` · `push_subscriptions` |
| Chats            | `conversations` · `conversation_members` · `messages` · `message_hidden` · `attachments` · `reactions`                     |
| Sticker          | `sticker_packs` · `stickers` · `sticker_pack_installs`                                                                     |
| Umfragen         | `polls` · `poll_options` · `poll_votes` · `poll_placements`                                                                |
| Kalender         | `calendar_events` · `event_attendees` · `event_attachments`                                                                |
| Notizen & Listen | `event_notes` · `event_note_items` · `event_note_checks` · `event_note_editors` · `event_note_item_assignees`              |
| Dateien          | `collections` · `collection_items` · `collection_grants`                                                                   |
| Ausgaben         | `expenses` · `expense_shares` · `expense_viewers` · `expense_hidden_from` · `payment_profiles`                             |
| Spiele           | `game_sessions`                                                                                                            |
| Speicher         | `storage_muell` – gelöschte Anhänge, deren Bytes noch wegzuräumen sind                                                     |

Alle IDs sind **UUID v7** (zeitlich sortierbar) – dadurch funktioniert
Keyset-Pagination (`where id < cursor`) und `id > last_read_message_id` als
Ungelesen-Zähler ohne zusätzlichen Index.

## Realtime-Protokoll

Ein Envelope für beide Richtungen:

```json
{ "v": 1, "type": "message.new", "ts": "2026-08-24T10:00:00.000Z", "payload": {} }
```

Server → Client: `hello`, `pong`, `message.new|updated|deleted|reactions`,
`conversation.updated|removed`, `read.updated`, `typing`, `presence`,
`poll.updated`, `event.updated|deleted`, `game.updated`,
`expense.updated|deleted|settled`, `user.updated`, `sync.hint`, `error`.
Client → Server: `ping`, `typing`, `read`, `subscribe`.

Unbekannte Event-Typen werden ignoriert – ein neuer Server bricht keinen alten
Client, und neue Module bringen einfach eigene Typen mit.

## Offline

Die PWA cached Chats und die letzten 200 Nachrichten pro Chat in IndexedDB und
legt ungesendete Nachrichten (inklusive offline aufgenommener Fotos und
Sprachnachrichten) in eine Outbox, die beim Reconnect abgearbeitet wird.
Der Service Worker cached die App-Shell und alle Medien (`cache-first`, Medien
sind unveränderlich).

## Warum Rust

- Eine statisch gelinkte Binary (~15 MB) ohne Laufzeit, OpenSSL oder libcurl –
  das Container-Image bleibt klein und startet in Millisekunden.
- Der Compiler erzwingt, dass jeder Fehlerfall behandelt wird; `AppError` ist der
  einzige Weg, wie eine Anfrage scheitern kann.
- Spielregeln, Umfragen-Auswertung, Serientermine und die Web-Push-Verschlüsselung
  sind reine Funktionen mit Unit-Tests – kein Mocking nötig.
- Speicherverbrauch bleibt auch bei vielen offenen WebSockets flach, weil jede
  Verbindung nur eine Task und einen Kanal kostet.

## Sicherheit

- Passwörter: **Argon2id** (RustCrypto, keine nativen Abhängigkeiten).
- Access-Token: HS256-JWT (selbst implementiert, Algorithmus fest verdrahtet –
  `alg: none` und Verfahrenswechsel sind damit ausgeschlossen), 15 Minuten.
  Refresh-Token: 48 zufällige Bytes, nur als SHA-256-Hash gespeichert, wird bei
  jedem Refresh rotiert und dabei entwertet.
- Jede Route prüft die Chat-Mitgliedschaft (`assert_membership`).
- Medien-URLs sind **Zugriffsschlüssel**, keine geschützten Adressen: Die
  Anhang-ID ist eine UUID v7 mit 74 Zufallsbits, und wer die URL hat, bekommt
  die Datei – ohne Anmeldung. Das ist Absicht, sonst könnten weder `<img>` noch
  der Service-Worker-Cache sie laden. Was die Auslieferung stattdessen tut:
  `X-Robots-Tag: noindex, nofollow, noarchive, noimageindex`, damit ein
  versehentlich veröffentlichter Link wenigstens nicht auffindbar wird,
  `X-Content-Type-Options: nosniff` und eine CSP mit `sandbox` – falls ein
  Browser die Antwort doch als Dokument darstellt, läuft darin kein Skript.
  Mit S3/R2 sind es stattdessen kurzlebige signierte Links.
- **Dateien im Speicher können verschlüsselt liegen** (`MEDIA_KEY`): Der
  `Tresor` schiebt sich vor den eigentlichen Speicher, alles Neue geht
  verschlüsselt hinein. Ohne Schlüssel bleibt alles wie bisher – das
  Einschalten ist eine Zeile in der Umgebung, kein Umbau.
- **Gelöschtes verschwindet auch wirklich.** Ein Auslöser in der Datenbank
  trägt jeden gelöschten Anhang in `storage_muell` ein, ein Hintergrunddienst
  löscht die Bytes. Der Weg über die Datenbank statt über den Anwendungscode
  ist der einzige, der auch `on delete cascade` mitbekommt.
- **Metadaten verlassen das Gerät nicht**: Fotos werden vor dem Hochladen neu
  gezeichnet (EXIF fällt dabei weg), bei Videos werden die Metadaten-Boxen im
  MP4 an Ort und Stelle überschrieben – Länge unverändert, weil `stco`
  absolute Dateipositionen enthält.
- Web Push ist nach RFC 8291 (aes128gcm) direkt implementiert; die
  Verschlüsselung ist mit einem Round-Trip-Test abgesichert.
- Ratenbegrenzung sitzt in `drossel.rs` – vor Anmeldung (je Konto und je
  Adresse), Registrierung, Token-Erneuerung, Passkeys, Passwortwechsel,
  Personensuche und dem Verwaltungsbereich.

## Tests

```bash
cargo test --manifest-path apps/api/Cargo.toml            # Unit-Tests
TEST_DATABASE_URL=postgres://… cargo test --test e2e      # kompletter API-Durchlauf
pnpm -r test                                              # Vitest
pnpm --filter @initiative/web e2e                         # Playwright im Browser
```

Der End-to-End-Test fährt den gesamten Router gegen eine echte Postgres-Datenbank
(ohne Netzwerk-Port): Registrierung, Token-Rotation, Chats, Idempotenz,
Ungelesen-Zähler, Reaktionen, Berechtigungen, Medien-Upload inklusive
Range-Requests, Sticker, Umfragen, Terminfindung → Termin, ICS-Feed und eine
komplette Partie Tic Tac Toe.

Daneben liegen in `apps/api/tests/` weitere Durchläufe, die jeweils eine Zusage
prüfen, die man sonst nur glauben müsste: `loeschen.rs` und
`betroffenenrechte.rs` (Konto weg heißt Daten weg), `muell.rs` (die Bytes
gelöschter Anhänge verschwinden auch bei einem Fehlschlag nicht aus der
Warteschlange), `tresor.rs` (verschlüsselt abgelegt, unverschlüsselt gelesen),
`medien_auslieferung.rs`, `bremse.rs`, `abrechnen.rs`, `listen.rs` und
`migrationen.rs`.
