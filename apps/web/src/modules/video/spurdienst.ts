import type { Leserdienst } from './leserDienst.js';
import type { Maske, SpurQuelle } from './masken.js';
import type { Abschnitt } from './schnitt.js';
import {
  Verfolger,
  type MaskenFortschritt as VerfolgerFortschritt,
  type VerfolgerStand,
} from './verfolger.js';

/**
 * Was der Film von der Verfolgung der Masken braucht – mehr als nur Daten.
 *
 * `SpurQuelle` (masken.ts) liefert, was an einem Bild bekannt ist. Dazu kommt
 * hier die Steuerung: welche Masken gerade gelten, wann gerechnet werden
 * darf, worauf der Filmbau wartet. Der `Verfolger` (verfolger.ts) erfüllt
 * das; solange die Rechengrösse des Videos noch nicht bekannt ist, steht
 * `leereSpuren()` an seiner Stelle.
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

/**
 * Warum die Verfolgung gerade ruht. `'bau'`: Der Filmbau liest selbst – ein
 * zweiter Dekodierer daneben kostete Speicher und machte beide langsamer.
 */
export type Ruhegrund = 'zug' | 'wiedergabe' | 'verborgen' | 'bau';

export type MaskenFortschritt = VerfolgerFortschritt;

/** `version` steigt, sobald sich etwas an den Daten geändert hat – dann Bahnen neu zeichnen. */
export type Spurstand = VerfolgerStand;

const LEERER_STAND: Spurstand = { version: 0, jeMaske: new Map() };

export interface SpurAuftrag {
  /** Der Dekodierer der Sitzung – derselbe, aus dem der Editor seine Stellbilder holt. */
  readonly leser: Leserdienst;
  /** Der Bildabstand des Films – das Raster, auf dem verfolgt wird. */
  readonly s: number;
  /** Die Rechengrösse; ohne sie gibt es noch nichts zu rechnen. */
  readonly mass: { readonly b: number; readonly h: number } | null;
}

/**
 * Der Dienst für dieses Video: ein `Verfolger` – oder, solange die
 * Rechengrösse noch nicht bekannt ist, der leere.
 *
 * Der Verfolger kennt drei Ruhegründe; `'bau'` ist hier dazugekommen und
 * ruht wie die Wiedergabe (beide brauchen den Dekodierer). Getrennt
 * gezählt, damit das Ende des einen nicht den anderen aufhebt.
 */
export function spurdienstFuer(auftrag: SpurAuftrag): Spurdienst {
  const { leser, s, mass } = auftrag;
  if (!mass) return leereSpuren();
  const verfolger = new Verfolger({ leser, s, mass });
  const ruht = { wiedergabe: false, bau: false };
  return {
    kette: (anker, richtung, k) => verfolger.kette(anker, richtung, k),
    maske: (anker, richtung, k) => verfolger.maske(anker, richtung, k),
    lage: (a, k) => verfolger.lage(a, k),
    tiefe: (k) => verfolger.tiefe(k),
    setzen: (masken, abschnitte, F) => verfolger.setzen(masken, abschnitte, F),
    abonnieren: verfolger.abonnieren,
    stand: verfolger.stand,
    vorziehen: (k) => verfolger.vorziehen(k),
    verfolgungRuhen: (grund, an) => {
      if (grund === 'wiedergabe' || grund === 'bau') {
        ruht[grund] = an;
        verfolger.verfolgungRuhen('wiedergabe', ruht.wiedergabe || ruht.bau);
        return;
      }
      verfolger.verfolgungRuhen(grund, an);
    },
    spurenFertig: (abbruch, fortschritt) => verfolger.spurenFertig(abbruch, fortschritt),
    schliessen: () => verfolger.schliessen(),
  };
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
