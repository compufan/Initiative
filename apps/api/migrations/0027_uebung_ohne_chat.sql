-- Übungen ohne Chat: „Pressen gegen den Spiegel“ braucht niemanden zum Spielen.
--
-- # Was sich ändert
--
-- Bisher hing jede Partie an einem Chat (`conversation_id not null`) und stand
-- dort als Karte – auch eine Übung allein gegen den Spiegel, samt Vorschau in
-- der Chatliste und Mitteilung. Eine Übung gehört aber niemandem außer dir.
--
--   conversation_id  darf jetzt leer sein: Übung ohne Chat, ohne Chat-Karte
--                    (`message_id` bleibt leer), ohne Mitteilung.
--   besitzer_id      Wem die Übung gehört. NUR diese Person darf sie lesen und
--                    spielen (Zugriffsprüfung in `services/games.rs`). Das
--                    Konto zu löschen nimmt die Übung mit (`on delete cascade`).
--
-- Eine Partie braucht entweder einen Chat oder einen Besitzer – beides leer
-- wäre eine Partie, die niemand je wieder erreicht.
--
-- # Rückwärtsverträglich
--
-- Bestehende Partien behalten ihren Chat und ihre Karte. `drop not null`,
-- `add column if not exists`, `create index if not exists` und die Prüfung
-- hinter dem Fangblock sind wiederholbar; der zweite Durchlauf tut nichts.
alter table game_sessions alter column conversation_id drop not null;

alter table game_sessions
  add column if not exists besitzer_id uuid references users (id) on delete cascade;

do $$
begin
  alter table game_sessions
    add constraint game_sessions_chat_oder_besitzer
    check (conversation_id is not null or besitzer_id is not null);
exception when duplicate_object then null;
end $$;

create index if not exists game_sessions_besitzer_idx
  on game_sessions (besitzer_id)
  where besitzer_id is not null;
