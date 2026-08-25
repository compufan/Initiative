# Umzug auf den eigenen Server

Von Fly.io (API), Vercel (PWA), Neon (Datenbank) und Cloudflare R2 (Dateien) auf
einen netcup VPS 1000 G12 – 4 Kerne, 8 GB, 256 GB NVMe.

Alles hier ist so geschrieben, dass es **vom Handy aus** geht: Der Server wird
über eine SSH-App bedient (Termius, JuiceSSH, Blink), gebaut wird weiterhin bei
GitHub, und veröffentlicht wird durch einen Push wie bisher.

> **Bei jedem Befehl steht, wo er hingehört.** „Auf dem Server" heisst: in der
> SSH-Verbindung zum VPS. „Bei dir" heisst: irgendwo mit Internetzugang, auch
> das Handy. Nichts davon braucht einen PC.

---

## Was der Umzug bringt – und was er kostet

**Es entfallen drei Auftragsverarbeiter mit US-Bezug** (Neon, Cloudflare,
Vercel) und einer ohne (Fly.io). Übrig bleibt **einer**: netcup selbst, denn
„eigener Server" heisst nicht „kein Auftragsverarbeiter" – netcup betreibt die
Hardware und hat physischen Zugriff. Den Vertrag gibt es im Kundenkonto unter
den Stammdaten zum Anklicken. Kommt eine Backup-Ablage bei Hetzner dazu, sind es
zwei – beide in der EU, beide ohne Drittlandübermittlung.

**Was trotzdem bleibt:** Push-Benachrichtigungen laufen über die Push-Dienste
von Google und Apple. Der _Inhalt_ ist für sie nicht lesbar (eigene
VAPID-Schlüssel, Verschlüsselung nach RFC 8291), aber die Zustellung erzeugt
Metadaten in den USA. Einen Vertrag gibt es dafür weder, noch ist einer nötig –
den Dienst hat der Browser des Nutzers gewählt, nicht du. Nennen muss man es
trotzdem.

**Was es kostet:** rund 10 € im Monat für den Server, dazu etwa 4 € für eine
Backup-Ablage ausser Haus. Heute läuft alles in kostenlosen Kontingenten. Es ist
kein Sparprogramm, sondern ein Tausch: Geld und Zeit gegen Kontrolle.

**Was du verlierst:**

| Weg                                 | Wie schlimm                                                                                                                                          |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Verwaltete Datenbank-Backups        | Neon kostenlos gibt sechs Stunden Historie. Stündliche Dumps sind **besser** – höchstens eine Stunde Verlust.                                        |
| Globales CDN                        | Fast egal. Deine Leute sind in DE/AT; ein Server in Nürnberg ist für sie schneller als ein Vercel-Knoten mit Kaltstart.                              |
| Automatische Skalierung             | Irrelevant bei zehn bis fünfzig Leuten – und sie war hier nachweislich ein Problem, kein Vorteil (gestoppte Maschinen, grüne Deploys bei toter App). |
| Deploy ohne Ausfall                 | 10–20 Sekunden pro Veröffentlichung, dazu brechen die offenen Verbindungen ab. Abends veröffentlichen, fertig.                                       |
| DDoS-Schutz auf Anwendungsebene     | Kleiner Verlust. Cloudflare wieder davorzuschalten würde den ganzen Datenschutzgewinn zunichtemachen – man kann nicht beides haben.                  |
| Vorschau-Adressen je Branch         | Spürbar, wenn du im echten Browser gegenlesen willst. Ersatz wäre ein zweiter Stapel auf `test.deine-domain`.                                        |
| **Jemand anderes hat Bereitschaft** | Der eigentliche Preis. Ein Ausfall fällt niemandem ausser dir auf – deshalb ist Schritt 8 keine Kür.                                                 |

---

## Vorher: die eine Frage, die den Zeitplan bestimmt

**Bleibt die Domain gleich?**

Wenn ja, ist der Umzug ein DNS-Wechsel und sonst nichts. Wenn nein, dann:

- **Alle Passkeys werden unbrauchbar.** Sie hängen fest am Hostnamen
  (`apps/api/src/modules/passkeys.rs`). Wer sich _nur_ per Passkey anmeldet,
  kommt nicht mehr hinein. Vorher sicherstellen, dass jeder ein Passwort hat.
- **Alle sind abgemeldet.** Die Anmeldedaten liegen im `localStorage` und der
  gehört zur Domain.
- **Alle Push-Abos sind tot.** Jeder muss Benachrichtigungen neu erlauben.
- **Die installierte App muss neu installiert werden.**

Bleibt die Domain, passiert von alledem nichts – vorausgesetzt, `JWT_SECRET` und
die beiden `VAPID_*`-Schlüssel werden **übernommen und nicht neu erzeugt**.

