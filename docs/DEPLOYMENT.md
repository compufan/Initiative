# Deployment

Initiative besteht aus zwei Teilen:

- **API** – eine einzelne Rust-Binary (Axum). Braucht Postgres, optional S3/R2 und
  VAPID-Schlüssel. Migrationen sind einkompiliert und laufen beim Start.
- **PWA** – statische Dateien (HTML, JS, CSS). Braucht nur einen Hoster, der
  alle Pfade auf `index.html` zurückfallen lässt.

**Der empfohlene Weg ist, beide gemeinsam auf einem Server zu betreiben:**
`docker compose up -d --build` startet Postgres, die API und die fertig gebaute
PWA hinter einem Caddy. Alles liegt unter einer Domain, deshalb gibt es weder
CORS- noch Cookie-Sonderfälle, die Dateien liegen im Volume daneben, und die
Rechnung ist die des Servers – unabhängig davon, wie viele Fotos hineingehen.

| Variante                                             | Wann                               | CORS                                                                  |
| ---------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------- |
| **Eine Domain** – `docker compose up -d --build`     | der Normalfall                     | kein CORS, `VITE_API_URL` bleibt leer                                 |
| **Getrennt** – PWA und API bei verschiedenen Hostern | wenn ein Teil schon woanders liegt | `CORS_ORIGINS` muss die PWA-URL enthalten, PWA braucht `VITE_API_URL` |

> **Wer bei Null anfängt, nimmt [UMZUG.md](UMZUG.md).** Dort steht der Weg vom
> leeren VPS bis zur laufenden App unter der eigenen Domain, Schritt für
> Schritt und vom Handy aus bedienbar: Härtung, Caddy mit Zertifikat,
> Sicherung, Veröffentlichen per Push. Diese Datei hier ist die Referenz
> daneben – alle Umgebungsvariablen, die Speicher-Varianten und was nach dem
> ersten Start zu prüfen ist.

Die Reihenfolge unten: erst Datenbank, dann Medien, dann Backend, dann
Frontend, dann Push.

---

## Alle Umgebungsvariablen

Gelesen in `apps/api/src/config.rs`. Was hier nicht steht, wird nicht gelesen.

### Betrieb

| Variable            | Standard      | Bedeutung                                                                                                                           |
| ------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`          | `development` | `development` \| `test` \| `production`. In `production` ist `JWT_SECRET` Pflicht und die CORS-Ausnahme für lokale Netze fällt weg. |
| `HOST`              | `0.0.0.0`     | Bind-Adresse. Im Container so lassen.                                                                                               |
| `PORT`              | `8080`        | Port der API.                                                                                                                       |
| `LOG_LEVEL`         | `info`        | `error` \| `warn` \| `info` \| `debug` \| `trace`. `RUST_LOG` überschreibt das.                                                     |
| `RUN_MIGRATIONS`    | `true`        | Migrationen beim Start anwenden. Nur `false` schaltet ab.                                                                           |
| `MIGRATIONS_REPAIR` | –             | Notfall-Schalter, siehe [Wenn Migrationen blockieren](#wenn-migrationen-blockieren). Gehört nicht in den Dauerbetrieb.              |
| `TRUST_PROXY`       | `false`       | Nur einschalten, wenn **wirklich** ein Proxy davorsteht. Siehe die Warnung unten.                                                   |
| `RATE_LIMIT`        | `true`        | Ob die Ratenbremse greift. Im Betrieb **nicht** abschalten – der einzige gute Grund sind die Browser-Tests.                         |
| `GIT_SHA`           | `unbekannt`   | Welcher Stand läuft. Wird auf sieben Zeichen gekürzt und im Profil unter „Über" angezeigt.                                          |

> **`TRUST_PROXY` ist keine Bequemlichkeitseinstellung.** Ist er an, liest die
> API die Absenderadresse aus `X-Forwarded-For` – und wer direkt an der API
> vorbei anfragt, kann dort hineinschreiben, was er will. Er umgeht damit
> nicht nur die Ratenbremse, er kann auch die Adresse eines anderen eintragen
> und den aussperren. Genommen wird der **letzte** Eintrag der Kette: Was
> Caddy selbst gesehen hat, hängt es hinten an; alles davor ist frei
> erfunden. Ohne Proxy davor bleibt der Schalter aus.

### Datenbank

| Variable                | Standard                      | Bedeutung                                                                                                                                        |
| ----------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`          | – (**Pflicht**)               | Postgres-Verbindung. TLS wird über die URL gesteuert: `?sslmode=require`.                                                                        |
| `REALTIME_DATABASE_URL` | aus `DATABASE_URL` abgeleitet | Verbindung für LISTEN/NOTIFY. Muss **direkt** sein, nicht über einen Pooler – siehe Warnung unten. Bei Neon wird `-pooler` automatisch entfernt. |
| `DATABASE_POOL_MAX`     | `10`                          | Maximale Verbindungen im Pool. Bei kleinen Hostern eher senken (5).                                                                              |

> Rust-API aber **nicht** ausgewertet – TLS kommt ausschließlich aus dem
> Connection String. Neon und Supabase liefern ihn bereits mit `sslmode=require`.

