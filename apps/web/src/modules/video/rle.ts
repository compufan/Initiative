/**
 * Masken klein ablegen: Lauflängen statt Bildpunkte.
 *
 * Eine Maske in Rechengrösse (960 × 540) sind 518 400 Byte. Sechshundert
 * Filmbilder davon wären 311 MB – je Maskenteil. Die Spuren der Verfolgung
 * halten sie deshalb als Lauflängen: Eine Maske ist fast überall 0 oder 255,
 * und nur am weichen Rand stehen Zwischenwerte. Gemessen an einer weichen
 * Scheibe sind das wenige Kilobyte je Bild.
 *
 * # Das Format
 *
 * Vorn die Länge der Maske (LEB128), dann Anweisungen:
 *
 * | erstes Byte c | bedeutet                                              |
 * | ------------- | ----------------------------------------------------- |
 * | 0 … 127       | c + 1 Werte folgen roh (der weiche Rand)              |
 * | 128 … 254     | c − 125 Mal (3 … 129) derselbe Wert, er folgt          |
 * | 255           | Länge folgt als LEB128, danach der Wert               |
 *
 * Eine LEERE Maske ist ein Feld der Länge 0 – ohne Kopf. So sieht man ihr
 * das Leersein an, ohne sie auszupacken, und sie kostet nichts.
 *
 * # Warum vorher gerundet wird
 *
 * Weil Modelle Zuversicht liefern und keine Masken. „Person" gibt im Innern
 * einer Person Werte zwischen 250 und 255 aus, die von Bildpunkt zu
 * Bildpunkt springen – für das Auge dasselbe, für Lauflängen ein Lauf je
 * Punkt. Werte ab 250 werden deshalb 255 und bis 5 werden 0. Der Unterschied
 * ist kleiner als eine Stufe, die ein 8-Bit-Bildschirm zeigt, nachdem die
 * Maske eine Belichtung um ein paar Prozent gewichtet hat.
 */

/** Die leere Maske – eine für alle, sie wird nie beschrieben. */
export const RLE_LEER: Uint8Array = new Uint8Array(0);

/** Siehe Kopf: fast 255 ist 255, fast 0 ist 0. */
export function quantisieren(wert: number): number {
  if (wert >= 250) return 255;
  if (wert <= 5) return 0;
  return wert;
}

/** Ein Feld, das mitwächst – die Grösse der Ausgabe weiss vorher niemand. */
class Schreiber {
  private feld = new Uint8Array(4096);
  laenge = 0;

  private platz(mehr: number): void {
    if (this.laenge + mehr <= this.feld.length) return;
    let neu = this.feld.length * 2;
    while (neu < this.laenge + mehr) neu *= 2;
    const groesser = new Uint8Array(neu);
    groesser.set(this.feld.subarray(0, this.laenge));
    this.feld = groesser;
  }

  byte(wert: number): void {
    this.platz(1);
    this.feld[this.laenge] = wert;
    this.laenge += 1;
  }

  zahl(wert: number): void {
    let rest = wert;
    while (rest >= 0x80) {
      this.byte((rest & 0x7f) | 0x80);
      rest = Math.floor(rest / 128);
    }
    this.byte(rest);
  }

  roh(quelle: Uint8Array, von: number, bis: number): void {
    this.platz(bis - von);
    for (let i = von; i < bis; i += 1) this.feld[this.laenge + i - von] = quantisieren(quelle[i]);
    this.laenge += bis - von;
  }

  /** Genau so gross wie beschrieben – ein Rest hielte sonst Speicher fest. */
  fertig(): Uint8Array {
    return this.feld.slice(0, this.laenge);
  }
}

/** Ab so vielen gleichen Werten lohnt ein Lauf statt roher Werte. */
const LAUF_AB = 3;
const KURZ_MAX = 129;
const ROH_MAX = 128;

/**
 * Eine Maske als Lauflängen – gerundet wie im Kopf beschrieben.
 *
 * Eine Maske, die nach dem Runden überall 0 ist, wird `RLE_LEER`.
 */
