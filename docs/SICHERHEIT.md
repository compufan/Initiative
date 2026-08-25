# Sicherheit: wogegen was hilft

Dieses Dokument sagt für jede Schutzmassnahme, **welchen Angriff sie abwehrt und
welchen nicht**. Das ist wichtiger als eine Liste von Häkchen: Eine Massnahme,
von der man glaubt, sie decke mehr ab als sie tut, ist gefährlicher als gar
keine – weil man sich darauf verlässt.

---

## Die Angreifer, der Reihe nach

| Wer                                       | Wie wahrscheinlich                                                                 | Was ihn aufhält                                             |
| ----------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Jemand, der Passwörter durchprobiert      | **Ständig.** Passiert ab dem Tag, an dem die Domain im Zertifikatsprotokoll steht. | Argon2id, Ratenbremse (`drossel.rs`)                        |
| Ein Scanner, der bekannte Lücken abklopft | **Ständig.**                                                                       | Wenig Angriffsfläche, aktuelle Abbilder, Sicherheitsupdates |
| Ein Nutzer, der etwas Böses hochlädt      | Möglich – es sind Freunde, aber deren Geräte können übernommen sein.               | Positivliste beim Ausliefern (`media.rs`), Grössenlimits    |
| Jemand, der eine Sicherung erwischt       | **Der realistischste Datenabfluss.** Sicherungen liegen woanders und unbeobachtet. | Dateien verschlüsselt (`tresor.rs`), Abzüge mit `age`       |
| Jemand mit root auf dem laufenden Server  | Selten, aber das Ende der Fahnenstange.                                            | Nichts mehr. Nur Verhindern hilft.                          |
| netcup selbst / ein Abzug der Platte      | Sehr selten, aber genau die Sorge, um die es hier geht.                            | Teilweise – siehe unten.                                    |
| Der Hypervisor / ein Angriff auf netcup   | Sehr selten.                                                                       | Nichts. Auch Plattenverschlüsselung nicht.                  |

---

## Die Schichten

### 1. Anmeldung

- **Argon2id** mit den OWASP-Mindestwerten (m=19456 KiB, t=2, p=1). Ein
  gestohlener Hash ist damit nicht in vertretbarer Zeit umkehrbar.
- **Gleiche Antwortzeit für bekannte und unbekannte Namen.** Klingt nach
  Kleinkram, ist es nicht: Vorher antwortete der Server für ein nicht
  vorhandenes Konto in 8 Mikrosekunden und für ein vorhandenes in 505
  Millisekunden – die Mitgliederliste war mit einer Stoppuhr auslesbar.
  Geprüft in `tests/bremse.rs`.
- **Ratenbremse** je Konto **und** je Adresse getrennt (`drossel.rs`). Nur nach
  Adresse zu zählen hilft nicht gegen ein Botnetz auf ein Konto; nur nach Konto
  zu zählen erlaubt es, von einer Adresse aus tausend Konten mit demselben
  Passwort durchzuprobieren.
- **Kein Bannen.** Wer zu schnell ist, bekommt eine Absage und darf es sofort
  wieder versuchen. Ein Bann über Minuten sperrt im Zweifel den Falschen aus –
  hinter einem Mobilfunkanschluss teilen sich Hunderte dieselbe Adresse.
- **Erkennung wiederverwendeter Refresh-Token.** Taucht ein bereits
  eingelöster, aber noch nicht abgelaufener Token wieder auf, haben zwei
  Parteien dieselbe Kette – dann werden alle Token des Kontos verworfen.

### 2. Was hereinkommt

- Uploads laufen durch die API (nicht mehr direkt in einen Objektspeicher),
  mit Grössenlimit je Art und einer Warteschlange von zwei gleichzeitigen
  Uploads, damit ein grosses Video nicht den Speicher aufbraucht.
- `REGISTRATION_MODE=invite` auf dem Server: Niemand legt sich ungefragt ein
  Konto an.

### 3. Was hinausgeht — die Lücke, die der Umzug aufgemacht hat

Solange die App auf Vercel lag und die Dateien bei Cloudflare, waren das zwei
Domains. Auf dem eigenen Server ist es **eine**. Damit wird aus einer
hochgeladenen `.html` ein Dokument im Ursprung der App, das den Anmelde-Token
aus dem Browserspeicher liest. Die Medienadresse ist absichtlich ohne Anmeldung
abrufbar (sonst funktionieren `<img>` und der Service Worker nicht) – es genügt
also, jemandem den Link zu schicken.

`X-Content-Type-Options: nosniff` allein reicht dagegen **nicht**. Es
verhindert, dass der Browser den Typ rät, nicht dass er einen mitgeschickten
befolgt.

