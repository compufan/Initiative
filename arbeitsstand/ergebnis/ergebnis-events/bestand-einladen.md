# Bestand „Einladen“ (Termine) – Stand d786eab

Geprüft durch Lesen UND Ausführen (API auf Port 8080, Dev-Server auf 5183, keine Produktivdatei geändert).

- Lauf gegen die API: `einladen-bestand.mjs` (Ausgabe: `einladen-bestand-lauf.txt` / `.json`)
- Lauf im Browser: `einladen-bestand.spec.ts` (Ausgabe: `browser-editor.json`, `browser-karten.json`)

## Kurzfassung

Vom Wunsch ist **nichts** vollständig umgesetzt. Was der Anwender mit „beides ist eventuell schon umgesetzt“ meint, stimmt nur so weit:

- Gruppenchat-Karte: ja, aber nur in **einem** Chat, und der Server lädt dann **immer alle** Mitglieder dieses Chats ein.
- Karten in Einzelchats: nein, nirgends.
- Synchron: auf der Datenseite ja (eine Tabelle `event_attendees`, ein Rundruf `event.updated`), auf der Kartenseite **nein**: Eine Karte in einem gerade nicht geöffneten Chat bleibt bis zum Neuladen auf dem alten Stand (Browserlauf).

Dazu kommen drei Fehler im Bestand, die den Entwurf unmittelbar betreffen (Abschnitt „Fehler im Bestand“): Nicht-Mitglieder des Termin-Chats können ihren Termin weder öffnen noch zusagen; wer abgewählt wird und im Chat sitzt, bleibt faktisch eingeladen; jedes Chatmitglied kann jeden Termin in eine Karte legen.

## Anforderung → erfüllt? → Beleg

