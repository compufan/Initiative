import { describe, expect, it, vi } from 'vitest';
import { ArbeiterFehler, BirefnetKanal, type ArbeiterAehnlich } from './birefnetKanal.js';
import type { AnArbeiter, VomArbeiter } from './birefnet.worker.js';

/**
 * Ein Doppelgänger für den Arbeiter.
 *
 * Er merkt sich, was ankam, und lässt den Test bestimmen, was zurückkommt.
 * Das ist der ganze Grund, warum der Kanal seine Fabrik von aussen bekommt:
 * Fälle wie „der Arbeiter stirbt mitten im Lauf" liessen sich an einem echten
 * `new Worker(...)` weder herstellen noch beobachten.
 */
class Doppel implements ArbeiterAehnlich {
  onmessage: ((ereignis: { data: VomArbeiter }) => void) | null = null;
  onerror: ((ereignis: unknown) => void) | null = null;
  readonly empfangen: AnArbeiter[] = [];
  readonly uebergeben: Transferable[][] = [];
  beendet = 0;

  postMessage(nachricht: AnArbeiter, uebergeben?: Transferable[]): void {
    this.empfangen.push(nachricht);
    this.uebergeben.push(uebergeben ?? []);
  }

  terminate(): void {
    this.beendet += 1;
  }

  /** Der Arbeiter meldet sich. */
  sende(nachricht: VomArbeiter): void {
    this.onmessage?.({ data: nachricht });
  }

  /** Der Arbeiter stirbt. */
  stirb(message = 'boom'): void {
    this.onerror?.({ message });
  }
}

function aufbau(): { kanal: BirefnetKanal; doppel: () => Doppel; gebaut: () => number } {
  let letzter: Doppel | null = null;
  let anzahl = 0;
  const kanal = new BirefnetKanal(() => {
    anzahl += 1;
    letzter = new Doppel();
    return letzter;
  });
  return {
    kanal,
    doppel: () => {
      if (!letzter) throw new Error('Noch kein Arbeiter gebaut');
      return letzter;
    },
    gebaut: () => anzahl,
  };
}

const tensor = () => new Float32Array(8);

