#!/bin/bash
. ./lib.sh
for n in A B C D E; do reg $n; done
echo "A=$I_A B=$I_B C=$I_C D=$I_D E=$I_E"
G=$(api T_A POST /conversations "{\"type\":\"group\",\"title\":\"Gruppe $S\",\"memberIds\":[\"$I_B\",\"$I_C\",\"$I_D\"]}" | jq -r .id)
echo "Gruppe $G"
ST=$(date -u -d '+2 days' +%Y-%m-%dT%H:%M:%SZ); EN=$(date -u -d '+2 days +1 hour' +%Y-%m-%dT%H:%M:%SZ)
R=$(api T_A POST /calendar/events "{\"title\":\"Grillen $S\",\"startsAt\":\"$ST\",\"endsAt\":\"$EN\",\"location\":\"Wiese 1\",\"attendeeIds\":[\"$I_B\",\"$I_C\",\"$I_D\"],\"zustellung\":{\"senden\":true,\"einzelchats\":true,\"gruppenChatIds\":[\"$G\"]},\"clientId\":\"k$S\"}")
echo "$R" | jq -c '{id, conversationId, stand, zustellung}'
EID=$(echo "$R" | jq -r .id)
echo "E=$EID" > s1.ids; echo "G=$G" >> s1.ids
# Doppelsenden
R2=$(curl -s -w ' %{http_code}' -X POST $API/calendar/events -H "authorization: Bearer $T_A" -H 'content-type: application/json' -d "{\"title\":\"Grillen $S\",\"startsAt\":\"$ST\",\"endsAt\":\"$EN\",\"attendeeIds\":[\"$I_B\"],\"zustellung\":{\"senden\":true,\"einzelchats\":true,\"gruppenChatIds\":[]},\"clientId\":\"k$S\"}")
echo "Doppelsenden: ${R2: -4} $(echo "${R2% *}" | jq -c '{id, zustellung}')"
# A fuegt E zur Gruppe hinzu
api T_A POST /conversations/$G/members "{\"userIds\":[\"$I_E\"]}" | head -c 300; echo
echo "--- E sieht in der Gruppe:"
api T_E GET /conversations/$G/messages | jq -c '[.items[]|select(.type=="event")|{type,metadata,event:(.event|if .==null then null else .title end)}]'
echo "--- E direkt:"
apic T_E GET /calendar/events/$EID
