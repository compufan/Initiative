. ./lib2.sh
reg A; reg K
ST=$(date -u -d '+2 days' +%Y-%m-%dT%H:%M:%SZ); EN=$(date -u -d '+2 days +1 hour' +%Y-%m-%dT%H:%M:%SZ)
EID=$(api T_A POST /calendar/events "{\"title\":\"E $S\",\"startsAt\":\"$ST\",\"endsAt\":\"$EN\"}" | jq -r .id)
echo "PATCH einzelchats:false -> $(api T_A PATCH /calendar/events/$EID "{\"attendeeIds\":[\"$I_K\"],\"zustellung\":{\"senden\":true,\"einzelchats\":false}}" | jq -c .zustellung)"
