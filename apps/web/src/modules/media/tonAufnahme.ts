/**
 * Eine Tonaufnahme ohne Oberfläche – für das Gedrückthalten im Eingabefeld.
 * (Das Blatt `VoiceSheet` hat seine eigene, ältere Fassung mit Pegel.)
 */
import { AUDIO_MIME_CANDIDATES, baseMime, pickRecorderMime } from './helpers.js';

export interface TonErgebnis {
  blob: Blob;
  mime: string;
  durationMs: number;
}

export class TonAufnahme {
  private stoppen: Promise<TonErgebnis> | null = null;

  private constructor(
    private readonly strom: MediaStream,
    private readonly rekorder: MediaRecorder,
    private readonly stuecke: Blob[],
    private readonly beginn: number,
  ) {}

  static async starten(): Promise<TonAufnahme> {
    const strom = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    const wunsch = pickRecorderMime(AUDIO_MIME_CANDIDATES);
    let rekorder: MediaRecorder;
    try {
      rekorder = new MediaRecorder(strom, wunsch ? { mimeType: wunsch } : undefined);
    } catch (fehler) {
      strom.getTracks().forEach((spur) => spur.stop());
      throw fehler;
    }
    const stuecke: Blob[] = [];
    rekorder.ondataavailable = (ereignis) => {
      if (ereignis.data.size > 0) stuecke.push(ereignis.data);
    };
    rekorder.start(250);
    return new TonAufnahme(strom, rekorder, stuecke, Date.now());
  }

  get dauerMs(): number {
    return Date.now() - this.beginn;
  }

  /** Beenden und das Ergebnis holen. */
  beenden(): Promise<TonErgebnis> {
    if (this.stoppen) return this.stoppen;
    const dauer = this.dauerMs;
    this.stoppen = new Promise<TonErgebnis>((fertig, fehler) => {
      this.rekorder.onstop = () => {
        this.strom.getTracks().forEach((spur) => spur.stop());
        const mime = baseMime(this.rekorder.mimeType) || 'audio/webm';
        fertig({ blob: new Blob(this.stuecke, { type: mime }), mime, durationMs: dauer });
      };
      this.rekorder.onerror = () => fehler(new Error('Die Aufnahme ist fehlgeschlagen'));
      try {
        if (this.rekorder.state !== 'inactive') this.rekorder.stop();
        else this.rekorder.onstop?.(new Event('stop'));
      } catch (grund) {
        fehler(grund instanceof Error ? grund : new Error(String(grund)));
      }
    });
    return this.stoppen;
  }

  /** Verwerfen: Mikrofon aus, nichts behalten. */
  verwerfen(): void {
    try {
      if (this.rekorder.state !== 'inactive') this.rekorder.stop();
    } catch {
      /* schon aus */
    }
    this.strom.getTracks().forEach((spur) => spur.stop());
    this.stuecke.length = 0;
  }
}
