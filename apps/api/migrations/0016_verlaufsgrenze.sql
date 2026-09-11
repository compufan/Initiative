-- Wer neu dazukommt, sieht ab jetzt – und kann den Verlauf beantragen.
--
-- # Die Regel
--
-- Bisher sah jeder neu Beigetretene den ganzen bisherigen Verlauf: Die
-- Sichtbarkeit hing allein an der Mitgliedschaft, `joined_at` stand da und
-- wurde nie ausgewertet. Wer eine Gruppe nach zwei Jahren betritt, las damit
-- zwei Jahre mit.
--
-- Jetzt ist die Voreinstellung umgekehrt, und `sieht_ab` trägt die Grenze:
--
--   * `sieht_ab = <Zeitpunkt>`: nur Nachrichten ab diesem Zeitpunkt.
--   * `sieht_ab is null`: alles, auch was vorher war.
--
-- # Warum eine Spalte und keine Leihtabelle
--
-- Der ganze Verlauf lässt sich damit mit EINEM `update` verleihen – eine
-- Zeile, nicht eine je Nachricht. Das ist der Kern: Verliehen wird der
-- Behälter, nicht sein Inhalt. Eine Tabelle mit einer Zeile je Nachricht
-- müsste bei jedem Beitritt tausende Zeilen nachtragen und bei jeder
-- Rücknahme wieder einsammeln – und jede vergessene Rücknahme wäre ein
-- stiller, offener Zugriff.
--
-- # Warum bestehende Mitgliedschaften `null` bekommen
--
-- Sie sehen heute alles. Eine Umstellung, die ihnen rückwirkend etwas
-- wegnimmt, wäre für die Beteiligten nicht von einem Fehler zu unterscheiden:
-- Ein Verlauf, den man gestern noch lesen konnte, ist heute weg, ohne dass
-- jemand etwas getan hat. Die neue Regel gilt deshalb nur für Beitritte ab
-- jetzt.

alter table conversation_members
  add column if not exists sieht_ab timestamptz;

comment on column conversation_members.sieht_ab is
  'Ab wann diese Person den Verlauf sieht. NULL heisst: von Anfang an.';

-- Nachträge zum Verlauf werden beantragt, nicht vergeben.
--
-- Zustimmen müssen ALLE anderen Mitglieder. Wer das ist, wird beim Auszählen
-- bestimmt und nicht beim Stellen festgeschrieben: Tritt jemand während eines
-- offenen Antrags bei, muss auch er zustimmen; tritt jemand aus, zählt seine
-- Stimme nicht mehr. Dieselbe Entscheidung wie überall hier – die heutige
-- Lage gilt, nicht eine gespeicherte von damals.
create table if not exists verlaufsantraege (
  id              uuid primary key,
  conversation_id uuid        not null references conversations (id) on delete cascade,
  antragsteller   uuid        not null references users (id) on delete cascade,
  status          text        not null default 'offen'
                    check (status in ('offen', 'angenommen', 'abgelehnt', 'zurueckgezogen')),
  created_at      timestamptz not null default now(),
  entschieden_at  timestamptz
);

create index if not exists verlaufsantraege_gespraech_idx
  on verlaufsantraege (conversation_id, status);

-- Höchstens ein offener Antrag je Person und Gespräch – sonst liesse sich die
-- Gruppe mit Anfragen überschütten.
create unique index if not exists verlaufsantraege_offen_idx
  on verlaufsantraege (conversation_id, antragsteller)
  where status = 'offen';

create table if not exists verlaufsstimmen (
  antrag_id  uuid        not null references verlaufsantraege (id) on delete cascade,
  user_id    uuid        not null references users (id) on delete cascade,
  zustimmung boolean     not null,
  created_at timestamptz not null default now(),
  primary key (antrag_id, user_id)
);
