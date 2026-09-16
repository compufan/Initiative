-- Damit eine ausgelagerte Datei auch wirklich gelöscht wird.
--
-- # Das Problem, das ohne diese Migration bliebe
--
-- Die Weiche (`storage/weiche.rs`) entscheidet anhand von
-- `attachments.ablage`, ob eine Datei warm oder kalt liegt. Beim LÖSCHEN
-- gibt es diese Zeile aber nicht mehr – das ist ja der Anlass. Der
-- Aufräumdienst bekommt nur einen Schlüssel aus `storage_muell` und sonst
-- nichts.
--
-- Ohne diese Angabe bliebe der Weiche nur eine von zwei Antworten, und beide
-- sind schlecht: Löscht sie nur warm, bleibt die kalte Fassung für immer
-- liegen, ohne dass es irgendwo auffiele – der Müllsammler meldet Erfolg, die
-- Storage Box wächst still weiter. Löscht sie vorsichtshalber immer beide,
-- zieht jede gelöschte Nachricht mit Anhang einen SFTP-Umlauf nach sich, für
-- eine Datei, die dort nie lag.
--
-- Mit der Angabe kann sie das Richtige tun und im Zweifel trotzdem beides.
--
-- Der Auslöser aus Migration 0013 schreibt jetzt `old.ablage` mit.

alter table storage_muell
  add column if not exists ablage text not null default 'lokal';

comment on column storage_muell.ablage is
  'Wo die Datei lag, als sie gelöscht wurde. Ohne das findet der Aufräumdienst die ferne Fassung nicht.';

-- Der Auslöser neu, mit der Ablage.
--
-- `create or replace` auf die Funktion aus 0013 (`attachment_in_muell`): Sie
-- behält ihren Namen, der Auslöser bleibt unverändert und zeigt danach auf
-- die neue Fassung. Einen zweiten Auslöser danebenzuhängen hiesse, jede
-- gelöschte Datei zweimal einzutragen.
create or replace function attachment_in_muell() returns trigger
language plpgsql as $$
begin
  -- `on conflict do nothing`: Zwei Zeilen könnten denselben Schlüssel
  -- tragen. Heute vergibt der Server je Anhang einen eigenen, aber diese
  -- Annahme soll nicht der Grund sein, warum ein Löschvorgang scheitert.
  insert into storage_muell (storage_key, ablage)
  values (old.storage_key, coalesce(old.ablage, 'lokal'))
  on conflict (storage_key) do nothing;
  return old;
end;
$$;

-- Der Index für die Frage der Weiche: „wo liegt dieser Schlüssel?"
--
-- Ausdrücklich NICHT `unique`. Migration 0013 rechnet damit, dass zwei Zeilen
-- denselben Schlüssel tragen könnten, und dieser Fall soll keinen Löschvorgang
-- zum Scheitern bringen.
create index if not exists attachments_storage_key_idx
  on attachments (storage_key);

create index if not exists storage_muell_key_idx
  on storage_muell (storage_key);
