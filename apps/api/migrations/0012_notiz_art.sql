-- Notiz oder Liste: der Unterschied wird ausdrücklich, statt geraten.
--
-- Bisher gab es kein Typfeld. Ob etwas eine Notiz oder eine Liste war,
-- entschied allein, ob Punkte daran hingen – so stand es auch im gemeinsamen
-- Typ: „Die Punkte der Liste. Leer heisst: eine gewoehnliche Textnotiz.“
--
-- Das hat zwei Folgen, und beide sieht man der App an:
--
--   1. Jede reine Textnotiz trug Listen-Bedienelemente. Das Feld „Punkt
--      hinzufügen …“ wurde nur ausgeblendet, wenn keine Punkte da waren UND
--      man nicht ergänzen durfte – der Verfasser darf aber immer. Eine
--      Erinnerung an sich selbst sah dadurch aus wie eine halbfertige Liste.
--   2. Eine geplante, noch leere Liste war von einer Textnotiz nicht zu
--      unterscheiden. Die Absicht stand nirgends, sie wurde jedes Mal neu
--      erraten.
--
-- # Warum eine Spalte und nicht „hat Punkte“
--
-- Weil eine leere Liste eine Liste ist. Wer sie anlegt, um sie gleich zu
-- füllen, meint eine Liste – und die App soll ihm nicht das Textfeld einer
-- Notiz hinstellen, bis er den ersten Punkt eingetippt hat.

alter table event_notes
  add column if not exists kind text not null default 'note'
    check (kind in ('note', 'list'));

-- Alles, was heute schon Punkte trägt, war immer als Liste gemeint.
--
-- Das ist die gesamte Wanderung: ein UPDATE, kein Kopieren von Zeilen, kein
-- Umhängen von Fremdschlüsseln. Wiederholbar – ein zweiter Durchlauf ändert
-- nichts mehr, weil die Bedingung dann nicht mehr greift.
update event_notes n
   set kind = 'list'
 where n.kind = 'note'
   and exists (select 1 from event_note_items i where i.note_id = n.id);

-- Die Listen stehen fast immer beisammen in der Ansicht eines Termins.
create index if not exists event_notes_event_kind_idx
  on event_notes (event_id, kind);
