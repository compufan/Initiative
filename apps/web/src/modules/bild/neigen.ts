/**
 * Freies Geraderichten – der Horizont, der nicht waagerecht ist.
 *
 * # Wo die Drehung sitzt
 *
 * `drehung` sind Vierteldrehungen: Sie tauschen Kanten und bleiben
 * achsenparallel. Die Neigung hier ist etwas anderes – ein kleiner Winkel,
 * der das Bild INNERHALB des Zuschnitts dreht. Der Rahmen bleibt stehen, das
 * Bild wandert darunter.
 *
 * Genau deshalb liegt die Drehung im Renderer ganz innen, direkt an den
 * Originalpunkten, und dreht um die MITTE DES ZUSCHNITTS:
 *
 *   Bildschirm ← Ansichtsraum ← Vierteldrehung/Spiegel ← [Neigung] ← Original
 *
 * Damit behält `zuschnitt` seine bisherige Bedeutung – ein achsenparalleles
 * Rechteck in Originalpunkten – und alles, was am Bild klebt (Striche, Text,
 * Masken), dreht sich mit, ohne dass eine dieser Stellen etwas davon wissen
 * muss.
 *
 * # Die eine Bedingung
 *
 * Ein gedrehtes Bild hat leere Ecken. Die Frage ist nie „passt das Bild in den
 * Rahmen", sondern immer die Umkehrung: Liegt der Rahmen, um −θ zurückgedreht,
 * noch vollständig im Bild? Das ist `rahmenPasst`, und es ist die einzige
 * Bedingung, die dieses Modul kennt.
 *
 * # Warum die Ecken reichen
 *
 * Ein Rechteck ist konvex, das Bild ist konvex. Liegen alle vier Ecken drin,
 * liegt die ganze Fläche drin. Deshalb prüft und rechnet hier alles über die
 * vier Ecken und nie über eine Abtastung.
 */

import type { Punkt, Zuschnitt } from './doc.js';

/**
 * Wie weit sich neigen lässt, in Grad nach jeder Seite.
 *
 * 15° ist grosszügig für einen schiefen Horizont – schon 5° sieht deutlich
 * aus. Weiter zu gehen kostet: Bei 15° bleiben von einem 4:3-Bild noch etwa
 * 70 % der Fläche, bei 45° wäre die Hälfte weg. Wer ein Bild wirklich auf die
 * Ecke stellen will, nimmt die Vierteldrehung.
 */
export const NEIGUNG_MAX = 15;

/** Hält den Winkel im erlaubten Bereich und macht aus `NaN` eine 0. */
export function neigungKlemmen(grad: number): number {
  if (!Number.isFinite(grad)) return 0;
  return Math.max(-NEIGUNG_MAX, Math.min(NEIGUNG_MAX, grad));
}

/**
 * Der Winkel, wie er im ORIGINALraum wirkt.
 *
 * Der Regler steht für das, was man sieht: „+3°" heisst, das Bild kippt auf
 * dem Bildschirm im Uhrzeigersinn. Vierteldrehungen ändern daran nichts – sie
 * drehen den Rahmen mit. Eine Spiegelung schon: Sie kehrt den Drehsinn um.
 * Ohne diese Zeile ginge der Regler bei gespiegelten Bildern in die falsche
 * Richtung, und zwar nur dann – der ärgerlichste Fehler, weil er in neun von
 * zehn Fällen nicht auffällt.
 */
export function neigungImOriginal(grad: number, spiegel: boolean): number {
  return spiegel ? -grad : grad;
}

function bogen(grad: number): number {
  return (grad * Math.PI) / 180;
}

