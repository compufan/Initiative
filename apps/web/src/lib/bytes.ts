/**
 * Bytes sammeln, ohne sie einzeln zu verpacken.
 *
 * Steht hier und nicht bei einem der beiden Schreiber, weil inzwischen zwei
 * ihn brauchen: der GIF-Schreiber (`stickers/gif.ts`) und der WebM-Schreiber
 * (`video/webm.ts`). Beide bauen eine Binärdatei Byte für Byte, und beide
 * kennen ihre Länge vorher nicht.
 */

/**
 * Bytes sammeln, ohne sie einzeln zu verpacken.
 *
 * Ein `number[]` wäre kürzer und für einen Sticker mit zehn Teilbildern auch
 * gut genug. Für ein GIF aus einem Video ist er es nicht: Bei 150 Bildern
 * kommen gut zehn Millionen Bytes zusammen, und die liegen in einem
 * JavaScript-Feld als je acht Byte – achtzig Megabyte für zehn. Auf einem
 * Telefon ist das der Unterschied zwischen „dauert" und „die Seite wurde neu
 * geladen".
 *
 * Verdoppelt wird beim Wachsen, nicht um einen festen Betrag: Sonst kostet
 * das Umkopieren quadratisch, und genau das sollte der Puffer ja verhindern.
 */
export class Bytepuffer {
  private daten: Uint8Array;
  private laenge = 0;

  constructor(anfang = 1 << 16) {
    this.daten = new Uint8Array(anfang);
  }

  private platzSchaffen(zusatz: number): void {
    if (this.laenge + zusatz <= this.daten.length) return;
    let groesse = this.daten.length;
    while (groesse < this.laenge + zusatz) groesse *= 2;
    const neu = new Uint8Array(groesse);
    neu.set(this.daten.subarray(0, this.laenge));
    this.daten = neu;
  }

  byte(wert: number): void {
    this.platzSchaffen(1);
    this.daten[this.laenge] = wert;
    this.laenge += 1;
  }

  bytes(...werte: number[]): void {
    this.platzSchaffen(werte.length);
    for (const wert of werte) {
      this.daten[this.laenge] = wert;
      this.laenge += 1;
    }
  }

  /** Ein ganzes Feld anhängen – ohne Umweg über einzelne Aufrufe. */
  feld(werte: Uint8Array): void {
    this.platzSchaffen(werte.length);
    this.daten.set(werte, this.laenge);
    this.laenge += werte.length;
  }

  /** Eine Zahl in zwei Bytes, kleinstes zuerst – so will es das Format. */
  zahl16(wert: number): void {
    this.bytes(wert & 0xff, (wert >> 8) & 0xff);
  }

  text(wort: string): void {
    for (const zeichen of wort) this.byte(zeichen.charCodeAt(0));
  }

  get groesse(): number {
    return this.laenge;
  }

  /**
   * Der fertige Inhalt.
   *
   * `slice` und nicht `subarray`: Eine Ansicht hielte den ganzen – womöglich
   * doppelt so grossen – Puffer am Leben, solange die Datei existiert.
   */
  fertig(): Uint8Array {
    return this.daten.slice(0, this.laenge);
  }
}
