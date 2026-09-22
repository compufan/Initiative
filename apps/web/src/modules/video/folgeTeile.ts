import { AbbruchError, runEngine } from '../stickers/engines/index.js';
import { kanteWeichzeichnen } from '../stickers/engines/prepare.js';
import { tippTeilRechnen } from '../bild/tippMaske.js';
import type { GelesenesBild, Fortschritt } from './bilderLesen.js';
import type { InhaltsTeil } from './bildweise.js';
import type { NeueDaten } from './bildweise.js';
import {
  LAGE_RUHE,
  bewegung,
  graustufen,
  lageSchaetzen,
  lageVerketten,
  maskePasst,
  maskeZiehen,
  punktVor,
  zeitlichGlaetten,
  type Grau,
  type Lage,
} from './verfolgung.js';

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
  /**
   * An welchen Stellen ein neues Stück anfängt – aus `abtasten`.
   *
   * Ohne diese Zahlen schätzt die Bewegungssuche an einer Schnittkante eine
   * Bewegung zwischen zwei völlig verschiedenen Szenen. Das wäre für sich
   * schon falsch; schlimmer ist, dass `lageVerketten` die Lage jedes Bildes
   * bis zum ersten durchsummiert – der Unfug von einer Kante wanderte also
   * durch den ganzen Rest des Films.
   */
  readonly schnitte?: readonly number[];
  readonly fortschritt?: Fortschritt;
  readonly abbruch?: AbortSignal;
}

export interface TeileErgebnis {
  /** Je Bild eine Zuordnung Teilkennung → neue Daten. */
  readonly jeBild: readonly ReadonlyMap<string, NeueDaten>[];
  /** Wie oft wirklich gerechnet wurde – für die Anzeige und die Schätzung. */
  readonly laeufe: number;
  /**
   * Wie oft eine frisch gerechnete Maske verworfen wurde, weil sie nicht zu
   * dem passte, was zu erwarten war.
   *
   * Gehört in die Oberfläche: Wer sieht, dass von neun Schlüsselbildern fünf
   * verworfen wurden, weiss, dass an dieser Stelle etwas nicht stimmt – und
   * probiert eine andere Maske, statt das Ergebnis für das Beste zu halten,
   * was die App kann.
   */
  readonly verworfen: number;
  /**
   * Je Bild die Lage gegenüber dem ersten.
   *
   * Sie wird hier ohnehin gerechnet, und der Aufrufer braucht sie für die
   * Bereiche, die eine FORM beschreiben – Verlauf, Ellipse, Pinselstrich.
   * Zweimal zu rechnen hiesse, die Blocksuche über alle Bilder zu wiederholen.
   */
  readonly lagen: readonly Lage[];
  /** Wie viele Bildpunkte ein Graupunkt war. */
  readonly faktor: number;
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
  if (bilder.length === 0) return { jeBild: leer, laeufe: 0, verworfen: 0, lagen: [], faktor: 1 };
  if (auftrag.abbruch?.aborted) throw new AbbruchError();

  const breite = bilder[0].daten.width;
  const hoehe = bilder[0].daten.height;
  const abstand = Math.max(1, auftrag.schluesselAbstand);
  const schnitte = new Set(auftrag.schnitte ?? []);
  const schluessel = new Set<number>();
  for (let i = 0; i < bilder.length; i += abstand) schluessel.add(i);
  /*
   * An jeder Schnittkante zwei Schlüsselbilder: das letzte des alten Stücks
   * und das erste des neuen.
   *
   * Eine geschobene Maske über die Kante hinweg zeigte den Ausschnitt der
   * vorigen Szene – und das letzte Bild eines Stücks ist die Stelle, an der
   * man beim Ansehen hängenbleibt.
   */
  for (const stelle of schnitte) {
    schluessel.add(stelle);
    if (stelle > 0) schluessel.add(stelle - 1);
  }
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
  const felder = bilder.map((_, i) =>
    i === 0 || schnitte.has(i) ? null : bewegung(grau[i - 1], grau[i], breite),
  );
  const faktor = felder.find(Boolean)?.faktor ?? 1;

  /*
   * Die Lage JEDES Bildes gegenüber dem ERSTEN – aufsummiert, nicht Schritt
   * für Schritt angewandt.
   *
   * Das ist der Unterschied zwischen einer Maske, die mitgeht, und einer, die
   * zerfranst: Gezogen wird immer aus dem Urbild mit einer einzigen
   * Abbildung. Nachgemessen verliert eine Maske, die 33-mal nacheinander
   * gezogen wird, 58 % ihrer Fläche; in einem Zug gezogen behält sie sie.
   */
  const lagen: Lage[] = [LAGE_RUHE];
  for (let i = 1; i < bilder.length; i += 1) {
    // An einer Schnittkante fängt die Rechnung von vorn an, statt die Lage
    // des vorigen Stücks weiterzutragen.
    if (schnitte.has(i)) {
      lagen.push(LAGE_RUHE);
      continue;
    }
    const feld = felder[i];
    const schritt = feld ? lageSchaetzen(feld) : LAGE_RUHE;
    /*
     * Der SCHRITT zuerst, die aufgelaufene Kette danach.
     *
     * `schritt` bildet Bild i auf Bild i−1 ab, `lagen[i-1]` bildet Bild i−1
     * auf Bild 0 ab. Wer sie andersherum verkettet, rechnet die Drehung des
     * jüngsten Schrittes auf die Verschiebung der ganzen Kette an – gemessen
     * 26,6 Punkte Abweichung nach acht Schwenken und acht Drehungen.
     */
    lagen.push(lageVerketten(schritt, lagen[i - 1]));
  }

