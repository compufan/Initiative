import { useCallback, useEffect, useRef } from 'react';

import type { BildDoc } from '../bild/doc.js';
import { bildDocAn } from './masken.js';
import { rasterbildImVideobild } from './raster.js';
import { filmZuQuelle, type Abschnitt } from './schnitt.js';
import type { SchnittZustand } from './schnittZustand.js';
import type { VorschauBild } from './vorschau.js';

/** Wo die Wiedergabe gerade steht – über eine Referenz gelesen, siehe unten. */
export interface Wiedergabelage {
  readonly spielt: boolean;
  /** Der Abschnitt, der gerade läuft. */
  readonly nummer: number;
  readonly filmMs: number;
}

/**
 * Welcher Abschnitt zeigt dieses Bild des Videos gerade?
 *
 * Beim Abspielen der laufende, sonst der unter der Wiedergabestelle – und
 * nur, wenn das Bild auch wirklich in ihm liegt: Zwei Abschnitte können
 * dieselbe Stelle des Videos zeigen, mit verschiedener Bearbeitung.
 */
export function abschnittAn(
  abschnitte: readonly Abschnitt[],
  quelleMs: number,
  lage: Wiedergabelage,
): number {
  const vermutet = lage.spielt
    ? lage.nummer
    : (filmZuQuelle(abschnitte, lage.filmMs)?.nummer ?? lage.nummer);
  const liegtIn = (i: number) => {
    const a = abschnitte[i];
    return a !== undefined && quelleMs >= a.vonMs - 1 && quelleMs < a.bisMs + 1;
  };
  if (liegtIn(vermutet)) return vermutet;
  const treffer = abschnitte.findIndex((_, i) => liegtIn(i));
  return treffer < 0 ? vermutet : treffer;
}

/** So oft höchstens wird beim Wischen eine fehlende Maske vorgezogen. */
export const VORZIEHEN_MS = 150;

/**
 * Die Bearbeitung für ein Bild der Vorschau: die des Abschnitts, dazu die
 * Masken des Films, so weit die Verfolgung sie an diesem Bild kennt.
 *
 * Für Editor und Blatt dieselbe Rechnung – zwei Vorschauen, die verschieden
 * zusammensetzen, zeigten denselben Film verschieden.
 *
 * Was noch nicht verfolgt ist, fehlt (`art: 'vorschau'` nimmt dafür auch
 * einen älteren Stand); das Bild wird dann vorgezogen – aber nicht beim
 * Abspielen, da wäre es schon vorbei, bevor es fertig ist.
 *
 * # Zwei Wege zum selben Dokument
 *
 * - `docFuer(quelleMs)`: für ein Bild aus dem VIDEO. Abschnitt und
 *   Rasterbild müssen aus der Zeit im Video erraten werden.
 * - `docFuerBild(nummer, k)`: für ein Bild aus dem WISCHSPEICHER. Dort
 *   stehen beide schon fest – sie stammen aus `filmRaster`, derselben Liste,
 *   aus der der Filmbau seine Bilder holt –, und es gibt den Umweg über das
 *   Video nicht, auf dem früher jedes dritte Bild einer 30er-Quelle die
 *   Maske des vorigen bekam.
 *
 * Beide liefern, zu welchem Abschnitt und Rasterbild die Bearbeitung gehört
 * (`VorschauBild`): Bild und Maske müssen zum selben `k` gehören.
 */
export function useVorschauDoc(
  schnitt: SchnittZustand,
  lage: { readonly current: Wiedergabelage },
): {
  docFuer: (quelleMs: number) => VorschauBild;
  docFuerBild: (nummer: number, k: number) => VorschauBild;
} {
  const { abschnitte, masken, spuren, speicher, mass, s } = schnitt;

  /*
   * Vorziehen, aber gedrosselt: Beim Wischen wird jedes Bild gezeichnet,
   * und jedes ruft `vorziehen` – 60-mal in der Sekunde liesse bei laufendem
   * Fenster 60-mal `waehlen()` rechnen. Höchstens alle `VORZIEHEN_MS`, und
   * das letzte Bild kommt nach, damit das Ziel des Zugs nicht verloren geht.
   */
  const vorziehenStand = useRef<{
    zeit: number;
    k: number;
    uhr: ReturnType<typeof setTimeout> | null;
  }>({ zeit: 0, k: -1, uhr: null });
  const vorziehen = useCallback(
    (k: number) => {
      const stand = vorziehenStand.current;
      const jetzt = Date.now();
      if (jetzt - stand.zeit >= VORZIEHEN_MS) {
        stand.zeit = jetzt;
        spuren.vorziehen(k);
        return;
      }
      stand.k = k;
      if (stand.uhr !== null) return;
      stand.uhr = setTimeout(
        () => {
          stand.uhr = null;
          stand.zeit = Date.now();
          spuren.vorziehen(stand.k);
        },
        VORZIEHEN_MS - (jetzt - stand.zeit),
      );
    },
    [spuren],
  );
  useEffect(
    () => () => {
      const stand = vorziehenStand.current;
      if (stand.uhr !== null) clearTimeout(stand.uhr);
      stand.uhr = null;
    },
    [],
  );

  const docFuerBild = useCallback(
    (nummer: number, k: number): VorschauBild => {
      const clipDoc = abschnitte[nummer]?.doc ?? null;
      if (masken.length === 0 || !mass) return { doc: clipDoc, nummer, k, fehlend: [] };
      const z = bildDocAn(
        clipDoc,
        masken,
        spuren,
        k,
        'vorschau',
        { abschnitte, s, b: mass.b, h: mass.h },
        speicher,
      );
      if (z.fehlend.length > 0 && !lage.current.spielt) vorziehen(k);
      return { doc: z.doc, nummer, k, fehlend: z.fehlend };
    },
    [abschnitte, lage, masken, mass, s, speicher, spuren, vorziehen],
  );

  const docFuer = useCallback(
    (quelleMs: number): VorschauBild => {
      const nummer = abschnittAn(abschnitte, quelleMs, lage.current);
      // `quelleMs` ist der ANFANG des gezeigten Quellbildes – siehe `rasterbildImVideobild`.
      return docFuerBild(nummer, rasterbildImVideobild(quelleMs, s));
    },
    [abschnitte, docFuerBild, lage, s],
  );

  return { docFuer, docFuerBild };
}
