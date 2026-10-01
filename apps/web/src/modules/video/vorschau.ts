import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type RefObject,
} from 'react';

import { docUnberuehrt, type BildDoc } from '../bild/doc.js';
import { quelleVeraendert } from '../bild/tonGpu.js';
import { zeichneAnsicht, zeichneAusgabe } from '../bild/zeichnen.js';
import type { Filmbild } from './raster.js';
import {
  naechstesBild,
  wischToleranz,
  type WischBild,
  type Wischspeicher,
} from './wischspeicher.js';
import {
  gueteBeimWischen,
  gueteErholt,
  leinwandVeraltet,
  notstufeNoetig,
  videobildDarf,
  type Guete,
  type Treffer,
} from './wischweg.js';

export type { Guete } from './wischweg.js';

/**
 * Die Vorschau eines Films MIT Bearbeitung – beim Wischen und beim Abspielen.
 *
 * # Warum es das braucht
 *
 * Bis hierher lag beim Abspielen und Wischen das rohe Video über dem
 * Standbild, mit dem Satz „Wiedergabe ohne Bearbeitung". Wer einen Film
 * wärmer stellt und dann durchwischt, sah ihn kalt – und wusste erst nach dem
 * Filmbau, ob es gefiel. Jetzt wird jedes Bild, das das Video anzeigt, durch
 * dieselbe Zeichnung geschickt wie das Standbild im Editor und der fertige
 * Film.
 *
 * # Zwei Quellen für dieselbe Leinwand
 *
 * 1. Das VIDEO: Es springt (siehe `springenZu`) und spielt wie bisher, und
 *    diese Datei hängt sich an die Bilder, die es wirklich anzeigt.
 *    `requestVideoFrameCallback` meldet jedes davon samt seiner Zeit im Film
 *    – so passt die Bearbeitung zu genau dem Bild, das gezeigt wird. Wo es
 *    das nicht gibt, zeichnet ein Bild nach `seeked` bzw. im Takt der Anzeige.
 * 2. Der WISCHSPEICHER (`wischspeicher.ts`): beim Wischen kommen die Bilder
 *    aus kleinen, komprimierten Bildern des ganzen Films, nicht aus
 *    Sprüngen. `zeigeBild` (über `Wischer`) sucht das Bild unter dem Finger
 *    oder eines nahe daneben, und gezeichnet wird je Anzeigetakt EINMAL das
 *    neueste Ziel – mit Bearbeitung UND Masken, mit derselben Zeichnung wie
 *    sonst.
 *
 * # Warum der `readyState`-Wächter nicht gelockert werden darf
 *
 * `zeichnen` bricht bei `readyState < 2` ab. Gemessen (Messung vorher,
 * Befund 1 und 7): Die Sprungkette setzt im `seeked`-Rückruf sofort den
 * nächsten Sprung; bis der Bildrückruf einen bis zwei Anzeigetakte später
 * läuft, steht das Video wieder im Sprung – an allen 275 Bildrückrufen der
 * Messzüge war `readyState` 1. Darum zeichnete die Vorschau beim Wischen
 * 0,0-mal je Sekunde. Den Wächter zu lockern hilft nicht: `drawImage` eines
 * Videos im Sprung liefert das Bild VOR dem Sprung – in 38 – 66 % der Takte
 * stimmte die Leinwand nicht mit dem gemeldeten Bild überein, also ein altes
 * Bild mit der Maske des neuen. Der Weg beim Wischen führt deshalb am Video
 * vorbei, durch den Speicher.
 *
 * # Wann welche Quelle zeichnet
 *
 * - Wischen, der Speicher hat ein Bild in der Nähe: Speicher. Das Video
 *   springt nicht mehr (`filmWiedergabe.ts`), solange er deckt.
 * - Wischen, der Speicher hat nichts in der Nähe (noch nicht gefüllt): wie
 *   bisher das Video. Damit ein Bild, das nicht mehr zum Finger gehört, nie
 *   stehenbleibt, wird die Leinwand dann verborgen, und das rohe Video zeigt,
 *   was es hat (`leinwandVeraltet`).
 * - Finger ruht (100 ms): das Video springt auf das genaue Bild und schärft
 *   nach; das scharfe Bild erscheint, wenn es ankommt und das Ziel noch
 *   dasselbe ist (`videobildDarf`: nur Bilder, die dem Finger näher liegen
 *   als das gezeigte).
 * - Abspielen und angehalten: das Video.
 *
 * Gezeichnet wird nur das jeweils NEUESTE Bild; die Sprungkette wartet nie
 * auf das Zeichnen. Sonst bestimmte die Zeichendauer, wie schnell das Video
 * dem Finger folgt.
 *
 * # Wenn das Gerät zu langsam ist
 *
 * Eine Stufenleiter: zuerst kleiner zeichnen, und wenn auch das beim
 * Abspielen nicht mithält, das rohe Video zeigen – mit einem Satz, der das
 * sagt. Beim Wischen kommt als letzte Stufe die Notstufe (`notstufeNoetig`):
 * Das rohe Speicherbild ohne Bearbeitung, bis der Finger ruht – ein Bild,
 * das flüssig läuft, wiegt dort schwerer als eines mit Bearbeitung, das
 * ruckelt.
 */

