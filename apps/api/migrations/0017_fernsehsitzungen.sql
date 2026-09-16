-- Eine Diashow auf dem Fernseher, ohne fremdes SDK und ohne Konto am Gerät.
--
-- # Warum es diesen Tisch gibt
--
-- Ein Video lässt sich mit den eingebauten Mitteln des Browsers auf einen
-- Fernseher schicken (Remote Playback, AirPlay). Ein FOTO nicht: Beide Wege
-- kennen nur Medienelemente. Und eine Diashow schon gar nicht – dafür bräuchte
-- es eine Warteschlange, und die gibt es nur im Google-Cast-SDK. Das liegt auf
-- gstatic.com und müsste dauerhaft in `script-src`; in CSP.md steht über genau
-- diese Zeile „Die wichtigste Zeile. Kein fremdes Skript".
--
-- Der Weg, der ohne all das auskommt: Jeder Fernseher der letzten zehn Jahre
-- hat einen Browser. Das Blatt unter `/tv` ist eine gewöhnliche Seite, und
-- dieser Tisch ist das Band zwischen ihr und dem Telefon.
--
-- # Warum der Fernseher den Code macht und nicht das Telefon
--
-- Andersherum wäre es naheliegender: Das Telefon kennt die Sammlung, also
-- vergibt es den Code. Dann müsste ihn aber jemand mit einer Fernbedienung
-- eintippen – acht Zeichen auf einer Bildschirmtastatur, bei der man mit
-- Pfeiltasten von Buchstabe zu Buchstabe fährt. So herum tippt man auf dem
-- Telefon, und der Fernseher zeigt nur an.
--
-- # Warum ein Geheimnis NEBEN dem Code
--
-- Der Code steht gross auf dem Bildschirm und ist kurz genug zum Abtippen –
-- also auch kurz genug zum Raten. Wer ihn errät, dürfte sonst die Diashow
-- eines Fremden mitlesen.
--
-- Deshalb zwei Stücke: Der CODE taugt nur zum Verbinden (das Telefon sagt
-- „dieser Fernseher gehört mir"), das GEHEIMNIS zum Abholen der Inhalte. Das
-- Geheimnis entsteht beim Fernseher, steht nie auf dem Bildschirm und liegt
-- hier nur als Abdruck. Wer den Code errät, kann damit eine fremde Sitzung
-- stören – aber kein einziges Bild sehen.
--
-- # Warum die Stücke hier stehen und nicht nur die Sammlung
--
-- Weil die Rechte beim EINSTELLEN geprüft werden und nicht erst beim Abholen:
-- Der Fernseher hat kein Konto, also kann beim Abholen niemand gefragt
-- werden. Was einmal in der Liste steht, ist damit genau das, was die Person
-- am Telefon in dem Moment sehen durfte. Eine Sammlung, die sich später
-- ändert, ändert die laufende Diashow nicht – das ist gewollt.

create table if not exists fernsehsitzungen (
  code         text primary key,
  geheim_hash  text        not null,
  besitzer_id  uuid        references users(id) on delete cascade,
  stuecke      jsonb       not null default '[]'::jsonb,
  modus        text        not null default 'linear',
  -- Die Saat, mit der gemischt wird. Sie steht hier, damit Fernseher und
  -- Telefon dieselbe Reihenfolge errechnen – „Zufall" heisst nicht „auf
  -- jedem Gerät anders".
  saat         bigint      not null default 0,
  sekunden     integer     not null default 6,
  stelle       integer     not null default 0,
  pausiert     boolean     not null default false,
  -- Steigt bei jeder Änderung. Der Fernseher fragt im Sekundentakt nur nach
  -- dieser Zahl und holt die (viel grössere) Liste erst, wenn sie sich
  -- bewegt hat.
  fassung      bigint      not null default 0,
  gesehen_at   timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  gueltig_bis  timestamptz not null,
  constraint fernsehsitzungen_modus check (modus in ('linear', 'zufall'))
);

comment on table fernsehsitzungen is
  'Ein Fernseher, der auf ein Telefon wartet. Der Code steht auf dem Schirm, das Geheimnis nie.';
comment on column fernsehsitzungen.geheim_hash is
  'SHA-256 des Geheimnisses. Im Klartext steht es nur im Fernseher selbst.';
comment on column fernsehsitzungen.stuecke is
  'Die Liste, wie sie beim Einstellen geprüft wurde – nicht die Sammlung, die sich ändern kann.';

-- Zum Aufräumen: abgelaufene Sitzungen werden beim Anlegen der nächsten
-- weggeräumt, und dafür muss dieser Vergleich billig sein.
create index if not exists fernsehsitzungen_gueltig_bis_idx
  on fernsehsitzungen (gueltig_bis);

-- Wer eine laufende Sitzung sucht, sucht sie über die Person.
create index if not exists fernsehsitzungen_besitzer_idx
  on fernsehsitzungen (besitzer_id)
  where besitzer_id is not null;
