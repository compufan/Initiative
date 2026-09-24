/**
 * Angetippte Stellen zu einem Maskenteil – mit Netz und ohne.
 *
 * Das Gegenstück zu `netzMaske.ts`: Dort zeigt ein Modell von sich aus auf
 * ein Motiv, hier zeigt ein Mensch auf eine Stelle. Beide enden in derselben
 * Form – ein Byte je Bildpunkt in der Grösse der Vorlage.
 *
 * # Die zwei Wege und warum es beide gibt
 *
 * **Mit Netz** läuft MobileSAM (`engines/tippen.ts`). Es findet den
 * GEGENSTAND unter dem Finger, mit seiner ganzen Kante, auch wenn er
 * mehrfarbig ist. Dafür muss es geladen werden, es braucht eine Laufzeit, und
 * auf manchen Geräten ist es abgeschaltet.
 *
 * **Ohne Netz** flutet die Farbe (`engines/flutung.ts`). Das trifft gröber –
 * ein rotes Trikot vor einer roten Wand fliesst über –, aber es rechnet auf
 * jedem Gerät, sofort, ohne einen einzigen Byte aus dem Netz. Für „der Himmel
 * dunkler“ oder „die Wand wärmer“ ist es sogar der bessere Weg: Eine Wand ist
 * für kein Modell ein Gegenstand.
 *
 * Deshalb steht das Netz hier als SCHALTER und nicht als Bedingung. Genau so
 * hält es das Sticker-Studio, und der Wunsch, der zu dieser Datei geführt hat,
 * war wörtlich: „das Antippen mit und ohne Netz wie bei der Stickererstellung“.
 *
 * # Je Punkt ein Lauf – nicht alle Punkte in einem
 *
 * SAM nimmt beliebig viele Punkte entgegen, versteht sie aber als Hinweise
 * auf EIN Ding. Zwei Tipps auf getrennte Dinge in einem Lauf ergeben Matsch:
 * im Sticker-Studio nachgemessen deckte sich die gemeinsame Maske mit der
 * Vereinigung der Einzelmasken nur zu IoU 0,54, und 46 % ihrer Fläche gehörte
 * zu keinem der beiden Dinge. Also je Punkt ein Lauf, und die Ergebnisse
 * werden vereinigt.
 *
 * Das ist billiger, als es klingt. Teuer ist am Netz der Blick auf das BILD
 * (der Encoder), und der wird je Bild einmal gemacht und gemerkt; jeder
 * weitere Punkt kostet nur noch den Decoder. Deshalb darf diese Datei bei
 * jeder Änderung ALLE Punkte neu rechnen, statt Masken fortzuschreiben – und
 * genau deshalb ist „Letzten Tipp zurück“ hier ein Einzeiler statt einer
 * Buchführung.
 */

import {
  EngineError,
  NichtsGefunden,
  engineAvailable,
  runEngine,
} from '../stickers/engines/index.js';
import { flutmaske } from '../stickers/engines/flutung.js';
import { maskeTraegt, vorlageAus } from '../stickers/engines/prepare.js';
import { naechsteMarke } from './maske.js';
import { TOLERANZ_VORGABE, type Maskenmodus, type Maskenteil, type TippTeil } from './doc.js';

export { TOLERANZ_VORGABE };

/** Ein angetippter Punkt, in Punkten der Vorlage. */
export interface Tipp {
  x: number;
  y: number;
}

/**
 * Ob „mit Netz“ gerade gewählt werden darf.
 *
 * Ohne Netz geht das Antippen IMMER – das ist der Sinn der Sache.
 */
export function tippNetzVerfuegbar(): boolean {
  return engineAvailable('tippen');
}

/**
 * Die Vorlage je Quellbild gemerkt – wortgleich zu `netzMaske.ts`.
 *
 * Eine `WeakMap`, damit die verkleinerte Fassung mit dem Bild verschwindet;
 * bei einem grossen Foto sind das mehrere Megabyte. Und dieselbe `ImageData`
 * für dasselbe Bild ist mehr als eine Ersparnis: `engines/tippen.ts` erkennt
 * genau daran, dass es den Encoder nicht noch einmal laufen lassen muss.
 */
