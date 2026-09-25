import { AbbruchError } from '../stickers/engines/index.js';
import { ausgabeGroesse, neuesDoc, wirksamerZuschnitt, type BildDoc } from '../bild/doc.js';
import { zeichneAusgabe } from '../bild/zeichnen.js';
import { quelleVeraendert } from '../bild/tonGpu.js';
import { videoLeserOeffnen, type GelesenesBild, type VideoLeser } from './bilderLesen.js';
import { filmSchrittMs, filmZeitpunkte, type Ausschnitt, type Stueck } from './ausschnitt.js';
import {
  docFuerBild,
  docMitLage,
  hatFormTeile,
  inhaltsTeile,
  type NeueDaten,
} from './bildweise.js';
import { folgeTeile } from './folgeTeile.js';
import { LAGE_RUHE, lageKehren, lageVerketten, type Lage } from './verfolgung.js';
import { haengtAmBild } from './schnitt.js';
import { SchreibAbbruch, videoSchreiben, videoTauglich } from './schreiben.js';
import { teileVerlegen } from './verlegen.js';

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

export type Bauschritt = 'lesen' | 'masken' | 'rechnen' | 'strom';

export const BAUSCHRITT_TITEL: Record<Bauschritt, string> = {
  lesen: 'Bilder holen',
  masken: 'Masken rechnen',
  rechnen: 'Video schreiben',
  // Ein eigener Name, weil dort beides zugleich passiert – ein Balken, der
  // zwischen „Bilder holen" und „Video schreiben" hin und her springt, sieht
  // aus wie ein Fehler.
  strom: 'Bilder holen und schreiben',
};

/**
 * Ein Stück des Films, wahlweise mit seiner EIGENEN Bearbeitung.
 *
 * So kommen die Abschnitte aus der Zeitleiste herein (`schnitt.ts`): Jeder
 * trägt sein Dokument und sein Stellbild. Ein Stück ohne Dokument bekommt
 * das des Auftrags.
 */
export interface FilmStueck extends Stueck {
  readonly doc?: BildDoc | null;
  /**
   * Das Bild, zu dem die Masken des Dokuments gehören – dort beginnt ihre
   * Verfolgung. Ohne Angabe: der Anfang des Stücks.
   */
  readonly standMs?: number;
}

export interface VideoBauAuftrag {
  readonly datei: Blob;
  /** Die Bearbeitung für jedes Stück, das keine eigene trägt – ohne Angabe: keine. */
  readonly doc?: BildDoc;
  /**
   * Die Stücke, aus denen der Film wird – in dieser Reihenfolge.
   *
   * Eine Liste und kein Bereich, weil „Schnittoptionen" genau das heisst:
   * ein Stück in der Mitte herausnehmen, die Reihenfolge tauschen, zwei
   * Ausschnitte hintereinanderhängen. Am Ende kommt trotzdem EINE Liste von
   * Zeitpunkten heraus, und die verarbeiten `bilderLesen` und
   * `videoSchreiben` schon heute.
   */
  readonly stuecke: readonly FilmStueck[];
  readonly bildrate: number;
  /** Die längere Kante, in der gerechnet und geschrieben wird. */
  readonly kante: number;
  /** Jedes wievielte Bild wirklich durch die Modelle geht. */
  readonly schluesselAbstand: number;
  /** Wie viele Bilder der Film höchstens hat – eine Grenze der Wartezeit. */
  readonly maxBilder: number;
  /**
   * Wie viele Bilder eine Gruppe mit Maske oder Form höchstens hat – aus
   * `maxBilderFuer(breite, hoehe)`.
   *
   * Deren Bilder liegen alle zugleich unkomprimiert im Speicher (siehe
   * `bauen`), und bei 1080p sind hundertfünfzig davon anderthalb Gigabyte.
   * Ohne Angabe gilt `maxBilder`.
   */
  readonly maxGepuffert?: number;
  readonly fortschritt?: (anteil: number, abschnitt: Bauschritt, text: string) => void;
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
    readonly abschnitt: Bauschritt,
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