/** Dreht einen Punkt um ein Zentrum. Winkel in Grad, im Uhrzeigersinn. */
export function drehenUm(p: Punkt, mitte: Punkt, grad: number): Punkt {
  if (grad === 0) return { x: p.x, y: p.y };
  const w = bogen(grad);
  const sin = Math.sin(w);
  const cos = Math.cos(w);
  const dx = p.x - mitte.x;
  const dy = p.y - mitte.y;
  return {
    x: mitte.x + dx * cos - dy * sin,
    y: mitte.y + dx * sin + dy * cos,
  };
}

export function zuschnittMitte(z: Zuschnitt): Punkt {
  return { x: z.x + z.w / 2, y: z.y + z.h / 2 };
}

/**
 * Die vier Ecken des Rahmens, um `grad` um seine eigene Mitte zurückgedreht.
 *
 * Zurück, nicht vor: Das Bild dreht sich um +θ, also liegt der Rahmen aus
 * Sicht des ungedrehten Bildes bei −θ. Wer das Vorzeichen hier vertauscht,
 * bekommt eine Prüfung, die bei symmetrisch liegenden Rahmen trotzdem
 * grün ist – und bei allen anderen falsch.
 */
export function rahmenEcken(z: Zuschnitt, grad: number): Punkt[] {
  const mitte = zuschnittMitte(z);
  const ecken: Punkt[] = [
    { x: z.x, y: z.y },
    { x: z.x + z.w, y: z.y },
    { x: z.x + z.w, y: z.y + z.h },
    { x: z.x, y: z.y + z.h },
  ];
  return ecken.map((p) => drehenUm(p, mitte, -grad));
}

/**
 * Liegt der Rahmen nach der Neigung noch vollständig im Bild?
 *
 * `nachsicht` federt Rundungsfehler ab: Ein Rahmen, den `rahmenEinpassen`
 * gerade eben eingepasst hat, darf nicht am letzten Bit scheitern.
 */
export function rahmenPasst(
  z: Zuschnitt,
  breite: number,
  hoehe: number,
  grad: number,
  nachsicht = 1e-6,
): boolean {
  return rahmenEcken(z, grad).every(
    (p) =>
      p.x >= -nachsicht &&
      p.y >= -nachsicht &&
      p.x <= breite + nachsicht &&
      p.y <= hoehe + nachsicht,
  );
}

/**
 * Der grösste mittige Rahmen mit dem Seitenverhältnis `seiten` (Breite durch
 * Höhe), der die Neigung übersteht.
 *
 * Hergeleitet statt geraten: Ein Rechteck w×h, um θ gedreht, hat die
 * Hüllbreite w·cos + h·sin und die Hüllhöhe w·sin + h·cos. Weil beide
 * Rechtecke dieselbe Mitte haben und das Bild achsenparallel ist, liegen alle
 * vier Ecken genau dann drin, wenn die Hülle hineinpasst. Mit h = w/seiten
 * bleiben zwei Ungleichungen, jede linear in w – das Minimum der beiden
 * Schranken ist die Antwort.
 */
export function groessterRahmen(
  breite: number,
  hoehe: number,
  grad: number,
  seiten: number,
): { w: number; h: number } {
  if (!(seiten > 0) || !(breite > 0) || !(hoehe > 0)) return { w: 0, h: 0 };
  const w = bogen(grad);
  const sin = Math.abs(Math.sin(w));
  const cos = Math.abs(Math.cos(w));
  const grenzeBreite = (breite * seiten) / (seiten * cos + sin);
  const grenzeHoehe = (hoehe * seiten) / (seiten * sin + cos);
  const wMax = Math.min(grenzeBreite, grenzeHoehe);
  return { w: wMax, h: wMax / seiten };
}

