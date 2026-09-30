import { AbbruchError } from '../stickers/engines/index.js';
import { videoLeserOeffnen, type VideoLeser } from './bilderLesen.js';
import { grauMass, graustufen, type Grau } from './verfolgung.js';

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
 * nach dem anderen, und `'vorn'` (der Editor, der ein Bild zeigen will)
 * kommt vor jedem wartenden `'hinten'` (die Verfolgung). Ein laufender
 * Sprung der Verfolgung wird nicht abgebrochen; er dauert 20 – 300 ms.
 *
 * Voll und grau aus EINEM Auftrag: Der zweite `bildAn` an derselben Stelle
 * springt nicht noch einmal (`bilderLesen.ts`), das kleine Bild kommt
 * verkleinert von der Grafikeinheit – gemessen 19 statt 144 ms je Bild.
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

export type Prioritaet = 'vorn' | 'hinten';

/** Was ein Auftrag liefert. */
export interface Lesung {
  /** Das Bild in Rechengrösse – `null`, wenn nicht verlangt. */
  readonly voll: ImageData | null;
  /** Die Graustufen in `grauMass`-Grösse – `null`, wenn nicht verlangt. */
  readonly grau: Grau | null;
}

export interface LeseOptionen {
  /** Das volle Bild – ohne Angabe genau dann, wenn kein Grau verlangt ist. */
  readonly voll?: boolean;
  readonly grau?: boolean;
  readonly abbruch?: AbortSignal;
}

export interface Leserdienst {
  holen(ms: number, prioritaet: Prioritaet, optionen?: LeseOptionen): Promise<Lesung>;
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

type Oeffnen = (
  datei: Blob,
  auftrag: { readonly kante: number; readonly randMs?: number; readonly abbruch?: AbortSignal },
) => Promise<VideoLeser>;

interface Auftrag {
  readonly ms: number;
  readonly prioritaet: Prioritaet;
  readonly voll: boolean;
  readonly grau: boolean;
  readonly abbruch?: AbortSignal;
  readonly erfuellen: (lesung: Lesung) => void;
  readonly ablehnen: (fehler: unknown) => void;
  readonly aufgeben: () => void;
}

/** Ein Signal, das abbricht, sobald eines der beiden es tut. */
function verbinden(a: AbortSignal, b: AbortSignal | undefined): AbortSignal {
  if (!b) return a;
  const steuer = new AbortController();
  const weiter = () => steuer.abort();
  if (a.aborted || b.aborted) steuer.abort();
  a.addEventListener('abort', weiter, { once: true });
  b.addEventListener('abort', weiter, { once: true });
  return steuer.signal;
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

  const pumpen = () => {
    if (laeuft) return;
    const stelle = reihe.findIndex((a) => a.prioritaet === 'vorn');
    const auftrag = reihe.splice(stelle >= 0 ? stelle : 0, 1)[0];
    if (!auftrag) {
      ruheStellen();
      return;
    }
    if (ruhe) clearTimeout(ruhe);
    ruhe = null;
    laeuft = true;
    auftrag.abbruch?.removeEventListener('abort', auftrag.aufgeben);
    void (async () => {
      try {
        if (auftrag.abbruch?.aborted) throw new AbbruchError();
        const offen = await holenLeser();
        const signal = verbinden(sitzung.signal, auftrag.abbruch);
        const voll = auftrag.voll ? await offen.bildAn(auftrag.ms, signal) : null;
        let grau: Grau | null = null;
        if (auftrag.grau) {
          const klein = grauMass(offen.breite, offen.hoehe);
          grau = graustufen(await offen.bildAn(auftrag.ms, signal, klein));
        }
        auftrag.erfuellen({ voll, grau });
      } catch (fehler) {
        auftrag.ablehnen(fehler);
      } finally {
        laeuft = false;
        pumpen();
      }
    })();
  };

  return {
    get offen() {
      return leser !== null;
    },
    holen(ms, prioritaet, wahl = {}) {
      const grau = wahl.grau === true;
      const voll = wahl.voll ?? !grau;
      if (wahl.abbruch?.aborted) return Promise.reject(new AbbruchError());
      return new Promise<Lesung>((erfuellen, ablehnen) => {
        const auftrag: Auftrag = {
          ms,
          prioritaet,
          voll,
          grau,
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
