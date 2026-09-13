/**
 * Farbmanagement: in welchem Raum gerechnet wird, und warum es überhaupt
 * einen zweiten gibt.
 *
 * # Was heute passiert, ohne dass es jemand merkt
 *
 * Ein Foto aus einem Telefon der letzten zehn Jahre ist meistens **Display-P3**
 * – ein Farbraum, der deutlich mehr Rot und Grün fasst als sRGB. Eine Leinwand
 * ist von Haus aus sRGB. Wer ein P3-Bild darauf zeichnet, bekommt es vom
 * Browser umgerechnet und dabei BESCHNITTEN: Was ausserhalb von sRGB liegt,
 * wird an den Rand geklemmt.
 *
 * Nachgemessen an einem kräftigen Orange (P3 0,95/0,35/0,15): In P3 steht es
 * als 242/89/38, in sRGB als 255/73/0. Der rote Kanal läuft an den Anschlag,
 * der blaue fällt auf null. Das ist kein Rundungsfehler, das ist die Farbe.
 *
 * Und es passierte bisher STILL, an der ersten Leinwand, bevor irgendein
 * Regler angefasst war. Ein Sonnenuntergang verlor seine sattesten Farben
 * schon beim Öffnen des Editors.
 *
 * # Was sich ändert
 *
 * Die Bearbeitungskette – Leinwände, Grafikeinheit, Ausgabe – arbeitet im
 * weitesten Raum, den der Browser anbietet. Nachgemessen: Ein WebP, das aus
 * einer P3-Leinwand geschrieben wird, kommt beim Wiedereinlesen Byte für Byte
 * als dieselbe P3-Farbe zurück (242/89/38 hin, 242/89/38 zurück). Der Browser
 * schreibt das Profil also mit; ohne das wäre die Umstellung SCHLIMMER als
 * der heutige Zustand, weil P3-Zahlen dann als sRGB gelesen würden und jedes
 * Bild grell zurückkäme.
 *
 * # Was sich NICHT ändert
 *
 * **Die Rechnung.** Display-P3 benutzt dieselbe Übertragungsfunktion wie
 * sRGB; nur die Primärfarben liegen weiter aussen. `zuLinear` und `zuSrgb`
 * gelten also unverändert, und der Vergleichstest zwischen GLSL und
 * TypeScript bleibt gültig.
 *
 * Ehrlich dazugesagt: Die Luminanzgewichte (Rec. 709) sind für sRGB-Primären
 * gerechnet. Auf P3-Zahlen angewandt sind sie leicht daneben – ein
 * Schwarzweissbild wird dort, wo das Foto ausserhalb von sRGB leuchtet, einen
 * Hauch anders grau. Die Alternative wäre, zwei Sätze Gewichte zu führen und
 * damit zwei Fassungen der ganzen Farbkette; der Fehler ist kleiner als der,
 * den zwei Fassungen mit der Zeit anrichten.
 *
 * **Was ein Modell sieht.** Die Netze für Freistellen und Tiefe bekommen ihre
 * Bildpunkte über `vorlageAus` aus einer gewöhnlichen Leinwand, und die bleibt
 * sRGB. Das ist kein Versehen: Die Modelle sind auf sRGB trainiert, und ihnen
 * P3-Zahlen zu geben hiesse, sie mit etwas zu füttern, das sie nie gesehen
 * haben.
 *
 * # Fällt aus, wenn es nicht geht
 *
 * Kann der Browser keine P3-Leinwand (oder keine P3-Grafikeinheit), bleibt
 * alles genau wie bisher. Die Erkennung fragt nicht nach Versionsnummern,
 * sondern legt eine Leinwand an und sieht nach, was herauskommt.
 */

/** Der Raum, in dem gerechnet wird. */
export type Farbraum = 'display-p3' | 'srgb';

let gemerkt: Farbraum | null = null;

/**
 * Der weiteste Raum, den dieser Browser durchgängig kann.
 *
 * „Durchgängig" ist das Wort, an dem es hängt: Eine 2D-Leinwand in P3 nützt
 * nichts, wenn die Grafikeinheit ihren Puffer nicht ebenfalls in P3 ausgeben
 * kann – dann liefe die Vorschau in einem Raum und der Rückfallweg im
 * anderen, und dasselbe Foto sähe auf demselben Gerät verschieden aus, je
 * nachdem, ob gerade eine Grafikeinheit da ist.
 */
