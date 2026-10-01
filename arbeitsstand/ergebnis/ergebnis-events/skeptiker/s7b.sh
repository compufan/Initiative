#!/bin/bash
. ./lib2.sh
reg A; reg X
ST=$(date -u -d '+2 days' +%Y-%m-%dT%H:%M:%SZ); EN=$(date -u -d '+2 days +1 hour' +%Y-%m-%dT%H:%M:%SZ)
EID=$(api T_A POST /calendar/events "{\"title\":\"Race2 $S\",\"startsAt\":\"$ST\",\"endsAt\":\"$EN\",\"attendeeIds\":[\"$I_X\"],\"zustellung\":{\"senden\":false,\"einzelchats\":false,\"gruppenChatIds\":[]}}" | jq -r .id)
rm -f rs.log
for w in 1 2 3 4 5 6 7 8 9 10 11 12; do ( for i in $(seq 1 80); do s=$(date +%s.%N); c=$(curl -s -o /dev/null -w "%{http_code}" -X POST $API/calendar/events/$EID/rsvp -H "authorization: Bearer $T_X" -H 'content-type: application/json' -d '{"status":"yes"}'); e=$(date +%s.%N); echo "$s $e $c" >> rs.log; done ) & done
sleep 0.25
AS=$(date +%s.%N); c=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE $API/calendar/events/$EID/attendees/$I_X -H "authorization: Bearer $T_A"); AE=$(date +%s.%N)
echo "ausladen: $c  start=$AS ende=$AE"
wait
echo "rsvp-Antworten 200, die NACH dem Ende des Ausladens abgeschlossen wurden und VOR dem Ende des Ausladens begonnen haben:"
awk -v ae=$AE '$3==200 && $2>ae && $1<ae {n++} END{print n+0}' rs.log
echo "rsvp 200 gestartet NACH Ende des Ausladens: $(awk -v ae=$AE '$3==200 && $1>ae {n++} END{print n+0}' rs.log)"
echo "Zeile von X in event_attendees: $(psql "$DATABASE_URL" -tA -c "select status from event_attendees where event_id='$EID' and user_id='$I_X'")"
echo "X sieht den Termin: $(apic T_X GET /calendar/events/$EID)"
