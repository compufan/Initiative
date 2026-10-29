import { useMemo } from 'react';
import { ortHinweis } from '../lib/ortHinweis.js';

/**
 * Die Zeile unter dem Ort-Feld: sagt, was die App aus dem Getippten macht.
 *
 * Kein `aria-live`: Es würde bei jedem Tastendruck vorlesen. Der Hinweis hängt
 * per `aria-describedby` am Feld und wird beim Fokus gelesen. Ohne Text
 * (Zoom, Online, bei mir) bleibt das Element versteckt da – ein Hinweis, der
 * zu einer Adresse rät, wäre dort falsch.
 */
export function OrtHinweis({ ort, id }: { ort: string; id: string }) {
  const hinweis = useMemo(() => ortHinweis(ort), [ort]);
  return (
    <p id={id} className={`cal-hint${hinweis?.gut ? ' cal-hint-ok' : ''}`} hidden={!hinweis}>
      {hinweis?.text}
    </p>
  );
}