| # | Anforderung | erfüllt? | Beleg |
|---|---|---|---|
| a1 | Liste aller verfügbaren Personen steht immer unter dem Feld, auch ohne Suche | **nein** | `PersonenWahl.tsx:35` zeigt nur `vorschlaege`; im Editor sind das Chatmitglieder + bereits Eingeladene (`EventEditor.tsx:156-199`). Browserlauf: ohne Chat 0 Zeilen, „0 Personen“; mit Chat nur dessen 3 Mitglieder, ein Kontakt aus einem Einzelchat (D) fehlt. Suche erst ab 2 Zeichen (`PersonenWahl.tsx:87`), `GET /users?q=` liefert bei leerem Begriff `[]` (`modules/users.rs:44-46`). |
| a2 | Suche filtert nur, statt zu ersetzen | teilweise | Die Suche **ergänzt** (Treffer von überall kommen dazu, `PersonenWahl.tsx:185-190`); sie filtert die Vorschläge nicht. |
| b1 | Schnellwahl „Alle“ | teilweise | Nur „Alle auswählen / Auswahl leeren“ für die *gerade sichtbaren* Zeilen (`PersonenWahl.tsx:217-223`). Es gibt keinen Begriff „alle verfügbaren Personen“, weil es die Liste (a1) nicht gibt. |
| b2 | Schnellwahl „Niemand“ | nein | Leere Auswahl heisst im Editor „alle aus dem Chat“: `attendeeIds` wird nur mitgeschickt, wenn nicht leer (`EventEditor.tsx:298-300`). „Niemand“ ist mit dieser Bedeutung nicht ausdrückbar. |
| b3 | Schnellwahl „Gruppenchat …“ (Mitglieder wählen, einzelne abwählbar) | **nein** | Die Chatwahl (`EventEditor.tsx:601-625`, nur beim Anlegen) **bindet** den Termin an den Chat, sie wählt keine Personen. Das Abwählen wirkt dort nicht: Der Server nimmt beim Anlegen immer alle Chatmitglieder dazu (`services/calendar.rs:197-201`; Lauf S3: `attendeeIds=[B]` → C ist trotzdem eingeladen). Der Zähler lügt dazu: „1 Person“, obwohl der Hinweistext „Alle aus dem Chat sind eingeladen“ sagt (Browserlauf). |
| b4 | Abwählen einzelner Mitglieder wirkt | **nein** | Beim Ändern löscht der Server die Teilnehmerzeile (`modules/calendar.rs:342-352`), aber Chatmitglieder sehen und beantworten den Termin weiter, und die Zusage trägt sie wieder ein (Lauf S9: B nach Abwahl Liste/Detail 200, Zusage 200, wieder Teilnehmer). Grund: Sichtbarkeit = Teilnehmerzeile **oder** Chatmitgliedschaft (`modules/calendar.rs:189-210`, `services/calendar.rs:115-127`). |
| c1 | Alle Mitglieder eines Gruppenchats eingeladen → Karte im Gruppenchat | teilweise | Ja, genau diese eine (`services/calendar.rs:258-276`, `announce` = Vorgabe „an“ bei Chat). Keine Unterscheidung „alle/nicht alle“. |
| c2 | … UND in den Einzelchats mit den einzelnen Personen | **nein** | Es gibt keinen Code, der Einzelchats findet oder anlegt. Lauf S1/S2/S6: Karte nur im Chat des Termins. Einzelchat-Anlegen steckt im HTTP-Handler (`modules/conversations.rs:86-203`), `find_direct_conversation` (`services/conversations.rs:397-416`) wird nur dort benutzt. |
| c3 | Sonst (nicht alle) nur in den Einzelchats | **nein** | Ohne Chat: keine Karte, auch nicht mit `announce=true` (Lauf S4). Nachträgliches Einladen: weder Karte noch Benachrichtigung, der Eingeladene bekommt nur `event.updated` (Lauf S7c). |
| c4 | Einladungen in verschiedenen Chats synchron (Zusage überall, alle Karten aktualisiert) | teilweise | Daten: ja (`event_attendees`, ein Status je Person; Lauf S8: Zusage über den Termin, beide Karten beim Laden identisch). Echtzeit: nur `event.updated` (`services/calendar.rs:284-294`), kein `message.updated`. Nur **gemountete** `EventBubble` folgen (`useCalendarEvents.ts:134-144`). Browserlauf: Karte im verlassenen Chat zeigt nach Rückkehr „1 zugesagt“, Stand „0 zugesagt · 1 abgesagt“; erst Neuladen korrigiert. Zwei Karten zu einem Termin sind nur über den rohen Nachrichtenweg möglich (Lauf S8). |
| c5 | Eine Einladung = eine Benachrichtigung (nicht zwei) | offen (nicht ausführbar, Push im Dev-Server aus) | Aus dem Code: jede Karte ist eine eigene Nachricht, `create_message` ruft für jede `notify_new_message` (`services/messages.rs:359-361`), Kennzeichen `conversation:<Chat>` (`notify.rs:123,139`). Zwei Karten → zwei Benachrichtigungen für dieselbe Person. |

## Was der Lauf gezeigt hat (Antworten auf die Fragen)

Nutzer A (Ersteller), B, C; Gruppe G = {A, B, C}; Einzelchats AB, AC, BC, AD; D ist **nicht** in G.

