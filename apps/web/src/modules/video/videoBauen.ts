import { AbbruchError } from '../stickers/engines/index.js';
import type { BildDoc } from '../bild/doc.js';
import { zeichneAusgabe } from '../bild/zeichnen.js';
import { LeseAbbruch, videoBilderLesen, type GelesenesBild } from './bilderLesen.js';
import { dauerJeBildMs, zeitpunkte } from './ausschnitt.js';
import { docFuerBild, docMitLage, hatFormTeile, inhaltsTeile } from './bildweise.js';
import { TeileAbbruch, folgeTeile } from './folgeTeile.js';
import { LAGE_RUHE, type Lage } from './verfolgung.js';
import { videoSchreiben, videoTauglich } from './schreiben.js';

/**
 * Ein bearbeitetes Video – dieselbe Bearbeitung wie beim Foto, über alle
 * Bilder.
 *
 * # Warum das Dokument von EINEM Bild kommt
 *
 * Weil eine Bearbeitung eine Entscheidung ist und keine Rechnung. „Etwas
 * wärmer, den Himmel dunkler, die Person schärfer" gilt für den ganzen Film;
 * an fünfzig Bildern einzeln eingestellt wäre es fünfzig Mal dieselbe
 * Entscheidung mit fünfzig leicht verschiedenen Ergebnissen – und ein
 * flackernder Film.
 *
 * Drei Arten von Maskenteilen sind davon ausgenommen, weil sie nicht die
 * Entscheidung, sondern den Bildinhalt beschreiben: Netz, Tiefe und Tipp.
 * Die rechnet `folgeTeile.ts` je Bild neu, und `bildweise.ts` setzt sie ein.
 *
 * # Warum die Bilder nicht alle zugleich im Speicher liegen
 *
 * Weil sie das nicht können. Hundertfünfzig Bilder bei 1280 × 720 sind
 * 550 MB, und `getImageData` gibt sie unkomprimiert heraus. Gelesen wird
 * deshalb in Rechengrösse (längere Kante `kante`), und das ist auch die
 * Grösse des fertigen Films – wer ein 4K-Video hineinsteckt, bekommt kein
 * 4K-Video zurück, und das steht in der Oberfläche auch so da.
 */

export type Abschnitt = 'lesen' | 'masken' | 'rechnen';

export const ABSCHNITT_TITEL: Record<Abschnitt, string> = {
  lesen: 'Bilder holen',
  masken: 'Masken rechnen',
  rechnen: 'Video schreiben',
};

export interface VideoBauAuftrag {
  readonly datei: Blob;
  readonly doc: BildDoc;
  readonly vonMs: number;
  readonly bisMs: number;
  readonly bildrate: number;
  /** Die längere Kante, in der gerechnet und geschrieben wird. */
  readonly kante: number;
  /** Jedes wievielte Bild wirklich durch die Modelle geht. */
  readonly schluesselAbstand: number;
  /**
   * Wie viele Bilder höchstens – aus `maxBilderFuer(breite, hoehe)`.
   *
   * Steht hier und nicht als feste Zahl im Modul, weil sie an der
   * Rechengrösse hängt: `videoBilderLesen` hält alle Bilder unkomprimiert,
   * und bei 1080p sind hundertfünfzig davon anderthalb Gigabyte.
   */
  readonly maxBilder: number;
  readonly fortschritt?: (anteil: number, abschnitt: Abschnitt, text: string) => void;
  readonly abbruch?: AbortSignal;
}

export interface VideoBauErgebnis {
  readonly blob: Blob;
  readonly bilder: number;
  readonly breite: number;
  readonly hoehe: number;
  readonly laufzeitMs: number;
  /** Wie oft die Modelle wirklich gelaufen sind. */
  readonly laeufe: number;
}

/** Ein Abbruch, der sagt, wie weit es gekommen war. */
export class VideoBauAbbruch extends AbbruchError {
  constructor(
    readonly abschnitt: Abschnitt,
    readonly fertigeBilder: number,
  ) {
    super();
    this.name = 'VideoBauAbbruch';
  }
}

