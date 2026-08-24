-- Admin-Modus und verwaltete Einladungscodes.
--
-- Bisher kamen Einladungscodes ausschließlich aus der Umgebungsvariablen
-- INVITE_CODES und ließen sich nur per Neustart ändern. Codes hier in der
-- Datenbank können Admins im laufenden Betrieb anlegen und zurückziehen;
-- INVITE_CODES bleibt als Notnagel bestehen.

alter table users add column if not exists is_admin boolean not null default false;

create table if not exists invite_codes (
  code        text primary key,
  note        text,
  created_by  uuid        references users (id) on delete set null,
  max_uses    integer,
  uses        integer     not null default 0,
  expires_at  timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists invite_codes_created_idx on invite_codes (created_at desc);

-- Wer einen Code eingelöst hat. Rein zur Nachvollziehbarkeit; verschwindet mit
-- dem Konto bzw. dem Code.
create table if not exists invite_redemptions (
  code        text        not null references invite_codes (code) on delete cascade,
  user_id     uuid        not null references users (id) on delete cascade,
  redeemed_at timestamptz not null default now(),
  primary key (code, user_id)
);
