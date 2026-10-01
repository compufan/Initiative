#!/bin/bash
. ./lib.sh
for n in A B C; do reg $n; done
ST=$(date -u -d '+2 days' +%Y-%m-%dT%H:%M:%SZ); EN=$(date -u -d '+2 days +1 hour' +%Y-%m-%dT%H:%M:%SZ)
EID=$(api T_A POST /calendar/events "{\"title\":\"Fremde Karte $S\",\"startsAt\":\"$ST\",\"endsAt\":\"$EN\",\"attendeeIds\":[\"$I_B\"],\"zustellung\":{\"senden\":false,\"einzelchats\":false,\"gruppenChatIds\":[]}}" | jq -r .id)
G2=$(api T_B POST /conversations "{\"type\":\"group\",\"title\":\"B-Gruppe\",\"memberIds\":[\"$I_C\"]}" | jq -r .id)
echo "vorher: B (Teilnehmer, Besitzer von G2, nicht Ersteller) PATCH: $(apic T_B PATCH /calendar/events/$EID '{"title":"von B"}')"
# Altbestand nachstellen: eine Karte mit fremder Kennung, wie sie der damalige Nachrichtenweg erlaubte (S12)
psql "$DATABASE_URL" -qtA -c "insert into messages (id, conversation_id, sender_id, type, metadata) values (gen_random_uuid(), '$G2', '$I_B', 'event', jsonb_build_object('eventId','$EID'))"
psql "$DATABASE_URL" -qtA -f schritt6.sql
echo "Platzierungen des Termins: $(psql "$DATABASE_URL" -tA -c "select art||' in '||conversation_id from event_placements where event_id='$EID'")"
echo "nachher: B PATCH: $(apic T_B PATCH /calendar/events/$EID '{"title":"von B"}')   B DELETE: $(apic T_B DELETE /calendar/events/$EID)"
echo "A sieht den Termin noch: $(apic T_A GET /calendar/events/$EID)"
