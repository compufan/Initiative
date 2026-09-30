-- Einladen: eine Einladung, mehrere Karten – und wer eingeladen ist, steht
-- allein in der Teilnehmerliste.
--
-- # Was sich ändert
--
-- Bisher hing die Sichtbarkeit eines Termins an zwei Dingen: der
-- Teilnehmerzeile ODER der Mitgliedschaft im Chat, an den er gebunden war. Damit
-- konnte niemand aus einer Gruppe „nicht eingeladen“ sein, und wer es doch war
-- (abgewählt, später beigetreten), sah den Termin trotzdem.
--
-- Jetzt gilt nur noch die Teilnehmerzeile (und der Ersteller). Der Chat ist
-- kein Zugang mehr, sondern höchstens ein Ort, an dem eine Karte steht – und
-- davon kann es mehrere geben: eine im Gruppenchat, eine je Person im
-- Einzelchat mit dem Ersteller.
--
-- # Warum eine eigene Tabelle für die Karten
--
-- `calendar_events.message_id` kennt genau eine Karte und wurde nie gelesen.
-- Wie bei den Umfragen (`poll_placements`, 0005) braucht jede Karte eine Zeile:
-- Ohne sie lässt sich weder sagen, wohin ein Termin gesendet wurde, noch eine
-- Karte nachführen oder beim Ausladen wieder einsammeln.
--
-- # Rückwärtsverträglich
--
-- Alles hier ist `if not exists` oder prüft vorher, der zweite Durchlauf tut
-- nichts. Bestehende Termine bleiben für dieselben Leute sichtbar: Wer bisher
-- nur als Chatmitglied Zugang hatte, bekommt eine Teilnehmerzeile (siehe 5).
-- `calendar_events.conversation_id` und `message_id` bleiben, wie sie sind.

-- ---------------------------------------------------------------------------
-- 1. Wann wurde eingeladen?
--
-- Die Erinnerungen (0024) rechnen „nach einer Weile“ ab diesem Zeitpunkt, und
-- ein nachträglich Eingeladener hat keinen Bezug zum Anlegen des Termins. Als
-- Block mit Prüfung, weil `add column` mit `not null` erst nach dem Füllen geht.
-- Bestehende Zeilen bekommen den Anlegezeitpunkt des Termins – das ist der
-- früheste Zeitpunkt, zu dem sie eingeladen worden sein können.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = current_schema()
       and table_name = 'event_attendees' and column_name = 'eingeladen_am'
  ) then
    alter table event_attendees add column eingeladen_am timestamptz;
    update event_attendees ea set eingeladen_am = e.created_at
      from calendar_events e where e.id = ea.event_id;
    update event_attendees set eingeladen_am = now() where eingeladen_am is null;
    alter table event_attendees alter column eingeladen_am set default now();
    alter table event_attendees alter column eingeladen_am set not null;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Stand und Wiederholungsschutz am Termin
--
-- `stand` zählt jede Änderung hoch, auch Zu- und Absagen (die `updated_at`
-- nicht berühren). Clients verwerfen einen Rundruf mit kleinerem Stand – sonst
-- überholt bei zwei fast gleichzeitigen Antworten die ältere Fassung die neuere.
--
-- `client_id` macht das Anlegen wiederholbar: Ein Doppelsenden (Funkloch,
-- Doppeltipp) liefert den schon angelegten Termin zurück, statt ihn und alle
-- Karten und Benachrichtigungen ein zweites Mal zu erzeugen.
-- ---------------------------------------------------------------------------
alter table calendar_events
  add column if not exists stand bigint not null default 0;
alter table calendar_events
  add column if not exists client_id text;
create unique index if not exists calendar_events_client_id_idx
  on calendar_events (created_by, client_id) where client_id is not null;

-- ---------------------------------------------------------------------------
-- 3. Der Chat reisst den Termin nicht mehr mit
--
-- `on delete cascade` machte den Chat zum Besitzer des Termins. Jetzt gehört der
-- Termin seinen Eingeladenen; der Chat ist ein Ort unter mehreren. Chats lassen
-- sich heute nicht löschen – die Fremdschlüssel-Regel soll trotzdem nicht
-- darauf warten, dass es jemand tut.
--
-- Gesucht wird der Fremdschlüssel über den Katalog und nicht über seinen Namen:
-- Wer die Datenbank aus einem älteren Stand aufgebaut hat, hat ihn womöglich
-- anders genannt, und ein zweiter Fremdschlüssel neben dem alten würde die
-- Kaskade nicht aufheben.
-- ---------------------------------------------------------------------------
do $$
declare
  fk record;
