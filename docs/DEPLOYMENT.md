# Deployment

Initiative besteht aus zwei Teilen, die getrennt oder gemeinsam laufen können:

- **API** – eine einzelne Rust-Binary (Axum). Braucht Postgres, optional S3/R2 und
  VAPID-Schlüssel. Migrationen sind einkompiliert und laufen beim Start.
- **PWA** – statische Dateien (HTML, JS, CSS). Braucht nur einen Hoster, der
  alle Pfade auf `index.html` zurückfallen lässt.

Zwei Betriebsarten:

| Variante                                               | Wann                                             | CORS                                                                  |
| ------------------------------------------------------ | ------------------------------------------------ | --------------------------------------------------------------------- |
| **Getrennt** – PWA bei Vercel/Pages, API bei Fly/Koyeb | Standardfall, kostenlos, schnellste Auslieferung | `CORS_ORIGINS` muss die PWA-URL enthalten, PWA braucht `VITE_API_URL` |
| **Eine Domain** – `docker compose up -d --build`       | eigener Server, alles unter einer Domain         | kein CORS, `VITE_API_URL` bleibt leer                                 |

Die Reihenfolge unten ist die empfohlene: erst Datenbank, dann Medien, dann
Backend, dann Frontend, dann Push.

---

## Alle Umgebungsvariablen

Gelesen in `apps/api/src/config.rs`. Was hier nicht steht, wird nicht gelesen.

### Betrieb

| Variable         | Standard      | Bedeutung                                                                                                                           |
| ---------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`       | `development` | `development` \| `test` \| `production`. In `production` ist `JWT_SECRET` Pflicht und die CORS-Ausnahme für lokale Netze fällt weg. |
| `HOST`           | `0.0.0.0`     | Bind-Adresse. Bei Fly/Koyeb/Docker so lassen.                                                                                       |
| `PORT`           | `8080`        | Port der API.                                                                                                                       |
| `LOG_LEVEL`      | `info`        | `error` \| `warn` \| `info` \| `debug` \| `trace`. `RUST_LOG` überschreibt das.                                                     |
| `RUN_MIGRATIONS` | `true`        | Migrationen beim Start anwenden. Nur `false` schaltet ab.                                                                           |

### Datenbank

| Variable            | Standard        | Bedeutung                                                                 |
| ------------------- | --------------- | ------------------------------------------------------------------------- |
| `DATABASE_URL`      | – (**Pflicht**) | Postgres-Verbindung. TLS wird über die URL gesteuert: `?sslmode=require`. |
| `DATABASE_POOL_MAX` | `10`            | Maximale Verbindungen im Pool. Bei kleinen Hostern eher senken (5).       |

> Rust-API aber **nicht** ausgewertet – TLS kommt ausschließlich aus dem
> Connection String. Neon und Supabase liefern ihn bereits mit `sslmode=require`.

### Sicherheit und Konten

| Variable                 | Standard           | Bedeutung                                                                                                                    |
| ------------------------ | ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `JWT_SECRET`             | zufällig (nur Dev) | Signaturschlüssel der Access-Token (HS256). Mindestens 16 Zeichen, in `production` Pflicht. Ändern entwertet alle Sitzungen. |
| `ACCESS_TOKEN_TTL`       | `900`              | Laufzeit des Access-Tokens in Sekunden (15 Minuten).                                                                         |
| `REFRESH_TOKEN_TTL_DAYS` | `60`               | Laufzeit des Refresh-Tokens in Tagen. Er rotiert bei jedem Refresh.                                                          |
| `REGISTRATION_MODE`      | `open`             | `open` \| `invite` \| `closed`.                                                                                              |
| `INVITE_CODES`           | leer               | Kommaliste gültiger Codes, wirkt bei `REGISTRATION_MODE=invite`.                                                             |

### URLs und CORS

| Variable         | Standard                | Bedeutung                                                                                                 |
| ---------------- | ----------------------- | --------------------------------------------------------------------------------------------------------- |
| `PUBLIC_APP_URL` | `http://localhost:5173` | Öffentliche URL der PWA. Landet in Push-Links und ICS-Einträgen und gilt immer als erlaubter CORS-Origin. |
| `PUBLIC_API_URL` | `http://localhost:8080` | Öffentliche URL der API. Bildet die Medien-URLs in jedem DTO.                                             |
| `CORS_ORIGINS`   | leer                    | Kommaliste zusätzlicher Origins. `*` erlaubt alle (dann ohne Credentials).                                |