---

## 1. Server einrichten

Bei dir, in der SSH-App, als `root` auf dem frischen Server:

```bash
# Erst der Schlüssel, dann das Passwort abschalten – nie umgekehrt.
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo "ssh-ed25519 AAAA... dein-schluessel" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

**Jetzt in einer zweiten SSH-Verbindung testen, dass der Schlüssel wirklich
greift.** Erst danach weiter – sonst sperrst du dich aus. (Notausgang: die
VNC-Konsole im netcup-Kundenkonto.)

```bash
cat >/etc/ssh/sshd_config.d/99-eigen.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
systemctl restart ssh

# Firewall: eingehend nur SSH, HTTP, HTTPS – auch über IPv6.
sed -i 's/^IPV6=.*/IPV6=yes/' /etc/default/ufw
ufw default deny incoming && ufw default allow outgoing
ufw allow 22,80,443/tcp && ufw --force enable

# Sicherheitsaktualisierungen von selbst, samt nächtlichem Neustart.
apt update && apt install -y unattended-upgrades fail2ban docker.io docker-compose-plugin restic
cat >/etc/apt/apt.conf.d/51-neustart <<'EOF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:30";
EOF
systemctl enable --now docker fail2ban

# Ein eigener Benutzer für das Veröffentlichen.
adduser --disabled-password --gecos "" initiative
usermod -aG docker initiative
install -d -o initiative -g initiative /opt/initiative /var/backups/initiative
```

> **Warum die Datenbank keinen `ports:`-Eintrag hat und nie einen bekommt:**
> Docker schreibt eigene Firewall-Regeln und **umgeht ufw**. Ein
> `ports: "5432:5432"` wäre aus dem Internet erreichbar, obwohl die Firewall es
> scheinbar sperrt. Wer von aussen an die Datenbank will, tunnelt:
> `ssh -L 5432:localhost:5432` und dann `docker compose exec postgres psql`.

> **fail2ban, ehrlich eingeordnet:** Bei abgeschalteter Passwortanmeldung ist
> der Sicherheitsgewinn gering – gegen einen fehlenden Schlüssel hilft kein
> Bannen. Der reale Nutzen ist Ruhe im Protokoll. Fünf Minuten, also mitnehmen,
> aber nicht damit verwechseln, sicher zu sein.

---

## 2. Dateien auf den Server legen

Auf dem Server, als `initiative`:

```bash
cd /opt/initiative
curl -fsSLO https://raw.githubusercontent.com/compufan/Initiative/main/deploy/vps/docker-compose.yml
curl -fsSLO https://raw.githubusercontent.com/compufan/Initiative/main/deploy/vps/Caddyfile
curl -fsSLO https://raw.githubusercontent.com/compufan/Initiative/main/deploy/vps/deploy.sh
curl -fsSLO https://raw.githubusercontent.com/compufan/Initiative/main/deploy/vps/backup.sh
curl -fsSL  https://raw.githubusercontent.com/compufan/Initiative/main/deploy/vps/.env.beispiel -o .env
chmod +x deploy.sh backup.sh
chmod 600 .env
```

Dann `.env` ausfüllen. **Die Geheimnisse aus den alten Umgebungen holen, nicht
neu erzeugen** – bei dir, in der GitHub-App oder im Fly-Kundenkonto:

```bash
# Bei dir, falls flyctl greifbar ist:
flyctl secrets list --app initiative-api          # zeigt nur die Namen
# Die Werte stehen dort, wo du sie damals hinterlegt hast.
```

Gebraucht werden: `JWT_SECRET`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`.

---

## 3. Bei GitHub hinterlegen

Bei dir, in der GitHub-App oder im Browser, unter
**Repository → Settings → Secrets and variables → Actions**:

| Name          | Wert                                                           |
| ------------- | -------------------------------------------------------------- |
| `VPS_HOST`    | die IP oder der Hostname des Servers                           |
| `VPS_USER`    | `initiative`                                                   |
| `VPS_SSH_KEY` | der **private** Schlüssel eines eigens dafür angelegten Paares |
| `VPS_APP_URL` | `https://deine-domain`                                         |

Solange diese fehlen, überspringt sich `deploy-vps.yml` stillschweigend – der
alte Fly-Weg läuft ungestört weiter. So können beide nebeneinander stehen, bis
der Umzug wirklich durch ist.

> **Ehrlich dazu:** Wer in dein GitHub-Konto kommt, kommt auf den Server. Ein
> eigener Schlüssel nur für diesen Zweck, in `authorized_keys` mit
> `command="/opt/initiative/deploy.sh",restrict` eingeschränkt, begrenzt den
> Schaden.

