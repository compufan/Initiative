#!/bin/bash
# Startet den Vite-Server eines Baums neu: $1 = Verzeichnis apps/web, $2 = Port
ziel="$1"; port="$2"; log="$3"
for pid in $(ps -eo pid,args | awk -v p="--port $port" 'index($0, "bin/vite.js") && index($0, p) {print $1}'); do kill "$pid"; done
sleep 1
cd "$ziel" && (nohup npx vite --port "$port" --strictPort > "$log" 2>&1 &)
for i in $(seq 1 40); do curl -s -o /dev/null -w "%{http_code}" "http://localhost:$port/" 2>/dev/null | grep -q 200 && exit 0; sleep 1; done
exit 1
