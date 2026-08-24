# Initiative

**Eine erweiterbare PWA-Plattform – der Messenger ist nur das erste Modul.**

Initiative ist keine fertige Chat-App, die man höchstens umlackieren kann, sondern
ein Fundament: ein Rust-Backend, eine installierbare React-PWA und ein
Modul-Contract, der beides verbindet. Wer eine Aufgabenliste, eine Haushaltskasse
oder ein weiteres Mini-Spiel dazubaut, legt einen Ordner an und trägt eine Zeile in
eine Registry ein – der Kern bleibt unangetastet.

Das erste Modul ist ein vollständiger Messenger: Text, Sticker (inklusive eigenem
Editor), Fotos mit Kameraanbindung, Sprachnachrichten, Videos, Kalender, Umfragen,
Terminfindung und Mini-Spiele.

|              |                                                                          |
| ------------ | ------------------------------------------------------------------------ |
| **Backend**  | Rust (Axum 0.8, sqlx, Postgres) – eine Binary, Migrationen einkompiliert |
| **Frontend** | React 19 + Vite, installierbare PWA mit Service Worker                   |
| **Realtime** | WebSocket `/ws`, Broadcast über Postgres `LISTEN/NOTIFY`                 |
| **Medien**   | lokale Platte oder Cloudflare R2 / S3 mit presigned URLs                 |
| **Push**     | Web Push (VAPID, RFC 8291) für Android und iOS 16.4+                     |

---

## Funktionen

**Messenger**

- [x] Direktchats und Gruppen mit Rollen (Besitzer, Admin, Mitglied)
- [x] Antworten auf Nachrichten, Bearbeiten, Löschen, Volltextsuche
- [x] Reaktionen mit Emoji, Lesebestätigungen, Tipp-Anzeige, Online-Status
- [x] Stummschalten auf Zeit und Archivieren von Chats
- [x] Ungesendete Nachrichten warten offline in einer Outbox

**Medien**

- [x] Kamera direkt in der App: Foto und Video, Front-/Rückkamera, Live-Vorschau
- [x] Fotos und Videos aus der Galerie, Bilder werden vor dem Upload verkleinert
- [x] Sprachnachrichten mit Aufnahme, Wellenform und Abspielen
- [x] Beliebige Dateien, Bildergalerie mit Lightbox, Video-Vorschaubilder
- [x] Medien landen offline im Cache und bleiben dort lesbar

**Sticker**

- [x] Sticker-Tastatur im Chat
- [x] Sticker-Editor: freistellen, zuschneiden, Text und weiße Kontur
- [x] Eigene Pakete anlegen, teilen, installieren und wieder entfernen

**Kalender**

- [x] Monats- und Agenda-Ansicht, Termine mit Ort, Farbe und Erinnerungen
- [x] Zu- und Absagen (ja / nein / vielleicht) direkt in der Chat-Blase
- [x] Serientermine (RRULE) und ICS-Abo für iPhone, Android und Outlook

**Umfragen und Terminfindung**

- [x] Umfragen im Chat, einfach oder Mehrfachauswahl, optional anonym
- [x] Terminfindung mit ja / vielleicht / nein je Vorschlag und Auswertung
- [x] Aus dem besten Vorschlag wird mit einem Tipp ein echter Termin

**Mini-Spiele**

- [x] Tic Tac Toe und Vier gewinnt, direkt aus dem Chat gestartet
- [x] Der Server prüft jeden Zug – schummeln geht nicht
- [x] Neues Spiel = eine Rust-Datei, ein TypeScript-Spiegel, ein Spielbrett

**Plattform**

- [x] Installierbar auf iPhone, Android und Desktop, arbeitet offline weiter
- [x] Push-Benachrichtigungen, Hell/Dunkel-Design, Akzentfarbe je Konto
- [x] Teilen-Ziel des Systems: Fotos aus anderen Apps direkt in einen Chat
- [x] Registrierung offen, per Einladungscode oder komplett geschlossen

---

## Screenshots

| Chatliste                                   | Terminfindung im Chat                          | Kalender                                      |
| ------------------------------------------- | ---------------------------------------------- | --------------------------------------------- |
| ![Chatliste](docs/screenshots/01-chats.png) | ![Terminfindung](docs/screenshots/02-chat.png) | ![Kalender](docs/screenshots/03-kalender.png) |

| Spiele                                    | Profil                                    | Einstellungen                                           |
| ----------------------------------------- | ----------------------------------------- | ------------------------------------------------------- |
| ![Spiele](docs/screenshots/04-spiele.png) | ![Profil](docs/screenshots/05-profil.png) | ![Einstellungen](docs/screenshots/06-einstellungen.png) |

<sub>Aufgenommen mit den Demo-Daten aus `cargo run --bin seed`.</sub>

---

## Schnellstart (lokal)

### Voraussetzungen