Die beiden Pakete müssen für den Server erreichbar sein. Am einfachsten:
**Package-Sichtbarkeit auf `public` stellen** (GitHub → dein Profil → Packages).
Die Abbilder enthalten keine Geheimnisse – alle Werte kommen zur Laufzeit aus
`.env`. Sonst braucht der Server einen Token mit `read:packages`.

---

## 4. Ein erster Durchlauf auf einer Testadresse

Bevor irgendetwas umgezogen wird: einen DNS-Eintrag `neu.deine-domain` auf die
Server-IP legen, in `.env` als `DOMAIN` eintragen, und veröffentlichen.

Bei dir, in der GitHub-App: **Actions → Deploy VPS → Run workflow.**

Dann auf dem Server nachsehen:

```bash
cd /opt/initiative && docker compose ps
curl -s https://neu.deine-domain/healthz | head -c 400
```

Damit hast du geprüft, dass Abbilder, Zertifikat, Proxy und Migrationen
funktionieren – **ohne** dass jemand davon etwas merkt.

---

## 5. Die Daten holen

### Datenbank

Auf dem Server. Die Verbindungszeichenfolge von Neon **ohne** `-pooler` im
Hostnamen verwenden – über den Pooler ist ein Dump unzuverlässig:

```bash
# 1. Wartungsfenster: die alte App stilllegen, damit nichts dazwischenkommt.
#    Bei dir: flyctl scale count 0 --app initiative-api

# 2. Dump ziehen (auf dem Server, Ausgabe bleibt dort).
docker run --rm -v /opt/initiative:/w -w /w postgres:16-alpine \
  pg_dump -Fc --no-owner --no-privileges \
  "postgres://USER:PW@ep-xxx.eu-central-1.aws.neon.tech/initiative?sslmode=require" \
  -f neon.dump

# 3. Zielsystem hochfahren und einspielen.
docker compose up -d postgres
docker compose exec -T postgres psql -U initiative -d initiative \
  -c 'drop schema if exists public cascade; create schema public;'
docker compose exec -T postgres pg_restore -U initiative -d initiative \
  --no-owner --no-privileges </opt/initiative/neon.dump
```

Es wird **keine einzige Erweiterung** gebraucht – kein `pgcrypto`, kein
`uuid-ossp`, kein `pg_trgm`. Alle Schlüssel erzeugt die Anwendung selbst.

Gegenprüfen, bevor du weitermachst:

```bash
docker compose exec -T postgres psql -U initiative -d initiative -c "
  select relname, n_live_tup from pg_stat_user_tables order by relname;"
```

Dieselbe Abfrage gegen Neon laufen lassen und die Zahlen vergleichen.

### Dateien

Die Schlüssel im Bucket sind bereits Pfade in der Form
`{art}/{jahr}/{monat}/{benutzer}/{zeitstempel}-{zufall}.{endung}` – ein
1:1-Spiegeln genügt, es muss nichts umbenannt werden.

```bash
# Auf dem Server. rclone einmal einrichten (Typ: s3, Anbieter: Cloudflare).
rclone config
rclone copy r2:dein-bucket /var/lib/docker/volumes/initiative_uploads/_data \
  --transfers 8 --progress
```

Und prüfen, dass wirklich alles da ist – die Datenbank kennt das vollständige
Inventar:

```bash
docker compose exec -T postgres psql -U initiative -d initiative -tAc \
  "select storage_key from attachments order by 1" | sort > /tmp/soll.txt
cd /var/lib/docker/volumes/initiative_uploads/_data && find . -type f \
  | sed 's|^\./||' | sort > /tmp/ist.txt
comm -23 /tmp/soll.txt /tmp/ist.txt   # fehlt auf der Platte -> muss leer sein
comm -13 /tmp/soll.txt /tmp/ist.txt   # liegt herum, kennt niemand -> egal
```

---

## 6. Umschalten

1. DNS der echten Domain auf die Server-IP zeigen lassen, TTL vorher auf
   60 Sekunden senken.
2. In `.env` `DOMAIN`, `PUBLIC_APP_URL` und `PUBLIC_API_URL` auf die echte
   Domain setzen, dann `./deploy.sh live`.
3. Caddy holt das Zertifikat wenige Sekunden nach dem DNS-Wechsel.

> **Die alte Fly-API muss noch ein paar Tage weiterlaufen.** Auf jedem
> installierten Gerät liegt die alte App im Zwischenspeicher des Service
> Workers, und die spricht weiter mit `initiative-api.fly.dev`. Erst wenn
> jemand das Update-Banner antippt, wechselt er auf die neue Fassung. Die App
> fragt alle 30 Minuten und bei jedem Zurückholen in den Vordergrund nach –
> ein bis zwei Tage reichen also. Bis dahin darf die alte API nicht abgeschaltet
> werden, sonst sehen Leute eine Oberfläche, die keine Daten mehr bekommt.

