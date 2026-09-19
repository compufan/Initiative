import { AbbruchError } from '../stickers/engines/index.js';
import { webmSchreiben, type WebmBild, type WebmCodec } from './webm.js';

/**
 * Aus Leinwänden wieder ein Video.
 *
 * `VideoEncoder` macht aus jedem Bild ein Päckchen, `webm.ts` legt sie in
 * einen Behälter. Der Weg über `MediaRecorder` wäre kürzer und falsch – die
 * Begründung steht im Kopf von `webm.ts`: Dort kommt die Zeit von der
 * Wanduhr, und ein Video, dessen Bilder je eine Sekunde Rechnung brauchen,
 * liefe in Zeitlupe.
 *
 * # Warum VP9 und nicht H.264
 *
 * Weil H.264 lizenzpflichtig ist und Chromium es deshalb nicht kodiert –
 * nachgemessen: `VideoEncoder.isConfigSupported` nimmt `vp09`, `vp8` und
 * `av01`, aber kein `avc1`. Das ist kein Mangel dieser App, sondern die
 * Lage. VP9 spielt jeder Browser ab, der diese App überhaupt lädt.
 *
 * AV1 wäre kleiner und bleibt trotzdem aussen vor: Es verlangt im Behälter
 * eine `CodecPrivate` mit einem eigenen Kopfsatz, den `VideoEncoder` nicht
 * herausgibt. VP8 und VP9 brauchen keine.
 */

/* ---------- Was der Browser mitbringt ---------- */

/**
 * Die Typen von WebCodecs stehen nicht in jeder TypeScript-Fassung.
 *
 * Hier nur das, was wirklich benutzt wird – lieber fünf Zeilen eigene Typen
 * als ein `any`, das jeden Tippfehler durchlässt.
 */
interface KodiertesBild {
  readonly type: 'key' | 'delta';
  readonly timestamp: number;
  readonly byteLength: number;
  copyTo(ziel: Uint8Array): void;
}

interface Kodierer {
  configure(einstellung: Record<string, unknown>): void;
  encode(bild: unknown, optionen?: { keyFrame?: boolean }): void;
  flush(): Promise<void>;
  close(): void;
  readonly encodeQueueSize: number;
}

interface KodiererBau {
  new (rueckrufe: {
    output: (bild: KodiertesBild) => void;
    error: (fehler: Error) => void;
  }): Kodierer;
  isConfigSupported(einstellung: Record<string, unknown>): Promise<{ supported?: boolean }>;
}

interface BildBau {
  new (
    quelle: CanvasImageSource,
    einstellung: { timestamp: number; duration?: number },
  ): {
    close(): void;
  };
}

function kodiererKlasse(): KodiererBau | null {
  return (globalThis as unknown as { VideoEncoder?: KodiererBau }).VideoEncoder ?? null;
}

function bildKlasse(): BildBau | null {
  return (globalThis as unknown as { VideoFrame?: BildBau }).VideoFrame ?? null;
}

/** Die Kennung, unter der der Browser den Codec kennt. */
const KODEK_NAME: Record<WebmCodec, string> = {
  vp9: 'vp09.00.10.08',
  vp8: 'vp8',
};

export interface Tauglichkeit {
  readonly moeglich: boolean;
  readonly codec?: WebmCodec;
  /** Warum nicht – ein ganzer Satz, den man anzeigen kann. */
  readonly grund?: string;
}

/**
 * Kann dieses Gerät ein Video schreiben?
 *
 * Gefragt wird VOR dem Rechnen, nicht danach. Eine halbe Minute zu warten und
 * dann zu erfahren, dass nichts herauskommt, ist die ärgerlichste Art, eine
 * fehlende Fähigkeit mitzuteilen.
 */
export async function videoTauglich(breite = 640, hoehe = 480): Promise<Tauglichkeit> {
  const klasse = kodiererKlasse();
  if (!klasse || !bildKlasse()) {
    return {
      moeglich: false,
      grund:
        'Dieser Browser kann keine Videos schreiben. Das geht in Chrome und Edge ab Version 94, in Safari ab 16.4 und in Firefox ab 130. Ein GIF lässt sich aus dem Video trotzdem machen.',
    };
  }
  for (const codec of ['vp9', 'vp8'] as const) {
    try {
      const befund = await klasse.isConfigSupported({
        codec: KODEK_NAME[codec],
        width: gerade(breite),
        height: gerade(hoehe),
        bitrate: 2_000_000,
      });
      if (befund.supported) return { moeglich: true, codec };
    } catch {
      // Ein Codec, nach dem zu fragen schon scheitert, ist keiner.
    }
  }
  return {
    moeglich: false,
    grund:
      'Dieser Browser bringt keinen Videokodierer mit, den wir benutzen dürfen. Ein GIF geht trotzdem.',
  };
}

/**
 * Gerade Kantenlängen.
 *
 * VP8 und VP9 rechnen die Farbe in halber Auflösung (4:2:0). Eine ungerade
 * Kante hat dort einen halben Bildpunkt, und der Kodierer lehnt sie ab – in
 * manchen Fassungen mit einer Fehlermeldung, in anderen mit einem grünen
 * Streifen am Rand.
 */
function gerade(wert: number): number {
  return Math.max(2, Math.round(wert / 2) * 2);
}

/* ---------- Schreiben ---------- */

