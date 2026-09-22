import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Esc schliesst genau EIN Blatt – das oberste.
 *
 * Der Anlass war handfest: Über dem fertigen GIF liegt das Blatt für die
 * Paketwahl. Solange jedes Blatt seinen eigenen `keydown` am Fenster hatte,
 * hörten beide zu, und ein Esc schloss beide – samt dem GIF, das je nach
 * Güte Minuten gerechnet hatte.
 *
 * Geprüft wird hier die Buchführung selbst und nicht ein Blatt: Ein
 * Browsertest bräuchte dafür erst einen Film, und die Regel gilt für jeden
 * Dialog, nicht nur für diesen einen.
 */

type Hoerer = (ereignis: { key: string; defaultPrevented?: boolean }) => void;

let hoerer: Map<string, Hoerer[]>;
let modul: typeof import('./dialogVerlauf.js');

async function fensterStellen() {
  hoerer = new Map();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {
      addEventListener: (typ: string, fn: Hoerer) => {
        hoerer.set(typ, [...(hoerer.get(typ) ?? []), fn]);
      },
      removeEventListener: () => {},
      // Die Buchführung legt einen Verlaufseintrag an; hier genügt eine
      // Attrappe, die nichts tut.
      history: { pushState: () => {}, back: () => {}, state: null },
      setTimeout: (fn: () => void) => setTimeout(fn, 0),
    },
  });
  vi.resetModules();
  modul = await import('./dialogVerlauf.js');
}

function escDruecken() {
  for (const fn of hoerer.get('keydown') ?? []) fn({ key: 'Escape' });
}

beforeEach(fensterStellen);

afterEach(async () => {
  /*
   * Erst den aufgeschobenen Abgleich ablaufen lassen, dann das Fenster
   * wegnehmen.
   *
   * `dialogAnmelden` plant die Buchführung über `window.setTimeout` – siehe
   * die Begründung im Modul. Wer die Attrappe vorher entfernt, bekommt den
   * Fehler ERST NACH dem letzten Test und an einer Stelle, die nichts mehr
   * mit ihm zu tun hat.
   */
  await new Promise((weiter) => setTimeout(weiter, 1));
  Reflect.deleteProperty(globalThis, 'window');
});

describe('Esc über dem Stapel', () => {
  it('schliesst nur den obersten Dialog', () => {
    const gerufen: string[] = [];
    modul.dialogAnmelden(() => gerufen.push('unten'));
    modul.dialogAnmelden(() => gerufen.push('oben'));

    escDruecken();

    expect(gerufen).toEqual(['oben']);
  });

  it('trifft nach dem Abmelden den darunterliegenden', () => {
    const gerufen: string[] = [];
    modul.dialogAnmelden(() => gerufen.push('unten'));
    const abmelden = modul.dialogAnmelden(() => gerufen.push('oben'));

    escDruecken();
    abmelden();
    escDruecken();

    expect(gerufen).toEqual(['oben', 'unten']);
  });

  it('tut nichts, wenn gar kein Dialog offen ist', () => {
    expect(() => escDruecken()).not.toThrow();
    expect(modul.dialogeOffen()).toBe(0);
  });

  it('hält still, wenn die Taste schon jemand anders verbraucht hat', () => {
    // Ein Eingabefeld, das Esc selbst behandelt (siehe ProfileScreen), ruft
    // `preventDefault`. Danach darf nicht zusätzlich ein Blatt zugehen.
    const gerufen: string[] = [];
    modul.dialogAnmelden(() => gerufen.push('oben'));
    for (const fn of hoerer.get('keydown') ?? []) fn({ key: 'Escape', defaultPrevented: true });
    expect(gerufen).toEqual([]);
  });

  it('zählt die offenen Dialoge', () => {
    expect(modul.dialogeOffen()).toBe(0);
    const weg = modul.dialogAnmelden(() => {});
    expect(modul.dialogeOffen()).toBe(1);
    weg();
    expect(modul.dialogeOffen()).toBe(0);
  });
});

describe('Die Reihenfolge am Stapel', () => {
  it('bleibt erhalten, wenn ein Dialog sich abmeldet und sofort wieder anmeldet', () => {
    /*
     * Genau das passierte bei jedem Rendern des Elternteils, solange die
     * Anmeldung an `onClose` hing: Der untere Dialog meldete ab und wieder
     * an – und lag danach OBEN. Ein Esc schloss dann ihn statt des Blattes
     * darüber. `useDialogAnmeldung` verhindert das, indem es gar nicht erst
     * abmeldet; diese Prüfung hält die Folge fest, die sonst einträte.
     */
    const gerufen: string[] = [];
    const abUnten = modul.dialogAnmelden(() => gerufen.push('unten'));
    modul.dialogAnmelden(() => gerufen.push('oben'));

    // Der untere meldet sich neu an – wie es ein instabiler Rückruf täte.
    abUnten();
    modul.dialogAnmelden(() => gerufen.push('unten-neu'));

    escDruecken();
    expect(gerufen).toEqual(['unten-neu']);
  });
});
