# Architektur

Initiative ist **keine Messenger-App, sondern eine Plattform** – der Messenger ist
nur das erste Modul. Alles ist so geschnitten, dass ein neues Feature (Mini-Spiel,
Aufgabenliste, Kasse, …) hinzugefügt wird, ohne den Kern anzufassen.

```
Initiative/
├── apps/
│   ├── api/          Rust-Backend (Axum + sqlx) – Fly.io, Koyeb, Docker, eigener Server
│   └── web/          React-PWA (Vite) – Vercel, Cloudflare Pages, eigener Server
└── packages/
    └── shared/       TypeScript-Contracts für die PWA (Typen, Zod-Schemas, Protokoll)
```

Das Backend ist die **einzige Quelle der Wahrheit** für den API-Vertrag.
`packages/shared` spiegelt diesen Vertrag für die PWA: dieselben Feldnamen
(camelCase), dieselben Grenzwerte, dasselbe Realtime-Protokoll. Wer einen
Endpunkt ändert, ändert beides.

## Datenfluss

```
PWA  ──REST /api/v1──▶  Axum (Rust)  ──SQL──▶  Postgres (Neon / Supabase / eigener)
 ▲                          │
 └──── WebSocket /ws ───────┘   Broadcast über Postgres LISTEN/NOTIFY
                                Medien: presigned PUT/GET direkt auf R2/S3
                                Push: Web Push (VAPID) an Android & iOS 16.4+
```

* **Schreiben** geht immer über REST (idempotent per `clientId`).
* **Lesen im Betrieb** kommt über den WebSocket; REST wird nur beim Kaltstart
  und beim Nachladen älterer Nachrichten benutzt.
* **Medien** laufen nie durch den API-Container, wenn R2/S3 konfiguriert ist.

## Erweiterungspunkte

| Punkt | Datei | Wofür |
| --- | --- | --- |
| Backend-Modul | `apps/api/src/modules/<name>.rs` + `modules/mod.rs` | eigene REST-Routen |
| Message-Expander | `impl MessageExpander` + Eintrag in `services/expanders.rs` | eigene Entitäten in Nachrichten einbetten |
| Frontend-Modul | `apps/web/src/modules/<name>/module.ts` + `registry.ts` | Routen, Tab, Chat-Bubbles, Composer-Aktionen |
| Mini-Spiel | `apps/api/src/games/<name>.rs` + `games/mod.rs` | Regeln (Server validiert autoritativ) |
| Spielbrett | `apps/web/src/modules/games/boards/` | Darstellung eines Spiels |

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
`AppState` enthält `pool`, `storage`, `hub` (Realtime), `push` und `config`.
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

`users` · `refresh_tokens` · `push_subscriptions` · `conversations` ·
`conversation_members` · `messages` · `attachments` · `reactions` ·
`sticker_packs` · `stickers` · `sticker_pack_installs` · `polls` · `poll_options` ·
`poll_votes` · `calendar_events` · `event_attendees` · `game_sessions`

Alle IDs sind **UUID v7** (zeitlich sortierbar) – dadurch funktioniert
Keyset-Pagination (`where id < cursor`) und `id > last_read_message_id` als
Ungelesen-Zähler ohne zusätzlichen Index.

## Realtime-Protokoll

Ein Envelope für beide Richtungen:

```json
{ "v": 1, "type": "message.new", "ts": "2026-08-24T10:00:00.000Z", "payload": { } }
```

Server → Client: `hello`, `message.new|updated|deleted|reactions`,
`conversation.updated|removed`, `read.updated`, `typing`, `presence`,
`poll.updated`, `event.updated|deleted`, `game.updated`, `user.updated`,
`sync.hint`, `error`.
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

* Eine statisch gelinkte Binary (~15 MB) ohne Laufzeit, OpenSSL oder libcurl –
  das Container-Image bleibt klein und startet in Millisekunden.
* Der Compiler erzwingt, dass jeder Fehlerfall behandelt wird; `AppError` ist der
  einzige Weg, wie eine Anfrage scheitern kann.
* Spielregeln, Umfragen-Auswertung, Serientermine und die Web-Push-Verschlüsselung
  sind reine Funktionen mit Unit-Tests – kein Mocking nötig.
* Speicherverbrauch bleibt auch bei vielen offenen WebSockets flach, weil jede
  Verbindung nur eine Task und einen Kanal kostet.

## Sicherheit

* Passwörter: **Argon2id** (RustCrypto, keine nativen Abhängigkeiten).
* Access-Token: HS256-JWT (selbst implementiert, Algorithmus fest verdrahtet –
  `alg: none` und Verfahrenswechsel sind damit ausgeschlossen), 15 Minuten.
  Refresh-Token: 48 zufällige Bytes, nur als SHA-256-Hash gespeichert, wird bei
  jedem Refresh rotiert und dabei entwertet.
* Jede Route prüft die Chat-Mitgliedschaft (`assertMembership`).
* Medien-URLs sind kurzlebige signierte R2/S3-Links. Ohne S3 liefert die API
  selbst aus – die Anhang-ID ist eine UUID v7 mit 74 Zufallsbits und wirkt als
  Capability-URL, damit `<img>` und der Service-Worker-Cache ohne Header
  funktionieren.
* Web Push ist nach RFC 8291 (aes128gcm) direkt implementiert; die
  Verschlüsselung ist mit einem Round-Trip-Test abgesichert.

## Tests

```bash
cargo test --manifest-path apps/api/Cargo.toml            # Unit-Tests
TEST_DATABASE_URL=postgres://… cargo test --test e2e      # kompletter API-Durchlauf
```

Der End-to-End-Test fährt den gesamten Router gegen eine echte Postgres-Datenbank
(ohne Netzwerk-Port): Registrierung, Token-Rotation, Chats, Idempotenz,
Ungelesen-Zähler, Reaktionen, Berechtigungen, Medien-Upload inklusive
Range-Requests, Sticker, Umfragen, Terminfindung → Termin, ICS-Feed und eine
komplette Partie Tic Tac Toe.