  /* ---------- Die Tiefensitzung, falls eine gebraucht wird ---------- */

  const brauchtTiefe = auftrag.teile.some((eintrag) => eintrag.art === 'tiefe');
  type Sitzung = Awaited<ReturnType<typeof import('../bild/tiefeNetz.js').tiefensitzungOeffnen>>;
  let tiefe: Sitzung | null = null;

  const roh = new Map<string, Uint8Array[]>();
  for (const eintrag of auftrag.teile) roh.set(eintrag.teil.id, []);

  let laeufe = 0;
  let verworfen = 0;
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
      // Nur zählen, wenn wirklich etwas zu rechnen war – sonst meldete ein
      // Dokument ohne Inhaltsteile Modelläufe, die nie stattfanden.
      if (istSchluessel && auftrag.teile.length > 0) laeufe += 1;

      for (const eintrag of auftrag.teile) {
        const sammlung = roh.get(eintrag.teil.id);
        if (!sammlung) continue;

        if (!istSchluessel) {
          /*
           * Aus dem letzten SCHLÜSSELBILD ziehen, nicht aus dem Vorgänger –
           * und mit der Lage, die von dort bis hierher gilt.
           */
          const anker = schluesselVor(schluessel, i);
          const vorlage = sammlung[anker];
          if (!vorlage) {
            sammlung.push(sammlung[i - 1]);
            continue;
          }
          const seitAnker = lageVerketten(lagen[i], kehren(lagen[anker]));
          sammlung.push(maskeZiehen(vorlage, breite, hoehe, seitAnker, faktor));
          continue;
        }

        const frisch = await teilRechnen(
          eintrag,
          bilder[i],
          breite,
          hoehe,
          tiefe,
          auftrag.abbruch,
          lagen[i],
          faktor,
        );
        /*
         * Gegen das halten, was aus dem vorigen Schlüsselbild zu erwarten
         * war – die Begründung samt Messung steht bei `maskePasst`.
         */
        // An einer Schnittkante gibt es nichts zu erwarten: Die Maske davor
        // gehört zu einer anderen Szene, und `maskePasst` würde die frische
        // zugunsten einer fremden verwerfen.
        const anker = i > 0 && !schnitte.has(i) ? schluesselVor(schluessel, i - 1) : -1;
        const vorlage = anker >= 0 ? sammlung[anker] : null;
        const erwartet = vorlage
          ? maskeZiehen(
              vorlage,
              breite,
              hoehe,
              lageVerketten(lagen[i], kehren(lagen[anker])),
              faktor,
            )
          : null;
        const befund = maskePasst(frisch, erwartet);
        if (!befund.haelt && erwartet) {
          verworfen += 1;
          sammlung.push(erwartet);
        } else {
          sammlung.push(frisch);
        }
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
    geglaettet.set(id, eintrag?.art === 'tiefe' ? folge : zeitlichGlaetten(folge, 3, schnitte));
  }

  const jeBild = bilder.map((_, i) => {
    const karte = new Map<string, NeueDaten>();
    for (const [id, folge] of geglaettet) {
      const werte = folge[i];
      if (werte) karte.set(id, { breite, hoehe, werte });
    }
    return karte;
  });

  return { jeBild, laeufe, verworfen, lagen, faktor };
}

/** Ein einzelnes Teil für ein einzelnes Bild rechnen. */
async function teilRechnen(
  eintrag: InhaltsTeil,
  bild: GelesenesBild,
  breite: number,
  hoehe: number,
  tiefe: { karteFuer(bild: ImageData): Promise<{ feld: Uint8Array }> } | null,
  abbruch: AbortSignal | undefined,
  lage: Lage,
  faktor: number,
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
     * Hier stand `teil.punkte` – also die Koordinaten vom ersten Bild, auf
     * jedem Schlüsselbild aufs Neue. Bei einer Kamera, die sich bewegt, zeigt
     * ein solcher Punkt nach zwei Sekunden auf etwas ganz anderes, und die
     * Maske sprang an jedem Schlüsselbild dorthin zurück. `folgeMaske.ts`
     * (der GIF-Weg) hat die Punkte von Anfang an mitgeführt; hier fehlte es.
     */
    const punkte = teil.punkte.map((punkt) => {
      const gezogen = punktVor(lage, faktor, punkt.x, punkt.y);
      return {
        x: Math.min(breite - 1, Math.max(0, Math.round(gezogen.x))),
        y: Math.min(hoehe - 1, Math.max(0, Math.round(gezogen.y))),
      };
    });
    const gerechnet = await tippTeilRechnen(bild.daten, punkte, {
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

/** Das letzte Schlüsselbild bis einschliesslich `bis`. */
function schluesselVor(schluessel: ReadonlySet<number>, bis: number): number {
  for (let i = bis; i >= 0; i -= 1) if (schluessel.has(i)) return i;
  return 0;
}

/**
 * Eine Lage umkehren.
 *
 * Gebraucht, um aus „Bild 0 nach Bild a" und „Bild 0 nach Bild b" die Lage
 * „Bild a nach Bild b" zu machen: erst zurück, dann vorwärts.
 */
function kehren(lage: Lage): Lage {
  const nenner = lage.s * lage.s + lage.w * lage.w;
  if (nenner === 0) return LAGE_RUHE;
  const s = lage.s / nenner;
  const w = -lage.w / nenner;
  return {
    s,
    w,
    tx: -(s * lage.tx - w * lage.ty),
    ty: -(w * lage.tx + s * lage.ty),
    sicher: lage.sicher,
  };
}
