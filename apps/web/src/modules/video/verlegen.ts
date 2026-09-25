import type { BildDoc } from '../bild/doc.js';
import { AbbruchError } from '../stickers/engines/index.js';
import { videoLeserOeffnen } from './bilderLesen.js';
import {
  docFuerBild,
  docMitLage,
  istFormTeil,
  istInhaltsTeil,
  type InhaltsArt,
  type InhaltsTeil,
  type NeueDaten,
} from './bildweise.js';
import { teilRechnen } from './folgeTeile.js';
import { Spur, type Punkt } from './objektFolge.js';
import {
  LAGE_RUHE,
  bewegung,
  grauMass,
  graustufen,
  lageKehren,
  lageRobust,
  lageVerketten,
  type Grau,
  type Lage,
} from './verfolgung.js';

/**
 * Masken von einem Bild an ein anderes mitnehmen.
 *
 * # Wofür
 *
 * Eine Freistellung, eine Tiefe, ein Tipp gehört zu dem Bild, an dem sie
 * gerechnet wurde. Wird ein Abschnitt geteilt, hat eine der beiden Hälften
 * ihr Stellbild woanders – an einem Bild, zu dem die Maske nicht passt. Sie
 * nur neu zu rechnen reicht beim Netz und bei der Tiefe (die brauchen nur
 * das Bild), beim Tipp aber nicht: Seine Punkte lagen auf dem Gegenstand,
 * und der ist inzwischen woanders.
 *
 * # Wie
 *
 * Genau wie beim Filmbau, nur mit zwei Schlüsselbildern: Die Bilder
 * dazwischen werden gelesen, als Graustufen behalten, und die Spur
 * (`objektFolge.ts`) sucht den Gegenstand darin Bild für Bild. Am Ziel wird
 * die Maske frisch gerechnet – mit den mitgewanderten Punkten – und gegen
 * die Vorhersage geprüft. Voll gehalten werden nur das erste und das letzte
 * Bild; die Graustufen dazwischen sind klein.
 *
 * Formen (Verlauf, Ellipse, Pinsel) wandern mit der KAMERA, wie beim
 * Filmbau: Sie stehen an einer Stelle der Szene, nicht an einem Gegenstand.
 */

export interface VerlegeAuftrag {
  /** Das Bild, zu dem die Masken gehören. */
  readonly vonMs: number;
  /** Das Bild, zu dem sie gehören sollen. */
  readonly nachMs: number;
  readonly kante: number;
  /** Der Bildabstand des Films – so dicht wird gesucht. */
  readonly schrittMs: number;
  readonly abbruch?: AbortSignal;
  readonly fortschritt?: (anteil: number) => void;
}

/**
 * Höchstens so viele Bilder werden dazwischen gelesen.
 *
 * Liegt das Ziel weiter weg (ein neuer Abschnitt aus einer ganz anderen
 * Stelle des Videos), wird gröber gesucht – dann kann die Spur den
 * Gegenstand verlieren, und am Ziel gilt, was das Modell sieht. Für Netz und
 * Tiefe ist das ohnehin das Richtige; beim Tipp bleiben die Punkte im
 * schlimmsten Fall, wo sie waren, und das Ergebnis steht im Editor zur
 * Ansicht.
 */
export const BILDER_MAX = 150;

/** Alle Teile, die zu einem Bild gehören – auch in abgeschalteten Bereichen. */
function alleInhaltsTeile(doc: BildDoc): InhaltsTeil[] {
  const raus: InhaltsTeil[] = [];
  for (const bereich of doc.bereiche) {
    for (const teil of bereich.teile) {
      if (istInhaltsTeil(teil))
        raus.push({ bereich: bereich.id, teil, art: teil.art as InhaltsArt });
    }
  }
  return raus;
}

