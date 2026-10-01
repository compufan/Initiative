#!/bin/bash
. ./lib.sh
for n in A B C; do reg $n; done
G=$(api T_A POST /conversations "{\"type\":\"group\",\"title\":\"G11\",\"memberIds\":[\"$I_B\",\"$I_C\"]}" | jq -r .id)
ST=$(date -u -d '+2 days' +%Y-%m-%dT%H:%M:%SZ); EN=$(date -u -d '+2 days +1 hour' +%Y-%m-%dT%H:%M:%SZ)
EID=$(api T_A POST /calendar/events "{\"title\":\"Geheim $S\",\"location\":\"Ort-$S\",\"startsAt\":\"$ST\",\"endsAt\":\"$EN\",\"attendeeIds\":[\"$I_B\",\"$I_C\"],\"zustellung\":{\"senden\":true,\"einzelchats\":true,\"gruppenChatIds\":[\"$G\"]}}" | jq -r .id)
api T_A PATCH /calendar/events/$EID "{\"attendeeIds\":[\"$I_B\"]}" >/dev/null
echo "C: Chatliste Gruppe lastMessage:"; api T_C GET /conversations | jq -c '[.items[]|select(.id=="'$G'")|.lastMessage|{type,metadata,event}]'
echo "C: Nachrichten:"; api T_C GET "/conversations/$G/messages" | jq -c '[.items[]|select(.type=="event")|{metadata,event}]'
echo "C: einzelne Nachricht per ID:"; MID=$(api T_C GET "/conversations/$G/messages" | jq -r '.items[]|select(.type=="event")|.id'); api T_C GET /messages/$MID | jq -c '{metadata,event}'
echo "C: Suche/Pins:"; api T_C GET "/conversations/$G/pins" 2>/dev/null | head -c 200; echo
echo "C: Medien/Suche nach Titel: $(api T_C GET "/search?q=Geheim" | head -c 300)"
