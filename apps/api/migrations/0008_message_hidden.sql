-- „Nur für mich löschen“.
--
-- Bisher gab es nur eine Art zu löschen: für alle, mit Grabstein. Das ist die
-- eine Hälfte. Die andere ist der Wunsch, etwas aus dem eigenen Verlauf zu
-- räumen, ohne dass es bei den anderen verschwindet – ein Foto, das man nicht
-- ständig sehen will; eine Nachricht, die man selbst nicht geschrieben hat.
--
-- Deshalb kein zweites Grabstein-Feld an `messages`: Was für mich verborgen
-- ist, geht niemanden sonst etwas an, und es kann für jeden anders sein. Eine
-- eigene Zeile je Person ist die einzige Form, die das abbildet.

create table if not exists message_hidden (
  message_id uuid not null references messages (id) on delete cascade,
  user_id    uuid not null references users (id) on delete cascade,
  hidden_at  timestamptz not null default now(),
  primary key (message_id, user_id)
);

-- Der Verlauf wird nach Chat und Kennung gelesen; die Frage lautet dabei
-- immer „was hat DIESE Person verborgen“.
create index if not exists message_hidden_user_idx on message_hidden (user_id, message_id);

comment on table message_hidden is
  'Nachrichten, die eine einzelne Person aus ihrem eigenen Verlauf genommen hat. Fuer alle anderen bleiben sie sichtbar.';
