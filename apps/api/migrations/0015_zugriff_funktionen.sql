-- Die Sichtbarkeit einer Sammlung – einmal definiert, in beide Richtungen.
--
-- Die rekursive Abfrage „welche Sammlungen darf X sehen" stand bisher wörtlich
-- in `visible_collection_ids` und noch einmal in der Medienprüfung. Zwei
-- Fassungen derselben Regel sind zwei Gelegenheiten, sie unterschiedlich
-- falsch zu beantworten – und genau das war schon einmal der Fall: Die eine
-- kannte Rechte an einer EINZELNEN Datei, die andere nicht.
--
-- Als Funktion in der Datenbank steht sie an einer Stelle und ist von beiden
-- Seiten aus benutzbar: vorwärts („was darf diese Person?") und rückwärts
-- („wer darf das hier?"). Die Rückrichtung ist neu und der eigentliche Grund
-- für diese Migration: Ohne sie müsste man über alle Konten hinweg fragen.
--
-- `stable`, nicht `volatile`: Innerhalb einer Anweisung ändert sich nichts,
-- der Planer darf das Ergebnis also wiederverwenden.

create or replace function sichtbare_sammlungen(betrachter uuid)
returns setof uuid
language sql
stable
as $$
  with recursive wurzeln as (
    select c.id
      from collections c
     where c.deleted_at is null
       and (
         c.created_by = betrachter
         or exists (
           select 1 from collection_grants g
            where g.collection_id = c.id and g.user_id = betrachter
         )
         or exists (
           select 1 from collection_grants g
             join conversation_members m
               on m.conversation_id = g.conversation_id and m.user_id = betrachter
            where g.collection_id = c.id and g.conversation_id is not null
         )
         or (
           c.member_level <> 'none'
           and exists (
             select 1 from conversation_members m
              where m.conversation_id = c.conversation_id and m.user_id = betrachter
           )
         )
       )
  ),
  baum as (
    select id from wurzeln
    union
    select c.id
      from collections c join baum b on c.parent_id = b.id
     where c.deleted_at is null
  )
  select id from baum;
$$;

-- Dieselbe Regel von hinten: Wer darf diese eine Sammlung sehen?
--
-- Geerbt wird nach unten, gefragt wird also nach oben: Die Kette sammelt die
-- Sammlung selbst und alle ihre Elternordner ein, und jedes Recht irgendwo in
-- dieser Kette trägt bis hierher.
create or replace function wer_sieht_sammlung(ziel uuid)
returns setof uuid
language sql
stable
as $$
  with recursive kette as (
    select c.id, c.parent_id, c.conversation_id, c.member_level, c.created_by
      from collections c
     where c.id = ziel and c.deleted_at is null
    union all
    select c.id, c.parent_id, c.conversation_id, c.member_level, c.created_by
      from collections c join kette k on c.id = k.parent_id
     where c.deleted_at is null
  )
  select k.created_by from kette k where k.created_by is not null
  union
  select g.user_id
    from collection_grants g join kette k on g.collection_id = k.id
   where g.user_id is not null
  union
  select m.user_id
    from collection_grants g
    join kette k on g.collection_id = k.id
    join conversation_members m on m.conversation_id = g.conversation_id
   where g.conversation_id is not null
  union
  select m.user_id
    from kette k join conversation_members m on m.conversation_id = k.conversation_id
   where k.member_level <> 'none';
$$;
