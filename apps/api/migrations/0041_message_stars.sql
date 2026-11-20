-- Gespeicherte Nachrichten („Sternchen“) – je Person, unsichtbar für andere.
--
-- Die Zeile hängt an der Nachricht: Wird sie für alle gelöscht, bleibt der
-- Stern zwar stehen (das Löschen leert nur den Inhalt), wird aber in der
-- Liste ausgefiltert; verschwindet die Nachricht ganz (Chat gelöscht), geht
-- der Stern mit.
create table if not exists message_stars (
  user_id    uuid        not null references users (id) on delete cascade,
  message_id uuid        not null references messages (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, message_id)
);
-- Die Liste blättert je Person nach Zeitpunkt des Speicherns.
create index if not exists message_stars_user_created_idx
  on message_stars (user_id, created_at desc, message_id desc);
-- Für das Löschen einer Nachricht (Fremdschlüssel, siehe 0031).
create index if not exists message_stars_message_idx on message_stars (message_id);
