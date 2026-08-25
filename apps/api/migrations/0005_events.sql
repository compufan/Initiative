-- Ereignisse: Terminfindung über mehrere Chats, Notizen und Dokumente.

-- ---------------------------------------------------------------------------
-- Eine Umfrage, überall dasselbe Ergebnis.
--
-- Bisher gehörte eine Umfrage genau einem Chat. Für die Terminfindung ist das
-- zu eng: Dieselbe Frage soll im Gruppenchat, in Einzelchats und am Termin
-- selbst stehen – aber mit **einem** Satz Vorschläge und **einem** Satz
-- Antworten. Wer in einem Einzelchat abstimmt, hat damit auch für die Gruppe
-- abgestimmt.
--
-- Deshalb bleibt die Umfrage, wo sie ist, und bekommt zusätzlich Auftritte.
-- `polls.conversation_id` ist weiterhin der Ursprung; jede weitere Stelle ist
-- eine Zeile hier.
-- ---------------------------------------------------------------------------
create table if not exists poll_placements (
  id              uuid primary key,
  poll_id         uuid        not null references polls (id) on delete cascade,
  conversation_id uuid        not null references conversations (id) on delete cascade,
  -- Die Nachricht, mit der sie dort auftaucht.
  message_id      uuid references messages (id) on delete set null,
  created_by      uuid references users (id) on delete set null,
  created_at      timestamptz not null default now()
);
-- Zweimal in denselben Chat waere eine zweite Nachricht zur selben Frage.
create unique index if not exists poll_placements_unique_idx
  on poll_placements (poll_id, conversation_id);
create index if not exists poll_placements_conversation_idx
  on poll_placements (conversation_id);

-- ---------------------------------------------------------------------------
-- Termine
-- ---------------------------------------------------------------------------

-- Ein Termin kann feststehen oder noch in Abstimmung sein.
--
-- `starts_at` bleibt bewusst verpflichtend: Ein Termin ohne Zeitpunkt wäre in
-- jeder Kalenderansicht, jedem ICS-Export und jeder Bereichsabfrage ein
-- Sonderfall. Ein Termin in Abstimmung trägt stattdessen den frühesten
-- Vorschlag als vorläufigen Zeitpunkt und wird als "in Abstimmung" angezeigt.
alter table calendar_events
  add column if not exists status text not null default 'confirmed'
    check (status in ('planning', 'confirmed', 'cancelled'));

-- Die Umfrage, mit der der Zeitpunkt gefunden wird. Gegenstueck zu
-- `source_poll_id`, das erst nach der Entscheidung gesetzt wird.
alter table calendar_events
  add column if not exists poll_id uuid references polls (id) on delete set null;

-- Die Sammlung, in der die Dateien zu diesem Termin liegen.
alter table calendar_events
  add column if not exists collection_id uuid references collections (id) on delete set null;

create index if not exists calendar_events_status_idx on calendar_events (status);

-- ---------------------------------------------------------------------------
-- Notizen am Termin
--
-- Jede Notiz bestimmt selbst, wer sie ändern darf. Das ist der Punkt, an dem
-- sich "Einkaufsliste, die alle pflegen" von "Ansprache, an der niemand
-- herumschreibt" unterscheidet.
-- ---------------------------------------------------------------------------
create table if not exists event_notes (
  id         uuid primary key,
  event_id   uuid        not null references calendar_events (id) on delete cascade,
  author_id  uuid references users (id) on delete set null,
  title      text,
  body       text        not null default '',
  -- author   – nur wer sie geschrieben hat
  -- members  – alle, die zum Termin eingeladen sind
  -- listed   – nur die in event_note_editors genannten (und der Verfasser)
  edit_scope text        not null default 'author'
               check (edit_scope in ('author', 'members', 'listed')),
  position   integer     not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists event_notes_event_idx on event_notes (event_id, position, created_at);

create table if not exists event_note_editors (
  note_id uuid not null references event_notes (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  primary key (note_id, user_id)
);

-- ---------------------------------------------------------------------------
-- Dokumente am Termin: Einladung als PDF, Anfahrtsskizze, Speisekarte.
-- ---------------------------------------------------------------------------
create table if not exists event_attachments (
  id            uuid primary key,
  event_id      uuid        not null references calendar_events (id) on delete cascade,
  attachment_id uuid        not null references attachments (id) on delete cascade,
  added_by      uuid references users (id) on delete set null,
  title         text,
  created_at    timestamptz not null default now()
);
create unique index if not exists event_attachments_unique_idx
  on event_attachments (event_id, attachment_id);
create index if not exists event_attachments_event_idx on event_attachments (event_id);