/** Was für ein Bild der Vorschau zu zeichnen ist: die Bearbeitung, und zu welchem Bild sie gehört. */
export interface VorschauBild {
  /** Die Bearbeitung – `null` heisst: keine, dann bleibt das rohe Video sichtbar. */
  readonly doc: BildDoc | null;
  /** Der Abschnitt, in dem das Bild liegt. */
  readonly nummer: number;
  /** Das Rasterbild der Quelle. */
  readonly k: number;
  /** Die Masken (Kennungen), die an diesem Bild noch fehlen. */
  readonly fehlend: readonly string[];
}

/**
 * Was die Vorschau dem Wischen anbietet – gesetzt in `VorschauAuftrag.wischer`,
 * gerufen von `filmWiedergabe.ts`. Die beiden Haken hängen an verschiedenen
 * Bäumen von Zuständen und kennen einander nicht; über diese Referenz
 * sprechen sie.
 */
export interface Wischer {
  /**
   * Das Filmbild `i` (oder eines nahe daneben) aus dem Speicher zeigen.
   * `fertig`: der Finger ist losgelassen – das Bild kommt dann in voller
   * Güte, auch aus der Notstufe.
   */
  zeigeBild(i: number, fertig: boolean): Treffer;
  /** Der Finger ruht: In der Notstufe kommt jetzt die Bearbeitung. */
  ruhe(): void;
  /** Es gibt kein Ziel mehr (springen, abspielen). */
  zielVergessen(): void;
  /** Der Index des Filmbildes in Abschnitt `nummer` am Rasterbild `k` – oder `null`. */
  indexVon(nummer: number, k: number): number | null;
}

export interface VorschauAuftrag {
  readonly video: RefObject<HTMLVideoElement | null>;
  readonly leinwand: RefObject<HTMLCanvasElement | null>;
  /**
   * Die Bearbeitung für das Bild bei dieser Quellzeit – mit dem Abschnitt und
   * Rasterbild, zu denen sie gehört. `doc: null` heisst: keine, dann bleibt
   * das rohe Video sichtbar.
   *
   * Über eine Referenz gelesen, nicht über die Abhängigkeiten: Sie ändert sich
   * mit jedem Reglerschritt, und die Rückrufe am Video sollen deshalb nicht
   * jedes Mal neu angemeldet werden.
   */
  readonly docFuer: (quelleMs: number) => VorschauBild;
  /** Dasselbe für ein Bild aus dem Speicher: Abschnitt und Rasterbild stehen schon fest. */
  readonly docFuerBild?: (nummer: number, k: number) => VorschauBild;
  /** Die Rechengrösse – darin stehen alle Koordinaten eines Dokuments. */
  readonly mass: { readonly b: number; readonly h: number } | null;
  /**
   * 'ansicht': wie der Editor bei Zoom 1 – ganzes gedrehtes Bild, der
   * Zuschnitt nicht angewandt. 'ausgabe': wie der fertige Film, mit
   * Zuschnitt und in die Filmgrösse eingepasst.
   */
  readonly art: 'ansicht' | 'ausgabe';
  /** Gilt nur für 'ausgabe': die Grösse des fertigen Films (`filmMass`). */
  readonly film?: { readonly w: number; readonly h: number } | null;
  /** Ist die Vorschau gerade zu sehen? Sonst wird nichts gezeichnet. */
  readonly aktiv: boolean;
  /** Der Bildabstand des Films – der Massstab für „hält mit". */
  readonly schrittMs: number;
  /**
   * Eine Zahl, die sich ändert, wenn das aktuelle Bild neu gezeichnet werden
   * muss, ohne dass das Video etwas tut – etwa nach einem Reglerschritt.
   */
  readonly neuZeichnen?: unknown;
  /** Die kleinen Bilder des Films – ohne sie wischt es wie bisher über das Video. */
  readonly speicher?: Wischspeicher | null;
  /** Alle Bilder des Films in Filmreihenfolge (`filmRaster(…).bilder`). */
  readonly filmBilder?: readonly Filmbild[];
  /** Hier trägt die Vorschau ein, was sie dem Wischen anbietet. */
  readonly wischer?: MutableRefObject<Wischer | null>;
}

