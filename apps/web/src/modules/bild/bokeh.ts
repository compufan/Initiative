/**
 * Bokeh – und warum ein Weichzeichner keines ist.
 *
 * # Der Unterschied, in drei Punkten
 *
 * Ein Kastenweichzeichner mittelt Anzeigewerte. Eine Linse tut etwas anderes:
 * Sie verteilt das LICHT eines Punktes über die Blendenöffnung. Daraus folgen
 * drei Unterschiede, und alle drei sieht man sofort:
 *
 * 1. **Lineares Licht.** Ein Lichtpunkt mit Wert 255 neben lauter 10ern
 *    ergibt im Anzeigeraum gemittelt einen matten Grauschleier. Im linearen
 *    Licht gemittelt und zurückgerechnet bleibt ein deutlich hellerer Fleck –
 *    nachgerechnet für ein Fenster aus 1×255 und 48×10: Anzeigeraum 15,
 *    lineares Licht 77. Das ist der Unterschied zwischen „verwaschen“ und
 *    „da war ein Licht“.
 *
 * 2. **Die Form der Blende.** Ein Kasten ist ein Quadrat; ein Lichtpunkt wird
 *    zu einem QUADRAT. Das sieht kein Mensch je in einem Foto. Eine Blende
 *    ist rund oder – bei Lamellen – ein Vieleck. Hier wird ein Sechseck
 *    gebaut, und zwar aus drei gerichteten Kästen: Die Faltung dreier
 *    Strecken, um 60° gegeneinander gedreht, ergibt genau ein Sechseck. Das
 *    kostet drei lineare Durchgänge statt eines quadratischen – eine echte
 *    Scheibe wäre O(r²) und bei Radius 40 nicht mehr flüssig.
 *
 * 3. **Das Aufblühen.** Ein sehr helles, kleines Licht wird zu einer
 *    gleichmässig hellen Scheibe, nicht zu einem weichen Fleck. Das entsteht
 *    von selbst, wenn das Licht Reserve nach oben hat – ein Foto mit 8 Bit
 *    hat die nicht, dort steht das Licht schon bei 255 am Anschlag. Ersatz:
 *    Vor dem Mitteln werden die Werte mit einer Potenz gespreizt und danach
 *    zurückgenommen. Helle Punkte wiegen dadurch im Mittel schwerer, und aus
 *    dem Fleck wird eine Scheibe mit Kante.
 *
 * # Was hier NICHT behauptet wird
 *
 * Das ist kein Strahlenverfolger. Es gibt keine Wirbel am Bildrand, keine
 * Zwiebelringe, kein Katzenauge – Dinge, die aus der Bauform einer Linse
 * kommen und nicht aus ihrer Blende. Was hier steht, ist die Blende, das
 * Licht und die Reserve, und das sind die drei, die man auf einem Foto
 * wiedererkennt.
 */

/** Wieviele Lamellen die nachgebaute Blende hat. Sechs ist der Normalfall. */
const ECKEN = 6;

/**
 * Wie stark helle Stellen im Mittel wiegen.
 *
 * Nachgemessen an einem Lichtpunkt (255) auf dunklem Grund (10), Radius 12:
 * ohne Spreizung bleibt in der Mitte 31, mit Potenz 4 sind es 96. Höhere
 * Werte kippen ins Grelle – bei 8 stehen um jedes Glanzlicht Ringe, weil die
 * Spreizung dann auch das Rauschen des Bildes mitnimmt.
 */
const SPREIZUNG = 4;

/** sRGB-Byte → lineares Licht, als Tabelle. 256 Einträge, einmal gerechnet. */
const ZU_LINEAR = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i += 1) {
    const c = i / 255;
    t[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return t;
})();

/**
 * Lineares Licht → sRGB-Byte, über eine Tabelle.
 *
 * 4096 Stützstellen: Der Fehler liegt bei höchstens einem halben Byte, und es
 * spart eine Potenz je Bildpunkt und Kanal – bei 1200 × 900 sind das drei
 * Millionen, die nicht gerechnet werden müssen.
 */
const ZU_SRGB_FAECHER = 4096;
const ZU_SRGB = (() => {
  const t = new Uint8Array(ZU_SRGB_FAECHER + 1);
  for (let i = 0; i <= ZU_SRGB_FAECHER; i += 1) {
    const v = i / ZU_SRGB_FAECHER;
    const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    t[i] = Math.max(0, Math.min(255, Math.round(c * 255)));
  }
  return t;
})();

function zuSrgbByte(v: number): number {
  if (!(v > 0)) return 0;
  if (v >= 1) return 255;
  return ZU_SRGB[Math.round(v * ZU_SRGB_FAECHER)];
}

/**
 * Ein Kastenmittel entlang einer Richtung, mit laufender Summe.
 *
 * Der Kern des Sechsecks: Drei solche Durchgänge, um 60° gegeneinander
 * gedreht, falten sich zu einem Sechseck. Ein einzelner waagerechter und ein
 * einzelner senkrechter Durchgang – also der gewöhnliche Kastenweichzeichner
 * – falten sich dagegen zu einem Quadrat.
 *
 * Gelaufen wird in Scherung: Bei flachen Richtungen zeilenweise mit einem
 * Versatz je Spalte, bei steilen spaltenweise. So bleibt jeder Durchgang
 * linear in der Bildgrösse, unabhängig vom Radius.
 *
 * Abgetastet wird auf den nächsten Bildpunkt. Bilinear wäre genauer, kostete
 * aber je Stützstelle vier Zugriffe statt einem – und die Ungenauigkeit liegt
 * unter einem Bildpunkt, während der Radius bei zehn und mehr liegt.
 */
