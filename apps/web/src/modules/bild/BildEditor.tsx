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
  BEREICHE_MAX,
  BEREICH_NEUTRAL,
  type Bereich,
  type Bereichston,
  type BildDoc,
  type Malstrich,
  type Maskenteil,
  type Pinselstrich,
  type RadialTeil,
  type Schriftzug,
  type VerlaufTeil,
  type Zuschnitt,
} from './doc.js';
import { basisAus, lupeHalten, zoomAusSpanne } from './lupe.js';
import {
  FARB_NEUTRAL,
  NEUTRAL,
  autoAnpassung,
  istNeutral,
  type Anpassung,
  type Farbanpassung,
} from './ton.js';
import {
  fangBereich,
  griffTreffer,
  griffZiehen,
  griffeVon,
  type Griffname,
} from './bereichGriffe.js';
import { maskeFuerBereich } from './maskenSpeicher.js';
import { netzTeilRechnen, netzVerfuegbar, type Netzart } from './netzMaske.js';
import { SCHRIFTEN, trifftText, zeichneAnsicht, zeichneAusgabe } from './zeichnen.js';
import './styles.css';

type Werkzeug = 'zuschnitt' | 'ton' | 'bereich' | 'malen' | 'text';

/**
 * Die Tonwert-Regler, in der Reihenfolge, in der man sie benutzt.
 *
 * Von grob nach fein: erst wieviel Licht, dann wie es verteilt ist, dann die
 * Farbe, zuletzt der Feinschliff. Das ist die Reihenfolge, die jede
 * Dunkelkammer und jedes Bearbeitungsprogramm benutzt – und sie ist nicht
 * dieselbe wie die Reihenfolge, in der gerechnet wird.
 */
/**
 * Die Regler eines Bereichs.
 *
 * Dieselben neun Farbregler wie global, plus die Tiefenschärfe – und
 * ausdrücklich OHNE Schärfe und Vignette: Die eine braucht die Nachbarn eines
 * noch ungetönten Bildpunkts, die andere den Bildrand, und einen eigenen
 * Rand hat ein Bereich nicht.
 */
const BEREICHSREGLER: { key: keyof Bereichston; label: string; min: number; max: number }[] = [
  { key: 'belichtung', label: 'Belichtung', min: -3, max: 3 },
  { key: 'kontrast', label: 'Kontrast', min: -1, max: 1 },
  { key: 'lichter', label: 'Lichter', min: -1, max: 1 },
  { key: 'tiefen', label: 'Tiefen', min: -1, max: 1 },
  { key: 'schwarz', label: 'Schwarz', min: -1, max: 1 },
  { key: 'waerme', label: 'Wärme', min: -1, max: 1 },
  { key: 'toenung', label: 'Tönung', min: -1, max: 1 },
  { key: 'saettigung', label: 'Sättigung', min: -1, max: 1 },
  { key: 'dynamik', label: 'Dynamik', min: -1, max: 1 },
];

/** Eine Kennung, die sich nicht wiederholt. */
function neueId(vorsatz: string): string {
  return `${vorsatz}${Date.now().toString(36)}${Math.round(Math.random() * 1e6).toString(36)}`;
}

