#!/usr/bin/env bash
# Zweite Kopie der Kaltablage (Hetzner Storage Box) – inkrementell, geprüft.
#
# Wird von backup.sh gerufen (`--kalt` oder `--auswaerts`), geht aber auch
# allein: `KALT_SICHERUNG_ZIEL=… ./kalt-sicherung.sh`.
#
# # Warum es das braucht
#
# Was `ablage = 'fern'` ist, liegt NUR auf der Box (backup.sh sichert die warme
# Platte und die Datenbank). Hetzner-Snapshots der Box sind die erste
# Empfehlung; diese zweite Kopie ist für den Fall, dass auch die Box samt ihren
# Snapshots verloren geht oder jemand versehentlich im Konto löscht.
#
# # Was kopiert wird
#
# Quelle: die Kaltablage dieser Installation (KALT_TREIBER=sftp: die Box laut
# KALT_SFTP_*, KALT_TREIBER=lokal: KALT_LOKAL_DIR; überschreibbar mit
# KALT_SICHERUNG_QUELLE). Ziel: KALT_SICHERUNG_ZIEL
#
#   /pfad                  ein Verzeichnis (zweite Platte, Einhängepunkt)
#   benutzer@host:pfad     rsync über SSH – etwa eine zweite Storage Box
#                          (Port KALT_SICHERUNG_PORT, Vorgabe 23)
#
# Nur Werkzeuge, die auf Debian/Ubuntu Standard sind: rsync, ssh, sftp, find,
# awk, sha256sum, flock. Die Dateien sind dieselben Bytes wie auf der Box –
# mit MEDIA_KEY also Geheimtext; die Kopie ist ohne den Schlüssel wertlos und
# braucht deshalb keine eigene Verschlüsselung.
#
# # Wie es arbeitet
#
# 1. Beide Seiten auflisten (Name + Grösse). `*.teil` (abgebrochene
#    Übertragungen) gehören nicht dazu.
# 2. Kopieren, was im Ziel fehlt oder eine andere Grösse hat – inkrementell,
#    fortsetzbar (`--partial`). Ziel auf einem anderen Host: Jede Datei läuft
#    über ein Zwischenverzeichnis auf diesem Server (höchstens EINE Datei
#    gleichzeitig, also bis 4 GiB Platz; rsync kann nicht von Host zu Host).
# 3. Aufbewahrung: Was in der Quelle fehlt (gelöscht), bleibt im Ziel noch
#    KALT_SICHERUNG_AUFBEWAHREN_TAGE Tage liegen (Vorgabe 30) – für den Fall,
#    dass eine Nachricht versehentlich gelöscht wurde oder die Quelle kurz
#    leer aussah. Erst danach wird es im Ziel entfernt. Gemerkt wird das in
#    KALT_SICHERUNG_STATE. Ist die Quelle leer oder fehlt mehr als ein Fünftel
#    des Ziels, wird NICHTS gelöscht (die Quelle ist dann eher kaputt als
#    aufgeräumt).
# 4. Prüfung: Danach werden beide Listen noch einmal verglichen (fehlende oder
#    falsch grosse Dateien = Fehler), und eine Stichprobe von
#    KALT_SICHERUNG_STICHPROBE Dateien (Vorgabe 5, je höchstens
#    KALT_SICHERUNG_STICHPROBE_MAX_MB, Vorgabe 256) wird auf beiden Seiten
#    gelesen und per SHA-256 verglichen.
# 5. Fehler sind laut: Meldung auf stderr, Exit-Code ungleich 0 (systemd
#    markiert den Dienst als gescheitert), KALT_SICHERUNG_HEALTHCHECK_URL wird
#    nur bei Erfolg angepingt (bei Fehler `…/fail`).
set -euo pipefail

if [ -f /opt/initiative/.env ] && [ -z "${KALT_SICHERUNG_KEIN_ENV:-}" ]; then
	set -a
	# shellcheck disable=SC1091
	. /opt/initiative/.env
	set +a
fi

ZIEL="${KALT_SICHERUNG_ZIEL:-}"
if [ -z "$ZIEL" ]; then
	echo "KALT_SICHERUNG_ZIEL ist nicht gesetzt – keine zweite Kopie der Kaltablage." >&2
	exit 2
fi

