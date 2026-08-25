#!/usr/bin/env bash
# Datenbank und Dateien sichern. Stündlich per systemd-Timer.
#
# Zwei Dinge, die zusammengehören und leicht getrennt vergessen werden:
# die Datenbank UND das Upload-Verzeichnis. Bilder liegen nicht in der
# Datenbank – ein Dump allein rettet die Texte und verliert die Fotos.
set -euo pipefail

cd /opt/initiative
set -a
# shellcheck disable=SC1091
. ./.env
set +a

ZIEL=/var/backups/initiative
mkdir -p "$ZIEL"

# -Fc: eigenes Format, komprimiert, erlaubt selektives Zurückspielen.
docker compose exec -T postgres \
	pg_dump -Fc -U "${POSTGRES_USER:-initiative}" "${POSTGRES_DB:-initiative}" \
	>"$ZIEL/db-$(date +%FT%H).dump"

# Nur die letzten 48 Stunden lokal – der Rest liegt ausser Haus.
find "$ZIEL" -name 'db-*.dump' -mmin +2880 -delete

# Einmal am Tag zusätzlich verschlüsselt ausser Haus. restic verschlüsselt von
# sich aus; das Passwort steht in RESTIC_PASSWORD_FILE.
if [ "${1:-}" = "--auswaerts" ] && [ -n "${RESTIC_REPOSITORY:-}" ]; then
	restic backup "$ZIEL" "${UPLOADS_DIR:-/var/lib/docker/volumes/initiative_uploads/_data}"
	restic forget --keep-hourly 24 --keep-daily 7 --keep-weekly 5 --keep-monthly 12 --prune
fi

# Erst nach dem Erfolg melden. Ein Dienst, der nur bei Erfolg angepingt wird,
# schlägt Alarm, wenn nichts kommt – ein Skript, das still scheitert, nicht.
if [ -n "${HEALTHCHECK_URL:-}" ]; then
	curl -fsS -m 10 "$HEALTHCHECK_URL" >/dev/null || true
fi
