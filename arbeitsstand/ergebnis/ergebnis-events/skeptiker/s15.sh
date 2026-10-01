#!/bin/bash
. ./lib2.sh
for n in A B C; do reg $n; done
G=$(api T_B POST /conversations "{\"type\":\"group\",\"title\":\"G15\",\"memberIds\":[\"$I_A\",\"$I_C\"]}" | jq -r .id)
ST=$(date -u -d '+2 days' +%Y-%m-%dT%H:%M:%SZ); EN=$(date -u -d '+2 days +1 hour' +%Y-%m-%dT%H:%M:%SZ)
EID=$(api T_A POST /calendar/events "{\"title\":\"Waise $S\",\"startsAt\":\"$ST\",\"endsAt\":\"$EN\",\"attendeeIds\":[\"$I_B\",\"$I_C\"],\"zustellung\":{\"senden\":true,\"einzelchats\":true,\"gruppenChatIds\":[\"$G\"]}}" | jq -r .id)
echo "B (Besitzer der Gruppe, eingeladen) entfernt C aus der Gruppe: $(apic T_B DELETE /conversations/$G/members/$I_C)"
echo "B ausladen C (Gruppenbesitzer, Teilnehmer): $(apic T_B DELETE /calendar/events/$EID/attendees/$I_C)"
echo "C sieht den Termin trotz Gruppen-Entfernung: $(apic T_C GET /calendar/events/$EID)"
echo "--- Ersteller-Konto geloescht (created_by wird NULL, wie bei DELETE /users/me):"
psql "$DATABASE_URL" -qtA -c "update calendar_events set created_by=null where id='$EID'"
echo "B ausladen C: $(apic T_B DELETE /calendar/events/$EID/attendees/$I_C)  B PATCH attendeeIds: $(apic T_B PATCH /calendar/events/$EID "{\"attendeeIds\":[\"$I_B\"]}")  B PATCH Ort: $(apic T_B PATCH /calendar/events/$EID '{"location":"x"}')"