TAGE="${KALT_SICHERUNG_AUFBEWAHREN_TAGE:-30}"
STICHPROBE="${KALT_SICHERUNG_STICHPROBE:-5}"
STICHPROBE_MAX_MB="${KALT_SICHERUNG_STICHPROBE_MAX_MB:-256}"
ZWISCHEN="${KALT_SICHERUNG_ZWISCHEN:-/var/tmp/kalt-sicherung}"
STATE="${KALT_SICHERUNG_STATE:-/var/backups/initiative/kalt-geloescht.tsv}"
PORT="${KALT_SICHERUNG_PORT:-23}"
BANDBREITE="${KALT_SICHERUNG_BANDBREITE_KB:-0}"
JETZT="$(date +%s)"

case "$TAGE$STICHPROBE$STICHPROBE_MAX_MB$BANDBREITE" in
*[!0-9]*)
	echo "KALT_SICHERUNG_AUFBEWAHREN_TAGE, _STICHPROBE, _STICHPROBE_MAX_MB und _BANDBREITE_KB müssen ganze Zahlen sein." >&2
	exit 2
	;;
esac

# --- Quelle bestimmen -------------------------------------------------------
QUELLE="${KALT_SICHERUNG_QUELLE:-}"
QUELLE_SCHLUESSEL="${KALT_SICHERUNG_QUELLE_SCHLUESSEL:-${KALT_SFTP_SCHLUESSEL:-}}"
QUELLE_PORT="${KALT_SFTP_HAFEN:-23}"
if [ -z "$QUELLE" ]; then
	case "${KALT_TREIBER:-aus}" in
	sftp)
		QUELLE="${KALT_SFTP_BENUTZER:?KALT_SFTP_BENUTZER fehlt}@${KALT_SFTP_WIRT:?KALT_SFTP_WIRT fehlt}:${KALT_SFTP_PFAD:-initiative}"
		;;
	lokal) QUELLE="${KALT_LOKAL_DIR:?KALT_LOKAL_DIR fehlt}" ;;
	*)
		echo "KALT_TREIBER ist ${KALT_TREIBER:-aus} – es gibt keine Kaltablage zu sichern." >&2
		exit 2
		;;
	esac
fi
ZIEL_SCHLUESSEL="${KALT_SICHERUNG_SCHLUESSEL:-${KALT_SFTP_SCHLUESSEL:-}}"

