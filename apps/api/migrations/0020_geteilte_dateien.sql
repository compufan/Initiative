-- Dieselbe Datei an zwei Orten, ohne sie zweimal abzulegen.
--
-- # Der Anlass
--
-- „Ein Foto aus einer Sammlung in einem Chat teilen" – ein Satz, hinter dem
-- eine Entscheidung steckt. Der Weg, den `messages` bisher kennt, geht nicht:
-- Dort bindet `create_message` einen Anhang an eine Nachricht, und zwar nur,
-- wenn er noch an keiner hängt und der Absender ihn selbst hochgeladen hat.
-- Ein Bild, das schon im Chat war oder von jemand anderem kam, liesse sich so
-- nie weitergeben.
--
-- Die naheliegende Antwort waere, die Bytes zu kopieren. Sie ist auch die
-- teuerste: Ein Video von zweihundert Megabyte, dreimal weitergegeben, liegt
-- viermal auf der Platte – auf derselben Platte, deren Enge der Grund für die
-- ganze Auslagerung war.
--
-- Also bekommt die zweite Zeile denselben `storage_key`. Es ist dieselbe
-- Datei, und sie weiss das jetzt auch: `quelle_id` zeigt auf das Original.
--
-- # Was daran gefährlich ist – und wo es abgefangen wird
--
-- Zwei Zeilen auf einer Datei heisst: Wer eine löscht, darf die Bytes nicht
-- anfassen, solange die andere steht. Genau das ist der Auslöser unten.
--
-- Und es heisst: Der Auslagerungsdienst darf dieselben Bytes nicht zweimal
-- zählen und nicht zweimal bewegen. Deshalb sieht er nur Originale an
-- (`quelle_id is null`) – und wenn er eine Datei bewegt, schreibt er die
-- Ablage bei ALLEN Zeilen mit diesem Schlüssel um. Sonst behauptete eine
-- Kopie weiter „lokal", während die Bytes längst drüben liegen, und die
-- Weiche glaubte ihr.

alter table attachments
  add column if not exists quelle_id uuid references attachments(id) on delete set null;

comment on column attachments.quelle_id is
  'Bei einer weitergegebenen Datei: das Original. Dieselben Bytes, derselbe storage_key.';

-- Für die Frage „ist das ein Original?" in jedem Durchgang des
-- Auslagerungsdienstes.
create index if not exists attachments_quelle_idx
  on attachments (quelle_id)
  where quelle_id is not null;

-- Der Auslöser aus 0013/0019 neu: Er räumt nicht mehr weg, was noch jemand
-- benutzt.
--
-- Ohne diese Bedingung genügte es, eine weitergegebene Nachricht zu löschen,
-- und das Original in der Sammlung wäre ein toter Verweis – die Zeile stünde
-- noch, die Bytes wären fort. Nicht als Fehlermeldung, sondern als Bild, das
-- nicht mehr lädt.
--
-- `id <> old.id` ist nötig, obwohl der Auslöser nach dem Löschen läuft: In
-- derselben Transaktion ist die Zeile für diese Abfrage je nach Sichtbarkeit
-- noch da. Die Bedingung kostet nichts und macht die Aussage unabhängig davon.
create or replace function attachment_in_muell() returns trigger
language plpgsql as $$
begin
  if exists (
    select 1 from attachments
     where storage_key = old.storage_key and id <> old.id
  ) then
    -- Jemand anders hält dieselbe Datei. Nur die Zeile geht, die Bytes
    -- bleiben.
    return old;
  end if;

  insert into storage_muell (storage_key, ablage)
  values (old.storage_key, coalesce(old.ablage, 'lokal'))
  on conflict (storage_key) do nothing;
  return old;
end;
$$;