const vorlagen = new WeakMap<HTMLImageElement, ReturnType<typeof vorlageAus>>();

export function tippVorlage(bild: HTMLImageElement | ImageData) {
  /*
   * Fertige Bildpunkte kommen unverändert zurück.
   *
   * Das ist der Weg der Videobearbeitung: Dort liegt jedes Bild ohnehin schon
   * als `ImageData` in Rechengrösse vor. Es durch eine Leinwand zu schicken,
   * um es dort wieder herauszulesen, wäre bei hundertfünfzig Bildern
   * hundertfünfzig Mal Arbeit ohne jede Wirkung – und ein
   * `WeakMap`-Eintrag je Bild obendrein.
   */
  if ('data' in bild) return { image: bild, faktor: 1 };
  const da = vorlagen.get(bild);
  if (da) return da;
  const neu = vorlageAus(bild, bild.naturalWidth, bild.naturalHeight);
  vorlagen.set(bild, neu);
  return neu;
}

/**
 * Ob `kurz` der Anfang von `lang` ist – Punkt für Punkt, nicht nur der Länge nach.
 *
 * Herausgehoben und einzeln geprüft, weil hier ein stiller Fehler läge: Ein
 * Vergleich nur der LÄNGEN sähe „Punkt zurückgenommen und einen anderen
 * gesetzt" als Fortsetzung an – die Maske behielte dann die Fläche des
 * zurückgenommenen Tipps, sichtbar, ohne Fehlermeldung und ohne einen Punkt in
 * der Liste, den man dafür verantwortlich machen könnte.
 */
export function istAnfangVon(kurz: readonly Tipp[], lang: readonly Tipp[]): boolean {
  if (kurz.length > lang.length) return false;
  for (let i = 0; i < kurz.length; i += 1) {
    if (kurz[i].x !== lang[i].x || kurz[i].y !== lang[i].y) return false;
  }
  return true;
}

/** Zwei Masken vereinigen – die hellere Stelle gewinnt. */
export function vereinigen(a: Uint8Array, b: Uint8Array): Uint8Array {
  for (let i = 0; i < a.length; i += 1) if (b[i] > a[i]) a[i] = b[i];
  return a;
}

/**
 * Rechnet die Maske zu einer Punktliste und macht daraus ein Maskenteil.
 *
 * `modus` entscheidet das Vorzeichen – ein Minus-Tipp heisst nicht „dieser
 * Punkt gehört nicht zum vorigen Ding“, sondern „finde, was hier liegt, und
 * nimm es weg“. Das Netz bekommt seinen Punkt deshalb in BEIDEN Fällen als
 * positiven Hinweis; abgezogen wird erst beim Falten der Teile.
 *
 * Wirft `EngineError` mit einem Satz für den Anwender – ausser bei einer
 * leeren Punktliste, die gibt `null` zurück: Das ist kein Fehler, sondern der
 * letzte zurückgenommene Tipp. Fand sich an der Stelle nichts, ist der
 * Fehler genauer `NichtsGefunden` – wichtig für alles, was diese Funktion
 * wiederholt aufruft, siehe dort.
 */
