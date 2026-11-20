-- Chatliste je Person, Chat leeren, Benachrichtigung je Chat, Sitzungen.
--
-- # Je Mitgliedschaft
--
-- * `pinned_at` – angeheftet (höchstens fünf, geprüft im Server). Die
--   Reihenfolge ist der Zeitpunkt: Umordnen schreibt neue Zeitpunkte.
-- * `marked_unread` – „als ungelesen markiert“; fällt beim Lesen.
-- * `cleared_until` – „Chat leeren (für mich)“. Der Server zieht dabei auch
--   `sieht_ab` auf diesen Zeitpunkt nach: Jeder Lesepfad (Verlauf, Suche,
--   Medien, Zähler, Vorschau, Zitate, Karten) filtert schon an `sieht_ab`,
--   und eine zweite Grenze, die jeder Pfad einzeln kennen müsste, wäre eine
--   Gelegenheit mehr, einen zu vergessen. `sieht_ab_vor_leeren` hält die
--   Grenze von vorher fest – sie ist es, die die anderen Mitglieder sehen
--   (wann jemand seinen Chat geleert hat, geht niemanden etwas an).
-- * `ausgeblendet` – „Direktchat löschen (für mich)“: geleert und aus der
--   Liste, bis wieder etwas Neues kommt.
-- * `notify_level` / `notify_preview` – Mitteilungen je Chat.
-- * `settings` – Persönliches je Chat (Hintergrund).
--
-- # Ordner
--
-- Eigene Ordner der Chatliste: Name und gewählte Chats. Ein Array statt einer
-- Zuordnungstabelle – gelesen wird immer der ganze Ordner, und ein Chat, den
-- man verlassen hat, fällt beim Anzeigen heraus.
--
-- # Sitzungen
--
-- Ein Erneuerungs-Token rotiert bei jeder Erneuerung; jede Rotation ist eine
-- neue Zeile. `sitzung_id` hält die Kette zusammen – sie ist das „Gerät“ in
-- der Geräteliste. Bestehende Zeilen bekommen ihre eigene Kennung als Sitzung:
-- Ihre Kette lässt sich nicht nachträglich ermitteln, und die lebende Zeile
-- jeder Kette ist ohnehin genau eine.
--
-- Wiederholbar: Jede Anweisung prüft selbst, ob es sie schon gibt.

alter table conversation_members add column if not exists pinned_at timestamptz;
alter table conversation_members add column if not exists marked_unread boolean not null default false;
alter table conversation_members add column if not exists cleared_until timestamptz;
alter table conversation_members add column if not exists sieht_ab_vor_leeren timestamptz;
alter table conversation_members add column if not exists ausgeblendet boolean not null default false;
alter table conversation_members add column if not exists notify_level text not null default 'alle';
alter table conversation_members add column if not exists notify_preview boolean not null default true;
alter table conversation_members add column if not exists settings jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'conversation_members_notify_level'
  ) then
    alter table conversation_members
      add constraint conversation_members_notify_level
      check (notify_level in ('alle', 'erwaehnungen', 'aus'));
  end if;
end $$;

create index if not exists conversation_members_pinned_idx
  on conversation_members (user_id, pinned_at) where pinned_at is not null;

create table if not exists chat_ordner (
  id uuid primary key,
  user_id uuid not null references users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  position integer not null default 0,
  chats uuid[] not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists chat_ordner_user_idx on chat_ordner (user_id, position);

alter table refresh_tokens add column if not exists sitzung_id uuid;
alter table refresh_tokens add column if not exists angemeldet_at timestamptz;
alter table refresh_tokens add column if not exists zuletzt_aktiv timestamptz;
update refresh_tokens
   set sitzung_id = coalesce(sitzung_id, id),
       angemeldet_at = coalesce(angemeldet_at, created_at),
       zuletzt_aktiv = coalesce(zuletzt_aktiv, created_at)
 where sitzung_id is null or angemeldet_at is null or zuletzt_aktiv is null;
create index if not exists refresh_tokens_sitzung_idx on refresh_tokens (sitzung_id);
