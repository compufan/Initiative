/**
 * Welche Zeitpunkte aus einem Video ein GIF werden.
 *
 * Reines Rechnen, kein Video, kein Browser – deshalb prüfbar. Die Stellen, an
 * denen es wirklich klemmt, sind nämlich alle arithmetisch: die Standzeit, die
 * Zahl der Bilder und die Grösse der fertigen Datei.
 *
 * # Warum nicht jede Bildrate
 *
 * Weil GIF die Standzeit in HUNDERTSTELSEKUNDEN zählt und sonst nichts. Bei 30
 * Bildern je Sekunde wären das 3,33 Hundertstel; gerundet auf 3 laufen die
 * Bilder mit 33,3 statt 30 je Sekunde, und über zehn Sekunden hat das GIF
 * knapp eine halbe Sekunde Vorsprung vor dem Ton, den es nicht hat, und vor
 * dem Video, aus dem es stammt. Angeboten werden deshalb nur Raten, die
 * aufgehen – und weil `gifSchreiben` die Standzeit bei zwei Hundertsteln
 * abfängt, liegt die schnellste angebotene Rate bei 25.
 */

/** Eine wählbare Bildrate samt dem, was sie in Hundertsteln bedeutet. */
export interface Bildrate {
  /** Bilder je Sekunde. */
  readonly rate: number;
  /** Was auf dem Knopf steht. */
  readonly titel: string;
  /** Ein Satz, der bei der Wahl hilft. */
  readonly beschreibung: string;
}

export const BILDRATEN: readonly Bildrate[] = [
  { rate: 5, titel: '5/s', beschreibung: 'Ruckelig, aber winzig. Gut für lange Ausschnitte.' },
  { rate: 10, titel: '10/s', beschreibung: 'Der übliche Kompromiss.' },
  { rate: 12.5, titel: '12,5/s', beschreibung: 'Etwas flüssiger, kaum grösser.' },
  { rate: 20, titel: '20/s', beschreibung: 'Flüssig. Jedes Bild kostet Platz.' },
  { rate: 25, titel: '25/s', beschreibung: 'So schnell, wie GIF es kann.' },
] as const;

export const BILDRATE_VORGABE = 10;

/**
 * Die Standzeit eines Bildes in Millisekunden.
 *
 * Immer ein Vielfaches von zehn – siehe oben. `Math.round` steht trotzdem da,
 * weil 1000 / 12.5 in Gleitkomma nicht zwingend auf 80,0 fällt.
 */
export function dauerJeBildMs(bildrate: number): number {
  return Math.max(20, Math.round(1000 / bildrate / 10) * 10);
}

export interface Ausschnitt {
  /** Die Zeitpunkte in Millisekunden, an denen ein Bild geholt wird. */
  readonly zeitpunkte: readonly number[];
  /** Die Standzeit jedes Bildes. */
  readonly dauerJeBildMs: number;
  /**
   * Wie viel am Ende wegfällt, weil die Obergrenze erreicht war. Null, wenn
   * der ganze gewählte Bereich hineinpasst.
   */
  readonly gekuerztMs: number;
}

/**
 * Die Zeitpunkte für einen Bereich.
 *
 * `maxBilder` schneidet HINTEN ab und dünnt nicht aus: Ein GIF mit jedem
 * zweiten Bild bei voller Standzeit liefe in Zeitlupe, eines mit halber
 * Standzeit doppelt so schnell. Beides ist schlechter als ein kürzerer
 * Ausschnitt, den der Anwender sieht und selbst verschieben kann.
 */
export function zeitpunkte(
  vonMs: number,
  bisMs: number,
  bildrate: number,
  maxBilder: number,
): Ausschnitt {
  const schritt = dauerJeBildMs(bildrate);
  const von = Math.max(0, vonMs);
  const bis = Math.max(von, bisMs);
  /*
   * Gerundet und nicht abgeschnitten: Wer bei 10 Bildern je Sekunde 950 ms
   * wählt, bekommt zehn Bilder und damit eine runde Sekunde. Abgeschnitten
   * wären es neun, und das letzte Zehntel des Ausschnitts – oft die Pointe –
   * fiele weg, ohne dass irgendwo stünde, warum.
   */
  const gewuenscht = Math.max(1, Math.round((bis - von) / schritt));
  const anzahl = Math.max(1, Math.min(maxBilder, gewuenscht));

  const liste: number[] = [];
  for (let i = 0; i < anzahl; i += 1) liste.push(von + i * schritt);

  return {
    zeitpunkte: liste,
    dauerJeBildMs: schritt,
    gekuerztMs: (gewuenscht - anzahl) * schritt,
  };
}

/* ---------- Was es am Ende wiegt ---------- */

/*
 * Die beiden Zahlen stammen aus einer Messung, nicht aus einer Formel.
 *
 * Fünfzig Bilder à 512 × 512 aus einem echten Video, durch `gifSchreiben`:
 * als Vollbild 6 505 995 Byte, freigestellt 916 000 Byte. Das sind 130 120
 * bzw. 18 320 Byte je Bild. Freigestellt ist es so viel kleiner, weil die
 * durchsichtige Fläche EIN Tafelplatz ist und LZW eine lange Reihe desselben
 * Platzes fast umsonst packt.
 *
 * Eine Schätzung bleibt eine Schätzung: Ein bewegtes Muster über das ganze
 * Bild wiegt mehr, eine ruhige Einstellung weniger. Sie steht in der
 * Oberfläche als „rund", und die harte Grenze zieht am Ende die fertige Datei.
 */
const JE_BILD_VOLL = 130_120;
const JE_BILD_FREI = 18_320;
const GEMESSEN_KANTE = 512;

export function groesseSchaetzenB(bilder: number, kante: number, freigestellt: boolean): number {
  const anteil = (kante * kante) / (GEMESSEN_KANTE * GEMESSEN_KANTE);
  return Math.round(bilder * (freigestellt ? JE_BILD_FREI : JE_BILD_VOLL) * anteil);
}

/** „rund 1,4 MB" – eine Zahl, die man auf einem Knopf lesen kann. */
export function groesseText(bytes: number): string {
  if (bytes < 900_000) return `rund ${Math.max(1, Math.round(bytes / 1000))} kB`;
  return `rund ${(bytes / 1_000_000).toFixed(1).replace('.', ',')} MB`;
}