export async function videoAusVideo(auftrag: VideoBauAuftrag): Promise<VideoBauErgebnis> {
  if (auftrag.abbruch?.aborted) throw new AbbruchError();

  /*
   * Die Tauglichkeit VOR dem Rechnen prüfen.
   *
   * Eine halbe Minute zu warten und dann zu erfahren, dass dieser Browser
   * keine Videos schreiben kann, ist die ärgerlichste Art, eine fehlende
   * Fähigkeit mitzuteilen.
   */
  const tauglich = await videoTauglich(auftrag.kante, auftrag.kante);
  if (!tauglich.moeglich)
    throw new Error(tauglich.grund ?? 'Dieser Browser kann keine Videos schreiben');

  const plan = zeitpunkte(auftrag.vonMs, auftrag.bisMs, auftrag.bildrate, auftrag.maxBilder);
  const teile = inhaltsTeile(auftrag.doc);
  const gewicht = gewichte(
    plan.zeitpunkte.length,
    teile.length > 0 || hatFormTeile(auftrag.doc),
    auftrag.schluesselAbstand,
  );
  const melden = (abschnitt: Abschnitt, anteil: number, text: string) => {
    const vorher =
      abschnitt === 'lesen'
        ? 0
        : abschnitt === 'masken'
          ? gewicht.lesen
          : gewicht.lesen + gewicht.masken;
    const breite =
      abschnitt === 'lesen'
        ? gewicht.lesen
        : abschnitt === 'masken'
          ? gewicht.masken
          : gewicht.rechnen;
    auftrag.fortschritt?.(Math.min(1, vorher + anteil * breite), abschnitt, text);
  };

  let gelesen: { bilder: readonly GelesenesBild[]; breite: number; hoehe: number };
  try {
    gelesen = await videoBilderLesen(auftrag.datei, {
      zeitpunkte: plan.zeitpunkte,
      kante: auftrag.kante,
      fortschritt: (anteil, text) => melden('lesen', anteil, text),
      abbruch: auftrag.abbruch,
    });
  } catch (ausfall) {
    if (ausfall instanceof LeseAbbruch) throw new VideoBauAbbruch('lesen', ausfall.fertig.length);
    throw ausfall;
  }

  let jeBild: readonly ReadonlyMap<string, { breite: number; hoehe: number; werte: Uint8Array }>[] =
    gelesen.bilder.map(() => new Map());
  let lagen: readonly Lage[] = gelesen.bilder.map(() => LAGE_RUHE);
  let grauFaktor = 1;
  let laeufe = 0;
  /*
   * Auch OHNE Inhaltsteile wird die Bewegung geschätzt, sobald ein Bereich
   * eine Form beschreibt.
   *
   * Ein Verlauf oder ein Pinselstrich kommt nicht aus dem Bild, er steht
   * darin – und blieb bisher stehen, während die Szene darunter wegwanderte.
   * Genau das war die Beschwerde: „der markierte Bereich bleibt im Verlauf
   * des Videos nicht dort wo er soll."
   */
  const formen = hatFormTeile(auftrag.doc);
  if (teile.length > 0 || formen) {
    try {
      const gerechnet = await folgeTeile(gelesen.bilder, {
        teile,
        schluesselAbstand: auftrag.schluesselAbstand,
        fortschritt: (anteil, text) => melden('masken', anteil, text),
        abbruch: auftrag.abbruch,
      });
      jeBild = gerechnet.jeBild;
      laeufe = gerechnet.laeufe;
      if (gerechnet.lagen.length === gelesen.bilder.length) lagen = gerechnet.lagen;
      grauFaktor = gerechnet.faktor;
    } catch (ausfall) {
      if (ausfall instanceof TeileAbbruch) throw new VideoBauAbbruch('masken', ausfall.fertig);
      throw ausfall;
    }
  }

  /* ---------- Jedes Bild zeichnen und kodieren ---------- */

  const anzahl = gelesen.bilder.length;
  /*
   * Die Leinwand, auf der das Quellbild landet, wird EINMAL angelegt.
   *
   * `zeichneAusgabe` verlangt eine `CanvasImageSource` – ein `ImageData` ist
   * keine. Je Bild eine neue Leinwand wären hundertfünfzig Leinwände, die der
   * Einsammler wegräumen muss, und auf einem Telefon ist Grafikspeicher genau
   * das, was dabei ausgeht.
   */
  const quelle = document.createElement('canvas');
  quelle.width = gelesen.breite;
  quelle.height = gelesen.hoehe;
  const stift = quelle.getContext('2d');
  if (!stift) throw new Error('Diese Ansicht kann keine Bilder zeichnen');

  /*
   * Passt das Dokument überhaupt zu dieser Bildgrösse?
   *
   * Ein `BildDoc` steht in Punkten SEINES Quellbildes. Kommt es von einem
   * Standbild in 640 und wird hier in 192 gerechnet, meint sein Zuschnitt
   * eine Fläche, die es gar nicht gibt – `wirksamerZuschnitt` liefert dann
   * brav den alten Ausschnitt, und heraus kommt ein Film in einer Grösse,
   * die niemand gewählt hat. Ohne Fehler, ohne Warnung.
   *
   * Nachgemessen: Ein Dokument von 320 × 240 auf Bildern von 192 × 144 ergab
   * einen Film von 320 × 240. Die Oberfläche verhindert das, indem sie die
   * Grösse festhält, sobald etwas eingestellt ist – dieser Riegel ist der
   * zweite, für alle anderen Aufrufer.
   */
  const z = auftrag.doc.zuschnitt;
  if (z.x + z.w > gelesen.breite + 1 || z.y + z.h > gelesen.hoehe + 1) {
    throw new Error(
      `Diese Bearbeitung gehört zu einem Bild von mindestens ${z.x + z.w} × ${z.y + z.h}, ` +
        `gerechnet wird aber in ${gelesen.breite} × ${gelesen.hoehe}.`,
    );
  }

  // Einmal zeichnen, um die Ausgabegrösse zu erfahren – sie hängt am
  // Zuschnitt und an der Drehung, nicht nur an der Quelle.
  stift.putImageData(gelesen.bilder[0].daten, 0, 0);
  const probe = zeichneAusgabe(quelle, gelesen.breite, gelesen.hoehe, auftrag.doc);
  const breite = probe.width;
  const hoehe = probe.height;

  let blob: Blob;
  try {
    blob = await videoSchreiben(
      anzahl,
      (nummer) => {
        stift.putImageData(gelesen.bilder[nummer].daten, 0, 0);
        return zeichneAusgabe(
          quelle,
          gelesen.breite,
          gelesen.hoehe,
          docFuerBild(docMitLage(auftrag.doc, lagen[nummer], grauFaktor), jeBild[nummer]),
        );
      },
      {
        breite,
        hoehe,
        bildrate: auftrag.bildrate,
        fortschritt: (anteil, text) => melden('rechnen', anteil, text),
        abbruch: auftrag.abbruch,
      },
    );
  } catch (ausfall) {
    if (ausfall instanceof AbbruchError) throw new VideoBauAbbruch('rechnen', anzahl);
    throw ausfall;
  }

  return {
    blob,
    bilder: anzahl,
    breite,
    hoehe,
    laufzeitMs: Math.round(anzahl * dauerJeBildMs(auftrag.bildrate)),
    laeufe,
  };
}

