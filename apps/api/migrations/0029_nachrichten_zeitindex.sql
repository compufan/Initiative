-- Nachrichten je Gespräch nach Zeitpunkt.
--
-- Die Verlaufsgrenze (`conversation_members.sieht_ab`, Migration 0016) ist ein
-- Zeitpunkt, und die Frage „liegt vor meiner Grenze überhaupt etwas?“ stellen
-- die Chatliste (bei JEDEM Laden, für jedes Gespräch mit Grenze) und der
-- Verlaufsantrag als `exists (… created_at < sieht_ab)`. Der einzige Index je
-- Gespräch lief über `(conversation_id, id)`, und eine Kennung ist kein
-- Zeitpunkt, mit dem Postgres rechnen darf: Es las den ganzen Verlauf, um im
-- häufigsten Fall – der Gründer, vor dessen Grenze nichts liegt –
-- festzustellen, dass da nichts ist. Gemessen bei 300 Chats mit je 2000
-- Nachrichten: 900 ms je Aufruf der Chatliste, mit diesem Index 3 ms.
--
-- Bewusst ohne `concurrently`: sqlx führt jede Migration in einer Transaktion
-- aus, und ein abgebrochener nebenläufiger Aufbau hinterliesse einen
-- ungültigen Index, den `if not exists` danach für fertig hielte. Der Aufbau
-- sperrt Schreibzugriffe auf `messages` für seine Dauer – 0,8 s bei
-- 600 000 Nachrichten.
create index if not exists messages_conversation_created_idx
  on messages (conversation_id, created_at);
