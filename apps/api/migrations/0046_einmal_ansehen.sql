-- Einmal ansehbare Fotos und Videos.
--
-- Je Anhang und Person eine Zeile, sobald die Person ihn geöffnet hat. Die
-- Auslieferung (`modules/messages/einmal.rs`) legt die Zeile in derselben
-- Anweisung an, mit der sie entscheidet: `on conflict do nothing` – wer schon
-- eine Zeile hat, bekommt 410. So kann auch ein doppelter Abruf in derselben
-- Millisekunde die Datei nicht zweimal holen.
create table if not exists einmal_ansichten (
  attachment_id uuid        not null references attachments (id) on delete cascade,
  user_id       uuid        not null references users (id) on delete cascade,
  geoeffnet_at  timestamptz not null default now(),
  primary key (attachment_id, user_id)
);
create index if not exists einmal_ansichten_user_idx on einmal_ansichten (user_id);