  const plan = filmZeitpunkte(auftrag.stuecke, auftrag.bildrate, auftrag.maxBilder, {
    gruppeJeStueck: pufferGruppen(auftrag.stuecke, auftrag.doc),
    max: auftrag.maxGepuffert ?? auftrag.maxBilder,
  });
  let gruppen = gruppieren(plan, auftrag);
  try {
    gruppen = await stellbilderEinholen(gruppen, plan, auftrag, (text) =>
      auftrag.fortschritt?.(0, 'lesen', text),
    );
  } catch (ausfall) {
    if (ausfall instanceof AbbruchError) throw new VideoBauAbbruch('lesen', 0);
    throw ausfall;
  }
  return await bauen(auftrag, plan, gruppen);
}

/**
 * Je Stück: Werden seine Bilder gesammelt, und mit welchen zusammen?
 *
 * Gesammelt wird, wo eine Maske (Netz, Tiefe, Tipp) oder eine Form (Verlauf,
 * Ellipse, Pinsel) verfolgt werden muss – dafür braucht es alle Bilder der
 * Gruppe zugleich. Alles andere wird durchgereicht.
 *
 * Dieselbe Regel wie in `gruppieren`, nur VOR dem Abtasten: Die Oberfläche
 * und `filmZeitpunkte` brauchen sie, um die Speichergrenze je Gruppe zu
 * ziehen. Ein neues Stück beginnt eine neue Gruppe, wenn es ein anderes
 * Dokument trägt oder ein eigenes Stellbild hat.
 */
export function pufferGruppen(stuecke: readonly FilmStueck[], doc?: BildDoc): (number | null)[] {
  let gruppe = -1;
  return stuecke.map((stueck, nummer) => {
    const eigenes = stueck.doc ?? doc ?? null;
    const vorher = nummer > 0 ? (stuecke[nummer - 1].doc ?? doc ?? null) : undefined;
    if (nummer === 0 || stueck.standMs !== undefined || eigenes !== vorher) gruppe += 1;
    return eigenes && sammeln(eigenes) ? gruppe : null;
  });
}

/** Ob die Bilder unter diesem Dokument gesammelt werden müssen – siehe `pufferGruppen`. */
function sammeln(doc: BildDoc): boolean {
  return inhaltsTeile(doc).length > 0 || hatFormTeile(doc);
}

/* ---------- Welche Bilder zusammen eine Bearbeitung tragen ---------- */

/**
 * Eine Reihe aufeinanderfolgender Bilder mit DERSELBEN Bearbeitung und
 * demselben Stellbild.
 *
 * Meist genau ein Abschnitt. Mehrere nahtlose Stücke mit demselben Dokument
 * und ohne eigenes Stellbild bleiben eine Gruppe – so kommen sie von
 * Aufrufern, die nur Stücke kennen und ein Dokument für alle, und für die
 * soll eine nahtlose Grenze auch weiterhin nichts ändern: keine neu
 * angesetzte Maske, keine Form, die an ihren Ausgangspunkt zurückspringt.
 */
interface Gruppe {
  readonly von: number;
  readonly bis: number;
  /** Das Bild, zu dem die Masken gehören und von dem aus die Formen wandern. */
  readonly anker: number;
  readonly doc: BildDoc | null;
  readonly teile: ReturnType<typeof inhaltsTeile>;
  /** Das Stellbild, zu dem Masken und Formen des Dokuments gehören – falls angegeben. */
  readonly standMs?: number;
}

/** Ob die Bilder einer Gruppe gesammelt werden – siehe `pufferGruppen`. */
function gepuffert(gruppe: Gruppe): boolean {
  return gruppe.doc !== null && sammeln(gruppe.doc);
}

function gruppieren(plan: Ausschnitt, auftrag: VideoBauAuftrag): Gruppe[] {
  const gruppen: Gruppe[] = [];
  const schnitte = new Set(plan.schnitte);
  let von = 0;
  for (let i = 1; i <= plan.zeitpunkte.length; i += 1) {
    const vorher = auftrag.stuecke[plan.stueckJeBild[i - 1]];
    const jetzt = i < plan.zeitpunkte.length ? auftrag.stuecke[plan.stueckJeBild[i]] : undefined;
    const docVorher = vorher?.doc ?? auftrag.doc ?? null;
    const docJetzt = jetzt?.doc ?? auftrag.doc ?? null;
    const grenze =
      jetzt === undefined ||
      schnitte.has(i) ||
      (jetzt !== vorher && (docJetzt !== docVorher || jetzt.standMs !== undefined));
    if (!grenze) continue;
    const erstes = auftrag.stuecke[plan.stueckJeBild[von]];
    const standMs = erstes?.standMs;
    /*
     * Das nächste Bild zum Stellbild. Hat die Obergrenze den Abschnitt vor
     * seinem Stellbild abgeschnitten, ist das sein letztes – und dorthin
     * werden Masken und Formen vor dem Rechnen mitgenommen, siehe
     * `stellbilderEinholen`.
     */
    let anker = von;
    if (standMs !== undefined) {
      for (let k = von; k < i; k += 1) {
        if (Math.abs(plan.zeitpunkte[k] - standMs) < Math.abs(plan.zeitpunkte[anker] - standMs)) {
          anker = k;
        }
      }
    }
    const doc = erstes?.doc ?? auftrag.doc ?? null;
    gruppen.push({ von, bis: i - 1, anker, doc, teile: doc ? inhaltsTeile(doc) : [], standMs });
    von = i;
  }
  return gruppen;
}

