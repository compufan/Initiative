import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { dialogAnmelden } from '../../../lib/dialogVerlauf.js';

/**
 * Vollbild für Pressen.
 *
 * Zwei Wege, ein Ergebnis – das Brett füllt die ganze Anzeige:
 *
 *  1. **Fullscreen-API** (`requestFullscreen`, bei älterem Safari mit
 *     `webkit`-Vorsatz): echtes Vollbild, ohne Adressleiste.
 *  2. **Überlagerung**: ein festes Element über der ganzen App
 *     (`100dvh`, Ränder für Kerbe und Home-Balken). Das ist der Weg für das
 *     iPhone (Safari kennt die API dort nur für Videos) – und der Rückfall,
 *     wenn der Browser das Vollbild verweigert.
 *
 * Die API verlangt eine Nutzergeste. Deshalb wird `betreten` NUR aus einem
 * Klick auf „Anstoßen“ oder auf „Vollbild“ gerufen, und zwar synchron – nach
 * einem `await` wäre die Geste verbraucht. Scheitert die Anfrage, bleibt die
 * Überlagerung stehen und das Spiel läuft wie gewohnt weiter.
 *
 * # Wer beendet es?
 *
 * Der Knopf „Vollbild beenden“, Esc und die Zurück-Taste. Esc meldet sich dazu
 * beim zentralen Dialogstapel an (`dialogVerlauf`), der es bereits so für Blätter
 * macht – und es als vergeben markiert (`defaultPrevented`). Das Brett lässt
 * sein eigenes Esc („vorzeitig abstellen“) deshalb sein, solange das Vollbild
 * offen ist: Ein Esc, das nur das Vollbild schließt, darf keinen Lauf abbrechen.
 * (Im echten Browser-Vollbild bekommt die Seite Esc ohnehin nicht zu sehen; dort
 * schließt der Browser selbst und meldet es über `fullscreenchange`.)
 * Beim Verlassen der Seite wird das Vollbild zuverlässig beendet.
 */

/** Die Teile der Fullscreen-API, die wir brauchen – mit und ohne Vorsatz. */
export interface VollbildElement {
  requestFullscreen?: (optionen?: { navigationUI?: 'hide' }) => Promise<void> | void;
  webkitRequestFullscreen?: () => Promise<void> | void;
}

export interface VollbildDokument {
  fullscreenElement?: Element | null;
  webkitFullscreenElement?: Element | null;
  exitFullscreen?: () => Promise<void> | void;
  webkitExitFullscreen?: () => Promise<void> | void;
}

