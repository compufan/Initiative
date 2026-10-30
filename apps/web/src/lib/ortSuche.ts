/**
 * Wann das Ort-Feld beim Tippen Vorschläge holt – und wie ein Treffer aussieht.
 *
 * Die Suche läuft über den eigenen Server (`/orte/suche`), der bei
 * OpenStreetMap-Daten nachschlägt. Was kein Ort ist, geht gar nicht erst hin:
 * Webadressen und Koordinaten kennt `adresse.ts` ohne jede Anfrage, und ein
 * Zoom-Link soll nicht bei einem Suchdienst landen, nur weil er im Feld steht.
 */

export interface OrtTreffer {
  /** Was ins Feld kommt. */
  text: string;
  titel: string;
  zeile: string;
  lat: number;
  lon: number;
  land: string | null;
}

/** Ab wie vielen Zeichen gesucht wird. */
export const MIN_ZEICHEN = 3;
/** Wartezeit nach dem letzten Tastendruck, in ms. */
export const WARTEZEIT_MS = 300;

const LINK = /^[a-z][a-z0-9+.-]*:\/\//i;
const KOORDINATE = /^[-+]?\d{1,3}[.,]\d+\s*[,;/ ]\s*[-+]?\d{1,3}[.,]\d+$/;

/** Ob zu dieser Eingabe Vorschläge geholt werden sollen. */
export function sucheLohnt(eingabe: string): boolean {
  const q = eingabe.trim();
  if (q.length < MIN_ZEICHEN) return false;
  if (LINK.test(q) || /^www\./i.test(q)) return false;
  if (KOORDINATE.test(q)) return false;
  return true;
}
