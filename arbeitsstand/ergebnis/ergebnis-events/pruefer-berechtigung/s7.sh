#!/bin/bash
# TOCTOU: Zusage-Flut des Auszuladenden gegen das Ausladen
. ./lib.sh
reg A; reg X
ST=$(date -u -d '+2 days' +%Y-%m-%dT%H:%M:%SZ); EN=$(date -u -d '+2 days +1 hour' +%Y-%m-%dT%H:%M:%SZ)
EID=$(api T_A POST /calendar/events "{\"title\":\"Race $S\",\"startsAt\":\"$ST\",\"endsAt\":\"$EN\",\"attendeeIds\":[\"$I_X\"],\"zustellung\":{\"senden\":false,\"einzelchats\":false,\"gruppenChatIds\":[]}}" | jq -r .id)
echo "EID=$EID X=$I_X"
# Flut: 8 Schleifen, je 40 Zusagen
for w in 1 2 3 4 5 6 7 8; do ( for i in $(seq 1 60); do curl -s -o /dev/null -X POST $API/calendar/events/$EID/rsvp -H "authorization: Bearer $T_X" -H 'content-type: application/json' -d '{"status":"yes"}'; done ) & done
sleep 0.4
curl -s -o /dev/null -w "ausladen %{http_code}\n" -X DELETE $API/calendar/events/$EID/attendees/$I_X -H "authorization: Bearer $T_A"
wait
echo "X noch Teilnehmer? $(psql "$DATABASE_URL" -tA -c "select count(*) from event_attendees where event_id='$EID' and user_id='$I_X'")"
echo "X GET: $(apic T_X GET /calendar/events/$EID)"
