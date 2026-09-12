/**
 * Ist diese Datei ein bewegtes Bild?
 *
 * # Warum das überhaupt gefragt werden muss
 *
 * Ein animiertes GIF oder WebP kommt als `HTMLImageElement` herein und bewegt
 * sich im Dokument auch – auf eine Leinwand gezeichnet wird davon aber genau
 * ein Bild, und das ohne jede Meldung. Wer ein bewegtes Bild zum Sticker
 * machte, bekam ein Standbild und erfuhr es erst hinterher, am fertigen
 * Sticker im Gespräch.
 *
 * # Warum von Hand und nicht mit einer Bibliothek
 *
 * Weil es zwei Byte-Muster sind. Beide Formate sagen es in ihrem Kopf, und
 * beide Prüfungen stehen unten in je einem Dutzend Zeilen. Eine Abhängigkeit
 * dafür wäre mehr Code als die Sache selbst – und bei Bildformaten eine
 * Angriffsfläche obendrein.
 */

/** Was eine Datei laut ihrem Kopf ist. */
export type Bildlage =
  | { bewegt: true; format: 'gif' | 'webp'; bilder: number | null }
  | { bewegt: false };

/**
 * GIF: Jedes Teilbild wird von einem Image Descriptor (`0x2C`) eingeleitet.
 *
 * Gezählt wird über die Blockkette, nicht mit einer Suche nach `0x2C` im
 * gesamten Strom: Das Byte kommt auch in Farbtabellen und in gepackten
 * Bilddaten vor, und eine naive Suche zählt dann Teilbilder, die es nicht
 * gibt. Der Aufbau ist in GIF89a festgelegt und lässt sich geradeaus
 * durchlaufen.
 */
function gifTeilbilder(daten: Uint8Array): number {
  // "GIF87a" oder "GIF89a", dann Logical Screen Descriptor (7 Byte).
  let at = 6;
  if (daten.length < 13) return 0;
  const packed = daten[at + 4];
  at += 7;
  // Globale Farbtabelle, wenn das oberste Bit gesetzt ist.
  if (packed & 0x80) at += 3 * (1 << ((packed & 0x07) + 1));

  let teilbilder = 0;
  while (at < daten.length) {
    const marke = daten[at];
    if (marke === 0x3b) break; // Trailer
    if (marke === 0x21) {
      // Erweiterung: Kennung, dann Datenblöcke bis zur Länge 0.
      at += 2;
      while (at < daten.length && daten[at] !== 0) at += daten[at] + 1;
      at += 1;
      continue;
    }
    if (marke === 0x2c) {
      teilbilder += 1;
      // Image Descriptor ist 10 Byte; danach ggf. eine lokale Farbtabelle.
      const lokal = daten[at + 9];
      at += 10;
      if (lokal & 0x80) at += 3 * (1 << ((lokal & 0x07) + 1));
      at += 1; // LZW-Mindestcodegrösse
      while (at < daten.length && daten[at] !== 0) at += daten[at] + 1;
      at += 1;
      continue;
    }
    // Unbekannt: Hier geradeaus weiterzulaufen hiesse raten. Was bis hierher
    // gezählt wurde, steht fest – mehr wird nicht behauptet.
    break;
  }
  return teilbilder;
}

/**
 * WebP: Ein bewegtes Bild trägt im RIFF-Behälter einen `ANIM`-Abschnitt.
 *
 * Die Zahl der Teilbilder steht dort nicht; sie ergäbe sich erst aus den
 * `ANMF`-Abschnitten. Für die Frage „bewegt oder nicht“ genügt `ANIM`, und
 * die Zahl bleibt ehrlicherweise offen.
 */
function istBewegtesWebp(daten: Uint8Array): boolean {
  if (daten.length < 21) return false;
  const text = (at: number, laenge: number) =>
    String.fromCharCode(...daten.subarray(at, at + laenge));
  if (text(0, 4) !== 'RIFF' || text(8, 4) !== 'WEBP') return false;
  // VP8X ist der erweiterte Kopf; nur er kann Animation ankündigen.
  if (text(12, 4) !== 'VP8X') return false;
  // Im Flag-Byte steht das Animationsbit an Stelle 1 (0x02).
  return (daten[20] & 0x02) !== 0;
}

/** Liest die ersten Bytes einer Datei und sagt, ob sie sich bewegt. */
export function bildlageAus(daten: Uint8Array): Bildlage {
  const anfang = (zeichen: string) =>
    String.fromCharCode(...daten.subarray(0, zeichen.length)) === zeichen;

  if (anfang('GIF8')) {
    const bilder = gifTeilbilder(daten);
    return bilder > 1 ? { bewegt: true, format: 'gif', bilder } : { bewegt: false };
  }
  if (istBewegtesWebp(daten)) {
    return { bewegt: true, format: 'webp', bilder: null };
  }
  return { bewegt: false };
}

/**
 * Dasselbe für eine Datei.
 *
 * Gelesen wird die ganze Datei: Bei einem GIF steht die Teilbildzahl über den
 * ganzen Strom verteilt, und ein Sticker ist ohnehin klein. Wer nur die
 * ersten Kilobyte liest, bekommt bei einem langen GIF „ein Teilbild“ heraus
 * und damit die falsche Antwort.
 */
export async function bildlage(datei: Blob): Promise<Bildlage> {
  try {
    const puffer = await datei.arrayBuffer();
    return bildlageAus(new Uint8Array(puffer));
  } catch {
    // Nicht lesbar: Dann behaupten wir nichts.
    return { bewegt: false };
  }
}
