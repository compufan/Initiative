import { AbbruchError } from '../stickers/engines/index.js';

/**
 * Bilder aus einem Video holen.
 *
 * # Warum `currentTime` und `seeked` und nicht `requestVideoFrameCallback`
 *
 * Weil `requestVideoFrameCallback` an der ECHTZEIT hängt: Es meldet sich, wenn
 * ein Bild zur Anzeige kommt, also frühestens nach der Spieldauer. Gemessen an
 * einem Video von 5,31 s: 5325 ms bis zum letzten Bild, die ersten 0,309 s
 * fehlten, und aus 143 Rückrufen kamen nur 126 verschiedene Bilder – derselbe
 * Zeitstempel mehrfach. Für ein GIF aus einer halben Minute Film wäre das eine
 * halbe Minute Warten für ein löchriges Ergebnis.
 *
 * Springen dagegen geht so schnell, wie der Rechner mag. Gemessen in Chromium
 * an 1280 × 720: 50 Bilder in 3,76 s, also rund 75 ms je Bild, und jedes traf
 * auf ein Bild genau.
 *
 * # Warum eine eigene Leinwand und kein `VideoFrame`
 *
 * `WebCodecs` wäre schneller und ist es nicht überall: Safari kennt
 * `VideoDecoder` erst ab 16.4, und in der Chromium-Fassung, mit der die
 * Prüfungen laufen, gibt es sie gar nicht. Ein `<video>` mit `drawImage` gibt
 * es seit fünfzehn Jahren überall.
 */

export type Fortschritt = (anteil: number, text: string) => void;

export interface LeseAuftrag {
  /** Die Zeitpunkte in Millisekunden – aus `zeitpunkte()`. */
  readonly zeitpunkte: readonly number[];
  /** Die längere Kante des Ergebnisses. Das Seitenverhältnis bleibt. */
  readonly kante: number;
  readonly fortschritt?: Fortschritt;
  readonly abbruch?: AbortSignal;
}

export interface GelesenesBild {
  readonly zeitMs: number;
  readonly daten: ImageData;
}

/** Was beim Lesen schiefgehen kann – mit einem Satz, den man zeigen kann. */
export class VideoLeseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VideoLeseError';
  }
}

/* ---------- Das Rechenbare ---------- */

/**
 * Die Zielgrösse: längere Kante auf `kante`, Seitenverhältnis bleibt.
 *
 * Gerade Zahlen, weil die Bewegungsschätzung in `verfolgung.ts` in Blöcken von
 * 16 arbeitet und eine ungerade Kante dort einen halben Block übrig lässt.
 * Und nie grösser als das Original: Ein hochgerechnetes Video sieht nicht
 * besser aus, kostet aber im GIF das Vierfache.
 */
export function masse(breite: number, hoehe: number, kante: number): { b: number; h: number } {
  if (breite <= 0 || hoehe <= 0) throw new VideoLeseError('Dieses Video hat keine Bildgrösse');
  const faktor = Math.min(1, kante / Math.max(breite, hoehe));
  const gerade = (wert: number) => Math.max(2, Math.round((wert * faktor) / 2) * 2);
  return { b: gerade(breite), h: gerade(hoehe) };
}

/**
 * Muss die Länge erst gesucht werden?
 *
 * Bei einer Datei aus `MediaRecorder` – also bei jedem Video, das in dieser
 * App selbst aufgenommen wurde – steht im WebM-Kopf keine Länge, weil beim
 * Schreiben noch keine bekannt war. `duration` ist dann `Infinity`, jeder
 * Sprung landet am Anfang, und man bekäme fünfzig Mal dasselbe Bild.
 */
export function brauchtDauerSuche(dauer: number): boolean {
  return !Number.isFinite(dauer) || dauer <= 0;
}

/* ---------- Der Teil mit dem Browser ---------- */

/**
 * Auf EINES von mehreren Ereignissen warten – oder auf `error`, oder auf den
 * Abbruch.
 *
 * Mehrere Namen und kein `Promise.race` über einzelne Warter: Beim Rennen
 * bliebe der Verlierer hängen, samt seinem Horcher auf `abort`. Bräche danach
 * jemand ab, würde ein Versprechen abgelehnt, auf das niemand mehr wartet –
 * und das meldet der Browser als unbehandelte Ablehnung in der Konsole.
 */
function warten(
  video: HTMLVideoElement,
  ereignisse: readonly string[],
  abbruch?: AbortSignal,
): Promise<string> {
  return new Promise((fertig, scheitern) => {
    const horcher: [string, () => void][] = [];
    const aufraeumen = () => {
      for (const [name, ruf] of horcher) video.removeEventListener(name, ruf);
      video.removeEventListener('error', aufSchlecht);
      abbruch?.removeEventListener('abort', aufAbbruch);
    };
    const aufSchlecht = () => {
      aufraeumen();
      scheitern(new VideoLeseError('Dieses Video lässt sich nicht lesen'));
    };
    const aufAbbruch = () => {
      aufraeumen();
      scheitern(new AbbruchError());
    };
    for (const name of ereignisse) {
      const ruf = () => {
        aufraeumen();
        fertig(name);
      };
      horcher.push([name, ruf]);
      video.addEventListener(name, ruf);
    }
    video.addEventListener('error', aufSchlecht, { once: true });
    abbruch?.addEventListener('abort', aufAbbruch, { once: true });
  });
}

