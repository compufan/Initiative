#!/bin/bash
# Aufruf: pw.sh <spec-datei in mess/>   (Umgebungsvariablen FAELLE/VARIANTEN/PRE/W werden durchgereicht)
B=/tmp/claude-0/-home-user-Initiative/b3e47b8f-e30a-5e75-8af6-6e58f2fcbe7c/scratchpad
cd $B/wt-blur/apps/web && npx playwright test -c $B/ergebnis-wt-blur/pw-mess.config.ts "$@" 2>&1
