#!/usr/bin/env bash
# Holt einen bestimmten Stand und startet ihn. Läuft auf dem Server.
#
#   /opt/initiative/deploy.sh <git-sha>
#
# Der Stand wird als feste Kennung gesetzt, nicht als `live`: Nur so ist
# nachvollziehbar, was läuft, und nur so lässt sich zurückrollen.
set -euo pipefail

ZIEL="${1:?Aufruf: deploy.sh <git-sha>}"
cd /opt/initiative

if grep -q '^IMAGE_TAG=' .env; then
	sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=${ZIEL}/" .env
else
	printf 'IMAGE_TAG=%s\n' "${ZIEL}" >>.env
fi

docker compose pull
docker compose up -d --remove-orphans

# Alte Abbilder wegräumen, aber nicht die der letzten Woche – die braucht man
# zum Zurückrollen.
docker image prune -f --filter "until=168h" >/dev/null

echo "Läuft jetzt: ${ZIEL}"
