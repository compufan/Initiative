#!/bin/bash
#
# Bringt die Sitzung in einen Zustand, in dem Tests und Linter laufen.
#
# Der Anlass: In einer Web-Sitzung wird der Container frisch aufgesetzt, und
# Postgres läuft danach nicht. Die API-Tests und die Browser-Tests brauchen ihn
# aber – und ohne Konsole kommt niemand an `pg_ctlcluster` heran. Genau das
# nimmt dieses Skript ab.
#
# Zwei Dinge sind dabei nicht offensichtlich:
#
#   * `pg_hba.conf` verlangt für Verbindungen über 127.0.0.1 `scram-sha-256`,
#     die Rolle `postgres` hat nach dem Aufsetzen aber kein Passwort. Ohne das
#     Setzen hier scheitert jede TCP-Verbindung mit „password authentication
#     failed" – auch die aus `.env`, die gar kein Passwort mitbringt.
#
#   * Deshalb wird die vollständige Adresse über `$CLAUDE_ENV_FILE` gesetzt.
#     Sie gewinnt gegen die Datei: `playwright.config.ts` mischt
#     `{ ...rootEnv(), ...process.env }`, die Umgebung steht also hinten.
#     So bleibt die `.env` des Containers unangetastet.
#
# Mehrfach ausführbar: Jeder Schritt prüft erst, ob er nötig ist.
set -euo pipefail

# Auf dem eigenen Rechner gilt die Einrichtung des Anwenders, nicht diese hier.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

PASSWORT="initiative"
DATENBANK="initiative"
TESTDATENBANK="initiative_test"

melde() { printf '[start] %s\n' "$1"; }

# ---- Postgres ------------------------------------------------------------

if command -v pg_lsclusters >/dev/null 2>&1; then
  # Die Fassung nicht festschreiben: Das Abbild kann morgen eine andere tragen.
  VERSION="$(pg_lsclusters -h 2>/dev/null | awk 'NR==1 {print $1}')"
  CLUSTER="$(pg_lsclusters -h 2>/dev/null | awk 'NR==1 {print $2}')"

  if [ -n "${VERSION:-}" ] && [ -n "${CLUSTER:-}" ]; then
    if ! pg_isready -q -h 127.0.0.1 -p 5432 2>/dev/null; then
      melde "Postgres $VERSION/$CLUSTER wird gestartet"
      # „Removed stale pid file" ist nach einem harten Neustart normal.
      pg_ctlcluster "$VERSION" "$CLUSTER" start 2>&1 | sed 's/^/[start] /' || true

      # Der Dienst meldet sich nicht sofort bereit.
      for _ in $(seq 1 30); do
        pg_isready -q -h 127.0.0.1 -p 5432 2>/dev/null && break
        sleep 1
      done
    fi

    if pg_isready -q -h 127.0.0.1 -p 5432 2>/dev/null; then
      melde "Postgres ist bereit"
      # Über den Unix-Strumpf als Systembenutzer `postgres` – dort gilt `peer`,
      # es braucht also kein Passwort, um eines zu setzen.
      su postgres -c "psql -tAq -c \"alter role postgres with password '${PASSWORT}';\"" \
        >/dev/null 2>&1 || melde "Passwort konnte nicht gesetzt werden"

      for db in "$DATENBANK" "$TESTDATENBANK"; do
        vorhanden="$(su postgres -c "psql -tAq -c \"select 1 from pg_database where datname = '${db}';\"" 2>/dev/null || true)"
        if [ "$vorhanden" != "1" ]; then
          melde "Datenbank $db wird angelegt"
          su postgres -c "createdb '${db}'" >/dev/null 2>&1 || true
        fi
      done

      ADRESSE="postgres://postgres:${PASSWORT}@127.0.0.1:5432/${DATENBANK}"
      if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
        {
          echo "export DATABASE_URL=\"${ADRESSE}\""
          echo "export TEST_DATABASE_URL=\"${ADRESSE}\""
        } >> "$CLAUDE_ENV_FILE"
        melde "DATABASE_URL gesetzt"
      fi
    else
      melde "Postgres kam nicht hoch – API- und Browser-Tests werden scheitern"
    fi
  fi
else
  melde "Kein Postgres im Abbild – API- und Browser-Tests werden scheitern"
fi

# ---- Node-Abhängigkeiten -------------------------------------------------
#
# Normalerweise sind sie schon da (der Zustand des Containers wird nach diesem
# Skript zwischengespeichert). Der Zweig trägt den Fall, dass ein Abbild ohne
# sie startet.
cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"
if [ ! -d node_modules ]; then
  melde "pnpm install"
  corepack enable >/dev/null 2>&1 || true
  pnpm install --prefer-offline 2>&1 | tail -3 | sed 's/^/[start] /'
fi

melde "bereit"
