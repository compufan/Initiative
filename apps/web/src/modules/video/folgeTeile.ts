import { AbbruchError, NichtsGefunden, runEngine } from '../stickers/engines/index.js';
import { kanteWeichzeichnen } from '../stickers/engines/prepare.js';
import { tippTeilRechnen } from '../bild/tippMaske.js';
import type { GelesenesBild, Fortschritt } from './bilderLesen.js';
import type { InhaltsTeil, NeueDaten } from './bildweise.js';
import { Spur, type Punkt } from './objektFolge.js';
import {
  LAGE_RUHE,
  bewegtGlaetten,
  bewegung,
  graustufen,
  lageKehren,
  lageRobust,
  lageVerketten,
  maskeZiehen,
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

/**
 * Ein Abschnitt des Films mit SEINEN Teilen und seinem Anker.
 *
 * Jeder Abschnitt trägt seine eigene Bearbeitung (`schnitt.ts`), und die
 * Masken darin gehören zu dem Bild, an dem sie eingestellt wurden – dem
 * Anker. Von dort läuft die Verfolgung rückwärts zum Anfang des Abschnitts
 * und vorwärts zu seinem Ende.
 */
export interface TeileAbschnitt {
  /** Erstes und letztes Bild, einschliesslich. */
  readonly von: number;
  readonly bis: number;
  /** Das Bild, zu dem die Teile gehören. */
  readonly anker: number;
  readonly teile: readonly InhaltsTeil[];
}

export interface TeileAuftrag {
  /**
   * Die Teile, die je Bild neu müssen – aus `inhaltsTeile(doc)`, für einen
   * Film mit EINER Bearbeitung. Angesetzt wird dann am Anfang jedes Stücks.
   */
  readonly teile?: readonly InhaltsTeil[];
  /** Oder je Abschnitt eigene Teile mit eigenem Anker. Hat Vorrang vor `teile`. */
  readonly abschnitte?: readonly TeileAbschnitt[];
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
   * Je Bild die Lage gegenüber dem ersten seines Stücks.
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

/** Der Seite Luft lassen – ein Makrotask, damit Zeichnen und „Abbrechen" durchkommen. */
const luftholen = () => new Promise<void>((weiter) => setTimeout(weiter, 0));

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
  const stuecke = stueckGrenzen(bilder.length, schnitte);
  const abschnitte = abschnitteFuer(auftrag, stuecke, bilder.length);

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
  // schlechtesten. Dazu Anfang, Ende und Anker jedes Abschnitts.
  schluessel.add(bilder.length - 1);
  for (const abschnitt of abschnitte) {
    schluessel.add(abschnitt.von);
    schluessel.add(abschnitt.bis);
    schluessel.add(abschnitt.anker);
  }
  const schluesselSortiert = Array.from(schluessel).sort((a, b) => a - b);

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
   * Die Lage der KAMERA für jedes Bild gegenüber dem ersten seines Stücks –
   * aufsummiert, nicht Schritt für Schritt angewandt.
   *
   * Gebraucht für das, was an der Szene klebt und nicht an einem
   * Gegenstand: die Tiefenkarte hier, Verlauf, Ellipse und Pinselstrich beim
   * Aufrufer. Masken folgen ihrem Gegenstand über `Spur` (objektFolge.ts).
   *
   * `lageRobust` statt `lageSchaetzen`: Bei ruhender Kamera zählte die alte
   * Schätzung nur, was sich bewegte – und die „Kamera" lief mit dem einzigen
   * Gegenstand mit, der durchs Bild ging. Ruhende Blöcke mit Struktur
   * stimmen jetzt für den Stillstand.
   */
  const lagen: Lage[] = [LAGE_RUHE];
  for (let i = 1; i < bilder.length; i += 1) {
    if (schnitte.has(i)) {
      lagen.push(LAGE_RUHE);
      continue;
    }
    const feld = felder[i];
    const schritt = feld ? (lageRobust(feld)?.lage ?? LAGE_RUHE) : LAGE_RUHE;
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

  /* ---------- Welche Teile über welche Bilder laufen ---------- */

  const brauchtTiefe = abschnitte.some((a) => a.teile.some((e) => e.art === 'tiefe'));
  type Sitzung = Awaited<ReturnType<typeof import('../bild/tiefeNetz.js').tiefensitzungOeffnen>>;
  let tiefe: Sitzung | null = null;

  const gerechnetAn = new Set<number>();
  let verworfen = 0;
  /*
   * Je Abschnitt und Teil eine Folge über SEINE Bilder. Nach Kennung allein
   * ginge es nicht: Zwei Hälften eines geteilten Abschnitts tragen dieselben
   * Teile mit denselben Kennungen, aber verschiedenen Ankern.
   */
  const folgen = abschnitte.map(
    (abschnitt) =>
      new Map<string, (Uint8Array | undefined)[]>(
        abschnitt.teile.map((eintrag) => [
          eintrag.teil.id,
          new Array(abschnitt.bis - abschnitt.von + 1),
        ]),
      ),
  );

  const rechnenFuer =
    (eintrag: InhaltsTeil) =>
    async (bild: number, punkte: readonly Punkt[] | null): Promise<Uint8Array> => {
      gerechnetAn.add(bild);
      return teilRechnen(eintrag, bilder[bild], breite, hoehe, tiefe, auftrag.abbruch, punkte);
    };

  const spuren: { nummer: number; eintrag: InhaltsTeil; spur: Spur }[] = [];
  const tiefenArbeit: { nummer: number; bild: number }[] = [];
  abschnitte.forEach((abschnitt, nummer) => {
    for (const eintrag of abschnitt.teile) {
      if (eintrag.art === 'tiefe') continue;
      spuren.push({
        nummer,
        eintrag,
        spur: new Spur({
          grau,
          breite,
          hoehe,
          von: abschnitt.von,
          bis: abschnitt.bis,
          anker: abschnitt.anker,
          schluessel: schluesselSortiert,
          punkte: eintrag.teil.art === 'tipp' ? eintrag.teil.punkte : null,
          rechnen: rechnenFuer(eintrag),
        }),
      });
    }
    if (abschnitt.teile.some((eintrag) => eintrag.art === 'tiefe')) {
      for (const bild of schluesselSortiert) {
        if (bild >= abschnitt.von && bild <= abschnitt.bis) tiefenArbeit.push({ nummer, bild });
      }
    }
  });
  tiefenArbeit.sort((a, b) => a.bild - b.bild);
  let tiefenPos = 0;
  const tiefenJe = (nummer: number) =>
    abschnitte[nummer].teile.filter((eintrag) => eintrag.art === 'tiefe');

  const gesamt =
    spuren.reduce((summe, { spur }) => summe + zaehlen(spur), 0) +
    tiefenArbeit.reduce((summe, arbeit) => summe + tiefenJe(arbeit.nummer).length, 0) +
    // Das Zusammensetzen je Spur zählt mit – sonst stünde der Balken voll,
    // während noch gerechnet wird.
    spuren.length;
  let erledigt = 0;
  const melden = () =>
    auftrag.fortschritt?.(gesamt > 0 ? erledigt / gesamt : 1, `Masken: ${erledigt} von ${gesamt}`);

  const fertigBis = () => {
    let bis = bilder.length;
    for (const { spur } of spuren) bis = Math.min(bis, spur.fertigBis());
    if (tiefenPos < tiefenArbeit.length) bis = Math.min(bis, tiefenArbeit[tiefenPos].bild);
    return bis;
  };

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

    /*
     * In der Reihenfolge der Bilder, quer über alle Teile.
     *
     * Nicht Teil für Teil: Ein Abbruch soll sagen können, bis wohin ALLE
     * Teile fertig sind – daran hängt das Angebot „aus den fertigen Bildern
     * trotzdem einen Film machen".
     */
    for (;;) {
      if (auftrag.abbruch?.aborted) throw new TeileAbbruch(fertigBis());
      let naechste: { spur: Spur } | null = null;
      let bild = Infinity;
      for (const eintrag of spuren) {
        const k = eintrag.spur.naechstes();
        if (k !== null && k < bild) {
          bild = k;
          naechste = eintrag;
        }
      }
      const arbeit = tiefenPos < tiefenArbeit.length ? tiefenArbeit[tiefenPos] : null;
      if (!naechste && !arbeit) break;
      if (arbeit && arbeit.bild <= bild) {
        const abschnitt = abschnitte[arbeit.nummer];
        for (const eintrag of tiefenJe(arbeit.nummer)) {
          const karte = await rechnenFuer(eintrag)(arbeit.bild, null);
          const folge = folgen[arbeit.nummer].get(eintrag.teil.id) as (Uint8Array | undefined)[];
          folge[arbeit.bild - abschnitt.von] = karte;
          erledigt += 1;
        }
        tiefenPos += 1;
      } else if (naechste) {
        await naechste.spur.schritt();
        erledigt += 1;
      }
      melden();
    }

    /* ---------- Zusammensetzen, glätten, ausliefern ---------- */

    for (const { nummer, eintrag, spur } of spuren) {
      /*
       * Zwischen zwei Spuren kommt die Seite zu Wort.
       *
       * Hier liefen vorher alle Spuren am Stück, ohne ein einziges `await`:
       * Der Balken stand auf voll, „Abbrechen" kam nicht an, und auf einem
       * Telefon stand die Seite gemessen zwanzig bis dreissig Sekunden.
       */
      await luftholen();
      if (auftrag.abbruch?.aborted) throw new TeileAbbruch(fertigBis());
      const abschnitt = abschnitte[nummer];
      const lauf = spur.ergebnis();
      verworfen += lauf.verworfen;
      /*
       * Geglättet wird MIT der Bewegung: Die Nachbarn werden dorthin
       * verschoben, wo die Maske in diesem Bild steht. Das blosse Mittel
       * legte um einen wandernden Gegenstand einen Saum, so breit wie sein
       * Weg je Bild.
       */
      const glatt = bewegtGlaetten(lauf.masken, breite, hoehe, lauf.versatz);
      const folge = folgen[nummer].get(eintrag.teil.id) as (Uint8Array | undefined)[];
      glatt.forEach((maske, i) => {
        if (abschnitt.von + i <= abschnitt.bis) folge[i] = maske;
      });
      erledigt += 1;
      melden();
    }
  } finally {
    await tiefe?.schliessen();
  }

  /*
   * Die TIEFENKARTE zwischen den Schlüsselbildern: aus dem letzten
   * Schlüsselbild DES ABSCHNITTS mit der Bewegung der KAMERA gezogen – eine
   * Entfernung klebt an der Szene, nicht an einem Gegenstand. Geglättet wird
   * sie nicht: Sie besteht überall aus Zwischenwerten, und über drei Bilder
   * gemittelt bekäme die Unschärfe an jeder Silhouette einen Hof.
   */
  abschnitte.forEach((abschnitt, nummer) => {
    for (const eintrag of tiefenJe(nummer)) {
      const folge = folgen[nummer].get(eintrag.teil.id) as (Uint8Array | undefined)[];
      for (let i = abschnitt.von; i <= abschnitt.bis; i += 1) {
        if (folge[i - abschnitt.von]) continue;
        const anker = Math.max(abschnitt.von, schluesselVor(schluessel, i));
        const vorlage = folge[anker - abschnitt.von];
        if (!vorlage) continue;
        const seitAnker = lageVerketten(lagen[i], lageKehren(lagen[anker]));
        folge[i - abschnitt.von] = maskeZiehen(vorlage, breite, hoehe, seitAnker, faktor);
      }
    }
  });

  const jeBild = bilder.map(() => new Map<string, NeueDaten>());
  abschnitte.forEach((abschnitt, nummer) => {
    for (const [id, folge] of folgen[nummer]) {
      for (let i = abschnitt.von; i <= abschnitt.bis; i += 1) {
        const werte = folge[i - abschnitt.von];
        if (werte) jeBild[i].set(id, { breite, hoehe, werte });
      }
    }
  });

  const irgendwas = abschnitte.some((abschnitt) => abschnitt.teile.length > 0);
  return {
    jeBild,
    laeufe: irgendwas ? gerechnetAn.size : 0,
    verworfen,
    lagen,
    faktor,
  };
}

/** Wie viele Schritte eine Spur insgesamt macht – für den Fortschritt. */
function zaehlen(spur: Spur): number {
  return spur.plan().length;
}

/** Die Stücke zwischen den Schnitten: erstes und letztes Bild, einschliesslich. */
function stueckGrenzen(
  anzahl: number,
  schnitte: ReadonlySet<number>,
): { von: number; bis: number }[] {
  const anfaenge = [0, ...[...schnitte].filter((s) => s > 0 && s < anzahl).sort((a, b) => a - b)];
  return anfaenge.map((von, i) => ({ von, bis: (anfaenge[i + 1] ?? anzahl) - 1 }));
}

/**
 * Die Abschnitte, über die gerechnet wird – nie über einen Schnitt hinweg.
 *
 * Ohne eigene Abschnitte ist jedes Stück einer, angesetzt an seinem Anfang:
 * Eingestellt wurde dann an genau einem Bild, und nach einem Schnitt beginnt
 * eine andere Szene, in der nur die ursprünglichen Koordinaten einen Sinn
 * haben können. Ein mitgegebener Abschnitt, der über einen Schnitt reicht,
 * wird dort geteilt; der Teil ohne den Anker setzt an seinem Anfang an.
 */
function abschnitteFuer(
  auftrag: TeileAuftrag,
  stuecke: readonly { von: number; bis: number }[],
  anzahl: number,
): TeileAbschnitt[] {
  if (!auftrag.abschnitte) {
    const teile = auftrag.teile ?? [];
    return stuecke.map((stueck) => ({ ...stueck, anker: stueck.von, teile }));
  }
  const raus: TeileAbschnitt[] = [];
  for (const abschnitt of auftrag.abschnitte) {
    const von = Math.max(0, abschnitt.von);
    const bis = Math.min(anzahl - 1, abschnitt.bis);
    if (bis < von) continue;
    for (const stueck of stuecke) {
      const a = Math.max(von, stueck.von);
      const b = Math.min(bis, stueck.bis);
      if (b < a) continue;
      const anker = abschnitt.anker >= a && abschnitt.anker <= b ? abschnitt.anker : a;
      raus.push({ von: a, bis: b, anker, teile: abschnitt.teile });
    }
  }
  return raus;
}

/** Ein einzelnes Teil für ein einzelnes Bild rechnen. */
export async function teilRechnen(
  eintrag: InhaltsTeil,
  bild: GelesenesBild,
  breite: number,
  hoehe: number,
  tiefe: { karteFuer(bild: ImageData): Promise<{ feld: Uint8Array }> } | null,
  abbruch: AbortSignal | undefined,
  /** Die angetippten Punkte an DIESEM Bild – schon mitgezogen, siehe `Spur`. */
  punkte: readonly Punkt[] | null,
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
    const gezogen = (punkte ?? teil.punkte).map((punkt) => ({
      x: Math.min(breite - 1, Math.max(0, Math.round(punkt.x))),
      y: Math.min(hoehe - 1, Math.max(0, Math.round(punkt.y))),
    }));
    try {
      const gerechnet = await tippTeilRechnen(bild.daten, gezogen, {
        modus: teil.modus,
        mitNetz: teil.mitNetz,
        toleranz: teil.toleranz,
        id: teil.id,
      });
      if (!gerechnet || gerechnet.art !== 'tipp') throw new Error('Der Tipp ergab keine Maske');
      return gerechnet.alpha;
    } catch (fehler) {
      /*
       * `NichtsGefunden` heisst: An dieser Stelle ist gerade nichts – das
       * angetippte Ding kann aus dem Bild gelaufen sein. Das darf den ganzen
       * Filmbau nicht abbrechen, sonst kostete ein Objekt, das für ein paar
       * Sekunden hinter etwas verschwindet, den kompletten Export. Eine leere
       * Maske ist die ehrliche Antwort; die Spur weiss damit umzugehen.
       * Jeder andere Fehler bleibt tödlich – ein abgeschaltetes oder
       * abgestürztes Verfahren fände beim nächsten Schlüsselbild ebenso
       * wenig.
       */
      if (fehler instanceof NichtsGefunden) return new Uint8Array(breite * hoehe);
      throw fehler;
    }
  }

  throw new Error(`Diese Maskenart wird je Bild nicht gerechnet: ${teil.art}`);
}

/** Das letzte Schlüsselbild bis einschliesslich `bis`. */
function schluesselVor(schluessel: ReadonlySet<number>, bis: number): number {
  for (let i = bis; i >= 0; i -= 1) if (schluessel.has(i)) return i;
  return 0;
}