# Entfernt (benutzer@host:pfad) oder lokal (/pfad)?
ist_fern() { case "$1" in /* | ./* | ../*) return 1 ;; *:*) return 0 ;; *) return 1 ;; esac; }
host_von() { local h="${1%%:*}"; printf '%s' "$h"; }
pfad_von() { printf '%s' "${1#*:}"; }

for werkzeug in awk find sha256sum flock sort; do
	command -v "$werkzeug" >/dev/null 2>&1 || {
		echo "$werkzeug fehlt." >&2
		exit 2
	}
done
if ist_fern "$QUELLE" || ist_fern "$ZIEL"; then
	for werkzeug in rsync ssh sftp; do
		command -v "$werkzeug" >/dev/null 2>&1 || {
			echo "$werkzeug fehlt (apt install rsync openssh-client)." >&2
			exit 2
		}
	done
fi

ssh_fuer() { # $1 Port, $2 Schlüsseldatei
	local s="ssh -p $1 -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30"
	[ -n "$2" ] && s="$s -i $2"
	printf '%s' "$s"
}
SSH_Q="$(ssh_fuer "$QUELLE_PORT" "$QUELLE_SCHLUESSEL")"
SSH_Z="$(ssh_fuer "$PORT" "$ZIEL_SCHLUESSEL")"
# Unfertiges liegt unter .rsync-partial bzw. mit der Endung $TEIL und zählt in
# keiner Liste: Eine halbe Datei darf nie wie eine ganze aussehen.
TEIL=".kalt-sicherung-teil"
RSYNC_OPT=(-a --partial-dir=.rsync-partial)
[ "$BANDBREITE" -gt 0 ] && RSYNC_OPT+=("--bwlimit=$BANDBREITE")

# --- Arbeitsverzeichnisse, Sperre ------------------------------------------
mkdir -p "$ZWISCHEN" "$(dirname "$STATE")"
chmod 700 "$ZWISCHEN" 2>/dev/null || true
exec 9>"$ZWISCHEN/.sperre"
if ! flock -n 9; then
	echo "Die Kaltablage-Sicherung läuft noch – dieser Aufruf tut nichts."
	exit 0
fi
ARBEIT="$(mktemp -d "$ZWISCHEN/lauf.XXXXXX")"
trap 'rm -rf "$ARBEIT"' EXIT

fehler_melden() {
	echo "FEHLER Kaltablage-Sicherung: $*" >&2
	if [ -n "${KALT_SICHERUNG_HEALTHCHECK_URL:-}" ]; then
		curl -fsS -m 10 "${KALT_SICHERUNG_HEALTHCHECK_URL%/}/fail" >/dev/null 2>&1 || true
	fi
}
trap 'fehler_melden "abgebrochen in Zeile $LINENO"' ERR

# --- Auflisten: "<Grösse>\t<Pfad>", sortiert, ohne *.teil -------------------
auflisten() { # $1 Ort, $2 SSH-Befehl
	if ist_fern "$1"; then
		# --no-h: Grössen ohne Tausenderpunkte. Verzeichnisse und Links fallen weg.
		rsync -r --list-only --no-h -e "$2" "$1/" |
			awk '$1 ~ /^-/ { p = $0; for (i = 1; i <= 4; i++) sub(/^[^ ]+ +/, "", p); print $2 "\t" p }'
	else
		[ -d "$1" ] || {
			echo "Verzeichnis $1 gibt es nicht." >&2
			return 1
		}
		find "$1" -type f -printf '%s\t%P\n'
	fi | awk -F'\t' '$2 !~ /\.teil$/ && $2 !~ /\.kalt-sicherung-teil$/ && $2 !~ /(^|\/)\.rsync-partial\//' | LC_ALL=C sort -t "$(printf '\t')" -k2,2
}

echo "Liste der Quelle …"
auflisten "$QUELLE" "$SSH_Q" >"$ARBEIT/quelle.tsv"
echo "Liste des Ziels …"
if ! ist_fern "$ZIEL"; then mkdir -p "$ZIEL"; fi
auflisten "$ZIEL" "$SSH_Z" >"$ARBEIT/ziel.tsv"
N_QUELLE="$(wc -l <"$ARBEIT/quelle.tsv")"
N_ZIEL="$(wc -l <"$ARBEIT/ziel.tsv")"
echo "Quelle: $N_QUELLE Dateien, Ziel: $N_ZIEL Dateien"

# Was ist im Ziel nicht (oder mit anderer Grösse) vorhanden?
# Zwei Dateien nach Pfad zusammenführen; $1 = Datei A, $2 = Datei B.
fehlend_in() {
	awk -F'\t' 'FILENAME == ARGV[1] { b[$2] = $1; next } !($2 in b) || b[$2] != $1 { print }' "$2" "$1"
}
fehlend_in "$ARBEIT/quelle.tsv" "$ARBEIT/ziel.tsv" >"$ARBEIT/kopieren.tsv"
N_KOPIEREN="$(wc -l <"$ARBEIT/kopieren.tsv")"

# --- Zugriffe auf eine Seite ------------------------------------------------
holen() { # $1 Ort, $2 SSH, $3 Pfad (relativ), $4 lokale Zieldatei
	mkdir -p "$(dirname "$4")"
	if ist_fern "$1"; then
		rsync "${RSYNC_OPT[@]}" -e "$2" "$1/$3" "$4"
	else
		cp -f "$1/$3" "$4$TEIL" && mv -f "$4$TEIL" "$4"
	fi
}
ablegen() { # $1 Ort, $2 SSH, $3 Wurzel (lokal), $4 Pfad (relativ unter der Wurzel)
	if ist_fern "$1"; then
		# -R mit "./": legt die Ordner oberhalb der Datei drüben an, ohne
		# --mkpath (erst ab rsync 3.2.3).
		(cd "$3" && rsync "${RSYNC_OPT[@]}" -R -e "$2" "./$4" "$1/")
	else
		mkdir -p "$(dirname "$1/$4")"
		cp -f "$3/$4" "$1/$4$TEIL" && mv -f "$1/$4$TEIL" "$1/$4"
	fi
}
loeschen_drueben() { # $1 Ort, $2 Pfad (relativ)
	if ist_fern "$1"; then
		printf 'rm "%s/%s"\n' "$(pfad_von "$1")" "$2" |
			sftp -P "$PORT" -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
				${ZIEL_SCHLUESSEL:+-i "$ZIEL_SCHLUESSEL"} -b - "$(host_von "$1")" >/dev/null
	else
		rm -f "$1/$2"
	fi
}

# --- Kopieren ---------------------------------------------------------------
GEKLAPPT=0
FEHLER=0
BYTES=0
if [ "$N_KOPIEREN" -gt 0 ]; then
	echo "$N_KOPIEREN Datei(en) zu kopieren …"
	mkdir -p "$ARBEIT/stage"
	if ist_fern "$ZIEL" && ist_fern "$QUELLE"; then
		# Platz für die grösste einzelne Datei im Zwischenverzeichnis?
		GROESSTE="$(awk -F'\t' '$1 > m { m = $1 } END { print m + 0 }' "$ARBEIT/kopieren.tsv")"
		FREI_KB="$(df -Pk "$ZWISCHEN" | awk 'NR == 2 { print $4 }')"
		if [ "$((FREI_KB * 1024))" -lt "$((GROESSTE + GROESSTE / 10))" ]; then
			echo "Zu wenig Platz in $ZWISCHEN: grösste Datei $GROESSTE Bytes, frei $((FREI_KB / 1024)) MiB." >&2
			exit 1
		fi
	fi
	while IFS=$'\t' read -r groesse pfad; do
		[ -n "$pfad" ] || continue
		if ist_fern "$ZIEL" && ist_fern "$QUELLE"; then
			# Host → dieser Server → Host, eine Datei nach der anderen.
			rm -rf "$ARBEIT/stage"
			mkdir -p "$ARBEIT/stage"
			if holen "$QUELLE" "$SSH_Q" "$pfad" "$ARBEIT/stage/$pfad" &&
				ablegen "$ZIEL" "$SSH_Z" "$ARBEIT/stage" "$pfad"; then
				GEKLAPPT=$((GEKLAPPT + 1))
				BYTES=$((BYTES + groesse))
			else
				echo "Kopieren gescheitert: $pfad" >&2
				FEHLER=$((FEHLER + 1))
			fi
		elif ist_fern "$QUELLE"; then
			# Box → lokales Ziel, direkt.
			if holen "$QUELLE" "$SSH_Q" "$pfad" "$ZIEL/$pfad"; then
				GEKLAPPT=$((GEKLAPPT + 1))
				BYTES=$((BYTES + groesse))
			else
				echo "Kopieren gescheitert: $pfad" >&2
				FEHLER=$((FEHLER + 1))
			fi
		else
			# Lokale Quelle → (fernes oder lokales) Ziel.
			if ablegen "$ZIEL" "$SSH_Z" "$QUELLE" "$pfad"; then
				GEKLAPPT=$((GEKLAPPT + 1))
				BYTES=$((BYTES + groesse))
			else
				echo "Kopieren gescheitert: $pfad" >&2
				FEHLER=$((FEHLER + 1))
			fi
		fi
	done <"$ARBEIT/kopieren.tsv"
fi

# --- Aufbewahrung: Gelöschtes erst nach TAGE Tagen drüben entfernen ----------
GELOESCHT=0
# Pfade, die im Ziel liegen, aber in der Quelle fehlen.
awk -F'\t' 'FILENAME == ARGV[1] { q[$2] = 1; next } !($2 in q) { print $2 }' \
	"$ARBEIT/quelle.tsv" "$ARBEIT/ziel.tsv" >"$ARBEIT/verwaist.txt"
N_VERWAIST="$(wc -l <"$ARBEIT/verwaist.txt")"
touch "$STATE"
# Seit wann fehlt eine Datei? Die erste Sichtung bleibt erhalten, Wiederaufgetauchtes
# fällt heraus (es steht nicht mehr in verwaist.txt), Neues bekommt "jetzt".
awk -F'\t' -v jetzt="$JETZT" 'FILENAME == ARGV[1] { s[$2] = $1; next } { print (($0 in s) ? s[$0] : jetzt) "\t" $0 }' \
	"$STATE" "$ARBEIT/verwaist.txt" >"$ARBEIT/state.neu"

if [ "$N_QUELLE" -eq 0 ] && [ "$N_ZIEL" -gt 0 ]; then
	echo "Die Quelle ist leer, das Ziel nicht – es wird NICHTS gelöscht (Quelle nicht erreichbar oder falscher Pfad?)." >&2
	[ "$N_VERWAIST" -gt 0 ] && FEHLER=$((FEHLER + 1))
elif [ "$N_ZIEL" -gt 0 ] && [ "$((N_VERWAIST * 5))" -gt "$N_ZIEL" ]; then
	echo "$N_VERWAIST von $N_ZIEL Dateien fehlen in der Quelle (mehr als ein Fünftel) – es wird NICHTS gelöscht." >&2
	FEHLER=$((FEHLER + 1))
else
	GRENZE=$((JETZT - TAGE * 86400))
	: >"$ARBEIT/state.bleibt"
	while IFS=$'\t' read -r seit pfad; do
		[ -n "$pfad" ] || continue
		if [ "$seit" -le "$GRENZE" ]; then
			if loeschen_drueben "$ZIEL" "$pfad"; then
				GELOESCHT=$((GELOESCHT + 1))
				continue
			fi
			echo "Entfernen im Ziel gescheitert: $pfad" >&2
			FEHLER=$((FEHLER + 1))
		fi
		printf '%s\t%s\n' "$seit" "$pfad" >>"$ARBEIT/state.bleibt"
	done <"$ARBEIT/state.neu"
	mv -f "$ARBEIT/state.bleibt" "$ARBEIT/state.neu"
fi
cp -f "$ARBEIT/state.neu" "$STATE"
chmod 600 "$STATE" 2>/dev/null || true

# --- Prüfung ----------------------------------------------------------------
echo "Prüfung …"
auflisten "$ZIEL" "$SSH_Z" >"$ARBEIT/ziel2.tsv"
fehlend_in "$ARBEIT/quelle.tsv" "$ARBEIT/ziel2.tsv" >"$ARBEIT/noch_fehlend.tsv"
N_FEHLT="$(wc -l <"$ARBEIT/noch_fehlend.tsv")"
if [ "$N_FEHLT" -gt 0 ]; then
	echo "Nach dem Kopieren fehlen im Ziel $N_FEHLT Datei(en) oder haben die falsche Grösse, z. B.:" >&2
	head -n 5 "$ARBEIT/noch_fehlend.tsv" >&2
	FEHLER=$((FEHLER + 1))
fi

# Stichprobe: Zufällige Dateien bis zur Höchstgrösse auf beiden Seiten lesen.
GEPRUEFT=0
if [ "$STICHPROBE" -gt 0 ]; then
	MAX_BYTES=$((STICHPROBE_MAX_MB * 1024 * 1024))
	awk -F'\t' -v max="$MAX_BYTES" '$1 <= max && $1 > 0 { print $2 }' "$ARBEIT/quelle.tsv" |
		awk 'BEGIN { srand() } { print rand() "\t" $0 }' | sort | head -n "$STICHPROBE" | cut -f2- \
			>"$ARBEIT/stichprobe.txt"
	while IFS= read -r pfad; do
		[ -n "$pfad" ] || continue
		rm -rf "$ARBEIT/pa" "$ARBEIT/pb"
		if holen "$QUELLE" "$SSH_Q" "$pfad" "$ARBEIT/pa/datei" &&
			holen "$ZIEL" "$SSH_Z" "$pfad" "$ARBEIT/pb/datei"; then
			a="$(sha256sum <"$ARBEIT/pa/datei" | cut -d' ' -f1)"
			b="$(sha256sum <"$ARBEIT/pb/datei" | cut -d' ' -f1)"
			if [ "$a" = "$b" ]; then
				GEPRUEFT=$((GEPRUEFT + 1))
			else
				echo "Prüfsumme stimmt nicht: $pfad (Quelle $a, Ziel $b)" >&2
				FEHLER=$((FEHLER + 1))
			fi
		else
			echo "Stichprobe nicht lesbar: $pfad" >&2
			FEHLER=$((FEHLER + 1))
		fi
		rm -rf "$ARBEIT/pa" "$ARBEIT/pb"
	done <"$ARBEIT/stichprobe.txt"
fi

echo "Kaltablage-Sicherung: $GEKLAPPT kopiert ($((BYTES / 1048576)) MiB), $GELOESCHT nach ${TAGE} Tagen im Ziel entfernt, $((N_VERWAIST - GELOESCHT)) in Aufbewahrung, $GEPRUEFT Stichproben (SHA-256) gleich, $FEHLER Fehler."

if [ "$FEHLER" -gt 0 ]; then
	trap - ERR
	fehler_melden "$FEHLER Fehler (siehe oben)"
	exit 1
fi
if [ -n "${KALT_SICHERUNG_HEALTHCHECK_URL:-}" ]; then
	curl -fsS -m 10 "$KALT_SICHERUNG_HEALTHCHECK_URL" >/dev/null || true
fi
