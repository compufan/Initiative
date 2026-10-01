import type { CalendarEventDto } from '@initiative/shared';
import { ApiError, api } from './api.js';
import { realtime } from './realtime.js';

/**
 * Der eine Trichter für alles, was sich an einem Termin ändert.
 *
 * Ein Termin steht an vielen Stellen zugleich: als Karte im Gruppenchat, als
 * Karte in jedem Einzelchat, im Kalender, auf der Detailseite. Jede Stelle
 * bekam ihre Fassung bisher für sich – aus dem Rundruf, aus einer eigenen
 * Antwort oder beim Laden des Chats. Dadurch blieb eine Karte in einem nicht
 * geöffneten Chat so alt, wie sie beim letzten Laden war, und zwei Rundrufe,
 * die einander überholten, ließen die ältere Fassung gewinnen.
 *
 * Hier läuft alles durch:
 *
 * - jeder Rundruf (`event.updated`, `event.deleted`),
 * - jede eigene REST-Antwort (Zusagen, Speichern, Einladen), damit die eigene
 *   Ansicht auch bei abgebrochener Verbindung stimmt,
 * - jeder Hinweis (`sync.hint` mit Termin-Kennung), den der Bus statt eines zu
 *   großen Rundrufs schickt.
 *
 * Der Trichter merkt sich je Termin den höchsten `stand` und verwirft Älteres.
 * Wer wissen will, was sich geändert hat, hängt sich mit `auf` an – die Stellen
 * im Chat-Speicher, im Kalender und auf der Detailseite tun das alle.
 *
 * Bewusst ohne Abhängigkeit von React und vom Chat-Speicher: Der Speicher hängt
 * sich an den Trichter, nicht umgekehrt.
 */

/** Warum ein Termin nicht mehr da ist – aus dem Rundruf `event.deleted`. */
export type EntferntGrund = 'geloescht' | 'ausgeladen';

export interface TerminHoerer {
  /** Eine neuere (oder gleich alte) Fassung ist da. */
  aktualisiert?: (event: CalendarEventDto) => void;
  /** Der Termin ist weg oder nicht mehr für mich sichtbar. */
  entfernt?: (eventId: string, grund: EntferntGrund | undefined) => void;
}

/**
 * Die Hörer, die gerade angehängt sind. Eine Menge, keine Liste: Dieselbe
 * Ansicht hängt sich bei einem erneuten Einhängen (Entwicklungsmodus,
 * Wiederverwendung) nicht zweimal an.
 */
const hoerer = new Set<TerminHoerer>();

/** Der höchste Stand, den wir je gesehen haben – je Termin. */
const staende = new Map<string, number>();

/**
 * Wann zuletzt eine Fassung eines Termins ankam – Grundlage dafür, einen
 * Hinweis zu überspringen, dessen Inhalt wir schon haben.
 */
const zuletztAm = new Map<string, number>();

/** Mehr Termine merkt sich der Trichter nicht; der älteste fliegt raus. */
const MERKEN_MAX = 2000;

/** Wie lange ein Hinweis höchstens wartet, bevor er nachlädt (Streuung). */
export const HINWEIS_STREUUNG_MS = 800;

function merken(event: CalendarEventDto): void {
  if (typeof event.stand === 'number') {
    staende.delete(event.id);
    staende.set(event.id, event.stand);
    if (staende.size > MERKEN_MAX) {
      const aeltester = staende.keys().next().value;
      if (aeltester !== undefined) staende.delete(aeltester);
    }
  }
  zuletztAm.set(event.id, Date.now());
  if (zuletztAm.size > MERKEN_MAX) {
    const aeltester = zuletztAm.keys().next().value;
    if (aeltester !== undefined) zuletztAm.delete(aeltester);
  }
}

/**
 * Welche von zwei Fassungen desselben Termins gilt.
 *
 * Der größere `stand` gewinnt; bei Gleichstand die zweite, weil sie später
 * angekommen ist. Ein Server ohne `stand` (älterer Stand) liefert keine Zahl –
 * dann gilt ebenfalls die zweite, wie vor dem Zähler.
 *
 * Antworten von Routen, die nur „melden“ (Sammlung verknüpfen, Notizen), können
 * einen Stand tragen, der um eins hinter dem folgenden Rundruf liegt: Darum
 * nie nach Ankunftsreihenfolge ersetzen, sondern immer hier entscheiden.
 */
export function neuer(a: CalendarEventDto, b: CalendarEventDto): CalendarEventDto {
  if (typeof a.stand === 'number' && typeof b.stand === 'number' && a.stand > b.stand) return a;
  return b;
}

