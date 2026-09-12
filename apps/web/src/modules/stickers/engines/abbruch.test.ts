/**
 * Abbrechen, was Minuten dauern kann.
 *
 * „Hohe Qualität" zieht beim ersten Mal 78 MB und rechnet danach auf der
 * Grafikeinheit. Wer versehentlich darauf tippt, sass fest: Es gab keinen Weg
 * zurück, und auch das Schliessen des Studios half nicht – der Arbeiter samt
 * Modell lief weiter.
 *
 * Geprüft wird hier die Regel, nicht das Modell: Ein gesetztes Signal muss
 * VOR dem Laden abbrechen, und ein währenddessen gesetztes muss das Ergebnis
 * verwerfen, statt es in eine Oberfläche zu schreiben, die längst
 * weitergezogen ist.
 */
import { describe, expect, it, vi } from 'vitest';
import { AbbruchError, runEngine } from './index.js';

vi.mock('./settings.js', () => ({
  isEngineEnabled: () => true,
  readEngineSettings: () => ({}),
  writeEngineSetting: () => ({}),
}));

vi.mock('./runtime.js', () => ({ runtimeSupported: () => true }));

/** Wie oft das Modell wirklich angefasst wurde. */
let laeufe = 0;
type Aufloeser = (wert: Uint8Array) => void;
let aufloesen: Aufloeser | null = null;

vi.mock('./object.js', () => ({
  objectMask: (_bild: ImageData, _melden?: unknown, _abbruch?: AbortSignal) => {
    laeufe += 1;
    return new Promise<Uint8Array>((fertig) => {
      aufloesen = fertig;
    });
  },
  releaseObject: () => {},
}));

function bild(): ImageData {
  return { data: new Uint8ClampedArray(4), width: 1, height: 1 } as ImageData;
}

/**
 * Warten, bis der Lauf wirklich begonnen hat.
 *
 * Ein `await Promise.resolve()` reicht nicht: `runEngine` lädt das Modul erst
 * per `import()`, und das braucht mehrere Runden der Mikroaufgaben. Ein fester
 * Wert wäre geraten – also wird gewartet, bis die Bedingung gilt.
 */
async function bisGilt(bedingung: () => boolean, runden = 200): Promise<void> {
  for (let i = 0; i < runden; i += 1) {
    if (bedingung()) return;
    await Promise.resolve();
    await new Promise((weiter) => setTimeout(weiter, 0));
  }
  throw new Error('Die Bedingung trat nicht ein');
}

describe('Ein gesetztes Abbruchsignal', () => {
  it('lädt gar nicht erst, wenn schon vor dem Start abgebrochen wurde', async () => {
    laeufe = 0;
    aufloesen = null as Aufloeser | null;
    const steuerung = new AbortController();
    steuerung.abort();

    await expect(
      runEngine('object', { image: bild(), abbruch: steuerung.signal }),
    ).rejects.toBeInstanceOf(AbbruchError);

    /*
     * Der Punkt: Es wurden keine 4 MB geholt. Ein Abbruch, der das Modell
     * trotzdem lädt und erst danach den Fehler wirft, hätte den Anwender
     * seinen Datenverbrauch schon gekostet.
     */
    expect(laeufe).toBe(0);
  });

  it('verwirft das Ergebnis, wenn während des Laufs abgebrochen wird', async () => {
    laeufe = 0;
    aufloesen = null as Aufloeser | null;
    const steuerung = new AbortController();
    const versprechen = runEngine('object', { image: bild(), abbruch: steuerung.signal });

    // Der Lauf hat begonnen …
    await bisGilt(() => laeufe === 1);

    // … und wird währenddessen abgebrochen; das Modell kommt danach zurück.
    steuerung.abort();
    aufloesen?.(new Uint8Array([255]));

    await expect(versprechen).rejects.toBeInstanceOf(AbbruchError);
  });

  it('lässt einen Lauf ohne Signal unberührt durch', async () => {
    laeufe = 0;
    aufloesen = null as Aufloeser | null;
    const versprechen = runEngine('object', { image: bild() });
    await bisGilt(() => laeufe === 1);
    aufloesen?.(new Uint8Array([7]));
    await expect(versprechen).resolves.toEqual(new Uint8Array([7]));
  });
});
