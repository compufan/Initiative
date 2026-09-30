import { abtasten, type Stueck } from './ausschnitt.js';

/**
 * Das eine Zeitraster eines Films: Bild k des QUELLvideos bei der Bildrate
 * des Films.
 *
 * Reine Rechnung, kein Video, kein Browser. Alles, was über den ganzen Film
 * gilt – Masken, Anker, Geltungsbereiche, gespeicherte Spuren –, steht in
 * diesem k. Filmzeit gibt es nur in der Oberfläche.
 *
 * # Warum ein Raster in der QUELLE und nicht im Film
 *
 * Weil ein Film umgestellt wird und die Quelle nicht. Wer einen Abschnitt
 * teilt, kürzt oder verschiebt, ändert, WO im Film ein Quellbild steht –
 * aber nie, was darauf zu sehen ist. Eine Maske, die an Quellbild 212
 * gerechnet wurde, gilt dort nach jedem Schnitt noch genauso. Im Film
 * gezählt, müsste jeder Schnitt alle gespeicherten Masken umnummerieren, und
 * ein Fehler dabei legte eine Maske auf ein anderes Bild.
 *
 * # Warum die Abschnittskanten auf dem Raster liegen
 *
 * Weil `abtasten` (mit `mitte`) Bild i eines Abschnitts bei
 * `von + (i + ½) · s` holt. Liegt `von` auf dem Raster, IST das die Mitte
 * von Rasterbild `von/s + i` – derselbe Zeitpunkt, den der Editor zeigt, die
 * Verfolgung liest und der Filmbau schreibt. Liegt `von` daneben (vorher
 * wurde auf ganze Millisekunden gerundet), fallen die Filmbilder ZWISCHEN
 * zwei Rasterbilder: Bei 24 Bildern je Sekunde und `von = 1000` lag jedes
 * Filmbild 0,3 ms vor der Mitte, bei `von = 1013` schon 13 ms – und eine
 * Maske aus Bild 24 läge dann über einem Bild, das ein Sprung zur Hälfte
 * als Bild 25 liefert.
 *
 * # Warum `s` nie gerundet wird
 *
 * Weil `videoSchreiben` die Zeitstempel mit genau `1000 / bildrate` schreibt
 * (siehe den Kopf von `ausschnitt.ts`). Ein auf ganze Millisekunden
 * gerundetes Raster liefe bei 30 Bildern je Sekunde nach zehn Sekunden um
 * drei Bilder aus dem Tritt. Kanten wie 41,666… ms sind deshalb gewollt.
 */

/**
 * Gegen Gleitkommareste: `3 · (1000/24)` ist nicht exakt `125`, und
 * `Math.floor(124,99999999999999 / 41,666…)` wäre das Bild davor.
 */
const RASTER_EPS = 1e-7;

/** Das Rasterbild, in dem `ms` liegt. */
export function bildIndex(ms: number, s: number): number {
  return Math.floor(ms / s + RASTER_EPS);
}

/**
 * Die Mitte von Rasterbild k – der EINZIGE Zeitpunkt, an dem für k je
 * gesprungen oder gelesen wird.
 *
 * Warum die Mitte und nicht die Grenze, steht im Kopf von `ausschnitt.ts`:
 * Ein Sprung genau auf die Grenze liefert je nach Dekodierer das Bild davor.
 */
export function bildMitte(k: number, s: number): number {
  return (k + 0.5) * s;
}

/** Die nächste Rasterkante – für Abschnittskanten. */
export function rasterRunden(ms: number, s: number): number {
  return Math.round(ms / s) * s;
}

/**
 * Wie viele GANZE Rasterbilder das Quellvideo hat – mindestens eines.
 *
 * Abgerundet, nicht gerundet: Ein Video von 5020 ms hat bei 25 Bildern je
 * Sekunde 125 ganze Bilder. Das 126. begänne bei 5000 ms und hätte seine
 * Mitte bei 5020 – genau auf dem Ende, wo ein Sprung je nach Browser das
 * letzte Bild liefert oder gar keines. Die Kante eines Abschnitts endet
 * deshalb spätestens bei `quellBilder · s` (siehe `rasterEnde`).
 */
export function quellBilder(quelleMs: number, s: number): number {
  return Math.max(1, Math.floor(quelleMs / s + RASTER_EPS));
}

/** Die späteste Kante, an der ein Abschnitt enden darf – siehe `quellBilder`. */
export function rasterEnde(quelleMs: number, s: number): number {
  return quellBilder(quelleMs, s) * s;
}

/**
 * Welche Rasterbilder ein Abschnitt zeigt: `[k0, k1)`.
 *
 * Gerechnet wie `abtasten` und nicht als `round(von/s)`: So stimmt es auch
 * für einen Abschnitt, dessen Kanten (noch) nicht auf dem Raster liegen –
 * etwa zwischen einem Wechsel der Bildrate und dem nächsten `rasterNeu`.
 * Bild i liegt bei `von + (i + ½)s`, also in Rasterbild
 * `floor(von/s + ½) + i`; es sind `max(1, round((bis − von)/s))` Bilder.
 */
export function bildBereich(stueck: Stueck, s: number): { k0: number; k1: number } {
  const von = Math.max(0, stueck.vonMs);
  const bis = Math.max(von, stueck.bisMs);
  const k0 = bildIndex(von + s / 2, s);
  return { k0, k1: k0 + Math.max(1, Math.round((bis - von) / s)) };
}

/** Ein Bild des Films: an welcher Stelle, aus welchem Abschnitt, welches Rasterbild. */
export interface Filmbild {
  /** Die Stelle im Film, ab 0. */
  readonly stelle: number;
  /** Der Abschnitt in der Liste. */
  readonly nummer: number;
  /** Das Rasterbild der Quelle. */
  readonly k: number;
}

