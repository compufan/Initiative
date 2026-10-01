#!/bin/bash
. ./lib.sh
for n in A B C; do reg $n; done
G=$(api T_A POST /conversations "{\"type\":\"group\",\"title\":\"G8\",\"memberIds\":[\"$I_B\"]}" | jq -r .id)
D=$(api T_A POST /conversations "{\"type\":\"direct\",\"memberIds\":[\"$I_B\"]}" | jq -r .id)
ST=$(date -u -d '+2 days' +%Y-%m-%dT%H:%M:%SZ); EN=$(date -u -d '+2 days +1 hour' +%Y-%m-%dT%H:%M:%SZ)
base="\"title\":\"F\",\"startsAt\":\"$ST\",\"endsAt\":\"$EN\""
t() { echo "$1 -> $(curl -s -w ' [%{http_code}]' -X POST $API/calendar/events -H "authorization: Bearer $T_A" -H 'content-type: application/json' -d "{$base,$2}" | cut -c1-160)"; }
t "zustellung null + conversationId Gruppe" "\"conversationId\":\"$G\",\"zustellung\":null"
t "Einzelchat als Gruppenziel" "\"zustellung\":{\"gruppenChatIds\":[\"$D\"]}"
t "fremde Gruppe (C nicht Mitglied) durch C" "\"zustellung\":{\"gruppenChatIds\":[\"$G\"]}" 
echo "C: $(curl -s -w ' [%{http_code}]' -X POST $API/calendar/events -H "authorization: Bearer $T_C" -H 'content-type: application/json' -d "{$base,\"zustellung\":{\"gruppenChatIds\":[\"$G\"]}}" | cut -c1-160)"
t "unbekannte Gruppe" "\"zustellung\":{\"gruppenChatIds\":[\"00000000-0000-7000-8000-000000000001\"]}"
t "clientId leer" "\"clientId\":\"\""
t "clientId 65" "\"clientId\":\"$(printf 'x%.0s' $(seq 1 65))\""
t "attendee Ersteller + dup" "\"attendeeIds\":[\"$I_A\",\"$I_B\",\"$I_B\"],\"zustellung\":{}"
t "senden false, Gruppe, Einzel" "\"attendeeIds\":[\"$I_B\"],\"zustellung\":{\"senden\":false,\"gruppenChatIds\":[\"$G\"]}"
t "conversationId nicht in Liste" "\"conversationId\":\"$G\",\"zustellung\":{\"gruppenChatIds\":[]}"
t "alt: conversationId = fremder Chat (C)" "\"conversationId\":\"$G\""
echo "C alt fremd: $(curl -s -w ' [%{http_code}]' -X POST $API/calendar/events -H "authorization: Bearer $T_C" -H 'content-type: application/json' -d "{$base,\"conversationId\":\"$G\"}" | cut -c1-120)"
echo "C alt mit attendeeIds von A,B: $(curl -s -w ' [%{http_code}]' -X POST $API/calendar/events -H "authorization: Bearer $T_C" -H 'content-type: application/json' -d "{$base,\"attendeeIds\":[\"$I_A\",\"$I_B\"]}" | cut -c1-120)"
