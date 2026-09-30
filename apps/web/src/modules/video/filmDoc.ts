import { useCallback } from 'react';

import type { BildDoc } from '../bild/doc.js';
import { bildDocAn } from './masken.js';
import { filmZuQuelle, type Abschnitt } from './schnitt.js';
import type { SchnittZustand } from './schnittZustand.js';

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

/**
 * Die Bearbeitung für ein Bild der Vorschau: die des Abschnitts, dazu die
 * Masken des Films, so weit die Verfolgung sie an diesem Bild kennt.
 *
 * Für Editor und Blatt dieselbe Rechnung – zwei Vorschauen, die verschieden
 * zusammensetzen, zeigten denselben Film verschieden.
 *
 * Was noch nicht verfolgt ist, fehlt (`art: 'vorschau'` nimmt dafür auch
 * einen älteren Stand); das Bild wird dann gleich vorgezogen – aber nicht
 * beim Abspielen, da wäre es schon vorbei, bevor es fertig ist.
 */
export function useVorschauDoc(
  schnitt: SchnittZustand,
  lage: { readonly current: Wiedergabelage },
): (quelleMs: number) => BildDoc | null {
  const { abschnitte, masken, spuren, speicher, mass, s } = schnitt;
  return useCallback(
    (quelleMs: number) => {
      const nummer = abschnittAn(abschnitte, quelleMs, lage.current);
      const clipDoc = abschnitte[nummer]?.doc ?? null;
      if (masken.length === 0 || !mass) return clipDoc;
      /*
       * `quelleMs` ist der ANFANG des gezeigten Quellbildes (`mediaTime`),
       * verfolgt wird aber an der Mitte eines Rasterbildes (`bildMitte`).
       * Gemeint ist das erste Rasterbild, dessen Mitte in diesem Quellbild
       * liegt – mit `bildIndex` (abgerundet) bekam jedes dritte Bild einer
       * 30er-Quelle die Maske des vorigen.
       */
      const k = Math.max(0, Math.ceil(quelleMs / s - 0.5 - 1e-6));
      const z = bildDocAn(
        clipDoc,
        masken,
        spuren,
        k,
        'vorschau',
        { abschnitte, s, b: mass.b, h: mass.h },
        speicher,
      );
      if (z.fehlend.length > 0 && !lage.current.spielt) spuren.vorziehen(k);
      return z.doc;
    },
    [abschnitte, lage, masken, mass, s, speicher, spuren],
  );
}