export interface FilmRaster {
  /** Alle Bilder des Films in Filmreihenfolge – höchstens `maxBilder`. */
  readonly bilder: readonly Filmbild[];
  /**
   * `F`: die Rasterbilder, die der Film zeigt, aufsteigend und ohne
   * Doppelte. Nur sie werden verfolgt.
   */
  readonly menge: readonly number[];
  /** Wie viele Bilder hinter der Obergrenze wegfallen. */
  readonly jenseits: number;
}

/**
 * Welche Rasterbilder der Film zeigt – GENAU die, die der Filmbau holt.
 *
 * Über `abtasten` gerechnet und nicht nachgebaut: Die Obergrenze, die
 * Rundung der Bildzahl und die Reihenfolge sind dann dieselben wie beim
 * Filmbau. Eine eigene Rechnung, die bei einem Randfall ein Bild mehr oder
 * weniger zählte, verfolgte ein Bild, das nie gebraucht wird – oder liesse
 * eines aus, auf das der Filmbau dann wartet.
 */
export function filmRaster(
  abschnitte: readonly Stueck[],
  s: number,
  maxBilder: number,
): FilmRaster {
  if (abschnitte.length === 0) return { bilder: [], menge: [], jenseits: 0 };
  const plan = abtasten({ stuecke: abschnitte, schrittMs: s, maxBilder, mitte: true });
  const bilder = plan.zeitpunkte.map((ms, stelle) => ({
    stelle,
    nummer: plan.stueckJeBild[stelle],
    k: bildIndex(ms, s),
  }));
  const menge = [...new Set(bilder.map((bild) => bild.k))].sort((a, b) => a - b);
  return { bilder, menge, jenseits: Math.max(0, Math.round(plan.gekuerztMs / s)) };
}

/**
 * Eine Stelle im Film als Abschnitt und Rasterbild – oder `null` ohne Film.
 *
 * Halboffen wie `filmZuQuelle`: Die Grenze gehört dem späteren Abschnitt.
 * Hinter dem Ende steht das letzte Bild des letzten Abschnitts – nicht das
 * Bild HINTER ihm, das `filmZuQuelle` mit `bisMs` meint.
 */
export function filmZuBild(
  abschnitte: readonly Stueck[],
  filmMs: number,
  s: number,
): { nummer: number; k: number } | null {
  let start = 0;
  for (let nummer = 0; nummer < abschnitte.length; nummer += 1) {
    const stueck = abschnitte[nummer];
    const laenge = Math.max(0, stueck.bisMs - stueck.vonMs);
    const letztes = nummer === abschnitte.length - 1;
    if (filmMs < start + laenge || letztes) {
      const { k0, k1 } = bildBereich(stueck, s);
      const innen = bildIndex(Math.max(0, filmMs - start), s);
      return { nummer, k: Math.min(k1 - 1, Math.max(k0, k0 + innen)) };
    }
    start += laenge;
  }
  return null;
}

/** Wo im Film die Mitte von Rasterbild k steht, gesehen in Abschnitt `nummer`. */
export function bildZuFilm(
  abschnitte: readonly Stueck[],
  nummer: number,
  k: number,
  s: number,
): number {
  let start = 0;
  for (let i = 0; i < nummer && i < abschnitte.length; i += 1) {
    start += Math.max(0, abschnitte[i].bisMs - abschnitte[i].vonMs);
  }
  const stueck = abschnitte[nummer];
  if (!stueck) return start;
  const { k0, k1 } = bildBereich(stueck, s);
  return start + (Math.min(k1 - 1, Math.max(k0, k)) - k0 + 0.5) * s;
}

/* ---------- Schlüsselbilder ---------- */

/**
 * Jedes wievielte Bild durch ein Modell geht – wie bisher beim Filmbau.
 *
 * Halb so viele wie Bilder je Sekunde, höchstens vier: Bei jeder Filmrate
 * ab 8 Bildern je Sekunde sind das 4, also rund sechs Modelläufe je Sekunde
 * Film bei 25 – und zwischen zwei Läufen schiebt die Spur die Maske
 * (`objektFolge.ts`).
 */
export function schluesselAbstand(s: number): number {
  const bildrate = 1000 / s;
  return Math.max(1, Math.min(4, Math.round(bildrate / 2)));
}

/**
 * Der Abstand im GROBpass: ein Modellauf etwa je Sekunde.
 *
 * Immer ein Vielfaches von `K`: Jedes grobe Schlüsselbild ist damit auch
 * ein feines, und der Feinpass rechnet dort kein Modell ein zweites Mal
 * (das Ergebnis liegt im Netzvorrat). Zusammen kosten Grob- und Feinpass
 * so viele Modelläufe wie der Feinpass allein.
 */
export function grobAbstand(K: number, s: number): number {
  const bildrate = 1000 / s;
  return K * Math.max(2, Math.round(bildrate / K));
}

/**
 * Wie viele Pfadbilder ein Fenster der Verfolgung umfasst.
 *
 * Nach der Fläche, weil ein Fenster alle seine Masken zugleich hält (roh,
 * geglättet, dazu die Graustufen): rund zwölf Millionen Bildpunkte, das sind
 * bei 960 × 540 zwanzig Bilder und bei 1280 × 720 zwölf. Immer ein
 * Vielfaches von `K`, damit ein Fenster auf einem Schlüsselbild endet.
 */
export function fensterGroesse(b: number, h: number, K: number): number {
  const flaeche = Math.max(1, b * h);
  return K * Math.min(12, Math.max(2, Math.floor(12e6 / flaeche / K)));
}
