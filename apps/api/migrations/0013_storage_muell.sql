-- Was gelöscht wurde, muss auch aus dem Speicher verschwinden.
--
-- # Warum eine Tabelle und kein Aufruf im Handler
--
-- Weil Anhänge an mehreren Stellen verschwinden, ohne dass dabei
-- Anwendungscode läuft. `attachments.message_id` hat `on delete cascade`;
-- wer eine Nachricht löscht, ein Gespräch löscht oder sein Konto löscht,
-- räumt damit Anhangszeilen ab, ohne dass ein Rust-Handler davon erfährt.
-- Ein `storage.delete` an den bekannten Stellen liesse also genau die Fälle
-- liegen, die am meisten Daten betreffen.
--
-- Ein Auslöser sieht jede dieser Löschungen, weil er in derselben
-- Transaktion in der Datenbank hängt. Er schreibt nur den Schlüssel auf;
-- das eigentliche Wegräumen erledigt der Server später.
--
-- # Warum nicht sofort löschen
--
-- Weil der Speicher gerade nicht antworten könnte. Eine Nachricht, die sich
-- nicht löschen lässt, weil ein Objektspeicher hakt, wäre schlimmer als eine
-- Datei, die eine Stunde länger liegt. Die Zeile bleibt stehen, bis das
-- Wegräumen wirklich geklappt hat.

create table if not exists storage_muell (
  storage_key text primary key,
  angelegt_at timestamptz not null default now(),
  -- Wie oft es schon vergeblich versucht wurde. Steigt der Wert, ist etwas
  -- dauerhaft im Argen – dann steht es im Protokoll und nicht nur im Nichts.
  versuche    integer     not null default 0,
  zuletzt_at  timestamptz
);

create index if not exists storage_muell_offen_idx on storage_muell (angelegt_at);

create or replace function attachment_in_muell() returns trigger
language plpgsql as $$
begin
  -- `on conflict do nothing`: Zwei Zeilen könnten denselben Schlüssel
  -- tragen. Heute vergibt der Server je Anhang einen eigenen, aber diese
  -- Annahme soll nicht der Grund sein, warum ein Löschvorgang scheitert.
  insert into storage_muell (storage_key)
  values (old.storage_key)
  on conflict (storage_key) do nothing;
  return old;
end;
$$;

drop trigger if exists attachments_muell on attachments;
create trigger attachments_muell
  after delete on attachments
  for each row execute function attachment_in_muell();

-- Was VOR dieser Wanderung gelöscht wurde, steht hier nicht drin: Die
-- Schlüssel sind mit ihren Zeilen verschwunden, und der Speicher lässt sich
-- ohne eine Auflistung nicht danach durchsuchen. Diese Waisen bleiben liegen;
-- sie sind unerreichbar, aber vorhanden. Wer sie loswerden will, braucht
-- einen Abgleich zwischen Speicherinhalt und `attachments`.
