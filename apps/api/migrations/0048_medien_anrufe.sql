-- Medienübersicht, Anrufe und drei Restpunkte der Atomaritäts-Prüfung.
--
-- # `attachments.wandert_seit` – hängende Umzüge
--
-- `ablage = 'wandert'` hiess bisher nur „gerade unterwegs“ – ohne Zeitpunkt.
-- Stürzte der Prozess mitten im Umzug ab, blieb die Zeile für immer so
-- stehen: Sie wurde nie wieder ausgewählt (die Auswahl nimmt nur `lokal`),
-- und die Weiche behandelte sie beim Löschen als unklar. Mit dem Zeitpunkt
-- setzt der Auslagerungsdienst solche Zeilen nach einer Frist auf `lokal`
-- zurück (`services::auslagern::haengende_zuruecksetzen`). Der Zeitpunkt ist
-- zugleich die Marke des Umzugs: Abschliessen und Zurücknehmen gelten nur,
-- solange er noch derselbe ist – eine zweite Instanz, die die Zeile nach der
-- Frist neu beansprucht hat, wird nicht überschrieben.
--
-- # `attachments.empfang_seit` – ein Upload je Anhang
--
-- Zwei gleichzeitige Uploads auf denselben `pending`-Anhang schrieben beide
-- in denselben Speicherschlüssel; wer zuletzt fertig wurde, gewann, und die
-- Grösse in der Zeile konnte zum anderen gehören. Der Upload beansprucht die
-- Zeile jetzt mit einem bedingten Update; ein zweiter bekommt 409.
--
-- # `anrufe` – 1:1-Anrufe
--
-- Der Server vermittelt nur die Signalisierung (WebRTC); Ton und Bild gehen
-- zwischen den Geräten bzw. über TURN. Die Zeile hält den Zustand fest, damit
-- „verpasst“, „besetzt“ und die Dauer genau einmal als Systemzeile im Chat
-- landen (`nachricht_id`), auch wenn mehrere Instanzen laufen.
--
-- Wiederholbar: Jede Anweisung prüft selbst, ob es sie schon gibt.

alter table attachments add column if not exists wandert_seit timestamptz;
alter table attachments add column if not exists empfang_seit timestamptz;

-- Bestehende Zeilen, die schon jetzt auf `wandert` stehen, stammen aus einem
-- abgebrochenen Umzug von vor dieser Migration: Sie bekommen den Zeitpunkt
-- der Migration und fallen damit nach der Frist zurück auf `lokal`.
update attachments set wandert_seit = now()
 where ablage = 'wandert' and wandert_seit is null;

create index if not exists attachments_wandert_idx
  on attachments (wandert_seit) where ablage = 'wandert';

create table if not exists anrufe (
  id              uuid primary key,
  conversation_id uuid        not null references conversations (id) on delete cascade,
  anrufer_id      uuid        references users (id) on delete set null,
  angerufener_id  uuid        references users (id) on delete set null,
  video           boolean     not null default false,
  status          text        not null default 'klingelt',
  begonnen_at     timestamptz not null default now(),
  angenommen_at   timestamptz,
  beendet_at      timestamptz,
  nachricht_id    uuid        references messages (id) on delete set null,
  -- Die Sitzungsbeschreibungen (SDP) liegen hier und nicht im Echtzeit-
  -- Ereignis: Über den Postgres-Bus darf ein Ereignis höchstens ~8000 Bytes
  -- haben, ein SDP mit Video ist oft grösser. Das Ereignis sagt nur, dass es
  -- eines gibt; das Gerät holt es über `GET /anrufe/{id}`.
  angebot_sdp     text,
  antwort_sdp     text
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'anrufe_status') then
    alter table anrufe add constraint anrufe_status
      check (status in ('klingelt', 'verbunden', 'beendet', 'verpasst', 'abgelehnt', 'besetzt'));
  end if;
end $$;

create index if not exists anrufe_conversation_idx on anrufe (conversation_id);
create index if not exists anrufe_anrufer_idx on anrufe (anrufer_id);
create index if not exists anrufe_angerufener_idx on anrufe (angerufener_id);
create index if not exists anrufe_nachricht_idx on anrufe (nachricht_id);
-- Die offenen Anrufe – für „besetzt“ und das Zeitlimit beim Klingeln.
create index if not exists anrufe_offen_idx
  on anrufe (begonnen_at) where status in ('klingelt', 'verbunden');
