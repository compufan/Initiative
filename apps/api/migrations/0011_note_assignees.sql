-- „Das übernimmt Nora.“
--
-- Bisher liess sich nur eine ANZAHL festlegen: einer, drei, alle. Oft weiss man
-- aber schon, WER – und dann ist „einer muss“ die schlechtere Angabe: Es hakt
-- irgendwer ab, und niemand weiss hinterher, ob der Kuchen jetzt gebacken wird.
--
-- Sind Personen benannt, ersetzen sie die Zahl: Der Punkt gilt als erledigt,
-- wenn GENAU DIESE ihn abgehakt haben. Hakt jemand anderes ab, wird der Punkt
-- davon nicht fertig – sein Haken zaehlt trotzdem sichtbar, denn dass jemand
-- mitgeholfen hat, ist keine Falschangabe.

create table if not exists event_note_item_assignees (
  item_id uuid not null references event_note_items (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  primary key (item_id, user_id)
);
create index if not exists event_note_item_assignees_user_idx
  on event_note_item_assignees (user_id, item_id);

comment on table event_note_item_assignees is
  'Namentlich Zugewiesene. Sind welche eingetragen, schlagen sie required_checks und required_all.';
