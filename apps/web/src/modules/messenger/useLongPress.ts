import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';

export interface LongPressHandlers {
  onPointerDown: (event: ReactPointerEvent) => void;
  onPointerMove: (event: ReactPointerEvent) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onContextMenu: (event: {
    preventDefault: () => void;
    /*
     * Beide optional und absichtlich schmal getippt.
     *
     * So erfüllt Reacts `MouseEvent` die Angabe von selbst (dort ist
     * `currentTarget` das Element mit seinem `contains`), und zugleich lässt
     * sich der Haken weiter ohne echtes Ereignis aufrufen – die Tests dieses
     * Projekts tun genau das.
     */
    target?: EventTarget | null;
    currentTarget?: { contains(ziel: Node | null): boolean } | null;
  }) => void;
}

/**
 * Long press (touch) plus the desktop context menu, both leading to the same
 * action sheet. Moving the finger cancels, so scrolling never opens the menu.
 */
export function useLongPress(onTrigger: () => void, delay = 450): LongPressHandlers {
  const timer = useRef<number | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  /**
   * Hat diese eine Geste schon ausgelöst?
   *
   * # Der Fehler, den das abfängt
   *
   * Auf einem Telefon feuert der Browser beim langen Drücken NACH unserem
   * Wecker noch sein eigenes `contextmenu` – Android Chrome nach etwa 500 ms,
   * unser Wecker steht auf 450. Damit lief `onTrigger` zweimal je Geste.
   *
   * Im Chat fiel das nie auf: Dort öffnet es ein Blatt, und ein Blatt, das
   * zweimal aufgeht, ist immer noch offen. In der Dateiansicht ist derselbe
   * Rückruf ein UMSCHALTER – der erste Aufruf wählte die Kachel aus, der
   * zweite sofort wieder ab. Der Anwender sah die Auswahl kurz aufblitzen und
   * verschwinden, und eine zweite Kachel liess sich gar nicht mehr dazuwählen,
   * weil die Auswahl ja nicht mehr stand.
   *
   * Zurückgesetzt wird beim nächsten Zeigerdruck, und zwar VOR allen frühen
   * Ausstiegen: Ein Rechtsklick steigt gleich darunter aus (Taste 2), soll
   * aber weiterhin über `contextmenu` auslösen dürfen.
   */
  const gefeuert = useRef(false);

  const clear = useCallback(() => {
    if (timer.current != null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    origin.current = null;
  }, []);

  useEffect(() => clear, [clear]);

  return {
    onPointerDown(event) {
      // Eine neue Geste beginnt – siehe `gefeuert`. Diese Zeile steht mit
      // Absicht vor jedem `return` darunter.
      gefeuert.current = false;
      if (event.button != null && event.button !== 0) return;
      /*
       * Nur, wenn der Druck WIRKLICH auf dieser Nachricht landete.
       *
       * React leitet Ereignisse am eigenen Baum entlang weiter – auch durch
       * ein Portal hindurch. Die Lichtbox hängt im DOM am Dokumentkörper,
       * im React-Baum aber weiter unter der Nachrichtenblase. Ein
       * Zeigerdruck im Bildeditor, der aus dieser Lichtbox heraus geöffnet
       * wurde, kam damit hier an und stellte den Wecker.
       *
       * Was der Anwender davon sah: Er zog im Editor den ersten
       * Pinselstrich, und mitten hinein sprang das Nachrichtenmenü mit
       * „Für alle löschen“. Nachgemessen: Der Wecker schlug 502 ms nach dem
       * Beginn des Zugs zu – die 450 ms von hier.
       *
       * `contains` fragt den DOM und nicht React. Ein Druck im Portal ist
       * dort nicht enthalten, und genau das ist die Auskunft, die wir
       * brauchen.
       */
      const ziel = event.target as Node | null;
      if (ziel && !event.currentTarget.contains(ziel)) return;
      /*
       * Erst aufräumen, DANN den Anfangspunkt merken.
       *
       * Andersherum stand es hier eine Zeit lang, und es machte die
       * Bewegungsprüfung unten wirkungslos: `clear()` setzt `origin` auf
       * null, also fand `onPointerMove` nie einen Anfangspunkt und stieg
       * jedes Mal sofort aus. Man konnte den Finger quer über den Bildschirm
       * ziehen, und nach 450 ms sprang trotzdem das Menü auf – während des
       * Scrollens, mitten im Wischen.
       *
       * Der Fehler ist die unangenehme Sorte: Er macht nichts kaputt, was
       * auffällt, er lässt nur eine Schutzmassnahme still ausfallen.
       */
      clear();
      origin.current = { x: event.clientX, y: event.clientY };
      timer.current = window.setTimeout(() => {
        timer.current = null;
        gefeuert.current = true;
        onTrigger();
      }, delay);
    },
    onPointerMove(event) {
      const start = origin.current;
      if (!start) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 12) clear();
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    onContextMenu(event) {
      /*
       * Derselbe Portal-Schutz wie oben – er fehlte hier.
       *
       * React leitet auch `contextmenu` am eigenen Baum entlang weiter, also
       * durch ein Portal hindurch. Ein Rechtsklick im Bildeditor, der aus der
       * Lichtbox einer Nachricht heraus geöffnet wurde, landete deshalb am
       * Nachrichtenmenü. Für `onPointerDown` ist das seit einem Vorfall
       * abgesichert; hier war es vergessen.
       *
       * `contains` ist optional, weil diese Haken auch ohne echtes Ereignis
       * aufgerufen werden (Tests, künstlich ausgelöste Menüs). Fehlt die
       * Auskunft, gilt der Druck als eigener – das ist die Richtung, in der
       * nichts verlorengeht.
       */
      const ziel = event.target as Node | null;
      if (ziel && event.currentTarget && !event.currentTarget.contains(ziel)) return;

      /*
       * `preventDefault` immer – das Systemmenü stört in beiden Fällen.
       * Auslösen aber nur, wenn der Wecker es nicht schon getan hat.
       *
       * Auf der Maus ist das der Rechtsklick und der einzige Auslöser; auf
       * dem Finger ist es das nachgeschobene Menü zu einem Druck, der längst
       * gewirkt hat.
       *
       * Der Merker wird hier NICHT gesetzt. Er gehört dem Weckerweg, und
       * dieser Weg liest ihn nur. Setzte er ihn auch, bliebe er nach einem
       * Menü ohne Zeigerdruck stehen – die Kontextmenü-Taste der Tastatur
       * erzeugt genau das –, und der nächste Druck derselben Taste täte
       * nichts mehr.
       */
      event.preventDefault();
      clear();
      if (gefeuert.current) return;
      onTrigger();
    },
  };
}
