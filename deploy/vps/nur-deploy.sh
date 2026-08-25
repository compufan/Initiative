#!/usr/bin/env bash
# Der Wächter für den Deploy-Schlüssel von GitHub.
#
# In `authorized_keys` als erzwungener Befehl eingetragen:
#
#   command="/opt/initiative/nur-deploy.sh",restrict ssh-ed25519 AAAA… github-deploy
#
# Damit kann dieser Schlüssel genau eines: eine Version starten. Kein `ls`,
# kein `cat .env`, keine Weiterleitung. Wer in das GitHub-Konto kommt, kommt
# damit immer noch auf den Server – aber nur bis hierher.
#
# # Warum nicht direkt `command="/opt/initiative/deploy.sh $SSH_ORIGINAL_COMMAND"`
#
# Weil die GitHub-Action die **ganze** Befehlszeile schickt, also
# `/opt/initiative/deploy.sh abc1234`. Der erzwungene Befehl würde daraus
# `deploy.sh /opt/initiative/deploy.sh abc1234` machen, und `deploy.sh` nähme
# den Pfad für die Kennung. Der Deploy liefe scheinbar durch und startete ein
# Abbild namens „/opt/initiative/deploy.sh".
#
# Deshalb nimmt dieses Skript nur das letzte Wort und prüft, dass es wirklich
# wie eine Git-Kennung aussieht.
set -euo pipefail

BEFEHL="${SSH_ORIGINAL_COMMAND:-}"

if [ -z "$BEFEHL" ]; then
	echo "Dieser Schlüssel darf keine Sitzung öffnen, nur veröffentlichen." >&2
	exit 1
fi

# Nur das letzte Wort. `deploy.sh abc1234` und `/opt/…/deploy.sh abc1234`
# führen beide zu `abc1234`.
ZIEL="${BEFEHL##* }"

# Erlaubt sind eine Git-Kennung (7 bis 40 Hex-Zeichen) und das Wort `live`.
# Alles andere ist ein Versuch, hier etwas anderes unterzubringen.
case "$ZIEL" in
live) ;;
*[!0-9a-f]*)
	echo "Ungültige Kennung: $ZIEL" >&2
	exit 1
	;;
???????*) ;;
*)
	echo "Kennung zu kurz: $ZIEL" >&2
	exit 1
	;;
esac

if [ "${#ZIEL}" -gt 40 ]; then
	echo "Kennung zu lang: $ZIEL" >&2
	exit 1
fi

exec /opt/initiative/deploy.sh "$ZIEL"
