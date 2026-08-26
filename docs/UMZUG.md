# Initiative auf dem eigenen Server installieren

Schritt für Schritt, von einem frischen netcup VPS 1000 G12 (4 Kerne, 8 GB,
256 GB NVMe) bis zur laufenden App unter der eigenen Domain.

**Alles hier geht vom Handy aus.** Der Server wird über eine SSH-App bedient
(Termux, Termius, JuiceSSH, Blink), gebaut wird bei GitHub, veröffentlicht wird
durch einen Push. Es kommt kein PC vor.

> **Bei jedem Befehl steht, wo er hingehört.**
>
> - **`[SERVER]`** – in der SSH-Verbindung zum VPS.
> - **`[BEI DIR]`** – auf deinem Gerät: Termux auf Android, Terminal auf dem
>   Mac, PowerShell unter Windows.
> - **`[BROWSER]`** – im netcup-Kundenkonto oder bei GitHub, geht auch mobil.

**Zeitbedarf:** etwa zwei Stunden konzentriert, verteilbar auf mehrere Abende.
Nach Teil C läuft die App bereits – alles danach ist der Umzug der Daten.

---

## Inhalt

| Teil                                                | Was passiert                                  |
| --------------------------------------------------- | --------------------------------------------- |
| [A – Vorbereitung](#teil-a--vorbereitung-bei-dir)   | Schlüssel und Domain, bevor der Server läuft  |
| [B – Server einrichten](#teil-b--server-einrichten) | Benutzer, Docker, Härtung                     |
| [C – App starten](#teil-c--die-app-starten)         | erster Durchlauf, noch ohne echte Daten       |
| [D – Daten holen](#teil-d--die-daten-holen)         | Datenbank und Dateien von den alten Anbietern |
| [E – Umschalten](#teil-e--umschalten)               | die echte Domain zeigt auf den Server         |
| [F – Betrieb](#teil-f--betrieb)                     | Sicherung, Überwachung, Veröffentlichen       |
| [G – Aufräumen](#teil-g--aufräumen)                 | alte Anbieter abschalten, Verträge, Erklärung |

---

# Teil A – Vorbereitung bei dir

Diese fünf Dinge müssen fertig sein, **bevor** du den Server anfasst. Nichts
davon ist nachholbar, ohne noch einmal anzufangen.

## A1. Die Domain

**Nein, dein Server hat keine eigene Domain.**

Was netcup mitliefert, ist ein Hostname der Form
`v2202xxxxxxxxxxxxxx.nicesrv.de` (oder `goodsrv.de`, `quicksrv.de` …). Der zeigt
auf deine IP und funktioniert – aber:

- **Er gehört netcup, nicht dir.** Bei einem Anbieterwechsel ist er weg.
- **Passkeys hängen fest daran.** Ein Passkey gilt für genau den Namen, unter
  dem er angelegt wurde. Wer sich unter `v2202….nicesrv.de` einen anlegt,
  verliert ihn beim Wechsel auf die richtige Domain. Endgültig.
- **Das Zertifikat kann klemmen.** Let's Encrypt zählt Zertifikate je
  registrierter Domain. `nicesrv.de` teilst du dir mit allen anderen
  netcup-Kunden – das Kontingent kann erschöpft sein, ohne dass du etwas falsch
  gemacht hast.

Für den **Testlauf in Teil C** ist er gut genug. Als Zuhause der App nicht.

**Also: eine eigene Domain kaufen.** Eine `.de` kostet 5–8 € im Jahr, bei netcup
selbst oder bei INWX, beide in Deutschland. Der Rest dieser Anleitung nennt sie
`deine-domain.de`.

> **Direkt auf der Hauptdomain betreiben, nicht auf einer Unterdomain.** Also
> `deine-domain.de`, nicht `app.deine-domain.de`. Der Grund heisst
> `WEBAUTHN_RP_ID`: Passkeys, die auf der Hauptdomain angelegt wurden, gelten
> auch auf jeder Unterdomain davon – umgekehrt nicht. Wer auf einer Unterdomain
> anfängt, sitzt dort für immer fest.

Zwei DNS-Einträge, sobald du die IP des Servers kennst:

| Typ    | Name | Wert                 |
| ------ | ---- | -------------------- |
| `A`    | `@`  | die IPv4 des Servers |
| `AAAA` | `@`  | die IPv6 des Servers |

Der `AAAA`-Eintrag ist keine Kür: Viele Mobilfunknetze sind IPv6-only. Fehlt er,
läuft es über den Übersetzer des Providers – meistens gut, manchmal langsam. Die
IPv6 des Servers steht im netcup-Kundenkonto beim Server selbst.

> **TTL vorher auf 60 Sekunden senken**, wenn die Domain schon woandershin
> zeigt. Sonst warten Leute stundenlang auf den Wechsel.

## A2. Der SSH-Schlüssel

**[BEI DIR]** – Termux (Android), Terminal (macOS/Linux) oder PowerShell
(Windows):

```bash
ssh-keygen -t ed25519 -C "initiative"
```

Dreimal Enter (Vorgabepfad, kein Passwort – oder eines, wenn dein Gerät
gestohlen werden könnte).

Den öffentlichen Teil anzeigen und aufheben, er wird gleich gebraucht:

```bash
cat ~/.ssh/id_ed25519.pub
```

> **In Termux** vorher einmal `pkg install openssh`.
>
> **Unter Windows** liegt die Datei in `%USERPROFILE%\.ssh\id_ed25519.pub`.

## A3. Der Sicherungsschlüssel

**[BEI DIR]**, nicht auf dem Server:

```bash
# Android: pkg install age    macOS: brew install age    Linux: apt install age
age-keygen -o initiative-backup.key
```

Ausgegeben wird eine Zeile `Public key: age1…`. Die kommt später in die `.env`
des Servers. **Die Datei `initiative-backup.key` selbst gehört ins
Passwortprogramm und niemals auf den Server.**

Damit kann der Server Sicherungen **schreiben**, aber keine einzige **lesen**.
Selbst wer die Maschine vollständig übernimmt, kommt an die Abzüge von gestern
nicht heran.

## A4. Die alten Geheimnisse

**Übernehmen, nicht neu erzeugen.** Drei Werte:

| Wert                                     | Wenn du ihn neu erzeugst                      |
| ---------------------------------------- | --------------------------------------------- |
| `JWT_SECRET`                             | **jeder** wird abgemeldet                     |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | **jedes** Push-Abo ist tot, alle neu erlauben |

Sie stehen in den Fly.io-Secrets. **[BEI DIR]**, falls `flyctl` greifbar ist:

```bash
flyctl secrets list --app initiative-api   # zeigt nur die Namen, nicht die Werte
```

Die Werte selbst liegen dort, wo du sie damals hinterlegt hast – im
Passwortprogramm oder in deiner lokalen `.env`.

## A5. Was der Domainwechsel kostet

Die Domain ändert sich, also passiert Folgendes, und zwar unvermeidlich:

- **Alle Passkeys werden unbrauchbar.** Sie hängen am alten Hostnamen.
- **Alle sind abgemeldet.** Die Anmeldedaten liegen im `localStorage`, und der
  gehört zur Domain.
- **Alle Push-Abos sind tot.** Jeder muss Benachrichtigungen neu erlauben – auch
  bei übernommenen VAPID-Schlüsseln, denn das Abo hängt am Ursprung.
- **Die installierte App muss neu installiert werden.**

> **Das ist die eine Ankündigung, die vorher raus muss.** Eine Nachricht in der
> Gruppe, ein bis zwei Tage vorher:
>
> _„Am Samstag zieht die App auf eine neue Adresse um. Setzt euch bitte vorher
> in den Einstellungen ein Passwort – wer sich nur per Fingerabdruck anmeldet,
> kommt danach sonst nicht mehr rein."_
>
> Wer sich **nur** per Passkey anmeldet und vorher kein Passwort setzt, ist
> ausgesperrt. Das ist der einzige Schritt in dieser Anleitung, der jemand
> anderem etwas kaputtmachen kann.

---

# Teil B – Server einrichten

## B1. Erste Anmeldung

**[BROWSER]** Im netcup-Kundenkonto (SCP) den Server mit **Ubuntu 24.04 LTS**
aufsetzen, falls noch nicht geschehen. IP und root-Passwort stehen dort.

**[BEI DIR]**:

```bash
ssh root@<deine-server-ip>
```

Beim ersten Mal fragt SSH nach dem Fingerabdruck – `yes`.

**✓ Geschafft, wenn** eine Eingabeaufforderung `root@v2202…:~#` erscheint.

## B2. System aktualisieren, Docker installieren

**[SERVER]** als root:

```bash
apt update && apt upgrade -y
apt install -y ca-certificates curl git restic
```

Docker kommt aus der **offiziellen Quelle**, nicht aus dem Ubuntu-Paket:

```bash
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  >/etc/apt/sources.list.d/docker.list
apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
```

> **Warum nicht `apt install docker.io`?** Das Ubuntu-Paket ist meist eine
> Version hinterher, und `docker-compose-plugin` gibt es dort **gar nicht** –
> der Befehl `docker compose` würde schlicht fehlen. Genau daran scheitert man
> sonst in Teil C, ohne dass klar wäre, warum.

**✓ Geschafft, wenn** beides eine Versionsnummer ausgibt:

```bash
docker --version && docker compose version
```

## B3. Einen eigenen Benutzer anlegen

**[SERVER]** als root:

```bash
adduser --gecos "" initiative
usermod -aG sudo,docker initiative
install -d -o initiative -g initiative -m 755 /opt/initiative
install -d -o initiative -g initiative -m 700 /var/backups/initiative
```

Den SSH-Schlüssel aus **A2** hinterlegen. Die Zeile mit `ssh-ed25519 AAAA…`
durch die echte Ausgabe von `cat ~/.ssh/id_ed25519.pub` ersetzen – in einer
Zeile, ohne Umbruch:

```bash
install -d -o initiative -g initiative -m 700 /home/initiative/.ssh
cat >/home/initiative/.ssh/authorized_keys <<'ENDE'
ssh-ed25519 AAAA… initiative
ENDE
chown initiative:initiative /home/initiative/.ssh/authorized_keys
chmod 600 /home/initiative/.ssh/authorized_keys
```

**✓ Jetzt prüfen, in einem NEUEN Terminalfenster** – das alte offen lassen:

```bash
ssh initiative@<deine-server-ip>
```

Kommt das **ohne Passwortabfrage** hinein? Dann weiter. Wenn nicht: **nicht
weitermachen.** Der nächste Schritt schaltet die Passwortanmeldung ab.

## B4. Härten

**[SERVER]** als `initiative`:

```bash
cd /opt/initiative
curl -fsSLO https://raw.githubusercontent.com/compufan/Initiative/HEAD/deploy/vps/haerten.sh
chmod +x haerten.sh
sudo ./haerten.sh initiative
```

Das Skript prüft **zuerst**, ob dein Schlüssel hinterlegt ist, und weigert sich
sonst – die Aussperr-Sicherung. Dann richtet es ein:

- SSH: kein Passwort, kein root, nur der Benutzer `initiative`
- ufw: eingehend nur 22, 80, 443
- eine `DOCKER-USER`-Regel, damit Docker die Firewall nicht umgeht
- fail2ban für SSH
- automatische Sicherheitsupdates
- Kernel-Einstellungen

Es ist wiederholbar: zweimal ausführen ändert nichts.

**✓ Geschafft, wenn:**

```bash
sudo ufw status | head -8          # zeigt 22, 80, 443
sudo systemctl is-active fail2ban  # active
```

**Und in einem NEUEN Fenster** noch einmal `ssh initiative@<ip>`. Klappt das,
darfst du das alte root-Fenster schliessen.

> **Der Notausgang**, falls doch etwas schiefgeht: Im netcup-Kundenkonto gibt es
> eine VNC-Konsole und ein Rettungssystem. Damit kommst du auch ohne SSH an die
> Maschine. Unbequem, aber es geht.

---

# Teil C – Die App starten

## C1. Die Dateien holen

**[SERVER]** als `initiative`:

```bash
cd /opt/initiative
for datei in docker-compose.yml Caddyfile deploy.sh backup.sh; do
  curl -fsSLO "https://raw.githubusercontent.com/compufan/Initiative/HEAD/deploy/vps/$datei"
done
curl -fsSL https://raw.githubusercontent.com/compufan/Initiative/HEAD/deploy/vps/.env.beispiel -o .env
chmod +x deploy.sh backup.sh
chmod 600 .env
```

## C2. Geheimnisse erzeugen

**[SERVER]**:

```bash
# Datenbankpasswort. Nur Buchstaben und Ziffern – ein @ : / # oder ? darin
# zerlegt die Verbindungsadresse, und der Fehler danach sieht nach allem
# Möglichen aus, nur nicht nach dem Passwort.
openssl rand -hex 24
```

Den Medienschlüssel erzeugt die API selbst:

```bash
docker run --rm ghcr.io/compufan/initiative-api:live initiative-api --generate-media-key
```

> **Diesen Schlüssel sofort ins Passwortprogramm.** Zwei Gründe:
>
> 1. Ohne ihn sind alle damit abgelegten Dateien **endgültig weg**. Es gibt
>    keine Hintertür.
> 2. Er darf **nicht** in dieselbe Sicherung wie die Dateien. Sonst läge er
>    neben dem, was er schützen soll, und die ganze Übung wäre umsonst.

## C3. Die `.env` ausfüllen

**[SERVER]**:

```bash
nano .env
```

> **nano in Termux:** Speichern ist `Strg`+`O`, dann Enter, dann `Strg`+`X`. Die
> Strg-Taste liegt in Termux auf der Zusatzzeile über der Tastatur. Wem das zu
> fummelig ist, ändert einzelne Zeilen mit
> `sed -i 's|^DOMAIN=.*|DOMAIN=deine-domain.de|' .env`.

Auszufüllen:

| Feld                               | Wert                                                    |
| ---------------------------------- | ------------------------------------------------------- |
| `DOMAIN`                           | **für den Testlauf** der netcup-Hostname, siehe unten   |
| `ACME_EMAIL`                       | deine E-Mail (Ablaufwarnungen von Let's Encrypt)        |
| `PUBLIC_APP_URL`, `PUBLIC_API_URL` | `https://` + dieselbe Domain, beide gleich              |
| `POSTGRES_PASSWORD`                | das eben erzeugte                                       |
| `JWT_SECRET`, `VAPID_*`            | die **alten** Werte aus A4                              |
| `MEDIA_KEY`                        | der eben erzeugte                                       |
| `BACKUP_PUBKEY`                    | die `age1…`-Zeile aus A3                                |
| `ADMIN_PASSWORD`                   | mindestens 8 Zeichen, sonst bleibt der Adminbereich aus |
| `OPERATOR_NAME/ADDRESS/EMAIL`      | für `/datenschutz` – Art. 13 DSGVO verlangt das         |
| `WEBAUTHN_RP_ID`                   | **beim Testlauf leer lassen**                           |

**Für den Testlauf** den netcup-Hostnamen eintragen:

```
DOMAIN=v2202xxxxxxxxxxxxxx.nicesrv.de
PUBLIC_APP_URL=https://v2202xxxxxxxxxxxxxx.nicesrv.de
PUBLIC_API_URL=https://v2202xxxxxxxxxxxxxx.nicesrv.de
```

So siehst du, ob alles läuft, bevor die echte Domain umgestellt wird – und ohne
dass jemand etwas merkt.

## C4. Starten

**[SERVER]**:

```bash
./deploy.sh live
```

Das holt die Abbilder aus der GitHub-Registry und startet den Stapel. Beim
ersten Mal dauert es ein paar Minuten.

**✓ Geschafft, wenn** alle vier Dienste laufen (`postgres` zusätzlich
`healthy`):

```bash
docker compose ps
curl -s https://v2202xxxxxxxxxxxxxx.nicesrv.de/healthz
```

und die zweite Zeile etwas mit `"status":"ok"` antwortet.

**[BROWSER]** Die Adresse aufrufen – die App muss erscheinen, mit gültigem
Zertifikat.

> Wenn es klemmt: [Fehlersuche](#fehlersuche) am Ende.

## C5. Zwischenstand

Damit steht fest, dass Abbilder, Zertifikat, Proxy, Datenbank und Migrationen
funktionieren. Der Rest ist der Umzug der Daten.

**Lege hier noch kein Konto an, das du behalten willst** – die Datenbank wird in
Teil D überschrieben.

---

# Teil D – Die Daten holen

## D1. Wartungsfenster

**[BEI DIR]** Die alte App stilllegen, damit während des Umzugs nichts mehr
dazukommt:

```bash
flyctl scale count 0 --app initiative-api
```

Ab jetzt sind alle offline. Ein Abend um 22 Uhr ist ein guter Zeitpunkt.

## D2. Die Datenbank

**[SERVER]**. Die Verbindungszeichenfolge von Neon **ohne** `-pooler` im
Hostnamen verwenden – über den Pooler ist ein Dump unzuverlässig:

```bash
cd /opt/initiative
docker run --rm -v /opt/initiative:/w -w /w postgres:16-alpine \
  pg_dump -Fc --no-owner --no-privileges \
  "postgres://USER:PW@ep-xxx.eu-central-1.aws.neon.tech/initiative?sslmode=require" \
  -f neon.dump
```

Einspielen:

```bash
docker compose up -d postgres
docker compose exec -T postgres psql -U initiative -d initiative \
  -c 'drop schema if exists public cascade; create schema public;'
docker compose exec -T postgres pg_restore -U initiative -d initiative \
  --no-owner --no-privileges </opt/initiative/neon.dump
docker compose restart api
```

Es wird **keine einzige Erweiterung** gebraucht – kein `pgcrypto`, kein
`uuid-ossp`, kein `pg_trgm`. Alle Schlüssel erzeugt die Anwendung selbst.

**✓ Geschafft, wenn** die Zeilenzahlen stimmen:

```bash
docker compose exec -T postgres psql -U initiative -d initiative -c \
  "select relname, n_live_tup from pg_stat_user_tables order by relname;"
```

Dieselbe Abfrage gegen Neon laufen lassen und vergleichen.

Danach den Abzug wegräumen – er ist Klartext:

```bash
shred -u /opt/initiative/neon.dump
```

## D3. Die Dateien

Die Schlüssel im Bucket sind bereits Pfade der Form
`{art}/{jahr}/{monat}/{benutzer}/{zeitstempel}-{zufall}.{endung}` – ein
1:1-Spiegeln genügt, es muss nichts umbenannt werden.

**[SERVER]**:

```bash
sudo apt install -y rclone
rclone config
```

> **`rclone config` ist ein Frage-und-Antwort-Dialog**, kein Befehl mit
> Argumenten. Der Reihe nach: `n` (neu) → Name `r2` → Typ `s3` → Anbieter
> `Cloudflare` → Zugangsdaten von Hand eingeben → `access_key_id` und
> `secret_access_key` aus dem Cloudflare-Konto → Region `auto` → Endpoint
> `https://<account-id>.r2.cloudflarestorage.com` → den Rest mit Enter
> durchwinken → `q` zum Beenden.

```bash
rclone copy r2:dein-bucket /var/lib/docker/volumes/initiative_uploads/_data \
  --transfers 8 --progress
```

**✓ Geschafft, wenn** nichts fehlt. Die Datenbank kennt das vollständige
Inventar:

```bash
docker compose exec -T postgres psql -U initiative -d initiative -tAc \
  "select storage_key from attachments order by 1" | sort >/tmp/soll.txt
cd /var/lib/docker/volumes/initiative_uploads/_data && find . -type f \
  | sed 's|^\./||' | sort >/tmp/ist.txt
comm -23 /tmp/soll.txt /tmp/ist.txt   # fehlt auf der Platte -> MUSS leer sein
comm -13 /tmp/soll.txt /tmp/ist.txt   # liegt herum, kennt niemand -> egal
```

> **Diese übernommenen Dateien bleiben unverschlüsselt** – sie kommen aus der
> Zeit davor. Die App liest beides (`storage/tresor.rs` erkennt am Kopf, was
> vorliegt), und alles, was ab jetzt hochgeladen wird, ist verschlüsselt. Wer
> die alten auch verschlüsselt haben will, lädt sie neu hoch; ein
> Automatikwerkzeug dafür gibt es bewusst nicht, weil ein halb durchgelaufener
> Massenumbau schlimmer wäre als der Zustand davor.

---

# Teil E – Umschalten

## E1. Auf die echte Domain

**[SERVER]** in `/opt/initiative/.env`:

```
DOMAIN=deine-domain.de
PUBLIC_APP_URL=https://deine-domain.de
PUBLIC_API_URL=https://deine-domain.de
WEBAUTHN_RP_ID=deine-domain.de
```

> **`WEBAUTHN_RP_ID` ist die eine Einstellung, die sich nie mehr korrigieren
> lässt.** Sie jetzt auf die Hauptdomain zu setzen, während die App direkt dort
> läuft, hält dir die Tür offen, später auf eine Unterdomain zu wechseln, ohne
> dass jemand seinen Passkey verliert. Umgekehrt geht es nicht.

**[BROWSER]** Die DNS-Einträge aus A1 auf die Server-IP setzen (`A` **und**
`AAAA`).

**[SERVER]**:

```bash
./deploy.sh live
```

Caddy holt das Zertifikat wenige Sekunden nach dem DNS-Wechsel.

**✓ Geschafft, wenn** `https://deine-domain.de` die App zeigt und
`https://deine-domain.de/healthz` `ok` sagt.

## E2. Die alte API muss noch ein paar Tage weiterlaufen

**[BEI DIR]**:

```bash
flyctl scale count 1 --app initiative-api
```

Auf jedem installierten Gerät liegt die alte App im Zwischenspeicher des Service
Workers und spricht weiter mit `initiative-api.fly.dev`. Erst wenn jemand das
Update-Banner antippt, wechselt er. Die App fragt alle 30 Minuten und bei jedem
Zurückholen in den Vordergrund nach – ein bis zwei Tage reichen.

**Wird die alte API vorher abgeschaltet**, sehen Leute eine Oberfläche, die
keine Daten mehr bekommt. Das ist der unangenehmste Zustand von allen, weil es
nicht nach „umgezogen" aussieht, sondern nach „kaputt".

## E3. Bei GitHub hinterlegen

Damit ein Push wieder veröffentlicht, statt dass du jedes Mal von Hand
`deploy.sh` aufrufst.

Zuerst ein **eigenes** Schlüsselpaar dafür, nicht dein persönliches:

```bash
# [BEI DIR]
ssh-keygen -t ed25519 -f ~/.ssh/initiative-deploy -C "github-deploy" -N ""
cat ~/.ssh/initiative-deploy       # dieser Teil kommt in das GitHub-Secret
cat ~/.ssh/initiative-deploy.pub   # dieser auf den Server
```

**[SERVER]** – den Wächter holen und den öffentlichen Teil eintragen:

```bash
cd /opt/initiative
curl -fsSLO https://raw.githubusercontent.com/compufan/Initiative/HEAD/deploy/vps/nur-deploy.sh
chmod +x nur-deploy.sh
nano /home/initiative/.ssh/authorized_keys
```

Eine neue Zeile, in dieser Form – der Teil ab `ssh-ed25519` ist die Ausgabe von
`cat ~/.ssh/initiative-deploy.pub`, alles in **einer** Zeile:

```
command="/opt/initiative/nur-deploy.sh",restrict ssh-ed25519 AAAA… github-deploy
```

Damit kann dieser Schlüssel genau eines: eine Version starten. Kein `ls`, kein
`cat .env`, keine Weiterleitung. `nur-deploy.sh` nimmt aus dem angeforderten
Befehl nur die Kennung und prüft, dass sie wirklich wie eine aussieht.

> **Warum nicht direkt `command="…/deploy.sh $SSH_ORIGINAL_COMMAND"`?** Weil die
> GitHub-Action die ganze Befehlszeile schickt – `deploy.sh` liefe dann doppelt
> und nähme seinen eigenen Pfad für die Kennung. Der Deploy sähe erfolgreich
> aus und startete nichts.
>
> **Wenn der Deploy danach mit „darf keine Sitzung öffnen" scheitert**, fordert
> die Action eine Shell statt eines Befehls an. Dann die Zeile auf
> `restrict ssh-ed25519 AAAA… github-deploy` kürzen (ohne `command=`) – der
> Schlüssel ist dann nicht mehr eingeschränkt, aber der Deploy läuft.

**[BROWSER]** Repository → Settings → Secrets and variables → Actions:

| Name          | Wert                                              |
| ------------- | ------------------------------------------------- |
| `VPS_HOST`    | die IP des Servers                                |
| `VPS_USER`    | `initiative`                                      |
| `VPS_SSH_KEY` | der **private** Teil (`~/.ssh/initiative-deploy`) |
| `VPS_APP_URL` | `https://deine-domain.de`                         |

Solange diese fehlen, überspringt sich `deploy-vps.yml` stillschweigend – der
alte Fly-Weg läuft ungestört weiter. So können beide nebeneinanderstehen, bis
der Umzug wirklich durch ist.

> **Ehrlich dazu:** Wer in dein GitHub-Konto kommt, kommt auf den Server. Die
> Einschränkung auf `deploy.sh` begrenzt den Schaden auf „kann eine andere
> Version starten" statt „kann alles".

Die beiden Pakete müssen für den Server erreichbar sein. Am einfachsten:
**[BROWSER]** GitHub → dein Profil → Packages → Sichtbarkeit auf `public`. Die
Abbilder enthalten keine Geheimnisse – alle Werte kommen zur Laufzeit aus
`.env`.

---

# Teil F – Betrieb

## F1. Sicherung einrichten

**[SERVER]**:

```bash
sudo tee /etc/systemd/system/initiative-backup.service >/dev/null <<'ENDE'
[Service]
Type=oneshot
User=initiative
ExecStart=/opt/initiative/backup.sh
ENDE
sudo tee /etc/systemd/system/initiative-backup.timer >/dev/null <<'ENDE'
[Timer]
OnCalendar=hourly
Persistent=true
[Install]
WantedBy=timers.target
ENDE
sudo systemctl daemon-reload
sudo systemctl enable --now initiative-backup.timer
```

Einmal von Hand auslösen und nachsehen:

```bash
sudo systemctl start initiative-backup.service
ls -l /var/backups/initiative/
```

**✓ Geschafft, wenn** dort eine Datei `db-….dump.age` liegt. Die Endung `.age`
ist der Beweis, dass verschlüsselt wurde – ohne `BACKUP_PUBKEY` hiesse sie nur
`.dump`, und dann liegt dein ganzer Nachrichtenverlauf im Klartext auf der
Platte.

**Zusätzlich ausser Haus**, einmal täglich. Eine Hetzner Storage Box kostet etwa
4 € im Monat. Dass es ein **zweiter** Anbieter ist, ist hier ein Vorteil:

```bash
# [SERVER], einmalig
head -c 32 /dev/urandom | base64 | sudo tee /opt/initiative/restic-passwort
sudo chown initiative:initiative /opt/initiative/restic-passwort
sudo chmod 600 /opt/initiative/restic-passwort
# Dieses Passwort AUCH ins Passwortprogramm – ohne es ist das Backup wertlos.
restic init   # nachdem RESTIC_REPOSITORY in .env steht
```

Dann ein zweiter Timer mit `ExecStart=/opt/initiative/backup.sh --auswaerts` und
`OnCalendar=daily`.

> **Eine Wiederherstellung, die nie geübt wurde, ist kein Backup.** Einmal im
> Monat, fünf Minuten:
>
> ```bash
> # [BEI DIR] – entschlüsseln kannst nur du.
> scp initiative@server:/var/backups/initiative/db-\*.age .
> age -d -i initiative-backup.key db-….dump.age >probe.dump
> # Dann in eine Wegwerf-Datenbank einspielen und Zeilen zählen.
> ```

## F2. Merken, wenn etwas nicht läuft

Ohne Ersatz erfährst du von einem Ausfall dadurch, dass ein Freund schreibt.

Das Billigste, das wirklich hilft: ein Konto bei healthchecks.io (kostenlos),
das `https://deine-domain.de/healthz` im Minutentakt abfragt und eine Nachricht
schickt, wenn keine Antwort kommt. Die URL kommt als `HEALTHCHECK_URL` in die
`.env` – dann meldet sich auch die Sicherung dort, und ein stillschweigend
gescheitertes Backup fällt auf.

**Ebenso wichtig: die Platte.** 256 GB müssen Datenbank, Uploads, Abbilder und
lokale Sicherungen tragen. Fotos in einer Freundesgruppe sind die realistischste
Ursache für ein volles Dateisystem, und ein volles `/var` legt Postgres lahm.

```bash
# [SERVER]
sudo tee /etc/cron.daily/platte >/dev/null <<'ENDE'
#!/bin/sh
voll=$(df --output=pcent / | tail -1 | tr -dc '0-9')
[ "$voll" -gt 85 ] && curl -fsS -m 10 "$HEALTHCHECK_ALARM_URL" >/dev/null
ENDE
sudo chmod +x /etc/cron.daily/platte
```

## F3. Veröffentlichen

Ab jetzt wie vorher: Push auf den Branch, GitHub baut, der Server holt.

Von Hand, wenn es schnell gehen muss:

```bash
# [SERVER]
cd /opt/initiative && ./deploy.sh <git-sha>
```

**Zurückrollen** ist derselbe Befehl mit der Kennung von gestern. Welche gerade
läuft, steht in den Einstellungen der App und in `.env` unter `IMAGE_TAG`.

## F4. Neustarts

Sicherheitsupdates laufen von allein, **Neustarts nicht**. Das ist Absicht: Ein
Neustart um halb vier ist genau dann unangenehm, wenn man ihn nicht mitbekommt.

```bash
# [SERVER] – gelegentlich nachsehen
[ -f /var/run/reboot-required ] && echo "Neustart fällig"
sudo reboot
```

Danach kommt der Stapel von allein hoch (`restart: unless-stopped`).

---

# Teil G – Aufräumen

Erst, wenn ein paar Tage nichts mehr über die alte API kam.

- [ ] Fly-App abschalten: `flyctl apps destroy initiative-api`
- [ ] `deploy.yml` (Fly) aus dem Repository entfernen
- [ ] `wartung.yml` auf SSH umschreiben. **Dabei nicht die Protokolle in die
      GitHub-Zusammenfassung schreiben** – dort landen sonst Produktionsprotokolle
      mit möglichem Personenbezug in einem US-System, und du hättest vier
      US-Anbieter durch einen ersetzt und den unmittelbarsten Datenabfluss
      behalten.
- [ ] Vercel-Projekt löschen, Neon-Datenbank löschen, R2-Bucket leeren
- [ ] **Auftragsverarbeitungsvertrag mit netcup** – im Kundenkonto unter den
      Stammdaten zum Anklicken. Und, falls Hetzner als Sicherungsablage
      dazukommt, dort ebenfalls.
- [ ] Datenschutzerklärung anpassen: die drei US-Anbieter streichen, netcup (und
      ggf. Hetzner) eintragen, den Absatz zu Push-Benachrichtigungen
      **behalten** – die laufen weiterhin über Google und Apple.
- [ ] DNS-Zone bei einem europäischen Anbieter führen (netcup betreibt selbst
      DNS)

---

# Fehlersuche

| Symptom                                           | Ursache und Abhilfe                                                                                                                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker compose` gibt es nicht                    | Das Ubuntu-Paket `docker.io` statt der offiziellen Quelle. B2 wiederholen.                                                                                                   |
| `deploy.sh`: `MEDIA_KEY fehlt`                    | Absicht. Ohne Schlüssel lägen die Dateien im Klartext; ein Fehlstart ist die freundlichere Antwort. C2 nachholen.                                                            |
| Kein Zertifikat, Caddy meldet einen ACME-Fehler   | DNS zeigt noch nicht auf den Server, oder Port 80 ist zu. `curl -I http://deine-domain.de` von aussen prüfen. Let's Encrypt braucht **Port 80**, auch für HTTPS-Zertifikate. |
| App lädt, aber keine Bilder                       | `PUBLIC_API_URL` falsch. Sie baut jede Medienadresse – ein Tippfehler macht alle Bilder unsichtbar, ohne dass sonst etwas auffällt.                                          |
| Anmeldung sagt „zu viele Versuche"                | Die Ratenbremse. Ein paar Minuten warten. Sie ist Absicht und gehört im Betrieb nicht abgeschaltet.                                                                          |
| Uploads scheitern ab einer gewissen Grösse        | Grössenlimit je Art (`constants.rs`): Videos 200 MB, Bilder 25 MB, Sticker 2 MB.                                                                                             |
| Postgres startet nicht, `permission denied`       | Jemand hat `cap_drop: ALL` bei Postgres ergänzt. Wieder entfernen – der Einstiegspunkt braucht `CHOWN`/`SETUID`.                                                             |
| Nach einem Neustart ist alles weg                 | Ein Volume wurde umbenannt. `docker volume ls` prüfen; die Namen beginnen mit `initiative_`.                                                                                 |
| `ufw status` sagt zu, ein Port ist trotzdem offen | Docker umgeht ufw. `haerten.sh` erneut laufen lassen, sie setzt die `DOCKER-USER`-Regel.                                                                                     |
| Eine Datei wird heruntergeladen statt angezeigt   | Kein Fehler. Nur Fotos, Videos, Ton und PDF werden dargestellt – alles andere könnte Skript im Ursprung der App ausführen. Siehe `SICHERHEIT.md`.                            |

**Protokolle ansehen:**

```bash
# [SERVER]
cd /opt/initiative
docker compose logs -f api      # die API
docker compose logs -f proxy    # TLS und Zertifikate
docker compose logs --tail 50   # alles, kurz
```

**An die Datenbank**, ohne einen Port zu öffnen:

```bash
docker compose exec postgres psql -U initiative -d initiative
```

---

# Zum Nachschlagen

| Wert             | Wo                              | Warum es zählt                                                                                        |
| ---------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `JWT_SECRET`     | `.env` auf dem Server           | Ein neuer Wert meldet **jeden** ab.                                                                   |
| `VAPID_*`        | `.env` auf dem Server           | Neue Schlüssel machen **jedes** Push-Abo ungültig.                                                    |
| `MEDIA_KEY`      | `.env` **und** Passwortprogramm | Ohne ihn sind die Dateien endgültig weg. Nicht in dieselbe Sicherung wie die Dateien.                 |
| `BACKUP_PUBKEY`  | `.env` (ist öffentlich)         | Der private Teil liegt **nie** auf dem Server. Genau das ist der Punkt.                               |
| `WEBAUTHN_RP_ID` | `.env` auf dem Server           | Die eine Entscheidung, die sich nie korrigieren lässt. Hauptdomain eintragen.                         |
| `PUBLIC_API_URL` | `.env` auf dem Server           | Baut jede Medienadresse. Ein Tippfehler macht alle Bilder unsichtbar, ohne dass sonst etwas auffällt. |
| `CORS_ORIGINS`   | leer lassen                     | Bei einer Domain gibt es keine Cross-Origin-Anfragen. Niemals `*` – das schaltet die Anmeldedaten ab. |
| `REALTIME_BUS`   | `memory`                        | Bei einem Prozess robuster. Genaue Schreibweise: `Memory` landet bei Postgres.                        |
| `RATE_LIMIT`     | nicht setzen                    | Vorgabe ist an. Es gibt genau einen guten Grund zum Abschalten, und der heisst Browser-Tests.         |
| `STORAGE_DRIVER` | `local`                         | Und damit gehört das Upload-Verzeichnis ins Backup – Bilder liegen **nicht** in der Datenbank.        |
| `VITE_API_URL`   | leer lassen                     | Alle Anfragen relativ, der WebSocket folgt der Domain von allein.                                     |

---

# Anhang: was der Umzug bringt und kostet

**Es entfallen drei Auftragsverarbeiter mit US-Bezug** (Neon, Cloudflare,
Vercel) und einer ohne (Fly.io). Übrig bleibt **einer**: netcup selbst – „eigener
Server" heisst nicht „kein Auftragsverarbeiter", netcup betreibt die Hardware und
hat physischen Zugriff. Kommt eine Sicherungsablage bei Hetzner dazu, sind es
zwei; beide in der EU, beide ohne Drittlandübermittlung.

**Was bleibt:** Push-Benachrichtigungen laufen über die Dienste von Google und
Apple. Der _Inhalt_ ist für sie nicht lesbar (eigene VAPID-Schlüssel,
Verschlüsselung nach RFC 8291), aber die Zustellung erzeugt Metadaten in den
USA. Einen Vertrag gibt es dafür weder, noch ist einer nötig – den Dienst hat
der Browser des Nutzers gewählt, nicht du. Nennen muss man es trotzdem.

**Was es kostet:** rund 10 € im Monat für den Server, dazu etwa 4 € für die
Sicherung ausser Haus, dazu 5–8 € im Jahr für die Domain. Heute läuft alles in
kostenlosen Kontingenten. Es ist kein Sparprogramm, sondern ein Tausch: Geld und
Zeit gegen Kontrolle.

**Was du verlierst:**

| Weg                                 | Wie schlimm                                                                                                                                          |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Verwaltete Datenbank-Backups        | Neon kostenlos gibt sechs Stunden Historie. Stündliche Abzüge sind **besser** – höchstens eine Stunde Verlust.                                       |
| Globales CDN                        | Fast egal. Deine Leute sind in DE/AT; ein Server in Wien ist für sie schneller als ein Vercel-Knoten mit Kaltstart.                                  |
| Automatische Skalierung             | Irrelevant bei zehn bis fünfzig Leuten – und sie war hier nachweislich ein Problem, kein Vorteil (gestoppte Maschinen, grüne Deploys bei toter App). |
| Deploy ohne Ausfall                 | 10–20 Sekunden je Veröffentlichung, dazu brechen offene Verbindungen ab. Abends veröffentlichen, fertig.                                             |
| DDoS-Schutz auf Anwendungsebene     | Kleiner Verlust. Cloudflare wieder davorzuschalten würde den ganzen Datenschutzgewinn zunichtemachen – man kann nicht beides haben.                  |
| Vorschau-Adressen je Branch         | Spürbar, wenn du im echten Browser gegenlesen willst. Ersatz wäre ein zweiter Stapel auf `test.deine-domain.de`.                                     |
| **Jemand anderes hat Bereitschaft** | Der eigentliche Preis. Ein Ausfall fällt niemandem ausser dir auf – deshalb ist F2 keine Kür.                                                        |

**Weiterlesen:** [`SICHERHEIT.md`](SICHERHEIT.md) – wogegen die einzelnen
Massnahmen helfen und wogegen nicht.
