#!/usr/bin/env bash
# Den Server selbst absichern. Einmalig, direkt nach dem Aufsetzen.
#
#   sudo ./haerten.sh <benutzername>
#
# Das Skript ist wiederholbar: Zweimal ausführen ändert nichts und macht nichts
# kaputt. Es sagt vor jedem Eingriff, was es tut, und bricht ab, statt zu raten.
#
# # Die eine Gefahr
#
# Der gefährlichste Schritt ist das Abschalten der Passwort-Anmeldung. Wer das
# tut, bevor sein Schlüssel funktioniert, sperrt sich selbst aus – und kommt
# dann nur noch über die Notfall-Konsole im netcup-Kundenbereich hinein, was
# vom Handy aus kein Vergnügen ist.
#
# Deshalb prüft dieses Skript zuerst, ob überhaupt ein Schlüssel hinterlegt
# ist, und weigert sich sonst. Die Prüfung lässt sich nicht überstimmen; das
# ist Absicht.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
	echo "Bitte mit sudo ausführen: sudo ./haerten.sh <benutzername>" >&2
	exit 1
fi

BENUTZER="${1:?Aufruf: sudo ./haerten.sh <benutzername>}"

if ! id "$BENUTZER" >/dev/null 2>&1; then
	echo "Den Benutzer '$BENUTZER' gibt es nicht." >&2
	echo "Zuerst anlegen:  adduser $BENUTZER && usermod -aG sudo,docker $BENUTZER" >&2
	exit 1
fi

HEIM="$(getent passwd "$BENUTZER" | cut -d: -f6)"
SCHLUESSEL="$HEIM/.ssh/authorized_keys"

# ---------------------------------------------------------------------------
# 0. Die Aussperr-Prüfung. Zuerst, vor allem anderen.
# ---------------------------------------------------------------------------
if [ ! -s "$SCHLUESSEL" ]; then
	cat >&2 <<ENDE
ABBRUCH: Für '$BENUTZER' ist kein SSH-Schlüssel hinterlegt.

Würde dieses Skript jetzt weitermachen, wärst du nach dem Neustart des
SSH-Dienstes ausgesperrt.

So legst du ihn an – auf DEINEM Gerät, nicht hier:

  # Android (Termux) oder Linux oder macOS:
  ssh-keygen -t ed25519 -C "initiative"
  ssh-copy-id $BENUTZER@<server-adresse>

  # Windows (PowerShell):
  ssh-keygen -t ed25519 -C "initiative"
  type \$env:USERPROFILE\\.ssh\\id_ed25519.pub | ssh $BENUTZER@<server-adresse> "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"

Danach in einem NEUEN Terminal prüfen, dass
  ssh $BENUTZER@<server-adresse>
ohne Passwort hineinkommt. Erst dann dieses Skript noch einmal starten.
ENDE
	exit 1
fi

echo "SSH-Schlüssel für '$BENUTZER' gefunden – weiter."
chmod 700 "$HEIM/.ssh"
chmod 600 "$SCHLUESSEL"

# ---------------------------------------------------------------------------
# 1. SSH: kein Passwort, kein root
# ---------------------------------------------------------------------------
# Eine eigene Datei statt Änderungen an der sshd_config: Beim nächsten
# Systemupgrade fragt apt sonst, ob die veränderte Datei ersetzt werden soll –
# und die falsche Antwort nimmt alle Einstellungen hier wieder zurück.
cat >/etc/ssh/sshd_config.d/50-initiative.conf <<ENDE
# Von haerten.sh angelegt.
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PubkeyAuthentication yes
# Wer nach drei Versuchen nicht drin ist, probiert durch.
MaxAuthTries 3
# Nur dieser eine Benutzer. Jedes weitere Konto muss hier ausdrücklich dazu.
AllowUsers $BENUTZER
# Weiterleitungen, die hier niemand braucht und die ein übernommenes Konto
# zum Sprungbrett ins Netz dahinter machen würden.
AllowAgentForwarding no
AllowTcpForwarding yes
X11Forwarding no
ENDE

# AllowTcpForwarding bleibt an: Ohne das gibt es keinen `ssh -L`-Tunnel mehr,
# und der ist der einzige vorgesehene Weg an die Datenbank.

if sshd -t; then
	systemctl reload ssh 2>/dev/null || systemctl reload sshd
	echo "SSH: Passwort-Anmeldung aus, root-Anmeldung aus."
else
	echo "ABBRUCH: sshd lehnt die neue Konfiguration ab – nichts geändert." >&2
	rm -f /etc/ssh/sshd_config.d/50-initiative.conf
	exit 1
fi