export async function tippTeilRechnen(
  bild: HTMLImageElement | ImageData,
  punkte: readonly Tipp[],
  wahl: {
    modus: Maskenmodus;
    mitNetz: boolean;
    toleranz: number;
    id?: string;
    /**
     * Das Teil, wie es vor dieser Änderung aussah – als Abkürzung.
     *
     * Ist seine Punktliste der ANFANG der neuen, sind nur die neuen Punkte zu
     * rechnen; das Übrige steht schon in seinem `alpha`. Beim Zurücknehmen
     * eines Tipps oder beim Verschieben der Toleranz trifft das nicht zu,
     * dann wird alles neu gerechnet. Ohne die Abkürzung kostete der zehnte
     * Tipp zehn Netzläufe statt einem.
     *
     * **Nur mit Netz.** Die Farbflutung zieht am Ende EINE Kante über die
     * Vereinigung aller Saatpunkte; einzeln geflutet und danach vereinigt
     * ergäbe an der Naht zweier Flächen eine andere Kante. Das Bild sähe nach
     * dem nächsten Öffnen minimal anders aus als vor dem Schliessen – für
     * eine Ersparnis, die es dort ohnehin nicht gibt: Die Flutung braucht für
     * alle Punkte zusammen einen einzigen Durchgang.
     */
    vorher?: { punkte: readonly Tipp[]; alpha: Uint8Array } | null;
  },
  melden?: (text: string) => void,
): Promise<Maskenteil | null> {
  if (punkte.length === 0) return null;

  melden?.('Bild wird vorbereitet …');
  const vorlage = tippVorlage(bild);
  const { width, height } = vorlage.image;

  let alpha: Uint8Array;
  if (wahl.mitNetz) {
    if (!tippNetzVerfuegbar()) {
      throw new EngineError(
        '„Antippen mit Netz“ ist auf diesem Gerät abgeschaltet. Du kannst es in den Einstellungen einschalten – oder den Haken wegnehmen, dann wird nach Farbe getippt.',
        'tippen',
      );
    }
    const fortsetzbar =
      wahl.vorher &&
      wahl.vorher.alpha.length === width * height &&
      istAnfangVon(wahl.vorher.punkte, punkte);
    // Eine KOPIE – das alte `alpha` liegt noch im Rückgängig-Verlauf, und
    // hineinzuschreiben änderte rückwirkend einen Schritt, den jemand gerade
    // zurückholen will.
    alpha = fortsetzbar
      ? Uint8Array.from(wahl.vorher?.alpha ?? [])
      : new Uint8Array(width * height);
    const ab = fortsetzbar ? (wahl.vorher?.punkte.length ?? 0) : 0;
    for (let i = ab; i < punkte.length; i += 1) {
      const nummer = i - ab + 1;
      const offen = punkte.length - ab;
      const roh = await runEngine('tippen', {
        image: vorlage.image,
        // Immer `dazu: true`: Das Netz soll den Gegenstand FINDEN. Ob er
        // dazukommt oder wegfällt, entscheidet `modus` am Teil.
        seeds: [{ x: punkte[i].x, y: punkte[i].y, dazu: true }],
        fortschritt: (_anteil, text) =>
          melden?.(offen > 1 ? `${text} (${nummer} von ${offen})` : text),
      });
      vereinigen(alpha, roh);
    }
  } else {
    melden?.('Farben werden verfolgt …');
    /*
     * Alle Punkte in EINEM Aufruf – anders als beim Netz, und das ist kein
     * Versehen: Die Flutung behandelt jeden Saatpunkt ohnehin für sich
     * (eigene Besuchsliste) und vereinigt am Ende. Ein Aufruf je Punkt wäre
     * dasselbe Ergebnis für das N-fache an Arbeit.
     */
    alpha = flutmaske(vorlage.image, punkte, wahl.toleranz);
  }

  if (!maskeTraegt(alpha)) {
    throw new NichtsGefunden(
      wahl.mitNetz
        ? 'An dieser Stelle wurde nichts gefunden. Tipp mitten auf das Ding – oder nimm den Haken weg, dann wird nach Farbe getippt.'
        : 'An dieser Stelle ist nichts aufgegangen. Zieh die Toleranz höher, dann greift die Farbe weiter.',
      'tippen',
    );
  }

  const teil: TippTeil & { id: string; modus: Maskenmodus; umkehren: boolean } = {
    // Die Kennung wird WEITERGEREICHT, wenn es sie schon gibt: Jeder weitere
    // Tipp ersetzt das Teil, und mit einer neuen Kennung verlöre der Editor
    // bei jedem Tipp die Auswahl in der Maskenliste.
    id: wahl.id ?? `t${naechsteMarke()}`,
    modus: wahl.modus,
    umkehren: false,
    art: 'tipp',
    mitNetz: wahl.mitNetz,
    punkte: punkte.map((p) => ({ x: p.x, y: p.y })),
    toleranz: wahl.toleranz,
    breite: width,
    hoehe: height,
    alpha,
    // Frisch bei jeder Neuberechnung – daran erkennt der Zwischenspeicher der
    // Masken, dass sich etwas getan hat. Siehe `teilSchluessel`.
    marke: naechsteMarke(),
  };
  return teil;
}
