import { realtime } from '../lib/realtime.js';

/**
 * Welcher Chat liegt gerade vor Augen?
 *
 * # Warum das zählt
 *
 * Der Server schickte bisher an jedes Mitglied einen Push, auch wenn es den
 * Chat in diesem Moment offen hatte. Er wusste es nicht. Jetzt meldet jede
 * Leitung den sichtbaren Chat (`chat.sichtbar`) und erneuert es alle paar
 * Sekunden; fällt die Meldung aus (iPhone friert die App ein), verfällt sie
 * serverseitig von selbst (`notify::CHAT_OFFEN_SEKUNDEN`).
 *
 * „Vor Augen" heisst: Der Chat ist offen UND das Dokument sichtbar. Die Zähler
 * der Chatliste stützen sich auf dieselbe Auskunft (`chat.ts`): Was in einem
 * Chat ankommt, den man vor Augen hat, ist nicht „neu".
 */

/** Wie oft die Meldung erneuert wird; der Server lässt sie 35 s gelten. */
export const SICHTBAR_ERNEUERN_MS = 15_000;

let offen: string | null = null;
let unten = true;
let letzteMeldung: string | null | undefined;
let timer: ReturnType<typeof setInterval> | null = null;
let beobachter: Array<() => void> = [];

function dokumentSichtbar(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

/** Der Chat, den man gerade ansieht – sonst `null`. */
export function chatVorAugen(): string | null {
  return offen !== null && dokumentSichtbar() ? offen : null;
}

/**
 * Ist `conversationId` offen, sichtbar und bis zum Ende gescrollt? Nur dann
 * ist eine neu eintreffende Nachricht schon gesehen.
 */
export function neuesSofortGesehen(conversationId: string): boolean {
  return unten && chatVorAugen() === conversationId;
}

/** Ruft `fn` bei jedem Wechsel von Chat, Sichtbarkeit oder Scrollstand. */
export function beiSichtbarkeitsaenderung(fn: () => void): () => void {
  beobachter.push(fn);
  return () => {
    beobachter = beobachter.filter((eintrag) => eintrag !== fn);
  };
}

function melden(erzwingen: boolean): void {
  const jetzt = chatVorAugen();
  if (!erzwingen && jetzt === letzteMeldung) return;
  // Nur als gesendet merken, was auch ankam: Ohne offene Leitung holt der
  // Wechsel auf „online" die Meldung nach.
  if (realtime.send({ type: 'chat.sichtbar', payload: { conversationId: jetzt } })) {
    letzteMeldung = jetzt;
  }
}

function geaendert(): void {
  melden(false);
  for (const fn of beobachter.slice()) fn();
}

/** Der Chatbildschirm sagt, welcher Chat offen ist (`null`: keiner). */
export function chatOffenSetzen(conversationId: string | null): void {
  if (offen === conversationId) return;
  offen = conversationId;
  unten = true;
  geaendert();
}

export function untenSetzen(istUnten: boolean): void {
  if (unten === istUnten) return;
  unten = istUnten;
  for (const fn of beobachter.slice()) fn();
}

let verdrahtet = false;
/** Einmal beim Start: Sichtbarkeit, Leitung und Erneuerung verdrahten. */
export function sichtbarkeitVerdrahten(): void {
  if (verdrahtet || typeof document === 'undefined') return;
  verdrahtet = true;
  document.addEventListener('visibilitychange', geaendert);
  // Beim Wegwischen der App feuert nicht immer `visibilitychange` rechtzeitig.
  window.addEventListener('pagehide', () => {
    if (realtime.send({ type: 'chat.sichtbar', payload: { conversationId: null } })) {
      letzteMeldung = null;
    }
  });
  window.addEventListener('pageshow', geaendert);
  realtime.onStateChange((zustand) => {
    // Neue Leitung: der Server kennt sie noch nicht.
    if (zustand === 'online') {
      letzteMeldung = undefined;
      melden(true);
    }
  });
  timer = setInterval(() => {
    if (chatVorAugen()) melden(true);
  }, SICHTBAR_ERNEUERN_MS);
}

/** Nur für Tests. */
export function sichtbarkeitZuruecksetzen(): void {
  offen = null;
  unten = true;
  letzteMeldung = undefined;
  beobachter = [];
  if (timer) clearInterval(timer);
  timer = null;
  verdrahtet = false;
}
