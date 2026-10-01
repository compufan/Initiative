#!/bin/bash
. ./lib2.sh
for n in A B; do reg $n; done
ST=$(date -u -d '+2 days' +%Y-%m-%dT%H:%M:%SZ); EN=$(date -u -d '+2 days +1 hour' +%Y-%m-%dT%H:%M:%SZ)
EID=$(api T_A POST /calendar/events "{\"title\":\"Absage $S\",\"startsAt\":\"$ST\",\"endsAt\":\"$EN\",\"attendeeIds\":[\"$I_B\"],\"zustellung\":{\"senden\":false,\"einzelchats\":false,\"gruppenChatIds\":[]}}" | jq -r .id)
TOK=$(psql "$DATABASE_URL" -tA -c "select calendar_token from users where id='$I_B'")
echo "vor Absage:"; curl -s $API/calendar/$TOK/feed.ics | grep -E "SUMMARY:Absage|STATUS" | head
echo "absagen: $(apic T_A PATCH /calendar/events/$EID '{"status":"cancelled"}')"
echo "nach Absage Feed:"; curl -s $API/calendar/$TOK/feed.ics | grep -E "SUMMARY:Absage|STATUS" | head
echo "event.ics:"; curl -s $API/calendar/events/$EID/event.ics | grep -E "SUMMARY|STATUS"
echo "--- E nicht eingeladen: PATCH/DELETE/zustellung vs unbekannte Kennung"
reg E
echo "E PATCH bekannt: $(apic T_E PATCH /calendar/events/$EID '{"title":"x"}')  unbekannt: $(apic T_E PATCH /calendar/events/00000000-0000-7000-8000-000000000009 '{"title":"x"}')"
echo "E DELETE bekannt: $(apic T_E DELETE /calendar/events/$EID)  unbekannt: $(apic T_E DELETE /calendar/events/00000000-0000-7000-8000-000000000009)"
echo "E GET bekannt: $(apic T_E GET /calendar/events/$EID)  unbekannt: $(apic T_E GET /calendar/events/00000000-0000-7000-8000-000000000009)"
echo "E zustellung bekannt: $(apic T_E GET /calendar/events/$EID/zustellung)"
echo "E collection bekannt: $(apic T_E PATCH /calendar/events/$EID/collection '{"collectionId":null}')"
