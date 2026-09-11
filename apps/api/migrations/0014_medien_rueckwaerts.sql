-- Rückwärts-Indizes für die Sichtbarkeitsprüfung an den Medienrouten.
--
-- Seit `darf_anhang_sehen` vor jeder Auslieferung fragt „darf diese Person
-- diesen Anhang sehen?", wird von der ANHANGSKENNUNG aus gesucht. Die
-- vorhandenen Indizes führen aber alle in die andere Richtung: `stickers` nach
-- `pack_id`, `event_attachments` nach `event_id`, und für die beiden
-- Profilbild-Spalten gab es gar keinen. Eine Prüfung hätte damit bis zu vier
-- vollständige Tabellendurchläufe gekostet – bei jedem Vorschaubild in einem
-- Verlauf.
--
-- `collection_items (attachment_id)` gibt es bereits (0004).

create index if not exists users_avatar_attachment_idx
  on users (avatar_attachment_id)
  where avatar_attachment_id is not null;

create index if not exists conversations_avatar_attachment_idx
  on conversations (avatar_attachment_id)
  where avatar_attachment_id is not null;

create index if not exists stickers_attachment_idx
  on stickers (attachment_id);

create index if not exists event_attachments_attachment_idx
  on event_attachments (attachment_id);

-- Der Weg vom Sticker zur Nachricht führt durch das JSON: `metadata->>'stickerId'`.
-- Ohne diesen Ausdrucks-Index bliebe genau dieser Zweig ein Tabellendurchlauf
-- über alle Nachrichten.
create index if not exists messages_sticker_idx
  on messages ((metadata ->> 'stickerId'))
  where metadata ->> 'stickerId' is not null;
