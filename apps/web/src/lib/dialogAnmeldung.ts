import { useEffect, useRef } from 'react';

import { dialogAnmelden } from './dialogVerlauf.js';

/**
 * Einen Dialog am Stapel anmelden – EINMAL, nicht bei jedem Rendern.
 *
 * # Warum es diesen Haken gibt und nicht bloss `useEffect(() =>
 * dialogAnmelden(onClose), [onClose])`
 *
 * Weil `onClose` bei fast jedem Aufrufer eine frisch erzeugte Funktion ist –
 * `onClose={() => setOffen(null)}` etwa. Ihre Kennung ändert sich damit bei
 * jedem Rendern des Elternteils, der Effekt meldet ab und wieder an, und der
 * Dialog rutscht dabei ans OBERE Ende des Stapels.
 *
 * Solange nur die Zurück-Taste daran hing, fiel das kaum auf. Seit auch Esc
 * über diesen Stapel geht, ist es ein Fehler mit Folgen: Liegt über der
 * Lightbox ein Blatt und trifft eine neue Nachricht ein, rendert der Chat neu
 * – und danach liegt die Lightbox oben. Ein Esc schliesst dann die Lightbox
 * samt Blatt statt nur des Blattes.
 *
 * Die Kennung wird deshalb über eine Referenz stabil gehalten, genau wie es
 * `Sheet` schon tut. Angemeldet wird, solange `offen` wahr ist.
 */
export function useDialogAnmeldung(offen: boolean, schliessen: () => void): void {
  const jetzt = useRef(schliessen);
  jetzt.current = schliessen;

  useEffect(() => {
    if (!offen) return undefined;
    return dialogAnmelden(() => jetzt.current());
  }, [offen]);
}