export function arbeitsraum(): Farbraum {
  if (gemerkt) return gemerkt;
  gemerkt = 'srgb';
  if (typeof document === 'undefined') return gemerkt;
  try {
    const probe = document.createElement('canvas');
    probe.width = 1;
    probe.height = 1;
    const ctx = probe.getContext('2d', {
      colorSpace: 'display-p3',
    } as CanvasRenderingContext2DSettings);
    // `getContextAttributes` sagt, was WIRKLICH herauskam: Ein Browser, der
    // die Angabe nicht kennt, ignoriert sie stillschweigend und gibt eine
    // sRGB-Leinwand zurück.
    if (ctx?.getContextAttributes?.().colorSpace !== 'display-p3') return gemerkt;

    const gl = document.createElement('canvas').getContext('webgl2');
    // Ohne Grafikeinheit ist die Frage nach ihrem Puffer gegenstandslos –
    // dann entscheidet die Leinwand allein.
    if (gl && !('drawingBufferColorSpace' in gl && 'unpackColorSpace' in gl)) return gemerkt;

    gemerkt = 'display-p3';
  } catch {
    // Ein Browser, der bei einer unbekannten Angabe wirft, bekommt sRGB.
  }
  return gemerkt;
}

/** Nur für Prüfungen: die Erkennung noch einmal laufen lassen. */
export function farbraumVergessen(): void {
  gemerkt = null;
}

/**
 * Eine 2D-Fläche im Arbeitsraum.
 *
 * Der Umweg über diese Funktion und nicht `getContext` an Ort und Stelle: Die
 * Kette hat ein Dutzend Leinwände, und es reicht EINE, die im falschen Raum
 * liegt. Wo ein Bild zwischen zwei Leinwänden verschiedener Räume wandert,
 * rechnet der Browser stumm um – und beschneidet dabei.
 */
export function flaeche2d(
  leinwand: HTMLCanvasElement,
  weitere?: CanvasRenderingContext2DSettings,
): CanvasRenderingContext2D | null {
  return leinwand.getContext('2d', {
    ...weitere,
    colorSpace: arbeitsraum(),
  } as CanvasRenderingContext2DSettings);
}

/** Eine neue Leinwand der Grösse `breite` × `hoehe`, samt Fläche. */
export function neueFlaeche(
  breite: number,
  hoehe: number,
  weitere?: CanvasRenderingContext2DSettings,
): { leinwand: HTMLCanvasElement; ctx: CanvasRenderingContext2D | null } {
  const leinwand = document.createElement('canvas');
  leinwand.width = Math.max(1, Math.round(breite));
  leinwand.height = Math.max(1, Math.round(hoehe));
  return { leinwand, ctx: flaeche2d(leinwand, weitere) };
}

/**
 * Die Grafikeinheit in denselben Raum stellen.
 *
 * Zwei Schalter, und beide sind nötig:
 *
 *   * `unpackColorSpace` gilt beim HOCHLADEN einer Textur. Ohne ihn käme ein
 *     P3-Foto als sRGB in die Textur – beschnitten, bevor der Schattierer
 *     überhaupt läuft.
 *   * `drawingBufferColorSpace` gilt bei der AUSGABE. Ohne ihn wären die
 *     gerechneten Zahlen zwar breit, würden aber als sRGB ausgegeben und
 *     beim Zurückzeichnen ein zweites Mal umgerechnet.
 *
 * Wer nur einen von beiden setzt, bekommt ein Bild, das durchgehend zu satt
 * oder durchgehend zu flau ist – und beides sieht nach einem Fehler in der
 * Farbkette aus, nicht nach einer vergessenen Zeile hier.
 */
export function glRaum(gl: WebGL2RenderingContext): void {
  if (arbeitsraum() !== 'display-p3') return;
  const offen = gl as unknown as Record<string, unknown>;
  if ('drawingBufferColorSpace' in offen) offen.drawingBufferColorSpace = 'display-p3';
  if ('unpackColorSpace' in offen) offen.unpackColorSpace = 'display-p3';
}