/**
 * Eine Fassung ist angekommen – aus dem Rundruf, einer eigenen Antwort oder
 * einem Nachladen. Gibt an, ob sie angenommen wurde (`false`: älter als
 * bekannt und damit verworfen).
 */
export function aktualisiert(event: CalendarEventDto): boolean {
  const bekannt = staende.get(event.id);
  if (typeof event.stand === 'number' && bekannt !== undefined && event.stand < bekannt) {
    return false;
  }
  merken(event);
  for (const eintrag of [...hoerer]) {
    try {
      eintrag.aktualisiert?.(event);
    } catch (fehler) {
      console.error('termin hörer', fehler);
    }
  }
  return true;
}

/**
 * Der Termin ist weg (`geloescht`) oder nicht mehr für mich da (`ausgeladen`).
 * Ohne Grund – ein Nachladen, das mit 403 oder 404 endete – weiß man nur, dass
 * er nicht mehr erreichbar ist.
 */
export function entfernt(eventId: string, grund?: EntferntGrund): void {
  // Den Stand vergessen: Wer wieder eingeladen wird, bekommt einen höheren,
  // aber ein Zähler, der nach einem Löschen weiterverwahrt wird, könnte eine
  // spätere, legitime Fassung fälschlich verwerfen.
  staende.delete(eventId);
  zuletztAm.delete(eventId);
  for (const eintrag of [...hoerer]) {
    try {
      eintrag.entfernt?.(eventId, grund);
    } catch (fehler) {
      console.error('termin hörer', fehler);
    }
  }
}

/** Hängt einen Hörer an; der Rückgabewert hängt ihn wieder ab. */
export function auf(zuhoerer: TerminHoerer): () => void {
  hoerer.add(zuhoerer);
  return () => {
    hoerer.delete(zuhoerer);
  };
}

/** Der bekannte Stand eines Termins – für Tests und Anzeigen. */
export function standVon(eventId: string): number | undefined {
  return staende.get(eventId);
}

/* ---------- Hinweise: nachladen statt Rundruf ---------- */

/** Termine, deren Nachladen schon geplant ist – mehrfach gemeldet ist einmal geholt. */
const nachladend = new Set<string>();

/**
 * Der Bus schickt bei einer zu großen Nutzlast nur einen Hinweis mit der
 * Kennung des Termins. Wir holen den Termin dann selbst – aber erst nach einer
 * zufälligen Wartezeit, damit hundert Geräte, die denselben Hinweis bekommen,
 * nicht im selben Augenblick fragen.
 *
 * Kam inzwischen die volle Fassung an (lokale Verbindungen bekommen sie
 * zusätzlich zum Hinweis), ist das Nachladen überflüssig und unterbleibt.
 */
export function nachladen(eventId: string): void {
  if (nachladend.has(eventId)) return;
  nachladend.add(eventId);
  const gemeldetAm = Date.now();
  setTimeout(() => {
    const hatSchon = (zuletztAm.get(eventId) ?? 0) >= gemeldetAm;
    if (hatSchon) {
      nachladend.delete(eventId);
      return;
    }
    api.calendar
      .byId(eventId)
      .then((termin) => {
        aktualisiert(termin);
      })
      .catch((fehler: unknown) => {
        // Kein Zugriff oder gelöscht: wie `event.deleted`. Offline bleibt
        // alles, wie es ist – der nächste Hinweis versucht es erneut.
        if (fehler instanceof ApiError && (fehler.status === 403 || fehler.status === 404)) {
          entfernt(eventId);
        }
      })
      .finally(() => {
        nachladend.delete(eventId);
      });
  }, Math.random() * HINWEIS_STREUUNG_MS);
}

/* ---------- Verdrahtung ---------- */

let verbunden = false;

/** Hängt den Trichter einmal an den Rundruf – wie `connectChatRealtime`. */
export function connectTerminEreignisse(): void {
  if (verbunden) return;
  verbunden = true;
  realtime.on('event.updated', ({ event }) => {
    aktualisiert(event);
  });
  realtime.on('event.deleted', ({ eventId, grund }) => {
    entfernt(eventId, grund);
  });
  realtime.on('sync.hint', ({ eventId }) => {
    if (eventId) nachladen(eventId);
  });
}

/** Nur für Tests: den Zustand des Trichters zurücksetzen. */
export function zuruecksetzen(): void {
  hoerer.clear();
  staende.clear();
  zuletztAm.clear();
  nachladend.clear();
  verbunden = false;
}
