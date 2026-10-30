-- Welchen Chat hat jemand gerade vor Augen?
--
-- Der Server wusste das nicht: `notify_new_message` schickte jedem Mitglied
-- (ausser dem Absender) einen Push, auch wenn es den Chat in diesem
-- Augenblick offen hatte und die Nachricht schon las. Das Gerät zeigte die
-- Mitteilung und schloss sie wieder (iOS verlangt eine sichtbare), und weil
-- das Lesen erst beim Server ankam, wenn der Push längst unterwegs war,
-- blieb die Nachricht in der Chatliste „neu“.
--
-- Jede Echtzeit-Leitung meldet den sichtbaren Chat (`chat.sichtbar`) und
-- wiederholt es alle paar Sekunden; die Zeile verfällt von selbst (`bis`),
-- falls das Gerät einfriert, ohne sich abzumelden. In der Datenbank und nicht
-- im Speicher eines Prozesses: Bei mehreren Maschinen läuft der Versand nicht
-- zwingend dort, wo die Leitung hängt.
create table if not exists chat_offen (
  verbindung uuid primary key,
  user_id uuid not null references users (id) on delete cascade,
  conversation_id uuid not null references conversations (id) on delete cascade,
  bis timestamptz not null
);
create index if not exists chat_offen_user_chat_idx
  on chat_offen (user_id, conversation_id);
