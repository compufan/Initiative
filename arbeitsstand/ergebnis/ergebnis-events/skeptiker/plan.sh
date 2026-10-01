. ./lib2.sh
for n in A B W; do reg $n; done
G=$(api T_A POST /conversations "{\"type\":\"group\",\"title\":\"Gp$S\",\"memberIds\":[\"$I_B\"]}" | jq -r .id)
S1=$(date -u -d '+3 days' +%Y-%m-%dT%H:%M:%SZ); S2=$(date -u -d '+4 days' +%Y-%m-%dT%H:%M:%SZ)
R=$(api T_A POST /calendar/planning "{\"conversationId\":\"$G\",\"title\":\"Wann $S\",\"slots\":[{\"startsAt\":\"$S1\"},{\"startsAt\":\"$S2\"}]}")
EID=$(echo "$R" | jq -r .id); PID=$(echo "$R" | jq -r .pollId)
echo "PATCH attendeeIds +W: $(api T_A PATCH /calendar/events/$EID "{\"attendeeIds\":[\"$I_B\",\"$I_W\"]}" | jq -c '{st:.termin.status, z:.zustellung}')"
CH=$(api T_W GET /conversations | jq -r '.items[]|select(.type=="direct")|.id' | head -1)
echo "W Karte im Einzelchat: $(api T_W GET /conversations/$CH/messages | jq -c '[.items[]|select(.type=="event")|{status:.event.status, pollId:.event.pollId}]')"
OPT=$(api T_B GET /polls/$PID | jq -r '.options[0].id')
echo "W rsvp: $(apic T_W POST /calendar/events/$EID/rsvp '{"status":"yes"}')"
echo "W vote: $(api T_W POST /polls/$PID/vote "{\"votes\":[{\"optionId\":\"$OPT\",\"value\":\"yes\"}]}" | head -c 200)"
echo "W GET polls: $(apic T_W GET /polls/$PID)"
