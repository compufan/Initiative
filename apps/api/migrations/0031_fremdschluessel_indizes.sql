-- Indizes für Fremdschlüssel auf `users`, die beim Löschen eines Kontos
-- gebraucht werden.
--
-- Wer ein Konto löscht (selbst, Art. 17, oder über die Verwaltung), löst für
-- jeden Fremdschlüssel auf `users` ein `on delete cascade` oder
-- `on delete set null` aus. Postgres sucht die betroffenen Zeilen dann über
-- die Spalte des Fremdschlüssels – und hat es für die folgenden keinen Index,
-- liest es die GANZE Tabelle. Bei `messages`, `reactions` und `poll_votes`
-- heisst das: einmal durch alles, was je geschrieben wurde, und das unter
-- einer Zeilensperre auf dem Konto.
--
-- # Welche, und welche bewusst nicht
--
-- Aufgenommen ist, was mit der Nutzung wächst (je Nachricht, Stimme,
-- Reaktion, Termin, Ausgabe, Notiz …). Für Spalten, die nur selten gesetzt
-- sind (`set null`-Spalten wie `settled_by`), ist der Index teilweise
-- (`where … is not null`): Die Suche des Fremdschlüssels lautet `spalte = $1`,
-- und daraus folgt `is not null` – der Planer nimmt den kleinen Index.
--
-- Bewusst NICHT:
--   * `game_sessions.turn_user_id` – wechselt bei jedem Zug. Ein Index darauf
--     verhindert die HOT-Aktualisierung genau des häufigsten Schreibvorgangs
--     der Tabelle, und die Tabelle ist klein (eine Zeile je Partie).
--   * `webauthn_states.user_id` – kurzlebige Zeilen einer laufenden
--     Passkey-Anmeldung; die Tabelle ist fast immer leer.
--   * `invite_codes.created_by`, `invite_redemptions.user_id`,
--     `collection_grants.granted_by`, `verlaufsantraege.antragsteller`,
--     `verlaufsstimmen.user_id` – Verwaltungs- bzw. Ausnahmevorgänge mit
--     wenigen Zeilen; ein Durchlauf kostet dort weniger als jeder Index bei
--     jedem Schreiben.
--
-- Schreibkosten: je Zeile ein Eintrag mehr in einem schmalen B-Baum. Für
-- `messages` ist das der dritte Index neben `(conversation_id, id)` und
-- `(conversation_id, created_at)`; teilweise, weil Systemzeilen ohne Absender
-- nicht hinein müssen.
--
-- Wie 0029 ohne `concurrently`: sqlx führt jede Migration in einer
-- Transaktion aus, und ein abgebrochener nebenläufiger Aufbau hinterliesse
-- einen ungültigen Index, den `if not exists` danach für fertig hielte.

create index if not exists messages_sender_idx
  on messages (sender_id) where sender_id is not null;
create index if not exists reactions_user_idx on reactions (user_id);
create index if not exists poll_votes_user_idx on poll_votes (user_id);

create index if not exists conversations_created_by_idx
  on conversations (created_by) where created_by is not null;
create index if not exists polls_created_by_idx
  on polls (created_by) where created_by is not null;
create index if not exists poll_options_created_by_idx
  on poll_options (created_by) where created_by is not null;
create index if not exists poll_placements_created_by_idx
  on poll_placements (created_by) where created_by is not null;

create index if not exists event_placements_user_idx
  on event_placements (user_id) where user_id is not null;
create index if not exists event_placements_created_by_idx
  on event_placements (created_by) where created_by is not null;
create index if not exists event_notes_author_idx
  on event_notes (author_id) where author_id is not null;
create index if not exists event_note_items_created_by_idx
  on event_note_items (created_by) where created_by is not null;
create index if not exists event_note_editors_user_idx on event_note_editors (user_id);
create index if not exists event_attachments_added_by_idx
  on event_attachments (added_by) where added_by is not null;

create index if not exists expenses_created_by_idx
  on expenses (created_by) where created_by is not null;
create index if not exists expense_shares_settled_by_idx
  on expense_shares (settled_by) where settled_by is not null;
create index if not exists expense_shares_confirmed_by_idx
  on expense_shares (confirmed_by) where confirmed_by is not null;
create index if not exists expense_viewers_user_idx on expense_viewers (user_id);
create index if not exists expense_hidden_from_user_idx on expense_hidden_from (user_id);

create index if not exists collection_items_added_by_idx
  on collection_items (added_by) where added_by is not null;
create index if not exists game_sessions_created_by_idx
  on game_sessions (created_by) where created_by is not null;
create index if not exists sticker_pack_installs_user_idx on sticker_pack_installs (user_id);

create index if not exists bierjunge_aufrufe_ausrufer_idx on bierjunge_aufrufe (ausrufer_id);
create index if not exists bierjunge_aufrufe_ziel_idx
  on bierjunge_aufrufe (ziel_id) where ziel_id is not null;
create index if not exists bierjunge_antworten_user_idx on bierjunge_antworten (user_id);
