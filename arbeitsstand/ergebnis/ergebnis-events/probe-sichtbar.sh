#!/bin/bash
# Probe 2: Wer darf einen Termin sehen/beantworten, der an EINEN Chat gebunden ist,
# wenn er eingeladen, aber nicht Mitglied dieses Chats ist? Und: zeigt eine Karte
# mit fremder eventId den Termin einem Fremden?
set -u
API=http://localhost:8080/api/v1
. ./probe-erinnern.ids
S=$(date +%s)$RANDOM
C=$(curl -s -X POST $API/auth/register -H 'content-type: application/json' -d "{\"username\":\"ca$S\",\"password\":\"passwort123\",\"displayName\":\"Carl $S\"}")
TC=$(echo "$C" | jq -r .accessToken); IC=$(echo "$C" | jq -r .user.id)
echo "Carl=$IC (kein Mitglied des Einzelchats $CHAT)"
echo "--- Anna laedt Carl ein (PATCH attendeeIds):"
curl -s -X PATCH $API/calendar/events/$EID -H "authorization: Bearer $TA" -H 'content-type: application/json' -d "{\"attendeeIds\":[\"$IB\",\"$IC\"]}" | jq -c '[.attendees[] | {userId, status}]'
echo "--- Nachrichten im Einzelchat nach dem Einladen (kommt eine neue Karte/Benachrichtigung?):"
curl -s "$API/conversations/$CHAT/messages" -H "authorization: Bearer $TA" | jq -c '[.items[] | .type]'
echo "--- Carl: Liste, Einzelabruf, Zusage:"
curl -s "$API/calendar/events?from=2026-01-01T00:00:00Z&to=2027-12-31T00:00:00Z" -H "authorization: Bearer $TC" | jq -c '[.items[] | .title]'
curl -s -o /dev/null -w "GET by id: %{http_code}\n" $API/calendar/events/$EID -H "authorization: Bearer $TC"
curl -s -w "\nPOST rsvp: %{http_code}\n" -X POST $API/calendar/events/$EID/rsvp -H "authorization: Bearer $TC" -H 'content-type: application/json' -d '{"status":"yes"}'
echo "--- Carl legt einen Chat mit sich und Anna an und postet eine Karte mit fremder eventId:"
C2=$(curl -s -X POST $API/conversations -H "authorization: Bearer $TC" -H 'content-type: application/json' -d "{\"type\":\"direct\",\"memberIds\":[\"$IA\"]}" | jq -r .id)
echo "(Probe ohne Einladung: Dritter ohne jede Beziehung)"
D=$(curl -s -X POST $API/auth/register -H 'content-type: application/json' -d "{\"username\":\"di$S\",\"password\":\"passwort123\",\"displayName\":\"Dora $S\"}")
TD=$(echo "$D" | jq -r .accessToken); ID=$(echo "$D" | jq -r .user.id)
C3=$(curl -s -X POST $API/conversations -H "authorization: Bearer $TD" -H 'content-type: application/json' -d "{\"type\":\"direct\",\"memberIds\":[\"$IC\"]}" | jq -r .id)
curl -s -X POST $API/conversations/$C3/messages -H "authorization: Bearer $TD" -H 'content-type: application/json' -d "{\"type\":\"event\",\"metadata\":{\"eventId\":\"$EID\"}}" | jq -c '{type, event: (.event | {title, attendees: (.attendees|length), createdBy})}'
