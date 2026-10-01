. ./lib2.sh
for n in A B; do reg $n; done
G=$(api T_A POST /conversations "{\"type\":\"group\",\"title\":\"Gk$S\",\"memberIds\":[\"$I_B\"]}" | jq -r .id)
ST=$(date -u -d '+2 days' +%Y-%m-%dT%H:%M:%SZ); EN=$(date -u -d '+2 days +1 hour' +%Y-%m-%dT%H:%M:%SZ)
R=$(api T_A POST /calendar/events "{\"title\":\"K $S\",\"startsAt\":\"$ST\",\"endsAt\":\"$EN\",\"attendeeIds\":[\"$I_B\"],\"zustellung\":{\"senden\":true,\"einzelchats\":true,\"gruppenChatIds\":[\"$G\"]}}")
EID=$(echo "$R" | jq -r .id)
MID=$(api T_A GET /conversations/$G/messages | jq -r '.items[]|select(.type=="event")|.id')
echo "Karte $MID; loeschen: $(apic T_A DELETE /messages/$MID)"
echo "zustellung danach: $(api T_A GET /calendar/events/$EID/zustellung | jq -c .)"
echo "PATCH gruppenChatIds [G]: $(api T_A PATCH /calendar/events/$EID "{\"zustellung\":{\"gruppenChatIds\":[\"$G\"]}}" | jq -c .zustellung)"
echo "nachliefern: $(api T_A POST /calendar/events/$EID/zustellung/nachliefern | jq -c .zustellung)"
echo "Karten im Chat jetzt (nicht gelöscht): $(psql "$DATABASE_URL" -tA -c "select count(*) filter (where deleted_at is null) from messages where conversation_id='$G' and type='event'")"
echo "Platzierung: $(psql "$DATABASE_URL" -tA -c "select art, message_id is not null from event_placements where event_id='$EID' and art='gruppe'")"
