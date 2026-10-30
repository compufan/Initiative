import { z } from 'zod';

/**
 * Pressen: Statistik über alle gewerteten Läufe eines Kontos.
 *
 * Die Läufe schreibt der Server beim Abschluss einer Runde (Tabelle
 * `pressen_laeufe`); gelesen werden nur die eigenen. Die Antworten stehen hier
 * als zod-Schemas, damit Client und Test dieselbe Form prüfen wie der Server sie
 * liefert (`apps/api/src/services/pressen_statistik.rs`).
 */

export const PRESSEN_MODI = ['spiegel', 'duell', 'ampel', 'staffette'] as const;
export type PressenLaufModus = (typeof PRESSEN_MODI)[number];

export const PRESSEN_STARTARTEN = ['echtzeit', 'asynchron'] as const;
export const PRESSEN_AUSGAENGE = ['sieg', 'niederlage', 'atempo', 'nicht_gewertet'] as const;
export type PressenAusgang = (typeof PRESSEN_AUSGAENGE)[number];
export const PRESSEN_SORTIERUNGEN = ['neu', 'alt', 'zeit', 'wertung', 'verschuettet'] as const;
export type PressenSortierung = (typeof PRESSEN_SORTIERUNGEN)[number];

/** Filter, den Statistik und Laufliste teilen. Zeiten als RFC 3339 (UTC). */
export const pressenFilterSchema = z.object({
  von: z.string().datetime().optional(),
  bis: z.string().datetime().optional(),
  modus: z.enum(PRESSEN_MODI).optional(),
  art: z.enum(PRESSEN_STARTARTEN).optional(),
  ausgang: z.enum(PRESSEN_AUSGAENGE).optional(),
});
export type PressenFilter = z.infer<typeof pressenFilterSchema>;

export const pressenLaeufeAbfrageSchema = pressenFilterSchema.extend({
  cursor: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  sortierung: z.enum(PRESSEN_SORTIERUNGEN).optional(),
});
export type PressenLaeufeAbfrage = z.infer<typeof pressenLaeufeAbfrageSchema>;

const zeit = z.string().datetime({ offset: true });

const rekord = z.object({ wert: z.number(), laufId: z.string().uuid(), gespieltAm: zeit });
export type PressenRekord = z.infer<typeof rekord>;

export const pressenStatistikSchema = z.object({
  kopf: z.object({
    laeufe: z.number().int(),
    siege: z.number().int(),
    niederlagen: z.number().int(),
    atempo: z.number().int(),
    nichtGewertet: z.number().int(),
    /** Siege / (Siege + Niederlagen), 0 bis 1; leer, solange nichts entschieden ist. */
    siegquote: z.number().nullable(),
    getruemmert: z.number().int(),
    vorzeitig: z.number().int(),
    durchschnittZeitMs: z.number().nullable(),
    durchschnittWertungMs: z.number().nullable(),
    durchschnittVerschuettetDezi: z.number().nullable(),
    gesamtGetrunkenDezi: z.number().int(),
    gesamtVerschuettetDezi: z.number().int(),
    /** Getrunken / (getrunken + verschüttet), 0 bis 1. */
    trefferquote: z.number().nullable(),
    gesamtDauerMs: z.number().int(),
    laengsteSiegesserie: z.number().int(),
    aktuelleSiegesserie: z.number().int(),
  }),
  rekorde: z.object({
    besteZeit: rekord.nullable(),
    besteWertung: rekord.nullable(),
    saubersterLauf: rekord.nullable(),
    schnellsteReaktion: rekord.nullable(),
    laengsteSiegesserie: rekord.nullable(),
  }),
  nachModus: z.array(
    z.object({
      modus: z.enum(PRESSEN_MODI),
      laeufe: z.number().int(),
      siege: z.number().int(),
      niederlagen: z.number().int(),
      atempo: z.number().int(),
      besteWertungMs: z.number().nullable(),
      durchschnittZeitMs: z.number().nullable(),
      durchschnittVerschuettetDezi: z.number().nullable(),
    }),
  ),
  nachGegner: z.array(
    z.object({
      userId: z.string().uuid(),
      /** Leer, wenn das Konto nicht mehr besteht. */
      name: z.string().nullable(),
      runden: z.number().int(),
      siege: z.number().int(),
      niederlagen: z.number().int(),
      atempo: z.number().int(),
      /** Mittlerer Vorsprung (ms) des eigenen Teams; negativ = im Schnitt langsamer. */
      durchschnittVorsprungMs: z.number().nullable(),
      letzteRunde: zeit,
    }),
  ),
  nachMalus: z.array(
    z.object({
      vonMs: z.number().int(),
      bisMs: z.number().int(),
      laeufe: z.number().int(),
      durchschnittWertungMs: z.number().nullable(),
      durchschnittZeitMs: z.number().nullable(),
      durchschnittVerschuettetDezi: z.number().nullable(),
    }),
  ),
  verlauf: z.array(
    z.object({
      id: z.string().uuid(),
      gespieltAm: zeit,
      modus: z.enum(PRESSEN_MODI),
      ausgang: z.enum(PRESSEN_AUSGAENGE),
      dauerMs: z.number().int(),
      verschuettetDezi: z.number().int(),
      wertungMs: z.number().int(),
      vorzeitig: z.boolean(),
      malusMs: z.number().int(),
    }),
  ),
  /** Es gab mehr Läufe, als der Verlauf zeigt (nur die jüngsten sind dabei). */
  verlaufGekuerzt: z.boolean(),
});
export type PressenStatistikDto = z.infer<typeof pressenStatistikSchema>;
export type PressenVerlaufPunkt = PressenStatistikDto['verlauf'][number];

const person = z.object({ userId: z.string().uuid(), name: z.string().nullable() });

export const pressenLaufSchema = z.object({
  id: z.string().uuid(),
  /** Leer, wenn die Übung inzwischen aufgeräumt wurde. */
  sessionId: z.string().uuid().nullable(),
  runde: z.number().int(),
  sitz: z.number().int(),
  modus: z.enum(PRESSEN_MODI),
  startArt: z.enum(PRESSEN_STARTARTEN),
  gegner: z.array(person),
  team: z.array(person),
  dauerMs: z.number().int(),
  verschuettetDezi: z.number().int(),
  wertungMs: z.number().int(),
  reaktionMs: z.number().int().nullable(),
  vorzeitig: z.boolean(),
  getruemmert: z.boolean(),
  malusMs: z.number().int(),
  versatzMs: z.number().int(),
  ausgang: z.enum(PRESSEN_AUSGAENGE),
  teamWertungMs: z.number().nullable(),
  gegnerWertungMs: z.number().nullable(),
  gespieltAm: zeit,
});
export type PressenLaufDto = z.infer<typeof pressenLaufSchema>;

export const pressenLaeufeSeiteSchema = z.object({
  items: z.array(pressenLaufSchema),
  nextCursor: z.string().nullable(),
});
export type PressenLaeufeSeite = z.infer<typeof pressenLaeufeSeiteSchema>;