### Speicher

| Variable               | Standard          | Bedeutung                                                                                  |
| ---------------------- | ----------------- | ------------------------------------------------------------------------------------------ |
| `STORAGE_DRIVER`       | `local`           | `local` \| `r2` \| `s3`.                                                                   |
| `LOCAL_STORAGE_DIR`    | `./.data/uploads` | Verzeichnis bei `local`. Muss ein persistentes Volume sein.                                |
| `S3_BUCKET`            | –                 | Pflicht bei `r2`/`s3`.                                                                     |
| `S3_ACCESS_KEY_ID`     | –                 | Pflicht bei `r2`/`s3`.                                                                     |
| `S3_SECRET_ACCESS_KEY` | –                 | Pflicht bei `r2`/`s3`.                                                                     |
| `S3_ENDPOINT`          | –                 | Bei `r2` Pflicht: `https://<account-id>.r2.cloudflarestorage.com`. Bei AWS S3 leer lassen. |
| `S3_REGION`            | `auto`            | Bei R2 `auto`, bei AWS z. B. `eu-central-1`.                                               |
| `S3_FORCE_PATH_STYLE`  | `true`            | R2, MinIO: `true`. AWS S3: `false`.                                                        |
| `S3_PUBLIC_BASE_URL`   | leer              | Öffentliche Bucket-Domain. Gesetzt → keine signierten Download-URLs mehr.                  |
| `SIGNED_URL_TTL`       | `3600`            | Gültigkeit signierter URLs in Sekunden.                                                    |

### Realtime und Push

| Variable            | Standard                   | Bedeutung                                                                       |
| ------------------- | -------------------------- | ------------------------------------------------------------------------------- |
| `REALTIME_BUS`      | `postgres`                 | `postgres` (LISTEN/NOTIFY, mehrere Instanzen) \| `memory` (genau eine Instanz). |
| `VAPID_PUBLIC_KEY`  | leer                       | Web-Push-Schlüsselpaar. Fehlt eines von beiden, ist Push schlicht aus.          |
| `VAPID_PRIVATE_KEY` | leer                       | siehe oben.                                                                     |
| `VAPID_SUBJECT`     | `mailto:admin@example.com` | Kontakt für die Push-Dienste.                                                   |

### PWA (Build-Zeit, `apps/web`)

| Variable             | Standard                | Bedeutung                                                                           |
| -------------------- | ----------------------- | ----------------------------------------------------------------------------------- |
| `VITE_API_URL`       | leer                    | Basis-URL der API. **Leer lassen**, wenn PWA und API unter derselben Domain liegen. |
| `VITE_DEV_API_PROXY` | `http://localhost:8080` | Ziel des Vite-Proxys, nur für `pnpm dev`.                                           |
| `VITE_APP_VERSION`   | `0.1.0`                 | Wird im Profil unter „Über" angezeigt.                                              |
| `VITE_REPO_URL`      | GitHub-URL              | Link im Profil.                                                                     |

Diese vier Werte werden **in das Bundle einkompiliert**. Nach einer Änderung muss
neu gebaut werden – ein Neustart reicht nicht.

---

## a) Datenbank

### Neon (empfohlen)

