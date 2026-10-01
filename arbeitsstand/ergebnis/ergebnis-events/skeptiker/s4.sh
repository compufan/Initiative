#!/bin/bash
# Altbestand mit mehr als 200 Teilnehmern (Chat-Mitglieder aus der Migration/dem alten Weg): kann man ausladen?
. ./lib2.sh
reg A; reg B
ST=$(date -u -d '+2 days' +%Y-%m-%dT%H:%M:%SZ); EN=$(date -u -d '+2 days +1 hour' +%Y-%m-%dT%H:%M:%SZ)
EID=$(api T_A POST /calendar/events "{\"title\":\"Alt gross $S\",\"startsAt\":\"$ST\",\"endsAt\":\"$EN\",\"attendeeIds\":[\"$I_B\"]}" | jq -r .id)
psql "$DATABASE_URL" -qtA -c "insert into event_attendees (event_id,user_id,status) select '$EID', id, 'pending' from users where id not in ('$I_A') order by id limit 230 on conflict do nothing"
echo "Teilnehmer: $(psql "$DATABASE_URL" -tA -c "select count(*) from event_attendees where event_id='$EID'")"
echo "ausladen B: $(api T_A DELETE /calendar/events/$EID/attendees/$I_B | head -c 200)"
echo "PATCH nur Zeit (ohne attendeeIds): $(apic T_A PATCH /calendar/events/$EID "{\"location\":\"Neu\"}")"
echo "PATCH zustellung nur Gruppen: $(api T_A PATCH /calendar/events/$EID "{\"zustellung\":{\"gruppenChatIds\":[]}}" | head -c 200)"
echo "$EID" > s4k.out