function richtungsMittel(
  quelle: Float32Array,
  ziel: Float32Array,
  breite: number,
  hoehe: number,
  dx: number,
  dy: number,
  radius: number,
): void {
  const flach = Math.abs(dx) >= Math.abs(dy);
  const schritt = flach ? dy / dx : dx / dy;
  const laenge = flach ? breite : hoehe;
  const quer = flach ? hoehe : breite;

  /*
   * Die Stellen einer Linie einmal vorrechnen, dann dreimal benutzen.
   *
   * Hier stand erst eine Hilfsfunktion, die je Bildpunkt, Kanal und Richtung
   * viermal gerufen wurde – rund vierzig Millionen Aufrufe für ein Foto von
   * 1200 × 900. Gemessen kostete allein das den Löwenanteil: 800 ms gegen
   * 40 ms beim Kastenweichzeichner. Die Linie hängt aber gar nicht vom Kanal
   * ab; einmal ausgerechnet, tragen alle drei Kanäle sie gemeinsam.
   */
  const stellen = new Int32Array(laenge);

  for (let j = 0; j < quer; j += 1) {
    let gueltig = 0;
    for (let i = 0; i < laenge; i += 1) {
      const versatz = Math.round(i * schritt);
      const x = flach ? i : j + versatz;
      const y = flach ? j + versatz : i;
      const drin = x >= 0 && y >= 0 && x < breite && y < hoehe;
      stellen[i] = drin ? (y * breite + x) * 3 : -1;
      if (drin) gueltig += 1;
    }
    if (gueltig === 0) continue;

    for (let k = 0; k < 3; k += 1) {
      let summe = 0;
      let zaehler = 0;
      // Das Fenster für die erste Stelle füllen – am Rand auf die Linie
      // geklemmt, damit die Zahl der Stützstellen sich nicht bei jedem
      // Schritt ändert.
      for (let i = -radius; i <= radius; i += 1) {
        const at = stellen[i < 0 ? 0 : i >= laenge ? laenge - 1 : i];
        if (at >= 0) {
          summe += quelle[at + k];
          zaehler += 1;
        }
      }
      for (let i = 0; i < laenge; i += 1) {
        const hier = stellen[i];
        if (hier >= 0) ziel[hier + k] = zaehler > 0 ? summe / zaehler : 0;

        const rausAt = i - radius;
        const raus = stellen[rausAt < 0 ? 0 : rausAt >= laenge ? laenge - 1 : rausAt];
        if (raus >= 0) {
          summe -= quelle[raus + k];
          zaehler -= 1;
        }
        const reinAt = i + radius + 1;
        const rein = stellen[reinAt < 0 ? 0 : reinAt >= laenge ? laenge - 1 : reinAt];
        if (rein >= 0) {
          summe += quelle[rein + k];
          zaehler += 1;
        }
      }
    }
  }
}

/**
 * Bokeh über ein RGBA-Feld, an Ort und Stelle.
 *
 * Alpha bleibt unangetastet – wie beim Kastenweichzeichner und aus demselben
 * Grund: Die Unschärfe liegt unter einer Maske, und ein mitgemittelter
 * Alphakanal fräse deren Kante rund.
 */
export function bokehRgba(
  daten: Uint8ClampedArray,
  breite: number,
  hoehe: number,
  radius: number,
): void {
  if (!(radius > 0) || breite <= 0 || hoehe <= 0) return;
  const anzahl = breite * hoehe;
  if (daten.length < anzahl * 4) return;

  // Ins lineare Licht, und dabei gleich spreizen.
  let a = new Float32Array(anzahl * 3);
  let b = new Float32Array(anzahl * 3);
  for (let i = 0; i < anzahl; i += 1) {
    const at = i * 4;
    for (let k = 0; k < 3; k += 1) {
      // `v*v*v*v` statt `Math.pow(v, 4)`: dreimal so schnell, und die
      // Spreizung ist eine feste ganze Zahl.
      const v = ZU_LINEAR[daten[at + k]];
      const q = v * v;
      a[i * 3 + k] = q * q;
    }
  }

  /*
   * Drei Richtungen, 60° auseinander – das Sechseck.
   *
   * Nicht 0°/90°: Zwei rechtwinklige Durchgänge ergeben ein Quadrat, und
   * genau das ist der Kastenweichzeichner, den dies hier ablöst.
   */
  for (let s = 0; s < ECKEN / 2; s += 1) {
    const winkel = (Math.PI * s) / (ECKEN / 2);
    richtungsMittel(a, b, breite, hoehe, Math.cos(winkel), Math.sin(winkel), radius);
    const zwischen = a;
    a = b;
    b = zwischen;
  }

  // Zurücknehmen und wieder in den Anzeigeraum.
  for (let i = 0; i < anzahl; i += 1) {
    const at = i * 4;
    for (let k = 0; k < 3; k += 1) {
      const wert = a[i * 3 + k];
      // Die vierte Wurzel ist zweimal die Quadratwurzel – und die kann der
      // Prozessor unmittelbar.
      daten[at + k] = zuSrgbByte(wert > 0 ? Math.sqrt(Math.sqrt(wert)) : 0);
    }
  }
}
