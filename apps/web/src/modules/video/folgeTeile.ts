import { AbbruchError, runEngine } from '../stickers/engines/index.js';
import { kanteWeichzeichnen } from '../stickers/engines/prepare.js';
import { tippTeilRechnen } from '../bild/tippMaske.js';
import type { GelesenesBild, Fortschritt } from './bilderLesen.js';
import type { InhaltsTeil } from './bildweise.js';
import type { NeueDaten } from './bildweise.js';
import { bewegung, graustufen, maskeSchieben, zeitlichGlaetten, type Grau } from './verfolgung.js';

/**
 * Die inhaltsabhängigen Maskenteile eines Bilddokumentes für JEDES Bild eines
 * Films.
 *
 * Der grosse Bruder von `folgeMaske.ts`. Der kann eine Maske; dieser kann
 * beliebig viele Teile nebeneinander – ein Netz für die Person, eine
 * Tiefenkarte für die Unschärfe, zwei Tipps für das, was kein Modell kennt.
 *
 * # Warum das nicht dasselbe Modul ist
 *
 * Weil `folgeMaske.ts` genau eine Frage beantwortet („welche Maske gilt für
 * Bild n?"), und die Antwort dort in ein GIF geht. Hier gibt es mehrere Teile
 * mit verschiedenen Verfahren, verschiedenen Kosten und – bei der Tiefe –
 * einer Sitzung, die über alle Bilder offen bleiben muss. Beides in ein Modul
 * zu zwingen hiesse, dem GIF eine Tiefensitzung beizubringen, die es nie
 * braucht.
 *
 * # Was geschoben wird und was nicht
 *
 * Netz und Tipp liefern eine MASKE – die lässt sich schieben, und genau das
 * tut `verfolgung.ts` zwischen den Schlüsselbildern.
 *
 * Die Tiefe liefert eine KARTE, also eine Entfernung je Bildpunkt. Die ist
 * ebenfalls schiebbar, und zwar mit denselben Vektoren: Wo vorher ein Meter
 * war, ist nach dem Schwenk immer noch ein Meter – nur an einer anderen
 * Stelle im Bild. Was NICHT gilt, ist die Entfernung selbst, wenn sich die
 * Kamera auf das Motiv zubewegt. Deshalb steht auch für die Tiefe ein
 * Schlüsselbildabstand, statt sie einmal zu rechnen.
 */

export interface TeileAuftrag {
  /** Die Teile, die je Bild neu müssen – aus `inhaltsTeile(doc)`. */
  readonly teile: readonly InhaltsTeil[];
  /** Jedes wievielte Bild wirklich gerechnet wird. */
  readonly schluesselAbstand: number;
  readonly fortschritt?: Fortschritt;
  readonly abbruch?: AbortSignal;
}

export interface TeileErgebnis {
  /** Je Bild eine Zuordnung Teilkennung → neue Daten. */
  readonly jeBild: readonly ReadonlyMap<string, NeueDaten>[];
  /** Wie oft wirklich gerechnet wurde – für die Anzeige und die Schätzung. */
  readonly laeufe: number;
}

/** Ein Abbruch, der mitbringt, wie viele Bilder schon fertig waren. */
export class TeileAbbruch extends AbbruchError {
  constructor(readonly fertig: number) {
    super();
    this.name = 'TeileAbbruch';
  }
}

/**
 * Der Weichzeichner für die Kante einer Netzmaske.
 *
 * Dieselbe Überlegung wie in `netzMaske.ts`: Ein Netz liefert eine harte
 * Entscheidung je Bildpunkt; für eine Anpassung, die überblendet wird, ist
 * eine harte Kante das, was ein Bild künstlich aussehen lässt. Im Film fällt
 * es sogar mehr auf als im Standbild, weil die Kante dann auch noch flimmert.
 */
const KANTE_WEICH = 1;

