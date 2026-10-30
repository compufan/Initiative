-- Rückholen häufig gelesener ferner Dateien (Kaltablage → Platte).
--
-- # Zwei Dinge werden festgehalten
--
-- 1. **Wie oft eine ferne Datei gelesen wird** – in `anhang_lesen`, eine Zeile
--    je Datei und TAG. Gezählt wird nicht jede Bereichsanfrage (ein Video
--    erzeugt beim Abspielen Dutzende), sondern jeder ZUGRIFF: Anfragen auf
--    dieselbe Datei innerhalb von zehn Minuten sind ein Zugriff (siehe
--    `services::lesen`). Geschrieben wird gebündelt, höchstens einmal je
--    Minute und Datei, nie in der Anfrage selbst – sonst höbe jedes Vorspulen
--    eine Zeile an, und genau die heisse Stelle der App wäre die Datenbank.
--    Eine Zeile je Tag statt eines laufenden Zählers, weil „in den letzten N
--    Tagen" so genau beantwortet werden kann (Summe der letzten N Tage) und
--    alte Tage von selbst herausfallen (`services::lesen::aufraeumen`).
--
-- 2. **Wann eine Datei zuletzt zurückgeholt wurde** (`zurueckgeholt_at`).
--    Gegen das Hin und Her: Wer gerade zurückgeholt wurde, wird mindestens
--    14 Tage nicht wieder ausgelagert (`services::auslagern::kandidaten`);
--    wer gerade ausgelagert wurde (`ausgelagert_at`, seit 0018), wird
--    mindestens 7 Tage nicht zurückgeholt.

create table if not exists anhang_lesen (
  anhang_id uuid    not null references attachments (id) on delete cascade,
  tag       date    not null,
  zugriffe  integer not null default 0,
  primary key (anhang_id, tag)
);

create index if not exists anhang_lesen_tag_idx on anhang_lesen (tag);

alter table attachments
  add column if not exists zurueckgeholt_at timestamptz;

comment on column attachments.zurueckgeholt_at is
  'Wann die Datei zuletzt von der Kaltablage auf die Platte zurückgeholt wurde. Sperrt das erneute Auslagern für 14 Tage.';
