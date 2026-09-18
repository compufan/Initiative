-- Der Fernseher zeigt auch einen Chat, nicht nur eine Diashow.
--
-- # Woher der Wunsch kam
--
-- Wörtlich: „Füge die Option hinzu die gesamte App auf dem Fernseher zu
-- spiegeln um bspw. auch Chats auf dem Fernseher zeigen zu können."
--
-- Echtes Spiegeln – der Bildschirm des Telefons als Pixelstrom – kann eine
-- Web-App nicht; die Belege dafür stehen in docs/FEATURES.md. Was geht, ist
-- die ehrlichere und in Wahrheit bessere Fassung: eine ZWEITE ANSICHT, vom
-- Telefon ferngesteuert. Der ganze Unterbau dafür steht seit 0017 – Sitzung,
-- Code, Geheimnis, Fassungszähler, Fernbedienung. Es fehlte nur eine zweite
-- ART von Programm.
--
-- # Warum die Rechte hier ANDERS geprüft werden als bei Fotos
--
-- Bei einer Diashow wird einmal beim Einstellen geprüft und die Liste
-- eingefroren; die Begründung steht oben in 0017. Für einen Chat wäre das
-- falsch: Ein Gesprächsverlauf ist nichts, was man einfriert, und wer aus der
-- Gruppe austritt, dessen Fernseher soll in derselben Sekunde dunkel werden.
--
-- Deshalb steht hier nur die KENNUNG des Gesprächs, nicht sein Inhalt – und
-- bei jedem Abruf wird die Mitgliedschaft des Besitzers neu geprüft. Das ist
-- strenger als der Fotoweg und kostet nichts: Der Besitzer steht ohnehin in
-- der Zeile.
--
-- # Warum kein eigener Tisch
--
-- Weil es dieselbe Sitzung ist. Derselbe Code am Fernseher, dieselbe
-- Fernbedienung am Telefon, derselbe Zwei-Sekunden-Takt. Ein zweiter Tisch
-- hiesse, all das zweimal zu haben – und der Balken am unteren Rand, der eine
-- laufende Sitzung zurückholt, müsste an zwei Stellen suchen.

alter table fernsehsitzungen
  add column if not exists art text not null default 'diashow',
  add column if not exists gespraech_id uuid references conversations(id) on delete cascade,
  -- Bis wann der Chat auf dem Schirm stehen darf, unabhängig von der Sitzung.
  --
  -- Eine Sitzung lebt zwölf Stunden, und für eine Diashow ist das richtig: Wer
  -- morgens Urlaubsfotos anwirft, will sie abends noch am Laufen haben. Für
  -- Nachrichten ist es das Gegenteil des Richtigen – der Fernseher im
  -- Wohnzimmer zeigt sie sonst stundenlang weiter, während alle längst
  -- woanders sind und die Putzhilfe einschaltet.
  --
  -- Verlängert wird bei jedem Griff an die Fernbedienung; eine NEUE Nachricht
  -- verlängert ebenfalls, das rechnet die Abfrage aus `messages` (siehe
  -- `fernsehen::chat_stand`). Beides ist ein Zeichen, dass jemand da ist.
  add column if not exists chat_bis timestamptz;

-- Bestehende Zeilen sind Diashows. Ohne diese Zeile schlüge die Bedingung
-- unten auf einer laufenden Datenbank fehl – `art` hat zwar einen
-- Vorgabewert, aber das rettet nur die Spalte, nicht die Prüfung.
update fernsehsitzungen set art = 'diashow' where art is null or art not in ('diashow', 'chat');

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'fernsehsitzungen_art'
  ) then
    alter table fernsehsitzungen
      add constraint fernsehsitzungen_art check (art in ('diashow', 'chat'));
  end if;
  /*
   * Genau eines von beiden, nie beides und nie keines.
   *
   * Ohne diese Bedingung wäre „art = 'chat' ohne Gespräch" möglich – eine
   * Sitzung, die der Fernseher als Chat anzeigt und für die es keinen gibt.
   * Das fiele erst beim Abholen auf, als leerer Schirm ohne Begründung.
   */
  if not exists (
    select 1 from pg_constraint where conname = 'fernsehsitzungen_art_passt'
  ) then
    alter table fernsehsitzungen
      add constraint fernsehsitzungen_art_passt check (
        (art = 'chat' and gespraech_id is not null)
        or (art = 'diashow' and gespraech_id is null)
      );
  end if;
end
$$;

comment on column fernsehsitzungen.art is
  'diashow = Fotos und Videos aus `stuecke`, chat = der Verlauf von `gespraech_id`.';
comment on column fernsehsitzungen.gespraech_id is
  'Nur die Kennung, nie der Inhalt: Die Mitgliedschaft wird bei JEDEM Abruf neu geprüft.';
comment on column fernsehsitzungen.chat_bis is
  'Bis wann ein Chat-Programm stehen darf. Kürzer als die Sitzung – siehe die Migration.';
