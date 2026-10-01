#!/bin/bash
# Beendet den Vite-Server auf Port $1 (Muster steht nur hier, nicht in der Befehlszeile).
for pid in $(ps -eo pid,args | awk -v p="--port $1" 'index($0, "bin/vite.js") && index($0, p) && !index($0, "awk") {print $1}'); do kill "$pid" 2>/dev/null; done
exit 0