Deshalb: eine Positivliste dessen, was dargestellt werden darf (Fotos, Videos,
Ton, PDF). Alles andere bekommt `Content-Disposition: attachment` und eine
`sandbox`-CSP. `image/*` steht bewusst **nicht** auf der Liste – `image/svg+xml`
ist ein Bild und gleichzeitig ein Dokument, in dem Skript läuft.

Siehe `tests/medien_auslieferung.rs`.

### 4. Die abgelegten Dateien

Mit gesetztem `MEDIA_KEY` liegen Bilder, Videos und Anhänge verschlüsselt auf
der Platte (AES-256-GCM, je Datei ein eigener abgeleiteter Schlüssel, 64-KiB-
Blöcke, damit Vorspulen in Videos schnell bleibt – `storage/tresor.rs`).

**Das hilft gegen:** eine abhandengekommene Sicherung, einen versehentlich
freigegebenen Ordner, einen fremd gelesenen Objektspeicher, einen Abzug der
Platte ohne die `.env`.

**Das hilft nicht gegen:** jemanden mit root auf der laufenden Maschine. Der
liest den Schlüssel aus der Prozessumgebung. Wer etwas anderes behauptet,
verkauft ein Placebo.

Der Schlüssel gehört deshalb **nicht** in dieselbe Sicherung wie die Dateien.

### 5. Die Sicherungen

- Der Datenbank-Abzug wird mit einem **öffentlichen** age-Schlüssel
  verschlüsselt. Der Server kann Sicherungen schreiben, aber keine einzige
  lesen – der private Schlüssel liegt nie auf der Maschine. Selbst wer sie
  vollständig übernimmt, kommt an die Abzüge von gestern nicht heran.
- Der Abzug wird direkt aus `pg_dump` in `age` geleitet. Ohne diese Pipe läge
  der Klartext zwischendurch auf der Platte – auch für zwei Sekunden zu lang.
- Ausser Haus verschlüsselt restic zusätzlich. Das ist keine Doppelung ohne
  Sinn: Die beiden Schichten schützen zwei verschiedene Orte.

### 6. Die Container

| Massnahme                    | Wo                 | Wogegen                                                         |
| ---------------------------- | ------------------ | --------------------------------------------------------------- |
| `no-new-privileges`          | alle vier Dienste  | der übliche zweite Schritt nach einer Lücke im Dienst           |
| `cap_drop: ALL`              | api, web, proxy    | Kernel-Sonderrechte, die keiner von ihnen braucht               |
| `read_only`                  | api                | nachgeladene Programme, Hintertüren, die den Neustart überleben |
| eigener Benutzer (uid 10001) | api-Abbild         | dasselbe, eine Stufe früher                                     |
| kein `ports:` bei Postgres   | docker-compose.yml | eine offene 5432 im Internet                                    |

Postgres behält seine Capabilities: Der Einstiegspunkt des offiziellen Abbilds
richtet beim ersten Start das Datenverzeichnis ein und braucht dafür
`CHOWN`/`FOWNER`/`SETUID`. Ohne sie scheitert der allererste Start.

### 7. Der Server

`deploy/vps/haerten.sh` – SSH ohne Passwort und ohne root, ufw, fail2ban,
automatische Sicherheitsupdates, sysctl.

Die wichtigste Zeile darin ist die erste: Das Skript prüft, ob überhaupt ein
SSH-Schlüssel hinterlegt ist, und weigert sich sonst. Wer die Passwortanmeldung
abschaltet, bevor sein Schlüssel greift, sperrt sich aus – und kommt dann nur
noch über die VNC-Konsole im netcup-Kundenbereich hinein, was vom Handy aus
kein Vergnügen ist.

