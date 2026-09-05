/**
 * Die Griffe der beiden geometrischen Maskenteile – Verlauf und Ellipse.
 *
 * Anfassen, Ziehen und Loslassen ist Zeigerlogik; wo genau ein Griff sitzt und
 * was ein Zug aus einem Maskenteil macht, ist dagegen Geometrie. Getrennt,
 * weil nur das Zweite prüfbar ist: Ein Vorzeichenfehler in der Senkrechten
 * sieht auf dem Bildschirm nach „der Verlauf zappelt“ aus und verrät nicht,
 * an welcher der drei beteiligten Rechnungen es liegt.
 *
 * **Alles in ORIGINALpunkten.** Wie schon Zuschnitt, Striche und Textanker in
 * `doc.ts`. Drehung, Spiegelung, Zuschnitt und Lupe legt die Zeichenschicht
 * hinterher darüber – ein Griff muss von keinem davon wissen, sonst müsste
 * jede dieser vier Einstellungen hier nachgezogen werden.
 *
 * Nichts in dieser Datei ändert etwas an Ort und Stelle. Die Maskenteile
 * wandern in `docKopie` per Referenz weiter (ein Netzteil ist bis zu 1,8 MB
 * gross) – wer eines davon anfasste, änderte damit auch jeden Schritt des
 * Rückgängig-Verlaufs.
 *
 * `griffZiehen` gibt deshalb ein neues Teil zurück, mit einer Ausnahme, die
 * hier stehen muss und nicht erst hundert Zeilen weiter unten: Bei einem
 * unbekannten Griffnamen kommt das übergebene Teil SELBST zurück. Wer
 * `griffZiehen(...) !== teil` als „es ist etwas passiert“ liest, bekommt dort
 * also das Gegenteil. Die Alternative – eine Kopie ohne Änderung – legte bei
 * jedem Fehlgriff eine neue an, und der Aufrufer verlöre die einzige billige
 * Möglichkeit zu erkennen, dass nichts geschehen ist.
 */

import type { Punkt, RadialTeil, VerlaufTeil } from './doc.js';

export type Griffname = 'von' | 'bis' | 'achse' | 'mitte' | 'rx' | 'ry' | 'dreh';

export interface Griff {
  name: Griffname;
  x: number;
  y: number;
}

/**
 * Wo der Drehgriff sitzt, als Vielfaches von `rx`.
 *
 * Auf demselben Strahl wie der rx-Griff, ein Viertel weiter draussen: Der
 * Daumen dreht dann um die Ellipsenmitte, wie an einem Hebel, statt an einer
 * beliebigen Stelle neben der Form zu hängen. Der Preis dafür steht in
 * `griffTreffer` – zwei Griffe auf einem Strahl vertragen keinen Treffer nach
 * dem Windhundprinzip.
 */
const DREH_WEITE = 1.25;

/** Die kleinste Halbachse. Bei 0 hätte die Ellipse keine Richtung mehr. */
const RADIUS_MIN = 1;

/**
 * Eine Kopie mit geänderten Feldern.
 *
 * Die Umtypung ist nötig, weil TypeScript einen Streuwert über einen
 * generischen Typ nicht wieder als denselben Typ erkennt – `start.art` grenzt
 * `T` selbst nicht ein, nur den Wert. Sie ist eng gefasst: `aenderung` kennt
 * nur Felder, die es an einem der beiden Teile wirklich gibt, ein Tippfehler
 * im Feldnamen fällt also weiterhin auf.
 */
function mit<T extends VerlaufTeil | RadialTeil>(
  start: T,
  aenderung: Partial<VerlaufTeil> & Partial<RadialTeil>,
): T {
  return { ...start, ...aenderung } as unknown as T;
}