/**
 * Masken und Formen an ein Bild holen, das im Film auch vorkommt.
 *
 * Hat die Obergrenze einen Abschnitt vor seinem Stellbild abgeschnitten,
 * wäre der Anker sonst einfach sein letztes Bild – und die Punkte eines
 * Tipps, gesetzt Sekunden später, fluteten dort den Hintergrund. So werden
 * sie vorher dorthin mitgenommen, wie beim Teilen (`verlegen.ts`).
 */
async function stellbilderEinholen(
  gruppen: readonly Gruppe[],
  plan: Ausschnitt,
  auftrag: VideoBauAuftrag,
  melden: (text: string) => void,
): Promise<Gruppe[]> {
  const raus: Gruppe[] = [];
  for (const gruppe of gruppen) {
    const standMs = gruppe.standMs;
    const ankerMs = plan.zeitpunkte[gruppe.anker];
    if (
      !gruppe.doc ||
      standMs === undefined ||
      !haengtAmBild(gruppe.doc) ||
      Math.abs(ankerMs - standMs) <= plan.schrittMs
    ) {
      raus.push(gruppe);
      continue;
    }
    melden('Masken werden an den gekürzten Film angepasst …');
    const doc = await teileVerlegen(auftrag.datei, gruppe.doc, {
      vonMs: standMs,
      nachMs: ankerMs,
      kante: auftrag.kante,
      schrittMs: plan.schrittMs,
      abbruch: auftrag.abbruch,
    });
    raus.push({ ...gruppe, doc, teile: inhaltsTeile(doc), standMs: ankerMs });
  }
  return raus;
}

function gruppenJeBild(gruppen: readonly Gruppe[], anzahl: number): number[] {
  const raus = new Array<number>(anzahl).fill(0);
  gruppen.forEach((gruppe, nummer) => {
    for (let i = gruppe.von; i <= gruppe.bis; i += 1) raus[i] = nummer;
  });
  return raus;
}

/**
 * Das Dokument jeder Gruppe – ein frisches, wo keines ist – und der Riegel
 * gegen eines, das zu einer anderen Bildgrösse gehört.
 *
 * Ein `BildDoc` steht in Punkten SEINES Quellbildes. Kommt es von einem
 * Standbild in 640 und wird hier in 192 gerechnet, meint sein Zuschnitt
 * eine Fläche, die es gar nicht gibt – `wirksamerZuschnitt` liefert dann
 * brav den alten Ausschnitt, und heraus kommt ein Film in einer Grösse, die
 * niemand gewählt hat. Ohne Fehler, ohne Warnung.
 *
 * Nachgemessen: Ein Dokument von 320 × 240 auf Bildern von 192 × 144 ergab
 * einen Film von 320 × 240. Die Oberfläche verhindert das, indem sie die
 * Grösse festhält, sobald etwas eingestellt ist – dieser Riegel ist der
 * zweite, für alle anderen Aufrufer.
 */
function fertigeDocs(gruppen: readonly Gruppe[], breite: number, hoehe: number): BildDoc[] {
  return gruppen.map((gruppe) => {
    const doc = gruppe.doc ?? neuesDoc(breite, hoehe);
    const z = doc.zuschnitt;
    if (z.x + z.w > breite + 1 || z.y + z.h > hoehe + 1) {
      throw new Error(
        `Diese Bearbeitung gehört zu einem Bild von mindestens ${z.x + z.w} × ${z.y + z.h}, ` +
          `gerechnet wird aber in ${breite} × ${hoehe}.`,
      );
    }
    return doc;
  });
}

