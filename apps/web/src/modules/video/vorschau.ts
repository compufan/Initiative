import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import { docUnberuehrt, type BildDoc } from '../bild/doc.js';
import { quelleVeraendert } from '../bild/tonGpu.js';
import { zeichneAnsicht, zeichneAusgabe } from '../bild/zeichnen.js';

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
 * # Wie, ohne das Wischen zu bremsen
 *
 * Das Video bleibt die Quelle: Es springt (siehe `springenZu`) und spielt
 * wie bisher, und diese Datei hängt sich nur an die Bilder, die es wirklich
 * anzeigt. `requestVideoFrameCallback` meldet jedes davon samt seiner
 * Zeit im Film – so passt die Bearbeitung zu genau dem Bild, das gezeigt
 * wird, auch wenn der nächste Sprung schon läuft. Wo es das nicht gibt,
 * zeichnet ein Bild nach `seeked` bzw. im Takt der Anzeige.
 *
 * Gezeichnet wird nur das jeweils NEUESTE Bild; die Sprungkette wartet nie
 * auf das Zeichnen. Sonst bestimmte die Zeichendauer, wie schnell das Video
 * dem Finger folgt, und genau das war gerade erst behoben.
 *
 * # Wenn das Gerät zu langsam ist
 *
 * Eine Stufenleiter: zuerst kleiner zeichnen, und wenn auch das beim
 * Abspielen nicht mithält, das rohe Video zeigen – mit einem Satz, der das
 * sagt. Angehalten und beim Wischen gibt es die Bearbeitung trotzdem, dort
 * kommt es auf ein paar Millisekunden nicht an.
 */

/** 0: volle Grösse · 1: kleiner gezeichnet · 2: rohes Video beim Abspielen. */
export type Guete = 0 | 1 | 2;

export interface VorschauAuftrag {
  readonly video: RefObject<HTMLVideoElement | null>;
  readonly leinwand: RefObject<HTMLCanvasElement | null>;
  /**
   * Die Bearbeitung für das Bild bei dieser Quellzeit – `null` heisst: keine,
   * dann bleibt das rohe Video sichtbar.
   *
   * Über eine Referenz gelesen, nicht über die Abhängigkeiten: Sie ändert sich
   * mit jedem Reglerschritt, und die Rückrufe am Video sollen deshalb nicht
   * jedes Mal neu angemeldet werden.
   */
  readonly docFuer: (quelleMs: number) => BildDoc | null;
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
}

export interface VorschauStand {
  /** Liegt gerade ein bearbeitetes Bild über dem Video? */
  readonly bearbeitet: boolean;
  readonly guete: Guete;
}

interface Pruefhaken {
  gezeichnet: number;
  guete: Guete;
  /** Für Tests: jede Zeichnung gilt als zu langsam. */
  erzwingeLangsam: boolean;
  /** Die Filmzeit (Quelle) des zuletzt gezeichneten Bildes. */
  letzteMs: number;
}

function pruefhaken(): Pruefhaken {
  const fenster = window as unknown as { __vorschau?: Pruefhaken };
  fenster.__vorschau ??= { gezeichnet: 0, guete: 0, erzwingeLangsam: false, letzteMs: -1 };
  return fenster.__vorschau;
}

/** Ab so vielen Millisekunden je Bild beim Wischen wird kleiner gezeichnet. */
const WISCH_GRENZE_MS = 120;
/** So viele Zeichnungen beim Abspielen werden für die Stufenleiter betrachtet. */
const FENSTER = 16;

type MitRvfc = HTMLVideoElement & {
  requestVideoFrameCallback?: (
    rueckruf: (jetzt: number, meta: { mediaTime: number }) => void,
  ) => number;
  cancelVideoFrameCallback?: (nummer: number) => void;
};

export function useBearbeiteteVorschau(auftrag: VorschauAuftrag): VorschauStand {
  const { video, leinwand, mass, art, film, aktiv, schrittMs, neuZeichnen } = auftrag;
  const docFuer = useRef(auftrag.docFuer);
  docFuer.current = auftrag.docFuer;

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

  /** Die Leinwand in Rechengrösse, auf die jedes Videobild zuerst kommt. */
  const quelle = useRef<{ flaeche: HTMLCanvasElement; stift: CanvasRenderingContext2D } | null>(
    null,
  );
  const dauern = useRef<number[]>([]);
  const gutSeit = useRef<number | null>(null);

  const zeichnen = useCallback(
    (quelleMs: number) => {
      const element = video.current;
      const ziel = leinwand.current;
      if (!element || !ziel || !mass || element.readyState < 2) return;
      const doc = docFuer.current(quelleMs);
      const spielt = !element.paused && !element.ended;
      if (!doc || docUnberuehrt(doc, mass.b, mass.h) || (spielt && gueteRef.current === 2)) {
        zeigen(false);
        return;
      }
      let q = quelle.current;
      if (!q || q.flaeche.width !== mass.b || q.flaeche.height !== mass.h) {
        const flaeche = document.createElement('canvas');
        flaeche.width = mass.b;
        flaeche.height = mass.h;
        const stift = flaeche.getContext('2d');
        if (!stift) return;
        q = { flaeche, stift };
        quelle.current = q;
      }
      const anfang = performance.now();
      q.stift.drawImage(element, 0, 0, mass.b, mass.h);
      quelleVeraendert(q.flaeche);
      if (art === 'ansicht') {
        const breite = ziel.clientWidth || 640;
        const dichte = window.devicePixelRatio || 1;
        const kante = Math.max(512, Math.min(1400, Math.round(breite * dichte)));
        zeichneAnsicht(ziel, q.flaeche, mass.b, mass.h, doc, {
          maxKante: gueteRef.current >= 1 ? Math.round(kante * 0.6) : kante,
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
      const haken = pruefhaken();
      const dauer = haken.erzwingeLangsam ? 1000 : performance.now() - anfang;
      haken.gezeichnet += 1;
      haken.letzteMs = quelleMs;
      zeigen(true);
      stufen(dauer, spielt);
    },
    // `stufen` ist unten definiert und stabil; `docFuer` läuft über die Referenz.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [art, film, leinwand, mass, video, zeigen],
  );

  /**
   * Die Stufenleiter – siehe oben. Beim Abspielen zählt der Anteil zu
   * langsamer Bilder, beim Wischen schon ein einzelnes sehr langsames.
   */
  const stufen = (dauer: number, spielt: boolean) => {
    const takt = Math.max(16, schrittMs);
    if (!spielt) {
      if (dauer > WISCH_GRENZE_MS && gueteRef.current === 0) setGuete(1);
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

  /* ---------- Wann gezeichnet wird ---------- */

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
    // das rohe Video da.
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

  /* Eine Änderung an der Bearbeitung zeichnet das stehende Bild neu. */
  useEffect(() => {
    const element = video.current;
    if (!aktiv || !element || !element.paused) return;
    zeichnen(element.currentTime * 1000);
  }, [aktiv, neuZeichnen, video, zeichnen]);

  return { bearbeitet, guete };
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
