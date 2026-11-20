-- Quiz-Umfragen: eine Umfrage mit richtiger Antwort (oder mehreren) und
-- optionaler Erklärung. Wer abgestimmt hat, sieht die Auflösung; wer nicht,
-- sieht sie nicht (`services/polls.rs`, `to_poll_dto`). Eine Stimme in einem
-- Quiz lässt sich nicht ändern – sonst wäre die Auflösung ein Spickzettel.
alter table polls
  add column if not exists quiz boolean not null default false,
  add column if not exists erklaerung text;

alter table poll_options
  add column if not exists richtig boolean not null default false;