/** Die Grösse des fertigen Films: die des ersten Bildes, genau wie `zeichneAusgabe` sie liefert. */
function filmMass(doc: BildDoc, breite: number, hoehe: number): { w: number; h: number } {
  const mass = ausgabeGroesse(wirksamerZuschnitt(doc, breite, hoehe), doc.drehung);
  return { w: mass.w, h: mass.h };
}

/**
 * Ein Bild in die Filmgrösse einpassen.
 *
 * Ein Film hat EINE Grösse, seine Abschnitte nicht unbedingt: Der eine ist
 * hochkant zugeschnitten, der andere quer. Eingepasst wird ganz, mit
 * schwarzem Rand – abgeschnitten wäre ein Teil dessen, was jemand mit
 * Absicht im Bild gelassen hat.
 */
function einpasser(film: { w: number; h: number }): (bild: HTMLCanvasElement) => HTMLCanvasElement {
  let flaeche: HTMLCanvasElement | null = null;
  return (bild) => {
    if (bild.width === film.w && bild.height === film.h) return bild;
    if (!flaeche) {
      flaeche = document.createElement('canvas');
      flaeche.width = film.w;
      flaeche.height = film.h;
    }
    const stift = flaeche.getContext('2d');
    if (!stift) return bild;
    const faktor = Math.min(film.w / bild.width, film.h / bild.height);
    const w = Math.round(bild.width * faktor);
    const h = Math.round(bild.height * faktor);
    stift.fillStyle = '#000';
    stift.fillRect(0, 0, film.w, film.h);
    stift.imageSmoothingQuality = 'high';
    stift.drawImage(bild, Math.round((film.w - w) / 2), Math.round((film.h - h) / 2), w, h);
    return flaeche;
  };
}

/* ---------- Lesen, rechnen, schreiben ---------- */

/**
 * Bild für Bild lesen, zeichnen und kodieren – und nur dort sammeln, wo es
 * sein muss.
 *
 * # Warum das überhaupt geht
 *
 * Weil `videoSchreiben` seine Bilder über eine FUNKTION holt und sie streng
 * aufsteigend abruft, und weil `videoLeserOeffnen` beliebig springt. Ohne
 * Inhalts- und Formteile hängt kein Bild von einem anderen ab: Jedes bekommt
 * die Bearbeitung seines Abschnitts, und es liegt immer genau eines im
 * Speicher. Die Grenze ist dort die Wartezeit – gemessen rund 90 ms je Bild.
 *
 * # Wo doch gesammelt wird
 *
 * In einer Gruppe mit Maske oder Form. Deren Bilder werden beim ersten
 * gebraucht komplett gelesen, die Masken durch alle verfolgt
 * (`folgeTeile`), und danach wird Bild für Bild daraus geschrieben. Nach
 * dem letzten Bild der Gruppe ist der Speicher wieder frei.
 *
 * Früher entschied EIN Abschnitt mit Maske über den ganzen Film: Alle Bilder
 * aller Abschnitte lagen zugleich im Speicher, und die Grenze dafür – 150
 * Bilder bei 960 Punkten – galt für den ganzen Film. Wer in einem von drei
 * Abschnitten freistellte, verlor den dritten. Die Verfolgung geht ohnehin
 * nie über eine Gruppe hinaus: Jede hat ihren eigenen Anker.
 */