const TONREGLER: {
  key: keyof Anpassung;
  label: string;
  min: number;
  max: number;
  schritt: number;
  /** Wie der Wert unter dem Regler steht. */
  zeigen?: (wert: number) => string;
}[] = [
  {
    key: 'belichtung',
    label: 'Belichtung',
    min: -3,
    max: 3,
    schritt: 0.05,
    zeigen: (wert) => `${wert > 0 ? '+' : ''}${wert.toFixed(2)} EV`,
  },
  { key: 'kontrast', label: 'Kontrast', min: -1, max: 1, schritt: 0.01 },
  { key: 'lichter', label: 'Lichter', min: -1, max: 1, schritt: 0.01 },
  { key: 'tiefen', label: 'Tiefen', min: -1, max: 1, schritt: 0.01 },
  { key: 'schwarz', label: 'Schwarz', min: -1, max: 1, schritt: 0.01 },
  { key: 'waerme', label: 'Wärme', min: -1, max: 1, schritt: 0.01 },
  { key: 'toenung', label: 'Tönung', min: -1, max: 1, schritt: 0.01 },
  { key: 'saettigung', label: 'Sättigung', min: -1, max: 1, schritt: 0.01 },
  { key: 'dynamik', label: 'Dynamik', min: -1, max: 1, schritt: 0.01 },
  { key: 'schaerfe', label: 'Schärfe', min: 0, max: 1, schritt: 0.01 },
  { key: 'vignette', label: 'Vignette', min: -1, max: 1, schritt: 0.01 },
];

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
  /** Der gewählte Bereich und das gewählte Maskenteil darin. */
  const [bereichId, setBereichId] = useState<string | null>(null);
  const [teilId, setTeilId] = useState<string | null>(null);
  const [pinselBreite, setPinselBreite] = useState(30);
  const [pinselAbziehen, setPinselAbziehen] = useState(false);
  const [schleier, setSchleier] = useState(true);
  /** Was das Netz gerade tut – oder woran es gescheitert ist. */
  const [netzLaeuft, setNetzLaeuft] = useState<string | null>(null);
  const [netzFehler, setNetzFehler] = useState<string | null>(null);
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
  /*
   * Jeder Zustand, den ein Zeigerbehandler liest, braucht seinen Spiegel.
   * Die Behandler hängen nicht an React – sie sehen sonst den Stand vom
   * ersten Bild und nicht den von jetzt.
   */
  const bereichRef = useRef<string | null>(null);
  const teilRef = useRef<string | null>(null);
  const pinselBreiteRef = useRef(pinselBreite);
  const pinselAbziehenRef = useRef(pinselAbziehen);
  const schleierRef = useRef(schleier);
  const verlauf = useRef<BildDoc[]>([]);
  /** Der Vor-Stapel: was zurückgenommen wurde und wiederkommen kann. */
  const vor = useRef<BildDoc[]>([]);
  const massRef = useRef({ faktor: 1, breite: 1, hoehe: 1, versatz: { x: 0, y: 0 } });
  const rahmen = useRef<number | null>(null);
  const zug = useRef<{
    art: 'keiner' | 'zuschnitt' | 'malen' | 'text' | 'bereich' | 'pinsel';
    griff: string;
    /** Das Maskenteil, wie es beim Aufsetzen aussah – Griffe rechnen daraus. */
    startTeil: VerlaufTeil | RadialTeil | null;
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
    startTeil: null,
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
  useEffect(() => {
    bereichRef.current = bereichId;
  }, [bereichId]);
  useEffect(() => {
    teilRef.current = teilId;
  }, [teilId]);
  useEffect(() => {
    pinselBreiteRef.current = pinselBreite;
  }, [pinselBreite]);
  useEffect(() => {
    pinselAbziehenRef.current = pinselAbziehen;
  }, [pinselAbziehen]);
  useEffect(() => {
    schleierRef.current = schleier;
    planenRef.current?.();
  }, [schleier]);

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
        bereichZeigen:
          werkzeugRef.current === 'bereich'
            ? {
                maske: bereichMaske(aktuell, quellBild.naturalWidth, quellBild.naturalHeight),
                teil: teilFinden(aktuell),
                schleier: schleierRef.current,
              }
            : undefined,
      },
    );
    if (mass) massRef.current = mass;
  }, []);

  /** Die Maske des gewählten Bereichs – für den Schleier. */
  function bereichMaske(aktuell: BildDoc, breite: number, hoehe: number) {
    const bereich = aktuell.bereiche.find((b) => b.id === bereichRef.current);
    if (!bereich) return null;
    return maskeFuerBereich(bereich, breite, hoehe);
  }

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
  }, [werkzeug, bereichId, teilId, planen]);

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

  /** Das gerade gewählte Maskenteil, oder nichts. */
  function teilFinden(aktuell: BildDoc): Maskenteil | null {
    const bereich = aktuell.bereiche.find((b) => b.id === bereichRef.current);
    return bereich?.teile.find((t) => t.id === teilRef.current) ?? null;
  }

  /**
   * Ersetzt ein Maskenteil – und legt dabei ein NEUES `teile`-Feld an.
   *
   * Daran hängt der Zwischenspeicher: Ist das Feld dasselbe Objekt, gilt die
   * gerasterte Maske weiter. Wer hier an Ort und Stelle änderte, bekäme eine
   * Maske, die sich nicht mehr bewegt – und einen Rückgängig-Verlauf, dessen
   * ältere Schritte stillschweigend mitwandern.
   */
  function teilErsetzen(teilNeu: Maskenteil) {
    setDoc((wert) =>
      wert
        ? {
            ...wert,
            bereiche: wert.bereiche.map((b) =>
              b.id === bereichRef.current
                ? { ...b, teile: b.teile.map((t) => (t.id === teilNeu.id ? teilNeu : t)) }
                : b,
            ),
          }
        : wert,
    );
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
        startTeil: null,
        begonnen: false,
      };
      return;
    }

    if (werkzeugRef.current === 'bereich') {
      const teil = teilFinden(aktuell);
      const amBild = nachOriginal(punkt, W, H, aktuell);
      if (teil && (teil.art === 'verlauf' || teil.art === 'radial')) {
        const griff = griffTreffer(griffeVon(teil), amBild, fangBereich(massRef.current.faktor));
        if (griff) {
          zug.current = {
            art: 'bereich',
            griff,
            startTeil: teil,
            start: amBild,
            startZ: leer,
            startText: { x: 0, y: 0 },
            begonnen: false,
          };
          return;
        }
      }
      if (teil && teil.art === 'pinsel') {
        zug.current = {
          art: 'pinsel',
          griff: teil.id,
          startTeil: null,
          start: amBild,
          startZ: leer,
          startText: { x: 0, y: 0 },
          begonnen: false,
        };
        return;
      }
      // Kein Griff getroffen und kein Pinsel gewählt: Der Tipp bleibt ohne
      // Wirkung. Ausdrücklich, damit er nicht in den Textzweig fällt.
      zug.current = { ...zug.current, art: 'keiner', begonnen: false };
      return;
    }

    if (werkzeugRef.current === 'malen') {
      zug.current = {
        art: 'malen',
        griff: '',
        start: punkt,
        startZ: leer,
        startText: { x: 0, y: 0 },
        startTeil: null,
        begonnen: false,
      };
      return;
    }

    /*
     * Ab hier ist nur noch das Textwerkzeug zuständig – und das muss
     * ausdrücklich dastehen.
     *
     * Vorher fiel jedes Werkzeug, das oben keinen eigenen Zweig hat, hier
     * hindurch. Mit dem Reiter „Ton“ hiess das: Wer auf die Leinwand tippte,
     * um zu sehen, was seine Belichtung macht, versetzte nebenbei den zuletzt
     * gewählten Schriftzug quer durchs Bild. Der Fehler ist mit dem
     * Ton-Reiter entstanden und wäre mit jedem weiteren Werkzeug wieder
     * entstanden – deshalb ein Riegel und keine dritte Abfrage oben.
     */
    if (werkzeugRef.current !== 'text') {
      zug.current = { ...zug.current, art: 'keiner', begonnen: false };
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
        startTeil: null,
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
      startTeil: null,
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

    if (art === 'bereich') {
      const start = zug.current.startTeil;
      if (!start) return;
      zug.current = { ...zug.current, begonnen: true };
      const amBild = nachOriginal(punkt, W, H, aktuell);
      const gezogen = griffZiehen(start, zug.current.griff as Griffname, amBild, zug.current.start);
      const alt = teilFinden(aktuell);
      if (alt) teilErsetzen({ ...alt, ...gezogen } as Maskenteil);
      return;
    }

    if (art === 'pinsel') {
      const amBild = nachOriginal(punkt, W, H, aktuell);
      const teil = teilFinden(aktuell);
      if (!teil || teil.art !== 'pinsel') return;
      if (!zug.current.begonnen) {
        // Der Strich beginnt beim Aufsetzpunkt, nicht erst hier.
        zug.current = { ...zug.current, begonnen: true };
        const neu: Pinselstrich = {
          punkte: [zug.current.start.x, zug.current.start.y, amBild.x, amBild.y],
          // Wie beim Malstrich relativ zur Bildkante: Ein Pinsel, der auf
          // einem 1920er Bild fein ist, deckt auf einem 600er alles zu.
          breite:
            (pinselBreiteRef.current / 100) *
            (Math.max(quellBild.naturalWidth, quellBild.naturalHeight) / 6),
          haerte: 0.6,
          abziehen: pinselAbziehenRef.current,
        };
        teilErsetzen({ ...teil, striche: [...teil.striche, neu] });
        return;
      }
      const letzter = teil.striche[teil.striche.length - 1];
      if (!letzter) return;
      const striche = teil.striche.slice();
      striche[striche.length - 1] = {
        ...letzter,
        punkte: [...letzter.punkte, amBild.x, amBild.y],
      };
      teilErsetzen({ ...teil, striche });
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

  /**
   * Einen Tonwert-Regler setzen.
   *
   * Gebündelt je Regler: Wer einen Schieber über die halbe Skala zieht,
   * erzeugt hundert Änderungen. Ohne die Bündelung wäre der Verlauf nach
   * einem Zug voll und alles davor fort.
   */
  const tonSetzen = useCallback(
    (welcher: keyof Anpassung, wert: number) => {
      merkenGebuendelt(`ton-${welcher}`);
      setDoc((alt) => (alt ? { ...alt, anpassung: { ...alt.anpassung, [welcher]: wert } } : alt));
    },
    [merkenGebuendelt],
  );

  /**
   * Der Vorschlag der Automatik.
   *
   * Gerechnet wird auf einer stark verkleinerten Fassung des Bildes: Für ein
   * Histogramm braucht es keine zwölf Millionen Bildpunkte, und 65 536
   * liefern dieselben Perzentile auf zwei Stellen genau. Auf dem Original
   * dauerte derselbe Griff auf einem Telefon spürbar lange.
   */
  const automatik = useCallback(() => {
    const quellBild = bildRef.current;
    if (!quellBild) return;
    const kante = 256;
    const flaeche = document.createElement('canvas');
    flaeche.width = kante;
    flaeche.height = kante;
    const ctx = flaeche.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(quellBild, 0, 0, kante, kante);
    const daten = ctx.getImageData(0, 0, kante, kante).data;
    const histogramm = new Uint32Array(256);
    for (let i = 0; i < daten.length; i += 4) {
      const y = 0.2126 * daten[i] + 0.7152 * daten[i + 1] + 0.0722 * daten[i + 2];
      histogramm[Math.min(255, Math.max(0, Math.round(y)))] += 1;
    }
    merken();
    const vorschlag = autoAnpassung(histogramm);
    setDoc((alt) =>
      alt
        ? {
            ...alt,
            // Schärfe und Vignette bleiben, wie sie sind: Die Automatik
            // beurteilt Helligkeit und Farbe, nicht den Geschmack.
            anpassung: {
              ...vorschlag,
              schaerfe: alt.anpassung.schaerfe,
              vignette: alt.anpassung.vignette,
            },
          }
        : alt,
    );
  }, [merken]);

  /* ---------- örtliche Anpassungen ---------- */

  const aktiverBereich = useMemo(
    () => doc?.bereiche.find((b) => b.id === bereichId) ?? null,
    [doc, bereichId],
  );
  const aktivesTeil = useMemo(
    () => aktiverBereich?.teile.find((t) => t.id === teilId) ?? null,
    [aktiverBereich, teilId],
  );

  /**
   * Legt ein Maskenteil an – und mit ihm bei Bedarf einen neuen Bereich.
   *
   * Die Anfangslage wird im ANSICHTSRAUM gedacht und über `nachOriginal`
   * abgelegt: Ein Verlauf von oben nach unten soll auch auf einem gedrehten
   * Foto von oben nach unten laufen, und nicht plötzlich quer.
   */
  function teilAnlegen(art: 'verlauf' | 'radial' | 'pinsel') {
    const quellBild = bildRef.current;
    const aktuell = docRef.current;
    if (!quellBild || !aktuell) return;
    const W = quellBild.naturalWidth;
    const H = quellBild.naturalHeight;
    const sicht = ansichtGroesse(W, H, aktuell.drehung);
    const id = neueId('t');

    let teil: Maskenteil;
    if (art === 'verlauf') {
      teil = {
        id,
        modus: 'dazu',
        umkehren: false,
        art: 'verlauf',
        von: nachOriginal({ x: sicht.w / 2, y: sicht.h * 0.15 }, W, H, aktuell),
        bis: nachOriginal({ x: sicht.w / 2, y: sicht.h * 0.55 }, W, H, aktuell),
      };
    } else if (art === 'radial') {
      const mitte = nachOriginal({ x: sicht.w / 2, y: sicht.h / 2 }, W, H, aktuell);
      const kante = Math.min(W, H);
      teil = {
        id,
        modus: 'dazu',
        umkehren: false,
        art: 'radial',
        mitte,
        rx: kante * 0.3,
        ry: kante * 0.22,
        winkel: 0,
        weichheit: 0.5,
      };
    } else {
      teil = { id, modus: 'dazu', umkehren: false, art: 'pinsel', striche: [] };
    }

    merken();
    const vorhanden = aktuell.bereiche.find((b) => b.id === bereichRef.current);
    if (vorhanden) {
      setDoc((wert) =>
        wert
          ? {
              ...wert,
              bereiche: wert.bereiche.map((b) =>
                b.id === vorhanden.id ? { ...b, teile: [...b.teile, teil] } : b,
              ),
            }
          : wert,
      );
    } else {
      if (aktuell.bereiche.length >= BEREICHE_MAX) return;
      const neu: Bereich = {
        id: neueId('b'),
        name: `Bereich ${aktuell.bereiche.length + 1}`,
        aktiv: true,
        teile: [teil],
        anpassung: { ...BEREICH_NEUTRAL },
      };
      setDoc((wert) => (wert ? { ...wert, bereiche: [...wert.bereiche, neu] } : wert));
      setBereichId(neu.id);
    }
    setTeilId(id);
  }

  /**
   * Lässt ein lokales Netz laufen und hängt seine Maske an den Bereich.
   *
   * Der Lauf dauert gemessen 1,6 bis 1,8 Sekunden und hängt kaum an der
   * Bildgrösse – deshalb eine Fortschrittsanzeige und ein gesperrter Knopf,
   * statt eines Knopfes, der scheinbar nichts tut.
   */
  async function netzTeilAnlegen(netz: Netzart) {
    const quellBild = bildRef.current;
    const aktuell = docRef.current;
    if (!quellBild || !aktuell || netzLaeuft) return;
    if (!vorhandenOderPlatz(aktuell)) return;
    setNetzFehler(null);
    setNetzLaeuft('Wird vorbereitet …');
    try {
      const teil = await netzTeilRechnen(quellBild, netz, (text) => setNetzLaeuft(text));
      merken();
      const bereich = docRef.current?.bereiche.find((b) => b.id === bereichRef.current);
      if (bereich) {
        setDoc((wert) =>
          wert
            ? {
                ...wert,
                bereiche: wert.bereiche.map((b) =>
                  b.id === bereich.id ? { ...b, teile: [...b.teile, teil] } : b,
                ),
              }
            : wert,
        );
      } else {
        const neu: Bereich = {
          id: neueId('b'),
          name: netz === 'person' ? 'Person' : 'Motiv',
          aktiv: true,
          teile: [teil],
          anpassung: { ...BEREICH_NEUTRAL },
        };
        setDoc((wert) => (wert ? { ...wert, bereiche: [...wert.bereiche, neu] } : wert));
        setBereichId(neu.id);
      }
      setTeilId(teil.id);
    } catch (fehler) {
      // Der Satz aus dem `EngineError` ist für den Anwender geschrieben –
      // „Fehler“ hilft niemandem, „ist abgeschaltet, du kannst es
      // einschalten“ schon.
      setNetzFehler(errorMessage(fehler, 'Das Netz konnte nicht laufen'));
    } finally {
      setNetzLaeuft(null);
    }
  }

  /** Ob noch ein Bereich hineinpasst – oder schon einer gewählt ist. */
  function vorhandenOderPlatz(aktuell: BildDoc): boolean {
    if (aktuell.bereiche.some((b) => b.id === bereichRef.current)) return true;
    return aktuell.bereiche.length < BEREICHE_MAX;
  }

  function bereichAnlegen() {
    const aktuell = docRef.current;
    if (!aktuell || aktuell.bereiche.length >= BEREICHE_MAX) return;
    merken();
    const neu: Bereich = {
      id: neueId('b'),
      name: `Bereich ${aktuell.bereiche.length + 1}`,
      aktiv: true,
      teile: [],
      anpassung: { ...BEREICH_NEUTRAL },
    };
    setDoc((wert) => (wert ? { ...wert, bereiche: [...wert.bereiche, neu] } : wert));
    setBereichId(neu.id);
    setTeilId(null);
  }

  function bereichLoeschen(id: string) {
    merken();
    setDoc((wert) =>
      wert ? { ...wert, bereiche: wert.bereiche.filter((b) => b.id !== id) } : wert,
    );
    if (bereichId === id) {
      setBereichId(null);
      setTeilId(null);
    }
  }

  function teilLoeschen(id: string) {
    if (!aktiverBereich) return;
    merken();
    setDoc((wert) =>
      wert
        ? {
            ...wert,
            bereiche: wert.bereiche.map((b) =>
              b.id === aktiverBereich.id ? { ...b, teile: b.teile.filter((t) => t.id !== id) } : b,
            ),
          }
        : wert,
    );
    if (teilId === id) setTeilId(null);
  }

  function teilAendern(patch: Partial<Maskenteil>) {
    if (!aktivesTeil || !aktiverBereich) return;
    merkenGebuendelt(`teil-${aktivesTeil.id}-${Object.keys(patch).join(',')}`);
    setDoc((wert) =>
      wert
        ? {
            ...wert,
            bereiche: wert.bereiche.map((b) =>
              b.id === aktiverBereich.id
                ? {
                    ...b,
                    teile: b.teile.map((t) =>
                      t.id === aktivesTeil.id ? ({ ...t, ...patch } as Maskenteil) : t,
                    ),
                  }
                : b,
            ),
          }
        : wert,
    );
  }

  function bereichRegler(welcher: keyof Bereichston, wert: number) {
    if (!aktiverBereich) return;
    // Die Kennung MUSS den Bereich enthalten: Sonst fielen zwei Bereiche,
    // kurz nacheinander verstellt, in einen Rückgängig-Schritt.
    merkenGebuendelt(`bereich-${aktiverBereich.id}-${welcher}`);
    setDoc((wert2) =>
      wert2
        ? {
            ...wert2,
            bereiche: wert2.bereiche.map((b) =>
              b.id === aktiverBereich.id
                ? { ...b, anpassung: { ...b.anpassung, [welcher]: wert } }
                : b,
            ),
          }
        : wert2,
    );
  }

  const tonZuruecksetzen = useCallback(() => {
    merken();
    setDoc((alt) => (alt ? { ...alt, anpassung: { ...NEUTRAL } } : alt));
  }, [merken]);

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

      <div
        className={`bild-panel ${werkzeug === 'ton' || werkzeug === 'bereich' ? 'ist-ton' : ''}`}
      >
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

        {werkzeug === 'ton' && doc && (
          <>
            <div className="bild-reihe">
              <button type="button" className="btn btn-sm" onClick={automatik}>
                ✨ Automatik
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={tonZuruecksetzen}
                disabled={istNeutral(doc.anpassung)}
              >
                Zurücksetzen
              </button>
            </div>
            {TONREGLER.map((regler) => {
              const wert = doc.anpassung[regler.key];
              return (
                <label className="bild-schieber" key={regler.key}>
                  <span>{regler.label}</span>
                  <input
                    type="range"
                    min={regler.min}
                    max={regler.max}
                    step={regler.schritt}
                    value={wert}
                    onChange={(event) => tonSetzen(regler.key, Number(event.target.value))}
                    /* Doppeltippen setzt einen einzelnen Regler zurück – der
                       Griff, den man am häufigsten braucht und am seltensten
                       findet. */
                    onDoubleClick={() => tonSetzen(regler.key, 0)}
                  />
                  <span className="bild-wert">
                    {regler.zeigen
                      ? regler.zeigen(wert)
                      : `${wert > 0 ? '+' : ''}${Math.round(wert * 100)}`}
                  </span>
                </label>
              );
            })}
            <p className="bild-hinweis">
              Doppeltippen auf einen Regler stellt ihn zurück. Die Regler wirken auf das Foto, nicht
              auf das Gemalte oder die Schrift.
            </p>
          </>
        )}

        {werkzeug === 'bereich' && doc && (
          <>
            <div className="bild-reihe" role="group" aria-label="Bereiche">
              {doc.bereiche.map((bereich) => (
                <button
                  key={bereich.id}
                  type="button"
                  className={`btn btn-sm ${bereich.id === bereichId ? 'is-active' : ''}`}
                  aria-pressed={bereich.id === bereichId}
                  onClick={() => {
                    setBereichId(bereich.id);
                    setTeilId(bereich.teile[0]?.id ?? null);
                  }}
                >
                  {bereich.aktiv ? '' : '✗ '}
                  {bereich.name}
                </button>
              ))}
              {doc.bereiche.length < BEREICHE_MAX && (
                <button type="button" className="btn btn-sm" onClick={bereichAnlegen}>
                  ＋ Bereich
                </button>
              )}
            </div>

            <div className="bild-reihe" role="group" aria-label="Maske hinzufügen">
              <button type="button" className="btn btn-sm" onClick={() => teilAnlegen('verlauf')}>
                ↗ Verlauf
              </button>
              <button type="button" className="btn btn-sm" onClick={() => teilAnlegen('radial')}>
                ◎ Radial
              </button>
              <button type="button" className="btn btn-sm" onClick={() => teilAnlegen('pinsel')}>
                🖌 Pinsel
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void netzTeilAnlegen('person')}
                disabled={netzLaeuft !== null || !netzVerfuegbar('person')}
              >
                👤 Person
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void netzTeilAnlegen('object')}
                disabled={netzLaeuft !== null || !netzVerfuegbar('object')}
              >
                🖼 Motiv
              </button>
            </div>

            {netzLaeuft && <p className="bild-hinweis">⏳ {netzLaeuft}</p>}
            {netzFehler && (
              /*
               * Sichtbarer Text, kein Tooltip. Auf einem Telefon gibt es kein
               * Schweben, und ein Hinweis, den man nur mit der Maus sieht,
               * ist auf dem Zielgerät keiner – das war schon einmal eine
               * Meldung des Anwenders.
               */
              <p className="bild-hinweis bild-hinweis-warn">{netzFehler}</p>
            )}
            {!netzVerfuegbar('object') && !netzFehler && (
              <p className="bild-hinweis">
                „Motiv“ ist abgeschaltet und lädt beim ersten Mal 4 MB. Du kannst es in den
                Sticker-Einstellungen einschalten.
              </p>
            )}

            {aktiverBereich ? (
              <>
                <div className="bild-reihe" role="group" aria-label="Masken des Bereichs">
                  {aktiverBereich.teile.map((teil, nummer) => (
                    <button
                      key={teil.id}
                      type="button"
                      className={`btn btn-sm ${teil.id === teilId ? 'is-active' : ''}`}
                      aria-pressed={teil.id === teilId}
                      onClick={() => setTeilId(teil.id)}
                    >
                      {teil.modus === 'weg' ? '−' : teil.modus === 'nur' ? '∩' : '+'}{' '}
                      {teil.art === 'verlauf'
                        ? 'Verlauf'
                        : teil.art === 'radial'
                          ? 'Radial'
                          : teil.art === 'pinsel'
                            ? 'Pinsel'
                            : 'Motiv'}{' '}
                      {nummer + 1}
                    </button>
                  ))}
                  {aktiverBereich.teile.length === 0 && (
                    <span className="bild-hinweis">Noch keine Maske – wähle oben eine Form.</span>
                  )}
                </div>

                {aktivesTeil && (
                  <div className="bild-reihe">
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() =>
                        teilAendern({
                          modus:
                            aktivesTeil.modus === 'dazu'
                              ? 'weg'
                              : aktivesTeil.modus === 'weg'
                                ? 'nur'
                                : 'dazu',
                        })
                      }
                      title="Dazunehmen, wegnehmen oder schneiden"
                    >
                      {aktivesTeil.modus === 'dazu'
                        ? '+ Dazu'
                        : aktivesTeil.modus === 'weg'
                          ? '− Weg'
                          : '∩ Nur'}
                    </button>
                    <button
                      type="button"
                      className={`btn btn-sm ${aktivesTeil.umkehren ? 'is-active' : ''}`}
                      aria-pressed={aktivesTeil.umkehren}
                      onClick={() => teilAendern({ umkehren: !aktivesTeil.umkehren })}
                    >
                      ⇄ Umkehren
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => teilLoeschen(aktivesTeil.id)}
                    >
                      🗑 Maske
                    </button>
                  </div>
                )}

                {aktivesTeil?.art === 'radial' && (
                  <label className="bild-schieber">
                    <span>Weichheit</span>
                    <input
                      type="range"
                      min={0.02}
                      max={1}
                      step={0.01}
                      value={aktivesTeil.weichheit}
                      onChange={(event) =>
                        teilAendern({
                          weichheit: Number(event.target.value),
                        } as Partial<Maskenteil>)
                      }
                    />
                    <span className="bild-wert">{Math.round(aktivesTeil.weichheit * 100)}</span>
                  </label>
                )}

                {aktivesTeil?.art === 'pinsel' && (
                  <>
                    <div className="bild-reihe">
                      <button
                        type="button"
                        className={`btn btn-sm ${!pinselAbziehen ? 'is-active' : ''}`}
                        aria-pressed={!pinselAbziehen}
                        onClick={() => setPinselAbziehen(false)}
                      >
                        🖌 Malen
                      </button>
                      <button
                        type="button"
                        className={`btn btn-sm ${pinselAbziehen ? 'is-active' : ''}`}
                        aria-pressed={pinselAbziehen}
                        onClick={() => setPinselAbziehen(true)}
                      >
                        🧽 Radieren
                      </button>
                    </div>
                    <label className="bild-schieber">
                      <span>Pinsel</span>
                      <input
                        type="range"
                        min={4}
                        max={100}
                        value={pinselBreite}
                        onChange={(event) => setPinselBreite(Number(event.target.value))}
                      />
                      <span className="bild-wert">{pinselBreite}</span>
                    </label>
                  </>
                )}

                <div className="bild-reihe">
                  <button
                    type="button"
                    className={`btn btn-sm ${schleier ? 'is-active' : ''}`}
                    aria-pressed={schleier}
                    onClick={() => setSchleier((wert) => !wert)}
                  >
                    👁 Maske zeigen
                  </button>
                  <button
                    type="button"
                    className={`btn btn-sm ${aktiverBereich.aktiv ? 'is-active' : ''}`}
                    aria-pressed={aktiverBereich.aktiv}
                    onClick={() => {
                      merken();
                      setDoc((wert) =>
                        wert
                          ? {
                              ...wert,
                              bereiche: wert.bereiche.map((b) =>
                                b.id === aktiverBereich.id ? { ...b, aktiv: !b.aktiv } : b,
                              ),
                            }
                          : wert,
                      );
                    }}
                  >
                    {aktiverBereich.aktiv ? 'An' : 'Aus'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => bereichLoeschen(aktiverBereich.id)}
                  >
                    🗑 Bereich
                  </button>
                </div>

                {BEREICHSREGLER.map((regler) => {
                  const wert = aktiverBereich.anpassung[regler.key];
                  return (
                    <label className="bild-schieber" key={regler.key}>
                      <span>{regler.label}</span>
                      <input
                        type="range"
                        min={regler.min}
                        max={regler.max}
                        step={regler.key === 'belichtung' ? 0.05 : 0.01}
                        value={wert}
                        onChange={(event) => bereichRegler(regler.key, Number(event.target.value))}
                        onDoubleClick={() => bereichRegler(regler.key, 0)}
                      />
                      <span className="bild-wert">
                        {regler.key === 'belichtung'
                          ? `${wert > 0 ? '+' : ''}${wert.toFixed(2)} EV`
                          : `${wert > 0 ? '+' : ''}${Math.round(wert * 100)}`}
                      </span>
                    </label>
                  );
                })}
                <p className="bild-hinweis">
                  Der Bereich wirkt nur dort, wo seine Maske greift – rot eingefärbt, solange „Maske
                  zeigen“ an ist. Zieh an den weissen Griffen im Bild.
                </p>
              </>
            ) : (
              <p className="bild-hinweis">
                Ein Bereich ist eine Anpassung, die nur an einer Stelle wirkt: der Himmel dunkler,
                das Gesicht heller. Leg oben eine Form an.
              </p>
            )}
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
            className={`bild-reiter-knopf ${werkzeug === 'ton' ? 'is-active' : ''}`}
            onClick={() => setWerkzeug('ton')}
          >
            <span aria-hidden="true">🎚️</span> Ton
          </button>
          <button
            type="button"
            className={`bild-reiter-knopf ${werkzeug === 'bereich' ? 'is-active' : ''}`}
            onClick={() => setWerkzeug('bereich')}
          >
            <span aria-hidden="true">🎯</span> Bereiche
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
