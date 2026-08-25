-- Anmelden mit Face ID, Fingerabdruck oder Geräte-PIN (WebAuthn/Passkeys).
--
-- Der private Schlüssel verlässt das Gerät nie; hier liegt nur der öffentliche
-- Teil. Damit ersetzt ein Blick oder ein Fingerabdruck die Passworteingabe,
-- ohne dass ein Geheimnis mehr auf dem Server liegt als vorher.

create table if not exists passkeys (
  id            uuid primary key,
  user_id       uuid        not null references users (id) on delete cascade,
  -- Von WebAuthn vergebene Kennung des Schlüssels, base64url.
  credential_id text        not null unique,
  -- Serialisierter öffentlicher Schlüssel samt Zählerstand.
  passkey       jsonb       not null,
  -- Womit man sich angemeldet hat („iPhone von Tim“).
  label         text        not null,
  last_used_at  timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists passkeys_user_idx on passkeys (user_id);

-- Kurzlebiger Zwischenstand zwischen Anfrage und Antwort des Geräts. Liegt in
-- der Datenbank statt im Arbeitsspeicher, damit es auch mit mehreren
-- API-Instanzen funktioniert.
create table if not exists webauthn_states (
  id         uuid primary key,
  user_id    uuid        references users (id) on delete cascade,
  purpose    text        not null,
  state      jsonb       not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists webauthn_states_expiry_idx on webauthn_states (expires_at);
