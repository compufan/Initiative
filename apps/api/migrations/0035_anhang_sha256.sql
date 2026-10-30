-- Die Gesamt-Prüfsumme eines in Stücken hochgeladenen Anhangs.
--
-- # Wozu
--
-- Beim Abschluss liest der Server die fertige Datei ohnehin einmal im Strom
-- (Inhaltsprüfung, optionale Prüfsumme des Clients). Das Ergebnis wird jetzt
-- festgehalten statt weggeworfen: Der Browser kann aus den Stück-Prüfsummen
-- (je Stück per WebCrypto) keine Gesamtsumme bilden, der Server aber hat sie
-- gratis. Sie dient danach
--   * dem Auslagerungsdienst: Nach dem Hinüberschreiben auf die Box kann
--     (bei kleinen, unverschlüsselten Dateien) drüben im Strom gegengelesen
--     werden, und
--   * dem Konsistenzcheck der Box (`/admin/storage-check/konsistenz`) als
--     Stichprobe.
--
-- Hex, klein geschrieben; es ist die Summe des KLARTEXTS, wie der Client ihn
-- hochgeladen hat. NULL bei allem, was nicht in Stücken kam (Altbestand).

alter table attachments
  add column if not exists sha256 text;

comment on column attachments.sha256 is
  'SHA-256 (Hex) des hochgeladenen Klartexts; nur bei Uploads in Stücken gesetzt.';