| Szenario | Eingabe | Teilnehmer danach | Karte (Nachricht) in | Sicht (Liste / Detail / Notizen) |
|---|---|---|---|---|
| S1 | Chat G, ohne `attendeeIds` | A yes, B, C pending | nur G | A, B, C: ja/200/200; D: nein/403/404 |
| S2 | Chat G + `[D]` | + D | nur G | D: **Liste ja, Detail 403, Zusage 403**, Notizen 200; D bekommt nur `event.updated` |
| S3 | Chat G + `[B]` | wie S1 (C trotzdem!) | nur G | wie S1 |
| S4 | kein Chat, `[B, C]`, `announce=true` | A, B, C | **keine** | B, C: 200 |
| S5 | kein Chat, niemand | nur A | keine | B, C, D: 403/404 |
| S6 | Chat AB + `[C, D]` | A, B, C, D | nur AB | C, D: Liste ja, **Detail 403, Zusage 403** |
| S7 | Chat G, `announce=false` | A, B, C | keine | wie S1 |
| S7b | Zusage durch D (Chat G), C und D (Chat AB) | – | – | alle drei: 403 „Du bist kein Mitglied dieses Chats“ |
| S7c | nachträglich D einladen (PATCH) | + D | keine neue | D: nur `event.updated`, keine Nachricht |
| S8 | zweite Karte in AB per `POST /messages` (`type=event`) | – | G und AB | `message.new` an A, B; `calendar_events.message_id` bleibt auf der ersten Karte; Zusage von B: `event.updated` an A, B, C, **kein** `message.updated`; beide Karten frisch geladen identisch |
| S9 | Chat-Termin: A setzt `attendeeIds=[A]` | nur A | – | B, C: Liste/Detail/Notizen weiter 200; B sagt zu → wieder Teilnehmer |
| S10 | Termin ohne Chat: `DELETE attendees/B` | A, C | – | B: 403/404; B erfährt nichts (kein Ereignis) |
| S11 | Gruppe G2 {A,B}, Termin, danach C als Mitglied | A, B | – | C: Liste ja, Detail 200, Notizen 200 – obwohl die Karte im Verlauf für C nicht sichtbar ist (`sieht_ab`) und C nicht Teilnehmer ist |
| S12 | D legt die Kennung eines fremden Termins (nur A) in eine Karte in AD | – | AD | Direktabruf 403, aber die Karte liefert Titel, Teilnehmer usw. (`EventExpander` prüft den Betrachter nicht: `services/calendar.rs:305-309`, `_viewer_id`) |
| S13 | Termin löschen | – | Karten **bleiben** | `event.deleted` an alle Teilnehmer; die Nachrichten sind nicht gelöscht, tragen aber keinen Termin mehr („Termin nicht verfügbar“) |

Nachrichten je Chat: siehe Spalte „Karte in“ – es entsteht höchstens **eine** Nachricht pro Termin und nur im Chat `conversationId`. Wer sieht den Termin, wenn Chatmitglieder nicht eingeladen sind: heute gibt es diesen Zustand beim Anlegen nicht (alle Mitglieder werden eingeladen); durch Abwählen (S9) und späteren Beitritt (S11) entsteht er, und die Mitglieder sehen den Termin trotzdem.

## Fehler im Bestand (Entwurf muss sie mitlösen)

1. **Nicht-Mitglieder kommen nicht an „ihren“ Termin.** `assert_visible` (`modules/calendar.rs:189-210`) kehrt im Chat-Zweig vorzeitig zurück (`assert_membership(...)?; return Ok(())`), der Teilnehmer-Zweig darunter wird für Termine mit Chat nie erreicht. Folge: Detail, Zusage (`rsvp`, Zeile 432) und Ereignis-Abruf sind für Eingeladene von ausserhalb des Chats 403 (S2, S6, S7b). Der Editor verspricht das Gegenteil („auch jemand von ausserhalb“, `EventEditor.tsx:651`), `polls.rs:405` und `confirm_event` (`modules/calendar.rs:1570-1577`) erzeugen genau solche Teilnehmer (Abstimmende aus Einzelchats). Ein Mitarbeiter am Thema „Erinnern“ hat dasselbe unabhängig gefunden (`probe-sichtbar.ausgabe`).
2. **`EventExpander` prüft den Betrachter nicht** und `send_message` lässt `type=event` mit beliebiger `eventId` zu (`modules/messages.rs:159`, Lauf S12). Wer eine Termin-Kennung kennt, bekommt Titel, Beschreibung, Ort, Teilnehmerliste, Sammlung, Umfrage. Weitere Karten für dieselbe Einladung dürfen nicht über diesen Weg entstehen; der Server muss Karten selbst anlegen und den Nachrichtenweg für `event` schliessen oder den Betrachter im Expander prüfen.
3. **Sichtbarkeit = Teilnehmer ODER Chatmitglied.** Damit kann kein Termin „nur für die Gewählten“ sein, und spätere Mitglieder sehen alte Termine samt Notizen und Unterlagen (S11; beabsichtigt laut Kommentar in `services/events.rs:43-44`, aber mit dem Wunsch „einzelne abwählen“ unvereinbar).

## Erkenntnisse, die den Entwurf prägen