async function bauen(
  auftrag: VideoBauAuftrag,
  plan: Ausschnitt,
  gruppen: readonly Gruppe[],
): Promise<VideoBauErgebnis> {
  const punkte = plan.zeitpunkte;
  const anzahl = punkte.length;
  let leser: VideoLeser;
  try {
    leser = await videoLeserOeffnen(auftrag.datei, {
      kante: auftrag.kante,
      // Der Abstand zum Videoende darf kleiner sein als ein Bild – sonst
      // fällt das Filmende bei hohen Bildraten auf ein Standbild zusammen.
      randMs: plan.schrittMs / 2,
      abbruch: auftrag.abbruch,
    });
  } catch (ausfall) {
    if (ausfall instanceof AbbruchError) throw new VideoBauAbbruch('lesen', 0);
    throw ausfall;
  }
  try {
    const breite = leser.breite;
    const hoehe = leser.hoehe;
    /*
     * Die Leinwand, auf der das Quellbild landet, wird EINMAL angelegt.
     *
     * `zeichneAusgabe` verlangt eine `CanvasImageSource` – ein `ImageData`
     * ist keine. Je Bild eine neue Leinwand wären hundertfünfzig Leinwände,
     * die der Einsammler wegräumen muss, und auf einem Telefon ist
     * Grafikspeicher genau das, was dabei ausgeht.
     */
    const quelle = document.createElement('canvas');
    quelle.width = breite;
    quelle.height = hoehe;
    const stift = quelle.getContext('2d');
    if (!stift) throw new Error('Diese Ansicht kann keine Bilder zeichnen');

    const docs = fertigeDocs(gruppen, breite, hoehe);
    const film = filmMass(docs[0], breite, hoehe);
    const einpassen = einpasser(film);
    const gruppeJeBild = gruppenJeBild(gruppen, anzahl);
    const stand = fortschrittRechner(auftrag, gruppen, anzahl);

    let puffer: Puffer | null = null;
    let laeufe = 0;
    /** Woran gerade gearbeitet wird – für die Meldung eines Abbruchs. */
    let schritt: Bauschritt = 'strom';

    let blob: Blob;
    try {
      blob = await videoSchreiben(
        anzahl,
        async (nummer) => {
          if (auftrag.abbruch?.aborted) throw new AbbruchError();
          const g = gruppeJeBild[nummer];
          const gruppe = gruppen[g];
          let daten: ImageData;
          let doc = docs[g];
          if (gepuffert(gruppe)) {
            if (puffer?.gruppe !== g) {
              // Der vorige wird nicht mehr gebraucht – erst loslassen, dann lesen.
              puffer = null;
              schritt = 'lesen';
              puffer = await gruppeSammeln(auftrag, plan, gruppe, g, leser, stand, (s) => {
                schritt = s;
              });
              laeufe += puffer.laeufe;
            }
            schritt = 'rechnen';
            const i = nummer - gruppe.von;
            daten = puffer.bilder[i].daten;
            /*
             * Die Formen wandern mit der Kamera – gerechnet vom STELLBILD
             * aus, nicht vom Anfang der Gruppe: Dort wurden sie gezeichnet,
             * und dort liegen sie richtig.
             */
            const seitAnker = lageVerketten(
              puffer.lagen[i],
              lageKehren(puffer.lagen[gruppe.anker - gruppe.von]),
            );
            doc = docFuerBild(docMitLage(doc, seitAnker, puffer.faktor), puffer.jeBild[i]);
          } else {
            schritt = 'strom';
            daten = await leser.bildAn(punkte[nummer], auftrag.abbruch);
            stand.gelesen();
          }
          stift.putImageData(daten, 0, 0);
          quelleVeraendert(quelle);
          const bild = einpassen(zeichneAusgabe(quelle, breite, hoehe, doc));
          if (nummer === gruppe.bis) puffer = null;
          stand.geschrieben(schritt, `Bild ${nummer + 1} von ${anzahl}`);
          return bild;
        },
        {
          breite: film.w,
          hoehe: film.h,
          bildrate: auftrag.bildrate,
          schluesselBei: new Set(plan.schnitte),
          abbruch: auftrag.abbruch,
        },
      );
    } catch (ausfall) {
      // Wie weit der Kodierer gekommen ist, weiss nur er selbst – siehe
      // `SchreibAbbruch`. Die volle Bilderzahl zu melden hiesse, hinterher
      // denselben Auftrag noch einmal von null anzubieten.
      if (ausfall instanceof SchreibAbbruch) throw new VideoBauAbbruch(schritt, ausfall.fertig);
      if (ausfall instanceof AbbruchError) throw new VideoBauAbbruch(schritt, 0);
      throw ausfall;
    }

    return {
      blob,
      bilder: anzahl,
      breite: film.w,
      hoehe: film.h,
      laufzeitMs: Math.round(anzahl * filmSchrittMs(auftrag.bildrate)),
      laeufe,
    };
  } finally {
    leser.schliessen();
  }
}

/** Die gesammelten Bilder EINER Gruppe samt allem, was an ihnen gerechnet wurde. */
interface Puffer {
  readonly gruppe: number;
  readonly bilder: readonly GelesenesBild[];
  readonly jeBild: readonly ReadonlyMap<string, NeueDaten>[];
  /** Je Bild die Lage der Kamera gegenüber dem ersten der Gruppe. */
  readonly lagen: readonly Lage[];
  readonly faktor: number;
  readonly laeufe: number;
}

