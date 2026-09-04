import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { dialogAnmelden } from '../../lib/dialogVerlauf.js';
import { herunterladen } from '../../lib/herunterladen.js';
import { toast, useHideNav } from '../../state/ui.js';
import { errorMessage, loadImageFromBlob } from '../stickers/helpers.js';
import {
  ansichtAlsZuschnitt,
  ansichtGroesse,
  aufVerhaeltnis,
  docKopie,
  docUnberuehrt,
  nachAnsicht,
  nachOriginal,
  neuesDoc,
  weiterdrehen,
  zuschnittHalten,
  zuschnittInAnsicht,
  type BildDoc,
  type Malstrich,
  type Schriftzug,
  type Zuschnitt,
} from './doc.js';
import { basisAus, lupeHalten, zoomAusSpanne } from './lupe.js';
import { SCHRIFTEN, trifftText, zeichneAnsicht, zeichneAusgabe } from './zeichnen.js';
import './styles.css';

type Werkzeug = 'zuschnitt' | 'malen' | 'text';

const FARBEN = [
  '#ffffff',
  '#111111',
  '#ff3b30',
  '#ff9500',
  '#ffcc00',
  '#34c759',
  '#0a84ff',
  '#af52de',
];

const VERHAELTNISSE: { label: string; wert: number | null }[] = [
  { label: 'Frei', wert: null },
  { label: '1:1', wert: 1 },
  { label: '4:5', wert: 4 / 5 },
  { label: '3:2', wert: 3 / 2 },
  { label: '16:9', wert: 16 / 9 },
];

/**
 * Die Anzeigeauflösung der Arbeitsfläche – mehr sieht niemand, kostet aber.
 *
 * Obergrenze, nicht Vorgabe: Gerechnet wird mit der tatsächlichen Breite der
 * Bühne mal Gerätedichte. Auf einem Telefon sind das oft 400 × 3 = 1200 statt
 * fester 1400 – ein Viertel weniger Bildpunkte je Neuzeichnen, ohne dass
 * jemand einen Unterschied sieht.
 */
const ANSICHT_KANTE_MAX = 1400;

const VERLAUF_MAX = 25;

interface BildEditorProps {
  /** Das zu bearbeitende Bild. */
  quelle: Blob;
  /** Name des Originals – der Vorschlag für die bearbeitete Fassung. */
  name?: string | null;
  onClose: () => void;
  /**
   * Wohin das Ergebnis geht. Fehlt es, bleibt nur „auf dem Handy speichern“ –
   * ein Editor ohne Ziel wäre eine Sackgasse, deshalb sagt der Knopf dann auch
   * genau das.
   */
  onFertig?: (blob: Blob, name: string) => Promise<void> | void;
  zielName?: string;
}

/** `foto.jpg` → `foto-bearbeitet.webp`. Das Original behält seinen Namen. */
function bearbeiteterName(name: string | null | undefined, endung: string): string {
  const roh = (name ?? 'bild').replace(/\.[^.]+$/, '');
  const kurz = roh.length > 60 ? roh.slice(0, 60) : roh;
  return `${kurz || 'bild'}-bearbeitet.${endung}`;
}

/**
 * Der Bildeditor: zuschneiden, drehen, malen, beschriften.
 *
 * Er überschreibt nie das Original. Das Ergebnis ist eine eigene Datei, die
 * entweder dort landet, wo das Original liegt (Chat oder Sammlung), oder auf
 * dem Telefon – oder beides.
 */
