#!/bin/bash
. ./lib.sh
for n in A B D; do reg $n; done
G=$(api T_B POST /conversations "{\"type\":\"group\",\"title\":\"G14\",\"memberIds\":[\"$I_D\"]}" | jq -r .id)
ST=$(date -u -d '+2 days' +%Y-%m-%dT%H:%M:%SZ); EN=$(date -u -d '+2 days +1 hour' +%Y-%m-%dT%H:%M:%SZ)
EID=$(api T_A POST /calendar/events "{\"title\":\"Geheimtermin $S\",\"location\":\"Ort $S\",\"startsAt\":\"$ST\",\"endsAt\":\"$EN\",\"attendeeIds\":[\"$I_B\"],\"zustellung\":{\"senden\":false,\"einzelchats\":false,\"gruppenChatIds\":[]}}" | jq -r .id)
# Altbestand: Textnachricht mit Kennung in den Metadaten (der alte Weg erlaubte jeden Typ)
psql "$DATABASE_URL" -qtA -c "insert into messages (id, conversation_id, sender_id, type, body, metadata) values (gen_random_uuid(), '$G', '$I_B', 'text', 'schau mal', jsonb_build_object('eventId','$EID'))"
echo "D (nicht eingeladen, Mitglied von G) liest die Nachrichten:"
api T_D GET /conversations/$G/messages | jq -c '[.items[]|select(.type=="text")|{body,metadata}]'
KENNUNG=$(api T_D GET /conversations/$G/messages | jq -r '.items[]|select(.type=="text")|.metadata.eventId')
echo "D ruft event.ics ohne Anmeldung: $(curl -s $API/calendar/events/$KENNUNG/event.ics | grep -E 'SUMMARY|LOCATION' | tr '\r\n' ' ')"
echo "D GET Termin mit Anmeldung: $(apic T_D GET /calendar/events/$KENNUNG)"
