#!/bin/bash
. ./lib.sh
reg A; reg B
ST=$(date -u -d '+2 days' +%Y-%m-%dT%H:%M:%SZ); EN=$(date -u -d '+2 days +1 hour' +%Y-%m-%dT%H:%M:%SZ)
python3 - <<PY > body12.json
import json
print(json.dumps({"title":"Gross","location":"x"*1_900_000,"startsAt":"$ST","endsAt":"$EN","attendeeIds":["$I_B"],"zustellung":{"senden":True,"einzelchats":True,"gruppenChatIds":[]}}))
PY
ls -l body12.json | awk '{print $5" Byte Anfrage"}'
curl -s -o r12.json -w "POST: %{http_code}\n" -X POST $API/calendar/events -H "authorization: Bearer $T_A" -H 'content-type: application/json' --data-binary @body12.json
jq -c '{id, loc: (.location|length)}' r12.json 2>/dev/null || head -c 300 r12.json
CH=$(api T_B GET /conversations | jq -r '.items[]|select(.type=="direct")|.id' | head -1)
curl -s -o m12.json -w "B laedt Nachrichten: %{http_code} %{size_download} Byte\n" "$API/conversations/$CH/messages" -H "authorization: Bearer $T_B"
curl -s -o l12.json -w "B laedt Chatliste: %{http_code} %{size_download} Byte\n" "$API/conversations" -H "authorization: Bearer $T_B"
