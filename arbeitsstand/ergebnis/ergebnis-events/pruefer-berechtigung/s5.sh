#!/bin/bash
. ./lib.sh
for n in A B C; do reg $n; done
G=$(api T_A POST /conversations "{\"type\":\"group\",\"title\":\"G5 $S\",\"memberIds\":[\"$I_B\",\"$I_C\"]}" | jq -r .id)
ST=$(date -u -d '+2 days' +%Y-%m-%dT%H:%M:%SZ); EN=$(date -u -d '+2 days +1 hour' +%Y-%m-%dT%H:%M:%SZ)
EID=$(api T_A POST /calendar/events "{\"title\":\"Nachl $S\",\"startsAt\":\"$ST\",\"endsAt\":\"$EN\",\"attendeeIds\":[\"$I_B\",\"$I_C\"],\"zustellung\":{\"senden\":true,\"einzelchats\":false,\"gruppenChatIds\":[]}}" | jq -r .id)
# reservierte Karte ohne Nachricht (simuliert einen Abbruch in Phase 2)
psql "$DATABASE_URL" -qtA -c "insert into event_placements (id,event_id,conversation_id,art,created_by) values (gen_random_uuid(),'$EID','$G','gruppe','$I_A')" 2>&1 | head -3
echo "zustellung vorher: $(api T_A GET /calendar/events/$EID/zustellung | jq -c .)"
for i in 1 2 3; do ( curl -s -X POST $API/calendar/events/$EID/zustellung/nachliefern -H "authorization: Bearer $T_A" | jq -c '.zustellung' > nl$i.out ) & done; wait
cat nl?.out
echo "Karten im Chat (B): $(api T_B GET /conversations/$G/messages | jq '[.items[]|select(.type=="event")]|length')"
psql "$DATABASE_URL" -qtA -c "select count(*) from messages where conversation_id='$G' and type='event'"
