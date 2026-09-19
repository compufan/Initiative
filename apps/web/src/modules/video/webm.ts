import { Bytepuffer } from '../../lib/bytes.js';

/**
 * Ein WebM-Behälter von Hand – damit aus bearbeiteten Bildern wieder ein
 * Video wird.
 *
 * # Warum nicht `MediaRecorder`
 *
 * Weil `MediaRecorder` an einer Leinwand hängt und die Zeit vom WANDUHR
 * nimmt. Nachgemessen in Chromium: dreissig Bilder, die 640 ms Rechenzeit
 * brauchten, ergaben ein Video von 0,61 s – nicht von 3 s, wie es bei
 * zehn Bildern je Sekunde sein müsste. Wer also pro Bild eine Sekunde
 * rechnet, bekommt ein Video in Zeitlupe, und zwar ohne Fehlermeldung.
 *
 * Mit `VideoEncoder` steht die Zeit an jedem Bild, und wie lange das Rechnen
 * gedauert hat, spielt keine Rolle. Was dann noch fehlt, ist der Behälter –
 * und den gibt es in keinem Browser. Also hier.
 *
 * # Warum das überschaubar ist
 *
 * Matroska ist ein Baum aus Kennung, Länge, Inhalt. Für ein Video ohne Ton,
 * ohne Kapitel und ohne Untertitel braucht es davon sieben Knoten. VP8 und
 * VP9 brauchen ausserdem keine `CodecPrivate` – anders als AV1 und H.264,
 * die ihre eigenen Kopfdaten mitschleppen müssten. Genau deshalb werden hier
 * auch nur diese beiden angeboten.
 *
 * Geprüft wird das Ergebnis nicht an einer hinterlegten Datei, sondern daran,
 * dass ein echter Browser es abspielt – siehe `e2e/videoSchreiben.spec.ts`.
 */

/* ---------- Kennungen ---------- */

const EBML = 0x1a45dfa3;
const EBML_VERSION = 0x4286;
const EBML_READ_VERSION = 0x42f7;
const EBML_MAX_ID = 0x42f2;
const EBML_MAX_SIZE = 0x42f3;
const DOC_TYPE = 0x4282;
const DOC_TYPE_VERSION = 0x4287;
const DOC_TYPE_READ_VERSION = 0x4285;

const SEGMENT = 0x18538067;
const INFO = 0x1549a966;
const TIMECODE_SCALE = 0x2ad7b1;
const MUXING_APP = 0x4d80;
const WRITING_APP = 0x5741;
const DURATION = 0x4489;

const TRACKS = 0x1654ae6b;
const TRACK_ENTRY = 0xae;
const TRACK_NUMBER = 0xd7;
const TRACK_UID = 0x73c5;
const TRACK_TYPE = 0x83;
const FLAG_LACING = 0x9c;
const CODEC_ID = 0x86;
const VIDEO = 0xe0;
const PIXEL_WIDTH = 0xb0;
const PIXEL_HEIGHT = 0xba;

const CLUSTER = 0x1f43b675;
const TIMECODE = 0xe7;
const SIMPLE_BLOCK = 0xa3;

const CUES = 0x1c53bb6b;
const CUE_POINT = 0xbb;
const CUE_TIME = 0xb3;
const CUE_TRACK_POSITIONS = 0xb7;
const CUE_TRACK = 0xf7;
const CUE_CLUSTER_POSITION = 0xf1;

/**
 * Eine Millisekunde je Zeiteinheit.
 *
 * Matroska zählt in Nanosekunden mal diesem Faktor. Eine Millisekunde ist die
 * übliche Wahl und genau genug: Bei 25 Bildern je Sekunde sind das 40 ganze
 * Einheiten je Bild.
 */
const ZEITEINHEIT_NS = 1_000_000;

/**
 * Wie lang ein Haufen höchstens wird.
 *
 * Die Zeitangabe an einem Block ist eine VORZEICHENBEHAFTETE 16-Bit-Zahl,
 * gezählt ab dem Anfang seines Haufens – mehr als 32 767 ms passen also gar
 * nicht hinein. 30 Sekunden lassen Luft und sind zugleich das, was Abspieler
 * zum Springen erwarten.
 */