export function rleKodieren(alpha: Uint8Array): Uint8Array {
  const n = alpha.length;
  let etwas = false;
  for (let i = 0; i < n; i += 1) {
    if (alpha[i] > 5) {
      etwas = true;
      break;
    }
  }
  if (!etwas) return RLE_LEER;

  const aus = new Schreiber();
  aus.zahl(n);
  /** Wo die noch nicht geschriebenen rohen Werte anfangen. */
  let rohAb = 0;
  const rohSchreiben = (bis: number) => {
    for (let von = rohAb; von < bis; von += ROH_MAX) {
      const ende = Math.min(bis, von + ROH_MAX);
      aus.byte(ende - von - 1);
      aus.roh(alpha, von, ende);
    }
  };

  let i = 0;
  while (i < n) {
    const wert = quantisieren(alpha[i]);
    let j = i + 1;
    while (j < n && quantisieren(alpha[j]) === wert) j += 1;
    const lauf = j - i;
    if (lauf >= LAUF_AB) {
      rohSchreiben(i);
      if (lauf <= KURZ_MAX) {
        aus.byte(128 + lauf - LAUF_AB);
      } else {
        aus.byte(255);
        aus.zahl(lauf);
      }
      aus.byte(wert);
      rohAb = j;
    }
    i = j;
  }
  rohSchreiben(n);
  return aus.fertig();
}

/** Ob eine abgelegte Maske leer ist – ohne sie auszupacken. */
export function rleLeer(rle: Uint8Array): boolean {
  return rle.length === 0;
}

/**
 * Eine abgelegte Maske auspacken – wahlweise in ein vorhandenes Feld.
 *
 * Eine leere wird zu `laenge` Nullen und NICHT zu einem leeren Feld: Wer
 * eine Maske erwartet, prüft ihre Länge gegen Breite mal Höhe (so die Spur
 * in `objektFolge.ts`), und ein leeres Feld fiele dort durch – am Rand eines
 * Fensters liefe dann ein Modell noch einmal, und dessen Maske überschriebe
 * den gespeicherten Stand.
 */
export function rleDekodieren(rle: Uint8Array, laenge: number, ziel?: Uint8Array): Uint8Array {
  const aus = ziel ?? new Uint8Array(laenge);
  if (aus.length !== laenge) {
    throw new Error(`Ziel hat ${aus.length} statt ${laenge} Werte`);
  }
  if (rle.length === 0) {
    if (ziel) aus.fill(0);
    return aus;
  }
  let p = 0;
  const zahl = (): number => {
    let wert = 0;
    let faktor = 1;
    for (;;) {
      const b = rle[p];
      p += 1;
      wert += (b & 0x7f) * faktor;
      if (b < 0x80) return wert;
      faktor *= 128;
    }
  };
  const gesamt = zahl();
  if (gesamt !== laenge) throw new Error(`Maske hat ${gesamt} statt ${laenge} Werte`);
  let stelle = 0;
  while (p < rle.length) {
    const c = rle[p];
    p += 1;
    if (c < 128) {
      const anzahl = c + 1;
      aus.set(rle.subarray(p, p + anzahl), stelle);
      p += anzahl;
      stelle += anzahl;
    } else {
      const anzahl = c < 255 ? c - 128 + LAUF_AB : zahl();
      aus.fill(rle[p], stelle, stelle + anzahl);
      p += 1;
      stelle += anzahl;
    }
  }
  if (stelle !== laenge) throw new Error(`Maske endet nach ${stelle} von ${laenge} Werten`);
  return aus;
}

/* ---------- Was an jedem Bild mitgemessen wird ---------- */

/**
 * Wo eine Maske liegt und wie viel sie deckt – in Bildpunkten der
 * Rechengrösse.
 *
 * Gebraucht für alles, was eine Maske nur BEURTEILT, statt sie zu zeichnen:
 * die Bahnen der Zeitleiste (ist sie hier im Bild?), Formteile, die ihrem
 * Inhalt folgen (wohin hat er sich bewegt?), die Punkte eines Tipps an einem
 * Bild ohne Anker. Auspacken hiesse dafür je Bild eine halbe Million Werte
 * anzufassen; diese sieben Zahlen liegen daneben.
 */
