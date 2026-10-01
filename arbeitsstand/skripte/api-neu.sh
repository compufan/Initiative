#!/bin/bash
# Startet die API aus dem Hauptbaum neu (Port 8080).
for pid in $(ps -eo pid,args | awk 'index($0, "apps/api/target/debug/initiative-api") && !index($0, "awk") {print $1}'); do kill "$pid"; done
sleep 1
cd /home/user/Initiative && (RATE_LIMIT=false nohup ./apps/api/target/debug/initiative-api > "$1" 2>&1 &)
for i in $(seq 1 40); do c=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/api/v1/health 2>/dev/null); [ "$c" != "000" ] && exit 0; sleep 1; done
exit 1
