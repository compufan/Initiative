/**
 * Die Unschärfemaske – das, was jedes Bearbeitungsprogramm „Schärfen“ nennt.
 *
 * # Was vorher da war, und warum es nicht half
 *
 * Gerechnet wurde die Differenz zum Mittel der VIER direkten Nachbarn, mal
 * 1,5, hart geklemmt. Das hat drei Eigenschaften, und alle drei sind der
 * Grund, warum man von diesem Regler wenig hatte:
 *
 *   * Der Radius ist auf genau einen Bildpunkt gelötet. Bei einem Foto von
 *     zwölf Megapunkten fasst das ausschliesslich die feinste Ebene an – also
 *     das Rauschen. Ein leicht verwackeltes Bild, dessen Streifen zwanzig
 *     Punkte lang ist, wird davon nicht um ein Haar besser; es wird körniger.
 *   * Es gibt keine Schwelle. Der Unterschied zwischen zwei benachbarten
 *     Rauschpunkten in einem glatten Himmel wird genauso verstärkt wie eine
 *     Dachkante. Daran erkennt man überschärfte Fotos.
 *   * Gerechnet wird in ANZEIGEWERTEN. Die sind nicht proportional zum Licht,
 *     und deshalb fällt derselbe Unterschied auf der hellen Seite einer Kante
 *     stärker aus als auf der dunklen. Das ist der helle Saum, der über jeder
 *     dunklen Kante steht.
 *
 * # Was hier steht
 *
 * Dieselbe Idee, aber mit den drei Dingen, die sie brauchbar machen: ein
 * einstellbarer Radius, eine Schwelle und lineares Licht. Dazu eine vierte
 * Sache, die kein Programm bewirbt und die den grössten Unterschied macht –
 * die Saumbegrenzung: Das Ergebnis wird auf das kleinste und grösste
 * Quellsignal in seiner Umgebung geklemmt. Damit kann eine Kante steiler
 * werden, aber nicht über das hinausschiessen, was daneben liegt. Genau das
 * meint „Smart Sharpen“.
 *
 * # Warum ein Abtastmuster und kein richtiger Gauss
 *
 * Ein separabler Gauss wären zwei Durchgänge. Der Schattierer hat aber nur
 * einen – er rechnet das ganze Bild in einem Zug –, und zwei Durchgänge
 * daraus zu machen hiesse, die halbe Farbkette umzubauen. Statt dessen wird
 * ein festes Muster aus fünfundzwanzig Stellen abgetastet, dessen Abstand mit
 * dem Radius wächst.
 *
 * Für eine Unschärfemaske ist das genug: Gebraucht wird nicht die genaue Form
 * der Glocke, sondern ihre WEITE. Und weil Prozessor und Grafikeinheit exakt
 * dasselbe Muster benutzen, sehen beide Wege gleich aus – was bei getrennten
 * Verfahren (hier Gauss, dort Kasten) nicht der Fall wäre.
 */

import { zuLinear, zuSrgb } from './ton.js';

/**
 * Das Abtastmuster: fünf mal fünf Stellen, in Vielfachen des halben Radius.
 *
 * Fünfundzwanzig Stellen sind der Punkt, an dem es aufhört, besser zu werden:
 * Bei neun sieht man das Kreuz im Saum, bei neunundvierzig sieht man nichts
 * mehr, was man bei fünfundzwanzig nicht auch sähe.
 */
export const ABTAST_N = 2;

/**
 * Das Gewicht einer Stelle – eine Glocke über dem Abstand.
 *
 * Ohne Gewichte wäre es ein Kastenmittel, und ein Kasten hat eine harte
 * Kante im Frequenzgang: An einer Linie, die gerade so breit ist wie der
 * Kasten, entsteht ein zweiter, schwächerer Saum daneben. Die Glocke hat das
 * nicht.
 */
export function abtastGewicht(dx: number, dy: number): number {
  // σ = N/2 über das Gitter gerechnet; der Betrag ist gleichgültig, weil
  // hinterher durch die Summe geteilt wird.
  const q = (dx * dx + dy * dy) / (2 * (ABTAST_N / 2) * (ABTAST_N / 2));
  return Math.exp(-q);
}

