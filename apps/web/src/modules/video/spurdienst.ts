import type { Maske, SpurQuelle } from './masken.js';
import type { Abschnitt } from './schnitt.js';

/**
 * Was der Film von der Verfolgung der Masken braucht – mehr als nur Daten.
 *
 * `SpurQuelle` (masken.ts) liefert, was an einem Bild bekannt ist. Dazu kommt
 * hier die Steuerung: welche Masken gerade gelten, wann gerechnet werden
 * darf, worauf der Filmbau wartet. Der `Verfolger` (verfolger.ts) erfüllt
 * das; bis er da ist – oder solange die Rechengrösse des Videos noch nicht
 * bekannt ist – steht `leereSpuren()` an seiner Stelle.
 */
export interface Spurdienst extends SpurQuelle {
  /**
   * Was gerade gilt. Der Dienst rechnet selbst aus, was sich geändert hat;
   * ein Reglerschritt an einer Maske kostet ihn nichts.
   *
   * `F`: die Rasterbilder, die der Film zeigt, sortiert – nur die werden
   * verfolgt.
   */
  setzen(masken: readonly Maske[], abschnitte: readonly Abschnitt[], F: readonly number[]): void;
  /** Für `useSyncExternalStore`. */
  abonnieren(rueckruf: () => void): () => void;
  stand(): Spurstand;
  /** Dieses Bild wird gerade gebraucht – dorthin zuerst. */
  vorziehen(k: number): void;
  /** Ruhen, solange ein Grund besteht: ein Finger auf der Leiste, die Wiedergabe, ein verborgenes Fenster. */
  verfolgungRuhen(grund: Ruhegrund, an: boolean): void;
  /**
   * Erfüllt sich, wenn alle eingeschalteten Masken überall fertig verfolgt
   * sind – darauf wartet der Filmbau. Scheitert mit dem Fehler einer Kette.
   */
  spurenFertig(
    abbruch: AbortSignal,
    fortschritt?: (anteil: number, text: string) => void,
  ): Promise<void>;
  schliessen(): void;
}

export type Ruhegrund = 'zug' | 'wiedergabe' | 'verborgen';

export interface MaskenFortschritt {
  /** Anteil der Bilder im Geltungsbereich, die fertig (fein) verfolgt sind. */
  readonly anteil: number;
  /** Anteil der Bilder mit wenigstens grober Verfolgung. */
  readonly grobAnteil: number;
  /** Geschätzte Restzeit bis fertig, in Millisekunden. */
  readonly restMs: number;
  /** … bis alles wenigstens grob da ist. */
  readonly grobRestMs: number;
  readonly laeuft: boolean;
  readonly fehler?: string;
}

export interface Spurstand {
  /** Steigt, sobald sich etwas an den Daten geändert hat – dann Bahnen neu zeichnen. */
  readonly version: number;
  readonly jeMaske: ReadonlyMap<string, MaskenFortschritt>;
}

const LEERER_STAND: Spurstand = { version: 0, jeMaske: new Map() };

export interface SpurAuftrag {
  readonly datei: Blob;
  readonly kante: number;
  /** Der Bildabstand des Films – das Raster, auf dem verfolgt wird. */
  readonly s: number;
  /** Die Rechengrösse; ohne sie gibt es noch nichts zu rechnen. */
  readonly mass: { readonly b: number; readonly h: number } | null;
}

/**
 * Der Dienst für dieses Video.
 *
 * Solange es die Verfolgung noch nicht gibt, oder die Rechengrösse noch
 * nicht bekannt ist, der leere.
 */
export function spurdienstFuer(auftrag: SpurAuftrag): Spurdienst {
  void auftrag;
  return leereSpuren();
}

/**
 * Ein Dienst, der nichts rechnet: Jede Maske ist nur an ihren Ankern
 * bekannt, überall sonst „offen".
 *
 * Kein Platzhalter für Tests allein: So verhält sich der Film auch, solange
 * die Rechengrösse des Videos noch nicht feststeht – der Editor zeigt eine
 * frisch angelegte Maske an ihrem Bild, und der Filmbau wartet nicht auf
 * etwas, das nie kommt, sondern sagt, woran es fehlt.
 */
export function leereSpuren(): Spurdienst {
  let masken: readonly Maske[] = [];
  return {
    kette: () => ({ stand: 'offen' }),
    maske: () => null,
    lage: () => ({ stand: 'offen' }),
    tiefe: () => ({ stand: 'offen' }),
    setzen(neu) {
      masken = neu;
    },
    abonnieren: () => () => undefined,
    stand: () => LEERER_STAND,
    vorziehen: () => undefined,
    verfolgungRuhen: () => undefined,
    spurenFertig: async () => {
      const aktiv = masken.filter((maske) => maske.aktiv);
      if (aktiv.length > 0) {
        throw new Error(
          `Die Maske „${aktiv[0].name}" lässt sich hier nicht verfolgen – dieser Browser rechnet keine Spuren.`,
        );
      }
    },
    schliessen: () => undefined,
  };
}
