#!/bin/bash
# Leistung/Teilfehler bei 150 Eingeladenen
. ./lib.sh
reg A
N=${1:-150}
rm -f ids.txt
seq 1 $N | xargs -P4 -I{} sh -c "curl -s -X POST $API/auth/register -H 'content-type: application/json' -d '{\"username\":\"pv{}x$S\",\"password\":\"passwort123\",\"displayName\":\"Pv {} $S\"}' | jq -r '.user.id + \" \" + .accessToken' >> ids.txt"
wc -l ids.txt
IDS=$(awk '{print "\""$1"\""}' ids.txt | paste -sd, )
ST=$(date -u -d '+2 days' +%Y-%m-%dT%H:%M:%SZ); EN=$(date -u -d '+2 days +1 hour' +%Y-%m-%dT%H:%M:%SZ)
T0=$(date +%s.%N)
R=$(api T_A POST /calendar/events "{\"title\":\"Gross $S\",\"startsAt\":\"$ST\",\"endsAt\":\"$EN\",\"attendeeIds\":[$IDS],\"zustellung\":{\"senden\":true,\"einzelchats\":true,\"gruppenChatIds\":[]}}")
T1=$(date +%s.%N)
echo "Anlegen $N: $(echo "$T1 - $T0" | bc) s"
echo "$R" | jq -c '{id, att:(.attendees|length), zustellung}'
EID=$(echo "$R" | jq -r .id)
echo "EID=$EID A=$I_A" > s3.out
# Einzelperson
U1=$(sed -n 1p ids.txt | cut -d' ' -f1); TU1=$(sed -n 1p ids.txt | cut -d' ' -f2)
T0=$(date +%s.%N); curl -s -o /dev/null -w "rsvp %{http_code}\n" -X POST $API/calendar/events/$EID/rsvp -H "authorization: Bearer $TU1" -H 'content-type: application/json' -d '{"status":"yes"}'; T1=$(date +%s.%N); echo "rsvp: $(echo "$T1 - $T0" | bc) s"
T0=$(date +%s.%N); curl -s -o /dev/null -w "ausladen %{http_code}\n" -X DELETE $API/calendar/events/$EID/attendees/$U1 -H "authorization: Bearer $T_A"; T1=$(date +%s.%N); echo "ausladen: $(echo "$T1 - $T0" | bc) s"
T0=$(date +%s.%N); curl -s -o /dev/null -w "delete %{http_code}\n" -X DELETE $API/calendar/events/$EID -H "authorization: Bearer $T_A"; T1=$(date +%s.%N); echo "delete: $(echo "$T1 - $T0" | bc) s"