export function BildEditor({ quelle, name, onClose, onFertig, zielName }: BildEditorProps) {
  useHideNav(true);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [bild, setBild] = useState<HTMLImageElement | null>(null);
  const [doc, setDoc] = useState<BildDoc | null>(null);
  const [werkzeug, setWerkzeug] = useState<Werkzeug>('zuschnitt');
  /**
   * Das gewählte Seitenverhältnis – und zwar dauerhaft.
   *
   * Vorher wandte `verhaeltnisSetzen` es genau einmal an; wer danach eine Ecke
   * zog, hatte es wieder verloren. „Auf 16:9 zuschneiden“ war damit kein
   * Modus, sondern eine einmalige Zurechtrückung.
   */
  const [verhaeltnis, setVerhaeltnis] = useState<number | null>(null);
  /** Was der Pinsel tut: malen, verpixeln oder verwischen. */
  const [malart, setMalart] = useState<'farbe' | 'pixel' | 'weich'>('farbe');
  const malartRef = useRef(malart);
  /**
   * Die Lupe: reine Ansicht, nicht Teil des Bildes.
   *
   * Steht bewusst nicht im Dokument – sonst landete jedes Heranzoomen im
   * Rückgängig-Verlauf. `x`/`y` ist die linke obere Ecke des gezeigten
   * Ausschnitts in Ansichtspunkten.
   */
  const [lupe, setLupe] = useState({ zoom: 1, x: 0, y: 0 });
  const lupeRef = useRef(lupe);
  const verhaeltnisRef = useRef<number | null>(null);
  const [farbe, setFarbe] = useState('#ff3b30');
  const [breite, setBreite] = useState(14);
  const [gewaehlterText, setGewaehlterText] = useState<string | null>(null);
  const [laedt, setLaedt] = useState(true);
  const [speichert, setSpeichert] = useState(false);
  const [kannZurueck, setKannZurueck] = useState(false);
  const [kannVor, setKannVor] = useState(false);

  const docRef = useRef<BildDoc | null>(null);
  const bildRef = useRef<HTMLImageElement | null>(null);
  const werkzeugRef = useRef(werkzeug);
  const farbeRef = useRef(farbe);
  const breiteRef = useRef(breite);
  const gewaehltRef = useRef<string | null>(null);
  const verlauf = useRef<BildDoc[]>([]);
  /** Der Vor-Stapel: was zurückgenommen wurde und wiederkommen kann. */
  const vor = useRef<BildDoc[]>([]);
  const massRef = useRef({ faktor: 1, breite: 1, hoehe: 1, versatz: { x: 0, y: 0 } });
  const rahmen = useRef<number | null>(null);
  const zug = useRef<{
    art: 'keiner' | 'zuschnitt' | 'malen' | 'text';
    griff: string;
    start: { x: number; y: number };
    startZ: Zuschnitt;
    startText: { x: number; y: number };
    /**
     * Ob dieser Zug schon etwas am Dokument geändert hat.
     *
     * Trennt „Antippen“ von „Ziehen“: Ein Antippen wirkt erst beim Loslassen,
     * und bis dahin kann aus dem ersten Finger noch eine Zwei-Finger-Geste
     * werden.
     */
    begonnen: boolean;
  }>({
    art: 'keiner',
    griff: '',
    start: { x: 0, y: 0 },
    startZ: { x: 0, y: 0, w: 0, h: 0 },
    startText: { x: 0, y: 0 },
    begonnen: false,
  });
  /** Ob dieser Zug schon einen Rückgängig-Schritt angelegt hat. */
  const zugGemerkt = useRef(false);

  useEffect(() => {
    werkzeugRef.current = werkzeug;
  }, [werkzeug]);
  useEffect(() => {
    farbeRef.current = farbe;
  }, [farbe]);
  useEffect(() => {
    breiteRef.current = breite;
  }, [breite]);
  useEffect(() => {
    gewaehltRef.current = gewaehlterText;
  }, [gewaehlterText]);

  /**
   * Wieviele Bildpunkte die Arbeitsfläche wirklich braucht.
   *
   * Nicht mehr als der Bildschirm hergibt: Auf einem Telefon sind das oft
   * 1200 statt fester 1400 – ein Viertel weniger Arbeit je Neuzeichnen, ohne
   * sichtbaren Unterschied. Nach oben gedeckelt, damit ein grosser Monitor
   * nicht in die Vollauflösung rutscht.
   */
  const ansichtsKante = useCallback(() => {
    const breite = canvasRef.current?.parentElement?.clientWidth ?? 0;
    const dichte = Math.min(globalThis.devicePixelRatio || 1, 3);
    if (breite <= 0) return ANSICHT_KANTE_MAX;
    return Math.max(512, Math.min(ANSICHT_KANTE_MAX, Math.round(breite * dichte)));
  }, []);

  /**
   * Feste Grenzen für die Schriftgrösse, abgeleitet von der Bildkante.
   *
   * Vorher hing `min` am aktuellen Wert (`groesse/8`): Wer die Schrift einmal
   * gross zog, konnte sie nie wieder klein machen, weil die Skala mitwanderte.
   */
  const schriftGrenzen = useMemo(() => {
    const kante = Math.max(bild?.naturalWidth ?? 512, bild?.naturalHeight ?? 512);
    return { klein: Math.max(8, kante / 60), gross: kante / 3 };
  }, [bild]);

  const planenRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    malartRef.current = malart;
  }, [malart]);

  useEffect(() => {
    lupeRef.current = lupe;
    planenRef.current?.();
  }, [lupe]);

  const zeichnen = useCallback(() => {
    const canvas = canvasRef.current;
    const quellBild = bildRef.current;
    const aktuell = docRef.current;
    if (!canvas || !quellBild || !aktuell) return;
    const mass = zeichneAnsicht(
      canvas,
      quellBild,
      quellBild.naturalWidth,
      quellBild.naturalHeight,
      aktuell,
      {
        maxKante: ansichtsKante(),
        zuschnittZeigen: werkzeugRef.current === 'zuschnitt',
        zoom: lupeRef.current.zoom,
        versatz: { x: lupeRef.current.x, y: lupeRef.current.y },
      },
    );
    if (mass) massRef.current = mass;
  }, []);

  const planen = useCallback(() => {
    if (rahmen.current != null) cancelAnimationFrame(rahmen.current);
    rahmen.current = window.requestAnimationFrame(() => {
      rahmen.current = null;
      zeichnen();
    });
  }, [zeichnen]);

  useEffect(() => {
    planenRef.current = planen;
  }, [planen]);

  useEffect(() => {
    docRef.current = doc;
    bildRef.current = bild;
    planen();
  }, [doc, bild, planen]);

  useEffect(() => {
    planen();
  }, [werkzeug, planen]);

  // Zurück-Taste schliesst den Editor, statt aus der App zu fallen.
  useEffect(() => dialogAnmelden(onClose), [onClose]);

  useEffect(() => {
    let weg = false;
    loadImageFromBlob(quelle)
      .then((geladen) => {
        if (weg) return;
        setBild(geladen);
        setDoc(neuesDoc(geladen.naturalWidth, geladen.naturalHeight));
      })
      .catch((error: unknown) => {
        if (weg) return;
        toast(errorMessage(error, 'Das Bild konnte nicht geladen werden'), 'error');
        onClose();
      })
      .finally(() => {
        if (!weg) setLaedt(false);
      });
    return () => {
      weg = true;
    };
  }, [quelle, onClose]);

  /** Merkt den Stand für „Rückgängig“. */
  const merken = useCallback(() => {
    const aktuell = docRef.current;
    if (!aktuell) return;
    verlauf.current = [...verlauf.current, docKopie(aktuell)].slice(-VERLAUF_MAX);
    // Ein neuer Schritt macht den Vor-Stapel gegenstandslos: Von hier führt
    // kein Weg mehr zu dem, was zurückgenommen wurde.
    vor.current = [];
    setKannZurueck(true);
    setKannVor(false);
  }, []);

  const zurueck = useCallback(() => {
    const vorher = verlauf.current[verlauf.current.length - 1];
    if (!vorher) return;
    const jetzt = docRef.current;
    verlauf.current = verlauf.current.slice(0, -1);
    // Was zurückgenommen wird, kommt auf den Vor-Stapel. Ohne ihn war ein
    // versehentliches Rückgängig unumkehrbar – die häufigste Art, Arbeit zu
    // verlieren.
    if (jetzt) vor.current = [...vor.current, docKopie(jetzt)].slice(-VERLAUF_MAX);
    setKannZurueck(verlauf.current.length > 0);
    setKannVor(vor.current.length > 0);
    setDoc(vorher);
  }, []);

  const wieder = useCallback(() => {
    const naechster = vor.current[vor.current.length - 1];
    if (!naechster) return;
    const jetzt = docRef.current;
    vor.current = vor.current.slice(0, -1);
    if (jetzt) verlauf.current = [...verlauf.current, docKopie(jetzt)].slice(-VERLAUF_MAX);
    setKannVor(vor.current.length > 0);
    setKannZurueck(true);
    setDoc(naechster);
  }, []);

  /* ---------- Umrechnung Bildschirm → Ansicht ---------- */

  /**
   * Bildschirmpunkt → Leinwandpunkt.
   *
   * Nur der Massstab zwischen CSS-Punkten und Gerätepunkten der Arbeitsfläche,
   * ohne Lupe. Getrennt vom Schritt darunter, weil die Zwei-Finger-Geste
   * genau diese Zwischenstufe braucht.
   */
  function leinwandPunkt(clientX: number, clientY: number): { x: number; y: number } {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const proPixel = massRef.current.breite / (rect.width || 1);
    return { x: (clientX - rect.left) * proPixel, y: (clientY - rect.top) * proPixel };
  }

  function ansichtsPunkt(clientX: number, clientY: number): { x: number; y: number } {
    // Der gezeigte Ausschnitt beginnt bei `versatz` – ohne ihn träfe jeder
    // Griff bei herangezoomter Ansicht daneben.
    const { faktor, versatz } = massRef.current;
    const auf = leinwandPunkt(clientX, clientY);
    return { x: auf.x / faktor + versatz.x, y: auf.y / faktor + versatz.y };
  }

  /** Welcher Griff des Zuschnittrahmens am nächsten liegt – oder „innen“. */
  function griffAn(punkt: { x: number; y: number }, z: Zuschnitt): string {
    /*
     * Ein Finger ist rund 28 Leinwandpunkte breit – das ist der Fangbereich,
     * umgerechnet in Ansichtspunkte. Vorher stand hier `Math.max(…, 20 % des
     * Rahmens)`: Bei einem grossen Rahmen führte der zweite Wert, und der
     * schrumpft beim Heranzoomen nicht mit. Auf Zoom 3 lag der Fangbereich
     * dann über der halben Bildschirmbreite – „innen“ war nicht mehr
     * erreichbar. Umgekehrt gedeckelt, damit bei einem winzigen Rahmen nicht
     * jeder Griff gleichzeitig alle vier Kanten trifft.
     */
    const nah = Math.min(28 / massRef.current.faktor, Math.min(z.w, z.h) * 0.25);
    const links = Math.abs(punkt.x - z.x) < nah;
    const rechts = Math.abs(punkt.x - (z.x + z.w)) < nah;
    const oben = Math.abs(punkt.y - z.y) < nah;
    const unten = Math.abs(punkt.y - (z.y + z.h)) < nah;
    if (links && oben) return 'lo';
    if (rechts && oben) return 'ro';
    if (links && unten) return 'lu';
    if (rechts && unten) return 'ru';
    if (links) return 'l';
    if (rechts) return 'r';
    if (oben) return 'o';
    if (unten) return 'u';
    return 'innen';
  }

  /**
   * Die gerade aufliegenden Finger.
   *
   * Vorher gab es genau ein `zug.current` – damit ist eine Zwei-Finger-Geste
   * nicht zu erkennen, der zweite Finger überschrieb schlicht den ersten.
   */
  const finger = useRef(new Map<number, { x: number; y: number }>());
  const zweiFinger = useRef<{
    /** Fingerabstand beim Aufsetzen, in Bildschirmpunkten. */
    abstand: number;
    /** Der Lupenfaktor beim Aufsetzen. */
    zoom: number;
    /** Der Bildpunkt unter der Fingermitte – der soll dort bleiben. */
    mitte: { x: number; y: number };
  } | null>(null);

  /** Abstand und Mitte zweier Finger, in Bildschirmpunkten. */
  function spanne(): { abstand: number; mitte: { x: number; y: number } } | null {
    const zwei = [...finger.current.values()];
    if (zwei.length < 2) return null;
    const dx = zwei[0].x - zwei[1].x;
    const dy = zwei[0].y - zwei[1].y;
    return {
      abstand: Math.hypot(dx, dy),
      mitte: { x: (zwei[0].x + zwei[1].x) / 2, y: (zwei[0].y + zwei[1].y) / 2 },
    };
  }

  /** Ein neuer Strich mit den gerade eingestellten Werten. */
  function neuerStrich(quellBild: HTMLImageElement, punkte: number[]): Malstrich {
    return {
      farbe: farbeRef.current,
      // Relativ zur Bildkante, nicht absolut: 14 Punkte sind auf einem 1920er
      // Bild 0,7 %, auf einem 600er aber 2,3 % – ein Strich, der auf dem einen
      // fein ist, deckt auf dem anderen alles zu. Die Schriftgrösse macht es
      // längst richtig.
      breite:
        (breiteRef.current / 100) *
        (Math.max(quellBild.naturalWidth, quellBild.naturalHeight) / 20),
      punkte,
      art: malartRef.current,
    };
  }

  function onPointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    const aktuell = docRef.current;
    const quellBild = bildRef.current;
    if (!aktuell || !quellBild) return;
    finger.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (finger.current.size >= 2) {
      // Zwei Finger heisst Ansicht, nicht Bearbeiten: die notierte Absicht
      // fallenlassen, damit nicht nebenbei gemalt oder zugeschnitten wird.
      zug.current = { ...zug.current, art: 'keiner', begonnen: false };
      const jetzt = spanne();
      if (jetzt) {
        zweiFinger.current = {
          abstand: jetzt.abstand,
          zoom: lupeRef.current.zoom,
          mitte: ansichtsPunkt(jetzt.mitte.x, jetzt.mitte.y),
        };
      }
      return;
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* nicht überall vorhanden, nicht schlimm */
    }
    const punkt = ansichtsPunkt(event.clientX, event.clientY);
    const W = quellBild.naturalWidth;
    const H = quellBild.naturalHeight;

    /*
     * Hier wird ausschliesslich notiert, was gemeint ist – geändert wird
     * nichts.
     *
     * Zwei Finger können nie in einem einzigen `pointerdown` ankommen: Der
     * erste löst immer für sich aus, der zweite kommt eine Handbreit später.
     * Vorher legte dieser erste Finger schon einen Strich an oder rückte
     * einen Schriftzug – das nachträgliche `art: 'keiner'` hielt nur
     * kommende Bewegungen auf, den Punkt im Bild nahm es nicht zurück. Wer
     * mit dem Pinsel in der Hand heranzoomen wollte, hatte danach einen
     * Klecks. Jetzt entsteht der Strich bei der ersten Bewegung, der
     * Antipp-Punkt erst beim Loslassen.
     */
    zugGemerkt.current = false;
    const leer = { x: 0, y: 0, w: 0, h: 0 };

    if (werkzeugRef.current === 'zuschnitt') {
      const inAnsicht = zuschnittInAnsicht(aktuell.zuschnitt, W, H, aktuell);
      // Erst merken, wenn sich wirklich etwas bewegt – siehe `zugGemerkt`.
      // Vorher legte jedes blosse Antippen der Fläche einen Schritt an, und
      // fünf Fehlgriffe hintereinander schoben den Verlauf leer.
      zug.current = {
        art: 'zuschnitt',
        griff: griffAn(punkt, inAnsicht),
        start: punkt,
        startZ: inAnsicht,
        startText: { x: 0, y: 0 },
        begonnen: false,
      };
      return;
    }

    if (werkzeugRef.current === 'malen') {
      zug.current = {
        art: 'malen',
        griff: '',
        start: punkt,
        startZ: leer,
        startText: { x: 0, y: 0 },
        begonnen: false,
      };
      return;
    }

    // Text: einen vorhandenen greifen, sonst den gewählten beim Loslassen
    // dorthin setzen. Ein leerer `griff` heisst „setzen“.
    const ctx = canvasRef.current?.getContext('2d');
    const getroffen = ctx
      ? [...aktuell.texte]
          .reverse()
          .find((text) =>
            trifftText(ctx, text, nachAnsicht({ x: text.x, y: text.y }, W, H, aktuell), punkt),
          )
      : undefined;
    if (getroffen) {
      setGewaehlterText(getroffen.id);
      zug.current = {
        art: 'text',
        griff: getroffen.id,
        start: punkt,
        startZ: leer,
        startText: { x: getroffen.x, y: getroffen.y },
        begonnen: false,
      };
      return;
    }
    zug.current = {
      art: 'text',
      griff: '',
      start: punkt,
      startZ: leer,
      startText: { x: 0, y: 0 },
      begonnen: false,
    };
  }

  function onPointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (finger.current.has(event.pointerId)) {
      finger.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }

    // Zwei Finger: zoomen und schieben, nichts am Bild ändern.
    const anker = zweiFinger.current;
    if (anker && finger.current.size >= 2) {
      const jetzt = spanne();
      if (!jetzt || anker.abstand <= 0) return;
      const bildJetzt = bildRef.current;
      const docJetzt = docRef.current;
      if (!bildJetzt || !docJetzt) return;
      // Die Rechnung steht in `lupe.ts` – dort ist sie nachprüfbar, hier
      // wäre sie zwischen Zeigerereignissen und Zeichenrahmen begraben.
      const sicht = ansichtGroesse(
        bildJetzt.naturalWidth,
        bildJetzt.naturalHeight,
        docJetzt.drehung,
      );
      setLupe(
        lupeHalten({
          ankerAnsicht: anker.mitte,
          mitteLeinwand: leinwandPunkt(jetzt.mitte.x, jetzt.mitte.y),
          basis: basisAus(massRef.current.breite, sicht.w),
          zoom: zoomAusSpanne(anker.zoom, anker.abstand, jetzt.abstand),
        }),
      );
      return;
    }

    const art = zug.current.art;
    if (art === 'keiner') return;
    const aktuell = docRef.current;
    const quellBild = bildRef.current;
    if (!aktuell || !quellBild) return;
    // Ziehen auf leerer Fläche mit dem Textwerkzeug: Es gibt nichts zu
    // greifen. Vor `merken`, sonst legte jedes Danebengreifen einen leeren
    // Rückgängig-Schritt an.
    if (art === 'text' && zug.current.griff === '') return;

    const punkt = ansichtsPunkt(event.clientX, event.clientY);
    const W = quellBild.naturalWidth;
    const H = quellBild.naturalHeight;

    // Jetzt bewegt sich wirklich etwas – jetzt lohnt ein Rückgängig-Schritt.
    // Beim blossen Antippen der Fläche entsteht keiner mehr.
    if (!zugGemerkt.current) {
      zugGemerkt.current = true;
      merken();
    }

    if (art === 'zuschnitt') {
      const start = zug.current.startZ;
      const dx = punkt.x - zug.current.start.x;
      const dy = punkt.y - zug.current.start.y;
      const griff = zug.current.griff;
      let rechteck: Zuschnitt;
      if (griff === 'innen') {
        rechteck = { ...start, x: start.x + dx, y: start.y + dy };
      } else {
        let { x, y, w, h } = start;
        if (griff.includes('l')) {
          x = start.x + dx;
          w = start.w - dx;
        }
        if (griff.includes('r')) w = start.w + dx;
        if (griff.includes('o')) {
          y = start.y + dy;
          h = start.h - dy;
        }
        if (griff.includes('u')) h = start.h + dy;
        // Das gewählte Verhältnis gilt auch beim Ziehen, nicht nur beim
        // Drücken des Knopfes. Die Breite führt, die Höhe folgt – und an den
        // Oberkanten wandert der Ursprung mit, sonst rutscht das Rechteck weg.
        if (verhaeltnisRef.current) {
          const v =
            aktuell.drehung === 90 || aktuell.drehung === 270
              ? 1 / verhaeltnisRef.current
              : verhaeltnisRef.current;
          const neueHoehe = Math.abs(w) / v;
          if (griff.includes('o')) y = start.y + start.h - neueHoehe;
          h = neueHoehe;
        }
        // Über den gegenüberliegenden Rand hinausgezogen: das Rechteck klappt
        // um, statt eine negative Breite zu bekommen.
        if (w < 0) {
          x += w;
          w = -w;
        }
        if (h < 0) {
          y += h;
          h = -h;
        }
        rechteck = { x, y, w, h };
      }
      const sicht = ansichtGroesse(W, H, aktuell.drehung);
      const gehalten = zuschnittHalten(rechteck, sicht.w, sicht.h);
      const amBild = ansichtAlsZuschnitt(gehalten, W, H, aktuell);
      zug.current = { ...zug.current, begonnen: true };
      setDoc((wert) => (wert ? { ...wert, zuschnitt: amBild } : wert));
      return;
    }

    if (art === 'malen') {
      const amBild = nachOriginal(punkt, W, H, aktuell);
      if (!zug.current.begonnen) {
        // Der Strich beginnt beim Aufsetzpunkt, nicht erst hier – sonst
        // fehlte der ersten Bewegung ihr Anfang.
        const anfang = nachOriginal(zug.current.start, W, H, aktuell);
        zug.current = { ...zug.current, begonnen: true };
        setDoc((wert) =>
          wert
            ? {
                ...wert,
                striche: [
                  ...wert.striche,
                  neuerStrich(quellBild, [anfang.x, anfang.y, amBild.x, amBild.y]),
                ],
              }
            : wert,
        );
        return;
      }
      setDoc((wert) => {
        if (!wert) return wert;
        const striche = wert.striche.slice();
        const letzter = striche[striche.length - 1];
        if (!letzter) return wert;
        striche[striche.length - 1] = {
          ...letzter,
          punkte: [...letzter.punkte, amBild.x, amBild.y],
        };
        return { ...wert, striche };
      });
      return;
    }

    if (art === 'text') {
      zug.current = { ...zug.current, begonnen: true };
      const start = nachAnsicht(zug.current.startText, W, H, aktuell);
      const ziel = nachOriginal(
        {
          x: start.x + (punkt.x - zug.current.start.x),
          y: start.y + (punkt.y - zug.current.start.y),
        },
        W,
        H,
        aktuell,
      );
      setDoc((wert) =>
        wert
          ? {
              ...wert,
              texte: wert.texte.map((text) =>
                text.id === zug.current.griff ? { ...text, x: ziel.x, y: ziel.y } : text,
              ),
            }
          : wert,
      );
    }
  }

  /**
   * Ende eines Zuges.
   *
   * `tippen` unterscheidet Loslassen von Abbruch: Ein `pointercancel` kommt,
   * wenn das System den Finger übernimmt (Wischgeste, Anruf). Daraus einen
   * Klecks oder einen versetzten Schriftzug zu machen, wäre falsch.
   */
  function zugBeenden(event: ReactPointerEvent<HTMLCanvasElement> | undefined, tippen: boolean) {
    if (event) finger.current.delete(event.pointerId);
    if (finger.current.size < 2) {
      zweiFinger.current = null;
    } else {
      // Von drei Fingern bleiben zwei übrig: Der Anker gehört zu einem
      // anderen Paar und würde das Bild springen lassen. Neu aufsetzen.
      const jetzt = spanne();
      if (jetzt) {
        zweiFinger.current = {
          abstand: jetzt.abstand,
          zoom: lupeRef.current.zoom,
          mitte: ansichtsPunkt(jetzt.mitte.x, jetzt.mitte.y),
        };
      }
    }
    const zustand = zug.current;
    zug.current = { ...zustand, art: 'keiner', begonnen: false };
    // Hat der Zug schon gewirkt, ist er hier fertig. War es eine
    // Zwei-Finger-Geste, steht `art` längst auf `keiner`.
    if (!tippen || zustand.begonnen || zustand.art === 'keiner') return;

    const aktuell = docRef.current;
    const quellBild = bildRef.current;
    if (!aktuell || !quellBild) return;
    const W = quellBild.naturalWidth;
    const H = quellBild.naturalHeight;

    if (zustand.art === 'malen') {
      // Ein Tupfen: ein Strich aus einem einzigen Punkt.
      const amBild = nachOriginal(zustand.start, W, H, aktuell);
      merken();
      setDoc((wert) =>
        wert
          ? { ...wert, striche: [...wert.striche, neuerStrich(quellBild, [amBild.x, amBild.y])] }
          : wert,
      );
      return;
    }

    if (zustand.art === 'text' && zustand.griff === '') {
      const gewaehlt = aktuell.texte.find((text) => text.id === gewaehltRef.current);
      if (!gewaehlt) return;
      const amBild = nachOriginal(zustand.start, W, H, aktuell);
      merken();
      setDoc((wert) =>
        wert
          ? {
              ...wert,
              texte: wert.texte.map((text) =>
                text.id === gewaehlt.id ? { ...text, x: amBild.x, y: amBild.y } : text,
              ),
            }
          : wert,
      );
    }
  }

  function onPointerUp(event?: ReactPointerEvent<HTMLCanvasElement>) {
    zugBeenden(event, true);
  }

  function onPointerCancel(event?: ReactPointerEvent<HTMLCanvasElement>) {
    zugBeenden(event, false);
  }

  /* ---------- Werkzeugbefehle ---------- */

  function drehen(schritte: number) {
    merken();
    setDoc((wert) => (wert ? { ...wert, drehung: weiterdrehen(wert.drehung, schritte) } : wert));
  }

  function spiegeln() {
    merken();
    setDoc((wert) => (wert ? { ...wert, spiegel: !wert.spiegel } : wert));
  }

  function verhaeltnisSetzen(wert: number | null) {
    setVerhaeltnis(wert);
    verhaeltnisRef.current = wert;
    if (!bild || wert === null) return;
    merken();
    setDoc((aktuell) =>
      aktuell
        ? {
            ...aktuell,
            zuschnitt: aufVerhaeltnis(
              aktuell.zuschnitt,
              // Das Verhältnis gilt für das, was man sieht; am hochkant
              // gedrehten Bild ist „16:9“ also quer zum Original.
              aktuell.drehung === 90 || aktuell.drehung === 270 ? 1 / wert : wert,
              bild.naturalWidth,
              bild.naturalHeight,
            ),
          }
        : aktuell,
    );
  }

  function zuschnittGanz() {
    if (!bild) return;
    merken();
    setDoc((wert) =>
      wert
        ? { ...wert, zuschnitt: { x: 0, y: 0, w: bild.naturalWidth, h: bild.naturalHeight } }
        : wert,
    );
  }

  function textHinzufuegen() {
    if (!bild || !doc) return;
    merken();
    const id = `t${Date.now().toString(36)}${Math.round(Math.random() * 1e6).toString(36)}`;
    const sicht = ansichtGroesse(bild.naturalWidth, bild.naturalHeight, doc.drehung);
    const mitte = nachOriginal(
      { x: sicht.w / 2, y: sicht.h / 2 },
      bild.naturalWidth,
      bild.naturalHeight,
      doc,
    );
    const neu: Schriftzug = {
      id,
      text: 'Text',
      x: mitte.x,
      y: mitte.y,
      groesse: Math.round(Math.max(sicht.w, sicht.h) / 12),
      farbe: '#ffffff',
      kontur: '#111111',
      schrift: 'system',
      fett: true,
    };
    setDoc((wert) => (wert ? { ...wert, texte: [...wert.texte, neu] } : wert));
    setGewaehlterText(id);
    setWerkzeug('text');
  }

  const aktiverText = useMemo(
    () => doc?.texte.find((text) => text.id === gewaehlterText) ?? null,
    [doc, gewaehlterText],
  );

  /**
   * Merkt gebündelt: mehrere gleichartige Änderungen kurz nacheinander werden
   * zu EINEM Rückgängig-Schritt.
   *
   * Ohne das legte jeder Tastendruck im Textfeld und jede Raste am
   * Größenregler einen eigenen Schritt an – nach dem Tippen eines Wortes wäre
   * der Verlauf (25 Schritte) voll und alles davor fort. Mit dem Muster aus
   * dem Sticker-Studio: gleiche Art innerhalb einer Sekunde = ein Schritt.
   */
  const letzteBuendelung = useRef<{ art: string; zeit: number }>({ art: '', zeit: 0 });
  const merkenGebuendelt = useCallback(
    (art: string) => {
      const jetzt = Date.now();
      const vorher = letzteBuendelung.current;
      letzteBuendelung.current = { art, zeit: jetzt };
      if (vorher.art === art && jetzt - vorher.zeit < 1000) return;
      merken();
    },
    [merken],
  );

  function textAendern(aenderung: Partial<Schriftzug>) {
    if (!aktiverText) return;
    // Vorher fehlte das ganz: Text tippen, Farbe und Größe waren nicht
    // rücknehmbar, während Löschen es korrekt war.
    merkenGebuendelt(`text:${aktiverText.id}:${Object.keys(aenderung).join(',')}`);
    setDoc((wert) =>
      wert
        ? {
            ...wert,
            texte: wert.texte.map((text) =>
              text.id === aktiverText.id ? { ...text, ...aenderung } : text,
            ),
          }
        : wert,
    );
  }

  function textLoeschen() {
    if (!aktiverText) return;
    merken();
    setDoc((wert) =>
      wert ? { ...wert, texte: wert.texte.filter((text) => text.id !== aktiverText.id) } : wert,
    );
    setGewaehlterText(null);
  }

  /* ---------- Speichern ---------- */

  async function ergebnis(): Promise<{ blob: Blob; name: string } | null> {
    if (!bild || !doc) return null;
    const canvas = zeichneAusgabe(bild, bild.naturalWidth, bild.naturalHeight, doc);
    // WebP ist bei gleicher Güte deutlich kleiner; ältere Geräte, die es nicht
    // schreiben können, bekommen still JPEG – `toBlob` sagt im `type` des
    // Ergebnisses, was daraus geworden ist.
    const blob = await new Promise<Blob | null>((auf) =>
      canvas.toBlob((wert) => auf(wert), 'image/webp', 0.92),
    );
    const fertig =
      blob ??
      (await new Promise<Blob | null>((auf) =>
        canvas.toBlob((wert) => auf(wert), 'image/jpeg', 0.92),
      ));
    if (!fertig) {
      toast('Das bearbeitete Bild konnte nicht erzeugt werden.', 'error');
      return null;
    }
    const endung = fertig.type === 'image/webp' ? 'webp' : 'jpg';
    return { blob: fertig, name: bearbeiteterName(name, endung) };
  }

  async function aufsHandy() {
    setSpeichert(true);
    try {
      const fertig = await ergebnis();
      if (!fertig) return;
      await herunterladen(fertig.blob, fertig.name);
    } catch (error) {
      toast(errorMessage(error, 'Speichern fehlgeschlagen'), 'error');
    } finally {
      setSpeichert(false);
    }
  }

  async function inDieApp() {
    if (!onFertig) return;
    setSpeichert(true);
    try {
      const fertig = await ergebnis();
      if (!fertig) return;
      await onFertig(fertig.blob, fertig.name);
      onClose();
    } catch (error) {
      toast(errorMessage(error, 'Speichern fehlgeschlagen'), 'error');
    } finally {
      setSpeichert(false);
    }
  }

  const unberuehrt = bild && doc ? docUnberuehrt(doc, bild.naturalWidth, bild.naturalHeight) : true;

  return createPortal(
    <div className="bild-editor" role="dialog" aria-modal="true" aria-label="Bild bearbeiten">
      <header className="bild-kopf">
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Schließen">
          ✕
        </button>
        <strong className="truncate">Bild bearbeiten</strong>
        <button
          type="button"
          className="icon-btn"
          onClick={zurueck}
          disabled={!kannZurueck}
          aria-label="Rückgängig"
        >
          ↺
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={wieder}
          disabled={!kannVor}
          aria-label="Wiederherstellen"
        >
          ↻
        </button>
        {/* Nur sichtbar, wenn herangezoomt ist – ein Knopf, der immer „1×“
            sagt, ist Zierrat. Antippen setzt zurück. */}
        {lupe.zoom > 1 && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setLupe({ zoom: 1, x: 0, y: 0 })}
            aria-label="Ansicht zurücksetzen"
            title="Ansicht zurücksetzen"
          >
            🔍 {Math.round(lupe.zoom * 10) / 10}×
          </button>
        )}
      </header>

      <div className="bild-buehne">
        {laedt && <p className="bild-hinweis">Bild wird geladen …</p>}
        <canvas
          ref={canvasRef}
          className="bild-leinwand"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onContextMenu={(event) => event.preventDefault()}
        />
      </div>

      <div className="bild-panel">
        {werkzeug === 'zuschnitt' && (
          <>
            <div className="bild-reihe">
              <button type="button" className="btn btn-sm" onClick={() => drehen(-1)}>
                ↺ Links
              </button>
              <button type="button" className="btn btn-sm" onClick={() => drehen(1)}>
                ↻ Rechts
              </button>
              <button type="button" className="btn btn-sm" onClick={spiegeln}>
                ⇄ Spiegeln
              </button>
              <button type="button" className="btn btn-sm" onClick={zuschnittGanz}>
                Ganzes Bild
              </button>
            </div>
            <div className="bild-reihe">
              {VERHAELTNISSE.map((eintrag) => (
                <button
                  key={eintrag.label}
                  type="button"
                  className={`btn btn-sm ${verhaeltnis === eintrag.wert ? 'is-active' : ''}`}
                  aria-pressed={verhaeltnis === eintrag.wert}
                  onClick={() => verhaeltnisSetzen(eintrag.wert)}
                  title={
                    eintrag.wert === null
                      ? 'Ziehe die Ecken – ohne festes Verhältnis.'
                      : `Auf ${eintrag.label} zuschneiden`
                  }
                >
                  {eintrag.label}
                </button>
              ))}
            </div>
            <p className="bild-hinweis">
              Zieh an den Ecken oder Kanten. Innerhalb des Rahmens verschiebst du den Ausschnitt.
            </p>
          </>
        )}

        {werkzeug === 'malen' && (
          <>
            {/*
                Drei Pinsel statt einem. Verpixeln und Verwischen sind die
                zwei Werkzeuge, mit denen man ein Kennzeichen oder ein fremdes
                Gesicht unkenntlich macht, ohne einen schwarzen Balken über
                das halbe Bild zu ziehen.
            */}
            <div className="bild-reihe">
              {(
                [
                  ['farbe', '✏️ Malen'],
                  ['pixel', '▦ Verpixeln'],
                  ['weich', '💧 Verwischen'],
                ] as const
              ).map(([wert, beschriftung]) => (
                <button
                  key={wert}
                  type="button"
                  className={`btn btn-sm ${malart === wert ? 'is-active' : ''}`}
                  aria-pressed={malart === wert}
                  onClick={() => setMalart(wert)}
                >
                  {beschriftung}
                </button>
              ))}
            </div>
            {malart === 'farbe' && (
              <div className="bild-farben">
                {FARBEN.map((wert) => (
                  <button
                    key={wert}
                    type="button"
                    className={`bild-farbe ${farbe === wert ? 'is-active' : ''}`}
                    style={{ background: wert }}
                    onClick={() => setFarbe(wert)}
                    aria-label={`Farbe ${wert}`}
                  />
                ))}
              </div>
            )}
            <label className="bild-schieber">
              <span>Strich</span>
              <input
                type="range"
                min={2}
                max={80}
                value={breite}
                onChange={(event) => setBreite(Number(event.target.value))}
              />
              <span className="bild-wert">{breite}</span>
            </label>
            <div className="bild-reihe">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  merken();
                  setDoc((wert) => (wert ? { ...wert, striche: wert.striche.slice(0, -1) } : wert));
                }}
                disabled={!doc || doc.striche.length === 0}
              >
                Letzten Strich zurück
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  merken();
                  setDoc((wert) => (wert ? { ...wert, striche: [] } : wert));
                }}
                disabled={!doc || doc.striche.length === 0}
              >
                Alles wegwischen
              </button>
            </div>
            <p className="bild-hinweis">
              Der Strich klebt am Bild: Drehst du später, dreht er mit.
            </p>
          </>
        )}

        {werkzeug === 'text' && (
          <>
            <div className="bild-reihe">
              <button type="button" className="btn btn-sm" onClick={textHinzufuegen}>
                ＋ Schriftzug
              </button>
              {doc?.texte.map((text) => (
                <button
                  key={text.id}
                  type="button"
                  className={`btn btn-sm ${text.id === gewaehlterText ? 'is-active' : ''}`}
                  onClick={() => setGewaehlterText(text.id)}
                >
                  {text.text.split('\n')[0].slice(0, 12) || '(leer)'}
                </button>
              ))}
            </div>
            {aktiverText ? (
              <>
                <textarea
                  className="bild-textfeld"
                  rows={2}
                  value={aktiverText.text}
                  onChange={(event) => textAendern({ text: event.target.value })}
                  placeholder="Was soll draufstehen?"
                />
                <div className="bild-reihe">
                  {SCHRIFTEN.map((schrift) => (
                    <button
                      key={schrift.key}
                      type="button"
                      className={`btn btn-sm ${aktiverText.schrift === schrift.key ? 'is-active' : ''}`}
                      style={{ fontFamily: schrift.stack }}
                      onClick={() => textAendern({ schrift: schrift.key })}
                    >
                      {schrift.label}
                    </button>
                  ))}
                </div>
                <div className="bild-farben">
                  {FARBEN.map((wert) => (
                    <button
                      key={wert}
                      type="button"
                      className={`bild-farbe ${aktiverText.farbe === wert ? 'is-active' : ''}`}
                      style={{ background: wert }}
                      onClick={() => textAendern({ farbe: wert })}
                      aria-label={`Schriftfarbe ${wert}`}
                    />
                  ))}
                </div>
                <div className="bild-reihe">
                  <button
                    type="button"
                    className={`btn btn-sm ${aktiverText.fett ? 'is-active' : ''}`}
                    onClick={() => textAendern({ fett: !aktiverText.fett })}
                  >
                    <strong>F</strong> Fett
                  </button>
                  <button
                    type="button"
                    className={`btn btn-sm ${aktiverText.kontur ? 'is-active' : ''}`}
                    onClick={() =>
                      textAendern({
                        kontur: aktiverText.kontur
                          ? null
                          : aktiverText.farbe === '#111111'
                            ? '#ffffff'
                            : '#111111',
                      })
                    }
                    title="Eine Kontur hält die Schrift auch über unruhigem Bild lesbar."
                  >
                    ◌ Kontur {aktiverText.kontur ? 'an' : 'aus'}
                  </button>
                  {aktiverText.kontur && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() =>
                        textAendern({
                          kontur: aktiverText.kontur === '#111111' ? '#ffffff' : '#111111',
                        })
                      }
                    >
                      Kontur {aktiverText.kontur === '#111111' ? 'dunkel' : 'hell'}
                    </button>
                  )}
                  <button type="button" className="btn btn-sm" onClick={textLoeschen}>
                    🗑 Löschen
                  </button>
                </div>
                <label className="bild-schieber">
                  <span>Größe</span>
                  <input
                    type="range"
                    /*
                     * Feste Grenzen, abgeleitet von der Bildkante – nicht vom
                     * aktuellen Wert. Vorher war `min` an `groesse/8` gebunden:
                     * Wer die Schrift einmal gross machte, konnte sie nie
                     * wieder klein machen, weil die Skala mitwanderte.
                     */
                    min={Math.max(8, Math.round(schriftGrenzen.klein))}
                    max={Math.round(schriftGrenzen.gross)}
                    value={aktiverText.groesse}
                    onChange={(event) => textAendern({ groesse: Number(event.target.value) })}
                  />
                  <span className="bild-wert">{aktiverText.groesse}</span>
                </label>
                <p className="bild-hinweis">
                  Tipp ins Bild, um den Schriftzug dorthin zu setzen – oder zieh ihn an seinen
                  Platz.
                </p>
              </>
            ) : (
              <p className="bild-hinweis">
                Noch kein Schriftzug. „＋ Schriftzug“ legt einen in der Bildmitte an.
              </p>
            )}
          </>
        )}
      </div>

      <div className="bild-fuss">
        <div className="bild-reiter">
          <button
            type="button"
            className={`bild-reiter-knopf ${werkzeug === 'zuschnitt' ? 'is-active' : ''}`}
            onClick={() => setWerkzeug('zuschnitt')}
          >
            <span aria-hidden="true">✂️</span> Zuschnitt
          </button>
          <button
            type="button"
            className={`bild-reiter-knopf ${werkzeug === 'malen' ? 'is-active' : ''}`}
            onClick={() => setWerkzeug('malen')}
          >
            <span aria-hidden="true">✏️</span> Malen
          </button>
          <button
            type="button"
            className={`bild-reiter-knopf ${werkzeug === 'text' ? 'is-active' : ''}`}
            onClick={() => setWerkzeug('text')}
          >
            <span aria-hidden="true">🅣</span> Text
          </button>
        </div>
        {/* Gibt es keinen Ablageort in der App, ist „aufs Handy“ nicht die
            zweite Wahl, sondern die einzige – dann steht sie auch dort, wo man
            sie sucht, statt neben einem gesperrten Knopf. */}
        <div className="bild-reihe">
          <button
            type="button"
            className={onFertig ? 'btn btn-sm' : 'btn btn-primary'}
            onClick={() => void aufsHandy()}
            disabled={laedt || speichert}
          >
            ⬇ Aufs Handy {onFertig ? '' : 'speichern'}
          </button>
          {onFertig && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void inDieApp()}
              disabled={laedt || speichert}
            >
              {speichert ? '…' : (zielName ?? 'Als neue Datei sichern')}
            </button>
          )}
        </div>
        {unberuehrt && !laedt && (
          <p className="bild-hinweis">
            Noch nichts geändert – gespeichert würde eine Kopie des Originals.
          </p>
        )}
      </div>
    </div>,
    document.body,
  );
}