1. Auf [neon.tech](https://neon.tech) ein Projekt anlegen, Region nah an der API.
2. Unter **Connection Details** die **„Pooled connection"** wählen – nicht die
   direkte. Sie sieht so aus:

   ```
   postgres://user:passwort@ep-xyz-123-pooler.eu-central-1.aws.neon.tech/initiative?sslmode=require
   ```

3. Diesen String als `DATABASE_URL` setzen. Mehr ist nicht nötig: Beim ersten
   Start legt die API alle Tabellen selbst an.

> `-pooler` im Hostnamen ist wichtig. Ohne Pooler geht Neon bei mehreren
> Verbindungen schnell in die Knie; mit Pooler `DATABASE_POOL_MAX=5` setzen.

### Supabase

1. Projekt anlegen, **Project Settings → Database → Connection string → URI**.
2. Den **Transaction-Pooler** (Port `6543`) nehmen und `DATABASE_POOL_MAX=5` setzen.
3. `?sslmode=require` anhängen, falls nicht schon enthalten.

Die Auth- und Storage-Dienste von Supabase werden nicht benutzt – Initiative
bringt beides selbst mit.

### Eigener Postgres

```bash
sudo -u postgres createuser --pwprompt initiative
sudo -u postgres createdb --owner=initiative initiative
```

```
DATABASE_URL=postgres://initiative:PASSWORT@127.0.0.1:5432/initiative
```

Läuft Postgres auf einem anderen Rechner, unbedingt TLS erzwingen
(`?sslmode=require`) und den Port nicht ins Internet hängen.

---

## b) Medien: Cloudflare R2

Ohne S3/R2 läuft alles über `STORAGE_DRIVER=local`; dann brauchst du ein
persistentes Volume und jedes Byte fließt durch den API-Container. Mit R2 gehen
Uploads und Downloads direkt vom Browser zum Speicher.

### 1. Bucket anlegen

Cloudflare Dashboard → **R2** → **Create bucket**, z. B. `initiative-media`.
Location automatisch. Der Bucket bleibt **privat**.

### 2. API-Token erzeugen

**R2 → Manage R2 API Tokens → Create API token**

- Permissions: **Object Read & Write**
- Scope: nur dieser Bucket

Cloudflare zeigt danach einmalig:

| Feld im Dashboard                              | Umgebungsvariable      |
| ---------------------------------------------- | ---------------------- |
| Access Key ID                                  | `S3_ACCESS_KEY_ID`     |
| Secret Access Key                              | `S3_SECRET_ACCESS_KEY` |
| Account ID (oben rechts / in der R2-Übersicht) | Teil von `S3_ENDPOINT` |

### 3. Variablen setzen

```bash
STORAGE_DRIVER=r2
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=initiative-media
S3_ACCESS_KEY_ID=…
S3_SECRET_ACCESS_KEY=…
S3_FORCE_PATH_STYLE=true
SIGNED_URL_TTL=3600
```

`S3_ENDPOINT` enthält **nur** Account-ID und Domain – der Bucket-Name gehört
nicht hinein, den hängt die API selbst an (Path-Style).

### 4. CORS-Regel

Der Browser lädt Dateien mit `PUT` direkt in den Bucket. Ohne CORS-Regel bricht
das ab. **R2 → Bucket → Settings → CORS Policy → Edit**, dann dieses JSON
einsetzen und `AllowedOrigins` auf die URL **deiner PWA** ändern:

```json
[
  {
    "AllowedOrigins": ["https://initiative.example.com"],
    "AllowedMethods": ["PUT", "GET"],
    "AllowedHeaders": ["content-type"],
    "ExposeHeaders": ["etag", "content-length"],
    "MaxAgeSeconds": 3600
  }
]
```

Mehrere Umgebungen (Produktion und Vorschau) einfach als weitere Einträge in
`AllowedOrigins` ergänzen. Ein `*` funktioniert, verschenkt aber Sicherheit ohne
Not.

### 5. Prüfen

Nach dem Deploy in der App ein Foto senden. Klappt der Upload, aber das Bild
bleibt grau, ist meistens `ExposeHeaders` oder `AllowedOrigins` falsch – die
Browser-Konsole nennt den Origin, den R2 abgelehnt hat.

### AWS S3 / MinIO / Backblaze

Gleiche Variablen, nur:

```bash
STORAGE_DRIVER=s3
S3_ENDPOINT=                 # bei AWS leer lassen
S3_REGION=eu-central-1
S3_FORCE_PATH_STYLE=false    # AWS: false, MinIO: true
```

---

## c) Backend

### Fly.io

Die `fly`-CLI installieren – der Befehl unterscheidet sich nach Betriebssystem:

**macOS/Linux** (Terminal-App bzw. `Terminal.app`):

```bash
curl -L https://fly.io/install.sh | sh
```

**Windows** (PowerShell, nicht die Eingabeaufforderung/`cmd` öffnen):

```powershell
pwsh -Command "iwr https://fly.io/install.ps1 -useb | iex"
```

> `sh` gibt es unter Windows nicht – der Unix-Befehl oben schlägt dort immer
> fehl. Nach der Installation das PowerShell-Fenster einmal schließen und neu
> öffnen, damit `fly` im PATH steht.

Danach auf allen Systemen gleich, im selben Fenster (PowerShell unter
Windows, Terminal unter macOS/Linux):

```bash
fly auth login
```

```bash
cd /pfad/zu/Initiative
fly launch --no-deploy --name initiative-api --region fra
```

`fly launch` legt eine `fly.toml` an. Sie muss auf das API-Dockerfile zeigen und
den internen Port kennen:

```toml
app = "initiative-api"
primary_region = "fra"

[build]
  dockerfile = "apps/api/Dockerfile"

[env]
  NODE_ENV = "production"
  HOST = "0.0.0.0"
  PORT = "8080"
  REALTIME_BUS = "postgres"
  STORAGE_DRIVER = "r2"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = "suspend"
  auto_start_machines = true
  min_machines_running = 1        # bleibt wach – WebSockets vertragen kein Einschlafen

  [[http_service.checks]]
    path = "/healthz"
    interval = "30s"
    timeout = "5s"
```

Zuerst ein zufälliges `JWT_SECRET` erzeugen – der Befehl unterscheidet sich
nach Betriebssystem, das Ergebnis einfach für den nächsten Schritt kopieren.

**macOS/Linux** (Terminal):

```bash
openssl rand -base64 48
```

**Windows** (PowerShell):

```powershell
-join ((48..57) + (65..90) + (97..122) | Get-Random -Count 48 | ForEach-Object { [char]$_ })
```

Geheimnisse setzen (sie landen nicht in der `fly.toml`). Der Befehl ist
bewusst **eine einzige Zeile** ohne `\`-Zeilenumbrüche – die funktionieren in
PowerShell und `cmd` nicht wie in Bash und reißen den Befehl sonst
mittendrin ab. Platzhalter wie `‹…›` vorher durch die echten Werte ersetzen
(am einfachsten in einem Texteditor vorbereiten und dann als Ganzes
einfügen), egal in welchem Terminal:

```bash
fly secrets set --app initiative-api DATABASE_URL="postgres://…-pooler…/initiative?sslmode=require" JWT_SECRET="‹Wert von eben›" PUBLIC_APP_URL="https://initiative.example.com" PUBLIC_API_URL="https://initiative-api.fly.dev" CORS_ORIGINS="https://initiative.example.com" S3_ENDPOINT="https://<account-id>.r2.cloudflarestorage.com" S3_BUCKET="initiative-media" S3_ACCESS_KEY_ID="…" S3_SECRET_ACCESS_KEY="…" VAPID_PUBLIC_KEY="…" VAPID_PRIVATE_KEY="…" VAPID_SUBJECT="mailto:du@example.com"
```

```bash
fly deploy
```

```bash
fly logs
```

Danach reicht es, `https://initiative-api.fly.dev/healthz` in einem
Browser-Tab zu öffnen – kein Terminal nötig. Wer lieber im Terminal prüft:
Unter Windows PowerShell den Befehl explizit als `curl.exe` schreiben (nicht
nur `curl`), sonst greift PowerShells eigener `curl`-Alias
(`Invoke-WebRequest`), der andere Optionen erwartet.

```bash
curl.exe https://initiative-api.fly.dev/healthz
```

`min_machines_running = 1` ist kein Luxus: Ohne eine dauerhaft laufende Instanz
trennt jede eingeschlafene Maschine alle WebSockets und verzögert Push-Zustellungen.

### Koyeb (Docker-Deploy)

1. **Create Service → Docker** – oder **GitHub**, dann als Builder **Dockerfile**
   mit dem Pfad `apps/api/Dockerfile` und Build-Context `.` wählen.
2. **Instance**: Free/Nano genügt für eine kleine Gruppe.
3. **Ports**: `8080`, Protokoll `HTTP`. Health-Check-Pfad `/healthz`.
4. **Environment variables** – Geheimnisse als _Secret_ anlegen:

   ```
   NODE_ENV=production
   HOST=0.0.0.0
   PORT=8080
   DATABASE_URL=<secret>
   JWT_SECRET=<secret>
   PUBLIC_APP_URL=https://initiative.example.com
   PUBLIC_API_URL=https://initiative-api-<org>.koyeb.app
   CORS_ORIGINS=https://initiative.example.com
   STORAGE_DRIVER=r2
   S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
   S3_BUCKET=initiative-media
   S3_ACCESS_KEY_ID=<secret>
   S3_SECRET_ACCESS_KEY=<secret>
   VAPID_PUBLIC_KEY=<secret>
   VAPID_PRIVATE_KEY=<secret>
   REALTIME_BUS=postgres
   ```

5. **Deploy**, dann `https://…koyeb.app/healthz` aufrufen.

Alternativ das fertige Image bauen und schieben:

```bash
docker build -f apps/api/Dockerfile -t ghcr.io/<user>/initiative-api:latest .
docker push ghcr.io/<user>/initiative-api:latest
```

### Docker Compose auf eigenem Server

Die mitgelieferte `docker-compose.yml` startet Postgres, die API und die fertig
gebaute PWA hinter Caddy – alles unter **einer** Domain, `/api` und `/ws` gehen
an die API. Dadurch entfallen CORS und `VITE_API_URL`.

```bash
git clone https://github.com/compufan/Initiative.git
cd Initiative
cp .env.example .env
```

Zwei Zufallswerte erzeugen – diese Schritte laufen direkt auf dem Server
(typischerweise Linux), auf dem auch `docker compose` steht:

```bash
openssl rand -base64 24    # → POSTGRES_PASSWORD
openssl rand -base64 48    # → JWT_SECRET
```

> Bereitest du die `.env` stattdessen von einem Windows-Rechner aus vor: in
> PowerShell erzeugt `-join ((48..57) + (65..90) + (97..122) | Get-Random -Count 32 | ForEach-Object { [char]$_ })`
> denselben Zweck ohne `openssl`.

… und in die `.env` eintragen (eine `.env` kennt keine Befehlsersetzung, die
Werte müssen ausgeschrieben dastehen):

```ini
POSTGRES_PASSWORD=…
JWT_SECRET=…
PUBLIC_APP_URL=https://initiative.example.com
PUBLIC_API_URL=https://initiative.example.com
CORS_ORIGINS=https://initiative.example.com
WEB_PORT=8080
VITE_API_URL=
```

`VITE_API_URL` bleibt **leer** – PWA und API liegen hier unter einer Domain.

```bash
docker compose up -d --build
docker compose logs -f api
curl http://localhost:8080/healthz
```

Davor gehört ein Reverse Proxy mit echtem Zertifikat, z. B. Caddy:

```caddyfile
initiative.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

Caddy holt das Let's-Encrypt-Zertifikat selbst und reicht WebSocket-Upgrades
ohne Zusatzkonfiguration durch.

Nach jedem `git pull`:

```bash
docker compose up -d --build
```

Backup nicht vergessen:

```bash
docker compose exec -T postgres pg_dump -U initiative initiative | gzip > backup-$(date +%F).sql.gz
```

---

## d) Frontend

### Vercel

1. **Add New → Project**, Repository auswählen.
2. Einstellungen:

   | Feld               | Wert           |
   | ------------------ | -------------- |
   | Framework Preset   | Vite           |
   | **Root Directory** | `apps/web`     |
   | Install Command    | `pnpm install` |
   | **Build Command**  | `pnpm build`   |
   | Output Directory   | `dist`         |

   „Include source files outside of the Root Directory" muss aktiv sein – die
   PWA importiert `packages/shared`.

3. **Environment Variables** (für Production _und_ Preview):

   ```
   VITE_API_URL=https://initiative-api.fly.dev
   ```

4. Nichts weiter zu tun: `apps/web/vercel.json` liegt bereits im Repository und
   regelt Rewrites (Deep Links wie `/chats/<id>` landen nicht im 404), die
   Cache-Header und `Permissions-Policy` für Kamera und Mikrofon.

5. Deployen, eigene Domain verbinden, danach in der API
   `PUBLIC_APP_URL` und `CORS_ORIGINS` auf genau diese Domain setzen.

### Cloudflare Pages

1. **Workers & Pages → Create → Pages → Connect to Git**.
2. Build-Einstellungen:

   | Feld                   | Wert                                                  |
   | ---------------------- | ----------------------------------------------------- |
   | Framework preset       | None                                                  |
   | Build command          | `pnpm install && pnpm --filter @initiative/web build` |
   | Build output directory | `apps/web/dist`                                       |
   | Root directory         | _(leer – Repo-Wurzel)_                                |

3. **Environment variables**:

   ```
   VITE_API_URL=https://initiative-api.fly.dev
   NODE_VERSION=22
   ```

4. Deep Links sind bereits abgedeckt: `apps/web/public/_redirects` liegt im
   Repository und leitet alles außer `/assets`, `/icons`, `/sw.js` und dem
   Manifest auf `index.html` um. Sicherheits- und Cache-Header stehen in
   `apps/web/public/_headers`.

> Der Service Worker wird mit `registerType: 'prompt'` gebaut: Nach einem Deploy
> sehen Nutzer einen Hinweis „Neue Version verfügbar" und aktualisieren selbst.
> Nichts wird ihnen unter den Fingern weggetauscht.

---

## e) Web Push

### 1. Schlüsselpaar erzeugen

```bash
pnpm keys:vapid
```

Ausgabe:

```
VAPID_PUBLIC_KEY=BEl…
VAPID_PRIVATE_KEY=k9…
```

Das Paar gilt dauerhaft. Wird es getauscht, sind **alle** bestehenden
Abonnements ungültig und jedes Gerät muss Benachrichtigungen neu erlauben.

### 2. Setzen

Wieder als eine einzige Zeile, egal ob in PowerShell (Windows) oder Terminal
(macOS/Linux):

```bash
fly secrets set --app initiative-api VAPID_PUBLIC_KEY="BEl…" VAPID_PRIVATE_KEY="k9…" VAPID_SUBJECT="mailto:du@example.com"
```

Die PWA holt den öffentlichen Schlüssel zur Laufzeit über
`GET /api/v1/push/public-key` – ein Neubau des Frontends ist nicht nötig. Fehlt
einer der beiden Schlüssel, meldet der Endpunkt `enabled: false` und die
Oberfläche blendet den Schalter aus, statt einen Fehler zu zeigen.

### 3. Testen

In der App: **Profil → Einstellungen → Benachrichtigungen** einschalten, dann
im Terminal (unter Windows-PowerShell explizit `curl.exe`, sonst greift der
`curl`-Alias von PowerShell und die Optionen unten funktionieren nicht):

```bash
curl.exe -X POST https://initiative-api.fly.dev/api/v1/push/test -H "authorization: Bearer <access-token>"
# → { "delivered": 1 }
```

### iOS-Besonderheit

Auf iPhone und iPad gilt:

- Web Push funktioniert erst ab **iOS 16.4**.
- Die App muss **über Safari zum Home-Bildschirm hinzugefügt** sein. Im Browser
  selbst gibt es keine Push-API – Chrome und Firefox auf iOS ebenso wenig.
- Die Berechtigung darf nur nach einer echten Nutzeraktion angefragt werden;
  die App macht das über den Schalter in den Einstellungen.
- Die Seite muss über **https** ausgeliefert werden.

Ist die App noch nicht installiert, zeigt die Oberfläche statt des Schalters die
Anleitung „Zum Home-Bildschirm hinzufügen".

Android/Chrome braucht keine Installation, nur https und die erteilte
Berechtigung.

---

## f) Nach dem Deploy

### Healthcheck

Einfach `https://initiative-api.fly.dev/healthz` in einem Browser-Tab öffnen
– kein Terminal nötig. Alternativ im Terminal (unter Windows-PowerShell als
`curl.exe`, siehe oben):

```bash
curl.exe https://initiative-api.fly.dev/healthz
```

```json
{
  "status": "ok",
  "storage": "r2",
  "bus": "postgres",
  "push": true,
  "connections": 3
}
```

Kurz gelesen: `storage` sollte `r2` sein (nicht `local`), `bus` bei mehreren
Instanzen `postgres`, `push` `true`, sobald VAPID gesetzt ist. Bei
`"status": "degraded"` erreicht die API die Datenbank nicht – dann steht der
Grund im Feld `error` und in `fly logs`.

Ein Blick auf die Wurzel zeigt die geladenen Module – auch das reicht als
Adresse im Browser, oder im Terminal (Windows: `curl.exe`):

```bash
curl.exe https://initiative-api.fly.dev/
# { "name": "Initiative API", "version": 1, "runtime": "rust", "modules": [ … ] }
```

### Erstes Konto anlegen

Solange `REGISTRATION_MODE=open` gilt, einfach in der PWA registrieren.

### Registrierung schließen

Nachdem alle drin sind – sonst legt sich jeder ein Konto an, der die URL kennt:

```bash
fly secrets set --app initiative-api REGISTRATION_MODE=invite INVITE_CODES="wandergruppe-2026,familie-xy"
```

- `open` – jeder kann sich registrieren.
- `invite` – nur mit einem Code aus `INVITE_CODES` (Kommaliste, Groß-/Kleinschreibung zählt).
  Die PWA zeigt dann ein zusätzliches Feld „Einladungscode".
- `closed` – niemand mehr, auch nicht mit Code. Neue Konten legst du dann selbst
  in der Datenbank an oder schaltest kurz auf `invite` um.

Bestehende Sitzungen bleiben davon unberührt.

---

## g) Produktions-Checkliste

- [ ] **`JWT_SECRET`** ist zufällig und mindestens 32 Zeichen lang
      (macOS/Linux: `openssl rand -base64 48`; Windows-PowerShell: siehe
      Abschnitt c) Backend), liegt als Secret vor und nicht im Repository.