/** Die Griffe eines Teils, in der Reihenfolge, in der sie gezeichnet werden. */
export function griffeVon(teil: VerlaufTeil | RadialTeil): Griff[] {
  if (teil.art === 'verlauf') {
    return [
      { name: 'von', x: teil.von.x, y: teil.von.y },
      { name: 'bis', x: teil.bis.x, y: teil.bis.y },
      // Die Mitte der Achse ist der Griff zum Verschieben. Sie liegt genau
      // dort, wo das Gewicht 0,5 ist – man fasst den Verlauf also an seiner
      // Kante an und nicht an einer erfundenen Stelle daneben.
      { name: 'achse', x: (teil.von.x + teil.bis.x) / 2, y: (teil.von.y + teil.bis.y) / 2 },
    ];
  }
  const cos = Math.cos(teil.winkel);
  const sin = Math.sin(teil.winkel);
  return [
    { name: 'mitte', x: teil.mitte.x, y: teil.mitte.y },
    { name: 'rx', x: teil.mitte.x + teil.rx * cos, y: teil.mitte.y + teil.rx * sin },
    // Die Nebenachse ist die um 90° gedrehte Hauptachse: (cos, sin) → (−sin, cos).
    { name: 'ry', x: teil.mitte.x - teil.ry * sin, y: teil.mitte.y + teil.ry * cos },
    {
      name: 'dreh',
      x: teil.mitte.x + teil.rx * DREH_WEITE * cos,
      y: teil.mitte.y + teil.rx * DREH_WEITE * sin,
    },
  ];
}

/**
 * Der nächstliegende Griff innerhalb von `nah` – oder keiner.
 *
 * NÄCHSTER, nicht erster. Das ist der einzige Grund, warum hier eine Schleife
 * mit Bestwert steht und kein `find`: Der Drehgriff sitzt auf demselben Strahl
 * wie der rx-Griff, nur um den Faktor 1,25 weiter draussen. Bei „der erste
 * Treffer gewinnt“ fängt der rx-Griff jede Berührung ab, die dem Drehgriff
 * galt – sobald `nah` grösser ist als das Viertel zwischen beiden, und das ist
 * es bei einer kleinen Ellipse immer. Die Ellipse liesse sich dann überhaupt
 * nicht mehr drehen, nur noch aufziehen.
 *
 * Verglichen wird im Quadrat; die Wurzel ändert an der Reihenfolge nichts.
 */
/**
 * Wie nah ein Finger einem Griff kommen muss, in ORIGINALpunkten.
 *
 * Ein Griff soll unter dem Finger immer gleich gross sein, egal wie weit man
 * hineingezoomt hat – also 22 Leinwandpunkte, umgerechnet. Bei einem
 * 4000er Foto in einer 1200er Ansicht ist `faktor` 0,3, der Fangbereich also
 * 73 Originalpunkte; bei achtfacher Lupe sind es 9. Ein fester Wert in
 * Originalpunkten wäre bei herangezoomter Ansicht ein Fangkreis über die
 * halbe Bildschirmbreite und bei herausgezoomter unerreichbar klein.
 *
 * Genau dieser Fehler steckte einmal im Zuschnittrahmen; dort schrumpfte der
 * Fangbereich nicht mit, und bei dreifacher Lupe war „innen“ nicht mehr
 * erreichbar.
 */
export function fangBereich(faktor: number): number {
  return 22 / Math.max(0.0001, faktor);
}

export function griffTreffer(griffe: Griff[], punkt: Punkt, nah: number): Griffname | null {
  /*
   * Positiv abfragen statt negativ ausschliessen.
   *
   * `if (abstand > grenze) continue` sieht gleichwertig aus, ist es aber
   * nicht: Bei `NaN` ist jeder Vergleich falsch, der Ausschluss greift also
   * nicht, und der erste Griff der Liste wird angenommen. Nachgemessen:
   * `griffTreffer(griffe, { x: NaN, y: NaN }, 60)` lieferte „mitte“.
   *
   * Ein NaN entsteht eine Schicht höher, sobald aus Bildschirm- in
   * Originalpunkte durch eine Leinwandbreite 0 geteilt wird – ein Fingerdruck
   * während eines Grössenwechsels reicht. Die Folge wäre ein Antippen ohne
   * gültige Koordinate, das den Mittengriff der Ellipse fasst und beim
   * nächsten Zug die ganze Maske verschiebt.
   *
   * Ein negatives `nah` fiele ebenfalls durch, weil nur das Quadrat
   * verglichen wird – deshalb steht die Abfrage davor.
   */
  if (!(nah > 0)) return null;
  const grenze = nah * nah;
  let beste: Griffname | null = null;
  let bestes = 0;
  for (const griff of griffe) {
    const dx = griff.x - punkt.x;
    const dy = griff.y - punkt.y;
    const abstand = dx * dx + dy * dy;
    if (!(abstand <= grenze)) continue;
    if (beste === null || abstand < bestes) {
      beste = griff.name;
      bestes = abstand;
    }
  }
  return beste;
}

