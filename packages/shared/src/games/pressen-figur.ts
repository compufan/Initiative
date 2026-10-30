/**
 * Pressen – das Strichmännchen eines Kontos.
 *
 * Jede Angabe ist eine kleine Zahl, die in der Zeichnung (`PressenFigur.tsx`)
 * eine Auswahl bedeutet: Frisur Nr. 3, Hautfarbe Nr. 2 … Kein Freitext, keine
 * Farbcodes – nichts, was beim Zeichnen etwas einschleusen könnte. Die Grenzen
 * stehen hier und in `apps/api/src/games/pressen_figur.rs` (der Server
 * prüft beim Speichern in den Konto-Einstellungen
 * `settings.modules.pressenFigur`).
 */
import { z } from 'zod';

export interface PressenFigurDaten {
  frisur: number;
  haarfarbe: number;
  haut: number;
  shirt: number;
  bart: number;
  brille: number;
  hut: number;
}

export type PressenFigurMerkmal = keyof PressenFigurDaten;

/** Größte erlaubte Nummer (einschließlich) je Merkmal; die kleinste ist immer 0. */
export const PRESSEN_FIGUR_GRENZEN: Readonly<Record<PressenFigurMerkmal, number>> = {
  frisur: 11,
  haarfarbe: 9,
  haut: 6,
  shirt: 11,
  bart: 4,
  brille: 3,
  hut: 4,
};

export const PRESSEN_FIGUR_MERKMALE = Object.keys(PRESSEN_FIGUR_GRENZEN) as PressenFigurMerkmal[];

/** Schlüssel in `settings.modules`. */
export const PRESSEN_FIGUR_SCHLUESSEL = 'pressenFigur';

const merkmal = (max: number) => z.number().int().min(0).max(max);

export const pressenFigurSchema = z
  .object({
    frisur: merkmal(PRESSEN_FIGUR_GRENZEN.frisur),
    haarfarbe: merkmal(PRESSEN_FIGUR_GRENZEN.haarfarbe),
    haut: merkmal(PRESSEN_FIGUR_GRENZEN.haut),
    shirt: merkmal(PRESSEN_FIGUR_GRENZEN.shirt),
    bart: merkmal(PRESSEN_FIGUR_GRENZEN.bart),
    brille: merkmal(PRESSEN_FIGUR_GRENZEN.brille),
    hut: merkmal(PRESSEN_FIGUR_GRENZEN.hut),
  })
  .strict();

/** Liest eine Figur streng; null, wenn irgendetwas nicht stimmt. */
export function figurLesen(roh: unknown): PressenFigurDaten | null {
  const r = pressenFigurSchema.safeParse(roh);
  return r.success ? r.data : null;
}

/**
 * Die Standardfigur, solange jemand keine eingestellt hat: aus der Kennung
 * abgeleitet, damit am Tisch nicht alle gleich aussehen – und bei allen gleich.
 */
export function standardFigur(kennung: string): PressenFigurDaten {
  let h = 2166136261;
  for (let i = 0; i < kennung.length; i += 1) {
    h = (Math.imul(h ^ kennung.charCodeAt(i), 16777619) >>> 0) % 4294967291;
  }
  const nimm = (max: number) => {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    return (h >>> 8) % (max + 1);
  };
  const g = PRESSEN_FIGUR_GRENZEN;
  return {
    frisur: nimm(g.frisur),
    haarfarbe: nimm(g.haarfarbe),
    haut: nimm(g.haut),
    shirt: nimm(g.shirt),
    // Die meisten ohne Bart, Brille und Hut: das sind die besonderen Fälle.
    bart: nimm(g.bart + 3) > g.bart ? 0 : nimm(g.bart),
    brille: nimm(g.brille + 3) > g.brille ? 0 : nimm(g.brille),
    hut: nimm(g.hut + 4) > g.hut ? 0 : nimm(g.hut),
  };
}

/** Eine zufällige Figur für den Knopf „Würfeln“ (Zufallsquelle kommt vom Aufrufer). */
export function zufallsFigur(zufall: () => number): PressenFigurDaten {
  const g = PRESSEN_FIGUR_GRENZEN;
  const nimm = (max: number) => Math.min(max, Math.floor(zufall() * (max + 1)));
  return {
    frisur: nimm(g.frisur),
    haarfarbe: nimm(g.haarfarbe),
    haut: nimm(g.haut),
    shirt: nimm(g.shirt),
    bart: nimm(g.bart),
    brille: nimm(g.brille),
    hut: nimm(g.hut),
  };
}
