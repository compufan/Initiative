. ./lib2.sh
reg A; reg B
ST=$(date -u -d '+2 days' +%Y-%m-%dT%H:%M:%SZ); EN=$(date -u -d '+2 days +1 hour' +%Y-%m-%dT%H:%M:%SZ)
EID=$(api T_A POST /calendar/events "{\"title\":\"Abs $S\",\"startsAt\":\"$ST\",\"endsAt\":\"$EN\",\"attendeeIds\":[\"$I_B\"],\"zustellung\":{\"senden\":false,\"einzelchats\":false,\"gruppenChatIds\":[]}}" | jq -r .id)
for i in $(seq 1 15); do a=$(apic T_A PATCH /calendar/events/$EID '{"status":"cancelled"}'); b=$(apic T_A PATCH /calendar/events/$EID '{"status":"confirmed"}'); echo -n "$a/$b "; done; echo