/**
 * Wie stark ein Unterschied nach der Schwelle noch zählt, 0 … 1.
 *
 * Weich und nicht als Sprung: Eine harte Schwelle erzeugt genau dort, wo sie
 * liegt, eine sichtbare Grenze im Bild – in einem Verlauf sieht man dann eine
 * Linie, an der die Schärfe einsetzt.
 *
 * `betrag` und `schwelle` sind beide in linearem Licht, 0 … 1.
 */
export function schwellenAnteil(betrag: number, schwelle: number): number {
  if (schwelle <= 0) return 1;
  // Der Übergang ist so breit wie die Schwelle selbst.
  const t = (betrag - schwelle) / schwelle;
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

/**
 * Die Unschärfemaske auf einen Kanal, in linearem Licht.
 *
 * `mitte` ist der Quellwert, `weich` das gewichtete Mittel der Umgebung,
 * `kleinst`/`groesst` deren Spanne – alle vier in linearem Licht. Zurück
 * kommt der neue Wert, ebenfalls linear.
 */
export function schaerfeAn(
  mitte: number,
  weich: number,
  kleinst: number,
  groesst: number,
  staerke: number,
  schwelle: number,
): number {
  const diff = mitte - weich;
  const anteil = schwellenAnteil(Math.abs(diff), schwelle);
  if (anteil <= 0) return mitte;
  const roh = mitte + diff * staerke * anteil;
  /*
   * Die Saumbegrenzung.
   *
   * Ohne sie schiesst eine verstärkte Kante über das hinaus, was rechts und
   * links von ihr wirklich steht – und genau das ist der weisse Saum. Mit ihr
   * wird die Kante steiler, aber sie bleibt innerhalb der Helligkeiten, die
   * im Bild vorkommen.
   */
  return Math.min(groesst, Math.max(kleinst, roh));
}

/**
 * Die Unschärfemaske über ein ganzes RGBA-Feld – der Weg ohne Grafikeinheit.
 *
 * `daempfung` ist das Bokeh-Gewicht je Punkt (0 … 255) oder `null`. Wo
 * unscharf gezeichnet wurde, darf nicht nachgeschärft werden: Sonst holte die
 * Schärfe genau die Hochfrequenz aus dem scharfen Quellbild zurück, die die
 * Tiefenschärfe gerade entfernt hat – der Hintergrund wäre unscharf UND
 * kantig.
 */
export function schaerfenFeld(
  daten: Uint8ClampedArray,
  breite: number,
  hoehe: number,
  staerke: number,
  radius: number,
  schwelle: number,
  daempfung: Uint8Array | null,
  quelle: Uint8ClampedArray,
): void {
  if (!(staerke > 0) || breite <= 0 || hoehe <= 0) return;
  const schritt = Math.max(0.5, radius) / ABTAST_N;

  // Die Gewichte einmal vorrechnen – sie hängen nur vom Gitter ab.
  const gewichte: number[] = [];
  let summe = 0;
  for (let dy = -ABTAST_N; dy <= ABTAST_N; dy += 1) {
    for (let dx = -ABTAST_N; dx <= ABTAST_N; dx += 1) {
      const g = abtastGewicht(dx, dy);
      gewichte.push(g);
      summe += g;
    }
  }

  for (let y = 0; y < hoehe; y += 1) {
    for (let x = 0; x < breite; x += 1) {
      const at = (y * breite + x) * 4;
      const daempf = daempfung ? 1 - daempfung[y * breite + x] / 255 : 1;
      if (daempf <= 0) continue;
      for (let k = 0; k < 3; k += 1) {
        let weich = 0;
        let kleinst = 1;
        let groesst = 0;
        let i = 0;
        for (let dy = -ABTAST_N; dy <= ABTAST_N; dy += 1) {
          const py = Math.min(hoehe - 1, Math.max(0, Math.round(y + dy * schritt)));
          for (let dx = -ABTAST_N; dx <= ABTAST_N; dx += 1) {
            const px = Math.min(breite - 1, Math.max(0, Math.round(x + dx * schritt)));
            const wert = zuLinear(quelle[(py * breite + px) * 4 + k] / 255);
            weich += wert * gewichte[i];
            if (wert < kleinst) kleinst = wert;
            if (wert > groesst) groesst = wert;
            i += 1;
          }
        }
        weich /= summe;
        const mitte = zuLinear(quelle[at + k] / 255);
        const neu = schaerfeAn(mitte, weich, kleinst, groesst, staerke * 1.5 * daempf, schwelle);
        daten[at + k] = Math.round(zuSrgb(neu) * 255);
      }
    }
  }
}