### Sicherheit und Konten

| Variable                 | Standard           | Bedeutung                                                                                                                                                    |
| ------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `JWT_SECRET`             | zufällig (nur Dev) | Signaturschlüssel der Access-Token (HS256). Mindestens 16 Zeichen, in `production` Pflicht. Ändern entwertet alle Sitzungen.                                 |
| `ACCESS_TOKEN_TTL`       | `900`              | Laufzeit des Access-Tokens in Sekunden. Laeuft er ab, erneuert die App ihn selbst – davon merkt man nichts.                                                  |
| `REFRESH_TOKEN_TTL_DAYS` | `60`               | **Hier stellt man die Sitzungsdauer ein.** So viele Tage bleibt man angemeldet: `365` fuer ein Jahr, `7` fuer eine Woche.                                    |
| `REGISTRATION_MODE`      | `open`             | `open` \| `invite` \| `closed`.                                                                                                                              |
| `INVITE_CODES`           | leer               | Kommaliste fest verdrahteter Codes, wirkt bei `REGISTRATION_MODE=invite`. Zusätzlich zu den Codes, die Admins in der App anlegen – gedacht als Notnagel.     |
| `ADMIN_PASSWORD`         | leer               | Schaltet den Admin-Modus frei (mind. 8 Zeichen). Ohne gesetztes Passwort ist die Verwaltung komplett aus. Gehört als Secret gesetzt, **nie** ins Repository. |

### Anmelden ohne Passwort (Face ID / Fingerabdruck)

