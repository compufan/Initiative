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
  /**
   * Die Verbindung kam nach einer Lücke zurück (oder die App war lange im
   * Hintergrund): Was der Hörer zeigt, kann veraltet sein, denn Rundrufe in der
   * Lücke sind verloren. Er holt nach, was er zeigt – mit `auffrischen`.
   */
  nachholen?: () => void;
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

/**
 * Termine, die eben gelöscht oder unsichtbar wurden – mit dem Stand, den wir
 * zuletzt kannten, und dem Zeitpunkt. Ohne diese Grabsteine belebte eine späte
 * Antwort (eine Abfrage, die vor dem Löschen losging, auf Mobilfunk drei
 * Sekunden braucht) einen gelöschten Termin wieder: Der Trichter hatte seinen
 * Stand vergessen und ließ jede Fassung durch.
 */
const grabsteine = new Map<string, { stand: number | undefined; am: number }>();

/** Wie lange ein Grabstein steht – länger braucht keine Antwort unterwegs zu sein. */
export const GRABSTEIN_MS = 60_000;

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
 * Gilt ein Termin als entfernt, so dass diese Fassung ihn nicht wieder
 * beleben darf?
 *
 * `angefordertAm`: Der Zeitpunkt, zu dem die Anfrage losging, deren Antwort das
 * hier ist. Eine Antwort auf eine Anfrage, die vor dem Entfernen lief, zeigt den
 * Termin, wie er davor war – egal, welchen Stand sie trägt. Ein Rundruf dagegen
 * (ohne Zeitpunkt) wird nur verworfen, wenn sein Stand nicht höher ist als der
 * zuletzt bekannte: Wer wieder eingeladen wird, bekommt einen höheren.
 */
export function entferntVerwirft(event: CalendarEventDto, angefordertAm?: number): boolean {
  const stein = grabsteine.get(event.id);
  if (!stein) return false;
  if (Date.now() - stein.am > GRABSTEIN_MS) {
    grabsteine.delete(event.id);
    return false;
  }
  if (angefordertAm !== undefined) return angefordertAm <= stein.am;
  if (typeof event.stand === 'number' && stein.stand !== undefined) {
    return event.stand <= stein.stand;
  }
  return false;
}

/**
 * Eine Fassung ist angekommen – aus dem Rundruf, einer eigenen Antwort oder
 * einem Nachladen. Gibt an, ob sie angenommen wurde (`false`: älter als
 * bekannt oder von einem entfernten Termin und damit verworfen).
 */
