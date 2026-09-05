/**
 * Tiefenkarten: von der Rohausgabe des Netzes zur Unschärfe je Bildpunkt.
 *
 * Alles hier ist reine Rechnung ohne Netz, ohne Leinwand und ohne Zustand –
 * damit es prüfbar bleibt. Das Modell selbst steckt in `tiefeNetz.ts`.
 *
 * # Was das Netz liefert
 *
 * Depth Anything V2 gibt *inverse relative* Tiefe aus: ein grosser Wert heisst
 * NAH, ein kleiner FERN, und die Skala ist von Bild zu Bild verschieden. Am
 * Probebild gemessen: 0,35 am Himmel, 2,23 am nächsten Gegenstand. Es gibt
 * also keine Meter und keinen festen Wertebereich – jedes Bild muss für sich
 * normalisiert werden.
 *
 * # Warum das für die Unschärfe genau passt
 *
 * Der Zerstreuungskreis einer echten Linse ist proportional zum Unterschied
 * der KEHRWERTE der Entfernungen:
 *
 *     Durchmesser ∝ |1/z − 1/z_scharf|
 *
 * Das Netz gibt uns 1/z bereits. Der Weg von der Tiefenkarte zur Unschärfe
 * ist deshalb ein schlichter Betrag der Differenz – keine Kurve, kein
 * Nachjustieren. Wer hier ein `smoothstep` einbaut, macht es hübscher und
 * falscher.
 */

/** Eine Tiefenkarte. 0 = fern, 255 = nah. */
export interface Tiefenkarte {
  readonly breite: number;
  readonly hoehe: number;
  readonly feld: Uint8Array;
}

function klemmen(wert: number, von: number, bis: number): number {
  if (!(wert > von)) return von;
  return wert > bis ? bis : wert;
}

/**
 * Die Rohausgabe auf 0…255 ziehen.
 *
 * Nicht über Kleinst- und Grösstwert, sondern über das 1.- und 99.-Perzentil.
 * Ein einzelner Ausreisser – eine Spiegelung, ein überstrahltes Fenster –
 * würde sonst die ganze Skala an sich ziehen und den Rest des Bildes in ein
 * schmales Band quetschen. Mit den Perzentilen kostet das im schlimmsten Fall
 * ein Prozent der Fläche, das an den Anschlag gerät.
 *
 * Das Histogramm hat 4096 Fächer statt 256: Bei 256 wäre die Auflösung der
 * Perzentilgrenze ein Vierundzwanzigstel des Wertebereichs – grob genug, um
 * bei einem flachen Bild die Grenzen zusammenfallen zu lassen.
 */
export function tiefeNormalisieren(roh: Float32Array, breite: number, hoehe: number): Tiefenkarte {
  const anzahl = breite * hoehe;
  const feld = new Uint8Array(anzahl);
  if (anzahl <= 0 || roh.length < anzahl) return { breite, hoehe, feld };

  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < anzahl; i += 1) {
    const v = roh[i];
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  // Ein völlig flaches Bild (oder lauter NaN): alles auf dieselbe Ebene.
  if (!Number.isFinite(min) || !Number.isFinite(max) || max - min < 1e-9) {
    feld.fill(128);
    return { breite, hoehe, feld };
  }

  const FAECHER = 4096;
  const histogramm = new Int32Array(FAECHER);
  const spanne = max - min;
  for (let i = 0; i < anzahl; i += 1) {
    const v = roh[i];
    if (!Number.isFinite(v)) continue;
    const fach = Math.min(FAECHER - 1, Math.floor(((v - min) / spanne) * FAECHER));
    histogramm[fach] += 1;
  }
  const untenZiel = anzahl * 0.01;
  const obenZiel = anzahl * 0.99;
  let summe = 0;
  let unten = min;
  let oben = max;
  let untenGesetzt = false;
  for (let f = 0; f < FAECHER; f += 1) {
    summe += histogramm[f];
    if (!untenGesetzt && summe >= untenZiel) {
      unten = min + (f / FAECHER) * spanne;
      untenGesetzt = true;
    }
    if (summe >= obenZiel) {
      oben = min + ((f + 1) / FAECHER) * spanne;
      break;
    }
  }
  /*
   * Nur der entartete Fall wird zurückgenommen: Wenn die beiden Grenzen
   * zusammenfallen, wäre die Division darunter unendlich.
   *
   * Hier stand erst ein Vergleich gegen ein Prozent der ROHEN Spanne. Der
   * hob sich selbst auf: Genau wenn die Perzentile einen Ausreisser
   * erfolgreich ausgeschlossen haben, ist die verbleibende Spanne winzig
   * gegen die rohe – die Bedingung traf also immer zu, sobald es etwas zu
   * schützen gab. Nachgemessen an 400 Werten zwischen 1,00 und 1,04 plus
   * einem bei 50: Die Karte war danach durchgehend 0.
   */
  if (!(oben - unten > 0)) {
    unten = min;
    oben = max;
  }

  const weite = oben - unten;
  for (let i = 0; i < anzahl; i += 1) {
    const v = roh[i];
    if (!Number.isFinite(v)) {
      feld[i] = 0;
      continue;
    }
    feld[i] = Math.round(klemmen((v - unten) / weite, 0, 1) * 255);
  }
  return { breite, hoehe, feld };
}

