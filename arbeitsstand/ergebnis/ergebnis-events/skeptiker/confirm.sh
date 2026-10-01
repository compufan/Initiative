#!/bin/bash
. ./lib2.sh
for n in A B C; do reg $n; done
G=$(api T_A POST /conversations "{\"type\":\"group\",\"title\":\"Gc$S\",\"memberIds\":[\"$I_B\",\"$I_C\"]}" | jq -r .id)
S1=$(date -u -d '+3 days' +%Y-%m-%dT%H:%M:%SZ); S2=$(date -u -d '+4 days' +%Y-%m-%dT%H:%M:%SZ)
R=$(api T_A POST /calendar/planning "{\"conversationId\":\"$G\",\"title\":\"Wann $S\",\"slots\":[{\"startsAt\":\"$S1\"},{\"startsAt\":\"$S2\"}]}")
EID=$(echo "$R" | jq -r .id); PID=$(echo "$R" | jq -r .pollId)
echo "Termin $EID Umfrage $PID status $(echo "$R" | jq -r .status)"
OPT=$(api T_B GET /polls/$PID | jq -r '.options[0].id')
echo "B stimmt: $(apic T_B POST /polls/$PID/vote "{\"votes\":[{\"optionId\":\"$OPT\",\"value\":\"yes\"}]}")"
echo "B sieht Termin vor Ausladen: $(apic T_B GET /calendar/events/$EID)"
echo "A ladet B aus: $(apic T_A DELETE /calendar/events/$EID/attendees/$I_B)"
echo "B sieht Termin nach Ausladen: $(apic T_B GET /calendar/events/$EID)"
echo "A bestaetigt: $(apic T_A POST /calendar/events/$EID/confirm "{\"optionId\":\"$OPT\"}")"
echo "B sieht Termin nach Bestaetigen: $(apic T_B GET /calendar/events/$EID)"
echo "Zeile B: $(psql "$DATABASE_URL" -tA -c "select status from event_attendees where event_id='$EID' and user_id='$I_B'")"
