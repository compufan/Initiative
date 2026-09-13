/**
 * Stapelarbeit: eine Einstellung auf viele Bilder.
 *
 * # Wozu
 *
 * Zwanzig Aufnahmen im selben Licht. Man stellt an EINER Belichtung, Wärme
 * und Kontrast ein, bis es sitzt – und fängt bei der zweiten wieder von vorn
 * an. Das ist der Grund, warum jedes ernsthafte Bearbeitungsprogramm ein
 * „Einstellungen übertragen“ hat.
 *
 * # Was übertragen wird, und was nicht
 *
 * Nur `Anpassung`: die elf Regler, die Kurven, die Farbbänder. Sie sind
 * einheitenlose Zahlen und gelten für jedes Bild gleich.
 *
 * Alles andere im Dokument steht in **Originalpunkten DIESES Bildes** – und
 * genau daran scheitert die naheliegende Idee, einfach das ganze Dokument zu
 * kopieren:
 *
 *   * Ein Zuschnitt von 800 × 600 ab (100, 50) ist im Hochformat daneben.
 *   * Die Griffe eines Verlaufs liegen an festen Punkten; im nächsten Bild
 *     liegt dort etwas anderes.
 *   * Eine Netzmaske und eine Tiefenkarte GEHÖREN zu ihrem Bild. Sie
 *     mitzugeben hiesse, die Silhouette der einen Person über die andere zu
 *     legen.
 *   * Striche und Schriftzüge sind an Ort und Stelle gemalt.
 *
 * Es wäre möglich, Verläufe und Ellipsen anteilig umzurechnen. Es wäre auch
 * falsch: Ein Verlauf, der im ersten Bild genau auf der Horizontlinie sitzt,
 * sitzt im zweiten anteilig woanders – und das sieht nicht nach „übertragen“
 * aus, sondern nach kaputt.
 *
 * # Warum vom ORIGINAL gerechnet wird
 *
 * Wer Bild 3 schon einmal bearbeitet hat und danach die Einstellung von
 * Bild 1 überträgt, bekäme sonst beides übereinander: Der Kontrast von
 * Bild 3 stünde noch in den Bildpunkten, und der von Bild 1 käme obendrauf.
 * Die Auswahl hält deshalb zu jedem Eintrag die Datei, wie sie hereinkam.
 */

import { neuesDoc } from './doc.js';
import { zeichneAusgabe } from './zeichnen.js';
import type { Anpassung } from './ton.js';

/** Ein Bild, wie es aus dem Stapel wieder herauskommt. */
export interface Stapelbild {
  blob: Blob;
  mime: string;
  breite: number;
  hoehe: number;
}

/** Wird nach jedem Bild gerufen – für die Fortschrittsanzeige. */
export type Stapelmelder = (fertig: number, gesamt: number) => void;

/** Zeigt an, dass die Reihe abgebrochen wurde. */
export class StapelAbbruch extends Error {
  constructor() {
    super('Die Reihe wurde abgebrochen');
    this.name = 'StapelAbbruch';
  }
}

async function alsBild(blob: Blob): Promise<HTMLImageElement> {
  const adresse = URL.createObjectURL(blob);
  try {
    return await new Promise<HTMLImageElement>((auf, ab) => {
      const bild = new Image();
      bild.onload = () => auf(bild);
      bild.onerror = () => ab(new Error('Das Bild konnte nicht gelesen werden'));
      bild.src = adresse;
    });
  } finally {
    // Erst NACH dem Laden freigeben – vorher bricht das Laden ab.
    URL.revokeObjectURL(adresse);
  }
}

/**
 * Ein einzelnes Bild mit einer Anpassung durchrechnen.
 *
 * Gerechnet wird über denselben Weg wie im Editor (`zeichneAusgabe`), damit
 * dasselbe herauskommt wie beim Bild, an dem eingestellt wurde. Ein eigener,
 * kürzerer Weg wäre schneller und sähe irgendwann anders aus.
 */
export async function anpassungAnwenden(
  quelle: Blob,
  anpassung: Anpassung,
): Promise<Stapelbild | null> {
  const bild = await alsBild(quelle);
  const doc = neuesDoc(bild.naturalWidth, bild.naturalHeight);
  doc.anpassung = anpassung;
  const leinwand = zeichneAusgabe(bild, bild.naturalWidth, bild.naturalHeight, doc);
  const blob = await new Promise<Blob | null>((auf) =>
    leinwand.toBlob((wert) => auf(wert), 'image/webp', 0.92),
  );
  const fertig =
    blob ??
    (await new Promise<Blob | null>((auf) =>
      leinwand.toBlob((wert) => auf(wert), 'image/jpeg', 0.92),
    ));
  if (!fertig) return null;
  return {
    blob: fertig,
    mime: fertig.type || 'image/webp',
    breite: leinwand.width,
    hoehe: leinwand.height,
  };
}

/**
 * Eine Reihe von Bildern, eines nach dem anderen.
 *
 * **Nacheinander und nicht nebeneinander.** Zwanzig Bilder gleichzeitig zu
 * rechnen hiesse, zwanzig Leinwände gleichzeitig zu halten – bei zwölf
 * Megapunkten je Bild fast eine Gigabyte, und auf einem Telefon fällt dann
 * der Reiter aus dem Speicher. Die Grafikeinheit rechnet ein Bild ohnehin in
 * Millisekunden; was dauert, ist das Kodieren, und das läuft auch nebeneinander
 * nicht schneller.
 *
 * Nach jedem Bild wird dem Aufrufer Bescheid gegeben und der Abbruch geprüft –
 * eine Reihe, die sich nicht anhalten lässt, ist auf einem Telefon keine
 * Hilfe, sondern eine Geiselnahme.
 */
export async function stapelAnwenden<T extends { id: string; quelle: Blob }>(
  bilder: readonly T[],
  anpassung: Anpassung,
  melden?: Stapelmelder,
  abbruch?: AbortSignal,
): Promise<Map<string, Stapelbild>> {
  const raus = new Map<string, Stapelbild>();
  melden?.(0, bilder.length);
  for (let i = 0; i < bilder.length; i += 1) {
    if (abbruch?.aborted) throw new StapelAbbruch();
    const fertig = await anpassungAnwenden(bilder[i].quelle, anpassung);
    if (fertig) raus.set(bilder[i].id, fertig);
    /*
     * Einmal den Strang freigeben.
     *
     * Ohne das läuft die ganze Reihe in einem Zug, und die
     * Fortschrittsanzeige steht die ganze Zeit auf 0 und springt am Ende auf
     * fertig – die Anzeige wäre da, aber sie zeigte nichts. Dasselbe gilt für
     * den Abbrechen-Knopf: Er liesse sich gar nicht drücken.
     */
    melden?.(i + 1, bilder.length);
    await new Promise((auf) => setTimeout(auf, 0));
  }
  if (abbruch?.aborted) throw new StapelAbbruch();
  return raus;
}