export interface VorschauStand {
  /** Liegt gerade ein bearbeitetes Bild über dem Video? */
  readonly bearbeitet: boolean;
  readonly guete: Guete;
  /**
   * Das Gerät ist zum Wischen mit Bearbeitung zu langsam: Beim Zug kommt das
   * rohe Bild, die Bearbeitung erscheint, sobald der Finger ruht.
   */
  readonly notstufe: boolean;
  /** Die Masken (Kennungen), die am gezeigten Bild noch fehlen. */
  readonly fehlend: readonly string[];
}

interface Pruefhaken {
  gezeichnet: number;
  guete: Guete;
  /** Für Tests: jede Zeichnung gilt als zu langsam. */
  erzwingeLangsam: boolean;
  /** Die Filmzeit (Quelle) des zuletzt gezeichneten Bildes – bei einem Speicherbild der Anfang seines Rasterbildes. */
  letzteMs: number;
  /** Woher das zuletzt gezeichnete Bild kam. */
  aus: 'video' | 'speicher' | 'keins';
  /** Das Rasterbild des zuletzt gezeichneten Bildes. */
  letzteK: number;
  /** Das Rasterbild unter dem Finger bei dieser Zeichnung (-1: kein Zug). */
  zielK: number;
  /** Wie viele Zeichnungen aus dem Speicher kamen. */
  speicherGezeichnet: number;
  /** Mittel der letzten acht Zeichnungen in ms. */
  zeichenMs: number;
  /** Wie viele Masken im Dokument der letzten Zeichnung standen. */
  bereiche: number;
  /** Die Masken, die an der letzten Zeichnung fehlten. */
  fehlend: string[];
  /** Für Tests: nie auf „roh beim Wischen" zurückfallen. */
  ohneNotstufe: boolean;
  /** Ist die Notstufe gerade an? */
  notstufe: boolean;
}

function pruefhaken(): Pruefhaken {
  const fenster = window as unknown as { __vorschau?: Partial<Pruefhaken> };
  const haken = (fenster.__vorschau ??= {});
  // Ein Test kann Felder VOR dem ersten Zeichnen setzen (`ohneNotstufe`): nur Fehlendes ergänzen.
  haken.gezeichnet ??= 0;
  haken.guete ??= 0;
  haken.erzwingeLangsam ??= false;
  haken.letzteMs ??= -1;
  haken.aus ??= 'keins';
  haken.letzteK ??= -1;
  haken.zielK ??= -1;
  haken.speicherGezeichnet ??= 0;
  haken.zeichenMs ??= 0;
  haken.bereiche ??= 0;
  haken.fehlend ??= [];
  haken.ohneNotstufe ??= false;
  haken.notstufe ??= false;
  return haken as Pruefhaken;
}

/** So viele Zeichnungen werden für die Stufenleiter betrachtet. */
const FENSTER = 16;
const KEINE_IDS: readonly string[] = [];
const KEINE_BILDER: readonly Filmbild[] = [];

type MitRvfc = HTMLVideoElement & {
  requestVideoFrameCallback?: (
    rueckruf: (jetzt: number, meta: { mediaTime: number }) => void,
  ) => number;
  cancelVideoFrameCallback?: (nummer: number) => void;
};

/** Ein Bild aus dem Speicher, das gezeichnet werden soll. */
interface Wunsch {
  /** Der Index des Filmbildes, dessen Rasterbild der Speicher hat. */
  readonly index: number;
  readonly nummer: number;
  readonly k: number;
  /** Ohne Bearbeitung zeichnen (Notstufe)? */
  readonly roh: boolean;
}

