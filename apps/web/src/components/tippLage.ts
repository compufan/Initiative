/**
 * Wo ein Tooltip hingehört – die Rechnung, ohne DOM.
 *
 * Ausgelagert, weil genau hier die Fehler sitzen, die man auf dem Gerät
 * schlecht sieht: eine Blase, die halb aus dem Bildschirm ragt, oder eine, die
 * genau den Knopf verdeckt, über den sie etwas sagen will.
 */

export interface Rechteck {
  links: number;
  oben: number;
  breite: number;
  hoehe: number;
}

export interface TippLage {
  links: number;
  oben: number;
  /** Ob die Blase unter dem Element sitzt statt darüber. */
  darunter: boolean;
}

/** Abstand zwischen Blase und Element. */
const LUFT = 8;

/** Wie nah die Blase an den Bildschirmrand darf. */
const RAND = 8;

/**
 * Legt die Blase über das Element – und darunter, wenn oben kein Platz ist.
 *
 * Waagerecht wird sie mittig ausgerichtet und dann in den Bildschirm geklemmt.
 * Beides zusammen ist wichtig: Ein Knopf ganz am rechten Rand bekäme sonst
 * eine Blase, deren rechte Hälfte niemand lesen kann – und das ist gerade bei
 * den Knöpfen der Fall, die am ehesten eine Erklärung brauchen, weil sie oben
 * rechts in einer Leiste sitzen und nur ein Symbol tragen.
 */
export function tippLage(
  ziel: Rechteck,
  tipp: { breite: number; hoehe: number },
  fenster: { breite: number; hoehe: number },
): TippLage {
  const platzOben = ziel.oben - LUFT - RAND;
  const darunter = platzOben < tipp.hoehe;

  const oben = darunter ? ziel.oben + ziel.hoehe + LUFT : ziel.oben - tipp.hoehe - LUFT;

  const mittig = ziel.links + ziel.breite / 2 - tipp.breite / 2;
  const links = klemmen(mittig, RAND, fenster.breite - tipp.breite - RAND);

  return { links, oben: klemmen(oben, RAND, fenster.hoehe - tipp.hoehe - RAND), darunter };
}

/**
 * Klemmt in `[unten, oben]` – und nimmt bei umgeschlagener Spanne die Mitte.
 *
 * Umgeschlagen heisst: Die Blase ist breiter als der Bildschirm. Dann gibt es
 * keine richtige Antwort, aber die Mitte ist die am wenigsten falsche. Ohne
 * diesen Zweig gewönne `Math.max`, und die Blase hinge links an, mit dem
 * überstehenden Teil rechts im Nichts.
 */
function klemmen(wert: number, unten: number, oben: number): number {
  if (unten > oben) return (unten + oben) / 2;
  return Math.max(unten, Math.min(oben, wert));
}
