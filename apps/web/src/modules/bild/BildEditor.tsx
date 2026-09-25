import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useDialogAnmeldung } from '../../lib/dialogAnmeldung.js';
import { ConfirmDialog } from '../profile/ConfirmDialog.js';
import { herunterladen } from '../../lib/herunterladen.js';
import { toast, useHideNav } from '../../state/ui.js';
import { errorMessage, loadImageFromBlob } from '../stickers/helpers.js';
import {
  ansichtAlsZuschnitt,
  ansichtGroesse,
  aufVerhaeltnis,
  docKopie,
  docUnberuehrt,
  docOhneBearbeitung,
  nachAnsicht,
  nachOriginal,
  neuesDoc,
  weiterdrehen,
  zuschnittHalten,
  wirksamerZuschnitt,
  zuschnittInAnsicht,
  BEREICHE_MAX,
  BEREICH_NEUTRAL,
  TOLERANZ_VORGABE,
  type Bereich,
  type Bereichston,
  type BildDoc,
  type Malstrich,
  type Maskenmodus,
  type Maskenteil,
  type Pinselstrich,
  type RadialTeil,
  type Schriftzug,
  type TippTeil,
  type VerlaufTeil,
  type Zuschnitt,
} from './doc.js';
import { NEIGUNG_MAX, neigungKlemmen } from './neigen.js';
import { basisAus, lupeHalten, zoomAusSpanne } from './lupe.js';
import {
  FARB_NEUTRAL,
  NEUTRAL,
  SCHAERFE_RADIUS_MAX,
  autoAnpassung,
  istNeutral,
  type Anpassung,
  type Farbanpassung,
  type Zahlfeld,
} from './ton.js';
import {
  fangBereich,
  griffTreffer,
  griffZiehen,
  griffeVon,
  type Griffname,
} from './bereichGriffe.js';
import { strichTreffer } from './maske.js';
import { VORLAGEN, vorlageAnwenden } from './vorlagen.js';
import { maskeFuerBereich } from './maskenSpeicher.js';
import { teilBefund } from './maske.js';
import { netzGrund, netzTeilRechnen, netzVerfuegbar, type Netzart } from './netzMaske.js';
import { tiefeGrund, tiefeVerfuegbar, tiefenTeilRechnen } from './tiefeNetz.js';
import { tippNetzVerfuegbar, tippTeilRechnen, tippVorlage } from './tippMaske.js';
import { engineInfo, firstUseMb } from '../stickers/engines/index.js';
import {
  freistellerFuer,
  gewaehlterFreisteller,
  readQualitaet,
  writeQualitaet,
  type Qualitaet,
} from '../stickers/engines/settings.js';
import type { EngineKey } from '../stickers/engines/types.js';
import { isEngineEnabled, writeEngineSetting } from '../stickers/engines/settings.js';
import { SCHRIFTEN, trifftText, zeichneAnsicht, zeichneAusgabe } from './zeichnen.js';
import { alleSchriftenBereit, schriftenBereit } from '../../lib/schriften.js';
import { rezeptHindernis, rezeptLohnt, rezeptMoeglich, rezeptSchreiben } from './rezept.js';
import { Kurvenfeld } from './Kurvenfeld.js';
import { flaeche2d } from './farbraum.js';
import { Entfaltungsfeld } from './Entfaltungsfeld.js';
import {
  BAENDER,
  BAENDER_NEUTRAL,
  KURVEN_NEUTRAL,
  type Farbband,
  type Kurven,
  type Kurvenpunkt,
} from './fein.js';
import {
  bildKennung,
  entwurfAlter,
  entwurfHolen,
  entwurfLoeschen,
  entwurfSichern,
} from './entwurf.js';
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
  /*
   * Die zwei Farbfilter fürs Schwarz-Weiss stehen NICHT hier.
   *
   * Sie tun nichts, solange nicht entsättigt wird – ein Regler, der bei jeder
   * normalen Einstellung wirkungslos ist, gehört nicht zwischen die, die
   * immer wirken. Sie erscheinen weiter unten, sobald die Sättigung im Minus
   * ist.
   */
  /*
   * Die Tiefenschärfe steht als Einzige NICHT im globalen Ton-Reiter.
   *
   * Sie ergibt dort keinen Sinn: Ein Bild gleichmässig unscharf zu machen ist
   * kein Effekt, sondern ein Fehler. Erst mit einer Maske wird daraus das,
   * was ein Objektiv tut – scharf hier, weich dort.
   */
  { key: 'unschaerfe', label: 'Weichzeichnen', min: 0, max: 1 },
];

/** Eine Kennung, die sich nicht wiederholt. */
function neueId(vorsatz: string): string {
  return `${vorsatz}${Date.now().toString(36)}${Math.round(Math.random() * 1e6).toString(36)}`;
}

/** Die vier Kurven, in der Reihenfolge, in der man sie anfasst. */
const KURVENKANAELE: { key: keyof Kurven; label: string; farbe: string }[] = [
  { key: 'gesamt', label: 'Gesamt', farbe: 'currentColor' },
  { key: 'rot', label: 'Rot', farbe: '#ef4444' },
  { key: 'gruen', label: 'Grün', farbe: '#22c55e' },
  { key: 'blau', label: 'Blau', farbe: '#3b82f6' },
];

/** Die drei Regler eines Farbbandes. */
const BANDREGLER: { key: keyof Farbband; label: string; tipp: string }[] = [
  {
    key: 'farbton',
    label: 'Farbton',
    tipp: 'Dreht diesen Farbbereich in Richtung seiner Nachbarn – Laub ins Gelbe oder ins Blaue',
  },
  {
    key: 'saettigung',
    label: 'Sättigung',
    tipp: 'Nur dieser Farbbereich wird kräftiger oder blasser',
  },
  {
    key: 'helligkeit',
    label: 'Helligkeit',
    tipp: 'Nur dieser Farbbereich wird heller oder dunkler – ein blauer Himmel ohne alles andere',
  },
];

const TONREGLER: {
  /* `Zahlfeld` und nicht `keyof Anpassung`: Seit Kurven und Bänder dazugehören,
     sind nicht mehr alle Felder von `Anpassung` Zahlen, und ein Schieber kann
     nur eine Zahl. */
  key: Zahlfeld;
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
  /*
   * Weite und Schwelle stehen direkt unter der Schärfe – sie gehören ihr.
   *
   * Beide waren vorher gar nicht einstellbar: Gerechnet wurde fest gegen die
   * vier direkten Nachbarn, also mit einem Radius von genau einem Punkt. Bei
   * einem Foto von zwölf Megapunkten fasst das nur die feinste Ebene an, und
   * das ist das Rauschen.
   */
  {
    key: 'schaerfeRadius',
    label: 'Schärfe-Weite',
    min: 0.5,
    max: SCHAERFE_RADIUS_MAX,
    schritt: 0.5,
  },
  { key: 'schaerfeSchwelle', label: 'Schärfe-Schwelle', min: 0, max: 1, schritt: 0.01 },
  { key: 'vignette', label: 'Vignette', min: -1, max: 1, schritt: 0.01 },
];

/**
 * Was jeder Regler tut – in einem Satz, für den Tooltip.
 *
 * Die Beschriftung nennt den Fachbegriff, und der sagt niemandem etwas, der
 * nicht ohnehin weiss, was er bedeutet. „Dynamik“ ist das beste Beispiel: Der
 * Name verrät nicht, dass der Regler blasse Farben anhebt und kräftige in
 * Ruhe lässt – und genau deshalb greift man zur Sättigung und wundert sich
 * über orange Gesichter.
 *
 * An einer Stelle, weil beide Reglerlisten – global und je Bereich – dieselben
 * Namen benutzen. Zwei Listen liefen unweigerlich auseinander.
 */
const REGLER_TIPP: Partial<Record<keyof Anpassung | keyof Bereichston, string>> = {
  belichtung: 'Macht das ganze Bild heller oder dunkler – wie eine längere Belichtungszeit.',
  kontrast: 'Zieht Hell und Dunkel auseinander. Zu viel davon frisst Zeichnung in beiden.',
  lichter: 'Holt Zeichnung in die hellen Stellen zurück – gegen ausgebrannten Himmel.',
  tiefen: 'Hellt die dunklen Stellen auf, ohne den Rest anzufassen.',
  schwarz: 'Legt fest, ab wo Dunkel wirklich Schwarz ist. Gibt dem Bild Halt.',
  waerme: 'Verschiebt die Farben zwischen kühlem Blau und warmem Gelb.',
  toenung: 'Der Ausgleich in die andere Richtung: zwischen Grün und Magenta.',
  saettigung: 'Verstärkt alle Farben gleichmässig. Ganz nach links wird das Bild grau.',
  dynamik: 'Hebt blasse Farben an und lässt kräftige Farben und Hauttöne in Ruhe.',
  schaerfe: 'Betont Kanten. Sparsam einsetzen – zu viel sieht nach Blech aus.',
  schaerfeRadius:
    'Wie breit der betonte Saum an einer Kante wird. Klein trifft feine Strukturen, gross wirkt auch auf einem grossen Foto.',
  schaerfeSchwelle:
    'Ab welchem Unterschied überhaupt geschärft wird. Höher heisst: glatte Flächen und Rauschen bleiben in Ruhe.',
  vignette: 'Dunkelt die Ecken ab und zieht den Blick zur Mitte.',
};

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

/**
 * Trägt das Dokument etwas, das zu EINEM Bild gehört?
 *
 * Jedes Maskenteil tut das: Netz, Tiefe und Tipp sind aus dem Bild
 * gerechnet, Verlauf, Ellipse und Pinsel an eine Stelle darin gezeichnet.
 * Frei davon sind nur Regler, Striche und Schrift.
 */