/**
 * Wie unscharf ein Punkt dieser Tiefe ist – 0 (scharf) bis 1 (voll).
 *
 * `tiefe` und `fokus` beide 0…1, `spanne` ist der Abstand, ab dem die volle
 * Unschärfe erreicht ist.
 *
 * Der Mindestwert für `spanne` ist nicht gegen die Null: Eine Division durch
 * null gibt „unendlich“, und das klemmt sauber auf 1 – bei Spanne 0 ist also
 * ohnehin alles ausser der Fokusebene voll unscharf, was genau richtig ist.
 * Er ist gegen einen NEGATIVEN Wert aus einem beschädigten Dokument: Dann
 * kippt das Vorzeichen, jeder Abstand wird negativ, klemmt auf 0 – und das
 * ganze Bild wäre scharf statt unscharf. Ein Fehler, der wie „der Regler tut
 * nichts“ aussieht und nicht wie ein kaputter Wert.
 */
export function unschaerfeAn(tiefe: number, fokus: number, spanne: number): number {
  return klemmen(Math.abs(tiefe - fokus) / Math.max(spanne, 1 / 255), 0, 1);
}

/**
 * Die Tiefenkarte auf eine andere Größe ziehen und in Unschärfe umrechnen.
 *
 * Die Reihenfolge ist nicht beliebig: erst ausdehnen, DANN die Kurve. Der
 * Betrag in `unschaerfeAn` hat an der Fokusebene einen Knick, und wer zwei
 * Punkte beiderseits davon mittelt, bekommt einen Wert, den keiner von beiden
 * hat – ein scharfer Streifen mitten im Verlauf. Andersherum wird über die
 * Tiefe gemittelt, und das ist der einzige Ort, an dem Mitteln etwas bedeutet.
 */
export function tiefenFeld(
  karte: Tiefenkarte,
  fokus: number,
  spanne: number,
  zielBreite: number,
  zielHoehe: number,
): Uint8Array {
  const aus = new Uint8Array(Math.max(0, zielBreite * zielHoehe));
  const { breite, hoehe, feld } = karte;
  if (aus.length === 0 || breite <= 0 || hoehe <= 0 || feld.length < breite * hoehe) return aus;

  for (let y = 0; y < zielHoehe; y += 1) {
    // Auf Mitten abbilden, nicht auf Ecken: sonst wandert das Bild beim
    // Ausdehnen um einen halben Bildpunkt nach links oben.
    const qy = klemmen(((y + 0.5) / zielHoehe) * hoehe - 0.5, 0, hoehe - 1);
    const y0 = Math.floor(qy);
    const y1 = Math.min(y0 + 1, hoehe - 1);
    const fy = qy - y0;
    for (let x = 0; x < zielBreite; x += 1) {
      const qx = klemmen(((x + 0.5) / zielBreite) * breite - 0.5, 0, breite - 1);
      const x0 = Math.floor(qx);
      const x1 = Math.min(x0 + 1, breite - 1);
      const fx = qx - x0;
      const oben = feld[y0 * breite + x0] + (feld[y0 * breite + x1] - feld[y0 * breite + x0]) * fx;
      const unten = feld[y1 * breite + x0] + (feld[y1 * breite + x1] - feld[y1 * breite + x0]) * fx;
      const tiefe = (oben + (unten - oben) * fy) / 255;
      aus[y * zielBreite + x] = Math.round(unschaerfeAn(tiefe, fokus, spanne) * 255);
    }
  }
  return aus;
}

/**
 * Die Eingabegrösse für das Netz: seitenrichtig und durch 14 teilbar.
 *
 * Durch 14, weil der Bildwandler das Bild in Flicken von 14 × 14 Punkten
 * zerlegt – eine andere Kantenlänge lehnt der Graph ab. Und seitenrichtig
 * statt quadratisch, weil ein gestauchtes Bild eine gestauchte Tiefe ergibt
 * und ein Quadrat bei 4:3 ein Drittel mehr Rechenzeit kostet, ohne dass mehr
 * Bild darin steckt.
 *
 * `flaeche` ist die Zielkantenlänge des längeren Randes (518 = 37 · 14, die
 * Grösse, mit der das Modell trainiert wurde).
 */
export function netzGroesse(
  breite: number,
  hoehe: number,
  flaeche = 518,
): { w: number; h: number } {
  const takt = 14;
  const sicher = (wert: number) => Math.max(takt, Math.round(wert / takt) * takt);
  if (breite <= 0 || hoehe <= 0) return { w: flaeche, h: flaeche };
  if (breite >= hoehe) return { w: sicher(flaeche), h: sicher((flaeche * hoehe) / breite) };
  return { w: sicher((flaeche * breite) / hoehe), h: sicher(flaeche) };
}