/**
 * Ein Zug an einem Griff, als neues Teil.
 *
 * `ziel` ist, wo der Finger JETZT liegt, `startZiel`, wo er aufgesetzt hat.
 * Beides wird gebraucht, und zwar für zwei verschiedene Sorten von Griff:
 *
 * - Die Endgriffe (`von`, `bis`, `rx`, `ry`, `dreh`) springen auf `ziel`. Sie
 *   sind die Stelle selbst, die man setzt.
 * - Die Schiebegriffe (`achse`, `mitte`) verschieben um die DIFFERENZ. Setzte
 *   man die Mitte auf `ziel`, spränge die Ellipse beim Aufsetzen unter den
 *   Finger, sobald man sie irgendwo anders als exakt im Mittelpunkt anfasst –
 *   und anfassen darf man sie auf ihrer ganzen Fläche.
 */
export function griffZiehen<T extends VerlaufTeil | RadialTeil>(
  start: T,
  name: Griffname,
  ziel: Punkt,
  startZiel: Punkt,
): T {
  const dx = ziel.x - startZiel.x;
  const dy = ziel.y - startZiel.y;

  if (start.art === 'verlauf') {
    switch (name) {
      case 'von':
        return mit(start, { von: { x: ziel.x, y: ziel.y } });
      case 'bis':
        return mit(start, { bis: { x: ziel.x, y: ziel.y } });
      case 'achse':
        return mit(start, {
          von: { x: start.von.x + dx, y: start.von.y + dy },
          bis: { x: start.bis.x + dx, y: start.bis.y + dy },
        });
      default:
        // Ein Griffname, den es an diesem Teil nicht gibt. Zurück kommt das
        // Teil SELBST, nicht eine gleiche Kopie: Am Feld `teile` eines
        // Bereichs hängt der Maskenspeicher über Objektgleichheit, und eine
        // Kopie ohne Änderung würfe jede gerasterte Maske weg.
        return start;
    }
  }

  const mitte = start.mitte;
  switch (name) {
    case 'mitte':
      return mit(start, { mitte: { x: mitte.x + dx, y: mitte.y + dy } });
    case 'rx': {
      const ex = ziel.x - mitte.x;
      const ey = ziel.y - mitte.y;
      /*
       * Radius UND Winkel, nicht nur der Radius.
       *
       * Der rx-Griff ist der Griff an der Hauptachse; zieht man ihn zur Seite,
       * ist die Hauptachse dorthin gewandert. Setzte man nur `rx`, bliebe der
       * Winkel der alte, und der Griff spränge im Moment des Loslassens auf
       * die alte Achse zurück – die Form folgte dem Finger, das Ergebnis nicht.
       */
      /*
       * Der Winkel nur, wenn der Zeiger überhaupt eine Richtung hat.
       *
       * `Math.atan2(0, 0)` ist 0 – wer den Griff auf die Mitte zieht, stellte
       * die Ellipse damit schlagartig achsenparallel, und einen Bildpunkt
       * daneben spränge sie auf 45°. Nachgemessen: aus Winkel 0,6 wurde beim
       * Zug auf die Mitte { rx: 1, winkel: 0 }. Unterhalb von `RADIUS_MIN`
       * bleibt der Winkel deshalb stehen; die Form wird klein, sie dreht sich
       * nicht wild.
       */
      const laenge = Math.hypot(ex, ey);
      return mit(start, {
        rx: Math.max(RADIUS_MIN, laenge),
        winkel: laenge >= RADIUS_MIN ? Math.atan2(ey, ex) : start.winkel,
      });
    }
    case 'ry':
      // Hier ausdrücklich OHNE Winkel: Haupt- und Nebenachse stehen fest
      // senkrecht aufeinander, ein zweiter Winkel wäre eine Scherung.
      return mit(start, {
        ry: Math.max(RADIUS_MIN, Math.hypot(ziel.x - mitte.x, ziel.y - mitte.y)),
      });
    case 'dreh':
      // Nur der Winkel – der Abstand zur Mitte ist beim Drehen gleichgültig,
      // sonst zöge jede Drehung die Ellipse nebenbei grösser.
      return mit(start, { winkel: Math.atan2(ziel.y - mitte.y, ziel.x - mitte.x) });
    default:
      return start;
  }
}

