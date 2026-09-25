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
  /**
   * Wie weit vor dem Ende des Videos spätestens gesprungen wird.
   *
   * Siehe `videoLeserOeffnen`. Ohne Angabe eine Zehntelsekunde – das ist
   * richtig für eine Handvoll Standbilder und falsch für einen Film: Bei 60
   * Bildern je Sekunde liegen darin sechs Bilder, und alle sechs lieferten
   * dasselbe Standbild.
   */
  readonly randMs?: number;
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

/**
 * Ein Abbruch, der die schon gelesenen Bilder mitbringt.
 *
 * Bei fünfzig Bildern à 75 ms sind das knapp vier Sekunden Arbeit. Wer
 * mittendrin abbricht, will meistens „dann eben kürzer" und nicht „von
 * vorn" – mit den Bildern in der Hand lässt sich das anbieten.
 */
export class LeseAbbruch extends AbbruchError {
  constructor(readonly fertig: readonly GelesenesBild[]) {
    super();
    this.name = 'LeseAbbruch';
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
    /*
     * Ein Signal, das SCHON abgebrochen ist, feuert kein `abort` mehr.
     *
     * Ohne diese Zeile wartete der Leser danach noch auf `seeked` und las
     * den ganzen Rest zu Ende – der Abbruch ging schlicht verloren. Er kam
     * erst beim nächsten Abschnitt an, und die Oberfläche bot „aus n
     * Bildern" für eine Arbeit an, die längst fertig war.
     */
    if (abbruch?.aborted) {
      scheitern(new AbbruchError());
      return;
    }
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
  /**
   * Die Masse des Videos selbst – nicht die der gelieferten Bilder.
   *
   * Gebraucht von jedem, der die gelieferte Grösse nicht übernimmt: Die
   * Oberfläche holt sich den Filmstreifen in 96 Punkten, rechnet das GIF aber
   * in 384. Ohne diese Zahlen müsste sie aus einem Vorschaubild auf das
   * Original zurückschliessen – und läge um den Faktor vier daneben.
   */
  readonly quellBreite: number;
  readonly quellHoehe: number;
  /** Die tatsächliche Länge des Videos in Millisekunden. */
  readonly dauerMs: number;
}

/**
 * Ein offener Leser: einmal aufmachen, beliebig oft springen, wieder zumachen.
 *
 * # Warum es das neben `videoBilderLesen` gibt
 *
 * Weil `videoBilderLesen` ALLE Bilder sammelt und unkomprimiert herausgibt.
 * Für ein GIF ist das richtig – die Masken brauchen die Bilder ohnehin alle
 * gleichzeitig. Für einen Film, an dem nichts vom Bildinhalt abhängt, ist es
 * der Grund, warum bei 60 Bildern je Sekunde nach zweieinhalb Sekunden
 * Schluss ist: Hundertfünfzig Bilder in 960 × 540 sind 311 MB, und mehr
 * verträgt ein Telefon nicht.
 *
 * Mit einem offenen Leser liegt genau EIN Bild im Speicher, und die Grenze
 * ist nur noch die Wartezeit – eine Grenze, die man dem Anwender wenigstens
 * ehrlich hinschreiben kann.
 *
 * # Warum das Schliessen dem Aufrufer gehört
 *
 * Weil niemand sonst weiss, wann er fertig ist. Ein vergessenes `schliessen`
 * hält ein dekodiertes Video am Leben – auf einem Telefon der teuerste
 * denkbare Fehler. Deshalb steht bei jedem Aufrufer ein `finally`.
 */
export interface VideoLeser {
  readonly breite: number;
  readonly hoehe: number;
  readonly quellBreite: number;
  readonly quellHoehe: number;
  readonly dauerMs: number;
  /**
   * Das Bild an dieser Stelle.
   *
   * Gibt eine eigene Kopie heraus (`getImageData`), keine Sicht auf die
   * Leseleinwand: Der nächste Sprung überschreibt sie.
   *
   * Mit `groesse` kommt es gleich verkleinert heraus – verkleinert von der
   * Grafikeinheit beim Zeichnen. Wer nur ein kleines Bild braucht (die
   * Graustufen der Verfolgung), spart so das volle Auslesen: gemessen 19
   * statt 144 ms je Bild bei 1280 × 720 und gedrosselter Rechenleistung.
   * Ein zweiter Aufruf an derselben Stelle springt nicht noch einmal.
   */
  bildAn(
    zeitMs: number,
    abbruch?: AbortSignal,
    groesse?: { readonly b: number; readonly h: number },
  ): Promise<ImageData>;
  schliessen(): void;
}

/**
 * Wie weit vor dem Ende gesprungen wird, wenn niemand etwas anderes sagt.
 *
 * Eine Zehntelsekunde. Das stammt aus der Zeit, als aus einem Video acht
 * Standbilder für den Filmstreifen geholt wurden; für die ist es richtig.
 */
const RAND_MS = 100;

export async function videoLeserOeffnen(
  datei: Blob,
  auftrag: {
    readonly kante: number;
    /**
     * Wie weit vor `dauerMs` spätestens gesprungen wird.
     *
     * Hinter das letzte Bild zu springen heisst je nach Browser: das letzte
     * Bild, ein schwarzes, oder `seeked` bleibt ganz aus. Ein Abstand muss
     * also sein – aber er muss KLEINER sein als ein Einzelbild, sonst fallen
     * mehrere Zeitpunkte auf denselben Sprung zusammen. Bei 60 Bildern je
     * Sekunde und der alten festen Zehntelsekunde waren das sechs Bilder,
     * die alle dasselbe Standbild lieferten: Das Filmende fror ein.
     *
     * Der Aufrufer gibt deshalb die halbe Schrittweite mit.
     */
    readonly randMs?: number;
    readonly abbruch?: AbortSignal;
  },
): Promise<VideoLeser> {
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

  const schliessen = () => {
    /*
     * Erst die Quelle leeren, dann die Adresse freigeben. Andersherum lädt
     * das Element noch an einer Adresse, die es nicht mehr gibt, und
     * hinterlässt in Firefox einen Fehler in der Konsole.
     */
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(adresse);
  };

  try {
    await warten(video, ['loadedmetadata'], auftrag.abbruch);
    const dauerS = brauchtDauerSuche(video.duration)
      ? await dauerSuchen(video, auftrag.abbruch)
      : video.duration;

    const { b, h } = masse(video.videoWidth, video.videoHeight, auftrag.kante);
    // Mindestens eine Millisekunde – null hiesse „genau auf `duration`", und
    // genau das ist der Sprung, der nichts liefert.
    const rand = Math.max(0.001, (auftrag.randMs ?? RAND_MS) / 1000);
    const flaeche = document.createElement('canvas');
    flaeche.width = b;
    flaeche.height = h;
    const stift = flaeche.getContext('2d', { willReadFrequently: true });
    if (!stift) throw new VideoLeseError('Diese Ansicht kann keine Bilder zeichnen');
    /** Die Leinwand für verkleinerte Bilder – erst angelegt, wenn eines verlangt wird. */
    let klein: CanvasRenderingContext2D | null = null;

    return {
      breite: b,
      hoehe: h,
      quellBreite: video.videoWidth,
      quellHoehe: video.videoHeight,
      dauerMs: Math.round(dauerS * 1000),
      async bildAn(zeitMs, abbruch, groesse) {
        // Das letzte Bild eines Videos ist NICHT bei `duration` – siehe
        // `randMs` oben.
        const ziel = Math.min(zeitMs / 1000, Math.max(0, dauerS - rand));
        await springen(video, ziel, abbruch);
        if (groesse && (groesse.b !== b || groesse.h !== h)) {
          if (!klein) {
            klein = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
            if (!klein) throw new VideoLeseError('Diese Ansicht kann keine Bilder zeichnen');
          }
          const leinwand = klein.canvas;
          if (leinwand.width !== groesse.b) leinwand.width = groesse.b;
          if (leinwand.height !== groesse.h) leinwand.height = groesse.h;
          // „high": Bei einem Drittel oder Viertel der Grösse flimmert die
          // einfache Verkleinerung, und die Verfolgung sucht dann Muster im
          // Rauschen.
          klein.imageSmoothingQuality = 'high';
          klein.clearRect(0, 0, groesse.b, groesse.h);
          klein.drawImage(video, 0, 0, groesse.b, groesse.h);
          return klein.getImageData(0, 0, groesse.b, groesse.h);
        }
        stift.clearRect(0, 0, b, h);
        stift.drawImage(video, 0, 0, b, h);
        return stift.getImageData(0, 0, b, h);
      },
      schliessen,
    };
  } catch (ausfall) {
    schliessen();
    throw ausfall;
  }
}

export async function videoBilderLesen(datei: Blob, auftrag: LeseAuftrag): Promise<VideoBilder> {
  const leser = await videoLeserOeffnen(datei, {
    kante: auftrag.kante,
    randMs: auftrag.randMs,
    abbruch: auftrag.abbruch,
  });
  try {
    const bilder: GelesenesBild[] = [];
    const gesamt = auftrag.zeitpunkte.length;
    for (let i = 0; i < gesamt; i += 1) {
      // Der Abbruch kann auch ZWISCHEN zwei Bildern kommen – der
      // Fortschrittsruf unten ist der häufigste Anlass, weil die Oberfläche
      // daran hängt. Dort wartet niemand, also fängt ihn erst diese Prüfung.
      if (auftrag.abbruch?.aborted) throw new LeseAbbruch(bilder);
      const zeitMs = auftrag.zeitpunkte[i];
      try {
        bilder.push({ zeitMs, daten: await leser.bildAn(zeitMs, auftrag.abbruch) });
      } catch (ausfall) {
        /*
         * Der Abbruch nimmt mit, was bis hierher gelesen ist.
         *
         * Er kommt aus `warten` als blanker `AbbruchError` – und genau
         * deshalb muss er HIER eingefangen werden. Eine Prüfung am
         * Schleifenanfang liefe nie an: Zwischen dem Ende von `bildAn` und
         * dem nächsten Schleifenkopf liegt kein Makrotask, ein Tipp auf
         * „Abbrechen" landet also immer mitten im Sprung. Ohne dieses
         * `catch` bekäme der Anwender nach einem Abbruch kein Angebot,
         * aus den schon gelesenen Bildern etwas zu machen.
         */
        if (ausfall instanceof AbbruchError) throw new LeseAbbruch(bilder);
        throw ausfall;
      }
      auftrag.fortschritt?.((i + 1) / gesamt, `Bild ${i + 1} von ${gesamt}`);
    }

    return {
      bilder,
      breite: leser.breite,
      hoehe: leser.hoehe,
      quellBreite: leser.quellBreite,
      quellHoehe: leser.quellHoehe,
      dauerMs: leser.dauerMs,
    };
  } finally {
    leser.schliessen();
  }
}
