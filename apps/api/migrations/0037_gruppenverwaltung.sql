-- Gruppenverwaltung: Beschreibung, Gruppen-Einstellungen, langsamer Modus.
--
-- `description` steht in der Gruppeninfo und in der Vorschau eines
-- Einladungslinks. Begrenzt in der Datenbank und nicht nur im Handler: Eine
-- Beschreibung geht an jedes Mitglied hinaus, und eine Grenze, die nur im
-- Code steht, umgeht der nächste Weg, der vergisst, sie zu prüfen.
--
-- `settings` hält die Schalter der Gruppe (`nurAdminsSenden`,
-- `nurAdminsInfo`, `langsamerModus` in Sekunden). jsonb statt Spalten: Die
-- Schalter wachsen mit, und gelesen werden sie immer zusammen.
--
-- `zuletzt_gesendet` je Mitglied ist die Grundlage des langsamen Modus. Der
-- Server setzt sie mit einem BEDINGTEN Update („nur wenn die Wartezeit um
-- ist“) – damit können zwei gleichzeitige Sendungen derselben Person nicht
-- beide durchrutschen, was ein Nachsehen der letzten Nachricht nicht leistet.
--
-- Wiederholbar: Jede Anweisung prüft selbst, ob es sie schon gibt.

alter table conversations add column if not exists description text;
alter table conversations add column if not exists settings jsonb not null default '{}'::jsonb;
alter table conversation_members add column if not exists zuletzt_gesendet timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'conversations_description_laenge'
  ) then
    alter table conversations
      add constraint conversations_description_laenge
      check (description is null or char_length(description) <= 512);
  end if;
end $$;