/** Der Ellipsenrand als Punktkette – zum Zeichnen, ohne Winkelumrechnung. */
export function radialRand(t: RadialTeil, punkte = 48): Punkt[] {
  // Unter drei Punkten gibt es keine Fläche mehr, nur noch einen Strich.
  // `Math.max(3, NaN)` ist NaN und die Schleife liefe null Mal – der Zeichner
  // bekäme eine leere Kette und zeigte gar keinen Rand. Deshalb die Abfrage
  // auf „ist überhaupt eine Zahl“ und nicht nur die Untergrenze.
  const anzahl = punkte >= 3 ? Math.round(punkte) : 3;
  const cos = Math.cos(t.winkel);
  const sin = Math.sin(t.winkel);
  const rand: Punkt[] = [];
  for (let i = 0; i < anzahl; i += 1) {
    // `i / anzahl`, nicht `i / (anzahl − 1)`: Der letzte Punkt soll NICHT auf
    // dem ersten liegen, sonst hätte die geschlossene Kette dort einen
    // doppelten Stützpunkt und die Strichverbindung einen Knoten.
    const w = (i / anzahl) * Math.PI * 2;
    const ex = t.rx * Math.cos(w);
    const ey = t.ry * Math.sin(w);
    rand.push({ x: t.mitte.x + ex * cos - ey * sin, y: t.mitte.y + ex * sin + ey * cos });
  }
  return rand;
}

/** Die zwei Linien eines Verlaufs (Anfangs- und Endlinie), je als Strecke. */
export function verlaufLinien(t: VerlaufTeil, laenge?: number): [Punkt, Punkt][] {
  const ax = t.bis.x - t.von.x;
  const ay = t.bis.y - t.von.y;
  const achse = Math.hypot(ax, ay);
  /*
   * Vorgabelänge ist die Achsenlänge selbst.
   *
   * Eine feste Länge in Originalpunkten sähe an einem 4000er Foto wie ein
   * Strich und an einem 300er wie ein Balken aus. So wächst die Anzeige mit
   * dem Verlauf, den sie zeigt, und bleibt in jeder Lupenstufe im Verhältnis.
   */
  const halb = (laenge ?? achse) / 2;
  // Bei Achsenlänge null gibt es keine Senkrechte. Statt NaN durchzureichen,
  // wird nach unten gezeigt – mit der Vorgabelänge sind beide Linien dann
  // ohnehin Punkte, und eine ausdrücklich angegebene Länge ergibt wenigstens
  // etwas Sichtbares statt zweier verschwundener Linien.
  const nx = achse > 0 ? -ay / achse : 0;
  const ny = achse > 0 ? ax / achse : 1;
  const linie = (p: Punkt): [Punkt, Punkt] => [
    { x: p.x - nx * halb, y: p.y - ny * halb },
    { x: p.x + nx * halb, y: p.y + ny * halb },
  ];
  return [linie(t.von), linie(t.bis)];
}
