import type { CastGrund, CastZustand } from './cast.js';

/**
 * Was der Cast-Knopf zeigt – als reine Entscheidung, ohne React.
 *
 * # Warum das hier steht und nicht in der Komponente
 *
 * Weil genau diese Entscheidung einmal falsch war, und zwar auf eine Art, die
 * kein Test gesehen hat. In `CastKnopf` stand:
 *
 *     if (zustand === 'aus' || zustand === 'keine-geraete') return null;
 *
 * Ein Anwender hat das so erlebt: „Ich muss einer Datenschutzvereinbarung
 * zustimmen. Danach passiert gar nichts. Der Fernseher-Button ist danach auch
 * weg." Beides stimmte. Nach der Zustimmung fällt der Schalter weg, das SDK
 * lädt noch, der Zustand ist `aus` – und dazwischen lag nichts.
 *
 * In der Komponente liess sich das nicht festhalten: Die Tests dieses
 * Projektes kommen ohne Renderer aus, und der Browsertest sieht nur den
 * Zustand, den der Testläufer zufällig herstellt (dort steht kein Chromecast,
 * also nie `bereit`, und je nach Netz auch nie `keine-geraete`).
 *
 * Als Funktion ist die Regel dagegen erschöpfend prüfbar – über ALLE
 * Zustände, nicht über die, die gerade eintreten. Die Regel lautet:
 *
 *   **Wer zugestimmt hat, sieht immer etwas.** Kein Zustand darf `nichts`
 *   ergeben, wenn `erlaubt` gilt und der Browser casten kann.
 *
 * Das ist keine Geschmacksfrage. Ein Bedienelement, das nach einer Zustimmung
 * spurlos verschwindet, liest sich als Fehler der App – und ist es auch.
 */
export type CastAnzeige =
  /** Gar nichts – nur erlaubt, solange niemand zugestimmt hat und kein Platz für einen Satz ist. */
  | 'nichts'
  /** Der Schalter, der das Streamen einschaltet. Noch nicht der Cast-Knopf. */
  | 'schalter'
  /** Dieser Browser oder diese Adresse kann kein Cast – mit Begründung. */
  | 'geht-hier-nicht'
  /** Das SDK ist unterwegs. */
  | 'laedt'
  /** Das SDK kam nicht: kein Netz, ein Blocker, oder die Frist ist abgelaufen. */
  | 'fehlgeschlagen'
  /** Kein Gerät im WLAN – der echte Knopf versteckt sich, ein Hinweis bleibt. */
  | 'kein-geraet'
  /** Der echte `<google-cast-launcher>`. */
  | 'knopf';

export interface CastLage {
  /** Kann dieser Browser an dieser Adresse überhaupt casten? */
  grund: CastGrund;
  /** Hat jemand auf diesem Gerät zugestimmt? */
  erlaubt: boolean;
  /** Was das SDK meldet. */
  zustand: CastZustand;
  /**
   * Steht der Knopf in einer Werkzeugleiste (`leiste`) oder in der dunklen
   * Leiste über einem Foto (`rund`)?
   *
   * Der Unterschied ist nur einer: Wo kein Platz für einen Satz ist, bleibt
   * ein Browser, der gar nicht casten kann, still – dort steht der andere Weg
   * ohnehin daneben. Alles andere ist in beiden Fällen gleich, und
   * insbesondere gibt es auch in der engen Leiste nach einer Zustimmung immer
   * etwas zu sehen.
   */
  stil: 'rund' | 'leiste';
}

export function castAnzeige({ grund, erlaubt, zustand, stil }: CastLage): CastAnzeige {
  if (grund !== 'geht') {
    /*
     * Vor jeder Zustimmung: In der engen Leiste schweigen, in der breiten den
     * Grund nennen. Wer zugestimmt HAT und dann das Gerät wechselt (Telefon
     * über die LAN-Adresse statt über https), soll den Grund in jedem Fall
     * erfahren – sonst ist genau das wieder die Leerstelle, um die es geht.
     */
    if (stil === 'leiste' || erlaubt) return 'geht-hier-nicht';
    return 'nichts';
  }
  if (!erlaubt) return 'schalter';
  switch (zustand) {
    case 'aus':
      return 'laedt';
    case 'fehlgeschlagen':
      return 'fehlgeschlagen';
    case 'keine-geraete':
      return 'kein-geraet';
    default:
      return 'knopf';
  }
}
