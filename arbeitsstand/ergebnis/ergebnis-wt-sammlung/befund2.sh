#!/bin/bash
# Termin ohne Chat mit attendeeIds: sieht der Eingeladene ihn, der Nicht-Eingeladene nicht?
API=http://localhost:8080/api/v1
S=$(date +%s%N | tail -c 7)
reg() { curl -s -X POST $API/auth/register -H 'content-type: application/json' -d "{\"username\":\"$1$S\",\"password\":\"passwort123\",\"displayName\":\"$2 $S\"}"; }
j() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)"; }
A=$(reg sna Anna); B=$(reg snb Bodo); C=$(reg snc Cleo)
AT=$(echo "$A" | j 'd["accessToken"]'); BT=$(echo "$B" | j 'd["accessToken"]'); CT=$(echo "$C" | j 'd["accessToken"]')
BID=$(echo "$B" | j 'd["user"]["id"]')
ah="authorization: Bearer $AT"; ct='content-type: application/json'
E=$(curl -s -X POST $API/calendar/events -H "$ah" -H "$ct" -d "{\"title\":\"Ohne Chat $S\",\"startsAt\":\"2026-11-10T10:00:00Z\",\"endsAt\":\"2026-11-10T12:00:00Z\",\"attendeeIds\":[\"$BID\"]}")
echo "$E" | j '[a["userId"][:8]+":"+a["status"] for a in d["attendees"]]'
EID=$(echo "$E" | j 'd["id"]')
curl -s -o /dev/null -w "Bodo: %{http_code}\n" $API/calendar/events/$EID -H "authorization: Bearer $BT"
curl -s -o /dev/null -w "Cleo: %{http_code}\n" $API/calendar/events/$EID -H "authorization: Bearer $CT"
# Nicht-Verwalter versucht zu verknüpfen
CO=$(curl -s -X POST $API/collections -H "authorization: Bearer $BT" -H "$ct" -d '{"name":"Bodos"}' | j 'd["id"]')
curl -s -w " -> Bodo verknüpft: %{http_code}\n" -X PATCH $API/calendar/events/$EID/collection -H "authorization: Bearer $BT" -H "$ct" -d "{\"collectionId\":\"$CO\"}"
