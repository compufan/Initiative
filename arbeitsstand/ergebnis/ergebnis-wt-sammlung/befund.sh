#!/bin/bash
# Messung des Bestands: Was sieht ein Eingeladener von der verknüpften Sammlung?
API=http://localhost:8080/api/v1
S=$(date +%s%N | tail -c 7)
reg() { curl -s -X POST $API/auth/register -H 'content-type: application/json' -d "{\"username\":\"$1$S\",\"password\":\"passwort123\",\"displayName\":\"$2 $S\"}"; }
A=$(reg sama Anna); B=$(reg samb Bodo)
AT=$(echo "$A" | python3 -c 'import sys,json;print(json.load(sys.stdin)["accessToken"])')
BT=$(echo "$B" | python3 -c 'import sys,json;print(json.load(sys.stdin)["accessToken"])')
BID=$(echo "$B" | python3 -c 'import sys,json;print(json.load(sys.stdin)["user"]["id"])')
ah="authorization: Bearer $AT"; bh="authorization: Bearer $BT"; ct='content-type: application/json'
G=$(curl -s -X POST $API/conversations -H "$ah" -H "$ct" -d "{\"type\":\"group\",\"title\":\"Hütte $S\",\"memberIds\":[\"$BID\"]}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
E=$(curl -s -X POST $API/calendar/events -H "$ah" -H "$ct" -d "{\"conversationId\":\"$G\",\"title\":\"Wochenende $S\",\"startsAt\":\"2026-11-10T10:00:00Z\",\"endsAt\":\"2026-11-10T12:00:00Z\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
echo "Termin $E"
echo "--- Anna legt Sammlung ohne Chat an, verknüpft sie"
C=$(curl -s -X POST $API/collections -H "$ah" -H "$ct" -d "{\"name\":\"Bilder $S\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
curl -s -X PATCH $API/calendar/events/$E/collection -H "$ah" -H "$ct" -d "{\"collectionId\":\"$C\"}" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("collectionId am Termin:",d.get("collectionId"))'
echo "--- Bodo (eingeladen): sieht er den Termin? Sammlung?"
curl -s -o /dev/null -w "Termin: %{http_code}\n" $API/calendar/events/$E -H "$bh"
curl -s -w "\nSammlung byId: %{http_code}\n" $API/collections/$C -H "$bh"
curl -s $API/collections -H "$bh" | python3 -c 'import sys,json;print("Bodos Sammlungsliste:",len(json.load(sys.stdin)["items"]))'
echo "--- Anna legt Sammlung MIT Chat (member_level edit) an"
C2=$(curl -s -X POST $API/collections -H "$ah" -H "$ct" -d "{\"name\":\"Chatbilder $S\",\"conversationId\":\"$G\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
curl -s -w "\nBodo byId (Chat-Sammlung): %{http_code}\n" $API/collections/$C2 -H "$bh" | python3 -c 'import sys;t=sys.stdin.read();print(t[-120:])'
echo "--- Anna legt Unterordner unter C an; erbt Bodo?"
curl -s -X POST $API/collections/$C/grants -H "$ah" -H "$ct" -d "{\"userId\":\"$BID\",\"level\":\"view\"}" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("grant:",d.get("level"))'
K=$(curl -s -X POST $API/collections -H "$ah" -H "$ct" -d "{\"name\":\"Unter $S\",\"parentId\":\"$C\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
curl -s $API/collections/$K -H "$bh" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("Bodo sieht Unterordner, myLevel:",d.get("myLevel"))'
echo "--- Tiefe"
P=$C
for i in 2 3 4 5 6 7 8 9; do
  R=$(curl -s -X POST $API/collections -H "$ah" -H "$ct" -d "{\"name\":\"T$i\",\"parentId\":\"$P\"}")
  echo "$R" | python3 -c "import sys,json;d=json.load(sys.stdin);print('Ebene $i:',d.get('id','FEHLER '+json.dumps(d)))"
  P=$(echo "$R" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("id",""))')
  [ -z "$P" ] && break
done
