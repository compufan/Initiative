-- Dateien & Sammlungen: Ordnerstruktur mit Berechtigungen.
--
-- Die Berechtigungen sind bewusst allgemein gehalten, weil Ausgaben und
-- Ereignisse denselben Mechanismus brauchen: "wer darf das sehen, wer darf es
-- ändern, wem gehört es". Drei Stufen, aufsteigend:
--
--   view  -- ansehen und herunterladen
--   edit  -- Dateien hinzufügen, umbenennen, verschieben
--   own   -- zusätzlich löschen und Rechte vergeben
--
-- Wer eine Sammlung anlegt, besitzt sie. Alles andere wird vererbt: eine
-- Datei erbt von ihrer Sammlung, eine Sammlung von ihrem Elternordner. Die
-- höchste gefundene Stufe gewinnt – ein ausdrückliches Recht hebt ein
-- geerbtes nie auf, es kann es nur erweitern.

create table if not exists collections (
  id              uuid primary key,
  parent_id       uuid references collections (id) on delete cascade,
  -- Aus welchem Chat die Sammlung stammt. Daran hängt das Recht, aus dem Chat
  -- heraus etwas hinzuzufügen.
  conversation_id uuid references conversations (id) on delete set null,
  name            text        not null,
  description     text,
  color           text,
  -- Was jemand darf, der im zugehörigen Chat ist, aber kein eigenes Recht hat.
  -- Vorgabe 'edit': "Zur Sammlung hinzufügen" soll für alle im Chat gehen.
  member_level    text        not null default 'edit'
                    check (member_level in ('none', 'view', 'edit')),
  created_by      uuid references users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);
create index if not exists collections_parent_idx on collections (parent_id);
create index if not exists collections_conversation_idx on collections (conversation_id);
create index if not exists collections_creator_idx on collections (created_by);

create table if not exists collection_items (
  id            uuid primary key,
  collection_id uuid        not null references collections (id) on delete cascade,
  attachment_id uuid        not null references attachments (id) on delete cascade,
  added_by      uuid references users (id) on delete set null,
  title         text,
  note          text,
  -- Woher die Datei kam, damit man im Chat zurückspringen kann.
  message_id    uuid references messages (id) on delete set null,
  sort_key      integer     not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create index if not exists collection_items_collection_idx
  on collection_items (collection_id, sort_key, created_at);
create index if not exists collection_items_attachment_idx on collection_items (attachment_id);
-- Dieselbe Datei nicht zweimal in derselben Sammlung.
create unique index if not exists collection_items_unique_idx
  on collection_items (collection_id, attachment_id)
  where deleted_at is null;

-- Ein ausdrücklich vergebenes Recht.
--
-- Es hängt entweder an einer Sammlung oder an einer einzelnen Datei, und es
-- gilt entweder für eine Person oder für alle in einem Chat. Die beiden
-- Prüfungen unten stellen sicher, dass genau eines von beidem gesetzt ist –
-- sonst liessen sich Zeilen anlegen, die niemand mehr eindeutig auswerten kann.
create table if not exists collection_grants (
  id              uuid primary key,
  collection_id   uuid references collections (id) on delete cascade,
  item_id         uuid references collection_items (id) on delete cascade,
  user_id         uuid references users (id) on delete cascade,
  conversation_id uuid references conversations (id) on delete cascade,
  level           text        not null check (level in ('view', 'edit', 'own')),
  granted_by      uuid references users (id) on delete set null,
  created_at      timestamptz not null default now(),
  constraint collection_grants_target
    check ((collection_id is not null) <> (item_id is not null)),
  constraint collection_grants_subject
    check ((user_id is not null) <> (conversation_id is not null))
);
create index if not exists collection_grants_collection_idx on collection_grants (collection_id);
create index if not exists collection_grants_item_idx on collection_grants (item_id);
create index if not exists collection_grants_user_idx on collection_grants (user_id);
create index if not exists collection_grants_conversation_idx
  on collection_grants (conversation_id);
-- Ein Recht je Ziel und Empfänger; eine Änderung ersetzt es.
create unique index if not exists collection_grants_unique_collection_user_idx
  on collection_grants (collection_id, user_id)
  where collection_id is not null and user_id is not null;
create unique index if not exists collection_grants_unique_collection_conv_idx
  on collection_grants (collection_id, conversation_id)
  where collection_id is not null and conversation_id is not null;
create unique index if not exists collection_grants_unique_item_user_idx
  on collection_grants (item_id, user_id)
  where item_id is not null and user_id is not null;
create unique index if not exists collection_grants_unique_item_conv_idx
  on collection_grants (item_id, conversation_id)
  where item_id is not null and conversation_id is not null;