/**
 * Zieht einen Rahmen so wenig wie möglich zusammen, bis er wieder passt.
 *
 * Zwei Schritte – **erst schrumpfen, dann verschieben**, und diese Reihenfolge
 * ist der ganze Trick:
 *
 * 1. **Auf eine Grösse bringen, die überhaupt irgendwo hineinpasst.** Der um
 *    θ gedrehte Rahmen belegt eine Hülle von w·cos + h·sin mal w·sin + h·cos.
 *    Ist sie breiter oder höher als das Bild, passt der Rahmen an KEINER
 *    Stelle – dann und nur dann wird verkleinert, und zwar genau so weit,
 *    dass die Hülle gerade noch hineingeht.
 * 2. **Die Mitte in den erlaubten Bereich holen.** Für eine feste Grösse
 *    liegen die zulässigen Mitten in einem Rechteck, das um die halbe Hülle
 *    nach innen gerückt ist. Hineinklemmen ist die kleinstmögliche
 *    Verschiebung.
 *
 * Umgekehrt geht es nicht, und das war mein erster Anlauf: Wer die Mitte
 * zuerst klemmt, klemmt sie womöglich auf die Bildecke – und um eine Bildecke
 * herum passt kein Rechteck ausser dem mit Kantenlänge null. Das Bild
 * verschwände beim Ziehen am Regler einfach.
 *
 * Ausserdem: Es wird um die MITTE DES RAHMENS gedreht, nicht um den
 * Bildursprung. Die Mitte bleibt also stehen, nur der Versatz zu den Ecken
 * dreht sich mit.
 */
export function rahmenEinpassen(
  z: Zuschnitt,
  breite: number,
  hoehe: number,
  grad: number,
): Zuschnitt {
  if (rahmenPasst(z, breite, hoehe, grad)) return { ...z };
  if (!(breite > 0) || !(hoehe > 0) || !(z.w > 0) || !(z.h > 0)) {
    return { x: 0, y: 0, w: 0, h: 0 };
  }

  const w = bogen(grad);
  const sin = Math.abs(Math.sin(w));
  const cos = Math.abs(Math.cos(w));

  // Schritt 1: die Hülle des gedrehten Rahmens auf Bildgrösse bringen.
  const huelleB = z.w * cos + z.h * sin;
  const huelleH = z.w * sin + z.h * cos;
  const skala = Math.min(1, breite / huelleB, hoehe / huelleH);
  const neuW = z.w * skala;
  const neuH = z.h * skala;

  // Schritt 2: die Mitte in das nach innen gerückte Rechteck klemmen.
  const randX = (neuW * cos + neuH * sin) / 2;
  const randY = (neuW * sin + neuH * cos) / 2;
  const mitte = zuschnittMitte(z);
  const mx = klemmen(mitte.x, randX, breite - randX);
  const my = klemmen(mitte.y, randY, hoehe - randY);

  return { x: mx - neuW / 2, y: my - neuH / 2, w: neuW, h: neuH };
}

/**
 * Klemmt einen Wert in `[unten, oben]`.
 *
 * Kippt die Spanne durch Rundung (`unten` minimal grösser als `oben`), ist
 * die Mitte der beiden die einzige sinnvolle Antwort – `Math.max` zuerst
 * würde sonst `unten` liefern und den Rahmen um Bruchteile hinausschieben.
 */
function klemmen(wert: number, unten: number, oben: number): number {
  if (unten > oben) return (unten + oben) / 2;
  return Math.max(unten, Math.min(oben, wert));
}

/**
 * Der Rahmen, der beim Ändern des Winkels herauskommen soll.
 *
 * Beim Ziehen am Regler wächst der Ausschnitt wieder mit, wenn man
 * zurückdreht – sonst hätte jedes Antippen des Reglers den Zuschnitt für
 * immer verkleinert, und nach dreimal Hin und Her wäre vom Bild nichts mehr
 * übrig. Deshalb wird nicht vom aktuellen Rahmen aus gerechnet, sondern vom
 * ungeneigten Ausgangsrahmen.
 */
export function neigungAnwenden(
  ausgang: Zuschnitt,
  breite: number,
  hoehe: number,
  grad: number,
): Zuschnitt {
  return rahmenEinpassen(ausgang, breite, hoehe, grad);
}
