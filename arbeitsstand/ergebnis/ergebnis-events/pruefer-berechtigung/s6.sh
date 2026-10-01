#!/bin/bash
. ./lib.sh
for n in A B C D; do reg $n; done
# A Ersteller (einfaches Mitglied!), B Admin der Gruppe, C Mitglied, D Mitglied
O=$(api T_B POST /conversations "{\"type\":\"group\",\"title\":\"G6 $S\",\"memberIds\":[\"$I_A\",\"$I_C\",\"$I_D\"]}" | jq -r .id)
echo "Gruppe $O (Besitzer B)"
ST=$(date -u -d '+2 days' +%Y-%m-%dT%H:%M:%SZ); EN=$(date -u -d '+2 days +1 hour' +%Y-%m-%dT%H:%M:%SZ)
EID=$(api T_A POST /calendar/events "{\"title\":\"Rechte $S\",\"startsAt\":\"$ST\",\"endsAt\":\"$EN\",\"attendeeIds\":[\"$I_B\",\"$I_C\",\"$I_D\"],\"zustellung\":{\"senden\":true,\"einzelchats\":true,\"gruppenChatIds\":[\"$O\"]}}" | jq -r .id)
echo "C (Mitglied, eingeladen) PATCH Titel: $(apic T_C PATCH /calendar/events/$EID '{"title":"x"}')"
echo "B (Besitzer, eingeladen) PATCH Ort: $(apic T_B PATCH /calendar/events/$EID '{"location":"bei B"}')"
echo "B PATCH attendeeIds: $(apic T_B PATCH /calendar/events/$EID "{\"attendeeIds\":[\"$I_C\"]}")"
echo "B ausladen C: $(apic T_B DELETE /calendar/events/$EID/attendees/$I_C)"
echo "B zustellung lesen: $(apic T_B GET /calendar/events/$EID/zustellung)"
echo "B nachliefern: $(apic T_B POST /calendar/events/$EID/zustellung/nachliefern)"
echo "B absagen: $(apic T_B PATCH /calendar/events/$EID '{"status":"cancelled"}')"
echo "--- A entfernt B (Besitzer der Gruppe) aus Teilnehmern:"
apic T_A PATCH /calendar/events/$EID "{\"attendeeIds\":[\"$I_C\",\"$I_D\"]}"; echo
echo "B jetzt PATCH Ort: $(apic T_B PATCH /calendar/events/$EID '{"location":"bei B 2"}') ; DELETE: $(apic T_B DELETE /calendar/events/$EID)"
echo "--- A holt B wieder: $(apic T_A PATCH /calendar/events/$EID "{\"attendeeIds\":[\"$I_B\",\"$I_C\",\"$I_D\"]}")"
echo "B sieht Termin: $(apic T_B GET /calendar/events/$EID)"
echo "B DELETE (Besitzer, eingeladen): $(apic T_B DELETE /calendar/events/$EID)"
echo "A GET nach Loeschen: $(apic T_A GET /calendar/events/$EID)"
echo "Karten in O (A sieht): $(api T_A GET /conversations/$O/messages | jq -c '[.items[]|select(.type=="event")|{deleted:(.deletedAt!=null)}]')"
