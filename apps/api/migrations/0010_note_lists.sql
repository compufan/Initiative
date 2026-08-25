-- Listen in Notizen: Packliste, Aufgabenliste.
--
-- Eine Notiz war bisher ein Text. Für „Kleidung, Rucksack, Zahnbürste, und
-- jeder hakt einzeln ab“ genügt das nicht: Ein Text sagt nicht, wer schon
-- gepackt hat, und wer ihn ändert, tut es für alle zugleich.
--
-- # Warum eine Soll-Zahl je Punkt, und nicht je Liste
--
-- Weil die beiden Beispiele des Anwenders verschiedene Dinge sind und in
-- derselben Liste stehen können:
--
--   Packliste     „Zahnbürste“      – muss JEDER abhaken, es geht um sein
--                                     eigenes Gepäck.
--   Aufgabenliste „Kuchen backen“   – muss EINER abhaken, danach ist es
--                                     erledigt.
--
-- Deshalb steht die Soll-Zahl am einzelnen Punkt: In einer Liste kann „A“ von
-- allen, „B“ von dreien, „C“ von niemandem und „D“ von einer Person zu
-- erledigen sein.
--
-- `required_all` ist bewusst ein eigenes Feld und nicht die Zahl der aktuell
-- Eingeladenen. „Alle“ soll mitwachsen: Wer später eingeladen wird, muss
-- ebenfalls abhaken. Eine festgeschriebene 5 täte das nicht.

create table if not exists event_note_items (
  id             uuid primary key,
  note_id        uuid        not null references event_notes (id) on delete cascade,
  text           text        not null,
  position       integer     not null default 0,
  -- Wie viele müssen abhaken? 0 heisst: niemand muss, es ist nur eine Zeile.
  required_checks integer    not null default 0 check (required_checks >= 0),
  -- Schlägt die Zahl: alle Eingeladenen, auch die von morgen.
  required_all   boolean     not null default false,
  created_by     uuid references users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists event_note_items_note_idx
  on event_note_items (note_id, position, created_at);

create table if not exists event_note_checks (
  item_id    uuid        not null references event_note_items (id) on delete cascade,
  user_id    uuid        not null references users (id) on delete cascade,
  checked_at timestamptz not null default now(),
  primary key (item_id, user_id)
);
create index if not exists event_note_checks_user_idx on event_note_checks (user_id, item_id);

-- ---------------------------------------------------------------------------
-- Drei Rechte statt einem.
--
-- Bisher gab es nur „darf ändern“. Bei einer Liste sind das drei verschiedene
-- Fragen, und sie fallen auseinander: An einer Packliste dürfen alle abhaken,
-- aber nur der Verfasser Punkte hinzufügen – sonst steht am Abreisetag eine
-- Liste da, die niemand mehr überblickt.
--
-- `check_scope` kennt zusätzlich 'nobody': eine Liste, die nur gelesen wird.
-- ---------------------------------------------------------------------------
alter table event_notes
  add column if not exists add_scope text not null default 'author'
    check (add_scope in ('author', 'members', 'listed')),
  add column if not exists check_scope text not null default 'members'
    check (check_scope in ('nobody', 'author', 'members', 'listed'));

-- Die benannten Personen je Recht. Bisher war die Tabelle nur für „ändern“
-- da; mit der Rolle trägt sie alle drei, statt drei fast gleiche Tabellen zu
-- brauchen.
alter table event_note_editors
  add column if not exists role text not null default 'edit'
    check (role in ('edit', 'add', 'check'));

-- Der Primärschlüssel muss die Rolle mit aufnehmen, sonst kann dieselbe
-- Person nicht für zwei Rechte benannt werden.
--
-- Als Block mit Prüfung, weil `add primary key` kein `if not exists` kennt:
-- Eine Migration muss ein zweites Mal durchlaufen können, ohne zu scheitern –
-- sonst steht man beim nächsten Anlauf an einer Stelle fest, die längst
-- erledigt ist.
do $$
begin
  if exists (
    select 1 from pg_constraint
     where conname = 'event_note_editors_pkey'
       and conrelid = 'event_note_editors'::regclass
       and array_length(conkey, 1) = 2
  ) then
    alter table event_note_editors drop constraint event_note_editors_pkey;
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'event_note_editors_pkey'
       and conrelid = 'event_note_editors'::regclass
  ) then
    alter table event_note_editors add primary key (note_id, user_id, role);
  end if;
end $$;
