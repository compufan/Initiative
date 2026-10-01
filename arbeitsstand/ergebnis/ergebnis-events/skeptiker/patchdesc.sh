. ./lib2.sh
reg A
ST=$(date -u -d '+2 days' +%Y-%m-%dT%H:%M:%SZ); EN=$(date -u -d '+2 days +1 hour' +%Y-%m-%dT%H:%M:%SZ)
EID=$(api T_A POST /calendar/events "{\"title\":\"P $S\",\"startsAt\":\"$ST\",\"endsAt\":\"$EN\"}" | jq -r .id)
python3 -c "import json;print(json.dumps({'description':'y'*1500000}))" > pd.json
curl -s -o /dev/null -w "PATCH 1.5MB description: %{http_code}\n" -X PATCH $API/calendar/events/$EID -H "authorization: Bearer $T_A" -H 'content-type: application/json' --data-binary @pd.json
echo "POST 4001: $(apic T_A POST /calendar/events "{\"title\":\"P2\",\"description\":\"$(python3 -c "print('z'*4001)")\",\"startsAt\":\"$ST\",\"endsAt\":\"$EN\"}")"
rm pd.json