| Werkzeug | Version | Prüfen                                     |
| -------- | ------- | ------------------------------------------ |
| Rust     | stable  | `rustc --version`                          |
| Node     | >= 20   | `node --version`                           |
| pnpm     | 10.x    | `pnpm --version` (sonst `corepack enable`) |
| Postgres | >= 14   | `psql --version`                           |

### 1. Repository holen und Abhängigkeiten installieren

```bash
git clone https://github.com/compufan/Initiative.git
cd Initiative
pnpm install
```

### 2. Konfiguration anlegen

```bash
cp .env.example .env
```

Für den Start reichen zwei Werte in der `.env`:

```ini
DATABASE_URL=postgres://initiative:initiative@localhost:5432/initiative
JWT_SECRET=hier-einen-langen-zufallswert-einsetzen
```

Ein passendes Geheimnis erzeugst du mit:

```bash
openssl rand -base64 48
```

Lokal darf `JWT_SECRET` auch fehlen – dann würfelt die API bei jedem Start ein
neues, und du musst dich nach jedem Neustart erneut anmelden.

Alle weiteren Variablen sind in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) erklärt.

### 3. Datenbank anlegen

```bash
createdb initiative
# oder, ohne lokalen Postgres:
docker run -d --name initiative-pg -p 5432:5432 \
  -e POSTGRES_USER=initiative -e POSTGRES_PASSWORD=initiative -e POSTGRES_DB=initiative \
  postgres:16-alpine
```

Migrationen musst du nicht aufrufen: Sie stecken in der Binary und laufen beim
Start (`RUN_MIGRATIONS=true`, Standard).

### 4. Starten

```bash
pnpm dev
```

Das startet die Rust-API auf **http://localhost:8080** und die PWA auf
**http://localhost:5173**. Vite leitet `/api` und `/ws` an die API weiter – du
brauchst lokal also kein `VITE_API_URL`.

Nur eines von beiden: `pnpm dev:api` bzw. `pnpm dev:web`.

### 5. Demo-Daten (optional)

```bash
cargo run --manifest-path apps/api/Cargo.toml --bin seed
```

Legt drei Benutzer an – **anna**, **ben** und **clara**, Passwort **`passwort123`** –
dazu eine Wandergruppe, einen Direktchat, eine Umfrage, eine Terminfindung, einen
Termin und eine laufende Partie Tic Tac Toe. Ein zweiter Lauf ändert nichts.

### Vom Handy im selben WLAN testen

Der Vite-Server lauscht bereits auf allen Adressen (`vite --host`). Finde die
IP deines Rechners und öffne sie auf dem Handy:

```bash
# macOS / Linux
ipconfig getifaddr en0 2>/dev/null || hostname -I
# → z. B. 192.168.1.42, dann am Handy: http://192.168.1.42:5173
```

Die API akzeptiert im Entwicklungsmodus Anfragen von `192.168.*` und `10.*`
automatisch – CORS musst du dafür nicht anfassen.

