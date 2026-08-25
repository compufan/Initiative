#!/usr/bin/env bash
# Datenbank und Dateien sichern. Stündlich per systemd-Timer.
#
# Zwei Dinge, die zusammengehören und leicht getrennt vergessen werden:
# die Datenbank UND das Upload-Verzeichnis. Bilder liegen nicht in der
# Datenbank – ein Dump allein rettet die Texte und verliert die Fotos.
#
# # Was hier verschlüsselt ist und was nicht
#
# Die **Dateien** sind es schon, bevor sie hier ankommen: Die API legt sie
# verschlüsselt ab (MEDIA_KEY, siehe storage/tresor.rs). Eine Sicherung des
# Upload-Ordners enthält also von sich aus nichts Lesbares.
#
# Der **Datenbank-Abzug** dagegen ist blanker Klartext – Nachrichten, Namen,
# Termine, alles. Genau deshalb wird er hier mit einem öffentlichen
# age-Schlüssel verschlüsselt: Der Server kann Sicherungen schreiben, aber
# keine einzige lesen. Der private Schlüssel liegt beim Betreiber und nie auf
# der Maschine.
#
# Der MEDIA_KEY wird bewusst NICHT mitgesichert. Er liegt in der `.env`, und
# die bleibt draussen – sonst läge der Schlüssel neben dem, was er schützt.
set -euo pipefail

cd /opt/initiative
set -a
# shellcheck disable=SC1091
. ./.env
set +a

ZIEL=/var/backups/initiative
mkdir -p "$ZIEL"
# Auch der Ordner selbst geht niemanden etwas an.
chmod 700 "$ZIEL"

STEMPEL="$(date +%FT%H)"

# -Fc: eigenes Format, komprimiert, erlaubt selektives Zurückspielen.
#
# Die Pipe ist Absicht: Ohne sie läge der Klartext zwischendurch auf der
# Platte, und genau der soll dort nie stehen – auch nicht für zwei Sekunden,
# auch nicht in einem Block, den `rm` freigibt, aber nicht überschreibt.
if [ -n "${BACKUP_PUBKEY:-}" ]; then
	if ! command -v age >/dev/null 2>&1; then
		echo "age ist nicht installiert, BACKUP_PUBKEY ist aber gesetzt." >&2
		echo "Entweder installieren (apt install age) oder BACKUP_PUBKEY leeren." >&2
		echo "Ein stiller Klartext-Abzug wäre das Gegenteil dessen, was gemeint war." >&2
		exit 1
	fi
	docker compose exec -T postgres \
		pg_dump -Fc -U "${POSTGRES_USER:-initiative}" "${POSTGRES_DB:-initiative}" |
		age -r "$BACKUP_PUBKEY" -o "$ZIEL/db-$STEMPEL.dump.age"
	chmod 600 "$ZIEL/db-$STEMPEL.dump.age"
else
	docker compose exec -T postgres \
		pg_dump -Fc -U "${POSTGRES_USER:-initiative}" "${POSTGRES_DB:-initiative}" \
		>"$ZIEL/db-$STEMPEL.dump"
	chmod 600 "$ZIEL/db-$STEMPEL.dump"
fi

# Nur die letzten 48 Stunden lokal – der Rest liegt ausser Haus.
find "$ZIEL" -name 'db-*.dump' -mmin +2880 -delete
find "$ZIEL" -name 'db-*.dump.age' -mmin +2880 -delete

# Einmal am Tag zusätzlich verschlüsselt ausser Haus. restic verschlüsselt von
# sich aus; das Passwort steht in RESTIC_PASSWORD_FILE. Dass die Abzüge dann
# doppelt verschlüsselt sind, ist kein Versehen: Die beiden Schichten schützen
# zwei verschiedene Orte – die Platte hier und das Ziel dort.
if [ "${1:-}" = "--auswaerts" ] && [ -n "${RESTIC_REPOSITORY:-}" ]; then
	restic backup "$ZIEL" "${UPLOADS_DIR:-/var/lib/docker/volumes/initiative_uploads/_data}"
	restic forget --keep-hourly 24 --keep-daily 7 --keep-weekly 5 --keep-monthly 12 --prune
fi

# Erst nach dem Erfolg melden. Ein Dienst, der nur bei Erfolg angepingt wird,
# schlägt Alarm, wenn nichts kommt – ein Skript, das still scheitert, nicht.
if [ -n "${HEALTHCHECK_URL:-}" ]; then
	curl -fsS -m 10 "$HEALTHCHECK_URL" >/dev/null || true
fi
