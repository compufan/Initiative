-- Wer hat abgehakt?
--
-- Bisher stand an einem Anteil nur `settled_at` – ein Zeitpunkt ohne Urheber.
-- Damit war nicht zu unterscheiden, ob der Schuldner gemeldet hat „ich habe
-- überwiesen“ oder ob der Empfänger bestätigt hat „ist angekommen“. Gerade das
-- ist aber der Punkt, an dem sich Leute uneinig werden.
--
-- Bewusst KEINE eigene Tabelle für Zahlungen: Über diese App läuft kein Geld,
-- es gibt also nichts zu quittieren. Es genügt festzuhalten, wer den Haken
-- gesetzt hat.

alter table expense_shares
  add column if not exists settled_by uuid references users (id) on delete set null;

comment on column expense_shares.settled_by is
  'Wer den Anteil abgehakt hat. Ist es der Schuldner selbst, ist es eine Meldung; ist es der Auslegende, eine Bestätigung.';