Passkeys brauchen im Normalfall keine Konfiguration. Die API leitet die nötige
Kennung („Relying Party ID") aus `PUBLIC_APP_URL` ab – deshalb muss die Variable
exakt zur Adresse passen, unter der die App im Browser läuft. Stimmt sie nicht,
lehnt das Gerät ab.

| Variable         | Standard                      | Bedeutung                                                                          |
| ---------------- | ----------------------------- | ---------------------------------------------------------------------------------- |
| `WEBAUTHN_RP_ID` | Hostname aus `PUBLIC_APP_URL` | Der Name, an den Passkeys gebunden werden. Nackter Hostname, ohne Schema und Port. |

> **Diese Entscheidung fällt einmal und lässt sich später nicht korrigieren.**
> Ein Passkey gilt für genau den Namen, unter dem er angelegt wurde. Passkeys
> von der Hauptdomain gelten auch auf jeder Unterdomain – umgekehrt nicht. Wer
> also unter `app.beispiel.de` anfängt und `WEBAUTHN_RP_ID=beispiel.de`
> einträgt, kann später umziehen; wer es lässt, sitzt dort fest. Und wer
> testweise unter dem geliehenen Hostnamen des Anbieters startet, verliert
> beim Wechsel auf die eigene Domain jeden dort angelegten Schlüssel.

Einrichten in der App unter **Profil → Einstellungen → Ohne Passwort
anmelden**, und zwar je Gerät einmal. Der private Schlüssel entsteht im Gerät
(Secure Enclave beim iPhone, Keystore bei Android) und verlässt es nie; hier
liegt nur der öffentliche Teil.

Auf dem iPhone geht das nur in der **zum Home-Bildschirm hinzugefügten App**,
nicht im normalen Safari-Tab.

### URLs und CORS

| Variable         | Standard                | Bedeutung                                                                                                 |
| ---------------- | ----------------------- | --------------------------------------------------------------------------------------------------------- |
| `PUBLIC_APP_URL` | `http://localhost:5173` | Öffentliche URL der PWA. Landet in Push-Links und ICS-Einträgen und gilt immer als erlaubter CORS-Origin. |
| `PUBLIC_API_URL` | `http://localhost:8080` | Öffentliche URL der API. Bildet die Medien-URLs in jedem DTO.                                             |
| `CORS_ORIGINS`   | leer                    | Kommaliste zusätzlicher Origins. `*` erlaubt alle (dann ohne Credentials).                                |

### Speicher

| Variable               | Standard          | Bedeutung                                                                                                  |
| ---------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------- |
| `STORAGE_DRIVER`       | `local`           | `local` \| `r2` \| `s3`.                                                                                   |
| `LOCAL_STORAGE_DIR`    | `./.data/uploads` | Verzeichnis bei `local`. Muss ein persistentes Volume sein.                                                |
| `S3_BUCKET`            | –                 | Pflicht bei `r2`/`s3`.                                                                                     |
| `S3_ACCESS_KEY_ID`     | –                 | Pflicht bei `r2`/`s3`.                                                                                     |
| `S3_SECRET_ACCESS_KEY` | –                 | Pflicht bei `r2`/`s3`.                                                                                     |
| `S3_ENDPOINT`          | –                 | Bei `r2` Pflicht: `https://<account-id>.r2.cloudflarestorage.com`. Bei AWS S3 leer lassen.                 |
| `S3_REGION`            | `auto`            | Bei R2 `auto`, bei AWS z. B. `eu-central-1`.                                                               |
| `S3_FORCE_PATH_STYLE`  | `true`            | R2, MinIO: `true`. AWS S3: `false`.                                                                        |
| `S3_PUBLIC_BASE_URL`   | leer              | Öffentliche Bucket-Domain. Gesetzt → keine signierten Download-URLs mehr.                                  |
| `SIGNED_URL_TTL`       | `3600`            | Gültigkeit signierter URLs in Sekunden.                                                                    |
| `MEDIA_KEY`            | leer              | 32 Bytes base64. Gesetzt → alles Neue wird verschlüsselt abgelegt (`initiative-api --generate-media-key`). |
| `MEDIA_AUTH`           | `true`            | Medienrouten verlangen eine angemeldete Person (Medien-Keks). `false` gibt jede Datei heraus, deren Kennung man kennt. |

> **`MEDIA_KEY` verschlüsselt nur, was danach hochgeladen wird.** Der Tresor
> schiebt sich vor den eigentlichen Speicher; schon vorhandene Dateien bleiben,
> wie sie sind, und werden weiter unverschlüsselt gelesen. Geht der Schlüssel
> verloren, sind alle damit abgelegten Dateien verloren – er gehört in dieselbe
> Sicherung wie `JWT_SECRET`, und keinesfalls ins Repository.

### Realtime und Push

| Variable            | Standard                   | Bedeutung                                                                       |
| ------------------- | -------------------------- | ------------------------------------------------------------------------------- |
| `REALTIME_BUS`      | `postgres`                 | `postgres` (LISTEN/NOTIFY, mehrere Instanzen) \| `memory` (genau eine Instanz). |
| `VAPID_PUBLIC_KEY`  | leer                       | Web-Push-Schlüsselpaar. Fehlt eines von beiden, ist Push schlicht aus.          |
| `VAPID_PRIVATE_KEY` | leer                       | siehe oben.                                                                     |
| `VAPID_SUBJECT`     | `mailto:admin@example.com` | Kontakt für die Push-Dienste.                                                   |

### Impressum und Datenschutzerklärung

Beide Seiten werden vom Server gerendert und sind **ohne Anmeldung** unter
`/impressum` und `/datenschutz` erreichbar. Sie nennen nicht irgendeinen
Mustertext, sondern das, was diese Instanz tatsächlich tut: welcher Speicher
eingestellt ist, ob Dateien verschlüsselt liegen, ob Push an ist, wie lange
Sitzungen halten, ob sich jeder registrieren kann.

| Variable           | Standard | Bedeutung                                                                                       |
| ------------------ | -------- | ----------------------------------------------------------------------------------------------- |
| `OPERATOR_NAME`    | leer     | Wer betreibt das. **Pflicht**, sonst melden sich beide Seiten als unvollständig.                |
| `OPERATOR_EMAIL`   | leer     | Kontaktadresse. Ebenfalls Pflicht – die beiden gelten nur zusammen.                             |
| `OPERATOR_ADDRESS` | leer     | Ladungsfähige Anschrift. Für ein Impressum nach § 5 DDG gehört sie hin.                         |
| `OPERATOR_HOSTING` | leer     | Wo der Server steht, in einem Satz. Landet als Auftragsverarbeiter in der Datenschutzerklärung. |

`OPERATOR_NAME` und `OPERATOR_EMAIL` wirken nur **gemeinsam**: Fehlt eines von
beiden, gilt gar kein Betreiber als hinterlegt.

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

### Im Compose-Stapel (empfohlen)

Nichts zu tun: Die mitgelieferte `docker-compose.yml` startet Postgres 16 mit
einem benannten Volume, und die API bekommt ihre `DATABASE_URL` von dort. Beim
ersten Start legt sie alle Tabellen selbst an.

Zwei Dinge, die dabei leicht untergehen:

- **Das Volume ist die Datenbank.** `docker compose down -v` löscht sie. Ohne
  `-v` bleibt sie.
- **Ein Dump allein reicht nicht.** Bilder liegen nicht in der Datenbank – zu
  jeder Sicherung gehört das Upload-Verzeichnis dazu. `deploy/vps/backup.sh`
  nimmt beides.

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

### Gehostete Anbieter

Funktionieren, sind aber nicht mehr der Weg, den dieses Projekt geht – die
Abschnitte bleiben für den Fall, dass die Datenbank schon dort liegt.

#### Neon

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

> **Wichtig für Realtime:** Der Pooler (PgBouncer im Transaction-Mode)
> unterstützt **kein LISTEN/NOTIFY** – genau das benutzt aber
> `REALTIME_BUS=postgres`, damit neue Nachrichten sofort ankommen. Über die
> gepoolte Verbindung allein bliebe der Chat stumm: Nachrichten tauchen erst
> beim erneuten Öffnen auf, weil sie dann per REST nachgeladen werden.
> Die API leitet deshalb aus `DATABASE_URL` automatisch die direkte Verbindung
> ab (sie entfernt `-pooler` aus dem Hostnamen) und benutzt sie nur für den
> Listener. Bei anderen Anbietern – etwa Supabase mit Port `6543` – muss
> `REALTIME_DATABASE_URL` von Hand auf die **direkte** Verbindung gesetzt
> werden. Ob es klappt, zeigt `/healthz` im Feld `busConnected`.

#### Supabase

1. Projekt anlegen, **Project Settings → Database → Connection string → URI**.
2. Den **Transaction-Pooler** (Port `6543`) nehmen und `DATABASE_POOL_MAX=5` setzen.
3. `?sslmode=require` anhängen, falls nicht schon enthalten.

Die Auth- und Storage-Dienste von Supabase werden nicht benutzt – Initiative
bringt beides selbst mit.

---

## b) Medien

### Lokale Platte (empfohlen)

```bash
STORAGE_DRIVER=local
LOCAL_STORAGE_DIR=/data/uploads
```

Mehr braucht es nicht – das Compose-Verzeichnis bringt dafür ein Volume mit.
Jedes Byte fließt dann durch den API-Container; auf einem Server, der ohnehin
die App ausliefert, ist das kein Nachteil, sondern spart die Runde zu einem
fremden Dienst.

Drei Dinge, die dazugehören:

- **Das Verzeichnis muss ein persistentes Volume sein.** Liegt es im
  Container-Dateisystem, ist beim nächsten Deploy jedes Foto weg.
- **Es gehört in die Sicherung**, zusammen mit dem Datenbank-Dump und nicht
  getrennt davon.
- **`MEDIA_KEY` setzen, wenn die Dateien verschlüsselt liegen sollen** – siehe
  oben. Ohne Schlüssel liegen sie im Klartext auf der Platte.

Ob es wirklich trägt, sagt `GET /api/v1/admin/storage-check`: Der Endpunkt legt
eine Testdatei an, liest sie zurück und löscht sie wieder.

### Cloudflare R2

Mit R2 gehen Uploads und Downloads direkt vom Browser zum Speicher, an der API
vorbei. Sinnvoll, wenn die Bandbreite des Servers das Nadelöhr ist – und der
Preis dafür ist eine Abhängigkeit mehr und eine CORS-Regel, die stimmen muss.

#### 1. Bucket anlegen

Cloudflare Dashboard → **R2** → **Create bucket**, z. B. `initiative-media`.
Location automatisch. Der Bucket bleibt **privat**.

#### 2. API-Token erzeugen

**R2 → Manage R2 API Tokens → Create API token**

- Permissions: **Object Read & Write**
- Scope: nur dieser Bucket

Cloudflare zeigt danach einmalig:

| Feld im Dashboard                              | Umgebungsvariable      |
| ---------------------------------------------- | ---------------------- |
| Access Key ID                                  | `S3_ACCESS_KEY_ID`     |
| Secret Access Key                              | `S3_SECRET_ACCESS_KEY` |
| Account ID (oben rechts / in der R2-Übersicht) | Teil von `S3_ENDPOINT` |

#### 3. Variablen setzen

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

#### 4. CORS-Regel

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

> **Reihenfolge-Falle:** Diese Regel lässt sich erst richtig setzen, wenn die
> echte PWA-Domain feststeht – die kennt man aber erst nach dem ersten
> Vercel-Deploy. Steht hier noch ein Platzhalter, schlägt **jeder** Upload fehl
> (Foto, Sprachnachricht, Video, Sticker), und zwar mit einer nichtssagenden
> Meldung wie „Fetch fehlgeschlagen“: Der Browser lädt per `PUT` direkt in den
> Bucket, und ohne passende CORS-Regel bricht er ab, bevor überhaupt ein
> Statuscode zurückkommt. Also nach dem Frontend-Deploy hierher zurückkommen
> und `AllowedOrigins` auf die echte Domain setzen.

#### 5. Prüfen

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
# Leer lassen: unter einer Domain gibt es keine Cross-Origin-Anfragen.
CORS_ORIGINS=
WEB_PORT=8080
VITE_API_URL=
# Genau ein API-Prozess – dann ist der Bus im Speicher die robustere Wahl.
REALTIME_BUS=memory
# Ohne diese drei melden sich /impressum und /datenschutz als unvollständig.
OPERATOR_NAME=…
OPERATOR_EMAIL=…
OPERATOR_ADDRESS=…
# Mindestens 8 Zeichen, sonst bleibt die Verwaltung stumm aus.
ADMIN_PASSWORD=…
```

`VITE_API_URL` bleibt **leer** – PWA und API liegen hier unter einer Domain.
`CORS_ORIGINS` ebenso, und niemals `*`: Das schaltet `allow_credentials` ab.
`REALTIME_BUS` schreibt sich genau so; die Prüfung ist buchstabengetreu, und
`Memory` landet bei Postgres.

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

Backup nicht vergessen – und zwar **beides**:

```bash
docker compose exec -T postgres pg_dump -U initiative initiative | gzip > db-$(date +%F).sql.gz
docker run --rm -v initiative_uploads:/quelle -v "$PWD":/ziel alpine \
  tar czf /ziel/uploads-$(date +%F).tar.gz -C /quelle .
```

Ein Dump allein rettet die Texte und verliert die Fotos: Bilder liegen nicht in
der Datenbank. Der Volume-Name setzt sich aus dem Verzeichnisnamen und `uploads`
zusammen – `docker volume ls` nennt den, der hier gilt. `deploy/vps/backup.sh` nimmt beides und läuft dort stündlich per
systemd-Timer.

> **Für den Dauerbetrieb gehört nicht diese Compose-Datei auf den Server,
> sondern die aus `deploy/vps/`.** Sie baut nichts, sondern holt fertige
> Abbilder aus der Registry – ein Rust-Release-Build braucht mehrere Gigabyte
> Arbeitsspeicher und Minuten an Rechenzeit. Auf einer Maschine, auf der
> gleichzeitig Postgres und die laufende App liegen, ist das kein Bauvorgang,
> sondern ein Ausfall. Veröffentlicht wird dann mit `./deploy.sh <git-sha>`,
> zurückgerollt mit derselben Zeile und der Kennung von gestern.

### Gehostete Anbieter

Die Konfigurationsdateien dafür liegen weiterhin im Repository
(`apps/api/fly.toml`, `apps/api/koyeb.yaml`) – das Projekt selbst läuft aber
nicht mehr dort. Die Abschnitte bleiben für den Fall, dass jemand diesen Weg
geht oder von ihm herunter muss.

#### Fly.io

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
fly apps create initiative-api
```

Eine passende `fly.toml` liegt bereits im Repository unter `apps/api/fly.toml`
– `fly launch` ist hier **nicht** nötig, das würde nur eine zweite,
überflüssige Konfiguration anlegen. Die mitgelieferte Datei zeigt auf das
API-Dockerfile und kennt den internen Port:

```toml
app = "initiative-api"
primary_region = "fra"

[build]
  dockerfile = "Dockerfile"

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

> `dockerfile = "Dockerfile"` ist **relativ zum Ordner dieser `fly.toml`**
> gemeint (also `apps/api`) – das entscheidet flyctl anhand des Pfads der
> Config-Datei, unabhängig davon, aus welchem Verzeichnis `fly deploy`
> aufgerufen wird. Der **Build-Context** (das Verzeichnis, aus dem `COPY` in
> der Dockerfile liest) folgt dagegen einer eigenen, unabhängigen Regel:
> Standardmäßig das Verzeichnis, in dem der Befehl läuft – **außer**, `fly
deploy` bekommt ein Verzeichnis als erstes Argument übergeben, wie im
> nächsten Schritt. Deshalb unten unbedingt `fly deploy apps/api …` verwenden
> (nicht `fly deploy --config apps/api/fly.toml …` ohne das Verzeichnis) –
> sonst sucht `COPY` die Dateien im falschen Ordner und der Build bricht mit
> `"/migrations": not found` (oder `Cargo.toml`/`src`) ab.

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

Deploy **mit `apps/api` als erstem Argument**, von der Repo-Wurzel aus. Das
Argument setzt gleichzeitig den Build-Context **und** findet die dortige
`fly.toml` automatisch – kein `--config` nötig, und genau das vermeidet den
Ordner-Mismatch von oben:

```bash
fly deploy apps/api --app initiative-api
```

```bash
fly logs --app initiative-api
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

#### Koyeb (Docker-Deploy)

1. **Create Service → Docker** – oder **GitHub**, dann als Builder **Dockerfile**
   mit **Work directory** `apps/api` und Dockerfile-Pfad `Dockerfile` wählen
   (der Build-Context ist damit `apps/api`, nicht die Repo-Wurzel – die
   Dockerfile-`COPY`-Befehle erwarten genau das).
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

Alternativ das fertige Image bauen und schieben – als Build-Context
`apps/api` angeben (nicht die Repo-Wurzel), das `-f` kann dann entfallen, weil
`Dockerfile` dort direkt gefunden wird:

```bash
docker build -t ghcr.io/<user>/initiative-api:latest apps/api
docker push ghcr.io/<user>/initiative-api:latest
```

---

## d) Frontend

### Im Compose-Stapel (empfohlen)

Nichts Zusätzliches zu tun: `apps/web/Dockerfile` baut die PWA und legt sie in
ein Caddy-Abbild, das sie statisch ausliefert und `/api`, `/ws`, `/healthz`,
`/readyz`, `/datenschutz` und `/impressum` an die API weiterreicht. Dort stehen
auch die Sicherheits- und Cache-Kopfzeilen (`apps/web/Caddyfile`).

`VITE_API_URL` bleibt dabei **leer** – alle Anfragen sind relativ, und der
WebSocket folgt der Domain von allein.

> **Für TLS gehört ein zweiter Caddy davor**, der nie neu gebaut wird
> (`deploy/vps/Caddyfile`). Der naheliegende Weg – im Web-Abbild die Domain
> eintragen und 443 veröffentlichen – ist eine Falle: Der Container wird bei
> jeder Frontend-Änderung ersetzt und verliert dabei seinen ACME-Zustand.
> Let's Encrypt erlaubt fünf gleiche Zertifikate pro Woche; wer mehrmals
> täglich veröffentlicht, steht nach zwei Tagen ohne gültiges Zertifikat da,
> und zwar für eine Woche.

### Gehostete Anbieter

Auch hier gilt: funktioniert, ist aber nicht der Weg, den dieses Projekt geht.
Wer die PWA getrennt hostet, braucht `VITE_API_URL` beim Bauen und die PWA-URL
in `CORS_ORIGINS`.

#### Vercel

1. **Add New → Project**, Repository auswählen.
2. Einstellungen:

   | Feld               | Wert           |
   | ------------------ | -------------- |
   | Framework Preset   | Vite           |
   | **Root Directory** | `apps/web`     |
   | Install Command    | `pnpm install` |
   | **Build Command**  | `pnpm build`   |
   | Output Directory   | `dist`         |

   Die PWA importiert `packages/shared` als `workspace:*`. Einen Schalter
   dafür gibt es nicht mehr: Vercel erkennt den pnpm-Workspace selbst an der
   `pnpm-lock.yaml` in der Repo-Wurzel und installiert von dort, auch wenn das
   Root Directory auf `apps/web` steht. Die frühere Option „Include source
   files outside of the Root Directory" existiert nicht mehr und wird auch
   nicht gebraucht.

3. **Environment Variables** (für Production _und_ Preview):

   ```
   VITE_API_URL=https://initiative-api.fly.dev
   ```

4. Nichts weiter zu tun: `apps/web/vercel.json` liegt bereits im Repository und
   regelt Rewrites (Deep Links wie `/chats/<id>` landen nicht im 404), die
   Cache-Header und `Permissions-Policy` für Kamera und Mikrofon.

5. Deployen, eigene Domain verbinden, danach in der API
   `PUBLIC_APP_URL` und `CORS_ORIGINS` auf genau diese Domain setzen.

#### Cloudflare Pages

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
`"status": "degraded"` steht der Grund im Feld `error` – entweder ist die
Datenbank nicht erreichbar, oder der Start hat ein Problem gemeldet (etwa
blockierte Migrationen, siehe unten).

**`/healthz` und `/readyz` – der Unterschied ist wichtig.**

`/healthz` ist das **Lebenszeichen** und antwortet immer mit 200, solange der
Prozess überhaupt antworten kann. Genau diesen Endpunkt fragt ein Orchestrator
ab, und seine Antwort darauf entscheidet, ob der Container überhaupt Anfragen
zugestellt bekommt. Meldet er „ungesund“, nimmt der Vermittler ihn aus dem
Verkehr – Anfragen werden dann angenommen, niemand beantwortet sie, und der
Browser wartet **ohne Fehlermeldung**. Eine App mit blockierten Migrationen
liefert Chats aber tadellos aus. Sie deswegen unerreichbar zu machen,
verwandelt ein Teilproblem in einen Totalausfall. Diese Lektion stammt aus dem
Fly.io-Betrieb und hat dort einen ganzen Ausfall unsichtbar gemacht.

`/readyz` ist die **strenge** Fassung: 200 nur, wenn wirklich alles stimmt,
sonst 503 mit dem Grund. Daran hängen die Deploy-Abläufe – ein Deploy, nach dem
etwas fehlt, darf nicht grün sein. Als Container-Healthcheck gehört es
bewusst **nicht** eingetragen.

Zum Nachsehen also `/healthz` (sagt alles und ist immer erreichbar), zum
Prüfen in Skripten `/readyz`.

Ein Blick auf die Wurzel zeigt die geladenen Module – auch das reicht als
Adresse im Browser, oder im Terminal (Windows: `curl.exe`):

```bash
curl https://deine-domain.de/
# { "name": "Initiative API", "version": 1, "runtime": "rust", "modules": [ … ] }
```

### Wenn Migrationen blockieren

sqlx merkt sich zu jeder ausgeführten Migration eine Prüfsumme über den
Dateiinhalt. Passt sie später nicht mehr, verweigert sqlx **jede** Migration,
auch die neuen:

```
Error: VersionMismatch(1)
```

Das ist im Kern richtig: Eine Migration, die auf einer echten Datenbank lief,
ist Geschichte und kein Entwurf mehr. Neue Änderungen gehören in eine neue
Datei.

Zwei Ursachen kommen in Frage, und die zweite wird leicht übersehen:

1. Die Datei wurde nach dem Ausführen noch bearbeitet – und sei es ein
   Leerzeichen.
2. **Die Datenbank wurde ursprünglich von einem anderen Stand migriert.** Das
   passiert, wenn dieselbe Datenbank schon vor der jetzigen
   Repository-Geschichte in Benutzung war. Die Tabellen sind dann in Ordnung,
   nur der Vermerk stammt aus anderen Bytes.

Welcher Fall vorliegt, verrät ein Vergleich: Steht die vermerkte Prüfsumme in
keiner einzigen Fassung der Datei aus der Repository-Geschichte, ist es Fall 2.

Die API beendet sich deswegen **nicht**. Sie läuft weiter, bleibt erreichbar
und meldet über `/healthz` (mit 200, damit kein Orchestrator sie aus dem
Verkehr nimmt – `/readyz` antwortet währenddessen mit 503):

```json
{
  "status": "degraded",
  "error": "Migration 1 (0001_init.sql) wurde nach dem Ausführen verändert. …"
}
```

Das ist Absicht, und sie ist teuer erkauft. Beendet sich der Prozess, startet
die Umgebung ihn neu, wieder und wieder – bei Fly.io bis „machine has reached
its max restart count of 10“, unter Docker mit `restart: unless-stopped`
endlos. Von aussen sieht man davon nichts: Der Vermittler nimmt jede Anfrage
an, sucht einen Prozess, findet keinen und lässt den Browser ins Leere laufen.
Kein Fehlercode, keine Meldung, nur Warten. Eine App, die antwortet und sagt
was fehlt, ist in Minuten repariert; eine, die sich auflöst, kostet Stunden.

**Lösen – auf dem eigenen Server:**

```bash
cd /opt/initiative
echo 'MIGRATIONS_REPAIR=1' >> .env
docker compose up -d api            # Migrationen laufen durch
docker compose logs api | grep -i 'prüfsumme\|pruefsumme'
sed -i '/^MIGRATIONS_REPAIR=/d' .env
docker compose up -d api            # ohne den Schalter weiter
```

Der Schalter gehört **nicht** stehengelassen – sonst würde er künftige
Änderungen an bereits ausgeführten Migrationen stillschweigend durchwinken,
statt sie zu melden. Beide Compose-Dateien reichen die Variable ausdrücklich
durch; `environment:` ist eine Liste und keine Durchreiche, ein Eintrag in der
`.env` allein käme im Container nie an.

**Lösen bei einem Fly.io-Betrieb – ohne Rechner, vom Handy aus:**

GitHub-App oder github.com im Browser → Repository → **Actions** →
**API-Wartung** → **Run workflow** → Aufgabe **`migration-reparieren`** →
starten. Der Ablauf setzt `MIGRATIONS_REPAIR=1`, wartet, bis die Migrationen
durch sind, und entfernt den Schalter wieder.

Was genau angeglichen wurde, steht anschliessend im Protokoll (Aufgabe
`protokoll`, dort nach „Prüfsumme“ suchen).

> `wartung.yml` spricht ausschließlich mit Fly.io. Wer auf dem eigenen Server
> betreibt, nimmt den Weg darüber.

> Der Schalter gleicht nur die Prüfsumme an. Er kann nicht wissen, ob die Datei
> um _neues_ SQL gewachsen ist – das käme dann nie in der Datenbank an. Wenn
> die Änderung mehr war als Formatierung: Den fraglichen Teil zusätzlich als
> neue Migrationsdatei anlegen.

### Erstes Konto anlegen

Solange `REGISTRATION_MODE=open` gilt, einfach in der PWA registrieren.

### Registrierung schließen

Nachdem alle drin sind – sonst legt sich jeder ein Konto an, der die URL kennt:

```bash
fly secrets set --app initiative-api REGISTRATION_MODE=invite INVITE_CODES="wandergruppe-2026,familie-xy"
```

Ab dann laufen Einladungen am bequemsten über den **Admin-Modus** in der App:

```bash
fly secrets set --app initiative-api ADMIN_PASSWORD="dein-admin-passwort"
```

Danach in der App unter **Profil → Einstellungen → Verwaltung** mit diesem
Passwort freischalten. Dort lassen sich Einladungscodes erzeugen (mit Limit und
Ablaufdatum), wieder zurückziehen und Mitglieder entfernen. Der Admin-Status
hängt an der Datenbank, nicht am Browser – ein manipuliertes Frontend bekommt
dadurch keine Rechte. `INVITE_CODES` bleibt als Notnagel bestehen, falls
niemand mehr hineinkommt.

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
- [ ] **`CORS_ORIGINS`** ist leer (eine Domain) oder nennt genau die PWA-Domain.
      Niemals `*` – das schaltet `allow_credentials` ab.
- [ ] **`PUBLIC_APP_URL`** und **`PUBLIC_API_URL`** zeigen auf die echten
      https-Adressen – daraus entstehen Medien-URLs, Push-Links und ICS-Einträge.
- [ ] **HTTPS überall.** Ohne https keine Kamera, kein Mikrofon, kein Service
      Worker, keine Installation, kein Push.
- [ ] **Die Domain steht fest, bevor sich jemand einen Passkey anlegt.** Ein
      Wechsel danach entwertet jeden – siehe `WEBAUTHN_RP_ID`.
- [ ] **`LOCAL_STORAGE_DIR`** liegt auf einem persistenten Volume; mit
      `STORAGE_DRIVER=s3`/`r2` ist der Bucket **privat** und die CORS-Regel
      nennt nur die eigene Domain.
- [ ] **Backups laufen und wurden einmal zurückgespielt.** Datenbank **und**
      Upload-Verzeichnis, in derselben Sicherung – ein Dump allein verliert
      jedes Foto. `deploy/vps/backup.sh` nimmt beides.
- [ ] **`MEDIA_KEY` und `JWT_SECRET` liegen in der Sicherung**, aber nicht im
      Repository. Ohne `MEDIA_KEY` ist jede damit abgelegte Datei verloren,
      ohne `JWT_SECRET` sind alle abgemeldet.
- [ ] **VAPID-Schlüssel** gesichert – gehen sie verloren, muss jedes Gerät
      Benachrichtigungen neu erlauben.
- [ ] **`REGISTRATION_MODE`** steht auf `invite` oder `closed`.
- [ ] **`ADMIN_PASSWORD`** hat mindestens 8 Zeichen – darunter wird es
      stillschweigend verworfen und die Verwaltung bleibt aus.
- [ ] **`OPERATOR_NAME`, `OPERATOR_EMAIL`, `OPERATOR_ADDRESS`** sind gesetzt,
      und `/impressum` und `/datenschutz` melden sich nicht als unvollständig.
- [ ] **`RATE_LIMIT`** ist **nicht** abgeschaltet.
- [ ] **`TRUST_PROXY`** nur an, wenn wirklich ein Proxy davorsteht.
- [ ] **`REALTIME_BUS`** steht auf `memory` bei genau einer Instanz, auf
      `postgres`, sobald es mehr sind.
- [ ] **`/healthz`** wird überwacht (UptimeRobot, Healthchecks.io).
- [ ] **Logs** sind erreichbar (`docker compose logs -f api`).
- [ ] **`GET /api/v1/admin/storage-check`** ist einmal grün durchgelaufen.

---

## Fehlersuche

| Symptom                                                                     | Ursache                                                                                             | Lösung                                                                                                                                                                                          |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PWA lädt, aber jede Anfrage schlägt fehl                                    | `VITE_API_URL` falsch oder fehlt                                                                    | Wert prüfen und **neu bauen** – er steckt im Bundle                                                                                                                                             |
| `blocked by CORS policy` in der Konsole                                     | Origin nicht erlaubt                                                                                | PWA-URL in `CORS_ORIGINS` **ohne** Schrägstrich am Ende                                                                                                                                         |
| Chats aktualisieren sich nicht von selbst                                   | WebSocket kommt nicht durch                                                                         | Der Proxy davor muss Upgrades durchlassen – Caddy tut das ohne Zutun                                                                                                                            |
| Neue Nachrichten erst nach erneutem Öffnen des Chats                        | `busConnected: false` in `/healthz` – der LISTEN-Kanal steht nicht, weil er über einen Pooler läuft | `REALTIME_DATABASE_URL` auf die **direkte** (nicht gepoolte) Verbindung setzen; bei Neon geschieht das automatisch                                                                              |
| Nachrichten kommen nur auf einer Instanz an                                 | `REALTIME_BUS=memory`                                                                               | auf `postgres` stellen                                                                                                                                                                          |
| Gelöschte Dateien liegen weiter im Speicher                                 | Die Müllabfuhr läuft nicht                                                                          | `select count(*) from storage_muell` – bleibt die Zahl stehen, sagt das API-Log warum                                                                                                           |
| Upload bricht mit CORS-Fehler ab                                            | R2-CORS-Regel                                                                                       | `AllowedOrigins`, `AllowedMethods` `PUT`/`GET`, `AllowedHeaders` `content-type`                                                                                                                 |
| Bilder bleiben grau                                                         | `PUBLIC_API_URL` falsch                                                                             | auf die echte API-URL setzen, Medien-URLs entstehen daraus                                                                                                                                      |
| Kein Push auf dem iPhone                                                    | Nicht installiert oder iOS < 16.4                                                                   | über Safari zum Home-Bildschirm hinzufügen                                                                                                                                                      |
| `push: false` im Healthcheck                                                | VAPID unvollständig                                                                                 | beide Schlüssel setzen und neu starten                                                                                                                                                          |
| API startet nicht, Log nennt `Konfigurationsfehler`                         | Pflichtvariable fehlt                                                                               | Meldung lesen – sie nennt die Variable im Klartext                                                                                                                                              |
| `status: degraded`                                                          | Datenbank nicht erreichbar                                                                          | `DATABASE_URL`, TLS und IP-Freigabe prüfen                                                                                                                                                      |
| `status: degraded`, `error` nennt eine Migration                            | Eine bereits ausgeführte Migrationsdatei wurde nachträglich verändert                               | `MIGRATIONS_REPAIR=1` für genau einen Neustart (siehe [Wenn Migrationen blockieren](#wenn-migrationen-blockieren))                                                                              |
| URL lädt ewig, Log zeigt `VersionMismatch(n)` und `max restart count of 10` | Derselbe Fall, nur mit einer älteren API-Version, die sich dabei noch beendet hat                   | Neu deployen (die Version danach läuft weiter statt abzustürzen), dann `MIGRATIONS_REPAIR=1`                                                                                                    |
| URL lädt ewig, Log zeigt nur `Main child exited normally with code: 0`      | Die Binary im Image ist die leere Platzhalter-Version aus der Cache-Stufe des Dockerfiles           | Im `apps/api/Dockerfile` muss vor dem zweiten `cargo build` ein `find src migrations -type f -exec touch {} +` stehen – sonst hält Cargo den echten Code für unverändert (siehe Kommentar dort) |

---

## Weiterlesen

- [ARCHITECTURE.md](ARCHITECTURE.md) – wie die Teile zusammenspielen
- [API.md](API.md) – alle Endpunkte und das Realtime-Protokoll
- [EXTENDING.md](EXTENDING.md) – eigene Module und Spiele
- [UMZUG.md](UMZUG.md) – vom leeren VPS bis zur laufenden App, Schritt für Schritt
- [SICHERHEIT.md](SICHERHEIT.md) – wogegen der Betrieb schützt und wogegen nicht