---

## 7. Backup einrichten

Auf dem Server, als `root`:

```bash
cat >/etc/systemd/system/initiative-backup.service <<'EOF'
[Service]
Type=oneshot
User=initiative
ExecStart=/opt/initiative/backup.sh
EOF
cat >/etc/systemd/system/initiative-backup.timer <<'EOF'
[Timer]
OnCalendar=hourly
Persistent=true
[Install]
WantedBy=timers.target
EOF
systemctl enable --now initiative-backup.timer
```

Stündliche Dumps heissen: höchstens eine Stunde Verlust. Einmal täglich geht
zusätzlich eine verschlüsselte Kopie ausser Haus (`backup.sh --auswaerts`), zum
Beispiel auf eine Hetzner Storage Box – ein **zweiter** Anbieter ist hier ein
Vorteil, kein Nachteil.

> **Eine Wiederherstellung, die nie geübt wurde, ist kein Backup.** Einmal im
> Monat: letzten Dump in eine Wegwerf-Datenbank einspielen, Zeilen zählen,
> verwerfen. Fünf Minuten.

---

## 8. Merken, wenn etwas nicht läuft

Ohne Ersatz erfährst du von einem Ausfall dadurch, dass ein Freund schreibt.

Das Billigste, das wirklich hilft: ein Konto bei einem Aufpass-Dienst
(healthchecks.io oder Uptime Kuma auf demselben Server), der
`https://deine-domain/healthz` im Minutentakt abfragt und eine Nachricht
schickt, wenn keine Antwort kommt.

**Ebenso wichtig: die Platte.** 256 GB müssen Datenbank, Uploads, Abbilder und
lokale Backups tragen. Fotos in einer Freundesgruppe sind die realistischste
Ursache für ein volles Dateisystem, und ein volles `/var` legt Postgres lahm.

```bash
# Auf dem Server, als root – meldet sich, wenn es eng wird.
cat >/etc/cron.daily/platte <<'EOF'
#!/bin/sh
voll=$(df --output=pcent / | tail -1 | tr -dc '0-9')
[ "$voll" -gt 85 ] && curl -fsS -m 10 "$HEALTHCHECK_ALARM_URL" >/dev/null
EOF
chmod +x /etc/cron.daily/platte
```

---

## 9. Danach aufräumen

- `deploy.yml` (Fly) und die Fly-App abschalten, sobald niemand mehr die alte
  Fassung benutzt.
- `wartung.yml` auf SSH umschreiben. **Dabei nicht die Protokolle in die
  GitHub-Zusammenfassung schreiben** – dort landen sonst Produktionsprotokolle
  mit möglichem Personenbezug in einem US-System, und du hättest vier
  US-Anbieter durch einen ersetzt und den unmittelbarsten Datenabfluss behalten.
- Vercel-Projekt und Neon-Datenbank löschen, R2-Bucket leeren.
- **Auftragsverarbeitungsvertrag mit netcup** im Kundenkonto unter den
  Stammdaten abschliessen. Und, falls Hetzner als Backup-Ablage dazukommt, dort
  ebenfalls.
- Die Datenschutzerklärung anpassen: die drei US-Anbieter streichen, netcup
  (und ggf. Hetzner) eintragen, den Absatz zu Push-Benachrichtigungen behalten.
- DNS-Zone bei einem europäischen Anbieter führen – netcup betreibt selbst DNS.

---

## Zum Nachschlagen: was wohin gehört

| Wert             | Wo                    | Warum                                                                                                 |
| ---------------- | --------------------- | ----------------------------------------------------------------------------------------------------- |
| `JWT_SECRET`     | `.env` auf dem Server | Ein neuer Wert meldet **jeden** ab.                                                                   |
| `VAPID_*`        | `.env` auf dem Server | Neue Schlüssel machen **jedes** Push-Abo ungültig.                                                    |
| `PUBLIC_API_URL` | `.env` auf dem Server | Baut jede Medienadresse. Ein Tippfehler macht alle Bilder unsichtbar, ohne dass sonst etwas auffällt. |
| `CORS_ORIGINS`   | leer lassen           | Bei einer Domain gibt es keine Cross-Origin-Anfragen. Niemals `*` – das schaltet die Anmeldedaten ab. |
| `REALTIME_BUS`   | `memory`              | Bei einem Prozess robuster. Genaue Schreibweise: `Memory` landet bei Postgres.                        |
| `STORAGE_DRIVER` | `local`               | Und damit gehört das Upload-Verzeichnis ins Backup – Bilder liegen **nicht** in der Datenbank.        |
| `VITE_API_URL`   | leer lassen           | Alle Anfragen relativ, der WebSocket folgt der Domain von allein.                                     |
