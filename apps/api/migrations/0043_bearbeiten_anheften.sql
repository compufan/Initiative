-- Bearbeitungsverlauf und angeheftete Nachrichten.
--
-- # Bearbeitungsverlauf
--
-- Wer eine Nachricht bearbeitet, ändert sie für alle – und alle sollen sehen
-- können, WAS geändert wurde. Sonst liesse sich eine Zusage nachträglich in
-- eine Absage verwandeln, ohne dass jemand es merkt („bearbeitet“ allein sagt
-- nicht, was vorher dastand). Je Bearbeitung eine Zeile mit dem Text DAVOR;
-- der aktuelle Text steht in der Nachricht selbst.
--
-- Löscht jemand die Nachricht für alle, verschwindet der Verlauf mit ihr
-- (siehe `modules/messages.rs`, `remove`) – ein gelöschter Text, der im
-- Verlauf weiterlebt, wäre kein gelöschter.
create table if not exists message_edits (
  id            uuid primary key,
  message_id    uuid        not null references messages (id) on delete cascade,
  body_vorher   text,
  bearbeitet_at timestamptz not null default now()
);
create index if not exists message_edits_message_idx
  on message_edits (message_id, bearbeitet_at);

-- # Angeheftete Nachrichten
--
-- Je Chat höchstens drei (wie WhatsApp); die Grenze hält der Server in einer
-- Transaktion ein, nicht die Tabelle – beim vierten fällt die älteste heraus.
-- Gilt für alle Mitglieder gleich, deshalb am Chat und nicht an der
-- Mitgliedschaft (das persönliche Anheften eines CHATS ist `pinned_at`).
create table if not exists conversation_pins (
  conversation_id uuid        not null references conversations (id) on delete cascade,
  message_id      uuid        not null references messages (id) on delete cascade,
  pinned_by       uuid        references users (id) on delete set null,
  pinned_at       timestamptz not null default now(),
  primary key (conversation_id, message_id)
);
create index if not exists conversation_pins_message_idx on conversation_pins (message_id);
create index if not exists conversation_pins_pinned_by_idx on conversation_pins (pinned_by);
