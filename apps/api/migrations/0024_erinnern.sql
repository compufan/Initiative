-- Erinnern: wer auf eine Einladung nicht antwortet, wird in seinem Einzelchat
-- mit dem Ersteller erinnert – wenn der Ersteller es für diesen Termin will.
--
-- # Was sich ändert
--
-- 1. Der Termin bekommt die Einstellung: nach wie vielen Stunden die erste
--    Erinnerung kommt (derselbe Abstand gilt zwischen allen weiteren) und wie
--    oft höchstens. Alles leer heisst: aus. Bestehende Termine bleiben also
--    stumm – kein Nachrichtenregen nach dem Einspielen.
-- 2. Eine Tabelle hält fest, welche Erinnerung an wen gegangen ist. Sie ist
--    zugleich das Beanspruchen: Der Schlüssel (Termin, Person, Nummer) lässt
--    jede Nummer genau einmal vergeben, auch wenn zwei Instanzen des Servers
--    im selben Augenblick danach greifen.
--
-- # Warum kein Zähler und kein Zeitstempel an `event_attendees`
--
-- Der Zähler wäre „wie viele“, der Zeitstempel „wann zuletzt“ – beides folgt
-- aus den Zeilen der Tabelle, und sie sagt zusätzlich, WELCHE Nachricht es war.
-- Ohne die Nachricht liesse sich beim Ausladen und Löschen nicht aufräumen:
-- Eine Erinnerung ist eine Karte im Einzelchat und soll mit dem Termin
-- verschwinden wie die Einladungskarte (0023).
--
-- # Rückwärtsverträglich
--
-- Alles hier ist `if not exists` oder prüft vorher; der zweite Durchlauf tut
-- nichts. Nichts wird zurückgefüllt: Wo keine Einstellung steht, passiert
-- nichts. Ein älterer Stand der Anwendung liest die neuen Spalten nicht und
-- läuft unverändert weiter.

-- ---------------------------------------------------------------------------
-- 1. Die Einstellung am Termin
--
--   erinnern_nach_std  Stunden bis zur ersten Erinnerung und zwischen den
--                      folgenden. Leer: aus. Die Grenzen (zwölf Stunden bis dreissig
--                      Tage) prüft der Server – hier nur, dass die Zahl etwas
--                      bedeutet. Wer die Grenzen später ändert, soll nicht
--                      dafür migrieren müssen.
--   erinnern_anzahl    Wie oft höchstens, je Person. Leer bei eingeschalteter
--                      Erinnerung: „bis zum Termin“ – der Server deckelt auch das
--                      (ERINNERN_ANZAHL_MAX).
--   erinnern_seit      Seit wann die Einstellung gilt. Jede Änderung (auch
--                      „wieder aufgenommen“ nach einer Absage) setzt sie neu,
--                      und die erste Erinnerung kommt frühestens eine Frist
--                      danach. Sonst löste das Einschalten bei Leuten, die
--                      schon lange offen sind, sofort eine Welle aus.
-- ---------------------------------------------------------------------------
alter table calendar_events
  add column if not exists erinnern_nach_std integer check (erinnern_nach_std > 0),
  add column if not exists erinnern_anzahl   smallint check (erinnern_anzahl > 0),
  add column if not exists erinnern_seit     timestamptz;

-- Alles oder nichts: Eine Anzahl ohne Frist oder eine Frist ohne Beginn wäre
-- ein halber Zustand, den jede Abfrage einzeln abfangen müsste.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'calendar_events_erinnern_check'
       and conrelid = 'calendar_events'::regclass
  ) then
    alter table calendar_events
      add constraint calendar_events_erinnern_check
      check ((erinnern_nach_std is null) = (erinnern_seit is null)
             and (erinnern_anzahl is null or erinnern_nach_std is not null));
  end if;
end $$;

-- Die Abfrage der Fälligen beginnt bei den Terminen, die überhaupt erinnern –
-- das sind wenige. Der Teilindex hält nur sie, geordnet nach Beginn (die
-- Schranke „nicht kurz vor Beginn“ wird dort angewendet).
create index if not exists calendar_events_erinnern_idx
  on calendar_events (starts_at)
  where erinnern_nach_std is not null and deleted_at is null;

-- ---------------------------------------------------------------------------
-- 2. Was erinnert wurde
--
-- Eine Zeile je Erinnerung, angelegt in dem Augenblick, in dem der Dienst sie
-- für sich beansprucht – VOR der Nachricht. `message_id` ist dann noch leer:
-- Bricht das Zustellen ab, bleibt die Zeile als offen sichtbar, und der
-- nächste Durchgang holt sie nach (höchstens dreimal). Der Schlüssel der
-- Nachricht ist die `id` der Zeile, so bleibt das Nachholen wiederholbar,
-- ohne eine zweite Karte zu erzeugen.
--
-- Der Fremdschlüssel auf die Teilnehmerzeile räumt auf: Wer ausgeladen wird,
-- verliert seine Zeilen – und bei einer neuen Einladung beginnt die Zählung
-- von vorn, denn das ist eine neue Einladung.
-- ---------------------------------------------------------------------------
create table if not exists event_erinnerungen (
  id              uuid        primary key,
  event_id        uuid        not null,
  user_id         uuid        not null,
  -- 1, 2, 3 … je Person und Termin. Zusammen mit Termin und Person der Schlüssel,
  -- an dem das Beanspruchen scheitert, wenn es schon ein anderer getan hat.
  nummer          smallint    not null check (nummer > 0),
  -- Der Einzelchat, in dem die Erinnerung steht (der der Einzelkarte).
  conversation_id uuid        not null references conversations (id) on delete cascade,
  message_id      uuid        references messages (id) on delete set null,
  -- Wann beansprucht – nach der Uhr, mit der der Durchgang rechnet.
  beansprucht_am  timestamptz not null,
  versuche        smallint    not null default 0,
  foreign key (event_id, user_id)
    references event_attendees (event_id, user_id) on delete cascade
);
create unique index if not exists event_erinnerungen_nummer_idx
  on event_erinnerungen (event_id, user_id, nummer);
create index if not exists event_erinnerungen_nachricht_idx
  on event_erinnerungen (message_id) where message_id is not null;
-- Die offenen Zeilen (Nachricht fehlt) sind selten; der Teilindex macht ihre
-- Suche billig.
create index if not exists event_erinnerungen_offen_idx
  on event_erinnerungen (beansprucht_am) where message_id is null;
