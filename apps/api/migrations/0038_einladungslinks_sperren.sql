-- Einladungslinks, Beitrittsanfragen, Blockieren und Melden.
--
-- # Einladungslinks
--
-- Der Token ist zufällig (32 Zeichen aus `random_token`) und steht im Klartext:
-- Admins müssen einen bestehenden Link erneut teilen können, und er öffnet
-- höchstens eine Gruppe, nie ein Konto – dieselbe Abwägung wie bei den
-- Einladungscodes der Registrierung (`invite_codes`). `uses` zählt ein
-- bedingtes Update hoch, damit zwei gleichzeitige Beitritte `max_uses` nicht
-- gemeinsam überschreiten.
--
-- # Beitrittsanfragen
--
-- Ein Link mit `freigabe` lässt niemanden direkt hinein, sondern legt eine
-- Anfrage an, die ein Admin annimmt oder ablehnt. Höchstens eine offene je
-- Person und Gruppe (Teilindex).
--
-- # Blockieren
--
-- Eine Zeile je (wer, wen). Die Wirkung steht im Server (`services::sperren`):
-- kein Schreiben im Direktchat, keine Präsenz, kein Profilbild, keine Suche.
--
-- # Meldungen
--
-- Eine Person oder Nachricht melden. `nachricht_auszug` hält fest, was der
-- Meldende in dem Augenblick sah – die Verwaltung soll nicht in fremde Chats
-- hineinsehen müssen, und eine später gelöschte Nachricht bleibt so
-- nachvollziehbar. Fremdschlüssel mit `set null`: Eine Meldung überlebt das
-- Löschen des Kontos oder der Nachricht.
--
-- Wiederholbar: `if not exists` überall.

create table if not exists conversation_invites (
  id uuid primary key,
  conversation_id uuid not null references conversations (id) on delete cascade,
  token text not null unique,
  created_by uuid references users (id) on delete set null,
  expires_at timestamptz,
  max_uses integer check (max_uses is null or max_uses > 0),
  uses integer not null default 0,
  freigabe boolean not null default false,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists conversation_invites_chat_idx
  on conversation_invites (conversation_id);
create index if not exists conversation_invites_created_by_idx
  on conversation_invites (created_by);

create table if not exists beitrittsanfragen (
  id uuid primary key,
  conversation_id uuid not null references conversations (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  invite_id uuid references conversation_invites (id) on delete set null,
  status text not null default 'offen'
    check (status in ('offen', 'angenommen', 'abgelehnt')),
  entschieden_von uuid references users (id) on delete set null,
  entschieden_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists beitrittsanfragen_offen_idx
  on beitrittsanfragen (conversation_id, user_id) where status = 'offen';
create index if not exists beitrittsanfragen_user_idx on beitrittsanfragen (user_id);
create index if not exists beitrittsanfragen_invite_idx on beitrittsanfragen (invite_id);
create index if not exists beitrittsanfragen_entschieden_von_idx
  on beitrittsanfragen (entschieden_von);

create table if not exists user_blocks (
  blocker_id uuid not null references users (id) on delete cascade,
  blocked_id uuid not null references users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index if not exists user_blocks_blocked_idx on user_blocks (blocked_id);

create table if not exists reports (
  id uuid primary key,
  reporter_id uuid references users (id) on delete set null,
  target_user_id uuid references users (id) on delete set null,
  message_id uuid references messages (id) on delete set null,
  conversation_id uuid references conversations (id) on delete set null,
  grund text not null
    check (grund in ('spam', 'belaestigung', 'unangemessen', 'gewalt', 'sonstiges')),
  freitext text check (freitext is null or char_length(freitext) <= 1000),
  nachricht_auszug text,
  status text not null default 'offen'
    check (status in ('offen', 'in_bearbeitung', 'erledigt', 'abgewiesen')),
  notiz text check (notiz is null or char_length(notiz) <= 1000),
  bearbeitet_von uuid references users (id) on delete set null,
  bearbeitet_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists reports_status_idx on reports (status, created_at desc);
create index if not exists reports_reporter_idx on reports (reporter_id);
create index if not exists reports_target_user_idx on reports (target_user_id);
create index if not exists reports_message_idx on reports (message_id);
create index if not exists reports_conversation_idx on reports (conversation_id);
create index if not exists reports_bearbeitet_von_idx on reports (bearbeitet_von);