/** Das Element, das gerade im echten Vollbild ist – gleich ob mit oder ohne Vorsatz. */
export function nativesVollbild(doc: VollbildDokument): Element | null {
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

/** Kann dieses Element die Fullscreen-API nutzen? (iPhone-Safari: nein.) */
export function kannNativ(el: VollbildElement | null | undefined): boolean {
  return Boolean(el && (el.requestFullscreen || el.webkitRequestFullscreen));
}

/**
 * Fragt das echte Vollbild an. Gibt `true` zurück, wenn die Anfrage gestellt
 * werden konnte und der Browser sie (bisher) nicht abgelehnt hat; `false`, wo
 * es die API nicht gibt oder sie sofort scheitert. Eine spätere Ablehnung
 * (Promise) meldet `beiAblehnung`.
 *
 * Wirft nie: Ein Fehler hier darf das Spiel nicht aufhalten.
 */
export function nativAnfordern(el: VollbildElement, beiAblehnung: () => void): boolean {
  if (!kannNativ(el)) return false;
  try {
    const ergebnis = el.requestFullscreen
      ? el.requestFullscreen({ navigationUI: 'hide' })
      : el.webkitRequestFullscreen?.();
    if (ergebnis && typeof (ergebnis as Promise<void>).then === 'function') {
      (ergebnis as Promise<void>).then(undefined, beiAblehnung);
    }
    return true;
  } catch {
    return false;
  }
}

/** Beendet das echte Vollbild, falls `el` darin ist. Wirft nie. */
export function nativBeenden(doc: VollbildDokument, el: Element | null): void {
  try {
    if (!el || nativesVollbild(doc) !== el) return;
    const ergebnis = doc.exitFullscreen ? doc.exitFullscreen() : doc.webkitExitFullscreen?.();
    if (ergebnis && typeof (ergebnis as Promise<void>).then === 'function') {
      (ergebnis as Promise<void>).then(undefined, () => undefined);
    }
  } catch {
    /* Ohne Vollbild gibt es auch nichts zu beenden. */
  }
}

/* ---------- Merker: hat jemand das Vollbild ausdrücklich abgewählt? ---------- */

const MERKER = 'pressen.vollbild';

/**
 * Soll „Anstoßen“ von selbst ins Vollbild gehen? Ja – bis jemand es mit
 * „Vollbild beenden“ ausdrücklich wegschickt; „Vollbild“ stellt es wieder an.
 */
export function vollbildGewuenscht(speicher: Pick<Storage, 'getItem'> | null): boolean {
  try {
    return speicher?.getItem(MERKER) !== 'aus';
  } catch {
    return true;
  }
}

function merken(wunsch: boolean) {
  try {
    window.localStorage.setItem(MERKER, wunsch ? 'an' : 'aus');
  } catch {
    /* Ohne Speicher gilt die Voreinstellung eben jedes Mal. */
  }
}

export function vollbildWunschLesen(): boolean {
  try {
    return vollbildGewuenscht(window.localStorage);
  } catch {
    return true;
  }
}

export interface PressenVollbild {
  /** Füllt das Brett gerade die ganze Anzeige (echtes Vollbild ODER Überlagerung)? */
  aktiv: boolean;
  /** Echtes Vollbild der Fullscreen-API (sonst: Überlagerung). */
  nativ: boolean;
  /**
   * Geht ins Vollbild. NUR aus einer Nutzergeste rufen, und zwar direkt – nicht
   * nach einem `await`. `ausdruecklich`: die Person hat den Knopf „Vollbild“ gewählt.
   */
  betreten: (ausdruecklich?: boolean) => void;
  /** Verlässt das Vollbild. `ausdruecklich`: die Person hat „Vollbild beenden“ gewählt. */
  beenden: (ausdruecklich?: boolean) => void;
}

/** Das Vollbild für das Element hinter `ziel`. */
export function usePressenVollbild(ziel: RefObject<HTMLElement | null>): PressenVollbild {
  const [aktiv, setAktiv] = useState(false);
  const [nativ, setNativ] = useState(false);
  const aktivRef = useRef(false);
  const nativRef = useRef(false);

  const setze = useCallback((a: boolean, n: boolean) => {
    aktivRef.current = a;
    nativRef.current = n;
    setAktiv(a);
    setNativ(n);
  }, []);

  const querformat = useCallback((an: boolean) => {
    // Querformat ist für das Brett die bessere Haltung; wo der Browser es nicht
    // zulässt (nur im echten Vollbild, nur auf Handys), bleibt es beim Wunsch.
    try {
      const ausrichtung = window.screen?.orientation as
        (ScreenOrientation & { lock?: (art: string) => Promise<void> }) | undefined;
      if (an) void ausrichtung?.lock?.('landscape')?.catch?.(() => undefined);
      else ausrichtung?.unlock?.();
    } catch {
      /* Nur ein Wunsch. */
    }
  }, []);

  const beenden = useCallback(
    (ausdruecklich = false) => {
      if (ausdruecklich) merken(false);
      nativBeenden(document as VollbildDokument, ziel.current);
      querformat(false);
      setze(false, false);
    },
    [setze, querformat, ziel],
  );

  const betreten = useCallback(
    (ausdruecklich = false) => {
      if (ausdruecklich) merken(true);
      const el = ziel.current;
      if (!el || aktivRef.current) return;
      // Sofort bildschirmfüllend darstellen: Die Überlagerung trägt, bis das
      // echte Vollbild bestätigt ist – oder für immer, wo es keines gibt.
      setze(true, false);
      if (kannNativ(el as VollbildElement)) {
        nativAnfordern(el as VollbildElement, () => undefined);
      }
    },
    [setze, ziel],
  );

  // Das echte Vollbild meldet sich über Ereignisse: Bestätigung und – wichtiger –
  // das Ende durch Esc oder Browser-Bedienung, das wir sonst nicht bemerkten.
  useEffect(() => {
    const geaendert = () => {
      const el = ziel.current;
      const drin = Boolean(el && nativesVollbild(document as VollbildDokument) === el);
      if (drin) {
        setze(true, true);
        querformat(true);
      } else if (nativRef.current) {
        // Esc oder die Bedienung des Browsers: ausdrücklich beendet.
        merken(false);
        querformat(false);
        setze(false, false);
      }
    };
    document.addEventListener('fullscreenchange', geaendert);
    document.addEventListener('webkitfullscreenchange', geaendert);
    return () => {
      document.removeEventListener('fullscreenchange', geaendert);
      document.removeEventListener('webkitfullscreenchange', geaendert);
    };
  }, [setze, querformat, ziel]);

  // Offen = oberster „Dialog“: Zurück-Taste und Esc schließen zuerst das Vollbild.
  useEffect(() => {
    if (!aktiv) return undefined;
    return dialogAnmelden(() => beenden(true));
  }, [aktiv, beenden]);

  // Verlässt jemand die Seite, darf das Vollbild nicht hängen bleiben.
  useEffect(() => {
    const el = ziel.current;
    return () => {
      nativBeenden(document as VollbildDokument, el);
      if (nativRef.current) {
        try {
          window.screen?.orientation?.unlock?.();
        } catch {
          /* siehe oben */
        }
      }
    };
  }, [ziel]);

  return { aktiv, nativ, betreten, beenden };
}
