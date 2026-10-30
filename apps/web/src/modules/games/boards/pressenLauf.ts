import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DT_MS,
  TASTEN,
  ergebnisVon,
  neuerZustand,
  simBis,
  type Eingabe,
  type LaufErgebnis,
  type SimZustand,
  type Taste,
} from '@initiative/shared';

export type LaufPhase = 'bereit' | 'laeuft' | 'fertig';

export interface PressenLauf {
  phase: LaufPhase;
  zustand: SimZustand;
  ergebnis: LaufErgebnis | null;
  /** Verzögerung (ms), mit der dieser Lauf gestartet wurde. */
  verzoegerungMs: number;
  /** „Anstoßen“: der Lauf beginnt SOFORT – kein Anlauf, kein Zwischenschritt. */
  anstossen: (verzoegerungMs: number, driftSeed: number) => void;
  zuruecksetzen: () => void;
  druecken: (taste: Taste) => void;
  loslassen: (taste: Taste) => void;
  abstellen: () => void;
  vorzeitigAbstellen: () => void;
}

/**
 * Der eigene Lauf, live.
 *
 * Die Physik steckt komplett in `simBis` (gemeinsames Paket). Dieser Haken
 * stempelt nur Tasten mit der Zeit seit „Anstoßen“ und lässt die Simulation je
 * Bild bis zur jetzigen Zeit nachrechnen – dieselben Ereignisse ergäben auf
 * jedem anderen Gerät dasselbe Ergebnis.
 *
 * WARUM der Stempel hinter dem letzten gerechneten Schritt liegt: Die
 * Simulation wendet ein Ereignis erst an, wenn ihre Zeit es erreicht; ein
 * Stempel in einem schon gerechneten Schritt ginge verloren.
 *
 * Das Warten VOR „Anstoßen“ (bei gemeinsamem Start) misst nicht dieser Haken,
 * sondern das Brett: Es rechnet die Differenz zum gemeinsamen Beginn in die
 * Dauer ein.
 */
export function usePressenLauf(onFertig: (ergebnis: LaufErgebnis) => void): PressenLauf {
  const [phase, setPhase] = useState<LaufPhase>('bereit');
  const [zustand, setZustand] = useState<SimZustand>(neuerZustand);
  const [ergebnis, setErgebnis] = useState<LaufErgebnis | null>(null);
  const [verzoegerungMs, setVerzoegerungMs] = useState(0);

  const eingaben = useRef<Eingabe[]>([]);
  const z = useRef<SimZustand>(zustand);
  const start = useRef(0);
  const verz = useRef(0);
  const drift = useRef(0);
  const unten = useRef<Record<Taste, boolean>>(keineTasten());
  const laeuft = useRef(false);
  const melden = useRef(onFertig);
  melden.current = onFertig;
  const bild = useRef<number | null>(null);

  const stoppen = useCallback(() => {
    laeuft.current = false;
    if (bild.current != null) cancelAnimationFrame(bild.current);
    bild.current = null;
  }, []);

  useEffect(() => stoppen, [stoppen]);

  const stempel = () => Math.max(performance.now() - start.current, z.current.tick * DT_MS + 1);

  const setzeTaste = useCallback((taste: Taste, runter: boolean) => {
    if (!laeuft.current || unten.current[taste] === runter) return;
    unten.current[taste] = runter;
    eingaben.current.push({ t: stempel(), was: taste, unten: runter });
  }, []);

  const bildSchritt = useCallback(() => {
    if (!laeuft.current) return;
    const ziel = Math.floor((performance.now() - start.current) / DT_MS);
    const neu = simBis(z.current, eingaben.current, verz.current, ziel, drift.current);
    if (neu.tick !== z.current.tick) {
      z.current = neu;
      setZustand(neu);
    }
    if (neu.fertig) {
      const ende = ergebnisVon(neu);
      stoppen();
      setPhase('fertig');
      if (ende) {
        setErgebnis(ende);
        melden.current(ende);
      }
      return;
    }
    bild.current = requestAnimationFrame(bildSchritt);
  }, [stoppen]);

  const zuruecksetzen = useCallback(() => {
    stoppen();
    eingaben.current = [];
    unten.current = keineTasten();
    z.current = neuerZustand();
    setZustand(z.current);
    setErgebnis(null);
    setPhase('bereit');
  }, [stoppen]);

  const anstossen = useCallback(
    (verzoegerungMs: number, driftSeed: number) => {
      zuruecksetzen();
      verz.current = verzoegerungMs;
      drift.current = driftSeed;
      setVerzoegerungMs(verzoegerungMs);
      start.current = performance.now();
      laeuft.current = true;
      setPhase('laeuft');
      bild.current = requestAnimationFrame(bildSchritt);
    },
    [bildSchritt, zuruecksetzen],
  );

  // Verliert die Seite den Blick (anderer Tab, Anruf), lassen alle Tasten los –
  // sonst liefe das Glas mit einer Taste weiter, deren Loslassen nie ankommt.
  useEffect(() => {
    const alleLos = () => {
      for (const t of TASTEN) setzeTaste(t, false);
    };
    window.addEventListener('blur', alleLos);
    document.addEventListener('visibilitychange', alleLos);
    return () => {
      window.removeEventListener('blur', alleLos);
      document.removeEventListener('visibilitychange', alleLos);
    };
  }, [setzeTaste]);

  return {
    phase,
    zustand,
    ergebnis,
    verzoegerungMs,
    anstossen,
    zuruecksetzen,
    druecken: (t) => setzeTaste(t, true),
    loslassen: (t) => setzeTaste(t, false),
    abstellen: () => {
      if (laeuft.current && z.current.leerTick != null) {
        eingaben.current.push({ t: stempel(), was: 'abstellen' });
      }
    },
    vorzeitigAbstellen: () => {
      if (laeuft.current) eingaben.current.push({ t: stempel(), was: 'vorzeitig' });
    },
  };
}

function keineTasten(): Record<Taste, boolean> {
  return { links: false, rechts: false, hoch: false, runter: false, neigen: false };
}

/* ---------- Auszeichnung "getrümmert" ---------- */

const AUSZEICHNUNG_KEY = 'pressen.getruemmert';

/** Wie oft "getrümmert" auf diesem Gerät schon erreicht wurde. */
export function getruemmertZaehler(): number {
  try {
    const n = Number(window.localStorage.getItem(AUSZEICHNUNG_KEY));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

/** Merkt die Auszeichnung; gibt die neue Anzahl zurück. */
export function getruemmertMerken(): number {
  const neu = getruemmertZaehler() + 1;
  try {
    window.localStorage.setItem(AUSZEICHNUNG_KEY, String(neu));
  } catch {
    /* Ohne Speicher gibt es die Auszeichnung trotzdem – nur eben ohne Zähler. */
  }
  return neu;
}
