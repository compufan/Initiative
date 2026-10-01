#!/bin/bash
. ./lib.sh
for n in A B C D; do reg $n; done
G=$(api T_A POST /conversations "{\"type\":\"group\",\"title\":\"Gruppe $S\",\"memberIds\":[\"$I_B\",\"$I_C\"]}" | jq -r .id)
ST=$(date -u -d '+2 days' +%Y-%m-%dT%H:%M:%SZ); EN=$(date -u -d '+2 days +1 hour' +%Y-%m-%dT%H:%M:%SZ)
BODY="{\"title\":\"Parallel $S\",\"startsAt\":\"$ST\",\"endsAt\":\"$EN\",\"attendeeIds\":[\"$I_B\",\"$I_C\",\"$I_D\"],\"zustellung\":{\"senden\":true,\"einzelchats\":true,\"gruppenChatIds\":[\"$G\"]},\"clientId\":\"par$S\"}"
for i in 1 2 3 4 5 6; do
  ( curl -s -w ' %{http_code}\n' -X POST $API/calendar/events -H "authorization: Bearer $T_A" -H 'content-type: application/json' -d "$BODY" | sed 's/^\(.\{0\}\).*\(.\{4\}\)$/\2/' > par$i.out ) &
done
wait
cat par?.out | sort | uniq -c
echo "Events von A mit Titel Parallel: $(api T_A GET "/calendar/events?from=2026-01-01T00:00:00Z&to=2027-12-31T00:00:00Z" | jq '[.items[]|select(.title=="Parallel '$S'")]|length')"
psql "$DATABASE_URL" -tA -c "select count(*) as events from calendar_events where created_by='$I_A'; select count(*) as placements from event_placements p join calendar_events e on e.id=p.event_id where e.created_by='$I_A'; select count(*) as direkt from conversations c join conversation_members m1 on m1.conversation_id=c.id and m1.user_id='$I_A' where c.type='direct'; select count(*) as kartenmsgs from messages m where m.sender_id='$I_A' and m.type='event';"
