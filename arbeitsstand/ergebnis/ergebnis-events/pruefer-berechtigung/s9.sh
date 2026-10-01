#!/bin/bash
. ./lib.sh
for n in S B; do reg $n; done
ST=$(date -u -d '+2 days' +%Y-%m-%dT%H:%M:%SZ); EN=$(date -u -d '+2 days +1 hour' +%Y-%m-%dT%H:%M:%SZ)
echo "S (Fremder, keine gemeinsamen Chats) laedt B ein, mit Einzelchat:"
R=$(api T_S POST /calendar/events "{\"title\":\"Gratis-Angebot $S\",\"description\":\"Klick hier\",\"location\":\"http://example.invalid\",\"startsAt\":\"$ST\",\"endsAt\":\"$EN\",\"attendeeIds\":[\"$I_B\"],\"zustellung\":{\"senden\":true,\"einzelchats\":true,\"gruppenChatIds\":[]}}")
EID=$(echo "$R" | jq -r .id); echo "$R" | jq -c '.zustellung'
echo "B Chatliste: $(api T_B GET /conversations | jq -c '[.items[]|{type,last:(.lastMessage.type)}]')"
echo "B Kalender: $(api T_B GET "/calendar/events?from=2026-01-01T00:00:00Z&to=2027-12-31T00:00:00Z" | jq -c '[.items[].title]|map(select(startswith("Gratis")))')"
echo "B rsvp no: $(apic T_B POST /calendar/events/$EID/rsvp '{"status":"no"}')"
echo "B entfernt sich selbst: $(apic T_B DELETE /calendar/events/$EID/attendees/$I_B)"
echo "B Kalender danach: $(api T_B GET "/calendar/events?from=2026-01-01T00:00:00Z&to=2027-12-31T00:00:00Z" | jq -c '[.items[].title]|map(select(startswith("Gratis")))')"
echo "Wiederholt: S ladet B nochmals ein (ausladen/einladen), 5x -> Einzelchat-Nachrichten bei B:"
for i in 1 2 3 4 5; do api T_S PATCH /calendar/events/$EID "{\"attendeeIds\":[]}" >/dev/null; api T_S PATCH /calendar/events/$EID "{\"attendeeIds\":[\"$I_B\"]}" >/dev/null; done
CH=$(api T_B GET /conversations | jq -r '.items[]|select(.type=="direct")|.id' | head -1)
psql "$DATABASE_URL" -tA -c "select count(*) filter (where deleted_at is null) as sichtbar, count(*) as gesamt from messages where conversation_id='$CH' and type='event'"