function haengtAmBild(doc: BildDoc): boolean {
  return doc.bereiche.some((bereich) => bereich.teile.length > 0);
}

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
  /**
   * Ein Seitenverhältnis, auf das der Zuschnitt sofort einrastet.
   *
   * Für Fälle, in denen das Ziel die Form vorgibt – ein Profilbild ist rund
   * und wird quadratisch gebraucht. Ohne das müsste jeder selbst auf 1:1
   * tippen, und wer es vergisst, bekommt ein Bild, das die App hinterher
   * mittig beschneidet, ohne zu fragen.
   */
  startVerhaeltnis?: number;
  /**
   * Ein Dokument, mit dem der Editor aufgeht, statt mit einem leeren.
   *
   * Damit lässt sich ein Rezept weiterbearbeiten: Das unberührte Bild kommt
   * als `quelle`, die Bearbeitung als Dokument – und beides passt zusammen,
   * weil alles darin in Originalpunkten steht.
   */
  startDoc?: BildDoc | null;
  /**
   * Wohin ein REZEPT geht: das unberührte Bild und die Anweisung daneben.
   *
   * Getrennt von `onFertig`, weil es etwas anderes verschickt – nicht ein
   * gerechnetes Ergebnis, sondern zwei Dateien. Fehlt es, gibt es den Knopf
   * nicht; er verspräche sonst etwas, das niemand entgegennimmt.
   */
  onRezept?: (original: Blob, rezept: Blob, name: string) => Promise<void> | void;
  /**
   * Wieviele WEITERE Bilder danebenliegen – für „auf alle übertragen“.
   *
   * Null oder fehlend heisst: Es gibt keinen Stapel, und der Knopf erscheint
   * gar nicht. Ein Knopf „auf alle 0 übertragen“ wäre eine Frage, die sich
   * selbst beantwortet.
   */
  stapelAnzahl?: number;
  /** Überträgt Licht und Farbe auf die anderen Bilder der Auswahl. */
  onStapel?: (anpassung: Anpassung) => Promise<void> | void;
  /**
   * Gibt die BEARBEITUNG heraus statt eines Bildes.
   *
   * Dafür gibt es genau einen Anwender: die Videobearbeitung. Dort wird an
   * einem einzelnen Bild eingestellt, und dasselbe Dokument läuft danach über
   * alle Bilder des Films. Ein gerechnetes Einzelbild nützte dort gar nichts.
   *
   * Steht es, verschwinden die drei üblichen Knöpfe. „Aufs Handy" und
   * „Rezept" wären an einem Standbild aus einem Film eine Sackgasse: Sie
   * lieferten ein Foto, und geholt war ein Film.
   */
  onDokument?: (doc: BildDoc, breite: number, hoehe: number) => Promise<void> | void;
  /** Was auf dem Knopf für `onDokument` steht. */
  dokumentName?: string;
  /**
   * Meldet JEDE Änderung am Dokument, sofort.
   *
   * Für die Videobearbeitung: Dort ist der Editor einer von vielen Blicken
   * auf den Film – ein Tipp in die Zeitleiste wechselt den Abschnitt, und
   * was bis dahin eingestellt war, muss schon beim Abschnitt liegen, nicht
   * erst nach einem Knopf. Steht es, gibt es beim Schliessen nichts mehr zu
   * verlieren, und die Rückfrage entfällt.
   *
   * `herkunft` sagt, zu welchem Bild und welcher Sitzung das Dokument
   * gehört. Zwischen einem neuen `quelle` und dem Ende des Ladens steht
   * noch das alte Dokument im Editor; wer in diesem Augenblick einen Regler
   * bewegt, meldet eine Änderung am ALTEN – und der Aufrufer muss sie
   * erkennen können.
   */
  onAenderung?: (doc: BildDoc, herkunft: { quelle: Blob; sitzung?: string }) => void;
  /**
   * Keinen Entwurf anlegen und keinen anbieten.
   *
   * Ein Entwurf hängt an den Bytes des Bildes. Ein Standbild aus einem Film
   * ist aber nur ein Blick auf einen Abschnitt; die Bearbeitung gehört dem
   * Abschnitt, und ein Entwurf dazu tauchte beim nächsten Film mit
   * demselben ersten Bild als Frage auf, die niemand versteht.
   */
  ohneEntwurf?: boolean;
  /** Was oben steht – ohne Angabe „Bild bearbeiten“. */
  titel?: string;
  /** Liegt über der Leinwand – die Wiedergabe im Videoeditor. */
  ueberBuehne?: ReactNode;
  /** Steht zwischen Leinwand und Werkzeugen – die Zeitleiste im Videoeditor. */
  unterBuehne?: ReactNode;
  /**
   * Wessen Bearbeitung gerade offen ist – im Videoeditor der Abschnitt.
   *
   * Wechselt sie, lädt der Editor `quelle` und `startDoc` neu und vergisst
   * seinen Rückgängig-Verlauf; der gehörte zu einem anderen Abschnitt.
   * Neu aufgebaut wird er dafür NICHT: Die Zeitleiste darunter behielte
   * sonst weder ihren Fokus noch einen laufenden Zug.
   */
  sitzung?: string;
  /** Werkzeuge und Rückgängig ruhen – etwa solange eine Maske mitgenommen wird. */
  gesperrt?: boolean;
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
export function BildEditor({
  quelle,
  name,
  onClose,
  onFertig,
  onDokument,
  dokumentName = 'Übernehmen',
  zielName,
  startVerhaeltnis,
  startDoc,
  onRezept,
  stapelAnzahl = 0,
  onStapel,
  onAenderung,
  ohneEntwurf = false,
  titel = 'Bild bearbeiten',
  ueberBuehne,
  unterBuehne,
  sitzung,
  gesperrt = false,
}: BildEditorProps) {
  useHideNav(true);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [bild, setBild] = useState<HTMLImageElement | null>(null);
  /*
   * Das Bild, wie es hereinkam – nur für „Zurücknehmen“ nach einer Entfaltung.
   *
   * Die Entfaltung ist der einzige Schritt in diesem Editor, der das QUELLBILD
   * ersetzt statt das Dokument zu ändern. Damit fasst der Rückgängig-Verlauf
   * sie nicht, und ohne diese Kopie wäre sie der einzige unumkehrbare Griff
   * hier – in einem Editor, in dem sonst alles zurückgeht.
   */
  const urbildRef = useRef<HTMLImageElement | null>(null);
  const [entfaltet, setEntfaltet] = useState(false);
  const [doc, setDoc] = useState<BildDoc | null>(null);
  const [werkzeug, setWerkzeug] = useState<Werkzeug>('zuschnitt');
  /**
   * Das gewählte Seitenverhältnis – und zwar dauerhaft.
   *
   * Vorher wandte `verhaeltnisSetzen` es genau einmal an; wer danach eine Ecke
   * zog, hatte es wieder verloren. „Auf 16:9 zuschneiden“ war damit kein
   * Modus, sondern eine einmalige Zurechtrückung.
   */
  const [verhaeltnis, setVerhaeltnis] = useState<number | null>(startVerhaeltnis ?? null);
  /** Was der Pinsel tut: malen, verpixeln oder verwischen. */
  const [malart, setMalart] = useState<'farbe' | 'pixel' | 'weich' | 'klon'>('farbe');
  const malartRef = useRef(malart);
  /*
   * Der Quellpunkt des Klonstempels, in Originalpunkten.
   *
   * Erst setzen, dann malen – wie in jedem Bildprogramm. Der Strich merkt
   * sich daraus einen VERSATZ, keinen festen Punkt: Wer eine Leitung
   * entlangfährt, nimmt fortlaufend den Himmel daneben, statt immer denselben
   * Fleck zu stempeln. Ein fester Punkt gäbe eine sichtbar wiederholte Kachel.
   */
  const [klonQuelle, setKlonQuelle] = useState<{ x: number; y: number } | null>(null);
  const klonQuelleRef = useRef(klonQuelle);
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
  /*
   * Taugt die Grafikeinheit für „Hohe Qualität“?
   *
   * Dieselbe Prüfung wie im Sticker-Studio, und aus demselben Grund: Die
   * Absage gehört an den Knopf, bevor 78 MB übertragen werden, nicht danach.
   * `netzVerfuegbar` allein genügt dafür nicht – es fragt nur den Schalter
   * und ob es WebAssembly gibt, nicht ob eine Grafikeinheit da ist.
   */
  const [schliessFrage, setSchliessFrage] = useState(false);
  /*
   * Die Kennung des Bildes, an der der Entwurf hängt.
   *
   * Sie steht erst fest, wenn die Bytes gelesen sind – bis dahin wird nichts
   * gespeichert. Ein Zustand und keine Referenz: Der Speicher-Effekt muss
   * anspringen, sobald sie da ist, sonst ginge der erste Zug am Regler
   * verloren.
   */
  const [kennung, setKennung] = useState<string | null>(null);
  const [entwurfsfrage, setEntwurfsfrage] = useState<{ doc: BildDoc; alter: string } | null>(null);
  const [grafikAus, setGrafikAus] = useState<{ grund: string } | null>(null);
  /* Zählt hoch, wenn ein Verfahren von hier aus eingeschaltet wurde: Die
     Einstellung liegt im Gerätespeicher und nicht im Zustand, also braucht
     das Neuzeichnen einen Anstoss. */
  const [, setEngineStand] = useState(0);
  useEffect(() => {
    let gilt = true;
    void import('../stickers/engines/ort-laufzeit.js')
      .then((modul) => modul.laufzeitEntscheiden())
      .then((laufzeit) => {
        if (!gilt) return;
        setGrafikAus(laufzeit.taugt ? null : { grund: laufzeit.grund ?? 'Keine Grafikeinheit.' });
      })
      .catch(() => {
        // Schlägt schon die Prüfung fehl, bleibt der Knopf bedienbar und die
        // Absage kommt wie bisher aus dem Verfahren selbst.
      });
    return () => {
      gilt = false;
    };
  }, []);
  /**
   * Die gewählte Güte des Freistellens – „niedrig" oder „hoch".
   *
   * Sie liegt im Gerätespeicher (`engines/settings.ts`) und wird von hier und
   * vom Sticker-Studio gemeinsam gelesen. Der Zustand daneben ist nur der
   * Spiegel für das Neuzeichnen; die Wahrheit steht im Speicher.
   */
  const [qualitaet, setQualitaet] = useState<Qualitaet>(() => readQualitaet());
  const qualitaetRef = useRef(qualitaet);
  const grafikAusRef = useRef(grafikAus);
  useEffect(() => {
    qualitaetRef.current = qualitaet;
  }, [qualitaet]);
  useEffect(() => {
    grafikAusRef.current = grafikAus;
  }, [grafikAus]);

  /**
   * Warum gerade gar nicht freigestellt werden kann – oder `null`.
   *
   * Ein Satz und kein Wahrheitswert: „Geht nicht" ohne Grund lässt den
   * Anwender raten, und raten heisst hier, den Knopf noch dreimal zu drücken.
   */
  const freistellerFehlt =
    gewaehlterFreisteller(qualitaet, grafikAus === null) === null
      ? netzGrund('object') || netzGrund('birefnet') || 'Kein Freistellverfahren eingeschaltet.'
      : null;

  const [teilId, setTeilId] = useState<string | null>(null);
  const [pinselBreite, setPinselBreite] = useState(30);
  /**
   * Was ein Zug mit dem Pinsel tut.
   *
   * „Radieren“ und „Strich löschen“ sind ausdrücklich zweierlei: Radieren
   * MALT negativ – es setzt einen neuen Strich, der wegnimmt. Strich löschen
   * nimmt einen vorhandenen Strich ZURÜCK, samt seiner Wirkung.
   *
   * Ein „letzten Strich zurücknehmen“ gibt es hier bewusst nicht: Das
   * vorhandene Rückgängig legt über `zugGemerkt` je Zug genau einen Schritt
   * an, kann das also schon. Ein zweiter Knopf daneben wäre derselbe Knopf.
   */
  const [pinselModus, setPinselModus] = useState<'malen' | 'radieren' | 'weg'>('malen');
  /**
   * Welche Vorlage gewählt ist und wie stark.
   *
   * Nur Bedienzustand, nicht Teil des Dokuments: Was die Vorlage bewirkt,
   * steht danach vollständig in `doc.anpassung`. Wer hinterher einen
   * einzelnen Regler verstellt, hat kein „halb gültiges“ Vorbild mehr – die
   * Auswahl fällt dann weg, und das ist ehrlicher, als eine Vorlage
   * anzuzeigen, die längst nicht mehr das ist, was im Bild steht.
   */
  const [vorlageId, setVorlageId] = useState<string | null>(null);
  const [kurvenKanal, setKurvenKanal] = useState<keyof Kurven>('gesamt');
  const [bandIndex, setBandIndex] = useState(0);
  const [vorlageStaerke, setVorlageStaerke] = useState(1);
  const pinselAbziehen = pinselModus === 'radieren';
  const [schleier, setSchleier] = useState(true);
  /*
   * Das Antippen in den Bereichen – dieselbe Handhabung wie im Sticker-Studio.
   *
   * `bereichModus` steht hier und nicht als sechstes Werkzeug oben: Antippen
   * ist kein anderes WERKZEUG, es ist eine andere Art, im selben Werkzeug eine
   * Maske zu machen. Wer es als Werkzeug führte, müsste beim Wechsel den
   * Bereich neu wählen und die Maskenliste verlöre ihren Platz.
   */
  const [bereichModus, setBereichModus] = useState<'griffe' | 'antippen'>('griffe');
  /*
   * „mit Netz“ aus derselben Kiste wie im Studio (`localStorage`, Schlüssel
   * der Verfahren). Wer dort einmal eingeschaltet hat, findet es hier an –
   * es ist dasselbe Modell und dieselbe Entscheidung über 30 MB.
   */
  const [tippMitNetz, setTippMitNetz] = useState(() => isEngineEnabled('tippen'));
  const [tippVorzeichen, setTippVorzeichen] = useState<'dazu' | 'weg'>('dazu');
  const [tippToleranz, setTippToleranz] = useState(TOLERANZ_VORGABE);
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
  const bereichModusRef = useRef(bereichModus);
  const tippMitNetzRef = useRef(tippMitNetz);
  const tippVorzeichenRef = useRef(tippVorzeichen);
  const tippToleranzRef = useRef(tippToleranz);
  /**
   * Ob gerade ein Tipp gerechnet wird.
   *
   * Von Hand gesetzt und nicht aus `netzLaeuft` abgeleitet: Zwei Tipps im
   * selben Bild sähen sonst beide ein freies Netz, weil der Zustand erst
   * nach dem nächsten Bild bei den Zeigerbehandlern ankommt. Genau dieser
   * Fehler ist im Sticker-Studio schon einmal gemacht worden.
   */
  const tippRechnetRef = useRef(false);
  /**
   * Die Nummer des laufenden Tipps.
   *
   * Steigt bei jedem Lauf. Kommt ein Ergebnis zurück, dessen Nummer nicht
   * mehr die aktuelle ist, gehört es zu einem Stand, den es nicht mehr gibt –
   * es wird fallen gelassen, statt eine Maske wieder auferstehen zu lassen,
   * die jemand gerade zurückgenommen hat.
   */
  const tippLaufRef = useRef(0);
  /** Der Wecker des Toleranzreglers – siehe `toleranzSchieben`. */
  const toleranzUhr = useRef<number | null>(null);
  const pinselModusRef = useRef(pinselModus);
  const pinselAbziehenRef = useRef(pinselAbziehen);
  const schleierRef = useRef(schleier);
  const verlauf = useRef<BildDoc[]>([]);
  /** Der Vor-Stapel: was zurückgenommen wurde und wiederkommen kann. */
  const vor = useRef<BildDoc[]>([]);
  const massRef = useRef({ faktor: 1, breite: 1, hoehe: 1, versatz: { x: 0, y: 0 } });
  const rahmen = useRef<number | null>(null);
  const zug = useRef<{
    art: 'keiner' | 'zuschnitt' | 'malen' | 'text' | 'bereich' | 'pinsel' | 'antippen';
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
  /*
   * Der Wecker des Toleranzreglers, wenn der Editor zugeht.
   *
   * Ohne das schlägt er eine Fünftelsekunde nach dem Schliessen noch einmal
   * an, greift auf `docRef` zu und setzt Zustand an einer Komponente, die es
   * nicht mehr gibt.
   */
  useEffect(
    () => () => {
      if (toleranzUhr.current !== null) window.clearTimeout(toleranzUhr.current);
    },
    [],
  );
  useEffect(() => {
    bereichModusRef.current = bereichModus;
    tippMitNetzRef.current = tippMitNetz;
    tippVorzeichenRef.current = tippVorzeichen;
    tippToleranzRef.current = tippToleranz;
  }, [bereichModus, tippMitNetz, tippVorzeichen, tippToleranz]);
  useEffect(() => {
    pinselModusRef.current = pinselModus;
    pinselAbziehenRef.current = pinselAbziehen;
  }, [pinselModus, pinselAbziehen]);
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

  /*
   * „Vorher“ – halten, um das unbearbeitete Bild zu sehen.
   *
   * Der Vergleich ist das Werkzeug, mit dem man entscheidet, ob eine
   * Bearbeitung besser ist; ohne ihn schiebt man Regler und glaubt. Jede
   * Vergleichsapp hat ihn, diese hatte ihn nicht.
   *
   * Als Ref UND als Zustand: Der Ref wird beim Zeichnen gelesen (das läuft
   * ausserhalb von React), der Zustand färbt den Knopf.
   */
  const vergleichRef = useRef(false);
  const [vergleich, setVergleich] = useState(false);
  /**
   * Gibt es überhaupt eine Bearbeitung zu vergleichen?
   *
   * Ohne das wäre „Vorher" bei einem frisch geöffneten Bild ein Knopf, der
   * sichtbar nichts tut – und ein Knopf, der nichts tut, ist schlimmer als
   * keiner. Der Zuschnitt zählt hier NICHT: Er bleibt im Vergleich stehen
   * (siehe `docOhneBearbeitung`), also gäbe es auch nichts zu sehen.
   */
  const hatBearbeitung = useMemo(() => {
    if (!doc) return false;
    return (
      !istNeutral(doc.anpassung) ||
      doc.bereiche.length > 0 ||
      doc.striche.length > 0 ||
      doc.texte.length > 0
    );
  }, [doc]);

  const vergleichSetzen = useCallback((an: boolean) => {
    vergleichRef.current = an;
    setVergleich(an);
    planenRef.current?.();
  }, []);

  const planenRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    malartRef.current = malart;
  }, [malart]);
  useEffect(() => {
    klonQuelleRef.current = klonQuelle;
    planenRef.current?.();
  }, [klonQuelle]);

  useEffect(() => {
    lupeRef.current = lupe;
    planenRef.current?.();
  }, [lupe]);

  const zeichnen = useCallback(() => {
    const canvas = canvasRef.current;
    const quellBild = bildRef.current;
    const aktuell = docRef.current;
    if (!canvas || !quellBild || !aktuell) return;
    /*
     * Beim Vergleich dasselbe Bild ohne Bearbeitung – und ohne Beiwerk.
     *
     * Der Zuschnitt bleibt (siehe `docOhneBearbeitung`), Griffe und
     * Maskenschleier gehen weg: Wer vergleicht, will zwei Bilder sehen und
     * nicht zwei Bilder mit Werkzeugkram darüber.
     */
    const vergleich = vergleichRef.current;
    const gezeigt = vergleich ? docOhneBearbeitung(aktuell) : aktuell;
    const mass = zeichneAnsicht(
      canvas,
      quellBild,
      quellBild.naturalWidth,
      quellBild.naturalHeight,
      gezeigt,
      {
        maxKante: ansichtsKante(),
        zuschnittZeigen: !vergleich && werkzeugRef.current === 'zuschnitt',
        zoom: lupeRef.current.zoom,
        versatz: { x: lupeRef.current.x, y: lupeRef.current.y },
        bereichZeigen:
          !vergleich && werkzeugRef.current === 'bereich'
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

  /*
   * Die Schriften holen, sobald der Editor aufgeht – nicht erst beim
   * Speichern.
   *
   * Sonst sähe die Arbeitsansicht eine andere Schrift als das Ergebnis: Man
   * setzt einen Schriftzug, rückt ihn nach der Ersatzschrift zurecht, und
   * beim Speichern steht plötzlich eine breitere darin. Danach neu zeichnen,
   * damit das Bild auf dem Schirm die richtige zeigt.
   */
  useEffect(() => {
    let gilt = true;
    void alleSchriftenBereit().then(() => {
      if (gilt) planenRef.current?.();
    });
    return () => {
      gilt = false;
    };
  }, []);

  useEffect(() => {
    docRef.current = doc;
    bildRef.current = bild;
    planen();
  }, [doc, bild, planen]);

  useEffect(() => {
    planen();
  }, [werkzeug, bereichId, teilId, planen]);

  /*
   * Schliessen fragt nach, wenn etwas zu verlieren ist.
   *
   * Der Editor ging bisher wortlos zu – über das ✕ wie über die
   * Zurück-Geste. Was dabei verschwand, ist mehr als ein paar Reglerstände:
   * Ein Tiefenmodell rechnet drei Sekunden, ein Freisteller ebenso, und
   * beides ist danach noch einmal fällig. Dieselbe Rückfrage wie im
   * Sticker-Studio, aus demselben Grund.
   *
   * Gefragt wird nur, wenn es etwas zu verlieren gibt: `hatBearbeitung`
   * deckt Regler, Bereiche, Striche und Schrift ab, der Zuschnitt kommt hier
   * dazu – er ist beim Vergleich zwar keine Änderung, beim Verwerfen aber
   * sehr wohl eine.
   */
  const etwasZuVerlieren = useCallback(() => {
    if (!docRef.current) return false;
    const d = docRef.current;
    return hatBearbeitung || d.drehung !== 0 || d.neigung !== 0 || d.spiegel || kannZurueck;
  }, [hatBearbeitung, kannZurueck]);

  const schliessenVersuchen = useCallback(() => {
    if (onAenderung || !etwasZuVerlieren()) {
      onClose();
      return;
    }
    setSchliessFrage(true);
  }, [etwasZuVerlieren, onAenderung, onClose]);

  // Zurück-Taste schliesst den Editor, statt aus der App zu fallen.
  useDialogAnmeldung(true, schliessenVersuchen);

  /*
   * `onClose` über eine Referenz, nicht über die Abhängigkeiten.
   *
   * Fast jeder Aufrufer gibt hier eine frisch erzeugte Funktion herein
   * (`onClose={() => setzen(false)}`), und die ändert bei jedem Rendern des
   * ELTERNTEILS ihre Kennung. Stand sie im Abhängigkeitsfeld des Ladeeffekts,
   * lud dieser das Bild neu und setzte ein frisches Dokument – mitten in der
   * Arbeit. Nachgestellt: Während „Auf alle übertragen" läuft, meldet das
   * Auswahlblatt seinen Fortschritt über den Zustand, rendert dabei neu, und
   * die Belichtung im offenen Editor sprang von 1,5 zurück auf 0.
   *
   * Dasselbe Muster und dieselbe Begründung stehen in `components/Sheet.tsx`.
   */
  const schliessenRef = useRef(onClose);
  schliessenRef.current = onClose;
  const letzteSitzung = useRef(sitzung);
  /** Zu welchem Bild und welcher Sitzung das Dokument im Editor gerade gehört. */
  const herkunftRef = useRef<{ quelle: Blob; sitzung?: string }>({ quelle, sitzung });

  useEffect(() => {
    let weg = false;
    loadImageFromBlob(quelle)
      .then((geladen) => {
        if (weg) return;
        setBild(geladen);
        /*
         * Ein neues Bild MITTEN in der Sitzung – das gibt es nur im
         * Videoeditor: ein anderes Stellbild, oder ein anderer Abschnitt.
         *
         * Ein anderer Abschnitt nimmt den Rückgängig-Verlauf nicht mit; er
         * gehörte zu einer anderen Bearbeitung. Dasselbe gilt für ein anderes
         * Stellbild, sobald im Verlauf etwas steht, das zu EINEM Bild gehört –
         * eine Maske, eine Tiefe, eine Form: Zurückgeholt läge sie über einem
         * Bild, zu dem sie nie gehörte. Nachgestellt: Tipp, ↺, Stellbild
         * verschoben, ↻ – und die Maske des alten Bildes galt für das neue.
         */
        const neueSitzung = letzteSitzung.current !== sitzung;
        letzteSitzung.current = sitzung;
        herkunftRef.current = { quelle, sitzung };
        if (neueSitzung || [...verlauf.current, ...vor.current].some(haengtAmBild)) {
          verlauf.current = [];
          vor.current = [];
          setKannZurueck(false);
          setKannVor(false);
        }
        if (neueSitzung) {
          setBereichId(null);
          setTeilId(null);
          setLupe({ zoom: 1, x: 0, y: 0 });
        }
        /*
         * Ein mitgebrachtes Dokument gilt – aber nur, wenn es zu DIESEM Bild
         * gehört.
         *
         * Es kommt aus einem Rezept, also von einem anderen Gerät, und alles
         * darin steht in Originalpunkten. Passten die Masse nicht, läge jeder
         * Verlauf, jede Ellipse und jeder Zuschnitt an der falschen Stelle –
         * und zwar plausibel falsch, nicht sichtbar kaputt.
         */
        const passt =
          startDoc &&
          startDoc.zuschnitt.x + startDoc.zuschnitt.w <= geladen.naturalWidth &&
          startDoc.zuschnitt.y + startDoc.zuschnitt.h <= geladen.naturalHeight;
        const frisch = passt
          ? docKopie(startDoc)
          : neuesDoc(geladen.naturalWidth, geladen.naturalHeight);
        if (startVerhaeltnis) {
          verhaeltnisRef.current = startVerhaeltnis;
          frisch.zuschnitt = aufVerhaeltnis(
            frisch.zuschnitt,
            startVerhaeltnis,
            geladen.naturalWidth,
            geladen.naturalHeight,
          );
        }
        setDoc(frisch);

        /*
         * Nach einem liegengebliebenen Entwurf sehen – aber nur, wenn keiner
         * mitgebracht wurde.
         *
         * Ein `startDoc` kommt aus einem Rezept und ist die ausdrückliche
         * Absicht des Anwenders („diese Bearbeitung weiterdrehen"). Sie mit
         * einer Frage nach einem alten Entwurf zu überschreiben, wäre die
         * falsche Reihenfolge.
         */
        if (ohneEntwurf) return;
        void (async () => {
          const id = await bildKennung(quelle);
          if (weg) return;
          setKennung(id);
          if (passt) return;
          const fund = await entwurfHolen(id, geladen.naturalWidth, geladen.naturalHeight);
          if (weg || !fund) return;
          setEntwurfsfrage({ doc: fund.doc, alter: entwurfAlter(fund.stand) });
        })();
      })
      .catch((error: unknown) => {
        if (weg) return;
        toast(errorMessage(error, 'Das Bild konnte nicht geladen werden'), 'error');
        schliessenRef.current();
      })
      .finally(() => {
        if (!weg) setLaedt(false);
      });
    return () => {
      weg = true;
    };
    // `startVerhaeltnis`, `startDoc`, `ohneEntwurf` und `onClose` gehören bewusst nicht in
    // die Abhängigkeiten: Die ersten beiden geben den ANFANGSstand vor,
    // `onClose` läuft über eine Referenz (siehe oben). Stünde eines davon
    // hier, würde ein Wechsel das Bild neu laden und jede Bearbeitung
    // wegwerfen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quelle, sitzung]);

  /*
   * Der Entwurf wird beim ARBEITEN fortgeschrieben, nicht beim Verlassen.
   *
   * Das ist der ganze Punkt: Gegen den falschen Fingertipp hilft die Frage
   * beim Schliessen. Gegen einen abgestürzten Browser, einen geschlossenen
   * Tab oder ein Telefon, das die Seite aus dem Speicher wirft, hilft nur
   * etwas, das schon vorher auf der Platte liegt.
   *
   * Eine Dreiviertelsekunde Ruhe: Ein Reglerzug löst dutzende Änderungen
   * aus, und jede einzelne zu schreiben hiesse, während des Ziehens dutzende
   * Male eine Netzmaske zu packen. Am Ende eines Zuges steht genau ein
   * Schreibvorgang.
   */
  useEffect(() => {
    if (!kennung || !doc || !bild) return undefined;
    /*
     * Solange die Frage nach dem Entwurf offen steht, wird NICHT geschrieben.
     *
     * Ohne das lief der Effekt gegen das frische, unberührte Dokument, und
     * `entwurfSichern` räumt bei einem unberührten Dokument den Entwurf weg –
     * nach einer Dreiviertelsekunde also genau den, nach dem der Dialog
     * gerade fragt. Wer die Frage länger ansieht als drei Viertel einer
     * Sekunde (also: jeder) und dann den Tab schliesst, hatte den Entwurf
     * schon verloren, bevor er antworten konnte.
     */
    if (entwurfsfrage) return undefined;
    const timer = window.setTimeout(() => {
      void entwurfSichern(kennung, doc, bild.naturalWidth, bild.naturalHeight, name ?? null);
    }, 750);
    return () => window.clearTimeout(timer);
  }, [kennung, doc, bild, name, entwurfsfrage]);

  /*
   * Jede Änderung hinaus, wenn jemand zuhört – über eine Referenz, aus
   * demselben Grund wie bei `onClose`: Der Aufrufer reicht bei jedem
   * Rendern eine neue Funktion herein.
   */
  const aenderungRef = useRef(onAenderung);
  aenderungRef.current = onAenderung;
  useEffect(() => {
    if (doc) aenderungRef.current?.(doc, herkunftRef.current);
  }, [doc]);

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
      /*
       * Der Versatz wird beim ERSTEN Punkt festgelegt und gilt für den ganzen
       * Strich. So wandert die Quelle mit der Hand mit – zieht man nach
       * rechts, wandert auch die gelesene Stelle nach rechts, und der
       * geklonte Bereich bleibt in sich stimmig.
       */
      ...(malartRef.current === 'klon' && klonQuelleRef.current
        ? {
            quelle: {
              x: klonQuelleRef.current.x - punkte[0],
              y: klonQuelleRef.current.y - punkte[1],
            },
          }
        : {}),
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
      const inAnsicht = zuschnittInAnsicht(wirksamerZuschnitt(aktuell, W, H), W, H, aktuell);
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
      /*
       * Im Antipp-Modus wird nichts gegriffen.
       *
       * Diese Prüfung steht VOR der Griffsuche, und das ist Absicht: Wer
       * antippt, tippt auch einmal dorthin, wo zufällig ein Griff eines
       * anderen Maskenteils liegt. Griffe zu ziehen, während der Knopf
       * „Antippen“ leuchtet, wäre genau die Art von halbem Modus, bei der
       * man nie weiss, was der nächste Finger bewirkt.
       *
       * Gewirkt wird erst beim Loslassen – bis dahin kann aus dem Finger
       * noch eine Zwei-Finger-Geste werden, und ein Tipp mitten im
       * Heranzoomen wäre ein Fleck, den niemand bestellt hat.
       */
      if (bereichModusRef.current === 'antippen') {
        zug.current = {
          art: 'antippen',
          griff: '',
          startTeil: null,
          start: amBild,
          startZ: leer,
          startText: { x: 0, y: 0 },
          begonnen: false,
        };
        return;
      }
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
        /*
         * Im Modus „Strich löschen“ ist das Antippen selbst die Handlung –
         * es entsteht kein Zug. Deshalb steht das VOR dem Anlegen von
         * `zug.current`: Sonst hinge nach dem Löschen ein Pinselzug in der
         * Luft und die nächste Bewegung malte einen Strich in ein Teil, das
         * man gerade aufräumen wollte.
         */
        if (pinselModusRef.current === 'weg') {
          const treffer = strichTreffer(teil.striche, amBild, fangBereich(massRef.current.faktor));
          if (treffer >= 0) {
            /*
             * Von Hand statt über `teilAendern` – aus zwei Gründen.
             *
             * Erstens merkt `teilAendern` selbst (über `merkenGebuendelt`);
             * zusammen mit einem eigenen `merken()` entstünden ZWEI Schritte
             * für eine Löschung, und der zweite Druck auf ↺ täte nichts.
             *
             * Zweitens bündelt es: Zwei Löschungen binnen einer Sekunde
             * teilen sich denselben Schlüssel und würden zu einem Schritt
             * verschmelzen. Bei einem Regler ist das richtig – wer ihn hin
             * und her zieht, will einen Schritt. Beim Löschen ist es falsch:
             * Jeder entfernte Strich soll einzeln zurückzuholen sein, und
             * ob das geht, dürfte nicht von der Tippgeschwindigkeit abhängen.
             */
            merken();
            const bereich = aktiverBereich;
            const uebrig = teil.striche.filter((_strich, nummer) => nummer !== treffer);
            setDoc((wert) =>
              wert && bereich
                ? {
                    ...wert,
                    bereiche: wert.bereiche.map((b) =>
                      b.id === bereich.id
                        ? {
                            ...b,
                            teile: b.teile.map((t) =>
                              t.id === teil.id ? { ...t, striche: uebrig } : t,
                            ),
                          }
                        : b,
                    ),
                  }
                : wert,
            );
          }
          zug.current = { ...zug.current, art: 'keiner', begonnen: false };
          return;
        }
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
      /*
       * Beim Stempel setzt der erste Druck die Quelle, statt zu malen.
       *
       * Solange keine Quelle steht, weiss das Werkzeug nicht, woher es lesen
       * soll – ein Strich wäre dann entweder wirkungslos oder eine Kopie der
       * Stelle auf sich selbst, also sichtbar nichts. Ein Werkzeug, das beim
       * ersten Versuch nichts tut, hält man für kaputt. Deshalb ist der erste
       * Druck die Quellwahl und nicht ein leerer Strich.
       */
      if (malartRef.current === 'klon' && !klonQuelleRef.current) {
        /*
         * In ORIGINALpunkten merken, nicht in Ansichtspunkten.
         *
         * Die Strichpunkte gehen durch `nachOriginal`; der Versatz wird aus
         * beiden gebildet. Ohne Drehung, Spiegelung und Zuschnitt fallen die
         * beiden Räume zusammen, und der Unterschied fällt nicht auf – genau
         * deshalb dreht der Test das Bild, bevor er stempelt. Mit Drehung
         * läse die Quelle sonst an einer ganz anderen Stelle als der, auf die
         * getippt wurde.
         */
        const amBild = nachOriginal(punkt, W, H, aktuell);
        setKlonQuelle({ x: amBild.x, y: amBild.y });
        zug.current = { ...zug.current, art: 'keiner', begonnen: false };
        return;
      }
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
    const ctx = canvasRef.current ? flaeche2d(canvasRef.current) : null;
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

    /*
     * Ein Tipp zieht nichts – aber ein Wischen ist auch kein Tipp.
     *
     * Ab einem Fingerbreit Weg gilt der Zug als begonnen, und `zugBeenden`
     * lässt ihn dann fallen. Ohne das würde jedes Verrutschen beim Halten
     * des Telefons eine Maske an der Stelle anlegen, an der der Finger
     * aufgesetzt hat.
     *
     * Der Fangbereich statt einer festen Zahl: Bei achtfacher Lupe sind 22
     * Leinwandpunkte neun Originalpunkte, herausgezoomt dreiundsiebzig.
     * Wie weit der Finger gerutscht IST, misst der Bildschirm – nicht das
     * Bild.
     *
     * Und das steht VOR `merken()`: Ein Zug, der nichts ändert, darf keinen
     * Rückgängig-Schritt anlegen. Genau dafür ist `zugGemerkt` da.
     */
    if (art === 'antippen') {
      const amBild = nachOriginal(punkt, W, H, aktuell);
      const dx = amBild.x - zug.current.start.x;
      const dy = amBild.y - zug.current.start.y;
      if (Math.hypot(dx, dy) > fangBereich(massRef.current.faktor)) {
        zug.current.begonnen = true;
      }
      return;
    }

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
      // Gehalten wird am Bildrand, nicht am geneigten Bild: Gespeichert ist
      // die ABSICHT. Was davon nach der Neigung übrig bleibt, rechnet
      // `wirksamerZuschnitt` bei jedem Zeichnen neu aus.
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

    if (zustand.art === 'antippen') {
      // `start` liegt schon in Originalpunkten – anders als beim Malen, wo
      // der Ansichtspunkt gemerkt wird. Siehe den Zweig in `onPointerDown`.
      void tippAnwenden(zustand.start);
      return;
    }

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
    setDoc((aktuell) => {
      if (!aktuell) return aktuell;
      const passend = aufVerhaeltnis(
        aktuell.zuschnitt,
        // Das Verhältnis gilt für das, was man sieht; am hochkant
        // gedrehten Bild ist „16:9“ also quer zum Original.
        aktuell.drehung === 90 || aktuell.drehung === 270 ? 1 / wert : wert,
        bild.naturalWidth,
        bild.naturalHeight,
      );
      return { ...aktuell, zuschnitt: passend };
    });
  }

  function zuschnittGanz() {
    if (!bild) return;
    merken();
    const ganz = { x: 0, y: 0, w: bild.naturalWidth, h: bild.naturalHeight };
    // Das Seitenverhältnis mit lösen: „Ganzes Bild" nimmt das ganze Bild, und
    // das hat nun einmal das Verhältnis, das es hat. Blieb der Knopf „1:1"
    // hervorgehoben, behauptete er einen Zustand, den der Zuschnitt nicht hat
    // – und der nächste Zug an einer Ecke sprang zurück auf das Quadrat.
    setVerhaeltnis(null);
    verhaeltnisRef.current = null;
    setDoc((wert) => (wert ? { ...wert, zuschnitt: ganz } : wert));
  }

  /**
   * Der Feinwinkel zum Geraderichten.
   *
   * Gerechnet wird immer vom UNGENEIGTEN Ausgangsrahmen aus, nie vom
   * aktuellen. Sonst wäre jede Reglerbewegung eine weitere Verkleinerung:
   * einmal nach rechts und wieder zurück, und der Ausschnitt wäre für immer
   * enger – nach ein paar Zügen bliebe vom Bild nichts übrig.
   */
  function neigenSetzen(grad: number) {
    if (!bild) return;
    merkenGebuendelt('neigung');
    const sauber = neigungKlemmen(grad);
    setDoc((wert) => (wert ? { ...wert, neigung: sauber } : wert));
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

  /** Eine Vorlage aufs Bild legen – oder ihre Stärke ändern. */
  function vorlageSetzen(id: string, staerke: number) {
    const vorlage = VORLAGEN.find((v) => v.id === id);
    if (!vorlage) return;
    // Gebündelt wie ein Regler: Wer die Stärke hin und her zieht, will einen
    // Rückgängig-Schritt, nicht dreissig.
    merkenGebuendelt(`vorlage-${id}`);
    setVorlageId(id);
    setVorlageStaerke(staerke);
    const anpassung = vorlageAnwenden(vorlage, staerke);
    setDoc((wert) => (wert ? { ...wert, anpassung } : wert));
  }

  /**
   * Einen Tonwert-Regler setzen.
   *
   * Gebündelt je Regler: Wer einen Schieber über die halbe Skala zieht,
   * erzeugt hundert Änderungen. Ohne die Bündelung wäre der Verlauf nach
   * einem Zug voll und alles davor fort.
   */
  /**
   * Eine Kurve oder ein Band ändern.
   *
   * Getrennt von `tonSetzen`, weil es etwas anderes setzt als eine Zahl – und
   * weil hier NICHT gebündelt wird: Ein Reglerzug erzeugt dutzende Werte und
   * soll ein Rückgängig-Schritt sein, das Setzen eines Kurvenpunktes ist
   * einer. Der Zug am Punkt bündelt sich über `merkenGebuendelt` im
   * Kurvenfeld selbst.
   */
  const feinSetzen = useCallback((aenderung: Partial<Pick<Anpassung, 'kurven' | 'baender'>>) => {
    setVorlageId(null);
    setDoc((alt) => (alt ? { ...alt, anpassung: { ...alt.anpassung, ...aenderung } } : alt));
  }, []);

  const kurveSetzen = useCallback(
    (kanal: keyof Kurven, punkte: Kurvenpunkt[]) => {
      const jetzt = docRef.current?.anpassung.kurven ?? KURVEN_NEUTRAL;
      feinSetzen({ kurven: { ...jetzt, [kanal]: punkte } });
    },
    [feinSetzen],
  );

  const bandSetzen = useCallback(
    (index: number, feld: keyof Farbband, wert: number) => {
      merkenGebuendelt(`band-${index}-${feld}`);
      const jetzt = docRef.current?.anpassung.baender ?? BAENDER_NEUTRAL;
      feinSetzen({
        baender: BAENDER.map((_, i) => {
          const b = jetzt[i] ?? { farbton: 0, saettigung: 0, helligkeit: 0 };
          return i === index ? { ...b, [feld]: wert } : { ...b };
        }),
      });
    },
    [feinSetzen, merkenGebuendelt],
  );

  const tonSetzen = useCallback(
    (welcher: Zahlfeld, wert: number) => {
      merkenGebuendelt(`ton-${welcher}`);
      // Ein einzelner Regler löst die Vorlage ab: Was jetzt im Bild steht,
      // ist nicht mehr das, was auf dem Knopf steht.
      setVorlageId(null);
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
    /*
     * Diese eine Leinwand bleibt ABSICHTLICH sRGB.
     *
     * Sie liefert das Histogramm für die Automatik, und das ist eine
     * Schätzung über die Verteilung der Helligkeiten. Sie in P3 zu nehmen
     * hiesse, die Schwellen in `autoAnpassung` gegen einen anderen Raum zu
     * halten, als sie gemessen wurden.
     */
    const ctx = flaeche.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
    if (!ctx) return;
    ctx.drawImage(quellBild, 0, 0, kante, kante);
    const daten = ctx.getImageData(0, 0, kante, kante).data;
    const histogramm = new Uint32Array(256);
    for (let i = 0; i < daten.length; i += 4) {
      const y = 0.2126 * daten[i] + 0.7152 * daten[i + 1] + 0.0722 * daten[i + 2];
      histogramm[Math.min(255, Math.max(0, Math.round(y)))] += 1;
    }
    merken();
    // Die Automatik überschreibt alle Farbregler – dann darf keine Vorlage
    // mehr als aktiv dastehen. Sonst behauptet der Knopf eine Einstellung,
    // die im Bild nicht mehr steckt.
    setVorlageId(null);
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

  /** Ob antippen gerade an ist – und das Werkzeug überhaupt das richtige. */
  const tippAktiv = werkzeug === 'bereich' && bereichModus === 'antippen';
  /** Ob „mit Netz“ gerade wirklich gilt – der Haken allein reicht nicht. */
  const tippNetzGilt = tippMitNetz && tippNetzVerfuegbar();
  /**
   * Das Tippteil, an das der nächste Tipp ginge.
   *
   * Dieselbe Suche wie in `tippTeilFinden`, nur aus dem Bild statt aus den
   * Spiegeln – hier hängt eine Zahl daran („3 Stellen“) und ob „Letzten Tipp
   * zurück“ überhaupt etwas zurücknehmen kann.
   */
  const tippTeilJetzt = useMemo(
    () =>
      (aktiverBereich?.teile.find(
        (t) => t.art === 'tipp' && t.modus === tippVorzeichen && t.mitNetz === tippNetzGilt,
      ) as (TippTeil & { id: string }) | undefined) ?? null,
    [aktiverBereich, tippVorzeichen, tippNetzGilt],
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

    /*
     * Erst prüfen, dann merken.
     *
     * Andersherum stand es hier, und das machte aus einem wirkungslosen Knopf
     * einen schädlichen: `merken()` legt einen Rückgängig-Schritt an und
     * leert den Wiederherstellen-Stapel. Wer bei vollem Bereichszähler auf
     * „Verlauf" tippte, verlor also seine Wiederherstellen-Schritte – und
     * bekam nicht einmal gesagt, warum nichts passiert ist.
     */
    const vorhanden = aktuell.bereiche.find((b) => b.id === bereichRef.current);
    if (!vorhanden && aktuell.bereiche.length >= BEREICHE_MAX) {
      toast(
        `Mehr als ${BEREICHE_MAX} Bereiche gehen nicht. Lösch einen, wenn du einen neuen brauchst.`,
        'info',
      );
      return;
    }

    merken();
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
      // Hat das Bild unterdessen gewechselt (im Videoeditor: ein anderes
      // Stellbild), gehört die Maske zu keinem Bild mehr, das hier steht.
      if (bildRef.current !== quellBild) return;
      teilEinsetzen([teil], netz === 'person' ? 'Person' : 'Motiv');
    } catch (fehler) {
      // Der Satz aus dem `EngineError` ist für den Anwender geschrieben –
      // „Fehler“ hilft niemandem, „ist abgeschaltet, du kannst es
      // einschalten“ schon.
      setNetzFehler(errorMessage(fehler, 'Das Netz konnte nicht laufen'));
    } finally {
      setNetzLaeuft(null);
    }
  }

  /**
   * Das Teil, an das ein Tipp geht – oder `null`, wenn es noch keines gibt.
   *
   * Gesucht wird nach VORZEICHEN und VERFAHREN, nicht nach der Auswahl in der
   * Maskenliste. Zwei Gründe: Ein Plus- und ein Minus-Tipp sind zwangsläufig
   * zwei Teile (ein Maskenteil hat genau einen `modus`), und wer zwischendurch
   * den Haken „mit Netz“ umlegt, bekommt ein eigenes Teil – die Punktliste
   * eines Teils wird als Ganzes mit EINEM Verfahren gerechnet, gemischt ergäbe
   * sie beim nächsten Neurechnen etwas anderes als beim ersten Mal.
   */
  function tippTeilFinden(
    aktuell: BildDoc,
    bereichId: string | null,
    modus: 'dazu' | 'weg',
    mitNetz: boolean,
  ): (TippTeil & { id: string; modus: Maskenmodus; umkehren: boolean }) | null {
    const bereich = aktuell.bereiche.find((b) => b.id === bereichId);
    if (!bereich) return null;
    for (const teil of bereich.teile) {
      if (teil.art === 'tipp' && teil.modus === modus && teil.mitNetz === mitNetz) return teil;
    }
    return null;
  }

  /**
   * Rechnet ein Tippteil neu und setzt es an die Stelle des alten.
   *
   * Der eine Weg für alle drei Anlässe: ein Tipp mehr, ein Tipp weniger, eine
   * andere Toleranz. Vorher stand dieselbe Rechnung dreimal da, und der dritte
   * Aufrufer vergass jedes Mal etwas anderes.
   *
   * Ist die Punktliste leer, verschwindet das Teil – ein Maskenteil, das nichts
   * mehr abdeckt, wäre eine Zeile in der Liste, die man nicht loswird.
   */
  async function tippTeilSetzen(
    vorlageTeil: (TippTeil & { id: string; modus: Maskenmodus }) | null,
    punkte: { x: number; y: number }[],
    wahl: { modus: 'dazu' | 'weg'; mitNetz: boolean; toleranz: number },
  ) {
    const quellBild = bildRef.current;
    const aktuell = docRef.current;
    if (!quellBild || !aktuell) return;

    /*
     * Ein leerer Tipp ist kein Lauf, sondern eine Löschung.
     *
     * Und sie geschieht SOFORT, ohne auf ein Modell zu warten: „Letzten Tipp
     * zurück“ beim einzigen Tipp ist die eine Stelle, an der ein Anwender
     * schon weiss, was herauskommt.
     */
    if (punkte.length === 0) {
      if (vorlageTeil) teilLoeschen(vorlageTeil.id);
      return;
    }

    // Ein zweiter Tipp, während der erste noch rechnet, würde dessen Punkt
    // überschreiben – die Liste käme aus dem Dokument von VOR dem ersten.
    if (tippRechnetRef.current) return;
    tippRechnetRef.current = true;
    const meinLauf = (tippLaufRef.current += 1);
    setNetzFehler(null);
    setNetzLaeuft(wahl.mitNetz ? 'Wird angesehen …' : 'Farben werden verfolgt …');
    try {
      const teil = await tippTeilRechnen(
        quellBild,
        punkte,
        {
          ...wahl,
          id: vorlageTeil?.id,
          vorher: vorlageTeil ? { punkte: vorlageTeil.punkte, alpha: vorlageTeil.alpha } : null,
        },
        (text) => setNetzLaeuft(text),
      );
      /*
       * Ein Ergebnis, das niemand mehr bestellt hat, wird fallen gelassen.
       *
       * Zwischen Start und Ende dieses Laufs kann ↺ gedrückt worden sein oder
       * das Bild gewechselt haben. Die Maske dann doch noch einzusetzen
       * hiesse: eine Fläche taucht wieder auf, die der Anwender gerade
       * weggenommen hat – ein Bild, das sich von selbst ändert.
       */
      if (!teil || meinLauf !== tippLaufRef.current || bildRef.current !== quellBild) return;
      if (vorlageTeil) {
        merken();
        const bereichJetzt = bereichRef.current;
        setDoc((wert) =>
          wert
            ? {
                ...wert,
                bereiche: wert.bereiche.map((b) =>
                  b.id === bereichJetzt
                    ? { ...b, teile: b.teile.map((t) => (t.id === teil.id ? teil : t)) }
                    : b,
                ),
              }
            : wert,
        );
      } else {
        // Kein `merken()` davor: `teilEinsetzen` merkt selbst, und zwei
        // Schritte für einen Tipp hiessen, dass der erste Druck auf ↺ nichts
        // tut. Denselben Fehler gab es einmal beim Löschen von Pinselstrichen.
        teilEinsetzen([teil], 'Antippen');
        setTeilId(teil.id);
      }
    } catch (fehler) {
      setNetzFehler(errorMessage(fehler, 'Der Tipp konnte nicht gerechnet werden'));
    } finally {
      tippRechnetRef.current = false;
      setNetzLaeuft(null);
    }
  }

  /**
   * Ein Tipp auf das Bild – die Stelle kommt in Originalpunkten herein.
   *
   * Umgerechnet wird auf die VORLAGE, weil dort gerechnet wird: `tippVorlage`
   * liefert dieselbe verkleinerte Fassung, die auch die Netze bekommen, und
   * nur weil es dieselbe ist, muss das Netz das Bild nicht bei jedem Tipp neu
   * ansehen.
   */
  async function tippAnwenden(imOriginal: { x: number; y: number }) {
    const quellBild = bildRef.current;
    const aktuell = docRef.current;
    if (!quellBild || !aktuell || tippRechnetRef.current) return;
    if (!vorhandenOderPlatz(aktuell)) return;

    const vorlage = tippVorlage(quellBild);
    const stelle = {
      x: imOriginal.x * vorlage.faktor,
      y: imOriginal.y * vorlage.faktor,
    };
    /*
     * Ein Tipp neben das Bild ist kein Tipp.
     *
     * Bei gedrehtem oder zugeschnittenem Foto liegt die Leinwand nicht auf dem
     * Bild; `nachOriginal` rechnet dann auch Stellen aus, die es nicht gibt.
     * Die Flutung überspringt solche Saat wortlos – und wortlos ist genau das
     * Falsche: Der Knopf hätte etwas getan, das Bild nicht.
     */
    if (
      stelle.x < 0 ||
      stelle.y < 0 ||
      stelle.x >= vorlage.image.width ||
      stelle.y >= vorlage.image.height
    ) {
      setNetzFehler('Diese Stelle liegt ausserhalb des Bildes.');
      return;
    }

    const modus = tippVorzeichenRef.current;
    const mitNetz = tippMitNetzRef.current && tippNetzVerfuegbar();
    const toleranz = tippToleranzRef.current;
    const vorher = tippTeilFinden(aktuell, bereichRef.current, modus, mitNetz);
    await tippTeilSetzen(vorher, [...(vorher?.punkte ?? []), stelle], {
      modus,
      mitNetz,
      toleranz,
    });
  }

  /**
   * Die Farbtoleranz verschieben – und die Maske gleich mitziehen.
   *
   * Nicht erst beim nächsten Tipp: Wer die Toleranz anfasst, hat gerade
   * gesehen, dass der Ausschnitt nicht passt, und will ihn WACHSEN sehen. Ein
   * Regler, dessen Wirkung man erst nach „zurück“ und noch einem Tipp sieht,
   * ist ein Ratespiel.
   *
   * Gebremst um eine Fünftelsekunde, weil ein Regler auf einem Telefon
   * dreissig Ereignisse je Sekunde liefert und jedes davon eine Flutung über
   * das ganze Bild anstiesse. Die Zahl an der Beschriftung springt trotzdem
   * sofort mit – das ist es, was den Regler flüssig aussehen lässt.
   */
  function toleranzSchieben(wert: number) {
    setTippToleranz(wert);
    if (toleranzUhr.current !== null) window.clearTimeout(toleranzUhr.current);
    toleranzUhr.current = window.setTimeout(() => {
      toleranzUhr.current = null;
      const aktuell = docRef.current;
      if (!aktuell) return;
      /*
       * Nur die Teile ohne Netz. Bei einem Netzteil ist die Toleranz eine
       * mitgeführte Zahl ohne Wirkung – es neu zu rechnen hiesse, das Modell
       * für nichts laufen zu lassen. Der Regler steht dort auch gar nicht.
       */
      const teil = tippTeilFinden(aktuell, bereichRef.current, tippVorzeichenRef.current, false);
      if (!teil) return;
      void tippTeilSetzen(teil, [...teil.punkte], {
        modus: teil.modus === 'weg' ? 'weg' : 'dazu',
        mitNetz: false,
        toleranz: wert,
      });
    }, 200);
  }

  /** „Letzten Tipp zurück“ – Punkt streichen, Maske neu rechnen. */
  async function tippZurueck() {
    const aktuell = docRef.current;
    if (!aktuell) return;
    const modus = tippVorzeichenRef.current;
    const mitNetz = tippMitNetzRef.current && tippNetzVerfuegbar();
    const vorher = tippTeilFinden(aktuell, bereichRef.current, modus, mitNetz);
    if (!vorher) return;
    await tippTeilSetzen(vorher, vorher.punkte.slice(0, -1), {
      modus,
      mitNetz,
      toleranz: vorher.toleranz,
    });
  }

  /**
   * Lässt das Tiefenmodell laufen und legt daraus ein Maskenteil an.
   *
   * Derselbe Ablauf wie bei den Freistellern, nur dauert er länger (rund drei
   * Sekunden auf dem Telefon) – deshalb dieselbe Fortschrittsanzeige und
   * derselbe Riegel gegen einen zweiten Lauf.
   */
  async function tiefeTeilAnlegen() {
    const quellBild = bildRef.current;
    const aktuell = docRef.current;
    if (!quellBild || !aktuell || netzLaeuft) return;
    if (!vorhandenOderPlatz(aktuell)) return;
    setNetzFehler(null);
    setNetzLaeuft('Wird vorbereitet …');
    try {
      const teil = await tiefenTeilRechnen(quellBild, (text) => setNetzLaeuft(text));
      if (bildRef.current !== quellBild) return;
      teilEinsetzen([teil], 'Tiefe');
    } catch (fehler) {
      setNetzFehler(errorMessage(fehler, 'Die Tiefenkarte konnte nicht gerechnet werden'));
    } finally {
      setNetzLaeuft(null);
    }
  }

  /**
   * Setzt ein fertig gerechnetes Maskenteil in den gewählten Bereich – oder
   * legt einen neuen an, wenn keiner gewählt ist.
   */
  function teilEinsetzen(teile: Maskenteil[], standardName: string, unschaerfe = 0) {
    if (teile.length === 0) return;
    merken();
    const bereich = docRef.current?.bereiche.find((b) => b.id === bereichRef.current);
    if (bereich) {
      setDoc((wert) =>
        wert
          ? {
              ...wert,
              bereiche: wert.bereiche.map((b) =>
                b.id === bereich.id ? { ...b, teile: [...b.teile, ...teile] } : b,
              ),
            }
          : wert,
      );
    } else {
      const neu: Bereich = {
        id: neueId('b'),
        name: standardName,
        aktiv: true,
        teile,
        anpassung: { ...BEREICH_NEUTRAL, unschaerfe },
      };
      setDoc((wert) => (wert ? { ...wert, bereiche: [...wert.bereiche, neu] } : wert));
      setBereichId(neu.id);
    }
    setTeilId(teile[teile.length - 1].id);
  }

  /**
   * Freistellkante UND Tiefe in einem Schritt.
   *
   * # Was hier zusammengesetzt wird
   *
   * Ein Tiefenteil `dazu` und ein Freistellteil `weg`. Die Faltung macht
   * daraus genau das, wonach man bei „Porträtmodus“ sucht: Im Motiv ist die
   * Maske null – es bleibt scharf, und zwar mit der Kante des
   * Freistellmodells, nicht mit der weichen Kante der Tiefenkarte.
   * Ausserhalb bleibt der Tiefenwert stehen, die Unschärfe WÄCHST also mit
   * der Entfernung, statt hinter dem Motiv überall gleich zu sein.
   *
   * Nachgerechnet an der Faltungsvorschrift mit Netz = [255,255,255,255,0,0,0,0]
   * und Tiefe = [0,20,60,90,150,200,240,255]: „dazu“ ergibt die Tiefe,
   * „weg“ danach [0,0,0,0,150,200,240,255].
   *
   * # Warum kein gefilterter Zwischenweg
   *
   * Naheliegend wäre, die Tiefenkarte mit der Freistellmaske als Führung
   * kantentreu zu machen – dann bliebe die Tiefe auch INNERHALB des Motivs
   * erhalten. Das setzt aber voraus, dass die Freistellmaske eine scharfe
   * Kante hat. Nachgemessen ist sie das nicht: Der Übergangsbereich von
   * „Motiv“ (U²-Net) auf einer 1024er Vorlage ist im Mittel 55 Punkte breit
   * – weicher als die Tiefenkarte selbst, die man damit schärfen wollte.
   * Eine um wenige Punkte danebenliegende Führung macht eine richtige
   * Tiefenkarte schlechter, nicht besser.
   *
   * Wer die Tiefe im Motiv haben will, nimmt „🔭 Tiefe“ allein: Sie wirkt
   * überall, auch im Motiv – nur eben mit ihrer eigenen weichen Silhouette.
   */
  async function kombiAnlegen() {
    const quellBild = bildRef.current;
    const aktuell = docRef.current;
    if (!quellBild || !aktuell || netzLaeuft) return;
    if (!vorhandenOderPlatz(aktuell)) return;
    /*
     * Die Kante ist der ganze Zweck – also gilt hier dieselbe Güte wie bei
     * „Motiv".
     *
     * Vorher stand hier fest `object`, notfalls `person`; BiRefNet kam in
     * dieser Kette gar nicht vor. Wer „Hohe Qualität" eingeschaltet hatte und
     * „Motiv + Tiefe" drückte, bekam trotzdem das kleine Modell –
     * ausgerechnet im Fall der Porträt-Unschärfe, für den die feine Kante
     * gebaut wurde.
     */
    const kante: Netzart | null =
      gewaehlterFreisteller(qualitaetRef.current, grafikAusRef.current === null) ??
      (netzVerfuegbar('person') ? 'person' : null);
    setNetzFehler(null);
    setNetzLaeuft('Wird vorbereitet …');
    try {
      const tiefe = await tiefenTeilRechnen(quellBild, (text) => setNetzLaeuft(text));
      if (bildRef.current !== quellBild) return;
      if (!kante) {
        teilEinsetzen([tiefe], 'Tiefe', 0.6);
        setNetzFehler(
          'Kein Freistellverfahren eingeschaltet – es wurde nur die Tiefe gerechnet. Die Kante am Motiv bleibt damit weich.',
        );
        return;
      }
      const silhouette = await netzTeilRechnen(quellBild, kante, (text) => setNetzLaeuft(text));
      if (bildRef.current !== quellBild) return;
      teilEinsetzen([tiefe, { ...silhouette, modus: 'weg' }], 'Motiv + Tiefe', 0.6);
    } catch (fehler) {
      setNetzFehler(errorMessage(fehler, 'Motiv und Tiefe konnten nicht gerechnet werden'));
    } finally {
      setNetzLaeuft(null);
    }
  }

  /**
   * Ein Verfahren von hier aus einschalten.
   *
   * Der Schalter lebt in den Einstellungen und gilt pro Gerät – das bleibt
   * so. Was sich ändert: Man muss nicht mehr dorthin. Wer mitten in einer
   * Bearbeitung erfährt, dass ein Verfahren abgeschaltet ist, soll nicht den
   * Editor verlassen müssen, um das zu ändern; ein halb bearbeitetes Bild
   * überlebt diesen Umweg nicht.
   */
  function einschalten(schluessel: EngineKey) {
    writeEngineSetting(schluessel, true);
    // `readEngineSettings` liest bei jedem Aufruf neu aus dem Gerätespeicher;
    // ein Neuzeichnen genügt also, damit die Knöpfe hell werden.
    setEngineStand((wert) => wert + 1);
    toast(
      `„${engineInfo(schluessel).label}“ ist eingeschaltet. Der erste Lauf lädt ${firstUseMb(
        engineInfo(schluessel),
      )} MB.`,
      'success',
    );
  }

  /**
   * Ob noch ein Bereich hineinpasst – oder schon einer gewählt ist.
   *
   * Sagt jetzt auch, wenn nicht. Vorher gab die Funktion nur `false` zurück,
   * und alle drei Aufrufer (`netzTeilAnlegen`, `tiefeTeilAnlegen`,
   * `kombiAnlegen`) brachen daraufhin mit einem nackten `return` ab: Der
   * Knopf war hell, nahm die Berührung an und tat wortlos nichts. Wer vier
   * Bereiche hatte und keinen ausgewählt, erlebte das als „die Knöpfe gehen
   * nicht, obwohl ich Bereiche habe“ – und hielt es für dieselbe Sache wie
   * die grauen Knöpfe daneben, die aus einem ganz anderen Grund grau sind.
   *
   * Denselben Satz zeigt `teilAnlegen` für Verlauf, Radial und Pinsel schon
   * lange; er stand nur an der falschen Stelle, um allen zu helfen.
   */
  function vorhandenOderPlatz(aktuell: BildDoc): boolean {
    if (aktuell.bereiche.some((b) => b.id === bereichRef.current)) return true;
    if (aktuell.bereiche.length < BEREICHE_MAX) return true;
    toast(
      `Mehr als ${BEREICHE_MAX} Bereiche gehen nicht. Wähl einen aus, in den die Maske soll, oder lösch einen.`,
      'info',
    );
    return false;
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
    // Die Vorlage mit aufheben: Sonst blieb sie hervorgehoben, mit
    // aria-pressed=true, obwohl von ihr im Bild nichts mehr übrig ist.
    setVorlageId(null);
    setVorlageStaerke(1);
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
    /*
     * Erst die Schriften, dann rastern.
     *
     * `fillText` wartet auf nichts: Ist die Schrift noch nicht geladen, malt
     * die Leinwand die Ersatzschrift – und das steht dann für immer im Bild,
     * denn ein Bild lädt nicht nach.
     */
    await schriftenBereit(doc.texte.map((t) => t.schrift));
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

  /**
   * Das Rezept: zwei Dateien statt einer.
   *
   * Das Bild geht UNVERÄNDERT hinaus – `quelle` selbst, nicht neu gerechnet.
   * Jede Umkodierung wäre hier ein Widerspruch: Der ganze Sinn ist, dass beim
   * Empfänger das Original liegt.
   */
  async function alsRezept() {
    if (!onRezept || !bild || !doc) return;
    const hindernis = rezeptHindernis(doc, bild.naturalWidth, bild.naturalHeight);
    if (hindernis) {
      toast(hindernis, 'error');
      return;
    }
    setSpeichert(true);
    try {
      const rezept = await rezeptSchreiben(doc, bild.naturalWidth, bild.naturalHeight);
      await onRezept(quelle, rezept, name ?? 'bild');
      // Draussen ist draussen: Ein Entwurf zu etwas, das schon verschickt ist,
      // fragte beim nächsten Aufmachen nach einer Arbeit, die längst getan ist.
      if (kennung) await entwurfLoeschen(kennung);
      onClose();
    } catch (error) {
      toast(errorMessage(error, 'Das Rezept konnte nicht erzeugt werden'), 'error');
    } finally {
      setSpeichert(false);
    }
  }

  /**
   * Licht und Farbe auf die anderen Bilder der Auswahl.
   *
   * Der Editor bleibt danach offen. Das ist Absicht: „Übertragen“ und
   * „Übernehmen“ sind zwei Entscheidungen, und wer die eine trifft, hat die
   * andere noch nicht getroffen. Ein Knopf, der beides täte, nähme einem das
   * Nachjustieren an genau dem Bild weg, an dem man gerade eingestellt hat.
   */
  async function stapelUebertragen() {
    if (!onStapel || !doc) return;
    setSpeichert(true);
    try {
      await onStapel(doc.anpassung);
    } catch (error) {
      toast(errorMessage(error, 'Das Übertragen ist fehlgeschlagen'), 'error');
    } finally {
      setSpeichert(false);
    }
  }

  async function dokumentAbgeben() {
    if (!onDokument || !doc || !bild) return;
    setSpeichert(true);
    try {
      await onDokument(doc, bild.naturalWidth, bild.naturalHeight);
      onClose();
    } catch (error) {
      toast(errorMessage(error, 'Das Übernehmen ist fehlgeschlagen'), 'error');
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
      if (kennung) await entwurfLoeschen(kennung);
      onClose();
    } catch (error) {
      toast(errorMessage(error, 'Speichern fehlgeschlagen'), 'error');
    } finally {
      setSpeichert(false);
    }
  }

  const unberuehrt = bild && doc ? docUnberuehrt(doc, bild.naturalWidth, bild.naturalHeight) : true;

  /*
   * Warum das Rezept gerade nicht geht – oder null.
   *
   * Drei Gründe, und sie sagen Verschiedenes: kein Empfänger (dann gibt es
   * den Knopf gar nicht), ein Browser ohne `CompressionStream`, oder eine
   * Bearbeitung, die Bildinhalt entfernt. Nur der letzte ist eine Nachricht
   * wert – die anderen beiden kann niemand ändern.
   */
  const rezeptSperre =
    !onRezept || !bild || !doc
      ? ''
      : !rezeptMoeglich()
        ? 'Dieser Browser kann keine Rezepte packen.'
        : (rezeptHindernis(doc, bild.naturalWidth, bild.naturalHeight) ?? '');
  const rezeptGeht = Boolean(onRezept && bild && doc && rezeptSperre === '' && rezeptLohnt(doc));

  /** Der eine Satz, der am Knopf steht – als Tipp und beim Tippen darauf. */
  const rezeptGrund =
    rezeptSperre !== ''
      ? `Kein Rezept möglich. ${rezeptSperre} Die Kopie geht wie immer.`
      : !rezeptGeht
        ? 'Noch nichts eingestellt – ein Rezept beschriebe nichts.'
        : 'Schickt das UNBEARBEITETE Bild und die Bearbeitung als Anweisung daneben – der Empfänger sieht dasselbe Ergebnis, kann aber das Original ansehen und die Regler weiterschieben.';

  return createPortal(
    <div
      className={`bild-editor${unterBuehne ? ' mit-zeitleiste' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={titel}
    >
      <header className="bild-kopf">
        <button
          type="button"
          className="icon-btn"
          onClick={schliessenVersuchen}
          aria-label="Schließen"
        >
          ✕
        </button>
        <strong className="truncate">{titel}</strong>
        <button
          type="button"
          className="icon-btn"
          onClick={zurueck}
          disabled={!kannZurueck || gesperrt}
          aria-label="Rückgängig"
        >
          ↺
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={wieder}
          disabled={!kannVor || gesperrt}
          aria-label="Wiederherstellen"
        >
          ↻
        </button>
        {/*
            „Vorher“ – halten, nicht umschalten.

            Halten ist die richtige Geste dafür: Man will das alte Bild sehen,
            solange man hinsieht, und danach wieder das neue. Ein Umschalter
            liesse einen versehentlich im Vorher-Zustand weiterarbeiten, und
            dann wundert man sich, warum die Regler nichts tun.

            Deshalb auch `onPointerLeave` und `onPointerCancel`: Wer mit dem
            Finger vom Knopf rutscht, bekommt sonst nie wieder sein
            bearbeitetes Bild zu sehen.
        */}
        <button
          type="button"
          className={`btn btn-sm ${vergleich ? 'is-active' : ''}`}
          aria-label="Original zeigen, solange gedrückt"
          aria-pressed={vergleich}
          disabled={!doc || !hatBearbeitung}
          onPointerDown={() => vergleichSetzen(true)}
          onPointerUp={() => vergleichSetzen(false)}
          onPointerLeave={() => vergleichSetzen(false)}
          onPointerCancel={() => vergleichSetzen(false)}
          onKeyDown={(ereignis) => {
            if (ereignis.key === ' ' || ereignis.key === 'Enter') vergleichSetzen(true);
          }}
          onKeyUp={() => vergleichSetzen(false)}
          onBlur={() => vergleichSetzen(false)}
        >
          👁 Vorher
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
        {ueberBuehne}
      </div>

      {unterBuehne && <div className="bild-zeitleiste">{unterBuehne}</div>}

      <div
        className={`bild-panel ${werkzeug === 'ton' || werkzeug === 'bereich' ? 'ist-ton' : ''}`}
        inert={gesperrt}
        aria-disabled={gesperrt || undefined}
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
            <label className="bild-schieber">
              <span>Geraderichten</span>
              <input
                type="range"
                min={-NEIGUNG_MAX}
                max={NEIGUNG_MAX}
                step={0.1}
                value={doc?.neigung ?? 0}
                onChange={(event) => neigenSetzen(Number(event.target.value))}
                aria-label="Geraderichten – Bild um kleine Winkel drehen"
              />
              <output>{(doc?.neigung ?? 0).toFixed(1)}°</output>
            </label>
            <div className="bild-reihe">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => neigenSetzen(0)}
                disabled={!doc || doc.neigung === 0}
              >
                Neigung zurück
              </button>
            </div>
            <p className="bild-hinweis">
              Zieh an den Ecken oder Kanten. Innerhalb des Rahmens verschiebst du den Ausschnitt.
              Mit <b>Geraderichten</b> kippst du einen schiefen Horizont gerade – der Ausschnitt
              rückt dabei so weit nach, dass keine leeren Ecken entstehen.
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
            {/*
              Vorlagen: eine Reglerstellung mit Namen, kein eigener Rechenweg.
              Der Stärkeregler mischt linear von neutral zur Vorlage – das
              geht, weil alle Regler bei null nichts tun und in dieselbe
              Richtung stärker werden.
            */}
            <div className="bild-reihe" role="group" aria-label="Vorlagen">
              {VORLAGEN.map((vorlage) => (
                <button
                  key={vorlage.id}
                  type="button"
                  className={`btn btn-sm ${vorlageId === vorlage.id ? 'is-active' : ''}`}
                  aria-pressed={vorlageId === vorlage.id}
                  title={vorlage.beschreibung}
                  /*
                   * Bei Stärke 0 wieder auf 1.
                   *
                   * Sonst wandte jeder Vorlagenknopf die Vorlage mit der
                   * zuletzt eingestellten Stärke an – und wer den Regler
                   * einmal auf 0 gezogen hatte, bekam von da an bei JEDEM
                   * Knopf ein neutrales Bild. Die Vorlage sah dabei
                   * ausgewählt aus (`is-active`), nur passierte nichts. Ein
                   * toter Knopf, der so tut, als habe er gewirkt.
                   */
                  onClick={() => vorlageSetzen(vorlage.id, vorlageStaerke > 0 ? vorlageStaerke : 1)}
                >
                  {vorlage.name}
                </button>
              ))}
            </div>
            {vorlageId && (
              <label className="bild-schieber">
                <span>Stärke</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={vorlageStaerke}
                  onChange={(event) => vorlageSetzen(vorlageId, Number(event.target.value))}
                />
                <span className="bild-wert">{Math.round(vorlageStaerke * 100)}</span>
              </label>
            )}

            {doc.anpassung.saettigung < 0 && (
              <>
                {/*
                  Nur sichtbar, wenn entsättigt wird – vorher tun sie nichts.
                  Ein Farbfilter im Schwarz-Weiss verschiebt die HELLIGKEITEN
                  beim Entsättigen; bei voller Farbe wird der Block gar nicht
                  betreten.
                */}
                <label className="bild-schieber">
                  <span>S/W-Filter Rot</span>
                  <input
                    type="range"
                    min={-1}
                    max={1}
                    step={0.01}
                    value={doc.anpassung.swRot}
                    onChange={(event) => tonSetzen('swRot', Number(event.target.value))}
                  />
                  <span className="bild-wert">{Math.round(doc.anpassung.swRot * 100)}</span>
                </label>
                <label className="bild-schieber">
                  <span>S/W-Filter Grün</span>
                  <input
                    type="range"
                    min={-1}
                    max={1}
                    step={0.01}
                    value={doc.anpassung.swGruen}
                    onChange={(event) => tonSetzen('swGruen', Number(event.target.value))}
                  />
                  <span className="bild-wert">{Math.round(doc.anpassung.swGruen * 100)}</span>
                </label>
                <p className="bild-hinweis">
                  Wie ein Filter vor dem Objektiv: Rot macht Himmel und Laub dunkel, Grün hebt Laub
                  und senkt Rot. Ohne Filter bekommen eine rote Rose und ein blauer Himmel gleicher
                  Helligkeit denselben Grauton.
                </p>
              </>
            )}

            {TONREGLER.map((regler) => {
              const wert = doc.anpassung[regler.key];
              return (
                <label
                  className="bild-schieber"
                  key={regler.key}
                  data-tipp={REGLER_TIPP[regler.key]}
                >
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

            {/*
              Zwei aufklappbare Abschnitte und keine zwei weiteren Reiter.

              Kurven und Farbbänder sind Werkzeuge für den zweiten Durchgang:
              Erst stellt man Licht und Farbe grob, dann feilt man. Als eigene
              Reiter stünden sie gleichberechtigt neben „Ton“ und drängten
              sich jedem auf, der nur ein Foto aufhellen will. Zugeklappt
              kosten sie eine Zeile.
            */}
            <details className="bild-klapp">
              <summary>Kurven</summary>
              <div className="bild-reihe" role="group" aria-label="Kanal der Kurve">
                {KURVENKANAELE.map((kanal) => (
                  <button
                    key={kanal.key}
                    type="button"
                    className={`btn btn-sm ${kurvenKanal === kanal.key ? 'is-active' : ''}`}
                    aria-pressed={kurvenKanal === kanal.key}
                    onClick={() => setKurvenKanal(kanal.key)}
                  >
                    {kanal.label}
                  </button>
                ))}
              </div>
              {/*
                Der Schlüssel ist der KANAL.
                Ohne ihn behält das Feld beim Wechsel seinen inneren Stand –
                unter anderem den ausgewählten Punkt, und der ist eine Nummer.
                Punkt 3 der Rotkurve ist beim Umschalten auf Blau noch immer
                „Punkt 3“, meint aber einen anderen. „Punkt entfernen“ nähme
                dann in der Blaukurve etwas weg, das man in der Roten
                ausgewählt hat.
              */}
              <Kurvenfeld
                key={kurvenKanal}
                label={`Kurve ${KURVENKANAELE.find((k) => k.key === kurvenKanal)?.label ?? ''}`}
                farbe={KURVENKANAELE.find((k) => k.key === kurvenKanal)?.farbe}
                punkte={(doc.anpassung.kurven ?? KURVEN_NEUTRAL)[kurvenKanal]}
                onBeginn={() => merkenGebuendelt(`kurve-${kurvenKanal}`)}
                onAendern={(punkte) => kurveSetzen(kurvenKanal, punkte)}
              />
              <p className="bild-hinweis">
                Tippen setzt einen Punkt, Ziehen verschiebt ihn. Die gestrichelte Linie ist „nichts
                tun“: Was darüber liegt, wird heller, was darunter liegt, dunkler. Die Enden bleiben
                links und rechts – ihre Höhe ist der Schwarz- und der Weisspunkt.
              </p>
            </details>

            <details className="bild-klapp">
              <summary>Farben einzeln</summary>
              <div className="bild-reihe" role="group" aria-label="Farbband">
                {BAENDER.map((band, i) => (
                  <button
                    key={band.key}
                    type="button"
                    className={`btn btn-sm ${bandIndex === i ? 'is-active' : ''}`}
                    aria-pressed={bandIndex === i}
                    onClick={() => setBandIndex(i)}
                    style={{
                      // Der Knopf trägt seine eigene Farbe – acht Wörter
                      // untereinander wären eine Liste, keine Farbauswahl.
                      borderColor: `hsl(${band.winkel} 70% 50%)`,
                    }}
                  >
                    {band.label}
                  </button>
                ))}
              </div>
              {BANDREGLER.map((regler) => {
                const band = (doc.anpassung.baender ?? BAENDER_NEUTRAL)[bandIndex] ?? {
                  farbton: 0,
                  saettigung: 0,
                  helligkeit: 0,
                };
                const wert = band[regler.key];
                return (
                  <label className="bild-schieber" key={regler.key} data-tipp={regler.tipp}>
                    <span>{regler.label}</span>
                    <input
                      type="range"
                      min={-1}
                      max={1}
                      step={0.01}
                      value={wert}
                      onChange={(event) =>
                        bandSetzen(bandIndex, regler.key, Number(event.target.value))
                      }
                      onDoubleClick={() => bandSetzen(bandIndex, regler.key, 0)}
                    />
                    <span className="bild-wert">
                      {wert > 0 ? '+' : ''}
                      {Math.round(wert * 100)}
                    </span>
                  </label>
                );
              })}
              <p className="bild-hinweis">
                Wirkt nur auf den gewählten Farbbereich – Laub grüner machen, ohne die Haut
                anzufassen. Graue und sehr blasse Stellen bleiben, wie sie sind: Dort gibt es keinen
                Farbton, an dem sich etwas festmachen liesse.
              </p>
            </details>

            {/*
              Die Entfaltung steht hier unten und zugeklappt, und das ist eine
              Aussage über die Reihenfolge: Erst Licht und Farbe, dann der
              Schärferegler – und nur wenn das Bild wirklich verwackelt ist,
              dieser Abschnitt. Er rechnet Sekunden und ersetzt das Foto; wer
              ein gutes Bild ein wenig knackiger will, ist beim Regler
              „Schärfe“ oben richtig.
            */}
            {/*
              Nicht im Videoeditor: Die Entfaltung ersetzt das Standbild,
              nicht den Film – eingestellt sähe man sie, im fertigen Film
              fehlte sie.
            */}
            {!onDokument && (
              <Entfaltungsfeld
                bild={bild}
                entfaltet={entfaltet}
                onAnwenden={(neu) => {
                  if (!urbildRef.current) urbildRef.current = bild;
                  setBild(neu);
                  setEntfaltet(true);
                }}
                onZuruecknehmen={() => {
                  if (urbildRef.current) setBild(urbildRef.current);
                  setEntfaltet(false);
                }}
              />
            )}
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
                title={netzVerfuegbar('person') ? undefined : netzGrund('person')}
              >
                👤 Person
              </button>
              {/*
                  EIN Knopf „Motiv“, und die Güte steht als Schalter darunter.

                  Vorher standen „Motiv“ und „Hohe Qualität“ als zwei Knöpfe
                  nebeneinander – zwei Namen für dieselbe Handlung, die sich
                  nur im Modell unterscheiden. Wer „Motiv + Tiefe“ wollte,
                  hatte die Wahl gar nicht: Der Knopf nahm fest das kleine
                  Modell, ausgerechnet für den Fall, für den die feine Kante
                  gebaut wurde.
              */}
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  const netz = gewaehlterFreisteller(qualitaet, grafikAus === null);
                  if (netz) void netzTeilAnlegen(netz);
                }}
                disabled={netzLaeuft !== null || freistellerFehlt !== null}
                title={freistellerFehlt ?? undefined}
              >
                🖼 Motiv
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void tiefeTeilAnlegen()}
                disabled={netzLaeuft !== null || !tiefeVerfuegbar()}
                title={tiefeVerfuegbar() ? 'Schätzt die Entfernung je Bildpunkt' : tiefeGrund()}
              >
                🔭 Tiefe
              </button>
              {/*
                  „Antippen“ steht in DIESER Reihe, obwohl es ein Zustand ist
                  und kein einzelner Griff.

                  Weil es hier gesucht wird: Die Reihe beantwortet die Frage
                  „wie mache ich eine Maske?“, und antippen ist eine Antwort
                  darauf – für alles, wofür kein Modell trainiert wurde und was
                  keine Form hat, die sich ziehen liesse. Ein Schatten auf einer
                  Wand, ein Stück Himmel zwischen zwei Ästen.

                  `aria-pressed` und der Name „an/aus“ sagen, dass er anders
                  ist als seine Nachbarn: Die legen sofort etwas an, dieser
                  wartet auf einen Finger im Bild.
              */}
              <button
                type="button"
                className={`btn btn-sm ${tippAktiv ? 'is-active' : ''}`}
                aria-pressed={tippAktiv}
                onClick={() => setBereichModus(tippAktiv ? 'griffe' : 'antippen')}
                disabled={netzLaeuft !== null}
                title="Tippe ins Bild auf das, was in den Bereich gehört"
              >
                👆 Antippen {tippAktiv ? 'an' : 'aus'}
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void kombiAnlegen()}
                disabled={netzLaeuft !== null || !tiefeVerfuegbar()}
                title={
                  tiefeVerfuegbar()
                    ? 'Kante vom Freisteller, Entfernung vom Tiefenmodell'
                    : tiefeGrund()
                }
              >
                🎯 Motiv + Tiefe
              </button>
            </div>

            {/*
                Die Einstellungen zum Antippen – eingerückt, wie die Güte
                darunter und wie der Antipp-Schalter im Sticker-Studio.

                Sie stehen nur da, solange antippen an ist. Vier Knöpfe und ein
                Regler, die dauerhaft unter der Formenreihe hängen, sind für die
                meisten Bilder Lärm: Wer einen Verlauf zieht, hat mit der
                Farbtoleranz nichts zu schaffen.
            */}
            {tippAktiv && (
              <div className="bild-antippen bild-unterzeile">
                <div className="bild-reihe">
                  {/*
                      Der Netz-Schalter lädt NICHTS, solange niemand tippt – er
                      ist eine Absichtserklärung. Die Zahl steht dran, solange
                      das Modell nicht da ist: 30 MB auf einem Mobilfunkvertrag
                      sind eine Entscheidung, keine Fussnote.
                  */}
                  <button
                    type="button"
                    className={`btn btn-sm ${tippMitNetz ? 'is-active' : ''}`}
                    aria-pressed={tippMitNetz}
                    onClick={() => {
                      const naechst = !tippMitNetz;
                      setTippMitNetz(naechst);
                      // Derselbe Schalter wie im Sticker-Studio, dieselbe
                      // Kiste: Es ist dasselbe Modell und dieselbe
                      // Entscheidung über den Download.
                      writeEngineSetting('tippen', naechst);
                    }}
                    disabled={netzLaeuft !== null}
                    title="Statt nach Farbe zu fluten, versteht ein Netz, was ein Gegenstand ist."
                  >
                    {tippMitNetz ? '☑' : '☐'} mit Netz
                    {!tippNetzVerfuegbar() && ` — einmalig ${firstUseMb(engineInfo('tippen'))} MB`}
                  </button>
                  {/*
                      Plus und Minus gelten für BEIDE Wege. Ein Minus-Tipp
                      heisst nicht „dieser Punkt gehört nicht zum vorigen Ding“,
                      sondern „finde, was hier liegt, und nimm es weg“ – das
                      kann die Farbflutung genauso.
                  */}
                  <button
                    type="button"
                    className={`btn btn-sm ${tippVorzeichen === 'weg' ? 'is-active' : ''}`}
                    aria-pressed={tippVorzeichen === 'weg'}
                    onClick={() => setTippVorzeichen(tippVorzeichen === 'weg' ? 'dazu' : 'weg')}
                    disabled={netzLaeuft !== null}
                  >
                    {tippVorzeichen === 'weg' ? '➖ Wegnehmen' : '➕ Dazunehmen'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => void tippZurueck()}
                    disabled={netzLaeuft !== null || !tippTeilJetzt}
                  >
                    ↩ Letzten Tipp zurück
                  </button>
                </div>
                {/*
                    Die Toleranz nur OHNE Netz.

                    Mit Netz entscheidet das Modell, was ein Gegenstand ist –
                    ein Farbabstand kommt darin nicht vor. Ein Regler, der
                    sichtbar ist und nichts bewirkt, ist schlimmer als keiner:
                    Wer damit eine schlechte Maske zu retten versucht, dreht
                    minutenlang an etwas, das gar nicht zuhört.
                */}
                {!tippNetzGilt && (
                  <label className="feld bild-tipp-regler">
                    <span>Farbtoleranz {tippToleranz}</span>
                    <input
                      type="range"
                      min={2}
                      max={160}
                      step={1}
                      value={tippToleranz}
                      disabled={netzLaeuft !== null}
                      onChange={(ereignis) => toleranzSchieben(Number(ereignis.target.value))}
                    />
                  </label>
                )}
                <p className="bild-hinweis">
                  {tippTeilJetzt
                    ? `${tippTeilJetzt.punkte.length === 1 ? '1 Stelle' : `${tippTeilJetzt.punkte.length} Stellen`} ${
                        tippVorzeichen === 'weg' ? 'weggenommen' : 'dazugenommen'
                      }. `
                    : ''}
                  {tippNetzGilt
                    ? 'Tippe mitten auf das Ding – das Netz nimmt es mit seiner ganzen Kante.'
                    : 'Tippe auf eine Farbfläche. Passt der Ausschnitt nicht, zieh die Toleranz – die Maske rechnet mit.'}
                </p>
              </div>
            )}

            {/*
                Die Güte als Schalter, nicht als eigener Knopf.

                Eingerückt unter der Reihe, nach dem Vorbild des
                Antipp-Schalters im Sticker-Studio: Die Reihe darüber sind
                HANDLUNGEN, dies hier ist eine EINSTELLUNG, die für zwei von
                ihnen gilt. Als sechster Knopf in derselben Reihe sah es aus
                wie eine sechste Handlung.

                Ein Klick auf „an“ schaltet das Verfahren gleich mit ein,
                statt in die Einstellungen zu verweisen – dieselbe
                Entscheidung wie bei den Hinweisen weiter unten.
            */}
            <div className="bild-reihe bild-unterzeile">
              <button
                type="button"
                className={`btn btn-sm ${qualitaet === 'hoch' ? 'is-active' : ''}`}
                aria-pressed={qualitaet === 'hoch'}
                disabled={grafikAus !== null}
                onClick={() => {
                  const naechst: Qualitaet = qualitaet === 'hoch' ? 'niedrig' : 'hoch';
                  setQualitaet(writeQualitaet(naechst));
                  if (naechst === 'hoch') einschalten(freistellerFuer('hoch'));
                }}
              >
                ✨ Hohe Qualität {qualitaet === 'hoch' ? 'an' : 'aus'}
                {qualitaet !== 'hoch' &&
                  !netzVerfuegbar('birefnet') &&
                  ` — einmalig ${firstUseMb(engineInfo('birefnet'))} MB`}
              </button>
              <span className="bild-hinweis-klein">
                Gilt für „Motiv“ und „Motiv + Tiefe“: die genaueste Kante – an Haaren, Zäunen,
                Brillenbügeln.
              </span>
            </div>
            {/*
                Sichtbar, nicht als Tooltip: Auf einem Telefon gibt es kein
                Schweben, und ein abgeblendeter Knopf nimmt nicht einmal eine
                Berührung entgegen. Genau das war schon einmal eine Meldung.
            */}
            {grafikAus && <p className="bild-hinweis bild-hinweis-warn">{grafikAus.grund}</p>}

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
            {/*
                Zu JEDEM grauen Knopf steht, warum er grau ist.

                Erklärt war nur „Motiv“. „Person“, „Tiefe“ und „Motiv + Tiefe“
                waren dauerhaft grau, und wer sie brauchte, hatte keinen
                Anhaltspunkt, wo das umzustellen wäre – dabei liefern
                `netzGrund` und `tiefeGrund` genau diesen Satz und waren hier
                nicht einmal eingebunden.

                Sichtbarer Text, kein `title`: Auf einem Telefon gibt es kein
                Schweben.
            */}
            {/*
                Nicht mehr an `!netzFehler` gekoppelt.

                Eine Fehlermeldung aus einem Lauf und die Begründung einer
                Sperre sind zwei verschiedene Aussagen. Vorher verschwand die
                Begründung für ALLE grauen Knöpfe, sobald irgendein Lauf
                einmal gescheitert war – also genau dann, wenn jemand sie am
                dringendsten braucht.

                Und der Schalter steht hier, statt dass hier steht, wo er
                steht: Wer lesen muss „schalt es in den Einstellungen ein“,
                verlässt den Editor, sucht, und kommt mit einem halb fertigen
                Bild zurück – wenn überhaupt.
            */}
            {!netzVerfuegbar('object') && (
              <p className="bild-hinweis">
                „Motiv“ ist abgeschaltet und lädt beim ersten Mal {firstUseMb(engineInfo('object'))}{' '}
                MB.{' '}
                <button type="button" className="btn btn-sm" onClick={() => einschalten('object')}>
                  Einschalten
                </button>
              </p>
            )}
            {!netzVerfuegbar('person') && (
              <p className="bild-hinweis">
                {netzGrund('person')}{' '}
                <button type="button" className="btn btn-sm" onClick={() => einschalten('person')}>
                  Einschalten
                </button>
              </p>
            )}
            {!netzVerfuegbar('birefnet') && (
              <p className="bild-hinweis">
                „Hohe Qualität“ ist abgeschaltet und lädt beim ersten Mal{' '}
                {firstUseMb(engineInfo('birefnet'))} MB. Es braucht eine Grafikeinheit, gibt dafür
                die genaueste Kante.{' '}
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => einschalten('birefnet')}
                >
                  Einschalten
                </button>
              </p>
            )}
            {!tiefeVerfuegbar() && (
              <p className="bild-hinweis">
                „Tiefenschärfe“ ist abgeschaltet und lädt beim ersten Mal{' '}
                {firstUseMb(engineInfo('tiefe'))} MB. Damit sind „🔭 Tiefe“ und „🎯 Motiv + Tiefe“
                gesperrt.{' '}
                <button type="button" className="btn btn-sm" onClick={() => einschalten('tiefe')}>
                  Einschalten
                </button>
              </p>
            )}
            {tiefeVerfuegbar() && !netzFehler && (
              /*
               * Der Unterschied zwischen den beiden Tiefenknöpfen ist der
               * ganze Punkt und lässt sich nicht erraten – also steht er da.
               */
              <p className="bild-hinweis">
                „🎯 Motiv + Tiefe“ nimmt die Kante vom Freisteller und die Entfernung vom
                Tiefenmodell: Das Motiv bleibt scharf, dahinter wächst die Unschärfe mit der
                Entfernung. „🔭 Tiefe“ allein wirkt auch IM Motiv – gut für Bilder ohne
                freistellbares Motiv, dafür mit weicher Silhouette.
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
                            : teil.art === 'tiefe'
                              ? 'Tiefe'
                              : teil.art === 'tipp'
                                ? teil.mitNetz
                                  ? 'Getippt'
                                  : 'Farbe'
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

                {/*
                    Warum tut dieser Knopf nichts?

                    Zwei Fälle machten „Umkehren“ unberechenbar, und beide
                    hängen nicht am Umkehren selbst, sondern an der Stellung
                    des Teils in der Liste:

                      * Ein erstes Teil auf „Weg“ oder „Nur“ rechnet gegen
                        eine leere Auswahl. Es bleibt leer – mit und ohne
                        Umkehren. Der Knopf schien tot.
                      * Ein leeres Teil auf „Dazu“ deckt umgekehrt alles ab.
                        Es sah aus, als markiere Umkehren wahllos das ganze
                        Bild.

                    Beides steht jetzt da, mitsamt dem Griff, der es behebt.
                */}
                {aktivesTeil &&
                  (() => {
                    const befund = teilBefund(
                      aktiverBereich.teile,
                      aktiverBereich.teile.findIndex((t) => t.id === aktivesTeil.id),
                    );
                    if (befund === 'ohne-wirkung') {
                      return (
                        <p className="bild-hinweis">
                          Diese Maske wirkt noch nicht: „
                          {aktivesTeil.modus === 'weg' ? 'Weg' : 'Nur'}“ nimmt von dem weg, was
                          vorher ausgewählt ist – und davor ist noch nichts.{' '}
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => teilAendern({ modus: 'dazu' })}
                          >
                            Auf „Dazu“ stellen
                          </button>
                        </p>
                      );
                    }
                    if (befund === 'deckt-alles') {
                      return (
                        <p className="bild-hinweis">
                          Diese Maske ist leer, umgekehrt deckt sie deshalb das ganze Bild ab. Mal
                          etwas hinein – oder nimm das Umkehren zurück.
                        </p>
                      );
                    }
                    return null;
                  })()}

                {aktivesTeil?.art === 'radial' && (
                  <label
                    className="bild-schieber"
                    data-tipp="Wie weich der Rand der Ellipse ausläuft – klein heisst harte Kante"
                  >
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

                {aktivesTeil?.art === 'tiefe' && (
                  <>
                    {/*
                     * Beide Regler ändern nur, WIE die vorhandene Karte
                     * gelesen wird – das Modell läuft dabei nicht noch
                     * einmal. Deshalb dürfen sie ganz normale Schieber sein
                     * und müssen kein Knopf mit Fortschrittsanzeige werden.
                     */}
                    <label className="bild-schieber">
                      <span>Fokus</span>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.01}
                        value={aktivesTeil.fokus}
                        onChange={(event) =>
                          teilAendern({ fokus: Number(event.target.value) } as Partial<Maskenteil>)
                        }
                      />
                      <span className="bild-wert">{Math.round(aktivesTeil.fokus * 100)}</span>
                    </label>
                    <label className="bild-schieber">
                      <span>Tiefenbereich</span>
                      <input
                        type="range"
                        min={0.02}
                        max={1}
                        step={0.01}
                        value={aktivesTeil.spanne}
                        onChange={(event) =>
                          teilAendern({ spanne: Number(event.target.value) } as Partial<Maskenteil>)
                        }
                      />
                      <span className="bild-wert">{Math.round(aktivesTeil.spanne * 100)}</span>
                    </label>
                    <p className="bild-hinweis">
                      „Fokus“ ist die Entfernung, die scharf bleibt – 100 ist ganz vorne, 0 ganz
                      hinten. „Tiefenbereich“ sagt, wie schnell es davor und dahinter unscharf wird.
                      Die Unschärfe selbst stellst du unten am Regler „Weichzeichnen“ ein.
                    </p>
                  </>
                )}

                {aktivesTeil?.art === 'pinsel' && (
                  <>
                    <div className="bild-reihe">
                      <button
                        type="button"
                        className={`btn btn-sm ${pinselModus === 'malen' ? 'is-active' : ''}`}
                        aria-pressed={pinselModus === 'malen'}
                        onClick={() => setPinselModus('malen')}
                      >
                        🖌 Malen
                      </button>
                      <button
                        type="button"
                        className={`btn btn-sm ${pinselModus === 'radieren' ? 'is-active' : ''}`}
                        aria-pressed={pinselModus === 'radieren'}
                        onClick={() => setPinselModus('radieren')}
                      >
                        🧽 Radieren
                      </button>
                      <button
                        type="button"
                        className={`btn btn-sm ${pinselModus === 'weg' ? 'is-active' : ''}`}
                        aria-pressed={pinselModus === 'weg'}
                        onClick={() => {
                          setPinselModus('weg');
                          // Man kann nicht antippen, was man nicht sieht.
                          // Ohne den Schleier zielt man auf unsichtbare
                          // Striche und trifft nach Gefühl.
                          setSchleier(true);
                        }}
                        title="Einen einzelnen Strich antippen und entfernen"
                      >
                        ✂️ Strich löschen
                      </button>
                    </div>
                    {pinselModus === 'weg' && (
                      <p className="bild-hinweis">
                        Tippe einen Strich an, um ihn zu entfernen – auch einen alten, ohne alles
                        danach zurückzunehmen. Für „den letzten wieder weg“ genügt ↺ oben.
                      </p>
                    )}
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
                    <label
                      className="bild-schieber"
                      key={regler.key}
                      data-tipp={REGLER_TIPP[regler.key]}
                    >
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
                  ['klon', '🩹 Stempel'],
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
            {malart === 'klon' && (
              <p className="bild-hinweis">
                {klonQuelle
                  ? 'Die Quelle steht. Mal jetzt über die Stelle, die verschwinden soll – gelesen wird vom gesetzten Punkt aus, im selben Abstand.'
                  : 'Tipp zuerst auf eine saubere Stelle, von der kopiert werden soll. Danach malst du damit über den Fleck.'}{' '}
                {klonQuelle && (
                  <button type="button" className="btn btn-sm" onClick={() => setKlonQuelle(null)}>
                    Quelle neu setzen
                  </button>
                )}
              </p>
            )}
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
                      data-tipp={
                        aktiverText.kontur === '#111111'
                          ? 'Tippen macht die Kontur hell'
                          : 'Tippen macht die Kontur dunkel'
                      }
                    >
                      {/*
                        Der Doppelpunkt ist der ganze Unterschied.
                        „Kontur dunkel" las sich wie ein Befehl – und stellte
                        beim Drücken das Gegenteil ein, weil die Beschriftung
                        den AKTUELLEN Zustand nannte. Anders als die
                        Nachbarknöpfe trug dieser auch keine Markierung, die
                        ihn als Anzeige kenntlich gemacht hätte.
                      */}
                      Kontur: {aktiverText.kontur === '#111111' ? 'dunkel' : 'hell'}
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
          {/*
            Geht die BEARBEITUNG heraus und nicht ein Bild, bleibt genau ein
            Knopf. Die anderen lieferten ein Foto – und geholt wurde ein Film.
          */}
          {onDokument ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void dokumentAbgeben()}
              disabled={laedt || speichert || !doc}
            >
              {speichert ? '…' : dokumentName}
            </button>
          ) : (
            <button
              type="button"
              className={onFertig ? 'btn btn-sm' : 'btn btn-primary'}
              onClick={() => void aufsHandy()}
              disabled={laedt || speichert}
            >
              ⬇ Aufs Handy {onFertig ? '' : 'speichern'}
            </button>
          )}
          {onFertig && !onDokument && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void inDieApp()}
              disabled={laedt || speichert}
            >
              {speichert ? '…' : (zielName ?? 'Als neue Datei sichern')}
            </button>
          )}
          {onStapel && stapelAnzahl > 0 && !onDokument && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void stapelUebertragen()}
              disabled={laedt || speichert || istNeutral(doc?.anpassung ?? NEUTRAL)}
              data-tipp="Belichtung, Farbe, Kurven und Farbbänder auf die anderen Bilder der Auswahl – Zuschnitt, Striche und Bereiche bleiben, wo sie sind"
            >
              ✨ Auf alle {stapelAnzahl + 1}
            </button>
          )}
          {onRezept && !onDokument && (
            /*
             * IMMER da, nur manchmal gesperrt – und der Grund steht im Tipp.
             *
             * Der Knopf hing vorher an `rezeptGeht`, und darin steckt
             * `doc.striche.length`: Er verschwand also genau dann, wenn
             * jemand den ersten Strich malte – zusammen mit zwei
             * Hinweiszeilen, die je nach Dokument drei oder vier Zeilen hoch
             * waren. Die Leinwand bekommt, was das Bedienfeld übrig lässt,
             * und wuchs damit mitten im Strich.
             *
             * Nachgemessen auf dem Telefon, an derselben Stelle im Ablauf:
             * 243 × 325 Punkte Leinwand mit den beiden Hinweisen, 290 × 386
             * ohne sie. Die zwei Zeilen kosteten also ein Sechstel der
             * Bildfläche – und zwar solange, bis man zu malen anfing.
             *
             * Ein gesperrter Knopf mit Begründung ist ausserdem auffindbarer
             * als einer, der gar nicht erst erscheint: Wer wissen will, warum
             * es hier kein Rezept gibt, bekommt eine Antwort statt einer
             * Leerstelle.
             */
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                if (laedt || speichert) return;
                // Gesperrt heisst nicht stumm: Ein Tipp darauf sagt, woran es
                // liegt. Siehe `aria-disabled` in `global.css`.
                if (!rezeptGeht) {
                  toast(rezeptGrund, 'info');
                  return;
                }
                void alsRezept();
              }}
              aria-disabled={laedt || speichert || !rezeptGeht}
              data-tipp={rezeptGrund}
            >
              🧪 Als Rezept
            </button>
          )}
        </div>
        {unberuehrt && !laedt && !onDokument && (
          <p className="bild-hinweis">
            Noch nichts geändert – gespeichert würde eine Kopie des Originals.
          </p>
        )}
      </div>

      <ConfirmDialog
        open={schliessFrage}
        title="Bearbeitung verwerfen?"
        description="Regler, Bereiche, Striche und Schrift gehen verloren. Ein Modelllauf, der schon gerechnet hat, ist danach noch einmal fällig."
        confirmLabel="Verwerfen"
        cancelLabel="Weiter bearbeiten"
        danger
        onCancel={() => setSchliessFrage(false)}
        onConfirm={() => {
          setSchliessFrage(false);
          /*
           * „Verwerfen" heisst verwerfen – auch den Entwurf.
           *
           * Ohne das stünde die Bearbeitung beim nächsten Aufmachen wieder da,
           * obwohl gerade jemand ausdrücklich das Gegenteil gesagt hat. Das
           * wäre schlimmer als gar kein Entwurf.
           */
          if (kennung) void entwurfLoeschen(kennung);
          onClose();
        }}
      />

      {/*
       * Gefragt wird, nicht angewandt.
       *
       * Ein Entwurf, der sich beim Aufmachen von selbst über das Bild legt,
       * ist eine Überraschung – und wer nur schnell etwas anderes machen
       * wollte, müsste erst herausfinden, woher die Regler kommen. Deshalb
       * die Frage, und deshalb steht das Alter darin: „von vor drei Minuten"
       * beantwortet sie meistens von allein.
       */}
      <ConfirmDialog
        open={entwurfsfrage !== null}
        title="Entwurf weiterführen?"
        description={`Zu diesem Bild liegt eine unfertige Bearbeitung ${entwurfsfrage?.alter ?? ''} – aus einer Sitzung, die nicht zu Ende gebracht wurde.`}
        confirmLabel="Weiterführen"
        cancelLabel="Neu anfangen"
        onCancel={() => {
          setEntwurfsfrage(null);
          if (kennung) void entwurfLoeschen(kennung);
        }}
        onConfirm={() => {
          const gefunden = entwurfsfrage?.doc;
          setEntwurfsfrage(null);
          if (!gefunden) return;
          /*
           * Der Verlauf bekommt den Stand VOR dem Entwurf.
           *
           * Damit führt ein einzelnes „Rückgängig" zurück auf das unbearbeitete
           * Bild. Ohne das wäre der Entwurf der Anfang der Welt, und wer ihn
           * versehentlich angenommen hat, käme nicht mehr davon los.
           */
          merken();
          setDoc(gefunden);
        }}
      />
    </div>,
    document.body,
  );
}
