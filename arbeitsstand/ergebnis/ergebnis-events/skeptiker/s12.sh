#!/bin/bash
. ./lib2.sh
reg A; reg B
ST=$(date -u -d '+2 days' +%Y-%m-%dT%H:%M:%SZ); EN=$(date -u -d '+2 days +1 hour' +%Y-%m-%dT%H:%M:%SZ)
python3 - <<PY > b12.json
import json
print(json.dumps({"title":"Gross","location":"x"*1_900_000,"startsAt":"$ST","endsAt":"$EN","attendeeIds":["$I_B"],"zustellung":{"senden":True,"einzelchats":True,"gruppenChatIds":[]}}))
PY
ls -l b12.json | awk '{print $5" Byte Anfrage"}'
curl -s -o rr12.json -w "POST: %{http_code}\n" -X POST $API/calendar/events -H "authorization: Bearer $T_A" -H 'content-type: application/json' --data-binary @b12.json
jq -c '{id, loc: (.location|length)}' rr12.json 2>/dev/null || head -c 300 rr12.json
CH=$(api T_B GET /conversations | jq -r '.items[]|select(.type=="direct")|.id' | head -1)
curl -s -o mm12.json -w "B laedt Nachrichten: %{http_code} %{size_download} Byte\n" "$API/conversations/$CH/messages" -H "authorization: Bearer $T_B"
curl -s -o ll12.json -w "B laedt Chatliste: %{http_code} %{size_download} Byte\n" "$API/conversations" -H "authorization: Bearer $T_B"