> **Wichtig:** Kamera, Mikrofon, Service Worker, Installation und Push sind
> „secure contexts“. Der Browser erlaubt sie nur über **https** oder auf
> **localhost**. Über `http://192.168.x.x` kannst du chatten und lesen, aber
> keine Fotos aufnehmen, keine Sprachnachrichten aufzeichnen, die App nicht
> installieren und keine Benachrichtigungen abonnieren. Für einen echten Test
> auf dem Handy brauchst du https – am einfachsten über einen Tunnel
> (`cloudflared tunnel --url http://localhost:5173`) oder ein Deployment nach
> [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

### Tests und Prüfungen

```bash
pnpm test                      # Rust-Unit-Tests + Vitest
pnpm typecheck                 # tsc über alle Pakete + cargo check
pnpm lint                      # clippy mit -D warnings
pnpm build                     # Release-Binary + PWA-Bundle

# End-to-End-Test der API gegen eine echte Datenbank
TEST_DATABASE_URL=postgres://initiative:initiative@localhost:5432/initiative_test \
  cargo test --manifest-path apps/api/Cargo.toml
```

---

## Projektstruktur

```
Initiative/
├─ apps/
│  ├─ api/                       Rust-Backend (Axum + sqlx)
│  │  ├─ migrations/             0001_init.sql – in die Binary eingebettet
│  │  ├─ Dockerfile              zweistufig, Ergebnis ist nur die Binary
│  │  └─ src/
│  │     ├─ modules/             REST-Module: auth, users, conversations,
│  │     │                       messages, media, stickers, calendar, polls,
│  │     │                       games, push
│  │     ├─ services/            Fachlogik + Message-Expander
│  │     ├─ games/               Spielregeln (autoritativ, serverseitig)
│  │     ├─ realtime/            WebSocket-Hub, Postgres LISTEN/NOTIFY
│  │     ├─ storage/             local | r2 | s3
│  │     ├─ push/                Web Push (VAPID, aes128gcm)
│  │     ├─ config.rs            alle Umgebungsvariablen an einer Stelle
│  │     └─ bin/seed.rs          Demo-Daten
│  └─ web/                       React-PWA (Vite)
│     └─ src/
│        ├─ modules/             messenger, media, stickers, calendar,
│        │                       polls, games, profile
│        ├─ components/          Avatar, Sheet, Screen, Feedback
│        ├─ lib/                 api.ts, realtime.ts, db.ts, upload.ts, push.ts
│        ├─ state/               session, chat, ui (zustand)
│        ├─ styles/              tokens.css, global.css
│        └─ sw.ts                Service Worker: Offline, Push, Share Target
├─ packages/
│  └─ shared/                    TypeScript-Contracts: Typen, Limits,
│                                Realtime-Protokoll, Spielregeln-Spiegel
├─ docs/                         ARCHITECTURE · API · DEPLOYMENT · EXTENDING · FEATURES
├─ scripts/dev.mjs               startet API und PWA gemeinsam
├─ docker-compose.yml            Postgres + API + PWA hinter Caddy
└─ .env.example                  kommentierte Beispielkonfiguration
```

---

## Deployment

Frontend und Backend lassen sich getrennt betreiben – oder gemeinsam hinter einer
Domain (`docker compose up -d --build`), dann gibt es weder CORS- noch
Cookie-Sonderfälle.

| Baustein  | Empfehlung                             | Alternativen                                               | Kosten im kleinen Rahmen |
| --------- | -------------------------------------- | ---------------------------------------------------------- | ------------------------ |
| PWA       | **Vercel** (Root Directory `apps/web`) | Cloudflare Pages, Netlify, eigener Caddy/nginx             | kostenlos                |
| API       | **Fly.io** (`fly deploy`)              | Koyeb (Docker), Railway, Docker Compose auf eigenem Server | kostenlos bis wenige €   |
| Datenbank | **Neon** (pooled Connection String)    | Supabase, eigener Postgres                                 | kostenlos                |
| Medien    | **Cloudflare R2** (presigned PUT/GET)  | AWS S3, Backblaze B2, MinIO, `STORAGE_DRIVER=local`        | kostenlos bis 10 GB      |
| Push      | Web Push mit eigenen VAPID-Schlüsseln  | –                                                          | kostenlos                |

Vollständige Anleitung mit allen Umgebungsvariablen, CORS-Regel für R2,
`fly secrets set`, Vercel-Einstellungen und Produktions-Checkliste:
**[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**

---

## Auf dem iPhone installieren

1. Die App in **Safari** öffnen (Chrome auf iOS kann keine PWA installieren).
2. Unten auf **Teilen** tippen (Quadrat mit Pfeil nach oben).
3. **„Zum Home-Bildschirm"** wählen, Namen bestätigen, **Hinzufügen**.
4. Initiative vom Home-Bildschirm starten – jetzt ohne Safari-Leiste, im
   Vollbild und mit eigenem Symbol.
5. Für Benachrichtigungen anschließend in der App auf **Profil → Einstellungen →
   Benachrichtigungen** tippen und erlauben.

> iOS erlaubt Web Push **erst ab iOS 16.4 und nur in der installierten PWA**.
> Solange die App nur im Browser läuft, blendet die Oberfläche einen Hinweis ein
> statt eines Schalters.

## Auf Android installieren

1. Die App in **Chrome** (oder Edge, Samsung Internet) öffnen.
2. Den Hinweis **„App installieren"** antippen – oder Menü **⋮ → App installieren**
   bzw. **Zum Startbildschirm hinzufügen**.
3. Initiative erscheint im App-Drawer und startet als eigenständige App.
4. Benachrichtigungen können direkt im Browser erlaubt werden, eine Installation
   ist dafür nicht nötig.

Die App bringt außerdem Schnellzugriffe mit (langes Drücken auf das Symbol):
**Neuer Chat**, **Kalender**, **Spiele**. Und sie meldet sich als Teilen-Ziel: Ein
Foto aus der Galerie lässt sich über „Teilen → Initiative" direkt in einen Chat
schicken.

---

## Erweitern

Ein neues Modul ist eine Datei im Backend, ein Ordner im Frontend und je eine
Zeile in einer Registry. Das Kochbuch mit vollständigen Beispielen – neues
Backend-Modul, neues Frontend-Modul, neuer Nachrichtentyp und ein komplettes
Mini-Spiel („Schere Stein Papier") – steht in
**[docs/EXTENDING.md](docs/EXTENDING.md)**.

## Dokumentation

| Datei                                        | Inhalt                                             |
| -------------------------------------------- | -------------------------------------------------- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Aufbau, Datenfluss, Erweiterungspunkte, Sicherheit |
| [docs/FEATURES.md](docs/FEATURES.md)         | Was die App aus Nutzersicht kann                   |
| [docs/API.md](docs/API.md)                   | Alle Endpunkte, Realtime-Protokoll, Fehlerformat   |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)     | Schritt für Schritt in Produktion                  |
| [docs/EXTENDING.md](docs/EXTENDING.md)       | Kochbuch für neue Module und Spiele                |

## Lizenz

[MIT](LICENSE) – benutze es, verändere es, betreibe es für dich und deine Leute.
