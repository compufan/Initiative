#!/bin/bash
. ./lib.sh
for n in A B C D E; do reg $n; done
G=$(api T_A POST /conversations "{\"type\":\"group\",\"title\":\"Gruppe $S\",\"memberIds\":[\"$I_B\",\"$I_C\",\"$I_D\"]}" | jq -r .id)
ST=$(date -u -d '+2 days' +%Y-%m-%dT%H:%M:%SZ); EN=$(date -u -d '+2 days +1 hour' +%Y-%m-%dT%H:%M:%SZ)
R=$(api T_A POST /calendar/events "{\"title\":\"Grillen $S\",\"startsAt\":\"$ST\",\"endsAt\":\"$EN\",\"location\":\"Wiese 1\",\"attendeeIds\":[\"$I_B\",\"$I_C\",\"$I_D\"],\"zustellung\":{\"senden\":true,\"einzelchats\":true,\"gruppenChatIds\":[\"$G\"]}}")
EID=$(echo "$R" | jq -r .id)
echo "EID=$EID G=$G"
api T_A POST /conversations/$G/members "{\"memberIds\":[\"$I_E\"]}" | jq -c '.id' 
echo "--- E sieht in der Gruppe:"
api T_E GET /conversations/$G/messages | jq -c '[.items[]|select(.type=="event")|{type,metadata,event:(.event|if .==null then null else .title end)}]'
echo "--- E list conv:"
api T_E GET /conversations | jq -c '[.items[]|select(.id=="'$G'")|.lastMessage|{type,metadata,event}]'
echo "--- E by id: $(apic T_E GET /calendar/events/$EID)  ics(unauth): $(curl -s -o /dev/null -w %{http_code} $API/calendar/events/$EID/event.ics)"
echo "--- C wird ausgeladen:"
api T_A PATCH /calendar/events/$EID "{\"attendeeIds\":[\"$I_B\",\"$I_D\"]}" | jq -c '{att:[.attendees[].userId]|length, zustellung}'
echo "C by id: $(apic T_C GET /calendar/events/$EID) ; rsvp: $(apic T_C POST /calendar/events/$EID/rsvp '{"status":"yes"}'); notes: $(apic T_C GET /calendar/events/$EID/notes); ics: $(curl -s -o /dev/null -w %{http_code} $API/calendar/events/$EID/event.ics)"
echo "--- C sieht in Gruppe und Einzelchat:"
api T_C GET /conversations/$G/messages | jq -c '[.items[]|select(.type=="event")|{type,metadata,event:(.event|if .==null then null else .title end)}]'
api T_C GET /conversations | jq -c '[.items[]|select(.type=="direct")|{id,last:(.lastMessage|{type,deleted:(.deletedAt!=null),metadata})}]'
echo "$EID $G $I_A $I_B $I_C $I_D $I_E" > s1b.out
