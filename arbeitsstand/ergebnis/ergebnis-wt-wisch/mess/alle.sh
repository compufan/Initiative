#!/bin/bash
# Die Messreihe: mehrere Bedingungen nacheinander, je ein Lauf des Messgeräts.
# Aufruf: alle.sh <marke> <gop:sprung>...   (WISCH_MASKE=1 u.a. aus der Umgebung)
cd /tmp/claude-0/-home-user-Initiative/b3e47b8f-e30a-5e75-8af6-6e58f2fcbe7c/scratchpad/ergebnis-wt-wisch/mess
marke="${1:-vorher}"
shift
for bed in "$@"; do
  gop="${bed%%:*}"; sprung="${bed##*:}"
  echo "=== Bedingung GOP $gop Sprung $sprung ==="
  WISCH_MARKE="$marke" WISCH_GOP="$gop" WISCH_SPRUNG="$sprung" timeout 420 npx playwright test -c pw.config.ts --timeout=400000 wischen.spec.ts 2>&1 | grep --line-buffered -E "gop=|Video|Maske|passed|failed|Error|error|Timeout|timeout"
done
echo "=== fertig ==="
