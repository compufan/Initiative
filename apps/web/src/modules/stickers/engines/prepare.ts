/**
 * Das Quellbild so aufbereiten, dass ein Modell damit rechnen kann.
 *
 * Der wichtigste Punkt hier ist die Deckelung: Ein Handyfoto mit 48 Megapixel
 * wird beim Entpacken zu rund 190 MB rohen Bilddaten. Original, Maske und
 * Ergebnis gleichzeitig im Speicher – und iOS beendet die Seite kommentarlos.
 * Die Modelle rechnen ohnehin intern mit 256 bzw. 320 Bildpunkten Kantenlänge,
 * eine grössere Vorlage bringt also nichts.
 */

/** Längste Kante, mit der wir ein Modell füttern. */
export const MAX_KANTE = 1024;

export interface Vorlage {
  image: ImageData;
  /** Wie stark verkleinert wurde – zum Zurückrechnen angetippter Punkte. */
  faktor: number;
}

/**
 * Zeichnet das Bild in eine Arbeitsfläche und gibt die Bildpunkte zurück.
 *
 * Wirft, wenn kein 2D-Kontext zu bekommen ist – das passiert auf Geräten mit
 * ausgeschöpftem Grafikspeicher und ist ein echter Fehler, kein Randfall.
 */
export function vorlageAus(
  image: CanvasImageSource,
  breite: number,
  hoehe: number,
  maxKante = MAX_KANTE,
): Vorlage {
  const faktor = Math.min(1, maxKante / Math.max(breite, hoehe));
  const w = Math.max(1, Math.round(breite * faktor));
  const h = Math.max(1, Math.round(hoehe * faktor));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Die Arbeitsfläche liess sich nicht anlegen.');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0, w, h);
  return { image: ctx.getImageData(0, 0, w, h), faktor };
}

/**
 * Glättet die Maskenkante.
 *
 * Ein Modell liefert oft eine Kante, die auf einen Bildpunkt genau springt.
 * Auf einem Sticker sieht das ausgefranst aus – ein leichter Weichzeichner
 * kostet nichts und macht den Unterschied zwischen „ausgeschnitten“ und
 * „ausgerissen“.
 */
export function kanteWeichzeichnen(
  alpha: Uint8Array,
  breite: number,
  hoehe: number,
  radius = 1,
): Uint8Array {
  if (radius < 1) return alpha;
  const fenster = radius * 2 + 1;
  const waagerecht = new Uint8Array(alpha.length);
  for (let y = 0; y < hoehe; y += 1) {
    const zeile = y * breite;
    let summe = 0;
    for (let x = -radius; x <= radius; x += 1) {
      summe += alpha[zeile + Math.min(breite - 1, Math.max(0, x))];
    }
    for (let x = 0; x < breite; x += 1) {
      waagerecht[zeile + x] = summe / fenster;
      summe -= alpha[zeile + Math.max(0, x - radius)];
      summe += alpha[zeile + Math.min(breite - 1, x + radius + 1)];
    }
  }

  const ergebnis = new Uint8Array(alpha.length);
  for (let x = 0; x < breite; x += 1) {
    let summe = 0;
    for (let y = -radius; y <= radius; y += 1) {
      summe += waagerecht[Math.min(hoehe - 1, Math.max(0, y)) * breite + x];
    }
    for (let y = 0; y < hoehe; y += 1) {
      ergebnis[y * breite + x] = summe / fenster;
      summe -= waagerecht[Math.max(0, y - radius) * breite + x];
      summe += waagerecht[Math.min(hoehe - 1, y + radius + 1) * breite + x];
    }
  }
  return ergebnis;
}

/**
 * Ob die Maske überhaupt etwas übrig lässt.
 *
 * Findet ein Modell nichts, liefert es eine fast leere Maske – und der Sticker
 * wäre durchsichtig. Dann lieber eine ehrliche Meldung als ein leeres Bild.
 */
export function maskeTraegt(alpha: Uint8Array): boolean {
  let sichtbar = 0;
  for (const wert of alpha) if (wert > 32) sichtbar += 1;
  // Ein Prozent der Fläche – darunter ist nichts Erkennbares übrig.
  return sichtbar > alpha.length * 0.01;
}
