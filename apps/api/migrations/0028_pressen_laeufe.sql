-- Pressen: jeder gewertete Lauf bleibt als eigene Zeile erhalten (Statistik).
--
-- # Warum eine eigene Tabelle
--
-- Bisher steht ein Lauf nur im Spielstand (`game_sessions.state`). Der ist
-- flüchtig: Übungen ohne Chat werden aufgeräumt (eine je Spiel und Person),
-- Partien können mit ihrem Chat verschwinden, und der Spielstand hält nur die
-- laufende und die letzte Atempo-Runde. Eine Statistik, die man „auch im
-- Nachhinein“ einsehen will, braucht deshalb ihren eigenen Speicher.
--
-- Der Server schreibt beim Abschluss einer Runde je gewerteter Person eine
-- Zeile – in derselben Transaktion, die den Spielstand speichert
-- (`persist_session`). Zwei Dinge halten das sauber:
--
--   * `pressen_laeufe_schluessel` (Sitzung, Runde, Person) ist eindeutig und
--     der Schreibweg ein `on conflict do nothing`: Ein Wiederholen, ein
--     doppelter Zug oder der Nachtrag unten doppelt nichts.
--   * Es werden NUR Runden geschrieben, die abgeschlossen sind. Fremde Zeiten
--     sind bis zum Rundenende verborgen (`fuer_betrachter`); die Zeilen
--     entstehen erst, wenn sie offen sind. Gelesen werden sie nur vom Konto,
--     dem die Zeile gehört (`user_id`).
--
-- # Was bewusst nicht gespeichert wird
--
-- Eine Trefferquote wird aus `verschuettet_dezi` abgeleitet (Glas = 300 ml,
-- getrunken ist, was nicht verschüttet wurde); die Simulation läuft nur im
-- Client und meldet keinen „Ort des Fehlschlags“. `start_art` ist
-- `echtzeit`, wenn es einen gemeinsamen Beginn gab (dann steckt ein Versatz im
-- Lauf), sonst `asynchron` (auch Spiegel, Ampel und Staffetten-Nachfolger
-- starten ab dem eigenen „Anstoßen“).
--
-- # Löschen
--
--   user_id     `on delete cascade`: das Konto löschen nimmt seine Läufe mit.
--   session_id  `on delete set null`: die Übung wird aufgeräumt, der Lauf
--               bleibt. Die Gegner stehen als Kennungen (`gegner_ids`) in der
--               Zeile selbst – ohne Fremdschlüssel, damit ein gelöschtes
--               Konto die Zeilen der anderen nicht berührt.
--
-- # Wiederholbar
--
-- `if not exists` und `on conflict do nothing`; ein zweiter Durchlauf tut
-- nichts.
create table if not exists pressen_laeufe (
  id                 uuid        primary key default gen_random_uuid(),
  user_id            uuid        not null references users (id) on delete cascade,
  session_id         uuid        references game_sessions (id) on delete set null,
  runde              integer     not null,
  sitz               integer     not null,
  modus              text        not null
                     check (modus in ('spiegel', 'duell', 'ampel', 'staffette')),
  start_art          text        not null check (start_art in ('echtzeit', 'asynchron')),
  gegner_ids         uuid[]      not null default '{}',
  team_ids           uuid[]      not null default '{}',
  dauer_ms           integer     not null,
  verschuettet_dezi  integer     not null,
  wertung_ms         integer     not null,
  reaktion_ms        integer,
  vorzeitig          boolean     not null default false,
  getruemmert        boolean     not null default false,
  malus_ms           integer     not null default 0,
  versatz_ms         integer     not null default 0,
  ausgang            text        not null
                     check (ausgang in ('sieg', 'niederlage', 'atempo', 'nicht_gewertet')),
  team_wertung_ms    bigint,
  gegner_wertung_ms  bigint,
  gespielt_am        timestamptz not null default now()
);

create unique index if not exists pressen_laeufe_schluessel
  on pressen_laeufe (session_id, runde, user_id);

create index if not exists pressen_laeufe_user_zeit_idx
  on pressen_laeufe (user_id, gespielt_am desc);

