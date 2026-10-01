import type { Tor } from './maskenVerfolgen.js';

/**
 * Das Tor der Hintergrundarbeit: zu, solange ein Grund besteht, und noch ein
 * wenig länger.
 *
 * # Warum es das Tor einmal gibt
 *
 * Weil zwei Dinge im Hintergrund laufen, die dem Anwender nie im Weg stehen
 * dürfen – die Verfolgung der Masken (`verfolger.ts`) und das Füllen des
 * Wischspeichers (`wischspeicher.ts`) – und beide aus denselben Gründen
 * innehalten: Ein Finger auf der Leiste, die Wiedergabe, der Filmbau, ein
 * verborgenes Fenster. Zwei Fassungen der Wartelogik hätten zwei Stellen, an
 * denen ein Grund vergessen wird. Welche Gründe es gibt, sagt jeder Benutzer
 * selbst (`G`).
 *
 * # Wie lange nach dem letzten Grund
 *
 * `WEITER_MS` nach dem letzten Grund, und nach einem Zug mindestens
 * `ZUG_RUHE_MS` – wer die Leiste loslässt, zieht oft gleich noch einmal.
 */

/** So lange nach dem letzten Grund geht es weiter. */
export const WEITER_MS = 300;
/** Nach einem Zug mindestens so lange Ruhe. */
export const ZUG_RUHE_MS = 500;

/** Das Tor: zu, solange ein Grund besteht, und noch ein wenig länger. */
export class Ruhetor<G extends string = string> implements Tor {
  private readonly gruende = new Set<G>();
  private frei = 0;
  private zugEnde = 0;
  private readonly wartende = new Set<() => void>();

  constructor(private readonly weiterMs: number) {}

  get zu(): boolean {
    return this.gruende.size > 0;
  }

  setzen(grund: G, an: boolean): void {
    if (an) this.gruende.add(grund);
    else if (this.gruende.delete(grund)) {
      const jetzt = Date.now();
      if (this.gruende.size === 0) this.frei = jetzt + this.weiterMs;
      // Nur der Zug zählt für die Ruhe danach – er heisst bei allen Benutzern gleich.
      if (grund === ('zug' as G)) this.zugEnde = jetzt;
    }
    this.wecken();
  }

  /**
   * Wie lange insgesamt am Tor gewartet wurde, in ms – damit die Schätzung
   * der Restzeit nur lernt, was gerechnet wurde, nicht wie lange der
   * Anwender gewischt hat (siehe `ausfuehren`).
   */
  gewartet = 0;

  async offen(ruheNachZugMs = 0): Promise<void> {
    const beginn = Date.now();
    try {
      for (;;) {
        if (this.gruende.size > 0) {
          await this.schlafen(null);
          continue;
        }
        const jetzt = Date.now();
        const warten = Math.max(
          this.frei - jetzt,
          this.zugEnde + Math.max(ZUG_RUHE_MS, ruheNachZugMs) - jetzt,
        );
        if (warten <= 0) return;
        await this.schlafen(warten);
      }
    } finally {
      this.gewartet += Date.now() - beginn;
    }
  }

  wecken(): void {
    for (const weiter of [...this.wartende]) weiter();
  }

  private schlafen(ms: number | null): Promise<void> {
    return new Promise((weiter) => {
      let zeitgeber: ReturnType<typeof setTimeout> | null = null;
      const fertig = () => {
        this.wartende.delete(fertig);
        if (zeitgeber) clearTimeout(zeitgeber);
        weiter();
      };
      this.wartende.add(fertig);
      if (ms !== null) zeitgeber = setTimeout(fertig, ms);
    });
  }
}
