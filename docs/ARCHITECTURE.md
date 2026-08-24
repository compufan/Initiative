# Architektur

Initiative ist **keine Messenger-App, sondern eine Plattform** – der Messenger ist
nur das erste Modul. Alles ist so geschnitten, dass ein neues Feature (Mini-Spiel,
Aufgabenliste, Kasse, …) hinzugefügt wird, ohne den Kern anzufassen.

```
Initiative/
├── apps/
│   ├── api/          Fastify-Backend (Fly.io, Koyeb, Docker, eigener Server)
│   └── web/          React-PWA (Vercel, Cloudflare Pages, eigener Server)
└── packages/
    └── shared/       Contracts: Typen, Zod-Schemas, Realtime-Protokoll, Spiellogik
```

## Datenfluss

```
PWA  ──REST /api/v1──▶  Fastify  ──SQL──▶  Postgres (Neon / Supabase / eigener)
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
| Backend-Modul | `apps/api/src/modules/<name>/index.ts` + `registry.ts` | eigene REST-Routen |
| Message-Expander | `registerMessageExpander()` | eigene Entitäten in Nachrichten einbetten |
| Frontend-Modul | `apps/web/src/modules/<name>/module.ts` + `registry.ts` | Routen, Tab, Chat-Bubbles, Composer-Aktionen |
| Mini-Spiel | `packages/shared/src/games/<name>.ts` + `registerGame()` | Regeln (Server validiert, Client rendert) |

### Backend-Modul

```ts
export default defineModule({
  key: 'tasks',
  description: 'Aufgabenlisten',
  register(app, ctx) {
    app.get('/tasks', { preHandler: app.authenticate }, async (request) => {
      const userId = requireUserId(request);
      return ctx.sql`select * from tasks where user_id = ${userId}`;
    });
  },
});
```

`ctx` enthält `sql`, `storage`, `hub` (Realtime), `push` und `env`. Neue Tabellen
kommen als nummerierte Datei nach `apps/api/migrations/`.

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

## Sicherheit

* Passwörter: `scrypt` (Node-Crypto, keine nativen Module).
* Access-Token: HS256-JWT, 15 Minuten; Refresh-Token: 48 zufällige Bytes,
  nur als SHA-256-Hash gespeichert, wird bei jedem Refresh rotiert.
* Jede Route prüft die Chat-Mitgliedschaft (`assertMembership`).
* Medien-URLs sind kurzlebige signierte R2/S3-Links.