export async function teileVerlegen(
  datei: Blob,
  doc: BildDoc,
  auftrag: VerlegeAuftrag,
): Promise<BildDoc> {
  const eintraege = alleInhaltsTeile(doc);
  const formen = doc.bereiche.some((bereich) => bereich.teile.some(istFormTeil));
  if ((eintraege.length === 0 && !formen) || Math.abs(auftrag.nachMs - auftrag.vonMs) < 0.5) {
    return doc;
  }
  if (auftrag.abbruch?.aborted) throw new AbbruchError();

  const vorwaerts = auftrag.nachMs >= auftrag.vonMs;
  const anfang = Math.min(auftrag.vonMs, auftrag.nachMs);
  const ende = Math.max(auftrag.vonMs, auftrag.nachMs);
  const schritt = Math.max(1, auftrag.schrittMs, (ende - anfang) / (BILDER_MAX - 1));
  const zeiten: number[] = [];
  for (let t = anfang; t < ende - 0.5; t += schritt) zeiten.push(t);
  zeiten.push(ende);
  const anzahl = zeiten.length;

  const leser = await videoLeserOeffnen(datei, {
    kante: auftrag.kante,
    // Derselbe Rand wie beim Filmbau und beim Stellbild – sonst läge das Ziel
    // am Videoende auf einem anderen Bild als das, das dort gezeigt wird.
    randMs: auftrag.schrittMs / 2,
    abbruch: auftrag.abbruch,
  });
  try {
    const grau: Grau[] = [];
    const voll = new Map<number, ImageData>();
    /*
     * Die Bilder dazwischen gleich in Graustufengrösse lesen.
     *
     * Voll gelesen und dann verkleinert kostete jedes gemessen 144 ms bei
     * 1280 × 720 und gedrosselter Rechenleistung – bei 150 Bildern über
     * zwanzig Sekunden, in denen der Editor ruckelt, während man an der
     * anderen Hälfte weiterarbeitet. Verkleinert beim Zeichnen sind es 19 ms.
     * Auch die beiden Enden bekommen ihre Graustufen so, damit alle aus
     * derselben Verkleinerung stammen; voll gelesen werden sie zusätzlich,
     * für das Modell.
     */
    const klein = grauMass(leser.breite, leser.hoehe);
    for (let i = 0; i < anzahl; i += 1) {
      if (auftrag.abbruch?.aborted) throw new AbbruchError();
      if (i === 0 || i === anzahl - 1) voll.set(i, await leser.bildAn(zeiten[i], auftrag.abbruch));
      grau.push(graustufen(await leser.bildAn(zeiten[i], auftrag.abbruch, klein)));
      auftrag.fortschritt?.(((i + 1) / anzahl) * 0.7);
    }
    const breite = leser.breite;
    const hoehe = leser.hoehe;
    const anker = vorwaerts ? 0 : anzahl - 1;
    const ziel = vorwaerts ? anzahl - 1 : 0;
    const bildAn = (nummer: number) => {
      const daten = voll.get(nummer);
      if (!daten) throw new Error('Dieses Bild wurde nicht gehalten');
      return { zeitMs: zeiten[nummer], daten };
    };

    const daten = new Map<string, NeueDaten>();
    const punkte = new Map<string, readonly Punkt[]>();
    type Sitzung = Awaited<ReturnType<typeof import('../bild/tiefeNetz.js').tiefensitzungOeffnen>>;
    let tiefe: Sitzung | null = null;
    try {
      if (eintraege.some((eintrag) => eintrag.art === 'tiefe')) {
        const modul = await import('../bild/tiefeNetz.js');
        tiefe = await modul.tiefensitzungOeffnen();
      }
      for (const [nummer, eintrag] of eintraege.entries()) {
        if (auftrag.abbruch?.aborted) throw new AbbruchError();
        const teil = eintrag.teil;
        if (teil.art === 'tiefe') {
          // Die Tiefe hängt nur am Bild: Am Ziel gerechnet ist sie richtig.
          const werte = await teilRechnen(
            eintrag,
            bildAn(ziel),
            breite,
            hoehe,
            tiefe,
            auftrag.abbruch,
            null,
          );
          daten.set(teil.id, { breite, hoehe, werte });
        } else if (teil.art === 'netz' || teil.art === 'tipp') {
          const gleichGross = teil.breite === breite && teil.hoehe === hoehe;
          const spur = new Spur({
            grau,
            breite,
            hoehe,
            von: 0,
            bis: anzahl - 1,
            anker,
            schluessel: [],
            punkte: teil.art === 'tipp' ? teil.punkte : null,
            /*
             * Am Anker gilt, was im Dokument steht – das ist die Maske, die
             * der Anwender gesehen und womöglich mit weiteren Tipps
             * zurechtgerückt hat. Neu gerechnet wäre sie beim Netz nur ein
             * zweiter Modellauf für dasselbe Bild.
             */
            ankerMaske: gleichGross ? teil.alpha : undefined,
            rechnen: (bild, gezogen) =>
              teilRechnen(eintrag, bildAn(bild), breite, hoehe, tiefe, auftrag.abbruch, gezogen),
          });
          while (spur.naechstes() !== null) await spur.schritt();
          daten.set(teil.id, { breite, hoehe, werte: spur.maskeAn(ziel) });
          const mitgenommen = spur.punkteAn(ziel);
          if (mitgenommen) punkte.set(teil.id, mitgenommen);
        }
        auftrag.fortschritt?.(0.7 + ((nummer + 1) / eintraege.length) * 0.3);
      }
    } finally {
      await tiefe?.schliessen();
    }
    const mitMasken = docFuerBild(doc, daten, punkte);
    if (!formen) return mitMasken;
    /*
     * Die Kamera von Bild zu Bild, aufsummiert wie in `folgeTeile.ts`, und
     * daraus der Weg vom alten zum neuen Stellbild.
     */
    const lagen: Lage[] = [LAGE_RUHE];
    let faktor = 1;
    for (let i = 1; i < anzahl; i += 1) {
      const feld = bewegung(grau[i - 1], grau[i], breite);
      faktor = feld.faktor;
      lagen.push(lageVerketten(lageRobust(feld)?.lage ?? LAGE_RUHE, lagen[i - 1]));
    }
    const seitAnker = lageVerketten(lagen[ziel], lageKehren(lagen[anker]));
    return docMitLage(mitMasken, seitAnker, faktor, true);
  } finally {
    leser.schliessen();
  }
}