async function gruppeSammeln(
  auftrag: VideoBauAuftrag,
  plan: Ausschnitt,
  gruppe: Gruppe,
  nummer: number,
  leser: VideoLeser,
  stand: FortschrittRechner,
  schrittMelden: (schritt: Bauschritt) => void,
): Promise<Puffer> {
  const zahl = gruppe.bis - gruppe.von + 1;
  const bilder: GelesenesBild[] = [];
  for (let i = 0; i < zahl; i += 1) {
    if (auftrag.abbruch?.aborted) throw new AbbruchError();
    const zeitMs = plan.zeitpunkte[gruppe.von + i];
    bilder.push({ zeitMs, daten: await leser.bildAn(zeitMs, auftrag.abbruch) });
    stand.gelesen();
    stand.melden('lesen', `Bild ${i + 1} von ${zahl} für die Masken`);
  }
  schrittMelden('masken');
  const gerechnet = await folgeTeile(bilder, {
    abschnitte: [{ von: 0, bis: zahl - 1, anker: gruppe.anker - gruppe.von, teile: gruppe.teile }],
    schluesselAbstand: auftrag.schluesselAbstand,
    fortschritt: (anteil, text) => stand.masken(nummer, anteil, text),
    abbruch: auftrag.abbruch,
  });
  stand.masken(nummer, 1, 'Masken fertig');
  return {
    gruppe: nummer,
    bilder,
    jeBild: gerechnet.jeBild,
    lagen: gerechnet.lagen.length === zahl ? gerechnet.lagen : bilder.map(() => LAGE_RUHE),
    faktor: gerechnet.faktor,
    laeufe: gerechnet.laeufe,
  };
}

/*
 * Was die Arbeit kostet – für einen Balken, der gleichmässig läuft.
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
 *
 * Die Masken zählen nur dort, wo ein Modell läuft. Eine Gruppe mit nur
 * Formteilen schätzt die Bewegung und sonst nichts; mit Modellgewicht bekäme
 * sie den halben Balken für drei Prozent der Arbeit, und der Balken kröche
 * erst und schösse dann durch.
 */
const JE_BILD_LESEN = 75;
const JE_BILD_RECHNEN = 15;
const JE_LAUF_MASKE = 2000;
const JE_BILD_SCHIEBEN = 10;

interface FortschrittRechner {
  gelesen(): void;
  geschrieben(schritt: Bauschritt, text: string): void;
  masken(gruppe: number, anteil: number, text: string): void;
  melden(schritt: Bauschritt, text: string): void;
}

function fortschrittRechner(
  auftrag: VideoBauAuftrag,
  gruppen: readonly Gruppe[],
  anzahl: number,
): FortschrittRechner {
  const maskenKosten = gruppen.map((gruppe) => {
    if (!gepuffert(gruppe) || gruppe.teile.length === 0) return 0;
    const bilder = gruppe.bis - gruppe.von + 1;
    const laeufe = Math.min(bilder, Math.ceil(bilder / Math.max(1, auftrag.schluesselAbstand)) + 2);
    return laeufe * JE_LAUF_MASKE + (bilder - laeufe) * JE_BILD_SCHIEBEN;
  });
  const summe = Math.max(
    1,
    anzahl * (JE_BILD_LESEN + JE_BILD_RECHNEN) + maskenKosten.reduce((a, b) => a + b, 0),
  );
  let fertig = 0;
  /** Welche Gruppe gerade ihre Masken rechnet, und wo der Balken dabei anfing. */
  let maskenGruppe = -1;
  let maskenAb = 0;
  const melden = (schritt: Bauschritt, text: string) =>
    auftrag.fortschritt?.(Math.min(1, fertig / summe), schritt, text);
  return {
    gelesen() {
      fertig += JE_BILD_LESEN;
    },
    geschrieben(schritt, text) {
      fertig += JE_BILD_RECHNEN;
      melden(schritt, text);
    },
    masken(gruppe, anteil, text) {
      if (gruppe !== maskenGruppe) {
        maskenGruppe = gruppe;
        maskenAb = fertig;
      }
      const jetzt = maskenAb + Math.max(0, Math.min(1, anteil)) * (maskenKosten[gruppe] ?? 0);
      fertig = Math.max(fertig, jetzt);
      melden('masken', text);
    },
    melden,
  };
}