-- # Nachtrag aus den vorhandenen Sitzungen
--
-- Übernommen wird nur, was sich aus dem gespeicherten Spielstand SICHER
-- ableiten lässt:
--
--   * die entscheidende Runde jeder beendeten Partie (`status = 'finished'`):
--     Sieg/Niederlage steht in `sieger`, der Zeitpunkt ist `updated_at`
--     (der beendende Zug war der letzte Schreibvorgang);
--   * die letzte Runde einer laufenden Übung gegen den Spiegel
--     (`vorrunde`): jeder Spiegel-Zug schließt eine Runde, `updated_at` ist
--     also ihr Zeitpunkt.
--
-- Nicht übernommen: frühere Atempo-Runden (der Spielstand hält sie nicht),
-- Vorrunden beendeter Partien und abgebrochener Übungen (Zeitpunkt nicht
-- bekannt – `updated_at` wäre dort der Abbruch). Das fehlt ehrlich, statt
-- erfunden zu werden.
with runden as (
  select g.id as session_id,
         (g.state ->> 'runde')::integer as runde,
         g.state -> 'ergebnisse' as erg,
         g.updated_at as zeit,
         true as entschieden
    from game_sessions g
   where g.game_key = 'pressen'
     and g.status = 'finished'
     and g.state ->> 'fertig' = 'true'
     and jsonb_typeof(g.state -> 'ergebnisse') = 'array'
  union all
  select g.id,
         (g.state ->> 'runde')::integer - 1,
         g.state -> 'vorrunde',
         g.updated_at,
         false
    from game_sessions g
   where g.game_key = 'pressen'
     and g.status = 'active'
     and g.state ->> 'modus' = 'spiegel'
     and jsonb_typeof(g.state -> 'vorrunde') = 'array'
),
ergs as (
  select r.session_id, r.runde, r.zeit, r.entschieden,
         (e.nr - 1)::integer as seat, e.erg
    from runden r,
         jsonb_array_elements(r.erg) with ordinality as e (erg, nr)
   where jsonb_typeof(e.erg) = 'object'
     and not (e.erg ? 'verborgen')
),
sitze as (
  select g.id as session_id,
         (p ->> 'seat')::integer as seat,
         (p ->> 'userId')::uuid as user_id
    from game_sessions g,
         jsonb_array_elements(g.players) as p
   where g.game_key = 'pressen'
),
teams as (
  select g.id as session_id,
         (t.nr - 1)::integer as team,
         s.seat::integer as seat
    from game_sessions g,
         jsonb_array_elements(g.state -> 'teams') with ordinality as t (team, nr),
         jsonb_array_elements_text(t.team) as s (seat)
   where g.game_key = 'pressen'
)
insert into pressen_laeufe
  (user_id, session_id, runde, sitz, modus, start_art, gegner_ids, team_ids,
   dauer_ms, verschuettet_dezi, wertung_ms, reaktion_ms, vorzeitig, getruemmert,
   malus_ms, versatz_ms, ausgang, team_wertung_ms, gegner_wertung_ms, gespielt_am)
select u.id, e.session_id, e.runde, e.seat,
       g.state ->> 'modus',
       case when coalesce((e.erg ->> 'versatzMs')::integer, 0) > 0
            then 'echtzeit' else 'asynchron' end,
       array(select s2.user_id
               from teams t2
               join sitze s2 on s2.session_id = t2.session_id and s2.seat = t2.seat
              where t2.session_id = e.session_id
                and tm.team is not null
                and t2.team <> tm.team),
       array(select s2.user_id
               from teams t2
               join sitze s2 on s2.session_id = t2.session_id and s2.seat = t2.seat
              where t2.session_id = e.session_id
                and tm.team is not null
                and t2.team = tm.team
                and t2.seat <> e.seat),
       (e.erg ->> 'dauerMs')::integer,
       (e.erg ->> 'verschuettetDezi')::integer,
       (e.erg ->> 'wertungMs')::integer,
       (e.erg ->> 'reaktionMs')::integer,
       coalesce((e.erg ->> 'vorzeitig')::boolean, false),
       coalesce((e.erg ->> 'getruemmert')::boolean, false),
       coalesce((e.erg ->> 'verzoegerungMs')::integer, 0),
       coalesce((e.erg ->> 'versatzMs')::integer, 0),
       case
         when e.seat = (g.state ->> 'ampel')::integer then 'nicht_gewertet'
         when not e.entschieden then 'atempo'
         when (g.state -> 'sieger') @> to_jsonb(e.seat) then 'sieg'
         else 'niederlage'
       end,
       (select sum((x.erg ->> 'wertungMs')::bigint)
          from teams t2
          join ergs x on x.session_id = t2.session_id
                     and x.runde = e.runde and x.seat = t2.seat
         where t2.session_id = e.session_id and t2.team = tm.team),
       (select sum((x.erg ->> 'wertungMs')::bigint)
          from teams t2
          join ergs x on x.session_id = t2.session_id
                     and x.runde = e.runde and x.seat = t2.seat
         where t2.session_id = e.session_id and t2.team <> tm.team),
       e.zeit
  from ergs e
  join game_sessions g on g.id = e.session_id
  join sitze si on si.session_id = e.session_id and si.seat = e.seat
  join users u on u.id = si.user_id
  left join teams tm on tm.session_id = e.session_id and tm.seat = e.seat
on conflict (session_id, runde, user_id) do nothing;
