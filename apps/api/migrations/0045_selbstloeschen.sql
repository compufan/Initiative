-- Selbstlöschende Nachrichten.
--
-- Die Einstellung gilt für den ganzen Chat (wie bei WhatsApp): `null` heisst
-- aus, sonst die Lebensdauer neuer Nachrichten in Sekunden. Sie wirkt nur auf
-- Nachrichten, die NACH dem Einschalten geschrieben werden – `expires_at`
-- wird beim Anlegen gesetzt (`nachricht_anlegen`), nie nachträglich.
--
-- Der Aufräumdienst (`services/selbstloeschen.rs`) löscht abgelaufene
-- Nachrichten wirklich (nicht nur `deleted_at`): Anhänge fallen über die
-- Kaskade, und der Auslöser aus 0013/0020 schreibt ihre Schlüssel in
-- `storage_muell` – ausser eine weitergeleitete Kopie benutzt dieselben Bytes.
alter table conversations
  add column if not exists selbstloeschen_s integer
    check (selbstloeschen_s is null or selbstloeschen_s > 0);

alter table messages
  add column if not exists expires_at timestamptz;

-- Nur die Nachrichten mit Ablauf: Der Index bleibt klein, auch wenn der
-- Verlauf riesig ist.
create index if not exists messages_expires_idx
  on messages (expires_at)
  where expires_at is not null;
