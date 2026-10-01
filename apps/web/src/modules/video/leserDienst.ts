import { AbbruchError } from '../stickers/engines/index.js';
import { videoLeserOeffnen, type KleinWunsch, type VideoLeser } from './bilderLesen.js';
import { bildIndex, bildMitte } from './raster.js';
import { grauMass, graustufen, type Grau } from './verfolgung.js';

export type { KleinWunsch } from './bilderLesen.js';

/**
 * EIN Dekodierer für Editor, Verfolgung und Filmbau – mit Vorfahrt für den
 * Editor.
 *
 * # Warum einer
 *
 * Weil ein Telefon nur wenige Videodekodierer zugleich hat (Android über
 * MediaCodec, iOS hält jedes dekodierte Video als Speicher). Bisher öffnete
 * jeder, der Bilder brauchte, einen eigenen `VideoLeser`: der Editor für das
 * Stellbild, die Mitnahme für die Masken, der Filmbau. Mit dem sichtbaren
 * Video dazu waren es drei. Hier ist es einer, und das sichtbare Video ist
 * der zweite.
 *
 * # Die Reihenfolge
 *
 * Ein `VideoLeser` springt zu einem Zeitpunkt und wartet auf das Bild – zwei
 * Sprünge zugleich gingen durcheinander. Die Aufträge laufen deshalb einer
 * nach dem anderen, in drei Stufen:
 *
 * - `'vorn'`: der Editor, der ein Bild zeigen will (das Standbild). Kommt vor
 *   allem anderen; er wartet nur auf den Sprung, der gerade läuft.
 * - `'mitte'`: die groben Stufen des Wischspeichers (`wischspeicher.ts`).
 *   Wer den Editor aufmacht und wischt, will sofort „ungefähr richtig" –
 *   dafür reichen 75 Bilder –, und die Verfolgung dauert je nach Verfahren
 *   eine halbe Minute bis mehrere Minuten. Also vor ihr.
 * - `'hinten'`: die Verfolgung – und die feinen Stufen des Speichers,
 *   abwechselnd mit ihr: Jeder wartet auf seine eigene Lesung und reiht sich
 *   dann wieder hinten ein, die Warteschlange wechselt von selbst.
 *
 * Ein laufender Sprung wird nicht abgebrochen; er dauert 20 – 300 ms.
 *
 * Voll und grau aus EINEM Auftrag: Der zweite `bildAn` an derselben Stelle
 * springt nicht noch einmal (`bilderLesen.ts`), das kleine Bild kommt
 * verkleinert von der Grafikeinheit – gemessen 19 statt 144 ms je Bild.
 *
 * # Das kleine Bild und der Mitschnitt
 *
 * Für den Wischspeicher liefert ein Auftrag mit `klein` ein verkleinertes,
 * KODIERTES Bild (`Lesung.klein`): Die Kodierung läuft nebenher, der
 * Dekodierer ist schon frei, wenn der Auftrag erfüllt ist. Höchstens
 * `KODIERUNGEN_MAX` laufen zugleich – sonst wüchse bei einem Browser, der auf
 * dem Hauptfaden kodiert, ein Rückstau im Arbeitsspeicher, und ein Auftrag,
 * der nur ein kleines Bild will, wartet am Eingang der Schlange statt im
 * Dekodierer.
 *
 * Der Mitschnitt (`mitschnittSetzen`) macht aus jeder Lesung der Verfolgung
 * ein Bild weniger zu füllen: Steht das Video nach einem anderen Auftrag an
 * `bildMitte(k)` und fehlt dem Speicher dieses Bild, wird es aus demselben
 * Stand verkleinert (kein zweiter Sprung, 0,3 ms) und nebenher kodiert.
 *
 * # Wann er schliesst
 *
 * Nach `LEERLAUF_MS` ohne Auftrag – ein offenes Video hält dekodierte Bilder
 * im Speicher. Der nächste Auftrag öffnet ihn wieder (rund 100 ms). Und bei
 * `schliessen()`: Wartende Aufträge scheitern mit `AbbruchError`, ein
 * laufender Sprung wird abgebrochen. Auch danach öffnet ein `holen` ihn
 * wieder – der Dienst gehört der Sitzung, nicht einem einzelnen Aufrufer
 * (der Filmbau schliesst ihn vor dem Start, damit nur SEIN Dekodierer
 * läuft, und danach liest der Editor weiter).
 */