# ---------------------------------------------------------------------------
# 2. Firewall
# ---------------------------------------------------------------------------
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ufw fail2ban unattended-upgrades age >/dev/null

ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
echo "Firewall: nur 22, 80 und 443 offen."

# Docker schreibt seine iptables-Regeln VOR die von ufw und umgeht sie damit.
# Solange kein Dienst in der Compose-Datei einen `ports:`-Eintrag hat, fällt das
# nicht auf – wer später einen hinzufügt (etwa 5432 zum „kurz mal draufschauen"),
# stellt ihn ohne diese Regel ungewollt ins offene Netz, und ufw zeigt weiter
# brav an, dass alles zu ist.
cat >/etc/docker/daemon.json.neu <<'ENDE'
{
  "iptables": true,
  "live-restore": true,
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
ENDE
if [ ! -f /etc/docker/daemon.json ] || ! cmp -s /etc/docker/daemon.json.neu /etc/docker/daemon.json; then
	mv /etc/docker/daemon.json.neu /etc/docker/daemon.json
	systemctl restart docker || true
	echo "Docker: Protokolle rotieren, live-restore an."
else
	rm -f /etc/docker/daemon.json.neu
fi

# Container erreichen die Aussenwelt weiterhin; von aussen kommt nur an sie
# heran, was ufw ohnehin durchlässt.
cat >/etc/ufw/after.rules.initiative <<'ENDE'
*filter
:DOCKER-USER - [0:0]
-A DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN
-A DOCKER-USER -i lo -j RETURN
-A DOCKER-USER -p tcp --dport 80 -j RETURN
-A DOCKER-USER -p tcp --dport 443 -j RETURN
-A DOCKER-USER -j DROP
COMMIT
ENDE
if ! grep -q 'DOCKER-USER' /etc/ufw/after.rules; then
	cat /etc/ufw/after.rules.initiative >>/etc/ufw/after.rules
	ufw reload >/dev/null
	echo "Firewall: Docker umgeht sie nicht mehr."
fi
rm -f /etc/ufw/after.rules.initiative

# ---------------------------------------------------------------------------
# 3. fail2ban
# ---------------------------------------------------------------------------
# Nur für SSH. Für die App wäre es das falsche Werkzeug: Die Bremse dort sitzt
# in der API (drossel.rs), kennt Konto und Adresse getrennt und sperrt niemanden
# aus – fail2ban würde stattdessen den ganzen Anschluss dichtmachen, hinter dem
# sich im Zweifel eine ganze Wohnung teilt.
cat >/etc/fail2ban/jail.d/initiative.conf <<'ENDE'
[sshd]
enabled  = true
maxretry = 5
findtime = 10m
bantime  = 1h
ENDE
systemctl enable --now fail2ban >/dev/null 2>&1 || true
echo "fail2ban: SSH überwacht."

# ---------------------------------------------------------------------------
# 4. Sicherheitsupdates von allein
# ---------------------------------------------------------------------------
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'ENDE'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
ENDE
cat >/etc/apt/apt.conf.d/51initiative-unattended <<'ENDE'
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
ENDE
# Automatic-Reboot bleibt aus. Ein Neustart um halb vier morgens ist genau
# dann unangenehm, wenn man ihn nicht mitbekommt – und mit
# Plattenverschlüsselung stünde der Server danach und wartete auf ein Passwort.
systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true
echo "Sicherheitsupdates: laufen von allein, Neustart macht der Mensch."

# ---------------------------------------------------------------------------
# 5. Kernel-Einstellungen
# ---------------------------------------------------------------------------
cat >/etc/sysctl.d/60-initiative.conf <<'ENDE'
# Keine Umleitungen annehmen oder verschicken.
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv6.conf.all.accept_redirects = 0
# Pakete mit gefälschtem Absender verwerfen.
net.ipv4.conf.all.rp_filter = 1
# Gegen SYN-Fluten.
net.ipv4.tcp_syncookies = 1
# Speicherabbilder von setuid-Programmen nicht schreiben.
fs.suid_dumpable = 0
# Kernel-Adressen nicht an unprivilegierte Prozesse verraten.
kernel.kptr_restrict = 2
# Nur der eigene Kindprozess darf angehängt werden.
kernel.yama.ptrace_scope = 1
ENDE
sysctl --system >/dev/null
echo "Kernel: Einstellungen gesetzt."

echo
echo "Fertig. Was jetzt noch von Hand gehört:"
echo "  1. In einem NEUEN Terminal prüfen: ssh $BENUTZER@<server-adresse>"
echo "     Erst wenn das klappt, das alte Fenster schliessen."
echo "  2. Sicherung einrichten (docs/UMZUG.md, Schritt 9)."
echo "  3. age-Schlüssel für die Sicherungen erzeugen – auf deinem Gerät."
