-- Hochladen in Stücken: fortsetzbar, ohne die Datei im Arbeitsspeicher.
--
-- # Warum eine Sitzung in der Datenbank
--
-- Ein Video von mehreren Gigabyte geht nicht in einer Anfrage durch. Das Netz
-- reisst, das Telefon schläft ein, die App wird neu geladen – und dann soll
-- der Upload dort weitermachen, wo er war, und nicht bei null. Dafür muss der
-- Server sich merken, WAS schon da ist, und zwar über einen Neustart des
-- Prozesses hinweg. Die Bytes selbst liegen in einer Teildatei auf der Platte
-- (`UPLOAD_TEILE_DIR`), hier steht nur die Buchführung.
--
-- # Warum eine Zeile je Stück und kein Zähler
--
-- Weil Stücke in beliebiger Reihenfolge und gleichzeitig ankommen (der Client
-- schickt zwei, drei parallel). Ein Zähler „empfangen bis Byte n" kennt keine
-- Lücken; eine Zeile je Stück mit Primärschlüssel macht das Wiederholen eines
-- Stückes von selbst folgenlos (`on conflict do nothing`).
--
-- Der zugehörige Anhang entsteht gleich beim Anlegen (Zustand `pending`), damit
-- der Speicherschlüssel feststeht und alle Rechteprüfungen der Auslieferung
-- unverändert greifen. Wird der Anhang gelöscht, verschwindet die Sitzung mit
-- (`on delete cascade`); die Teildatei räumt der Aufräumdienst weg.

create table if not exists upload_sitzungen (
  id              uuid        primary key,
  user_id         uuid        not null references users (id) on delete cascade,
  attachment_id   uuid        not null references attachments (id) on delete cascade,
  kind            text        not null,
  mime            text        not null,
  file_name       text,
  groesse         bigint      not null check (groesse > 0),
  stueck_groesse  integer     not null check (stueck_groesse > 0),
  -- Hex, klein geschrieben. Fehlt sie, wird beim Abschluss nicht geprüft.
  sha256          text,
  -- offen → abschluss → fertig. `abschluss` sperrt gegen einen zweiten
  -- gleichzeitigen Abschluss; `fertig` bleibt stehen, damit ein wiederholter
  -- Abschluss (Antwort unterwegs verloren) den Anhang noch einmal bekommt.
  status          text        not null default 'offen'
                    check (status in ('offen', 'abschluss', 'fertig')),
  angelegt_at     timestamptz not null default now(),
  -- Letzte Bewegung. Nach dieser Zeit plus Frist gilt die Sitzung als
  -- verwaist und wird samt Teildatei weggeräumt.
  aktualisiert_at timestamptz not null default now()
);

create index if not exists upload_sitzungen_user_idx on upload_sitzungen (user_id);
create index if not exists upload_sitzungen_attachment_idx on upload_sitzungen (attachment_id);
create index if not exists upload_sitzungen_alter_idx on upload_sitzungen (aktualisiert_at);

create table if not exists upload_stuecke (
  sitzung_id uuid    not null references upload_sitzungen (id) on delete cascade,
  nr         integer not null check (nr >= 0),
  laenge     integer not null check (laenge > 0),
  primary key (sitzung_id, nr)
);
