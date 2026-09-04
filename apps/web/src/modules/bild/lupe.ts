/**
 * Die Lupe des Bildeditors: welcher Ausschnitt gerade gezeigt wird.
 *
 * Eigene Datei, weil genau diese Rechnung schon zweimal danebenlag – und im
 * Bauch einer Komponente mit Zeigerereignissen, `useRef` und Zeichenrahmen
 * lässt sie sich weder nachrechnen noch prüfen. Hier ist sie das, was sie
 * ist: vier Zahlen rein, drei Zahlen raus.
 *
 * Die Lupe gehört bewusst NICHT zum Dokument. Sonst landete jedes
 * Heranzoomen im Rückgängig-Verlauf.
 */

export interface Lupe {
  /** 1 = ganzes Bild, 8 = achtfach. */
  zoom: number;
  /** Linke obere Ecke des gezeigten Ausschnitts, in Ansichtspunkten. */
  x: number;
  y: number;
}

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 8;

/** Der neue Lupenfaktor aus dem Verhältnis der Fingerabstände. */
export function zoomAusSpanne(startZoom: number, startAbstand: number, abstand: number): number {
  if (!(startAbstand > 0)) return startZoom;
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, (startZoom * abstand) / startAbstand));
}

/**
 * Wieviele Leinwandpunkte auf einen Ansichtspunkt kommen, ohne Lupe.
 *
 * Bewusst aus der Leinwandbreite abgeleitet und nicht aus `faktor / zoom`:
 * Der Faktor wird im Zeichenrahmen fortgeschrieben, der Zoom in einem
 * Effekt. Die beiden gehören zu verschiedenen Zeitpunkten, sobald das
 * Zeichnen einen Rahmen hinterherhinkt – und ihr Quotient dann zu keinem.
 * Die Leinwandbreite enthält den Zoom gar nicht erst.
 */
export function basisAus(leinwandBreite: number, sichtBreite: number): number {
  return leinwandBreite / Math.max(1, sichtBreite);
}

/**
 * Hält einen Bildpunkt unter dem Finger fest.
 *
 * Aus der Zeichenvorschrift
 *     leinwand = (ansicht − versatz) · basis · zoom
 * folgt bei festgehaltenem `ansicht`
 *     versatz = ansicht − leinwand / (basis · zoom).
 *
 * `mitteLeinwand` ist die JETZIGE Fingermitte. Vorher stand dort die Mitte
 * der Leinwand – damit rückte jede Geste den angefassten Punkt in die
 * Bildmitte, statt ihn zu halten. Mit der echten Fingermitte fällt das
 * Schieben nebenbei mit ab: Bleibt der Abstand gleich, wandert der Ausschnitt
 * genau mit den Fingern.
 */
export function lupeHalten(werte: {
  /** Der Bildpunkt, der unter der Fingermitte lag, als sie aufsetzte. */
  ankerAnsicht: { x: number; y: number };
  /** Wo die Fingermitte jetzt liegt, in Leinwandpunkten. */
  mitteLeinwand: { x: number; y: number };
  /** Leinwandpunkte je Ansichtspunkt ohne Lupe. */
  basis: number;
  zoom: number;
}): Lupe {
  const faktor = werte.basis * werte.zoom;
  if (!(faktor > 0)) return { zoom: werte.zoom, x: werte.ankerAnsicht.x, y: werte.ankerAnsicht.y };
  return {
    zoom: werte.zoom,
    x: werte.ankerAnsicht.x - werte.mitteLeinwand.x / faktor,
    y: werte.ankerAnsicht.y - werte.mitteLeinwand.y / faktor,
  };
}

/**
 * Die Gegenrichtung: wo ein Ansichtspunkt auf der Leinwand landet.
 *
 * Nur für Prüfungen gedacht – wer den Anker hineingibt, muss die Fingermitte
 * zurückbekommen. Genau das war vorher nicht so.
 */
export function aufLeinwand(
  punkt: { x: number; y: number },
  lupe: Lupe,
  basis: number,
): { x: number; y: number } {
  const faktor = basis * lupe.zoom;
  return { x: (punkt.x - lupe.x) * faktor, y: (punkt.y - lupe.y) * faktor };
}