/*
 * Wie sich die Arbeit auf die drei Abschnitte verteilt.
 *
 * Grober als bei `phasenGewichte` in `einstellungen.ts`, und mit Absicht:
 * Dort steht EIN Netz mit einer gemessenen Zeit dahinter, hier können es
 * vier Teile mit ganz verschiedenen Kosten sein – ein Tipp ohne Netz ist eine
 * Farbflutung von Millisekunden, eine Tiefenkarte sind zweieinhalb Sekunden.
 * Eine Schätzung, die so tut, als wüsste sie das genau, wäre falscher als
 * eine, die nur die Grössenordnung trifft.
 *
 * Die Zahlen sind trotzdem gemessen, nicht geraten:
 *
 * – Lesen: 75 ms je Bild bei 1280 × 720 (siehe `bilderLesen.ts`).
 * – Zeichnen und Kodieren zusammen: 13,5 ms bei 192 × 144, 9,4 ms bei
 *   640 × 360, 14,1 ms bei 960 × 540. Die Zahl wächst NICHT mit der Fläche,
 *   und das ist kein Messfehler: `zeichneAusgabe` rechnet auf der
 *   Grafikeinheit, und dort kostet ein grösseres Bild kaum mehr. Deshalb
 *   steht hier eine feste Zahl und keine, die mit der Fläche skaliert.
 * – Ein Modellauf: u2netp 1874 bis 2180 ms, die Tiefenkarte rund 2500 ms.
 *   2000 liegt dazwischen.
 * – Schieben: rund 10 ms, siehe `verfolgung.ts`.
 *
 * Nachgerechnet an einem Lauf mit Tiefe: fünf Bilder, zwei Modelläufe –
 * geschätzt 6,25 s, gemessen 6,35 s.
 */
const JE_BILD_LESEN = 75;
const JE_BILD_RECHNEN = 15;
const JE_LAUF_MASKE = 2000;
const JE_BILD_SCHIEBEN = 10;

function gewichte(bilder: number, mitMasken: boolean, schluesselAbstand: number) {
  const lesen = bilder * JE_BILD_LESEN;
  const rechnen = bilder * JE_BILD_RECHNEN;
  let masken = 0;
  if (mitMasken) {
    const laeufe = Math.ceil(bilder / Math.max(1, schluesselAbstand));
    masken = laeufe * JE_LAUF_MASKE + (bilder - laeufe) * JE_BILD_SCHIEBEN;
  }
  const summe = lesen + rechnen + masken;
  if (summe <= 0) return { lesen: 1, masken: 0, rechnen: 0 };
  return { lesen: lesen / summe, masken: masken / summe, rechnen: rechnen / summe };
}
