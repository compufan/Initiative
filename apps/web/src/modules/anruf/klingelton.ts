/**
 * Klingel- und Freizeichen – eine eigene kleine Tonfolge per WebAudio, ohne
 * Tondatei (keine Lizenzfrage, kein Laden).
 *
 * Browser lassen Ton erst nach einer Berührung der Seite zu. Klingelt es,
 * bevor man die App angefasst hat (frisch aus einer Mitteilung geöffnet),
 * bleibt es still; dann vibriert das Gerät, wo es das kann, und die
 * Oberfläche blinkt. Ehrlich dokumentiert in `docs/FEATURES.md`.
 */

export interface Ton {
  /** Frequenz in Hz; 0 = Pause. */
  hz: number;
  ms: number;
}

/**
 * Eingehend: zwei kurze Doppeltöne, dann Ruhe – deutlich, aber nicht schrill.
 * Ausgehend (Freizeichen): 425 Hz, eine Sekunde an, vier aus – wie im
 * europäischen Telefonnetz, damit man sofort weiss, dass es drüben klingelt.
 */
export function tonfolge(art: 'eingehend' | 'ausgehend'): Ton[] {
  if (art === 'ausgehend') {
    return [
      { hz: 425, ms: 1000 },
      { hz: 0, ms: 4000 },
    ];
  }
  return [
    { hz: 784, ms: 180 },
    { hz: 988, ms: 180 },
    { hz: 0, ms: 120 },
    { hz: 784, ms: 180 },
    { hz: 988, ms: 180 },
    { hz: 0, ms: 1600 },
  ];
}

export function periodeMs(folge: Ton[]): number {
  return folge.reduce((summe, ton) => summe + ton.ms, 0);
}

type AudioCtor = typeof AudioContext;

let laufend: { stop: () => void } | null = null;

/** Spielt die Folge in Schleife, bis `klingeltonAus()`. */
export function klingeltonAn(art: 'eingehend' | 'ausgehend'): void {
  klingeltonAus();
  const Ctor: AudioCtor | undefined =
    typeof window === 'undefined'
      ? undefined
      : (window.AudioContext ??
        (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext);
  const folge = tonfolge(art);
  let vibration: number | null = null;
  if (art === 'eingehend' && typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    const muster = () => navigator.vibrate?.([400, 200, 400]);
    muster();
    vibration = window.setInterval(muster, periodeMs(folge));
  }
  if (!Ctor) {
    laufend = { stop: () => vibration !== null && window.clearInterval(vibration) };
    return;
  }
  let kontext: AudioContext;
  try {
    kontext = new Ctor();
  } catch {
    laufend = { stop: () => vibration !== null && window.clearInterval(vibration) };
    return;
  }
  void kontext.resume().catch(() => {});
  const lautstaerke = kontext.createGain();
  lautstaerke.gain.value = art === 'eingehend' ? 0.18 : 0.08;
  lautstaerke.connect(kontext.destination);
  let gestoppt = false;
  const periode = periodeMs(folge) / 1000;

  // Immer ein paar Perioden im Voraus planen; WebAudio taktet genau.
  let naechste = kontext.currentTime + 0.05;
  const planen = () => {
    if (gestoppt) return;
    while (naechste < kontext.currentTime + periode * 2) {
      let t = naechste;
      for (const ton of folge) {
        if (ton.hz > 0) {
          const osz = kontext.createOscillator();
          const huelle = kontext.createGain();
          osz.type = 'sine';
          osz.frequency.value = ton.hz;
          huelle.gain.setValueAtTime(0, t);
          huelle.gain.linearRampToValueAtTime(1, t + 0.01);
          huelle.gain.setValueAtTime(1, t + ton.ms / 1000 - 0.02);
          huelle.gain.linearRampToValueAtTime(0, t + ton.ms / 1000);
          osz.connect(huelle).connect(lautstaerke);
          osz.start(t);
          osz.stop(t + ton.ms / 1000);
        }
        t += ton.ms / 1000;
      }
      naechste += periode;
    }
  };
  planen();
  const takt = window.setInterval(planen, 500);
  laufend = {
    stop: () => {
      gestoppt = true;
      window.clearInterval(takt);
      if (vibration !== null) window.clearInterval(vibration);
      navigator.vibrate?.(0);
      void kontext.close().catch(() => {});
    },
  };
}

export function klingeltonAus(): void {
  laufend?.stop();
  laufend = null;
}