- [ ] **`NODE_ENV=production`** – erst dann ist `JWT_SECRET` erzwungen und die
      CORS-Ausnahme für lokale Netze abgeschaltet.
- [ ] **`CORS_ORIGINS`** enthält genau die PWA-Domain, kein `*`.
- [ ] **`PUBLIC_APP_URL`** und **`PUBLIC_API_URL`** zeigen auf die echten
      https-Adressen – daraus entstehen Medien-URLs, Push-Links und ICS-Einträge.
- [ ] **HTTPS überall.** Ohne https keine Kamera, kein Mikrofon, kein Service
      Worker, keine Installation, kein Push.
- [ ] **`DATABASE_URL`** nutzt `sslmode=require` und bei Neon/Supabase den Pooler.
- [ ] **Backups** eingerichtet: Neon/Supabase haben Point-in-Time-Recovery,
      beim eigenen Postgres ein `pg_dump`-Cronjob **und ein getesteter Restore**.
- [ ] **R2/S3-Bucket ist privat**, die CORS-Regel nennt nur die eigene Domain.
- [ ] **VAPID-Schlüssel** gesichert – gehen sie verloren, muss jedes Gerät
      Benachrichtigungen neu erlauben.
- [ ] **`REGISTRATION_MODE`** steht auf `invite` oder `closed`.
- [ ] **`REALTIME_BUS=postgres`**, sobald mehr als eine Instanz läuft.
- [ ] **Mindestens eine wache Instanz** (Fly: `min_machines_running = 1`),
      sonst brechen WebSockets weg, sobald die Maschine einschläft.