/**
 * Die Länge herausfinden, wenn sie nicht im Kopf steht.
 *
 * Der Trick ist alt und hässlich und funktioniert überall: ganz weit nach
 * hinten springen. Der Browser landet am tatsächlichen Ende, schreibt die
 * gefundene Länge nach `duration` und meldet `durationchange`. Danach geht es
 * an den Anfang zurück.
 */
async function dauerSuchen(video: HTMLVideoElement, abbruch?: AbortSignal): Promise<number> {
  const gewartet = warten(video, ['durationchange', 'seeked'], abbruch);
  video.currentTime = 1e9;
  await gewartet;
  if (brauchtDauerSuche(video.duration)) {
    /*
     * Manche Fassungen schreiben `duration` nicht, setzen aber `currentTime`
     * auf das echte Ende. Das ist dann die Länge.
     */
    if (video.currentTime > 0 && video.currentTime < 1e9) return video.currentTime;
    throw new VideoLeseError('Die Länge dieses Videos lässt sich nicht ermitteln');
  }
  return video.duration;
}

/** Springen und warten – aber nicht ewig. */
async function springen(video: HTMLVideoElement, sekunden: number, abbruch?: AbortSignal) {
  if (Math.abs(video.currentTime - sekunden) < 1e-4 && video.readyState >= 2) return;
  const gewartet = warten(video, ['seeked'], abbruch);
  video.currentTime = sekunden;
  await gewartet;
}

export interface VideoBilder {
  readonly bilder: readonly GelesenesBild[];
  readonly breite: number;
  readonly hoehe: number;
  /** Die tatsächliche Länge des Videos in Millisekunden. */
  readonly dauerMs: number;
}

export async function videoBilderLesen(datei: Blob, auftrag: LeseAuftrag): Promise<VideoBilder> {
  if (auftrag.abbruch?.aborted) throw new AbbruchError();
  const adresse = URL.createObjectURL(datei);
  const video = document.createElement('video');
  /*
   * `muted` und `playsInline` stehen hier, obwohl nie abgespielt wird.
   * iOS entscheidet beim Laden, ob ein Video überhaupt im Hintergrund
   * dekodiert werden darf, und ein nicht stummes Video ohne Geste darf es
   * nicht – dann bleibt `readyState` bei 0 und jeder Sprung hängt.
   */
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  video.src = adresse;

  try {
    await warten(video, ['loadedmetadata'], auftrag.abbruch);
    const dauerS = brauchtDauerSuche(video.duration)
      ? await dauerSuchen(video, auftrag.abbruch)
      : video.duration;

    const { b, h } = masse(video.videoWidth, video.videoHeight, auftrag.kante);
    const flaeche = document.createElement('canvas');
    flaeche.width = b;
    flaeche.height = h;
    const stift = flaeche.getContext('2d', { willReadFrequently: true });
    if (!stift) throw new VideoLeseError('Diese Ansicht kann keine Bilder zeichnen');

    const bilder: GelesenesBild[] = [];
    const gesamt = auftrag.zeitpunkte.length;
    for (let i = 0; i < gesamt; i += 1) {
      if (auftrag.abbruch?.aborted) throw new AbbruchError();
      /*
       * Das letzte Bild eines Videos ist NICHT bei `duration`.
       *
       * Dorthin zu springen heisst „hinter das letzte Bild", und je nach
       * Browser kommt dann das letzte Bild, ein schwarzes, oder `seeked`
       * bleibt aus. Ein Zehntel Abstand ist mehr als jedes Einzelbild lang.
       */
      const ziel = Math.min(auftrag.zeitpunkte[i] / 1000, Math.max(0, dauerS - 0.1));
      await springen(video, ziel, auftrag.abbruch);
      stift.clearRect(0, 0, b, h);
      stift.drawImage(video, 0, 0, b, h);
      bilder.push({ zeitMs: auftrag.zeitpunkte[i], daten: stift.getImageData(0, 0, b, h) });
      auftrag.fortschritt?.((i + 1) / gesamt, `Bild ${i + 1} von ${gesamt}`);
    }

    return { bilder, breite: b, hoehe: h, dauerMs: Math.round(dauerS * 1000) };
  } finally {
    /*
     * Erst die Quelle leeren, dann die Adresse freigeben. Andersherum lädt
     * das Element noch an einer Adresse, die es nicht mehr gibt, und
     * hinterlässt in Firefox einen Fehler in der Konsole.
     */
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(adresse);
  }
}