const HAUFEN_MS = 30_000;

/* ---------- Die Bausteine ---------- */

/** Eine Kennung in ihre Bytes zerlegen – sie steht schon in Matroska-Form da. */
function kennung(wert: number): number[] {
  const bytes: number[] = [];
  let laenge = 1;
  if (wert > 0xff_ffff) laenge = 4;
  else if (wert > 0xffff) laenge = 3;
  else if (wert > 0xff) laenge = 2;
  for (let i = laenge - 1; i >= 0; i -= 1) bytes.push((wert >> (i * 8)) & 0xff);
  return bytes;
}

/**
 * Eine Länge als variabel lange Zahl.
 *
 * Das erste gesetzte Bit sagt, wie viele Bytes folgen: `1xxxxxxx` ist eins,
 * `01xxxxxx xxxxxxxx` sind zwei, und so weiter. Ein Wert, dessen Bits alle
 * gesetzt wären, bedeutet „unbekannte Länge" – deshalb steht die Grenze je
 * Stufe bei 2^(7n) − 1 und nicht bei 2^(7n).
 */
export function vint(wert: number): number[] {
  if (wert < 0) throw new Error('Eine Länge kann nicht negativ sein');
  for (let laenge = 1; laenge <= 8; laenge += 1) {
    const grenze = 2 ** (7 * laenge) - 1;
    if (wert >= grenze) continue;
    const bytes: number[] = [];
    let rest = wert;
    for (let i = laenge - 1; i >= 0; i -= 1) {
      bytes[i] = rest & 0xff;
      // `Math.floor(rest / 256)` und nicht `rest >>= 8`: Bitschieben rechnet
      // in JavaScript mit 32 Bit, und eine Länge kann darüber liegen.
      rest = Math.floor(rest / 256);
    }
    bytes[0] |= 1 << (8 - laenge);
    return bytes;
  }
  throw new Error('Diese Länge passt in keinen WebM-Behälter');
}

/** Eine ganze Zahl so kurz wie möglich – Matroska erlaubt jede Länge bis acht. */
function ganzzahl(wert: number): number[] {
  if (wert === 0) return [0];
  const bytes: number[] = [];
  let rest = wert;
  while (rest > 0) {
    bytes.unshift(rest & 0xff);
    rest = Math.floor(rest / 256);
  }
  return bytes;
}

/** Ein Knoten: Kennung, Länge, Inhalt. */
function knoten(id: number, inhalt: number[] | Uint8Array): number[] {
  return [...kennung(id), ...vint(inhalt.length), ...inhalt];
}

function zahlKnoten(id: number, wert: number): number[] {
  return knoten(id, ganzzahl(wert));
}

function textKnoten(id: number, text: string): number[] {
  return knoten(id, [...new TextEncoder().encode(text)]);
}

function kommaKnoten(id: number, wert: number): number[] {
  const feld = new Uint8Array(8);
  new DataView(feld.buffer).setFloat64(0, wert, false);
  return knoten(id, feld);
}

/* ---------- Die Datei ---------- */

export type WebmCodec = 'vp9' | 'vp8';

/** Wie der Codec im Behälter heisst. Die Namen stehen so in der Matroska-Liste. */
const CODEC_NAME: Record<WebmCodec, string> = {
  vp9: 'V_VP9',
  vp8: 'V_VP8',
};

export interface WebmBild {
  /** Die kodierten Bytes, so wie sie aus `VideoEncoder` kommen. */
  readonly daten: Uint8Array;
  /** Der Zeitpunkt in Millisekunden ab Anfang. */
  readonly zeitMs: number;
  /** Ob das Bild für sich allein steht. */
  readonly schluessel: boolean;
}

export interface WebmAuftrag {
  readonly codec: WebmCodec;
  readonly breite: number;
  readonly hoehe: number;
  /** Die Gesamtlänge in Millisekunden – sie steht im Kopf. */
  readonly dauerMs: number;
}