export function useBearbeiteteVorschau(auftrag: VorschauAuftrag): VorschauStand {
  const { video, leinwand, mass, art, film, aktiv, schrittMs, neuZeichnen, wischer } = auftrag;
  const docFuer = useRef(auftrag.docFuer);
  docFuer.current = auftrag.docFuer;
  const docFuerBild = useRef(auftrag.docFuerBild);
  docFuerBild.current = auftrag.docFuerBild;
  const speicher = useRef(auftrag.speicher ?? null);
  speicher.current = auftrag.speicher ?? null;
  const filmBilder = auftrag.filmBilder ?? KEINE_BILDER;
  const filmBilderRef = useRef(filmBilder);
  filmBilderRef.current = filmBilder;
  const aktivRef = useRef(aktiv);
  aktivRef.current = aktiv;
  const schrittRef = useRef(schrittMs);
  schrittRef.current = schrittMs;
  /** Abschnitt und Rasterbild → Index des Filmbildes: Wohin gehört ein Bild aus dem Video? */
  const indexVonBild = useMemo(() => {
    const karte = new Map<string, number>();
    filmBilder.forEach((bild, i) => karte.set(`${bild.nummer}:${bild.k}`, i));
    return karte;
  }, [filmBilder]);
  const indexRef = useRef(indexVonBild);
  indexRef.current = indexVonBild;

  const [bearbeitet, setBearbeitet] = useState(false);
  const [guete, setGueteRoh] = useState<Guete>(0);
  const gueteRef = useRef<Guete>(0);
  const setGuete = useCallback((neu: Guete) => {
    if (gueteRef.current === neu) return;
    gueteRef.current = neu;
    pruefhaken().guete = neu;
    setGueteRoh(neu);
  }, []);
  const bearbeitetRef = useRef(false);
  const zeigen = useCallback((ja: boolean) => {
    if (bearbeitetRef.current === ja) return;
    bearbeitetRef.current = ja;
    setBearbeitet(ja);
  }, []);
  const [notstufe, setNotstufeRoh] = useState(false);
  const notstufeRef = useRef(false);
  const setNotstufe = useCallback((an: boolean) => {
    if (notstufeRef.current === an) return;
    notstufeRef.current = an;
    pruefhaken().notstufe = an;
    setNotstufeRoh(an);
  }, []);
  const [fehlend, setFehlendRoh] = useState<readonly string[]>(KEINE_IDS);
  const fehlendRef = useRef<readonly string[]>(KEINE_IDS);
  const fehlendSetzen = useCallback((neu: readonly string[]) => {
    const alt = fehlendRef.current;
    if (alt.length === neu.length && alt.every((id, i) => id === neu[i])) return;
    fehlendRef.current = neu.length === 0 ? KEINE_IDS : neu;
    setFehlendRoh(fehlendRef.current);
  }, []);

  /** Die Leinwand in Rechengrösse, auf die jedes Bild zuerst kommt. */
  const quelle = useRef<{ flaeche: HTMLCanvasElement; stift: CanvasRenderingContext2D } | null>(
    null,
  );
  const dauern = useRef<number[]>([]);
  const gutSeit = useRef<number | null>(null);
  /** Die letzten Zeichenzeiten, für `zeichenMs` und die Stufen beim Wischen. */
  const wischDauern = useRef<number[]>([]);
  const alleDauern = useRef<number[]>([]);

  /** Der Zustand des Wischens – nur über Referenzen, damit der Zug nie rendert. */
  const wisch = useRef({
    /** Das Filmbild unter dem Finger – `null` ohne Zug. */
    ziel: null as number | null,
    /** Das Filmbild, das auf der Leinwand steht – `null`, wenn keines zuzuordnen ist. */
    gezeigt: null as number | null,
    wunsch: null as Wunsch | null,
    /** Der zuletzt aus dem Speicher gezeichnete Wunsch – für `neuZeichnen`. */
    gezeichnet: null as Wunsch | null,
    rahmen: 0,
    laeuft: false,
    /** Woher das Bild auf der Leinwand zuletzt kam. */
    zuletzt: null as 'video' | 'speicher' | null,
  });

  const quelleFuer = useCallback((): NonNullable<typeof quelle.current> | null => {
    if (!mass) return null;
    let q = quelle.current;
    if (!q || q.flaeche.width !== mass.b || q.flaeche.height !== mass.h) {
      const flaeche = document.createElement('canvas');
      flaeche.width = mass.b;
      flaeche.height = mass.h;
      const stift = flaeche.getContext('2d');
      if (!stift) return null;
      // Ein kleines Speicherbild wird hochgerechnet: weich, nicht blockig.
      stift.imageSmoothingQuality = 'high';
      q = { flaeche, stift };
      quelle.current = q;
    }
    return q;
  }, [mass]);

  /** Die Zeichenkante der Ansicht: wie gross die Leinwand auf dem Schirm ist, mal Pixeldichte. */
  const ansichtKante = useCallback((ziel: HTMLCanvasElement) => {
    const breite = ziel.clientWidth || 640;
    const dichte = window.devicePixelRatio || 1;
    const kante = Math.max(512, Math.min(1400, Math.round(breite * dichte)));
    return gueteRef.current >= 1 ? Math.round(kante * 0.6) : kante;
  }, []);

  /** Das Bild in `q.flaeche` mit der Bearbeitung in die Leinwand zeichnen. */
  const mitBearbeitung = useCallback(
    (q: NonNullable<typeof quelle.current>, doc: BildDoc, ziel: HTMLCanvasElement) => {
      if (!mass) return;
      quelleVeraendert(q.flaeche);
      if (art === 'ansicht') {
        zeichneAnsicht(ziel, q.flaeche, mass.b, mass.h, doc, {
          maxKante: ansichtKante(ziel),
          zuschnittZeigen: false,
          fluechtig: true,
        });
      } else {
        const fertig = zeichneAusgabe(q.flaeche, mass.b, mass.h, doc, {
          ziel: arbeitsLeinwand(),
          fluechtig: true,
        });
        einpassen(ziel, fertig, film ?? { w: fertig.width, h: fertig.height });
      }
    },
    [ansichtKante, art, film, mass],
  );

  /** Das Bild in `q.flaeche` unbearbeitet in die Leinwand – für die Notstufe und unbearbeitete Filme. */
  const ohneBearbeitung = useCallback(
    (q: NonNullable<typeof quelle.current>, ziel: HTMLCanvasElement) => {
      if (!mass) return;
      if (art === 'ansicht') {
        const basis = Math.min(1, ansichtKante(ziel) / Math.max(mass.b, mass.h));
        const breite = Math.max(1, Math.round(mass.b * basis));
        const hoehe = Math.max(1, Math.round(mass.h * basis));
        if (ziel.width !== breite) ziel.width = breite;
        if (ziel.height !== hoehe) ziel.height = hoehe;
        const stift = ziel.getContext('2d');
        if (!stift) return;
        stift.setTransform(1, 0, 0, 1, 0, 0);
        stift.imageSmoothingQuality = 'high';
        stift.drawImage(q.flaeche, 0, 0, breite, hoehe);
      } else {
        einpassen(ziel, q.flaeche, film ?? { w: q.flaeche.width, h: q.flaeche.height });
      }
    },
    [ansichtKante, art, film, mass],
  );

  /** Die Zeichenzeit festhalten – für den Prüfhaken und die Stufen. */
  const dauerMerken = (haken: Pruefhaken, dauer: number) => {
    const liste = alleDauern.current;
    liste.push(dauer);
    if (liste.length > 8) liste.shift();
    haken.zeichenMs = liste.reduce((summe, d) => summe + d, 0) / liste.length;
  };

  const zeichnen = useCallback(
    (quelleMs: number) => {
      const element = video.current;
      const ziel = leinwand.current;
      if (!element || !ziel || !mass || element.readyState < 2) return;
      const spielt = !element.paused && !element.ended;
      const w = wisch.current;
      // Das Abspielen beendet den Zug.
      if (spielt) w.ziel = null;
      const vb = docFuer.current(quelleMs);
      const j = indexRef.current.get(`${vb.nummer}:${vb.k}`) ?? null;
      // Ein Bild, das weiter vom Finger liegt als das gezeigte, kommt zu spät – siehe `videobildDarf`.
      if (!videobildDarf(j, w.ziel, w.gezeigt, wischToleranz(schrittRef.current))) return;
      // Das scharfe Bild des Ziels ist da – das Ziel ist erreicht.
      if (j !== null && j === w.ziel) w.ziel = null;
      w.gezeigt = j;
      w.zuletzt = 'video';
      fehlendSetzen(vb.fehlend);
      const doc = vb.doc;
      if (!doc || docUnberuehrt(doc, mass.b, mass.h) || (spielt && gueteRef.current === 2)) {
        zeigen(false);
        return;
      }
      const q = quelleFuer();
      if (!q) return;
      const anfang = performance.now();
      q.stift.drawImage(element, 0, 0, mass.b, mass.h);
      mitBearbeitung(q, doc, ziel);
      const haken = pruefhaken();
      const dauer = haken.erzwingeLangsam ? 1000 : performance.now() - anfang;
      haken.gezeichnet += 1;
      haken.letzteMs = quelleMs;
      haken.aus = 'video';
      haken.letzteK = vb.k;
      haken.zielK = w.ziel === null ? -1 : (filmBilderRef.current[w.ziel]?.k ?? -1);
      haken.bereiche = doc.bereiche.length;
      haken.fehlend = [...vb.fehlend];
      dauerMerken(haken, dauer);
      zeigen(true);
      stufen(dauer, spielt);
    },
    // `stufen` ist unten definiert und stabil; `docFuer` läuft über die Referenz.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fehlendSetzen, leinwand, mass, mitBearbeitung, quelleFuer, video, zeigen],
  );

  /**
   * Die Stufenleiter – siehe oben. Beim Abspielen zählt der Anteil zu
   * langsamer Bilder, beim Wischen schon ein einzelnes sehr langsames.
   */
  const stufen = (dauer: number, spielt: boolean) => {
    const takt = Math.max(16, schrittMs);
    if (!spielt) {
      wischStufen(dauer);
      return;
    }
    const liste = dauern.current;
    liste.push(dauer);
    if (liste.length > FENSTER) liste.shift();
    const langsam = liste.filter((d) => d > 0.8 * takt).length;
    if (liste.length >= 8 && langsam >= 8 && gueteRef.current < 2) {
      setGuete((gueteRef.current + 1) as Guete);
      liste.length = 0;
      gutSeit.current = null;
      return;
    }
    const sortiert = [...liste].sort((a, b) => a - b);
    const p90 = sortiert[Math.floor(sortiert.length * 0.9)] ?? dauer;
    if (p90 < 0.5 * takt) {
      gutSeit.current ??= performance.now();
      if (performance.now() - gutSeit.current > 3000 && gueteRef.current > 0) {
        setGuete((gueteRef.current - 1) as Guete);
        gutSeit.current = null;
      }
    } else {
      gutSeit.current = null;
    }
  };

  /** Die Stufen beim Wischen: kleiner zeichnen, bei Dauerlast die Notstufe – und zurück, wenn es wieder reicht. */
  const wischStufen = (dauer: number) => {
    const liste = wischDauern.current;
    liste.push(dauer);
    if (liste.length > FENSTER) liste.shift();
    const neu = gueteBeimWischen(liste, gueteRef.current);
    if (neu !== gueteRef.current) {
      setGuete(neu);
      gutSeit.current = null;
      return;
    }
    if (!pruefhaken().ohneNotstufe && notstufeNoetig(liste)) setNotstufe(true);
    if (gueteRef.current === 1 && gueteErholt(liste)) {
      gutSeit.current ??= performance.now();
      if (performance.now() - gutSeit.current > 3000) {
        setGuete(0);
        gutSeit.current = null;
      }
    } else if (gueteRef.current === 1) {
      gutSeit.current = null;
    }
  };

  /* ---------- Der Weg aus dem Speicher ---------- */

  /** Ein Bild aus dem Speicher zeichnen – mit der Bearbeitung und den Masken seines Filmbildes. */
  const zeichneSpeicherBild = (bild: WischBild, wunsch: Wunsch) => {
    const ziel = leinwand.current;
    if (!ziel || !mass) return;
    const q = quelleFuer();
    if (!q) return;
    const w = wisch.current;
    const vb = docFuerBild.current?.(wunsch.nummer, wunsch.k) ?? null;
    const doc = vb?.doc ?? null;
    const unberuehrt = !doc || docUnberuehrt(doc, mass.b, mass.h);
    const anfang = performance.now();
    // Auf die Rechengrösse hochrechnen, in dieselbe Leinwand wie das Video: Ab da ist alles
    // wie sonst (die Masken liegen in Rechengrösse, die Zeichnung nimmt `mass.b/mass.h`).
    q.stift.drawImage(bild as CanvasImageSource, 0, 0, mass.b, mass.h);
    if (unberuehrt || wunsch.roh) ohneBearbeitung(q, ziel);
    else mitBearbeitung(q, doc, ziel);
    const haken = pruefhaken();
    const dauer = haken.erzwingeLangsam ? 1000 : performance.now() - anfang;
    w.gezeigt = wunsch.index;
    w.gezeichnet = wunsch;
    w.zuletzt = 'speicher';
    haken.gezeichnet += 1;
    haken.speicherGezeichnet += 1;
    haken.letzteMs = wunsch.k * schrittRef.current;
    haken.aus = 'speicher';
    haken.letzteK = wunsch.k;
    haken.zielK = w.ziel === null ? -1 : (filmBilderRef.current[w.ziel]?.k ?? -1);
    haken.bereiche = doc?.bereiche.length ?? 0;
    haken.fehlend = [...(vb?.fehlend ?? KEINE_IDS)];
    dauerMerken(haken, dauer);
    fehlendSetzen(vb?.fehlend ?? KEINE_IDS);
    zeigen(true);
    // Nur Zeichnungen MIT Bearbeitung sagen etwas über die Last der Bearbeitung.
    if (!unberuehrt && !wunsch.roh) wischStufen(dauer);
  };

  /** Das neueste Ziel zeichnen – höchstens einmal je Anzeigetakt, nie gestaut. */
  const zeichneAusSpeicher = async () => {
    const w = wisch.current;
    const wunsch = w.wunsch;
    const sp = speicher.current;
    if (!wunsch || !sp || !aktivRef.current) return;
    if (wunsch === w.gezeichnet) return;
    // Läuft noch ein Warten auf das Entpacken, kommt der nächste Takt dran.
    if (w.laeuft) {
      planen();
      return;
    }
    let bild = sp.entpacktBild(wunsch.k);
    if (!bild) {
      w.laeuft = true;
      try {
        bild = await sp.bild(wunsch.k);
      } finally {
        w.laeuft = false;
      }
      // Inzwischen gibt es ein neueres Ziel: Dessen Takt zeichnet es.
      if (w.wunsch !== wunsch) {
        if (w.wunsch) planen();
        return;
      }
      if (!bild) return;
    }
    try {
      zeichneSpeicherBild(bild, wunsch);
    } catch {
      // Ein Bild, das inzwischen verdrängt und geschlossen wurde: Das nächste Ziel richtet es.
    }
    if (w.wunsch !== wunsch) planen();
  };

  const planen = () => {
    const w = wisch.current;
    if (w.rahmen) return;
    w.rahmen = requestAnimationFrame(() => {
      w.rahmen = 0;
      void neuest.current.zeichneAusSpeicher();
    });
  };

  /** Das Filmbild unter dem Finger zeigen – siehe `Wischer.zeigeBild`. */
  const zeigeBild = (i: number, fertig: boolean): Treffer => {
    const w = wisch.current;
    const bilder = filmBilderRef.current;
    const bild = bilder[i];
    if (!bild) return 'fehlt';
    w.ziel = i;
    const sp = speicher.current;
    sp?.kopf(bild.k);
    const toleranz = wischToleranz(schrittRef.current);
    const treffer = sp ? naechstesBild(bilder, i, (k) => sp.hat(k), toleranz) : null;
    if (!treffer) {
      // Der Speicher deckt nicht: Das Video springt wie bisher, und ein älterer Wunsch
      // aus dem Speicher gilt nicht mehr. Ein Bild, das nicht mehr zum Finger gehört,
      // bleibt dabei nie stehen – die Leinwand weicht dem rohen Video.
      w.wunsch = null;
      if (fertig) {
        wischDauern.current = [];
        setNotstufe(false);
      }
      if (leinwandVeraltet(w.gezeigt, i, toleranz)) {
        w.gezeigt = null;
        w.zuletzt = null;
        zeigen(false);
      }
      return 'fehlt';
    }
    const gewaehlt = bilder[treffer.index];
    sp?.vorladen(gewaehlt.k);
    // Beim Loslassen kommt das Bild in voller Güte, auch aus der Notstufe.
    const roh = notstufeRef.current && !fertig;
    // Dasselbe Bild noch einmal (der Finger bewegt sich innerhalb eines Bildes): nichts zu tun.
    const vorher = w.wunsch ?? (w.zuletzt === 'speicher' ? w.gezeichnet : null);
    if (!vorher || vorher.index !== treffer.index || vorher.roh !== roh) {
      w.wunsch = { index: treffer.index, nummer: gewaehlt.nummer, k: gewaehlt.k, roh };
      planen();
    }
    if (fertig) {
      wischDauern.current = [];
      setNotstufe(false);
    }
    return treffer.abstand === 0 ? 'genau' : 'genaehert';
  };

  /** Der Finger ruht: In der Notstufe das gezeigte Bild jetzt mit Bearbeitung. */
  const ruhe = () => {
    const w = wisch.current;
    if (!notstufeRef.current || !w.gezeichnet || !w.gezeichnet.roh) return;
    w.wunsch = { ...w.gezeichnet, roh: false };
    planen();
  };

  const zielVergessen = () => {
    wisch.current.ziel = null;
  };

  /** Immer die Fassung dieses Renders – der angebotene `Wischer` ist einer für alle Renders. */
  const neuest = useRef({ zeichneAusSpeicher, zeigeBild, ruhe, zielVergessen });
  neuest.current = { zeichneAusSpeicher, zeigeBild, ruhe, zielVergessen };

  useEffect(() => {
    if (!wischer) return undefined;
    const angebot: Wischer = {
      zeigeBild: (i, fertig) => neuest.current.zeigeBild(i, fertig),
      ruhe: () => neuest.current.ruhe(),
      zielVergessen: () => neuest.current.zielVergessen(),
      indexVon: (nummer, k) => indexRef.current.get(`${nummer}:${k}`) ?? null,
    };
    wischer.current = angebot;
    return () => {
      if (wischer.current === angebot) wischer.current = null;
    };
  }, [wischer]);

  /*
   * Solange die Vorschau zu sehen ist, darf aus dem Speicher gezeichnet
   * werden. Ein Wunsch, der kam, bevor sie sichtbar wurde (das Zeigerereignis
   * schaltet sie mit ein), wartet hier auf seinen Takt; beim Wegschalten
   * räumt es auf, damit der nächste Zug nicht mit dem alten Ziel beginnt.
   */
  useEffect(() => {
    if (!aktiv) return undefined;
    if (wisch.current.wunsch) planen();
    return () => {
      const w = wisch.current;
      cancelAnimationFrame(w.rahmen);
      w.rahmen = 0;
      w.wunsch = null;
      w.gezeichnet = null;
      w.ziel = null;
      w.gezeigt = null;
      w.zuletzt = null;
      wischDauern.current = [];
      setNotstufe(false);
    };
    // `planen` liest nur Referenzen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aktiv, setNotstufe]);

  /* ---------- Wann vom Video gezeichnet wird ---------- */

  useEffect(() => {
    const element = video.current as MitRvfc | null;
    if (!aktiv || !element) {
      zeigen(false);
      return undefined;
    }
    let weg = false;
    let rvfcNummer: number | null = null;
    let rahmen = 0;
    /** Wartet nach `seeked` noch auf die Meldung des angezeigten Bildes? */
    let wartend = false;

    const hatRvfc = typeof element.requestVideoFrameCallback === 'function';
    const anmelden = () => {
      if (weg || !hatRvfc) return;
      rvfcNummer = element.requestVideoFrameCallback!((_jetzt, meta) => {
        wartend = false;
        zeichnen(meta.mediaTime * 1000);
        anmelden();
      });
    };
    anmelden();

    /*
     * Nach einem Sprung: Kommt das Bild nicht über den Bildrückruf (manche
     * Browser melden ein Bild, das sich nicht geändert hat, gar nicht), wird
     * es zwei Anzeigetakte später von Hand gezeichnet.
     */
    const nachSprung = () => {
      wartend = true;
      cancelAnimationFrame(rahmen);
      rahmen = requestAnimationFrame(() => {
        rahmen = requestAnimationFrame(() => {
          if (wartend) {
            wartend = false;
            zeichnen(element.currentTime * 1000);
          }
        });
      });
    };
    element.addEventListener('seeked', nachSprung);

    /* Ohne Bildrückruf: beim Abspielen im Takt der Anzeige nachsehen. */
    let letzteZeit = -1;
    const takt = () => {
      if (weg) return;
      if (!element.paused && element.currentTime !== letzteZeit) {
        letzteZeit = element.currentTime;
        zeichnen(element.currentTime * 1000);
      }
      rahmen = requestAnimationFrame(takt);
    };
    if (!hatRvfc) rahmen = requestAnimationFrame(takt);

    // Das Bild, das gerade steht, sofort – sonst läge bis zum ersten Sprung
    // das rohe Video da. (Mit einem Ziel zählt das nur, wenn es dem Finger nahe liegt.)
    if (element.readyState >= 2) zeichnen(element.currentTime * 1000);
    else element.addEventListener('loadeddata', nachSprung, { once: true });

    return () => {
      weg = true;
      cancelAnimationFrame(rahmen);
      if (rvfcNummer !== null) element.cancelVideoFrameCallback?.(rvfcNummer);
      element.removeEventListener('seeked', nachSprung);
      element.removeEventListener('loadeddata', nachSprung);
    };
  }, [aktiv, video, zeichnen, zeigen]);

  /*
   * Eine Änderung an der Bearbeitung zeichnet das stehende Bild neu – das
   * Bild, das auf der Leinwand steht: kam es aus dem Speicher, wieder aus
   * dem Speicher. Das Video steht dann irgendwo, nur nicht beim gezeigten
   * Bild (es springt beim Wischen nicht mit).
   */
  useEffect(() => {
    const element = video.current;
    const w = wisch.current;
    if (!aktiv || !element) return;
    if (w.zuletzt === 'speicher' && w.gezeichnet) {
      // Ein Wunsch, der noch wartet, ist neuer als das Gezeichnete und nimmt die neue Bearbeitung
      // ohnehin mit – ihn zu ersetzen verlöre das Ziel des Fingers (gemessen beim Loslassen: Die
      // Leinwand blieb auf einem Bild, 280 Bilder daneben, bis der Editor sein Standbild zeigte).
      w.wunsch ??= { ...w.gezeichnet, roh: false };
      planen();
      return;
    }
    // Mitten in einem Zug kommt das richtige Bild von selbst.
    if (!element.paused || w.ziel !== null) return;
    zeichnen(element.currentTime * 1000);
    // `planen` liest nur Referenzen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aktiv, neuZeichnen, video, zeichnen]);

  useEffect(
    () => () => {
      cancelAnimationFrame(wisch.current.rahmen);
      wisch.current.rahmen = 0;
    },
    [],
  );

  return { bearbeitet, guete, notstufe, fehlend };
}

let arbeit: HTMLCanvasElement | null = null;
/** Eine Leinwand für das fertige Bild vor dem Einpassen – eine für alle. */
function arbeitsLeinwand(): HTMLCanvasElement {
  arbeit ??= document.createElement('canvas');
  return arbeit;
}

/**
 * Das fertige Bild in die Filmgrösse einpassen, mit schwarzem Rand – genau
 * wie `einpasser` in `videoBauen.ts`: Ein Film hat EINE Grösse, seine
 * Abschnitte nicht unbedingt.
 */
function einpassen(
  ziel: HTMLCanvasElement,
  bild: HTMLCanvasElement,
  film: { readonly w: number; readonly h: number },
): void {
  if (ziel.width !== film.w) ziel.width = film.w;
  if (ziel.height !== film.h) ziel.height = film.h;
  const stift = ziel.getContext('2d');
  if (!stift) return;
  stift.setTransform(1, 0, 0, 1, 0, 0);
  stift.fillStyle = '#000';
  stift.fillRect(0, 0, film.w, film.h);
  const faktor = Math.min(film.w / bild.width, film.h / bild.height);
  const w = Math.round(bild.width * faktor);
  const h = Math.round(bild.height * faktor);
  stift.imageSmoothingQuality = 'high';
  stift.drawImage(bild, Math.round((film.w - w) / 2), Math.round((film.h - h) / 2), w, h);
}
