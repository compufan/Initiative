import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DT_MS,
  ergebnisVon,
  neuerZustand,
  simBis,
  type Eingabe,
  type LaufErgebnis,
  type SimZustand,
  type Taste,
} from '@initiative/shared';

export type LaufPhase = 'bereit' | 'zaehlt' | 'laeuft' | 'fertig';

/** Sekunden Anlauf, bevor es losgeht – so lange sind die Tasten noch tot. */
export const ANLAUF_SEKUNDEN = 3;
const ANLAUF_SCHRITT_MS = 700;

export interface PressenLauf {
  phase: LaufPhase;
  /** Verbleibende Anlauf-Sekunden (3, 2, 1) oder 0. */
  zaehler: number;
  zustand: SimZustand;
  ergebnis: LaufErgebnis | null;
  /** Verzögerung (ms), mit der dieser Lauf gestartet wurde. */
  verzoegerungMs: number;
  starten: (verzoegerungMs: number) => void;
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
 * stempelt nur Tasten mit der Zeit seit „Los“ und lässt die Simulation je
 * Bild bis zur jetzigen Zeit nachrechnen – dieselben Ereignisse ergäben auf
 * jedem anderen Gerät dasselbe Ergebnis.
 *
 * WARUM der Stempel hinter dem letzten gerechneten Schritt liegt: Die
 * Simulation wendet ein Ereignis erst an, wenn ihre Zeit es erreicht; ein
 * Stempel in einem schon gerechneten Schritt ginge verloren.
 */
export function usePressenLauf(onFertig: (ergebnis: LaufErgebnis) => void): PressenLauf {
  const [phase, setPhase] = useState<LaufPhase>('bereit');
  const [zaehler, setZaehler] = useState(0);
  const [zustand, setZustand] = useState<SimZustand>(neuerZustand);
  const [ergebnis, setErgebnis] = useState<LaufErgebnis | null>(null);
  const [verzoegerungMs, setVerzoegerungMs] = useState(0);

  const eingaben = useRef<Eingabe[]>([]);
  const z = useRef<SimZustand>(zustand);
  const start = useRef(0);
  const verz = useRef(0);
  const unten = useRef<Record<Taste, boolean>>({ links: false, rechts: false, neigen: false });
  const laeuft = useRef(false);
  const melden = useRef(onFertig);
  melden.current = onFertig;
  const timer = useRef<number | null>(null);
  const bild = useRef<number | null>(null);

  const stoppen = useCallback(() => {
    laeuft.current = false;
    if (timer.current != null) window.clearTimeout(timer.current);
    if (bild.current != null) cancelAnimationFrame(bild.current);
    timer.current = null;
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
    const neu = simBis(z.current, eingaben.current, verz.current, ziel);
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

  const losGehts = useCallback(() => {
    start.current = performance.now();
    laeuft.current = true;
    setZaehler(0);
    setPhase('laeuft');
    bild.current = requestAnimationFrame(bildSchritt);
  }, [bildSchritt]);

  const zuruecksetzen = useCallback(() => {
    stoppen();
    eingaben.current = [];
    unten.current = { links: false, rechts: false, neigen: false };
    z.current = neuerZustand();
    setZustand(z.current);
    setErgebnis(null);
    setZaehler(0);
    setPhase('bereit');
  }, [stoppen]);

  const starten = useCallback(
    (verzoegerungMs: number) => {
      zuruecksetzen();
      verz.current = verzoegerungMs;
      setVerzoegerungMs(verzoegerungMs);
      setPhase('zaehlt');
      const runter = (rest: number) => {
        setZaehler(rest);
        if (rest === 0) {
          losGehts();
          return;
        }
        timer.current = window.setTimeout(() => runter(rest - 1), ANLAUF_SCHRITT_MS);
      };
      runter(ANLAUF_SEKUNDEN);
    },
    [losGehts, zuruecksetzen],
  );

  // Verliert die Seite den Blick (anderer Tab, Anruf), lassen alle Tasten los –
  // sonst liefe das Glas mit einer Taste weiter, deren Loslassen nie ankommt.
  useEffect(() => {
    const alleLos = () => {
      for (const t of ['links', 'rechts', 'neigen'] as Taste[]) setzeTaste(t, false);
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
    zaehler,
    zustand,
    ergebnis,
    verzoegerungMs,
    starten,
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
