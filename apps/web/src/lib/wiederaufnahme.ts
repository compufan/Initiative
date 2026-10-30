/**
 * Wann die App „zurück“ ist – und wie oft sie daraufhin nachholt.
 *
 * WARUM: Auf dem iPhone friert iOS eine PWA im Hintergrund ein. Die
 * Echtzeitleitung stirbt dabei meist OHNE `close`, und beim Zurückkehren holte
 * nichts nach, was in der Zwischenzeit kam: Die Chatliste zeigte nicht, dass
 * jemand geantwortet hatte. Jedes der Signale unten kann das Zurückkommen
 * sein, und je nach Browser kommt nur eines davon an:
 *
 * - `visibilitychange` → sichtbar: der Normalfall (Wechsel zurück zur App).
 * - `pageshow`: Rückkehr aus dem bfcache (`persisted`) – dort feuert
 *   `visibilitychange` nicht in jedem WebKit.
 * - `focus`: Desktop-Fenster, und iOS beim Antippen einer Mitteilung.
 * - `online`: nach einem Funkloch.
 *
 * Oft kommen zwei oder drei davon fast gleichzeitig; deshalb gedrosselt.
 */

/**
 * Ruft `aufgabe` sofort und höchstens einmal je `fensterMs` auf. Kommen im
 * Fenster weitere Anstösse, gibt es GENAU einen Nachzügler am Ende des
 * Fensters.
 *
 * Der Nachzügler ist kein Luxus: Beim Zurückkommen holt der erste Aufruf die
 * Liste, Sekunden später steht die neue Leitung (`online` nach `offline`). Was
 * zwischen den beiden geschah, sähe sonst niemand – also noch einmal.
 */
export function gedrosselt(aufgabe: () => void, fensterMs: number): () => void {
  let zuletzt = -Infinity;
  let nachzuegler: ReturnType<typeof setTimeout> | null = null;
  const ausfuehren = () => {
    zuletzt = Date.now();
    aufgabe();
  };
  return () => {
    const seit = Date.now() - zuletzt;
    if (seit >= fensterMs && !nachzuegler) {
      ausfuehren();
      return;
    }
    if (nachzuegler) return;
    nachzuegler = setTimeout(
      () => {
        nachzuegler = null;
        ausfuehren();
      },
      Math.max(0, fensterMs - seit),
    );
  };
}

interface Ziele {
  fenster: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  dokument: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
}

/** Meldet jedes Zurückkommen der App an `zurueck`. Gibt das Abmelden zurück. */
export function beiRueckkehr(
  zurueck: () => void,
  ziele: Ziele = { fenster: window, dokument: document },
): () => void {
  const { fenster, dokument } = ziele;
  const sichtbarkeit = () => {
    if (dokument.visibilityState === 'visible') zurueck();
  };
  const sonst = () => zurueck();
  dokument.addEventListener('visibilitychange', sichtbarkeit);
  fenster.addEventListener('pageshow', sonst);
  fenster.addEventListener('focus', sonst);
  fenster.addEventListener('online', sonst);
  return () => {
    dokument.removeEventListener('visibilitychange', sichtbarkeit);
    fenster.removeEventListener('pageshow', sonst);
    fenster.removeEventListener('focus', sonst);
    fenster.removeEventListener('online', sonst);
  };
}