export type Prioritaet = 'vorn' | 'mitte' | 'hinten';

/** Was ein Auftrag liefert. */
export interface Lesung {
  /** Das Bild in Rechengrösse – `null`, wenn nicht verlangt. */
  readonly voll: ImageData | null;
  /** Die Graustufen in `grauMass`-Grösse – `null`, wenn nicht verlangt. */
  readonly grau: Grau | null;
  /**
   * Das kleine, kodierte Bild – nur mit `LeseOptionen.klein`. Die Kodierung
   * läuft nebenher: Der Dekodierer ist schon frei, wenn der Auftrag fertig
   * ist, und das Bild kommt erst mit diesem Versprechen. `null`, wo der
   * Browser das Format nicht kodiert.
   */
  readonly klein?: Promise<Blob | null> | null;
}

export interface LeseOptionen {
  /**
   * Das volle Bild – ohne Angabe genau dann, wenn weder Grau noch ein
   * kleines Bild verlangt ist.
   */
  readonly voll?: boolean;
  readonly grau?: boolean;
  /** Ein kleines, kodiertes Bild für den Wischspeicher. */
  readonly klein?: KleinWunsch;
  readonly abbruch?: AbortSignal;
}

/**
 * Ein Wunsch, den der Dienst NEBENHER erfüllt: Jede Lesung eines anderen
 * Auftrags an `bildMitte(k)`, bei der dem Speicher das Bild fehlt, gibt ein
 * kleines Bild ab.
 */
export interface Mitschnitt {
  readonly wunsch: KleinWunsch;
  /** Fehlt dem Speicher das Bild k? */
  braucht(k: number): boolean;
  /** Das kodierte Bild – erst, wenn die Kodierung fertig ist. */
  ablegen(k: number, blob: Blob): void;
}

export interface Leserdienst {
  holen(ms: number, prioritaet: Prioritaet, optionen?: LeseOptionen): Promise<Lesung>;
  /** Setzt den Mitschnitt – `null` nimmt ihn zurück. */
  mitschnittSetzen(mitschnitt: Mitschnitt | null): void;
  /** Die Masse des Videos – öffnet den Leser, wenn er zu ist. */
  masse(): Promise<{
    readonly breite: number;
    readonly hoehe: number;
    readonly quellBreite: number;
    readonly quellHoehe: number;
    readonly dauerMs: number;
  }>;
  /** Wartende Aufträge scheitern, der Dekodierer wird frei. */
  schliessen(): void;
  /** Ist gerade ein Dekodierer offen? */
  readonly offen: boolean;
}

/** Nach so langer Ruhe wird der Dekodierer freigegeben. */
export const LEERLAUF_MS = 30_000;
/** So viele Kodierungen kleiner Bilder laufen höchstens zugleich. */
export const KODIERUNGEN_MAX = 2;

type Oeffnen = (
  datei: Blob,
  auftrag: { readonly kante: number; readonly randMs?: number; readonly abbruch?: AbortSignal },
) => Promise<VideoLeser>;

interface Auftrag {
  readonly ms: number;
  readonly prioritaet: Prioritaet;
  readonly voll: boolean;
  readonly grau: boolean;
  readonly klein?: KleinWunsch;
  readonly abbruch?: AbortSignal;
  readonly erfuellen: (lesung: Lesung) => void;
  readonly ablehnen: (fehler: unknown) => void;
  readonly aufgeben: () => void;
}

/**
 * Ein Signal, das abbricht, sobald eines der beiden es tut – und `loesen`,
 * das die Horcher wieder abmeldet.
 *
 * # Warum abmelden
 *
 * Weil `a` das Signal der SITZUNG ist, und das lebt, solange das Blatt offen
 * ist. Die Verfolgung reicht bei jeder Lesung ihr Fenstersignal herein; ohne
 * Abmelden hing je Lesung ein Horcher mehr an der Sitzung – nach 50 000
 * Lesungen 32 MB, jede neue Anmeldung langsamer (der Browser sucht die ganze
 * Liste nach Doppelten ab), und `schliessen()` feuerte sie alle auf einmal.
 */