export interface MaskenMeta {
  /** Summe der Deckung durch 255 – so viele „volle" Bildpunkte. */
  readonly flaeche: number;
  /** Schwerpunkt, nach Deckung gewichtet. Bei einer leeren Maske 0. */
  readonly mx: number;
  readonly my: number;
  /**
   * Der Kasten der Punkte ab Deckung 64, einschliesslich. Bei einer Maske
   * ohne solche Punkte ist `x0 > x1`.
   */
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export const META_LEER: MaskenMeta = { flaeche: 0, mx: 0, my: 0, x0: 1, y0: 1, x1: 0, y1: 0 };

/** Ab dieser Deckung zählt ein Punkt zum Kasten – ein Viertel. */
const KASTEN_AB = 64;

/**
 * Die Messwerte einer Maske – gerundet wie beim Ablegen, damit sie zu dem
 * passen, was später ausgepackt wird.
 */
export function metaMessen(alpha: Uint8Array, breite: number, hoehe: number): MaskenMeta {
  let summe = 0;
  let sx = 0;
  let sy = 0;
  let x0 = breite;
  let y0 = hoehe;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < hoehe; y += 1) {
    const zeile = y * breite;
    for (let x = 0; x < breite; x += 1) {
      const a = quantisieren(alpha[zeile + x]);
      if (a === 0) continue;
      summe += a;
      sx += a * x;
      sy += a * y;
      if (a >= KASTEN_AB) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (summe === 0) return META_LEER;
  return {
    flaeche: summe / 255,
    mx: sx / summe,
    my: sy / summe,
    ...(x1 >= 0 ? { x0, y0, x1, y1 } : { x0: 1, y0: 1, x1: 0, y1: 0 }),
  };
}

/** Ob die Maske (nach den Messwerten) praktisch leer ist – weniger als ein voller Punkt. */
export function metaLeer(meta: MaskenMeta): boolean {
  return meta.flaeche < 1;
}

/** Ab so vielen Bytes Lauflängen gilt eine Maske als verrauscht – siehe `ablegbar`. */
export const RAUSCHEN_AB = 48 * 1024;

/**
 * Eine Maske so, wie sie abgelegt wird: als Lauflängen – und, wenn sie sich
 * so nicht klein machen lässt, vorher gröber gestuft.
 *
 * # Warum
 *
 * Nachgemessen bei 960 × 540 (`messung.test.ts`): Eine weiche Scheibe kommt
 * mit der Rundung aus `rleKodieren` (ab 250 → 255, bis 5 → 0) auf 6,6 KB. Eine
 * Zuversichtsmaske, wie ein Freisteller sie liefern kann – innen 235 … 255,
 * aussen 0 … 12, beides verrauscht –, bleibt bei 497 KB, fast ihrer vollen
 * Grösse: Jeder Punkt beginnt einen neuen Lauf. Sechshundert Filmbilder
 * davon wären 290 MB, das Doppelte des ganzen Budgets.
 *
 * Nur für SOLCHE Masken wird gröber gestuft: bis 16 → 0, ab 232 → 255,
 * dazwischen auf Achtel. Das ist höchstens ein Zehntel der Wirkung am
 * äussersten Saum und im Innern – und im Innern ist es Rauschen, das im Film
 * ohnehin nur flimmerte. Dieselbe verrauschte Maske, geglättet und so
 * gestuft: 9,7 KB, und die Verfolgung kostet je Bild 20 statt 47 ms, weil
 * das Packen nicht mehr jeden Punkt einzeln schreibt. Eine Maske, die sich
 * ordentlich packen lässt, bleibt Bit für Bit, wie sie war.
 *
 * Für die Ketten der Verfolgung (`maskenVerfolgen.ts`) und für die rohen
 * Ergebnisse der Freisteller im Netzvorrat (`spurVorrat.ts`).
 */
export function ablegbar(maske: Uint8Array): {
  readonly rle: Uint8Array;
  readonly maske: Uint8Array;
} {
  const rle = rleKodieren(maske);
  if (rle.length <= RAUSCHEN_AB) return { rle, maske };
  const grob = new Uint8Array(maske.length);
  for (let i = 0; i < maske.length; i += 1) {
    const wert = maske[i];
    grob[i] = wert <= 16 ? 0 : wert >= 232 ? 255 : (wert + 4) & ~7;
  }
  return { rle: rleKodieren(grob), maske: grob };
}
