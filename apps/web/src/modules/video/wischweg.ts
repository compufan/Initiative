/**
 * Die Entscheidungen des Zeichenwegs beim Wischen – als reine Funktionen,
 * damit sie sich ohne Browser prüfen lassen.
 *
 * Gezeichnet wird in `vorschau.ts`, gesprungen in `filmWiedergabe.ts`; was
 * hier steht, sind die Fragen dazwischen: Welches Bild liegt unter dem
 * Finger? Darf ein Bild aus dem Video jetzt noch gezeichnet werden? Wann ist
 * das Gerät zu langsam für die Bearbeitung beim Wischen?
 */

/** Die Güte der Zeichnung: 0 – voll · 1 – kleiner gezeichnet · 2 – rohes Video beim Abspielen. */
export type Guete = 0 | 1 | 2;

/** Wie nahe das Bild liegt, das der Speicher für die Fingerstelle hat. */
export type Treffer = 'genau' | 'genaehert' | 'fehlt';

/** Ein Anzeigetakt bei 60 Hz – die Einheit der Zeitgrenzen unten. */
export const TAKT_MS = 1000 / 60;
/** Ab so vielen Millisekunden für ein Bild beim Wischen wird kleiner gezeichnet. */
export const WISCH_GRENZE_MS = 120;
/** So viele Zeichnungen in Folge über `3 · TAKT_MS` senken die Güte. */
export const LANGSAM_FOLGE = 6;
/** So viele der letzten Zeichnungen zählt der Median für die Notstufe. */
export const NOT_FENSTER = 8;
/** Über so vielen Takten im Median ist das Gerät zum Wischen mit Bearbeitung zu langsam. */
export const NOT_TAKTE = 12;
/** So lange liegt der Finger still, bis das Bild scharf wird (und die Bearbeitung zurückkommt). */
export const RUHE_FINGER_MS = 100;

/**
 * Das Filmbild unter dem Finger: sein Index in `filmRaster(…).bilder`.
 *
 * Die Stelle im Film geteilt durch den Bildabstand – nicht ein Umweg über
 * das Video. Die Liste ist der Massstab: dieselbe, aus der der Filmbau
 * seine Bilder holt, auch für Abschnitte, deren Kanten nicht auf dem Raster
 * liegen. Hinter dem Ende steht das letzte Bild.
 */
export function filmBildIndex(anzahl: number, filmMs: number, s: number): number {
  if (anzahl <= 0) return 0;
  const roh = Math.floor(Math.max(0, filmMs) / s + 1e-7);
  return Math.min(anzahl - 1, roh);
}

/**
 * Darf ein Bild aus dem VIDEO gezeichnet werden, während der Finger bei
 * `ziel` liegt und `gezeigt` schon auf der Leinwand steht?
 *
 * Zwei Quellen zeichnen in dieselbe Leinwand: der Speicher (im Takt) und das
 * Video (nach einem Sprung: Nachschärfen, Lücke, Abspielen). Ohne Regel
 * legte ein spät ankommender Sprung ein Bild eines längst überholten Ziels
 * über ein neueres aus dem Speicher – und der `readyState`-Wächter allein
 * schützt davor nicht: Der späte Sprung IST fertig. Ein Bild, das weiter vom
 * Finger weg liegt als das, was schon steht, wird verworfen.
 *
 * Ohne Ziel (Abspielen, ruhender Finger) oder wo ein Bild keinem Filmbild
 * zuzuordnen ist, gilt die Regel nicht. Steht noch nichts auf der Leinwand,
 * zählt die Toleranz.
 */
export function videobildDarf(
  bild: number | null,
  ziel: number | null,
  gezeigt: number | null,
  toleranz: number,
): boolean {
  if (ziel === null || bild === null) return true;
  // Noch nichts gezeigt: nur ein Bild nahe am Finger. Das Bild, das das
  // Video von VOR dem Zug noch hält, trüge sonst die Bearbeitung des neuen.
  if (gezeigt === null) return Math.abs(bild - ziel) <= toleranz;
  return Math.abs(bild - ziel) <= Math.abs(gezeigt - ziel);
}

/**
 * Gehört das gezeigte Bild nicht mehr zum Finger – so weit weg, dass es
 * stehenbleibt, während das Video hinterherhinkt?
 *
 * Dann wird die Leinwand verborgen, und das rohe Video zeigt, was es hat.
 * Ein Bild, das nicht mehr zum Finger gehört, bleibt nie stehen: Gemessen
 * hat die bearbeitete Leinwand ein einziges Bild 3 s lang gezeigt, während
 * der Finger über den ganzen Film zog (Befund 4 der Messung).
 */
export function leinwandVeraltet(
  gezeigt: number | null,
  ziel: number | null,
  toleranz: number,
): boolean {
  if (ziel === null) return false;
  if (gezeigt === null) return true;
  return Math.abs(gezeigt - ziel) > toleranz;
}

function median(werte: readonly number[]): number {
  const sortiert = [...werte].sort((a, b) => a - b);
  return sortiert[Math.floor(sortiert.length / 2)] ?? 0;
}

/**
 * Die Güte beim Wischen – die Stufenleiter von `vorschau.ts`, erweitert.
 *
 * Eine Zeichnung über `WISCH_GRENZE_MS` (wie bisher) oder sechs in Folge
 * über drei Takte senken die Güte auf 1: kleiner zeichnen. `dauern`: die
 * letzten Zeichnungen, die neueste zuletzt.
 */
export function gueteBeimWischen(dauern: readonly number[], guete: Guete): Guete {
  if (guete !== 0 || dauern.length === 0) return guete;
  if (dauern[dauern.length - 1] > WISCH_GRENZE_MS) return 1;
  const folge = dauern.slice(-LANGSAM_FOLGE);
  if (folge.length >= LANGSAM_FOLGE && folge.every((dauer) => dauer > 3 * TAKT_MS)) return 1;
  return guete;
}

/**
 * Darf die Güte nach dem Wischen wieder steigen? Neun von zehn der letzten
 * Zeichnungen liegen unter anderthalb Takten – dann kostet die volle Güte
 * keinen Takt mehr.
 */
export function gueteErholt(dauern: readonly number[]): boolean {
  if (dauern.length < NOT_FENSTER) return false;
  const sortiert = [...dauern.slice(-NOT_FENSTER * 2)].sort((a, b) => a - b);
  const p90 = sortiert[Math.min(sortiert.length - 1, Math.floor(sortiert.length * 0.9))];
  return p90 < 1.5 * TAKT_MS;
}

/**
 * Ist das Gerät zum Wischen mit Bearbeitung zu langsam?
 *
 * Der Median der letzten acht Zeichnungen liegt über zwölf Takten (200 ms):
 * Dann zeigt der Zug das rohe Speicherbild, und die Bearbeitung erscheint,
 * sobald der Finger ruht. Der Median und nicht der Mittelwert, damit ein
 * einzelner Ausreisser (das erste Zeichnen lädt Texturen) nicht genügt.
 */
export function notstufeNoetig(dauern: readonly number[]): boolean {
  if (dauern.length < NOT_FENSTER) return false;
  return median(dauern.slice(-NOT_FENSTER)) > NOT_TAKTE * TAKT_MS;
}
