-- Erinnerung vor dem Termin: der Server liefert `calendar_events.reminder_minutes`
-- selbst aus (Push und stille Karte im Einzelchat), nicht mehr nur im
-- Kalenderabo (.ics).
--
-- # Was sich ändert
--
-- Eine Tabelle hält fest, welche Erinnerung an wen gegangen ist. Sie ist
-- zugleich das Beanspruchen, wie `event_erinnerungen` (0024): Der Schlüssel
-- lässt jede Erinnerung genau einmal vergeben, auch wenn zwei Instanzen des
-- Servers im selben Augenblick danach greifen.
--
-- # Warum `beginn` im Schlüssel steht
--
-- Schlüssel ist (Termin, Person, Minuten, Beginn): Ein unveränderter Termin
-- erinnert nie doppelt, ein verschobener (anderer `starts_at`) erinnert erneut –
-- ohne dass die Zeilen beim Verschieben angefasst werden müssten. Bei einer
-- Serie gilt nur der erste Beginn (wie beim Erinnern an Antworten).
--
-- # Warum eine eigene `id`
--
-- Der feste Schlüssel der Karte (`client_id`) hängt an ihr und nicht am
-- zusammengesetzten Schlüssel: Wer ausgeladen und wieder eingeladen wird, soll
-- eine neue Karte bekommen und nicht die gelöschte von damals zurück.
--
-- # Rückwärtsverträglich
--
-- Alles hier ist `if not exists`; der zweite Durchlauf tut nichts. Nichts wird
-- zurückgefüllt: Termine, deren Erinnerung schon vor dem Einspielen fällig war,
-- bekommen keine nachträgliche (der Dienst sendet höchstens eine Stunde nach der
-- Fälligkeit). Ein älterer Stand der Anwendung kennt die Tabelle nicht und läuft
-- unverändert weiter.
--
--   message_id   Die stille Karte im Einzelchat. Leer, wenn es keinen gibt (der
--                Ersteller selbst, Einzelchats abgewählt) – dann ging nur ein Push.
--   gesendet_am  Wann beansprucht (und damit gesendet), nach der Uhr des Durchgangs.
create table if not exists event_vorab_erinnerungen (
  id          uuid        not null default gen_random_uuid(),
  event_id    uuid        not null references calendar_events (id) on delete cascade,
  user_id     uuid        not null references users (id) on delete cascade,
  minuten     integer     not null check (minuten > 0),
  beginn      timestamptz not null,
  message_id  uuid        references messages (id) on delete set null,
  gesendet_am timestamptz not null,
  primary key (event_id, user_id, minuten, beginn)
);
create unique index if not exists event_vorab_erinnerungen_id_idx
  on event_vorab_erinnerungen (id);
-- Aufräumen beim Ausladen/Löschen sucht über (Termin, Person) – das deckt der
-- Schlüssel ab; die Kaskade beim Löschen einer Person braucht den eigenen Index.
create index if not exists event_vorab_erinnerungen_person_idx
  on event_vorab_erinnerungen (user_id);
create index if not exists event_vorab_erinnerungen_nachricht_idx
  on event_vorab_erinnerungen (message_id) where message_id is not null;