function verbinden(
  a: AbortSignal,
  b: AbortSignal | undefined,
): { signal: AbortSignal; loesen: () => void } {
  if (!b) return { signal: a, loesen: () => undefined };
  const steuer = new AbortController();
  const weiter = () => steuer.abort();
  if (a.aborted || b.aborted) steuer.abort();
  a.addEventListener('abort', weiter, { once: true });
  b.addEventListener('abort', weiter, { once: true });
  return {
    signal: steuer.signal,
    loesen: () => {
      a.removeEventListener('abort', weiter);
      b.removeEventListener('abort', weiter);
    },
  };
}

export function leserDienst(
  datei: Blob,
  kante: number,
  /** Die Schrittweite des Films – der Rand am Videoende ist ein halbes Bild (`bilderLesen.ts`). */
  s: number,
  optionen: { readonly oeffnen?: Oeffnen; readonly leerlaufMs?: number } = {},
): Leserdienst {
  const oeffnen: Oeffnen = optionen.oeffnen ?? videoLeserOeffnen;
  const leerlaufMs = optionen.leerlaufMs ?? LEERLAUF_MS;
  const reihe: Auftrag[] = [];
  let leser: VideoLeser | null = null;
  let oeffnend: Promise<VideoLeser> | null = null;
  let laeuft = false;
  let ruhe: ReturnType<typeof setTimeout> | null = null;
  /** Bricht ab, was läuft, wenn `schliessen` kommt – danach ein neues. */
  let sitzung = new AbortController();
  let mitschnitt: Mitschnitt | null = null;
  /** Kodierungen kleiner Bilder, die noch laufen. */
  let kodierungen = 0;

  const zu = () => {
    leser?.schliessen();
    leser = null;
    oeffnend = null;
  };

  const holenLeser = (): Promise<VideoLeser> => {
    if (leser) return Promise.resolve(leser);
    if (!oeffnend) {
      const dieSitzung = sitzung;
      const versuch: Promise<VideoLeser> = oeffnen(datei, {
        kante,
        randMs: s / 2,
        abbruch: dieSitzung.signal,
      }).then(
        (offen) => {
          if (dieSitzung.signal.aborted) {
            offen.schliessen();
            throw new AbbruchError();
          }
          leser = offen;
          return offen;
        },
        (fehler) => {
          // Ein misslungenes Öffnen darf das nächste nicht verhindern.
          if (oeffnend === versuch) oeffnend = null;
          throw fehler;
        },
      );
      oeffnend = versuch;
    }
    return oeffnend;
  };

  const ruheStellen = () => {
    if (ruhe) clearTimeout(ruhe);
    ruhe = null;
    if (laeuft || reihe.length > 0) return;
    ruhe = setTimeout(() => {
      ruhe = null;
      if (!laeuft && reihe.length === 0) zu();
    }, leerlaufMs);
  };

  /** Ein kleines Bild abgeben und mitzählen – der Dekodierer wartet nicht darauf. */
  const kodierungMerken = (kodiert: Promise<Blob | null>): Promise<Blob | null> => {
    kodierungen += 1;
    const ende = () => {
      kodierungen -= 1;
      // Ein Auftrag, der wegen voller Kodierung wartete, darf jetzt.
      pumpen();
    };
    kodiert.then(ende, ende);
    return kodiert;
  };

  /**
   * Darf dieser Auftrag jetzt anfangen? Einer, der NUR ein kleines Bild will,
   * wartet, solange zwei Kodierungen offen sind – alle anderen laufen.
   */
  const darfLaufen = (a: Auftrag) =>
    !(a.klein && !a.voll && !a.grau && kodierungen >= KODIERUNGEN_MAX);

  const naechster = (): number => {
    for (const prioritaet of ['vorn', 'mitte', 'hinten'] as const) {
      const stelle = reihe.findIndex((a) => a.prioritaet === prioritaet && darfLaufen(a));
      if (stelle >= 0) return stelle;
    }
    return -1;
  };

  const pumpen = () => {
    if (laeuft) return;
    const stelle = naechster();
    if (stelle < 0) {
      // Nichts, was jetzt laufen dürfte: entweder leer (Ruhe stellen) oder
      // nur kleine Bilder bei voller Kodierung – dann weckt deren Ende uns.
      if (reihe.length === 0) ruheStellen();
      return;
    }
    const auftrag = reihe.splice(stelle, 1)[0];
    if (ruhe) clearTimeout(ruhe);
    ruhe = null;
    laeuft = true;
    auftrag.abbruch?.removeEventListener('abort', auftrag.aufgeben);
    void (async () => {
      let loesen: () => void = () => undefined;
      try {
        if (auftrag.abbruch?.aborted) throw new AbbruchError();
        const offen = await holenLeser();
        const verbunden = verbinden(sitzung.signal, auftrag.abbruch);
        loesen = verbunden.loesen;
        const signal = verbunden.signal;
        const voll = auftrag.voll ? await offen.bildAn(auftrag.ms, signal) : null;
        let grau: Grau | null = null;
        if (auftrag.grau) {
          const klein = grauMass(offen.breite, offen.hoehe);
          grau = graustufen(await offen.bildAn(auftrag.ms, signal, klein));
        }
        let klein: Promise<Blob | null> | null = null;
        if (auftrag.klein) {
          const kleinBild = await offen.kleinAn(auftrag.ms, auftrag.klein, signal);
          klein = kodierungMerken(kleinBild.kodiert);
        } else if (mitschnitt) {
          await mitschneiden(offen, auftrag.ms, mitschnitt, signal);
        }
        auftrag.erfuellen({ voll, grau, klein });
      } catch (fehler) {
        auftrag.ablehnen(fehler);
      } finally {
        loesen();
        laeuft = false;
        pumpen();
      }
    })();
  };

  /**
   * Das Bild, das das Video gerade zeigt, als kleines Bild abgeben – wenn
   * der Speicher es braucht. Ein Fehler hier darf den Auftrag nicht
   * verderben: Der Mitschnitt ist ein Geschenk, kein Teil des Auftrags.
   */
  const mitschneiden = async (
    offen: VideoLeser,
    ms: number,
    wunsch: Mitschnitt,
    signal: AbortSignal,
  ): Promise<void> => {
    const k = bildIndex(ms, s);
    // Nur an der Mitte eines Rasterbildes: Ein Standbild an anderer Stelle
    // gehört keinem Rasterbild, und der Speicher hielte ein falsches.
    if (Math.abs(ms - bildMitte(k, s)) > 1e-3) return;
    if (kodierungen >= KODIERUNGEN_MAX || !wunsch.braucht(k)) return;
    try {
      const kleinBild = await offen.kleinAn(ms, wunsch.wunsch, signal);
      void kodierungMerken(kleinBild.kodiert).then((blob) => {
        if (blob && mitschnitt === wunsch) wunsch.ablegen(k, blob);
      });
    } catch {
      // Abgebrochen oder nicht zu zeichnen: Dann fehlt dem Speicher eben ein Bild.
    }
  };

  return {
    get offen() {
      return leser !== null;
    },
    mitschnittSetzen(neu) {
      mitschnitt = neu;
    },
    holen(ms, prioritaet, wahl = {}) {
      const grau = wahl.grau === true;
      const voll = wahl.voll ?? (!grau && !wahl.klein);
      if (wahl.abbruch?.aborted) return Promise.reject(new AbbruchError());
      return new Promise<Lesung>((erfuellen, ablehnen) => {
        const auftrag: Auftrag = {
          ms,
          prioritaet,
          voll,
          grau,
          klein: wahl.klein,
          abbruch: wahl.abbruch,
          erfuellen,
          ablehnen,
          aufgeben: () => {
            const stelle = reihe.indexOf(auftrag);
            if (stelle < 0) return;
            reihe.splice(stelle, 1);
            ablehnen(new AbbruchError());
            ruheStellen();
          },
        };
        wahl.abbruch?.addEventListener('abort', auftrag.aufgeben, { once: true });
        reihe.push(auftrag);
        pumpen();
      });
    },
    async masse() {
      const offen = await holenLeser();
      ruheStellen();
      return {
        breite: offen.breite,
        hoehe: offen.hoehe,
        quellBreite: offen.quellBreite,
        quellHoehe: offen.quellHoehe,
        dauerMs: offen.dauerMs,
      };
    },
    schliessen() {
      for (const auftrag of reihe.splice(0)) {
        auftrag.abbruch?.removeEventListener('abort', auftrag.aufgeben);
        auftrag.ablehnen(new AbbruchError());
      }
      sitzung.abort();
      sitzung = new AbortController();
      if (ruhe) clearTimeout(ruhe);
      ruhe = null;
      zu();
    },
  };
}