**Die ufw-Regel für Docker ist kein Beiwerk.** Docker schreibt eigene
iptables-Regeln **vor** die von ufw und umgeht sie damit. Solange kein Dienst
einen `ports:`-Eintrag hat, fällt das nicht auf. Wer später einen hinzufügt
(„nur kurz mal auf die Datenbank schauen"), stellt ihn ungewollt ins offene
Netz – und `ufw status` zeigt weiter brav an, dass alles zu ist.

---

## Was bewusst **nicht** gemacht wird

### Keine Ende-zu-Ende-Verschlüsselung

Der Server müsste dann auf fast alles verzichten, was die App ausmacht:
Volltextsuche über Nachrichten, serverseitige Vorschaubilder, Push mit Inhalt,
Kalenderfeeds. Und der schwierige Teil wäre nicht die Verschlüsselung, sondern
die Schlüsselverwaltung über mehrere Geräte hinweg – ein verlorenes Handy hiesse
ohne Zusatzaufwand: Verlauf weg.

Für eine Gruppe, die dem Betreiber ohnehin vertraut (er ist einer von ihnen),
ist der Preis zu hoch für den Gewinn.

### Keine Verschlüsselung der Nachrichtentexte in der Datenbank

Naheliegend, aber es würde die Volltextsuche über `messages.body` erledigen –
die läuft über einen GIN-Index, und auf verschlüsselte Werte lässt sich kein
Index legen. Ein Suchfeld, das nichts findet, wäre der schlechtere Tausch.

Und der Schlüssel läge auf derselben Maschine wie die Daten. Gegen den
Angreifer, gegen den es zählen würde, hilft das nichts.

### Kein Cloudflare davor

Es wäre wirksamer DDoS-Schutz. Es würde aber bedeuten, dass wieder ein
US-Anbieter jede Anfrage im Klartext sieht – und damit genau den Grund
zunichtemachen, aus dem der Umzug stattfindet. Man kann nicht beides haben.

### Kein fail2ban für die App

Falsches Werkzeug. Die Bremse in der API kennt Konto und Adresse getrennt und
sperrt niemanden aus; fail2ban würde den ganzen Anschluss dichtmachen, hinter
dem sich im Zweifel eine ganze Wohnung teilt.

---

## Plattenverschlüsselung (LUKS): das offene Ende

Was oben **nicht** abgedeckt ist: ein Abzug der laufenden virtuellen Platte
samt `.env`. Dann sind der Medienschlüssel und die Datenbank im Klartext
zugänglich.

LUKS würde genau diesen einen Fall schliessen – und nur diesen: eine Kopie der
Platte, die **ohne den Arbeitsspeicher** entsteht. Läuft die Maschine, liegt der
Schlüssel im RAM, und wer den Hypervisor hat, hat ihn auch.

**Was es kostet:** Der Server startet nach jedem Neustart nicht mehr von allein.
Er wartet auf die Passphrase – bei jedem Kernel-Update, bei jeder Wartung durch
netcup, nach jedem Stromausfall. Mit `dropbear-initramfs` lässt sich das per SSH
erledigen, auch vom Handy:

```bash
# Auf dem Server, als root.
apt install dropbear-initramfs
# Den eigenen öffentlichen Schlüssel eintragen:
#   /etc/dropbear/initramfs/authorized_keys
# In /etc/initramfs-tools/initramfs.conf:
#   IP=:::::eth0:dhcp
update-initramfs -u
```

Danach beim Neustart: `ssh -p 22 root@<server>` → `cryptroot-unlock`.

**Die Empfehlung:** Für eine Freundesgruppe ist das den Aufwand nicht wert. Der
Gewinn ist ein enger Sonderfall, der Preis ist ein Server, der ohne dich nicht
hochkommt – und der Ausfall, den das erzeugt, ist wahrscheinlicher als der
Angriff, den es verhindert.

Wer es trotzdem will, macht es **vor** dem Umzug: Nachträglich bedeutet neu
aufsetzen. netcup bietet dafür ein Rettungssystem und eine VNC-Konsole im
Kundenbereich.

---

## Was regelmässig zu tun ist

| Wann            | Was                                                                    |
| --------------- | ---------------------------------------------------------------------- |
| automatisch     | Sicherheitsupdates (`unattended-upgrades`)                             |
| bei Gelegenheit | Neustart nach Kernel-Updates – die laufen nicht von allein             |
| monatlich       | **eine Wiederherstellung üben.** Ein ungeübtes Backup ist kein Backup. |
| monatlich       | `docker compose pull && ./deploy.sh <sha>` – neue Basis-Abbilder       |
| bei jedem Umbau | prüfen, dass kein neuer `ports:`-Eintrag ins Netz zeigt                |

---

## Wenn doch etwas passiert ist

1. **Nicht neu starten.** Der Arbeitsspeicher ist die einzige Spur, die verloren
   geht.
2. `JWT_SECRET` neu setzen – das meldet jeden ab und macht gestohlene Token
   wertlos. Danach `docker compose up -d api`.
3. Alle Refresh-Token verwerfen:
   `docker compose exec -T postgres psql -U initiative -d initiative -c "delete from refresh_tokens;"`
4. Prüfen, ob der `MEDIA_KEY` betroffen ist. Wenn ja: Er lässt sich nicht
   einfach wechseln – die alten Dateien hängen daran. Ein Wechsel bedeutet, sie
   einmal durchzuschreiben.
5. **Meldepflicht.** Art. 33 DSGVO: 72 Stunden an die Aufsichtsbehörde, wenn ein
   Risiko für die Betroffenen besteht. Bei einem Messenger einer Freundesgruppe
   ist das im Zweifel der Fall. Art. 34: die Betroffenen selbst informieren,
   wenn das Risiko hoch ist.
