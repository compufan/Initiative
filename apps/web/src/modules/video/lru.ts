/**
 * Ein Zwischenspeicher, der nach BYTES begrenzt ist und das am längsten
 * nicht Gebrauchte zuerst vergisst.
 *
 * # Warum nach Bytes und nicht nach Einträgen
 *
 * Weil die Einträge hier nicht gleich gross sind. Ein zusammengesetztes Bild
 * mit einem Pinselstrich wiegt ein paar hundert Byte, eines mit vier
 * Netzmasken bei 1280 × 720 knapp vier Megabyte. „Sechzehn Bilder" hiesse
 * damit zwischen ein paar Kilobyte und sechzig Megabyte – und die
 * sechzig sind auf einem Telefon genau der Unterschied, bei dem Safari den
 * Reiter neu lädt.
 *
 * Die Reihenfolge führt die `Map` selbst: Sie zählt in Einfügereihenfolge,
 * und ein Treffer wird entnommen und hinten wieder eingesetzt.
 */
export class BytesLru<S, W> {
  private readonly eintraege = new Map<S, { wert: W; bytes: number }>();
  private summe = 0;

  constructor(
    private readonly maxBytes: number,
    /** Wird für jeden Eintrag gerufen, der weichen muss – nicht für `loeschen`. */
    private readonly verdraengt?: (schluessel: S, wert: W) => void,
  ) {}

  /** Der Wert – und er gilt ab jetzt als zuletzt gebraucht. */
  holen(schluessel: S): W | undefined {
    const eintrag = this.eintraege.get(schluessel);
    if (!eintrag) return undefined;
    this.eintraege.delete(schluessel);
    this.eintraege.set(schluessel, eintrag);
    return eintrag.wert;
  }

  /** Ohne ihn als gebraucht zu zählen. */
  hat(schluessel: S): boolean {
    return this.eintraege.has(schluessel);
  }

  /**
   * Ablegen und so viel Altes verdrängen, bis die Grenze wieder hält.
   *
   * Ein Eintrag, der allein schon grösser ist als die Grenze, wird gar
   * nicht erst abgelegt: Er verdrängte alles andere und flöge beim nächsten
   * Mal selbst hinaus.
   */
  ablegen(schluessel: S, wert: W, bytes: number): void {
    this.loeschen(schluessel);
    if (bytes > this.maxBytes) return;
    this.eintraege.set(schluessel, { wert, bytes });
    this.summe += bytes;
    for (const [alt, eintrag] of this.eintraege) {
      if (this.summe <= this.maxBytes) break;
      this.eintraege.delete(alt);
      this.summe -= eintrag.bytes;
      this.verdraengt?.(alt, eintrag.wert);
    }
  }

  /**
   * Das am längsten nicht Gebrauchte verdrängen, bis höchstens `bytes`
   * übrig sind – wenn der Platz woanders gebraucht wird.
   */
  begrenzen(bytes: number): void {
    for (const [alt, eintrag] of this.eintraege) {
      if (this.summe <= bytes) break;
      this.eintraege.delete(alt);
      this.summe -= eintrag.bytes;
      this.verdraengt?.(alt, eintrag.wert);
    }
  }

  loeschen(schluessel: S): void {
    const eintrag = this.eintraege.get(schluessel);
    if (!eintrag) return;
    this.eintraege.delete(schluessel);
    this.summe -= eintrag.bytes;
  }

  leeren(): void {
    this.eintraege.clear();
    this.summe = 0;
  }

  get bytes(): number {
    return this.summe;
  }

  get anzahl(): number {
    return this.eintraege.size;
  }
}