1. **Ein Termin ist heute an EINEN Chat gebunden.** `calendar_events.conversation_id` (`0001_init.sql:188`, `on delete cascade`) und `message_id` (`:190`) sind je eine Spalte. Es gibt genau eine Karte. `conversation_id` wirkt an vier Stellen: Teilnehmer beim Anlegen (`services/calendar.rs:197-201`), Sichtbarkeit (`assert_visible`, `load_events_for_user`, `is_attendee`), Bearbeitungsrecht (`assert_editable`: Chat-Admins dürfen mit, `modules/calendar.rs:212-229`), Rundruf (`broadcast_event`, `remove`). Der Wunsch verlangt N Karten und eine Teilnehmerliste, die nicht aus dem Chat abgeleitet wird.
2. **Die Auswahl kann heute nur erweitern** (`services/calendar.rs:197-201`; Lauf S3). Damit „Gruppe wählen, dann einzelne abwählen“ wirkt, muss die Teilnehmerliste die einzige Quelle der Wahrheit werden: nur Teilnehmerzeile (plus Ersteller) gibt Sicht und Antwortrecht. Der Chat liefert nur Vorschläge und den Ort der Karte. Altbestand: bestehende Chat-Termine behalten ihre Mitglieder nur, wenn eine Wanderung die Teilnehmerzeilen für aktuelle Chatmitglieder nachträgt (Entscheidung: rückwirkend ja, sonst verlieren Altmitglieder den Zugang).
3. **„Alle Mitglieder des Gruppenchats eingeladen“ ist zu berechnen, nicht zu speichern.** Die Gruppenkarte kommt genau dann, wenn die Teilnehmerzeilen alle Mitglieder des gewählten Gruppenchats enthalten; es bleibt die Frage, was bei späterem Beitritt/Austritt oder Abwahl geschieht (Karte bleibt, Teilnehmer ändern sich nicht automatisch). Einfachster Weg: zur Anlegezeit entscheiden und dann nur noch über die Teilnehmerliste arbeiten; Karten gehören zu einer Platzierung.
4. **Vorbild liegt im Haus: Umfragen.** `poll_placements` (`0005_events.sql:16-29`: Umfrage, Chat, Nachricht, eindeutig je Umfrage+Chat), `place_poll` (`services/polls.rs:508-548`), `unplace_poll` (`:550`, löscht die Nachricht), `broadcast_poll` (`:332-359`, spielt **jede** Karte neu aus). Ein `event_placements` (Migration 0023) wäre das Gegenstück. Unterschied: Bei Umfragen folgt der Empfängerkreis aus der Kartensichtbarkeit (`sichtbar_fuer`, `:439`ff.), bei Terminen soll er aus der Teilnehmerliste folgen; eine Karte nützt nur Teilnehmern.
5. **Einzelchats muss der Server finden oder anlegen.** Die Anlegelogik (Transaktion, `sieht_ab = now()`, `broadcast_conversation`) steckt im Handler `modules/conversations.rs:86-203`; dort ist auch die Grenze „Direktchats brauchen genau ein Gegenüber“. Sie muss zu einer Dienstfunktion werden (Finden: `find_direct_conversation` existiert), damit der Termin-Dienst sie benutzen kann. Nebenwirkung, die bewusst sein muss: Wer jemanden einlädt, mit dem er nur in Gruppen schreibt, legt damit einen Einzelchat an, der beim Gegenüber in der Liste erscheint. Die Suche über `GET /users` zeigt jeden Nutzer des Servers (Verzeichnis, gedrosselt 60/Minute, `drossel.rs:289`), ein Einzelchat mit Fremden wäre ein neuer Kanal – „verfügbar“ sollte deshalb **Kontakte** heissen (siehe 8).
6. **Benachrichtigungen: zwei Karten → zwei Pushes.** `NewMessage::entity` setzt `silent: false` fest (`services/messages.rs:262`), `create_message` benachrichtigt je Karte alle Mitglieder ausser dem Absender, Kennzeichen `conversation:<Chat>` → auf dem Gerät **zwei** Benachrichtigungen (`renotify` in `sw.ts:297`) für dieselbe Einladung, bei stummgeschaltetem Gruppenchat aber trotzdem eine über den Einzelchat (`notify.rs:53`, je Chat). Entwurfsentscheidung: die Karten der weiteren Chats stumm anlegen (`silent: true`) und je Person genau **eine** Benachrichtigung auslösen (Wahl: den Einzelchat, sonst den Gruppenchat, unter Beachtung der Stummschaltung des gewählten Chats). Auch ungelesene Zähler und „zuletzt geschrieben“ wandern mit jeder Karte (`touch_conversation`); das ist gewollt.
7. **Synchronität auf der Kartenseite fehlt im Client, nicht im Server.** `EventBubble` hält den Termin in eigenem Zustand (`useLiveEvent(eventId, message.event)`, `useCalendarEvents.ts:92-146`); `message.event` im Speicher wird nie angefasst (`state/chat.ts` kennt `event.updated` nicht), `refreshMessages` holt nur Neueres (`state/chat.ts:477-485`), und ein Remount lädt nicht nach, weil `initial.id === eventId` (`:109`). Zwei Wege: (a) im Chat-Speicher auf `event.updated`/`event.deleted` hören und `message.event` in **allen** Chats mit dieser Kennung ersetzen (auch im IndexedDB-Zwischenspeicher); (b) wie bei Umfragen serverseitig jede Karte mit `message.updated` neu ausspielen. Vorsicht bei (b): `applyMessage` setzt `lastMessage` der Chatliste auf die gemeldete Nachricht, auch wenn sie alt ist (`state/chat.ts:384-388`) – die Vorschauzeile würde auf eine alte Karte springen. (a) ist billiger und trifft beide Wege (mit und ohne Platzierungstabelle).
8. **Woher „alle verfügbaren Personen“?** Ein Weg zum Auflisten gibt es nicht: `GET /users?q=` braucht einen Begriff (`modules/users.rs:44`), `contacts_of` (`services/users.rs:101-112`) hat keine Route (nur Anwesenheit und Datenexport). Im Client liegen die Kontakte längst vor: jeder Chat im Speicher trägt `members[].user` (`UserDto`), einschliesslich der Einzelchats (`ConversationDto.members`, `services/conversations.rs:295-314`). Damit lässt sich die Liste ohne neuen Endpunkt bilden (Vereinigung aller Mitglieder der nicht archivierten Chats, ohne mich); der Editor holt heute jede Person einzeln mit `GET /users/:id` (`EventEditor.tsx:191`), obwohl die Namen im Speicher stehen. Zu klären: Archivierte Chats zählen nicht zur Liste (`load_conversation_dtos` liefert sie nur auf Wunsch), Kontakte, die nur über archivierte Chats bestehen, bleiben über die Suche erreichbar.
9. **Leere Liste ist mehrdeutig.** `attendeeIds` leer heisst „alle aus dem Chat“ (`EventEditor.tsx:298-300`, `services/calendar.rs:197-201`), und `update` behandelt die Liste als **Sollzustand** (`modules/calendar.rs:309-353`). Mit „Niemand“ und der Gruppenwahl braucht die Schnittstelle eine ausdrückliche Form (Teilnehmerliste ist immer die volle Liste; der Chat wird nicht mehr still ergänzt), sonst kippt die alte Bedeutung um, und ältere App-Stände (PWA-Cache!) schicken weiter leere Listen. Rückwärtsverträglich: fehlt das neue Feld, gilt das alte Verhalten.
10. **Löschen lässt tote Karten zurück** (Lauf S13, auch `modules/calendar.rs:360-390`: nur `deleted_at`, der Rundruf trägt keinen Nachrichtenbezug). Bei N Karten wären es N Leichen pro Termin. Wie `unplace_poll`: die Karten mitlöschen oder durch „Termin abgesagt“ ersetzen; das betrifft auch das Erinnerungsthema (Abbruchbedingung „Termin gelöscht“).
11. **Es gibt keinen Hintergrunddienst für Termine** (`tokio::spawn` nur in `media.rs`, `auslagern.rs`, `muell.rs`, `state.rs`); `reminder_minutes` ist reine ICS-Angabe (`ical.rs`), und `status = 'cancelled'` hat keine Route (nur Schema, `0005_events.sql:41-43`). Für das Erinnern ist also ein neuer periodischer Auftrag nötig; die Erinnerung ist entweder eine neue Nachricht im Einzelchat (`create_message`, mit eigenem Push) oder ein reiner Push über `notify_users` (`notify.rs:153`); das entscheidet das Erinnerungsthema.
12. **Die Nachricht `message_id` der ersten Karte behält eine Sonderrolle** (`calendar_events.message_id`, `0001_init.sql:190`; wird nur in `create_event` geschrieben, `services/calendar.rs:271`). Mit Platzierungen sollte sie nur noch „Ursprungskarte“ heissen oder entfallen; gelesen wird sie im Code nirgends (nur `select *` in die Zeilenstruktur `db.rs`, das DTO führt sie nicht) – sie kann als „Ursprungskarte“ bleiben.

