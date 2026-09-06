/**
 * Der Draht zum BiRefNet-Arbeiter – ohne ONNX Runtime im Hauptfaden.
 *
 * Getrennt von `birefnet.ts`, damit dieses Stück ohne Browser prüfbar ist:
 * Der Kanal bekommt die Arbeiterfabrik von aussen und weiss nichts von
 * `new Worker(...)`. Im Test steht dort ein Doppelgänger, der dieselben
 * Nachrichten schickt – und damit lassen sich genau die Fälle prüfen, die in
 * einem Arbeiter sonst niemand sieht: ein Fehlschlag mitten im Lauf, ein
 * zweiter Auftrag während der erste läuft, ein Arbeiter, der stirbt.
 */

import type { AnArbeiter, VomArbeiter } from './birefnet.worker.js';

export type Fortschritt = (anteil: number, text: string) => void;

/** Was der Kanal von einem Arbeiter braucht – mehr nicht. */
export interface ArbeiterAehnlich {
  postMessage(nachricht: AnArbeiter, uebergeben?: Transferable[]): void;
  terminate(): void;
  onmessage: ((ereignis: { data: VomArbeiter }) => void) | null;
  onerror: ((ereignis: unknown) => void) | null;
}

export interface Lauf {
  roh: Float32Array;
  ladeMs: number;
  laufMs: number;
}

/** Ein Fehlschlag mitsamt der Auskunft, ob er mitten im Rechnen kam. */
export class ArbeiterFehler extends Error {
  readonly imLauf: boolean;
  readonly laufMs: number;

  constructor(text: string, imLauf: boolean, laufMs: number) {
    super(text);
    this.name = 'ArbeiterFehler';
    this.imLauf = imLauf;
    this.laufMs = laufMs;
  }
}

export class BirefnetKanal {
  private arbeiter: ArbeiterAehnlich | null = null;
  private readonly bauen: () => ArbeiterAehnlich;
  /** Der laufende Auftrag. Es gibt immer höchstens einen. */
  private offen: {
    fertig: (lauf: Lauf) => void;
    scheitert: (fehler: Error) => void;
    melden?: Fortschritt;
  } | null = null;

  constructor(bauen: () => ArbeiterAehnlich) {
    this.bauen = bauen;
  }

  private hole(): ArbeiterAehnlich {
    if (this.arbeiter) return this.arbeiter;
    const neu = this.bauen();
    neu.onmessage = (ereignis) => this.empfangen(ereignis.data);
    /*
     * Ein Arbeiter kann sterben, ohne eine Nachricht zu schicken.
     *
     * Ohne diesen Zweig bliebe das Versprechen für immer offen: Der Anwender
     * sähe „Wird freigestellt …" und danach nichts mehr, kein Fehler, kein
     * Abbruch. Von allen Arten zu scheitern ist das die schlechteste.
     */
    neu.onerror = (ereignis) => {
      const text =
        typeof ereignis === 'object' && ereignis && 'message' in ereignis
          ? String((ereignis as { message: unknown }).message)
          : 'Der Arbeiter ist abgestürzt.';
      this.abbrechen(new ArbeiterFehler(text, false, 0));
    };
    this.arbeiter = neu;
    return neu;
  }

  private empfangen(nachricht: VomArbeiter): void {
    const auftrag = this.offen;
    if (!auftrag) return;
    switch (nachricht.art) {
      case 'fortschritt':
        auftrag.melden?.(nachricht.anteil, nachricht.text);
        return;
      case 'fertig':
        this.offen = null;
        auftrag.fertig({
          roh: nachricht.roh,
          ladeMs: nachricht.ladeMs,
          laufMs: nachricht.laufMs,
        });
        return;
      case 'fehler':
        this.offen = null;
        auftrag.scheitert(new ArbeiterFehler(nachricht.text, nachricht.imLauf, nachricht.laufMs));
        return;
      case 'frei':
        return;
    }
  }

  private abbrechen(fehler: Error): void {
    const auftrag = this.offen;
    this.offen = null;
    // Ein abgestürzter Arbeiter wird nicht wiederverwendet: Der nächste
    // Auftrag baut einen frischen.
    this.arbeiter = null;
    auftrag?.scheitert(fehler);
  }

  /**
   * Einen Lauf beauftragen.
   *
   * `tensor` wird ÜBERGEBEN, nicht kopiert – der Aufrufer darf ihn danach
   * nicht mehr anfassen. Drei Megabyte je Bild sind es wert; wer sie noch
   * braucht, kopiert vorher selbst.
   */
  rechne(tensor: Float32Array, melden?: Fortschritt): Promise<Lauf> {
    if (this.offen) {
      // Kein Warteschlangenbau: Das Studio lässt immer nur einen Lauf zu, und
      // ein zweiter wäre ein Fehler im Aufrufer, den man sehen soll.
      return Promise.reject(new Error('Es läuft bereits eine Freistellung.'));
    }
    return new Promise<Lauf>((fertig, scheitert) => {
      this.offen = { fertig, scheitert, melden };
      try {
        this.hole().postMessage({ art: 'rechne', tensor }, [tensor.buffer]);
      } catch (fehler) {
        this.offen = null;
        scheitert(fehler instanceof Error ? fehler : new Error(String(fehler)));
      }
    });
  }

  /** Den Arbeiter samt seiner 94 MB wieder loswerden. */
  freigeben(): void {
    const arbeiter = this.arbeiter;
    this.arbeiter = null;
    this.abbrechen(new Error('Die Freistellung wurde abgebrochen.'));
    if (!arbeiter) return;
    try {
      arbeiter.postMessage({ art: 'freigeben' });
    } catch {
      // Ein bereits toter Arbeiter nimmt nichts mehr entgegen – egal.
    }
    arbeiter.terminate();
  }
}