export async function folgeTeile(
  bilder: readonly GelesenesBild[],
  auftrag: TeileAuftrag,
): Promise<TeileErgebnis> {
  const leer = bilder.map(() => new Map<string, NeueDaten>());
  if (bilder.length === 0 || auftrag.teile.length === 0) return { jeBild: leer, laeufe: 0 };
  if (auftrag.abbruch?.aborted) throw new AbbruchError();

  const breite = bilder[0].daten.width;
  const hoehe = bilder[0].daten.height;
  const abstand = Math.max(1, auftrag.schluesselAbstand);
  const schluessel = new Set<number>();
  for (let i = 0; i < bilder.length; i += abstand) schluessel.add(i);
  // Das letzte Bild immer – siehe `folgeMaske.ts`: Ein Film wird am Ende
  // angehalten und angesehen, und dort sässe die geschobene Maske am
  // schlechtesten.
  schluessel.add(bilder.length - 1);

  // Die Graustufen einmal – jedes Bild ist an zwei Übergängen beteiligt.
  const grau: Grau[] = bilder.map((bild) => graustufen(bild.daten));
  /*
   * Die Bewegungsfelder ebenfalls einmal, und zwar GEMEINSAM für alle Teile.
   *
   * Vier Teile heissen sonst vier Mal dieselbe Blocksuche über dieselben zwei
   * Bilder. Gemessen sind das je 3 ms – bei 150 Bildern und vier Teilen also
   * knapp zwei Sekunden, die niemand braucht.
   */
  const felder = bilder.map((_, i) => (i === 0 ? null : bewegung(grau[i - 1], grau[i], breite)));

  /* ---------- Die Tiefensitzung, falls eine gebraucht wird ---------- */

  const brauchtTiefe = auftrag.teile.some((eintrag) => eintrag.art === 'tiefe');
  type Sitzung = Awaited<ReturnType<typeof import('../bild/tiefeNetz.js').tiefensitzungOeffnen>>;
  let tiefe: Sitzung | null = null;

  const roh = new Map<string, Uint8Array[]>();
  for (const eintrag of auftrag.teile) roh.set(eintrag.teil.id, []);

  let laeufe = 0;
  const schritte = bilder.length;

  try {
    if (brauchtTiefe) {
      /*
       * Erst hier geladen, nicht oben: Der Import zieht die ONNX-Laufzeit in
       * den Modulgraphen – 14 MB, die niemand braucht, der nur die Farbe
       * ändert.
       */
      const modul = await import('../bild/tiefeNetz.js');
      tiefe = await modul.tiefensitzungOeffnen((text) => auftrag.fortschritt?.(0, text));
    }

    for (let i = 0; i < bilder.length; i += 1) {
      if (auftrag.abbruch?.aborted) throw new TeileAbbruch(i);
      const istSchluessel = schluessel.has(i);
      if (istSchluessel) laeufe += 1;

      for (const eintrag of auftrag.teile) {
        const sammlung = roh.get(eintrag.teil.id);
        if (!sammlung) continue;

        if (!istSchluessel) {
          const feld = felder[i];
          const vorher = sammlung[i - 1];
          sammlung.push(feld && vorher ? maskeSchieben(vorher, breite, hoehe, feld) : vorher);
          continue;
        }

        sammlung.push(await teilRechnen(eintrag, bilder[i], breite, hoehe, tiefe, auftrag.abbruch));
      }

      auftrag.fortschritt?.((i + 1) / schritte, `Masken: Bild ${i + 1} von ${schritte}`);
    }
  } finally {
    await tiefe?.schliessen();
  }

  /* ---------- Glätten und ausliefern ---------- */

  const geglaettet = new Map<string, Uint8Array[]>();
  for (const [id, folge] of roh) {
    const eintrag = auftrag.teile.find((kandidat) => kandidat.teil.id === id);
    /*
     * Die TIEFENKARTE wird NICHT geglättet.
     *
     * Bei einer Maske nimmt das Mitteln über drei Bilder das Flimmern an der
     * Kante heraus – dort stehen ohnehin nur Null und 255, und dazwischen
     * gehört ein weicher Übergang. Eine Tiefenkarte besteht dagegen überall
     * aus Zwischenwerten; über drei Bilder gemittelt zieht sie eine
     * bewegte Kante zu einem Verlauf auseinander, und die Unschärfe bekäme
     * an jeder Silhouette einen Hof.
     */
    geglaettet.set(id, eintrag?.art === 'tiefe' ? folge : zeitlichGlaetten(folge));
  }

  const jeBild = bilder.map((_, i) => {
    const karte = new Map<string, NeueDaten>();
    for (const [id, folge] of geglaettet) {
      const werte = folge[i];
      if (werte) karte.set(id, { breite, hoehe, werte });
    }
    return karte;
  });

  return { jeBild, laeufe };
}

/** Ein einzelnes Teil für ein einzelnes Bild rechnen. */
async function teilRechnen(
  eintrag: InhaltsTeil,
  bild: GelesenesBild,
  breite: number,
  hoehe: number,
  tiefe: { karteFuer(bild: ImageData): Promise<{ feld: Uint8Array }> } | null,
  abbruch?: AbortSignal,
): Promise<Uint8Array> {
  const teil = eintrag.teil;

  if (teil.art === 'tiefe') {
    if (!tiefe) throw new Error('Für die Tiefe fehlt die Sitzung');
    const karte = await tiefe.karteFuer(bild.daten);
    return karte.feld;
  }

  if (teil.art === 'netz') {
    const maske = await runEngine(teil.netz, { image: bild.daten, abbruch });
    return kanteWeichzeichnen(maske, breite, hoehe, KANTE_WEICH);
  }

  if (teil.art === 'tipp') {
    /*
     * Die angetippten PUNKTE wandern mit, nicht die Maske.
     *
     * Das ist der ganze Vorteil dieses Weges: Aus den Punkten lässt sich die
     * Maske auf jedem Bild neu rechnen, und sie sitzt dann auf dem, was dort
     * wirklich steht – nicht auf dem, was auf Bild 1 dort stand.
     */
    const gerechnet = await tippTeilRechnen(bild.daten, teil.punkte, {
      modus: teil.modus,
      mitNetz: teil.mitNetz,
      toleranz: teil.toleranz,
      id: teil.id,
    });
    if (!gerechnet || gerechnet.art !== 'tipp') throw new Error('Der Tipp ergab keine Maske');
    return gerechnet.alpha;
  }

  throw new Error(`Diese Maskenart wird je Bild nicht gerechnet: ${teil.art}`);
}