## Lücken (in Reihenfolge der Abhängigkeit)

1. Sichtbarkeit/Antwortrecht an der Teilnehmerliste ausrichten; `assert_visible` reparieren (Teilnehmer-Zweig) und `rsvp` darf nur Eingeladene eintragen (heute trägt es jedes Chatmitglied ein).
2. Karte nur für Teilnehmer; `EventExpander` mit Betrachterprüfung; `type=event` über `POST /messages` schliessen oder prüfen.
3. Platzierungen (`event_placements`) und Dienst „Einzelchat finden/anlegen“; Anlage von Gruppen- und Einzelkarten nach der Regel „alle Mitglieder gewählt → Gruppenkarte + Einzelkarten, sonst nur Einzelkarten“; nachträgliches Einladen und Ausladen ziehen die Karten mit (heute: nichts).
4. Benachrichtigung je Person genau einmal.
5. Karten im Client synchron halten (Chat-Speicher reagiert auf `event.updated`/`event.deleted`).
6. Oberfläche: Personenliste immer sichtbar (Kontakte aus dem Chat-Speicher), Schnellwahl „Alle / Niemand / Gruppenchat …“, ehrlicher Zähler, Gruppe/Einzelchat nicht mehr als Bindung missverstehen; nachträgliches Einladen bietet dieselbe Liste (heute nur Chatmitglieder, die noch nicht eingeladen sind, `EventDetailScreen.tsx:59-66`, also meist nichts).
7. Löschen und Absage: Karten mitführen.
8. Wanderung (0023): `event_placements`, Teilnehmerzeilen für Bestandstermine (Chatmitglieder) nachtragen, `idempotent`.