begin
  for fk in
    select c.conname
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
     where c.conrelid = 'calendar_events'::regclass
       and c.contype = 'f'
       and a.attname = 'conversation_id'
       and c.confdeltype <> 'n'
  loop
    execute format('alter table calendar_events drop constraint %I', fk.conname);
  end loop;

  if not exists (
    select 1
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
     where c.conrelid = 'calendar_events'::regclass
       and c.contype = 'f'
       and a.attname = 'conversation_id'
  ) then
    alter table calendar_events
      add constraint calendar_events_conversation_id_fkey
      foreign key (conversation_id) references conversations (id) on delete set null;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Die Karten eines Termins
--
--   gruppe – die Karte im Gruppenchat; steht nur dort, wo ALLE, die sie sehen
--            können, eingeladen sind.
--   einzel – die Karte im Einzelchat zwischen Ersteller und `user_id`.
--
-- Eine Zeile wird vor der Nachricht angelegt (`message_id` ist dann noch leer):
-- Bricht das Zustellen ab, bleibt sichtbar, was noch aussteht, und ein
-- zweiter Anlauf legt keine zweite Karte an.
-- ---------------------------------------------------------------------------
create table if not exists event_placements (
  id              uuid primary key,
  event_id        uuid        not null references calendar_events (id) on delete cascade,
  conversation_id uuid        not null references conversations (id) on delete cascade,
  message_id      uuid references messages (id) on delete set null,
  art             text        not null check (art in ('gruppe', 'einzel')),
  -- Bei `einzel` das Gegenüber des Erstellers, sonst leer.
  user_id         uuid references users (id) on delete cascade,
  created_by      uuid references users (id) on delete set null,
  created_at      timestamptz not null default now(),
  check ((art = 'einzel') = (user_id is not null))
);
-- Zweimal dieselbe Karte im selben Chat wäre nur verwirrend.
create unique index if not exists event_placements_chat_idx
  on event_placements (event_id, conversation_id);
-- Eine Einzelkarte je Person – auch wenn es zwei Einzelchats mit ihr gibt.
create unique index if not exists event_placements_person_idx
  on event_placements (event_id, user_id) where art = 'einzel';
create index if not exists event_placements_conversation_idx
  on event_placements (conversation_id);
create index if not exists event_placements_message_idx
  on event_placements (message_id) where message_id is not null;

-- ---------------------------------------------------------------------------
-- 5. Wer bisher nur über den Chat Zugang hatte, wird Teilnehmer
--
-- Sonst verlören genau diese Leute ihren Termin. Gemeint sind die HEUTIGEN
-- Mitglieder; wer nach dem Einspielen dazukommt, ist nicht eingeladen – das ist
-- die neue Regel und der Zweck der Änderung. Die Zusage steht auf „offen“: Wer
-- nie gefragt wurde, hat nicht zugesagt.
-- ---------------------------------------------------------------------------
insert into event_attendees (event_id, user_id, status)
select e.id, cm.user_id, 'pending'
  from calendar_events e
  join conversation_members cm on cm.conversation_id = e.conversation_id
 where e.conversation_id is not null and e.deleted_at is null
on conflict (event_id, user_id) do nothing;

-- ---------------------------------------------------------------------------
-- 6. Die vorhandenen Karten eintragen
--
-- Aus den Nachrichten selbst, nicht aus `calendar_events.message_id`: Letzteres
-- kennt nur die erste Karte, und die Nachrichtenschnittstelle liess bisher
-- beliebig viele zu. Der Vergleich läuft über den Text der Kennung – ein
-- Schlüssel, der keine UUID ist, darf die Migration nicht abbrechen.
--
-- Einzelkarte heisst: Einzelchat mit genau zwei Mitgliedern, eines davon der
-- Ersteller. Alles andere gilt als Gruppenkarte. Die Kennung ist aus der der
-- Nachricht abgeleitet, damit ein zweiter Durchlauf dieselben Zeilen meint.
-- ---------------------------------------------------------------------------
insert into event_placements
  (id, event_id, conversation_id, message_id, art, user_id, created_by, created_at)
select md5('event_placements:' || m.id::text)::uuid,
       e.id,
       m.conversation_id,
       m.id,
       case when k.einzel then 'einzel' else 'gruppe' end,
       case when k.einzel then k.gegenueber end,
       m.sender_id,
       m.created_at
  from messages m
  join calendar_events e on e.id::text = m.metadata ->> 'eventId'
  join lateral (
    select c.type = 'direct'
             and (select count(*) from conversation_members x
                   where x.conversation_id = c.id) = 2
             and exists (select 1 from conversation_members x
                          where x.conversation_id = c.id and x.user_id = e.created_by)
             as einzel,
           (select x.user_id from conversation_members x
             where x.conversation_id = c.id and x.user_id <> e.created_by
             limit 1) as gegenueber
      from conversations c
     where c.id = m.conversation_id
  ) k on true
 where m.type = 'event' and m.deleted_at is null and e.deleted_at is null
 order by m.id
on conflict do nothing;
