import type { Maskenteil } from '../bild/doc.js';
import { tippTeilRechnen } from '../bild/tippMaske.js';
import { NichtsGefunden, runEngine, type Vorrang } from '../stickers/engines/index.js';
import { kanteWeichzeichnen } from '../stickers/engines/prepare.js';
import type { GelesenesBild } from './bilderLesen.js';
import type { NeueDaten } from './bildweise.js';
import type { Punkt } from './objektFolge.js';

/**
 * EIN Maskenteil für EIN Bild rechnen – mit dem Modell, das es braucht.
 *
 * Aus `folgeTeile.ts` herausgezogen, weil es inzwischen drei Aufrufer hat:
 * den Filmbau (`folgeTeile`), die Mitnahme an ein anderes Stellbild
 * (`verlegen.ts`) und die Verfolgung im Hintergrund (`maskenVerfolgen.ts`).
 * `folgeTeile.ts` reicht es weiter, damit bestehende Importe gelten.
 *
 * # Was herauskommt – und in welcher Grösse
 *
 * `NeueDaten`, also Werte MIT ihren Massen:
 *
 * - Netz und Tipp: eine Maske in der Rechengrösse `breite × hoehe`.
 * - Tiefe: die Karte in der Grösse, die das Netz liefert (`netzGroesse`,
 *   bei 16 : 9 etwa 518 × 294) – NICHT in der Rechengrösse.
 *
 * Genau daran war die Tiefe im Film bisher wirkungslos: Hier kam nur das
 * Feld der Karte heraus, und jeder Aufrufer schrieb die Rechengrösse
 * daneben. Bei 960 × 540 fand `tiefenFeld` dann 152 292 statt 518 400
 * Werte, brach ab und lieferte überall 0 – keine Unschärfe; bei kleineren
 * Bildern las es gestreiften Unsinn. Wer die Karte über ein Bild legt,
 * rechnet sie jetzt selbst um (der Renderer tut das über die Masse der
 * `NeueDaten`, wie beim Foto).
 */

/**
 * Der Weichzeichner für die Kante einer Netzmaske.
 *
 * Dieselbe Überlegung wie in `netzMaske.ts`: Ein Netz liefert eine harte
 * Entscheidung je Bildpunkt; für eine Anpassung, die überblendet wird, ist
 * eine harte Kante das, was ein Bild künstlich aussehen lässt. Im Film fällt
 * es sogar mehr auf als im Standbild, weil die Kante dann auch noch flimmert.
 */
export const KANTE_WEICH = 1;

/** Was es für die Tiefe braucht – eine offene Sitzung aus `bild/tiefeNetz.ts`. */
export interface Tiefenrechner {
  karteFuer(
    bild: ImageData,
    optionen?: { readonly vorrang?: Vorrang; readonly abbruch?: AbortSignal },
  ): Promise<{ breite: number; hoehe: number; feld: Uint8Array }>;
}

export async function teilRechnen(
  eintrag: { readonly teil: Maskenteil },
  bild: GelesenesBild,
  breite: number,
  hoehe: number,
  tiefe: Tiefenrechner | null,
  abbruch: AbortSignal | undefined,
  /** Die angetippten Punkte an DIESEM Bild – schon mitgezogen, siehe `Spur`. */
  punkte: readonly Punkt[] | null,
  /** Wer rechnen lässt – siehe `modellReihe`. Der Filmbau wartet: `'vorn'`. */
  vorrang: Vorrang = 'vorn',
): Promise<NeueDaten> {
  const teil = eintrag.teil;

  if (teil.art === 'tiefe') {
    if (!tiefe) throw new Error('Für die Tiefe fehlt die Sitzung');
    const karte = await tiefe.karteFuer(bild.daten, { vorrang, abbruch });
    return { breite: karte.breite, hoehe: karte.hoehe, werte: karte.feld };
  }

  if (teil.art === 'netz') {
    const maske = await runEngine(teil.netz, { image: bild.daten, abbruch, vorrang });
    return { breite, hoehe, werte: kanteWeichzeichnen(maske, breite, hoehe, KANTE_WEICH) };
  }

  if (teil.art === 'tipp') {
    const leer = (): NeueDaten => ({ breite, hoehe, werte: new Uint8Array(breite * hoehe) });
    const gezogen = (punkte ?? teil.punkte).map((punkt) => ({
      x: Math.min(breite - 1, Math.max(0, Math.round(punkt.x))),
      y: Math.min(hoehe - 1, Math.max(0, Math.round(punkt.y))),
    }));
    /*
     * Keine Punkte, keine Maske. So kommt ein Tipp aus `verlegen.ts`, dessen
     * Gegenstand am neuen Stellbild schon aus dem Bild war – und
     * `tippTeilRechnen` gäbe dafür nichts zurück, was hier den ganzen
     * Filmbau abbräche.
     */
    if (gezogen.length === 0) return leer();
    try {
      const gerechnet = await tippTeilRechnen(bild.daten, gezogen, {
        modus: teil.modus,
        mitNetz: teil.mitNetz,
        toleranz: teil.toleranz,
        id: teil.id,
        vorrang,
      });
      if (!gerechnet || gerechnet.art !== 'tipp') throw new Error('Der Tipp ergab keine Maske');
      return { breite, hoehe, werte: gerechnet.alpha };
    } catch (fehler) {
      /*
       * `NichtsGefunden` heisst: An dieser Stelle ist gerade nichts – das
       * angetippte Ding kann aus dem Bild gelaufen sein. Das darf den ganzen
       * Filmbau nicht abbrechen, sonst kostete ein Objekt, das für ein paar
       * Sekunden hinter etwas verschwindet, den kompletten Export. Eine leere
       * Maske ist die ehrliche Antwort; die Spur weiss damit umzugehen.
       * Jeder andere Fehler bleibt tödlich – ein abgeschaltetes oder
       * abgestürztes Verfahren fände beim nächsten Schlüsselbild ebenso
       * wenig.
       */
      if (fehler instanceof NichtsGefunden) return leer();
      throw fehler;
    }
  }

  throw new Error(`Diese Maskenart wird je Bild nicht gerechnet: ${teil.art}`);
}
