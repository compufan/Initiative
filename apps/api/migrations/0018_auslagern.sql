-- Zwei Ablagen statt einer: schnell auf dem Server, gross daneben.
--
-- # Warum
--
-- Der Server hat 256 GB, und im Testbetrieb sind schon sechzig davon weg. Was
-- sie wegnimmt, sind nicht die Nachrichten – die stehen als Text in dieser
-- Datenbank und sind gegen ein einziges Video ein Rundungsfehler. Es sind die
-- ANHÄNGE. Läuft die Platte voll, nimmt die App keine Datei mehr an, und das
-- trifft alle zugleich.
--
-- Daneben liegt eine Storage Box: langsamer, dafür gross. Diese Migration gibt
-- jedem Anhang die zwei Angaben, die es braucht, um ihn dorthin und wieder
-- zurück zu bewegen.
--
-- # `ablage`: wo die Bytes liegen
--
-- `lokal` heisst: auf dem Server, wie bisher. `fern` heisst: auf der Storage
-- Box. Der Schlüssel (`storage_key`) bleibt derselbe – es ist dieselbe Datei
-- an einem anderen Ort, nicht eine zweite. Damit ändert sich für alles, was
-- den Schlüssel benutzt, gar nichts; nur die Auslieferung sieht nach, wo sie
-- ihn suchen muss.
--
-- `wandert` ist der Zustand DAZWISCHEN. Ohne ihn gäbe es ein Fenster, in dem
-- die Datei schon drüben, aber noch als `lokal` eingetragen ist – oder
-- umgekehrt. Wer in diesem Fenster abruft, bekäme eine 404 für eine Datei,
-- die es gibt. Mit dem Zustand liest die Auslieferung weiter aus der
-- lokalen Fassung, bis der Wechsel wirklich fertig ist.
--
-- # `prioritaet`: was der Mensch dazu sagt
--
-- Die Gewichtung (Grösse, Alter) rechnet der Server. Was er nicht wissen kann,
-- ist, was jemandem wichtig ist – die Bilder vom Geburtstag der Grossmutter
-- sind alt und gross, also nach jeder Formel die ersten Kandidaten.
--
--   * `niedrig` – wandert sofort, ohne auf eine Grenze zu warten. Die
--     Einstellung heisst „das darf langsam sein".
--   * `normal` – wandert ab hundert Gigabyte, nach Gewicht.
--   * `hoch` – wandert erst ab hundertzwanzig, und auch dann nur, wenn nichts
--     Normales mehr da ist.
--
-- Die Priorität hängt am ANHANG und nicht am Sammlungseintrag, obwohl man sie
-- in einer Sammlung einstellt. Der Grund ist einfach: Es gibt die Datei nur
-- einmal. Läge sie in zwei Sammlungen mit verschiedener Priorität, müsste der
-- Server entscheiden, welche gilt – und was er auch entschiede, für eine der
-- beiden Seiten wäre es falsch.

alter table attachments
  add column if not exists ablage text not null default 'lokal',
  add column if not exists prioritaet text not null default 'normal',
  add column if not exists ausgelagert_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'attachments_ablage_check') then
    alter table attachments
      add constraint attachments_ablage_check check (ablage in ('lokal', 'wandert', 'fern'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'attachments_prioritaet_check') then
    alter table attachments
      add constraint attachments_prioritaet_check
      check (prioritaet in ('niedrig', 'normal', 'hoch'));
  end if;
end $$;

comment on column attachments.ablage is
  'lokal | wandert | fern – wo die Bytes liegen. Der Schlüssel bleibt derselbe.';
comment on column attachments.prioritaet is
  'niedrig | normal | hoch – wie ungern diese Datei ausgelagert wird.';
comment on column attachments.ausgelagert_at is
  'Wann sie hinübergewandert ist. NULL, solange sie lokal liegt.';

-- Der Index für die Frage „was wandert als nächstes".
--
-- Nur auf dem, was überhaupt in Frage kommt: fertige Anhänge, die noch lokal
-- liegen. Ein Index über die ganze Tabelle wäre um ein Vielfaches grösser und
-- beantwortete dieselbe Frage nicht schneller.
create index if not exists attachments_auslagern_idx
  on attachments (prioritaet, created_at, size desc)
  where ablage = 'lokal' and status = 'ready';

-- Und für die Frage „wie viel liegt gerade lokal".
--
-- Ohne ihn liest Postgres bei jedem Durchgang des Auslagerungsdienstes die
-- ganze Tabelle. Mit ihm reicht der Index selbst, weil `size` darin steht.
create index if not exists attachments_lokal_groesse_idx
  on attachments (ablage, status) include (size);
