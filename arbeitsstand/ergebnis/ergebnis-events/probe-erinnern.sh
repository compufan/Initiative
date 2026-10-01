#!/bin/bash
# Bestandsprobe (nur lesend ausser den Testkonten): Wird etwas fuer die
# Erinnerungen vor dem Termin ausgeliefert? Legt zwei Konten, einen Einzelchat
# und einen Termin mit Erinnerungen an und prueft, was im Chat und im ICS steht.
set -u
API=http://localhost:8080/api/v1
S=$(date +%s)$RANDOM
reg() { curl -s -X POST $API/auth/register -H 'content-type: application/json' -d "{\"username\":\"$1$S\",\"password\":\"passwort123\",\"displayName\":\"$1 $S\"}"; }
A=$(reg an); B=$(reg bo)
TA=$(echo "$A" | jq -r .accessToken); TB=$(echo "$B" | jq -r .accessToken)
IA=$(echo "$A" | jq -r .user.id); IB=$(echo "$B" | jq -r .user.id)
echo "Anna=$IA Bodo=$IB"
CHAT=$(curl -s -X POST $API/conversations -H "authorization: Bearer $TA" -H 'content-type: application/json' -d "{\"type\":\"direct\",\"memberIds\":[\"$IB\"]}" | jq -r .id)
echo "Einzelchat=$CHAT"
START=$(date -u -d '+3 hours' +%Y-%m-%dT%H:%M:%SZ); END=$(date -u -d '+4 hours' +%Y-%m-%dT%H:%M:%SZ)
EV=$(curl -s -X POST $API/calendar/events -H "authorization: Bearer $TA" -H 'content-type: application/json' \
  -d "{\"conversationId\":\"$CHAT\",\"title\":\"Probe\",\"startsAt\":\"$START\",\"endsAt\":\"$END\",\"reminderMinutes\":[10,60,1440]}")
EID=$(echo "$EV" | jq -r .id)
echo "Termin=$EID; Teilnehmer:"; echo "$EV" | jq -c '.attendees[] | {userId, status, respondedAt}'
echo "--- Nachrichten im Einzelchat (Bodo):"
curl -s "$API/conversations/$CHAT/messages" -H "authorization: Bearer $TB" | jq -c '.items[] | {type, senderId, body, metadata}'
echo "--- event.ics (ohne Anmeldung):"
curl -s "$API/calendar/events/$EID/event.ics" | grep -E "BEGIN:VALARM|TRIGGER|SUMMARY|DTSTART|METHOD"
echo "--- Bodo schuldet noch die Antwort; nach 3 s nachsehen, ob der Server von sich aus etwas schreibt:"
sleep 3
curl -s "$API/conversations/$CHAT/messages" -H "authorization: Bearer $TB" | jq -c '[.items[] | .type]'
echo "--- Zusage durch Bodo und Nachrichtenzahl danach:"
curl -s -X POST $API/calendar/events/$EID/rsvp -H "authorization: Bearer $TB" -H 'content-type: application/json' -d '{"status":"yes"}' | jq -c '.attendees[] | {userId, status, respondedAt}'
curl -s "$API/conversations/$CHAT/messages" -H "authorization: Bearer $TB" | jq -c '[.items[] | .type]'
echo "EID=$EID CHAT=$CHAT TA=$TA IA=$IA IB=$IB TB=$TB" > probe-erinnern.ids