describe('BirefnetKanal', () => {
  it('baut den Arbeiter erst beim ersten Auftrag', () => {
    const { kanal, gebaut } = aufbau();
    expect(gebaut()).toBe(0);
    void kanal.rechne(tensor()).catch(() => undefined);
    expect(gebaut()).toBe(1);
  });

  it('übergibt den Tensor, statt ihn zu kopieren', async () => {
    // Drei Megabyte je Bild. Wer sie kopiert, zahlt sie zweimal – einmal im
    // Hauptfaden und einmal im Arbeiter.
    const { kanal, doppel } = aufbau();
    const t = tensor();
    void kanal.rechne(t).catch(() => undefined);
    expect(doppel().uebergeben[0]).toEqual([t.buffer]);
  });

  it('reicht den Fortschritt durch', async () => {
    const { kanal, doppel } = aufbau();
    const gesehen: string[] = [];
    const lauf = kanal.rechne(tensor(), (_, text) => gesehen.push(text));
    doppel().sende({ art: 'fortschritt', anteil: 0.5, text: 'Modell wird geladen … 47 MB' });
    doppel().sende({ art: 'fertig', roh: new Float32Array(4), ladeMs: 1200, laufMs: 800 });
    await lauf;
    expect(gesehen).toEqual(['Modell wird geladen … 47 MB']);
  });

  it('liefert Ergebnis und Zeiten', async () => {
    const { kanal, doppel } = aufbau();
    const lauf = kanal.rechne(tensor());
    doppel().sende({ art: 'fertig', roh: new Float32Array([1, 2]), ladeMs: 1200, laufMs: 800 });
    const ergebnis = await lauf;
    expect([...ergebnis.roh]).toEqual([1, 2]);
    expect(ergebnis.ladeMs).toBe(1200);
    expect(ergebnis.laufMs).toBe(800);
  });

  it('meldet einen Fehler samt der Auskunft, ob er mitten im Lauf kam', async () => {
    // Der Unterschied entscheidet, ob die Grafikeinheit gemerkt aufgibt:
    // Ein Abbruch im Lauf heisst „dieses Gerät schafft es nicht", ein Fehler
    // beim Laden heisst nur „die Datei kam nicht an".
    const { kanal, doppel } = aufbau();
    const lauf = kanal.rechne(tensor());
    doppel().sende({ art: 'fehler', text: 'f16 fehlt', imLauf: true, laufMs: 4200 });
    await expect(lauf).rejects.toThrow('f16 fehlt');
    await lauf.catch((fehler: unknown) => {
      expect(fehler).toBeInstanceOf(ArbeiterFehler);
      expect((fehler as ArbeiterFehler).imLauf).toBe(true);
      expect((fehler as ArbeiterFehler).laufMs).toBe(4200);
    });
  });

  it('lässt kein Versprechen offen, wenn der Arbeiter stirbt', async () => {
    /*
     * Der wichtigste Fall.
     *
     * Ein Arbeiter kann ohne jede Nachricht verschwinden – iOS beendet
     * Seiten, die zu viel Speicher halten, kommentarlos, und 94 MB Modell
     * sind genau so ein Fall. Ohne `onerror` bliebe das Versprechen für immer
     * offen: Der Anwender sähe „Wird freigestellt …" und danach nichts mehr.
     */
    const { kanal, doppel } = aufbau();
    const lauf = kanal.rechne(tensor());
    doppel().stirb('out of memory');
    await expect(lauf).rejects.toThrow('out of memory');
  });

  it('baut nach einem Absturz einen frischen Arbeiter', async () => {
    const { kanal, doppel, gebaut } = aufbau();
    const erster = kanal.rechne(tensor());
    doppel().stirb();
    await expect(erster).rejects.toThrow();
    expect(gebaut()).toBe(1);

    const zweiter = kanal.rechne(tensor());
    expect(gebaut()).toBe(2);
    doppel().sende({ art: 'fertig', roh: new Float32Array(1), ladeMs: 0, laufMs: 10 });
    await expect(zweiter).resolves.toBeTruthy();
  });

  it('verwendet den Arbeiter für einen zweiten Lauf wieder', async () => {
    // Sonst wären es beim zweiten Bild wieder 94 MB Download.
    const { kanal, doppel, gebaut } = aufbau();
    const erster = kanal.rechne(tensor());
    doppel().sende({ art: 'fertig', roh: new Float32Array(1), ladeMs: 5000, laufMs: 900 });
    await erster;
    const zweiter = kanal.rechne(tensor());
    doppel().sende({ art: 'fertig', roh: new Float32Array(1), ladeMs: 0, laufMs: 850 });
    await zweiter;
    expect(gebaut()).toBe(1);
  });

  it('weist einen zweiten Auftrag ab, solange einer läuft', async () => {
    const { kanal, doppel } = aufbau();
    const erster = kanal.rechne(tensor());
    await expect(kanal.rechne(tensor())).rejects.toThrow(/läuft bereits/);
    doppel().sende({ art: 'fertig', roh: new Float32Array(1), ladeMs: 0, laufMs: 1 });
    await expect(erster).resolves.toBeTruthy();
  });

  it('beendet den Arbeiter beim Freigeben und lässt keinen Lauf hängen', async () => {
    const { kanal, doppel } = aufbau();
    const lauf = kanal.rechne(tensor());
    const arbeiter = doppel();
    kanal.freigeben();
    await expect(lauf).rejects.toThrow(/abgebrochen/);
    expect(arbeiter.beendet).toBe(1);
    expect(arbeiter.empfangen.at(-1)).toEqual({ art: 'freigeben' });
  });

  it('überlebt ein Freigeben ohne laufenden Arbeiter', () => {
    const { kanal } = aufbau();
    expect(() => kanal.freigeben()).not.toThrow();
  });

  it('ignoriert Nachrichten, die zu keinem Auftrag gehören', async () => {
    // Nach einem Abbruch trudeln durchaus noch Nachrichten ein. Sie dürfen
    // kein zweites Mal in ein bereits erfülltes Versprechen greifen.
    const { kanal, doppel } = aufbau();
    const lauf = kanal.rechne(tensor());
    const arbeiter = doppel();
    arbeiter.sende({ art: 'fertig', roh: new Float32Array(1), ladeMs: 0, laufMs: 1 });
    await lauf;
    expect(() =>
      arbeiter.sende({ art: 'fehler', text: 'zu spät', imLauf: false, laufMs: 0 }),
    ).not.toThrow();
  });

  it('scheitert sauber, wenn schon das Absenden fehlschlägt', async () => {
    // `postMessage` wirft, wenn der Puffer bereits übergeben wurde. Ohne den
    // try/catch bliebe der Auftrag als „läuft" stehen und jeder weitere
    // Versuch prallte an „Es läuft bereits" ab – dauerhaft.
    const kaputt: ArbeiterAehnlich = {
      postMessage: () => {
        throw new Error('bereits übergeben');
      },
      terminate: vi.fn(),
      onmessage: null,
      onerror: null,
    };
    const kanal = new BirefnetKanal(() => kaputt);
    await expect(kanal.rechne(tensor())).rejects.toThrow('bereits übergeben');
    // Und danach geht es wieder – der Auftrag steht nicht mehr offen.
    await expect(kanal.rechne(tensor())).rejects.toThrow('bereits übergeben');
  });
});
