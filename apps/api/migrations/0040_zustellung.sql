-- Zugestellt und gelesen – je Mitglied ein Stand, und wann er vorrückte.
--
-- `delivered_message_id` ist das Gegenstück zu `last_read_message_id`: bis zu
-- welcher Nachricht ein Gerät dieses Mitglieds den Verlauf empfangen hat.
-- Beide Stände rücken nur vor (UUIDv7 ist zeitlich sortiert).
--
-- # Warum eine Verlaufstabelle
--
-- Ein Stand sagt, BIS WOHIN gelesen wurde, aber nicht, WANN eine bestimmte
-- Nachricht gelesen wurde: Der Zeitstempel des Stands gehört zur letzten
-- gelesenen Nachricht, nicht zu den älteren dahinter. Jedes Vorrücken legt
-- deshalb eine Zeile an (`bis` = neuer Stand, `am` = jetzt). Wann Nachricht M
-- gelesen wurde, ist dann die früheste Zeile mit `bis >= M` – genau der
-- Augenblick, in dem der Stand M überschritt.
--
-- Genauigkeit: der Zeitpunkt, zu dem die MELDUNG beim Server ankam. Der
-- Client bündelt Zustellmeldungen (höchstens alle paar Sekunden) und meldet
-- das Lesen, sobald der Chat sichtbar unten steht; offline Gelesenes zählt
-- ab der Rückkehr. Für Stände von vor dieser Migration gibt es keine Zeile –
-- die Oberfläche sagt dann „Zeit unbekannt“.
--
-- Der Auslöser hängt an der Mitgliederzeile selbst: Jede Stelle, die einen
-- Stand vorrückt (REST, Echtzeit-Leitung, künftige Wege), wird erfasst, ohne
-- dass sie davon wissen muss.
alter table conversation_members add column if not exists delivered_message_id uuid;

create table if not exists lesestand_verlauf (
  conversation_id uuid        not null,
  user_id         uuid        not null,
  art             text        not null check (art in ('zugestellt', 'gelesen')),
  bis             uuid        not null,
  am              timestamptz not null default now(),
  primary key (conversation_id, user_id, art, bis),
  -- Wer den Chat verlässt, nimmt seinen Verlauf mit.
  foreign key (conversation_id, user_id)
    references conversation_members (conversation_id, user_id) on delete cascade
);

create or replace function lesestand_vermerken() returns trigger as $$
begin
  if new.last_read_message_id is not null
     and new.last_read_message_id is distinct from old.last_read_message_id then
    insert into lesestand_verlauf (conversation_id, user_id, art, bis)
    values (new.conversation_id, new.user_id, 'gelesen', new.last_read_message_id)
    on conflict do nothing;
  end if;
  if new.delivered_message_id is not null
     and new.delivered_message_id is distinct from old.delivered_message_id then
    insert into lesestand_verlauf (conversation_id, user_id, art, bis)
    values (new.conversation_id, new.user_id, 'zugestellt', new.delivered_message_id)
    on conflict do nothing;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists lesestand_vermerken on conversation_members;
create trigger lesestand_vermerken
  after update of last_read_message_id, delivered_message_id on conversation_members
  for each row execute function lesestand_vermerken();
