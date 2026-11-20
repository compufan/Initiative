-- Geplante Nachrichten („Später senden“).
--
-- Eine Zeile je geplanter Nachricht, bis der Dienst sie gesendet hat
-- (`services/geplant.rs`). Sie trägt alles, was zum Senden nötig ist – den
-- Text, die Kennungen fertig hochgeladener Anhänge, den Antwortbezug und die
-- Erwähnungen –, aber keine Kopie der Bytes: Die Anhänge liegen ungebunden im
-- Medienspeicher, bis die Nachricht sie zum Sendezeitpunkt bindet. Fehlt dann
-- einer (gelöscht, anderweitig vergeben), scheitert die Sendung mit Hinweis,
-- statt eine halbe Nachricht zu schicken.
--
-- `status`: `geplant` → `sendet` (beansprucht) → `gesendet`, oder
-- `fehlgeschlagen` mit `fehler`. Eine beanspruchte Zeile, die liegen bleibt
-- (Absturz zwischen Beanspruchen und Senden), holt der nächste Durchgang nach
-- einer Frist erneut; der feste Wiederholungsschlüssel `geplant:<id>` sorgt
-- dafür, dass dabei keine zweite Nachricht entsteht.
--
-- `zeitzone` ist nur Anzeige (die Liste „Geplant“ zeigt die Uhrzeit, die der
-- Mensch gewählt hat); gerechnet wird mit `senden_um` in UTC.
create table if not exists scheduled_messages (
  id              uuid primary key,
  conversation_id uuid        not null references conversations (id) on delete cascade,
  sender_id       uuid        not null references users (id) on delete cascade,
  typ             text        not null default 'text'
                  check (typ in ('text', 'image', 'video', 'audio', 'file')),
  body            text,
  attachment_ids  uuid[]      not null default '{}',
  reply_to_id     uuid        references messages (id) on delete set null,
  metadata        jsonb       not null default '{}'::jsonb,
  senden_um       timestamptz not null,
  zeitzone        text        not null default 'UTC',
  status          text        not null default 'geplant'
                  check (status in ('geplant', 'sendet', 'gesendet', 'fehlgeschlagen')),
  fehler          text,
  beansprucht_at  timestamptz,
  message_id      uuid        references messages (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
-- Der Dienst fragt „was ist fällig?“ – nur über offene Zeilen.
create index if not exists scheduled_messages_faellig_idx
  on scheduled_messages (senden_um)
  where status in ('geplant', 'sendet');
create index if not exists scheduled_messages_chat_idx
  on scheduled_messages (conversation_id, sender_id);
create index if not exists scheduled_messages_sender_idx on scheduled_messages (sender_id);
create index if not exists scheduled_messages_reply_idx on scheduled_messages (reply_to_id);
create index if not exists scheduled_messages_message_idx on scheduled_messages (message_id);
