-- Bezahlt UND bestätigt – zwei Schritte, nicht einer.
--
-- 0007 hat festgehalten, WER abgehakt hat. Das reicht für die Unterscheidung
-- „gemeldet“ gegen „bestätigt“, aber nicht dafür, dass BEIDES passiert ist:
-- Hakt erst der Schuldner ab und danach der Empfänger, überschriebe der zweite
-- den ersten, und der Vorgang sähe aus, als hätte der Schuldner nie gemeldet.
--
-- Genau diese Reihenfolge ist aber der Normalfall: Einer überweist und meldet
-- es, der andere sieht das Geld und bestätigt. Erst dann ist der Vorgang
-- wirklich abgeschlossen.
--
-- Also ein zweiter Satz Felder. `settled_*` ist die erste Markierung,
-- `confirmed_*` die Gegenzeichnung durch die andere Seite.

alter table expense_shares
  add column if not exists confirmed_at timestamptz,
  add column if not exists confirmed_by uuid references users (id) on delete set null;

comment on column expense_shares.confirmed_at is
  'Gegenzeichnung durch die jeweils andere Seite. Erst mit ihr gilt ein Anteil als abgeschlossen.';
