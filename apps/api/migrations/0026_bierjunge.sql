-- „Bierjunge“ / „hängt“: ein Wort im Chat startet ein Pressen-Spiel.
--
-- # Was sich ändert
--
-- Schreibt jemand „Bierjunge“ (oder „Generalbierjunge“) in einen Chat, merkt sich
-- der Server den Aufruf. Antwortet ein anderes Mitglied innerhalb von zehn
-- Minuten mit „hängt“, legt der Server die Pressen-Partie an (siehe
-- `services/bierjunge.rs`). Hier stehen nur die zwei Tabellen dafür.
--
-- # bierjunge_aufrufe
--
--   message_id   Die Nachricht mit dem Aufruf (eindeutig: eine Nachricht, ein
--                Aufruf). Wird sie gelöscht, verschwindet der Aufruf mit.
--   art          'normal' (verbraucht sich mit dem ersten startenden „hängt“) oder
--                'general' (bleibt bis zum Ablauf offen).
--   ziel_id      Bei 'normal' im Gruppenchat: das genannte Mitglied. Nur dessen
--                „hängt“ zählt. Leer: das erste „hängt“ eines anderen Mitglieds.
--   erstellt_am  Zeit der Nachricht (nicht der Verarbeitung): die zehn Minuten
--                laufen ab hier.
--   verbraucht_am  Das atomare Beanspruchen eines normalen Aufrufs: genau ein
--                `update … where verbraucht_am is null` gewinnt, auch wenn zwei
--                „hängt“ im selben Augenblick ankommen.
--
-- # bierjunge_antworten
--
-- Schlüssel (Aufruf, Person): Jede Person antwortet auf einen Aufruf höchstens
-- einmal. `spiel_id` ist die daraus entstandene Partie (leer, wenn der
-- Versuch nichts gestartet hat).
--
-- # Rückwärtsverträglich
--
-- Alles ist `if not exists`; der zweite Durchlauf tut nichts. Ein älterer Stand
-- der Anwendung kennt die Tabellen nicht und läuft unverändert weiter.
create table if not exists bierjunge_aufrufe (
  id              uuid        primary key default gen_random_uuid(),
  conversation_id uuid        not null references conversations (id) on delete cascade,
  ausrufer_id     uuid        not null references users (id) on delete cascade,
  message_id      uuid        not null references messages (id) on delete cascade,
  art             text        not null check (art in ('normal', 'general')),
  ziel_id         uuid        references users (id) on delete cascade,
  erstellt_am     timestamptz not null,
  verbraucht_am   timestamptz,
  unique (message_id)
);
create index if not exists bierjunge_aufrufe_chat_idx
  on bierjunge_aufrufe (conversation_id, erstellt_am);

create table if not exists bierjunge_antworten (
  aufruf_id    uuid        not null references bierjunge_aufrufe (id) on delete cascade,
  user_id      uuid        not null references users (id) on delete cascade,
  nachricht_id uuid        references messages (id) on delete set null,
  spiel_id     uuid        references game_sessions (id) on delete set null,
  erstellt_am  timestamptz not null default now(),
  primary key (aufruf_id, user_id)
);