## Wiederverwenden

```
# API-Lauf (ca. 15 s, legt vier frische Nutzer an)
node /tmp/claude-0/-home-user-Initiative/b3e47b8f-e30a-5e75-8af6-6e58f2fcbe7c/scratchpad/ergebnis-events/einladen-bestand.mjs

# Browser-Lauf (Dev-Server auf 5183 nötig)
cd /home/user/Initiative/apps/web && npx playwright test \
  -c /tmp/claude-0/-home-user-Initiative/b3e47b8f-e30a-5e75-8af6-6e58f2fcbe7c/scratchpad/ergebnis-events/pw-einladen.config.ts
```

Das Skript enthält Hilfen, die Folgearbeiten übernehmen können: `aufbau()` (vier Nutzer, Gruppe, vier Einzelchats, ein Websocket je Nutzer), `karten(eventId)` (in welchen Chats steht eine Karte), `sicht(eventId)` (Liste/Detail/Notizen je Nutzer), `echtzeitAlle(eventId)` (was jeder Websocket zu diesem Termin meldete). Die Erwartungen für „nach der Änderung“ lassen sich daraus ableiten: aus „Karte in: nur G“ wird „G + AB + AC“, aus `D: Detail 403` wird 200, aus S9 „B weiter 200“ wird 403.

Nicht gemessen: Web-Push (im Dev-Server aus, `/healthz` → `"push": false`). Der Befund zu den doppelten Benachrichtigungen folgt aus dem Code (Nr. 6), nicht aus einem Lauf; ein Test braucht VAPID-Schlüssel in der Konfiguration und ein Abo, oder eine Zählung der `notify_new_message`-Aufrufe in einem Rust-Test.