export function webmSchreiben(bilder: readonly WebmBild[], auftrag: WebmAuftrag): Uint8Array {
  if (bilder.length === 0) throw new Error('Ein Video ohne Bilder gibt es nicht');
  if (!bilder[0].schluessel) {
    /*
     * Das erste Bild MUSS für sich allein stehen. Sonst hat der Abspieler
     * nichts, worauf er die folgenden beziehen könnte – und je nach Abspieler
     * bleibt das Bild schwarz, statt dass er sich beschwert.
     */
    throw new Error('Das erste Bild muss ein Schlüsselbild sein');
  }

  const kopf = [
    ...zahlKnoten(EBML_VERSION, 1),
    ...zahlKnoten(EBML_READ_VERSION, 1),
    ...zahlKnoten(EBML_MAX_ID, 4),
    ...zahlKnoten(EBML_MAX_SIZE, 8),
    ...textKnoten(DOC_TYPE, 'webm'),
    ...zahlKnoten(DOC_TYPE_VERSION, 2),
    ...zahlKnoten(DOC_TYPE_READ_VERSION, 2),
  ];

  const info = [
    ...zahlKnoten(TIMECODE_SCALE, ZEITEINHEIT_NS),
    ...textKnoten(MUXING_APP, 'Initiative'),
    ...textKnoten(WRITING_APP, 'Initiative'),
    ...kommaKnoten(DURATION, Math.max(1, auftrag.dauerMs)),
  ];

  const spur = [
    ...zahlKnoten(TRACK_NUMBER, 1),
    ...zahlKnoten(TRACK_UID, 1),
    // 1 heisst Video. Ton wäre 2, und den gibt es hier nicht.
    ...zahlKnoten(TRACK_TYPE, 1),
    ...zahlKnoten(FLAG_LACING, 0),
    ...textKnoten(CODEC_ID, CODEC_NAME[auftrag.codec]),
    ...knoten(VIDEO, [
      ...zahlKnoten(PIXEL_WIDTH, auftrag.breite),
      ...zahlKnoten(PIXEL_HEIGHT, auftrag.hoehe),
    ]),
  ];

  /* ---------- Die Haufen ---------- */

  const haufenBytes = new Bytepuffer();
  /** Je Haufen sein Zeitpunkt und wo er beginnt – gemessen ab dem ersten Haufen. */
  const marken: { zeitMs: number; versatz: number }[] = [];

  let at = 0;
  while (at < bilder.length) {
    const beginn = bilder[at].zeitMs;
    const bloecke = new Bytepuffer();
    /*
     * Ein neuer Haufen beginnt bei jedem Schlüsselbild – so kann ein
     * Abspieler springen, ohne die Datei von vorn zu lesen. Und spätestens
     * nach dreissig Sekunden, weil die Zeitangabe an einem Block nur sechzehn
     * Bit hat.
     */
    do {
      const bild = bilder[at];
      const versatz = bild.zeitMs - beginn;
      const block = new Bytepuffer();
      block.bytes(...vint(1)); // Spurnummer
      block.bytes((versatz >> 8) & 0xff, versatz & 0xff);
      // 0x80 heisst „steht für sich allein“. Alles andere bleibt aus: kein
      // Verschränken, kein Verwerfen.
      block.byte(bild.schluessel ? 0x80 : 0x00);
      block.feld(bild.daten);
      const fertig = block.fertig();
      bloecke.feld(Uint8Array.from(kennung(SIMPLE_BLOCK)));
      bloecke.feld(Uint8Array.from(vint(fertig.length)));
      bloecke.feld(fertig);
      at += 1;
    } while (
      at < bilder.length &&
      !bilder[at].schluessel &&
      bilder[at].zeitMs - beginn < HAUFEN_MS
    );

    marken.push({ zeitMs: beginn, versatz: haufenBytes.groesse });
    const haufen = [...zahlKnoten(TIMECODE, beginn), ...bloecke.fertig()];
    haufenBytes.feld(Uint8Array.from(knoten(CLUSTER, haufen)));
  }

  /* ---------- Der Suchindex ---------- */

  /*
   * Ohne `Cues` findet ein Abspieler beim Springen nur ungefähr die richtige
   * Stelle – er muss die Haufen von vorn durchgehen und schätzt dabei. Unter
   * Last fiel das in `e2e/videoSchreiben.spec.ts` auf: Der Sprung auf 2,25 s
   * lieferte das Bild vom Anfang, und zwar nur, wenn nebenher zweihundert
   * andere Prüfungen liefen. Einzeln ging es jedes Mal gut – die
   * unangenehmste Art von Fehler.
   *
   * Der Index steht VOR den Haufen, damit er schon beim Öffnen der Datei
   * gelesen wird und nicht erst, wenn jemand bis ans Ende geladen hat.
   *
   * Das ist der Grund für die Schleife: Wo ein Haufen liegt, wird ab dem
   * Anfang der Nutzdaten gezählt – und dazu gehört der Index selbst. Seine
   * Länge hängt also von den Zahlen ab, die in ihm stehen. Zwei bis drei
   * Durchgänge genügen, weil die Längenangaben nur wachsen und nie schrumpfen.
   */
  const vorlauf = knoten(INFO, info).length + knoten(TRACKS, knoten(TRACK_ENTRY, spur)).length;
  let cues = cuesBauen(marken, vorlauf);
  for (let runde = 0; runde < 4; runde += 1) {
    const naechste = cuesBauen(marken, vorlauf + cues.length);
    /*
     * Erst übernehmen, dann abbrechen – nicht umgekehrt.
     *
     * Hier stand `if (gleich) break;` VOR der Zuweisung, und damit blieb
     * immer die Fassung stehen, die noch ohne den Index selbst gerechnet
     * hatte: Jeder Eintrag zeigte um die Länge des Index zu weit nach vorn
     * (gemessen 46 Byte). Ein Abspieler sprang dann mitten in die Kopfdaten.
     */
    const stabil = naechste.length === cues.length;
    cues = naechste;
    if (stabil) break;
  }

  const inhalt = new Bytepuffer(haufenBytes.groesse + cues.length + 4096);
  inhalt.feld(Uint8Array.from(knoten(INFO, info)));
  inhalt.feld(Uint8Array.from(knoten(TRACKS, knoten(TRACK_ENTRY, spur))));
  inhalt.feld(Uint8Array.from(cues));
  inhalt.feld(haufenBytes.fertig());

  const segment = inhalt.fertig();
  const datei = new Bytepuffer(segment.length + 256);
  datei.feld(Uint8Array.from(knoten(EBML, kopf)));
  datei.feld(Uint8Array.from(kennung(SEGMENT)));
  datei.feld(Uint8Array.from(vint(segment.length)));
  datei.feld(segment);
  return datei.fertig();
}

/**
 * Der Suchindex: zu jedem Haufen sein Zeitpunkt und seine Stelle in der Datei.
 *
 * `vorlauf` ist, was vor dem ersten Haufen steht – gezählt ab dem Anfang der
 * Nutzdaten des Segments, so wie Matroska es verlangt. Der Index selbst
 * gehört dazu, deshalb wird er in `webmSchreiben` mehrfach gebaut, bis seine
 * Länge stillsteht.
 */
function cuesBauen(
  marken: readonly { zeitMs: number; versatz: number }[],
  vorlauf: number,
): number[] {
  const punkte: number[] = [];
  for (const marke of marken) {
    punkte.push(
      ...knoten(CUE_POINT, [
        ...zahlKnoten(CUE_TIME, marke.zeitMs),
        ...knoten(CUE_TRACK_POSITIONS, [
          ...zahlKnoten(CUE_TRACK, 1),
          ...zahlKnoten(CUE_CLUSTER_POSITION, vorlauf + marke.versatz),
        ]),
      ]),
    );
  }
  return knoten(CUES, punkte);
}