- [ ] **`/healthz`** wird überwacht (Fly-Check, UptimeRobot, Healthchecks.io).
- [ ] **Logs** sind erreichbar (`fly logs`, `docker compose logs -f api`).
- [ ] **`LOCAL_STORAGE_DIR`** liegt auf einem persistenten Volume – falls du
      wirklich bei `STORAGE_DRIVER=local` bleibst.

---

## Fehlersuche

| Symptom                                             | Ursache                           | Lösung                                                                          |
| --------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------- |
| PWA lädt, aber jede Anfrage schlägt fehl            | `VITE_API_URL` falsch oder fehlt  | Wert prüfen und **neu bauen** – er steckt im Bundle                             |
| `blocked by CORS policy` in der Konsole             | Origin nicht erlaubt              | PWA-URL in `CORS_ORIGINS` **ohne** Schrägstrich am Ende                         |
| Chats aktualisieren sich nicht von selbst           | WebSocket kommt nicht durch       | Proxy muss Upgrades durchlassen; bei Fly `min_machines_running = 1` setzen      |
| Nachrichten kommen nur auf einer Instanz an         | `REALTIME_BUS=memory`             | auf `postgres` stellen                                                          |
| Upload bricht mit CORS-Fehler ab                    | R2-CORS-Regel                     | `AllowedOrigins`, `AllowedMethods` `PUT`/`GET`, `AllowedHeaders` `content-type` |
| Bilder bleiben grau                                 | `PUBLIC_API_URL` falsch           | auf die echte API-URL setzen, Medien-URLs entstehen daraus                      |
| Kein Push auf dem iPhone                            | Nicht installiert oder iOS < 16.4 | über Safari zum Home-Bildschirm hinzufügen                                      |
| `push: false` im Healthcheck                        | VAPID unvollständig               | beide Schlüssel setzen und neu starten                                          |
| API startet nicht, Log nennt `Konfigurationsfehler` | Pflichtvariable fehlt             | Meldung lesen – sie nennt die Variable im Klartext                              |
| `status: degraded`                                  | Datenbank nicht erreichbar        | `DATABASE_URL`, TLS und IP-Freigabe prüfen                                      |

---

## Weiterlesen

- [ARCHITECTURE.md](ARCHITECTURE.md) – wie die Teile zusammenspielen
- [API.md](API.md) – alle Endpunkte und das Realtime-Protokoll
- [EXTENDING.md](EXTENDING.md) – eigene Module und Spiele