export interface SchreibAuftrag {
  readonly breite: number;
  readonly hoehe: number;
  readonly bildrate: number;
  /**
   * Wie viele Bits je Sekunde.
   *
   * Ohne Angabe wird aus der Fläche gerechnet: rund 0,1 Bit je Bildpunkt und
   * Sekunde. Das ist die übliche Hausnummer für bewegte Bilder aus der Hand
   * und liegt bei 720p bei etwa 2,7 Mbit/s.
   */
  readonly bitrate?: number;
  /**
   * Nach wie vielen Bildern wieder eines für sich allein steht.
   *
   * Schlüsselbilder kosten Platz und ermöglichen das Springen. Alle zwei
   * Sekunden ist der übliche Kompromiss.
   */
  readonly schluesselAbstand?: number;
  readonly fortschritt?: (anteil: number, text: string) => void;
  readonly abbruch?: AbortSignal;
}

/** Woher die Bilder kommen: eine Funktion, die das n-te malt. */
export type Bildquelle = (nummer: number) => Promise<CanvasImageSource> | CanvasImageSource;

export async function videoSchreiben(
  anzahl: number,
  quelle: Bildquelle,
  auftrag: SchreibAuftrag,
): Promise<Blob> {
  if (anzahl <= 0) throw new Error('Ein Video ohne Bilder gibt es nicht');
  if (auftrag.abbruch?.aborted) throw new AbbruchError();

  const tauglich = await videoTauglich(auftrag.breite, auftrag.hoehe);
  if (!tauglich.moeglich || !tauglich.codec) {
    throw new Error(tauglich.grund ?? 'Dieser Browser kann keine Videos schreiben');
  }
  const Kodierer = kodiererKlasse();
  const Bild = bildKlasse();
  if (!Kodierer || !Bild) throw new Error('Dieser Browser kann keine Videos schreiben');

  const breite = gerade(auftrag.breite);
  const hoehe = gerade(auftrag.hoehe);
  const abstandMs = 1000 / auftrag.bildrate;
  const schluesselAbstand =
    auftrag.schluesselAbstand ?? Math.max(1, Math.round(auftrag.bildrate * 2));

  const gesammelt: WebmBild[] = [];
  let gescheitert: Error | null = null;
  const kodierer = new Kodierer({
    output: (kodiert) => {
      const daten = new Uint8Array(kodiert.byteLength);
      kodiert.copyTo(daten);
      gesammelt.push({
        daten,
        // `VideoEncoder` zählt in Mikrosekunden, Matroska in Millisekunden.
        zeitMs: Math.round(kodiert.timestamp / 1000),
        schluessel: kodiert.type === 'key',
      });
    },
    error: (fehler) => {
      gescheitert = fehler;
    },
  });

  kodierer.configure({
    codec: KODEK_NAME[tauglich.codec],
    width: breite,
    height: hoehe,
    bitrate: auftrag.bitrate ?? Math.round(breite * hoehe * auftrag.bildrate * 0.1),
    framerate: auftrag.bildrate,
    // „realtime" heisst: nicht auf spätere Bilder warten. Genau das wollen wir
    // hier nicht – wir haben alle Bilder, und „quality" packt besser.
    latencyMode: 'quality',
  });

  try {
    for (let i = 0; i < anzahl; i += 1) {
      if (auftrag.abbruch?.aborted) throw new AbbruchError();
      if (gescheitert) throw gescheitert;

      const gemalt = await quelle(i);
      const bild = new Bild(gemalt, {
        timestamp: Math.round(i * abstandMs * 1000),
        duration: Math.round(abstandMs * 1000),
      });
      try {
        kodierer.encode(bild, { keyFrame: i % schluesselAbstand === 0 });
      } finally {
        /*
         * `close()` ist Pflicht und kein Aufräumen aus Ordnungsliebe: Ein
         * `VideoFrame` hält Speicher ausserhalb der üblichen Verwaltung, und
         * der Einsammler kommt dort nicht hin. Ohne dieses `close` bricht
         * Chromium nach ein paar Dutzend Bildern mit einer Meldung über zu
         * viele offene Bilder ab.
         */
        bild.close();
      }

      /*
       * Warten, wenn sich die Schlange füllt.
       *
       * Der Kodierer arbeitet nebenher. Wer ihm schneller Bilder gibt, als er
       * sie wegrechnet, hält am Ende zwanzig unkodierte Vollbilder im
       * Speicher – bei 1080p sind das 120 MB.
       */
      while (kodierer.encodeQueueSize > 8) {
        await new Promise((weiter) => setTimeout(weiter, 4));
        if (auftrag.abbruch?.aborted) throw new AbbruchError();
      }
      auftrag.fortschritt?.((i + 1) / anzahl, `Bild ${i + 1} von ${anzahl}`);
    }

    await kodierer.flush();
    if (gescheitert) throw gescheitert;
  } finally {
    try {
      kodierer.close();
    } catch {
      // Schon geschlossen, weil etwas schiefging – dann ist ja gut.
    }
  }

  /*
   * Nach der Zeit sortieren, bevor gepackt wird.
   *
   * Ein Kodierer darf Päckchen in einer anderen Reihenfolge herausgeben, als
   * er Bilder bekommen hat. VP9 tut das in dieser Einstellung nicht, aber
   * darauf zu bauen hiesse, eine Zusicherung anzunehmen, die niemand gegeben
   * hat – und ein Behälter mit rückwärts laufender Zeit ist unlesbar.
   */
  gesammelt.sort((a, b) => a.zeitMs - b.zeitMs);
  const roh = webmSchreiben(gesammelt, {
    codec: tauglich.codec,
    breite,
    hoehe,
    dauerMs: Math.round(anzahl * abstandMs),
  });
  return new Blob([roh.slice().buffer], { type: 'video/webm' });
}