export function aktualisiert(
  event: CalendarEventDto,
  optionen?: { angefordertAm?: number },
): boolean {
  const bekannt = staende.get(event.id);
  if (typeof event.stand === 'number' && bekannt !== undefined && event.stand < bekannt) {
    return false;
  }
  if (entferntVerwirft(event, optionen?.angefordertAm)) return false;
  grabsteine.delete(event.id);
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
  // Der Stand wandert in einen Grabstein: Wer wieder eingeladen wird, bekommt
  // einen höheren und wird angenommen, eine späte Antwort von davor nicht.
  grabsteine.delete(eventId);
  grabsteine.set(eventId, { stand: staende.get(eventId), am: Date.now() });
  if (grabsteine.size > MERKEN_MAX) {
    const aeltester = grabsteine.keys().next().value;
    if (aeltester !== undefined) grabsteine.delete(aeltester);
  }
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

/* ---------- Nachladen: Hinweise, Lücken, Zwischenspeicher ---------- */

/** Termine, deren Abruf geplant oder unterwegs ist – mehrfach gewünscht ist einmal geholt. */
const nachladend = new Set<string>();

/** Wie viele Termine höchstens gleichzeitig abgerufen werden. */
const ABRUFE_GLEICHZEITIG = 4;

/** Termine, deren Abruf wartet, bis ein Platz frei ist. */
const wartend: string[] = [];
let laufend = 0;

/** Ein Abruf: Die Antwort geht durch den Trichter, ein 403/404 heißt „weg“. */
async function holen(eventId: string): Promise<void> {
  const angefordertAm = Date.now();
  try {
    const termin = await api.calendar.byId(eventId);
    aktualisiert(termin, { angefordertAm });
  } catch (fehler: unknown) {
    // Kein Zugriff oder gelöscht: wie `event.deleted`. Offline bleibt alles,
    // wie es ist – der nächste Anlass versucht es erneut.
    if (fehler instanceof ApiError && (fehler.status === 403 || fehler.status === 404)) {
      entfernt(eventId);
    }
  }
}

function abrufeStarten(): void {
  while (laufend < ABRUFE_GLEICHZEITIG && wartend.length > 0) {
    const eventId = wartend.shift()!;
    laufend += 1;
    void holen(eventId).finally(() => {
      laufend -= 1;
      nachladend.delete(eventId);
      abrufeStarten();
    });
  }
}

/**
 * Holt Termine nach, deren angezeigte Fassung veraltet sein kann: nach einer
 * Lücke der Verbindung, oder weil sie aus dem Zwischenspeicher stammt.
 *
 * Jeder Termin höchstens einmal zugleich, höchstens vier Abrufe gleichzeitig
 * und über eine zufällige Wartezeit gestreut – nach einer Lücke wollen alle
 * Geräte auf einmal, und eine Karte je Termin ist schnell ein Dutzend Abrufe.
 */
export function auffrischen(eventIds: Iterable<string>): void {
  for (const eventId of eventIds) {
    if (nachladend.has(eventId)) continue;
    nachladend.add(eventId);
    setTimeout(() => {
      wartend.push(eventId);
      abrufeStarten();
    }, Math.random() * HINWEIS_STREUUNG_MS);
  }
}

/** Termine, deren Zwischenspeicher-Fassung in dieser Sitzung schon geprüft wurde. */
const geprueft = new Set<string>();

/**
 * Eine Karte aus dem Zwischenspeicher zeigt den Stand vom letzten Öffnen. Nur
 * die erste Seite eines Chats kommt frisch vom Server – Karten dahinter bleiben
 * sonst für immer veraltet (Zusagen, Absage, neue Zeit, ausgeladen). Hier wird
 * jeder Termin einmal je Sitzung nachgeprüft.
 */
export function einmalPruefen(eventIds: Iterable<string>): void {
  const neu: string[] = [];
  for (const eventId of eventIds) {
    if (geprueft.has(eventId)) continue;
    geprueft.add(eventId);
    neu.push(eventId);
  }
  if (neu.length > 0) auffrischen(neu);
}

/**
 * Der Bus schickt bei einer zu großen Nutzlast nur einen Hinweis mit der
 * Kennung des Termins. Wir holen den Termin dann selbst – aber erst nach einer
 * zufälligen Wartezeit, damit hundert Geräte, die denselben Hinweis bekommen,
 * nicht im selben Augenblick fragen.
 *
 * Kennen wir den Stand, den der Hinweis meldet, schon (die volle Fassung geht an
 * Geräte am selben Server **vor** dem Hinweis hinaus), ist das Nachladen
 * überflüssig und unterbleibt. Ohne Stand im Hinweis (älterer Server) zählt, ob
 * seit dem Hinweis eine Fassung angekommen ist.
 */
export function nachladen(eventId: string, stand?: number): void {
  if (nachladend.has(eventId)) return;
  const gemeldetAm = Date.now();
  const schonDa = () =>
    typeof stand === 'number'
      ? (staende.get(eventId) ?? -1) >= stand
      : (zuletztAm.get(eventId) ?? 0) >= gemeldetAm;
  if (schonDa()) return;
  nachladend.add(eventId);
  setTimeout(() => {
    // Ist die Fassung in der Wartezeit angekommen, genügt sie.
    if (schonDa()) {
      nachladend.delete(eventId);
      return;
    }
    wartend.push(eventId);
    abrufeStarten();
  }, Math.random() * HINWEIS_STREUUNG_MS);
}

/* ---------- Verdrahtung ---------- */

let verbunden = false;

/** Wann zuletzt nachgeholt wurde – mehrere Anlässe kurz hintereinander zählen einmal. */
let zuletztNachgeholt = 0;
const NACHHOLEN_ABSTAND_MS = 3000;

/** Wie lange die App im Hintergrund gewesen sein muss, damit sie beim Zurückkehren nachholt. */
export const HINTERGRUND_MS = 20_000;

/**
 * Sagt allen Hörern, dass sie nachholen sollen, was sie zeigen: Rundrufe, die in
 * einer Lücke der Verbindung verschickt wurden, kommen nie wieder.
 */
export function nachholen(): void {
  const jetzt = Date.now();
  if (jetzt - zuletztNachgeholt < NACHHOLEN_ABSTAND_MS) return;
  zuletztNachgeholt = jetzt;
  for (const eintrag of [...hoerer]) {
    try {
      eintrag.nachholen?.();
    } catch (fehler) {
      console.error('termin hörer', fehler);
    }
  }
}

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
  realtime.on('sync.hint', ({ eventId, stand }) => {
    if (eventId) nachladen(eventId, stand);
  });

  // Reißt die Leitung ab (Bildschirm aus, Tunnel, Funkloch), gehen die Rundrufe
  // dazwischen verloren. Beim Wiederverbinden wird nachgeholt – sonst zeigt eine
  // Karte so lange den alten Stand, bis man die Seite neu lädt.
  let warWeg = false;
  realtime.onStateChange((zustand) => {
    if (zustand === 'offline') warWeg = true;
    else if (zustand === 'online' && warWeg) {
      warWeg = false;
      nachholen();
    }
  });

  // Auch ohne erkannten Abbruch: Ein im Hintergrund eingefrorener Socket steht
  // formal auf OPEN und empfängt nichts. Kehrt die App nach einer Weile zurück,
  // wird nachgeholt.
  if (typeof document !== 'undefined') {
    let versteckt = 0;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') versteckt = Date.now();
      else if (versteckt > 0 && Date.now() - versteckt > HINTERGRUND_MS) {
        versteckt = 0;
        nachholen();
      }
    });
  }
}

/** Nur für Tests: den Zustand des Trichters zurücksetzen. */
export function zuruecksetzen(): void {
  hoerer.clear();
  staende.clear();
  zuletztAm.clear();
  grabsteine.clear();
  nachladend.clear();
  wartend.length = 0;
  laufend = 0;
  geprueft.clear();
  zuletztNachgeholt = 0;
  verbunden = false;
}
