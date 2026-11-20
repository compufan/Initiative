/**
 * Die Chatliste als reine Rechnung: filtern, sortieren, Abzeichen, Wischen,
 * Stummschalt-Vorgaben. Ohne React, damit sie sich ohne Browser prüfen lässt
 * (`chatliste.test.ts`).
 */
import { ANGEHEFTET_MAX, type ChatOrdnerDto, type ConversationDto } from '@initiative/shared';

export type ListenFilter =
  { art: 'alle' | 'ungelesen' | 'gruppen' | 'direkt' | 'archiv' } | { art: 'ordner'; id: string };

export const FESTE_FILTER: {
  art: 'alle' | 'ungelesen' | 'gruppen' | 'direkt' | 'archiv';
  label: string;
}[] = [
  { art: 'alle', label: 'Alle' },
  { art: 'ungelesen', label: 'Ungelesen' },
  { art: 'gruppen', label: 'Gruppen' },
  { art: 'direkt', label: 'Direkt' },
  { art: 'archiv', label: 'Archiv' },
];

/** Ungelesen ist, was neue Nachrichten hat – oder ausdrücklich so markiert ist. */
export function istUngelesen(chat: ConversationDto): boolean {
  return chat.unreadCount > 0 || chat.markedUnread === true;
}

export function letzteAktivitaet(chat: ConversationDto): number {
  const stempel = chat.lastMessage?.createdAt ?? chat.updatedAt;
  const zeit = new Date(stempel).getTime();
  return Number.isNaN(zeit) ? 0 : zeit;
}

function angeheftetZeit(chat: ConversationDto): number | null {
  if (!chat.pinnedAt) return null;
  const zeit = new Date(chat.pinnedAt).getTime();
  return Number.isNaN(zeit) ? null : zeit;
}

/**
 * Angeheftete oben – der zuletzt angeheftete (bzw. beim Umordnen nach oben
 * geschobene) zuerst –, darunter nach letzter Aktivität. Im Archiv gibt es
 * keine Nadeln (Archivieren löst sie im Server).
 */
export function sortieren(chats: ConversationDto[]): ConversationDto[] {
  return chats.slice().sort((a, b) => {
    const pa = angeheftetZeit(a);
    const pb = angeheftetZeit(b);
    if (pa != null && pb != null) return pb - pa;
    if (pa != null) return -1;
    if (pb != null) return 1;
    return letzteAktivitaet(b) - letzteAktivitaet(a);
  });
}

/** Was ein Filter zeigt. Ein Ordner zeigt nur Chats, die es (noch) gibt. */
export function filtern(
  chats: ConversationDto[],
  filter: ListenFilter,
  ordner: ChatOrdnerDto[] = [],
): ConversationDto[] {
  if (filter.art === 'archiv') return chats.filter((chat) => chat.archived);
  const offen = chats.filter((chat) => !chat.archived);
  switch (filter.art) {
    case 'ungelesen':
      return offen.filter(istUngelesen);
    case 'gruppen':
      return offen.filter((chat) => chat.type === 'group');
    case 'direkt':
      return offen.filter((chat) => chat.type === 'direct');
    case 'ordner': {
      const drin = new Set(ordner.find((eintrag) => eintrag.id === filter.id)?.chats ?? []);
      return offen.filter((chat) => drin.has(chat.id));
    }
    default:
      return offen;
  }
}

export function filterSchluessel(filter: ListenFilter): string {
  return filter.art === 'ordner' ? `ordner:${filter.id}` : filter.art;
}

export function filterAusSchluessel(schluessel: string | null): ListenFilter {
  if (schluessel?.startsWith('ordner:')) return { art: 'ordner', id: schluessel.slice(7) };
  const fest = FESTE_FILTER.find((eintrag) => eintrag.art === schluessel);
  return fest ? { art: fest.art } : { art: 'alle' };
}

export type Abzeichen = { art: 'zahl'; text: string } | { art: 'punkt' } | null;

/** Zahl der Ungelesenen, sonst ein Punkt für „als ungelesen markiert“. */
export function abzeichen(chat: ConversationDto): Abzeichen {
  if (chat.unreadCount > 0) {
    return { art: 'zahl', text: chat.unreadCount > 99 ? '99+' : String(chat.unreadCount) };
  }
  return chat.markedUnread ? { art: 'punkt' } : null;
}

/** Das Abzeichen am Reiter „Chats“: Ungelesene, ein markierter Chat zählt eins. */
export function reiterZahl(chats: ConversationDto[]): number {
  return chats.reduce(
    (summe, chat) =>
      summe +
      (chat.archived ? 0 : chat.unreadCount > 0 ? chat.unreadCount : chat.markedUnread ? 1 : 0),
    0,
  );
}

export function angeheftetAnzahl(chats: ConversationDto[]): number {
  return chats.filter((chat) => chat.pinnedAt && !chat.archived).length;
}

export function darfAnheften(chats: ConversationDto[], chat: ConversationDto): boolean {
  return Boolean(chat.pinnedAt) || angeheftetAnzahl(chats) < ANGEHEFTET_MAX;
}

/**
 * Die neue Reihenfolge der Angehefteten, wenn einer um eins verschoben wird –
 * für die Tasten „nach oben“/„nach unten“ (die Tastatur-Alternative zum
 * Ziehen). Unverändert, wenn er schon am Rand steht.
 */
export function verschieben(
  chats: ConversationDto[],
  id: string,
  richtung: 'hoch' | 'runter',
): string[] {
  const reihe = sortieren(chats.filter((chat) => chat.pinnedAt && !chat.archived)).map(
    (chat) => chat.id,
  );
  const stelle = reihe.indexOf(id);
  if (stelle < 0) return reihe;
  const ziel = richtung === 'hoch' ? stelle - 1 : stelle + 1;
  if (ziel < 0 || ziel >= reihe.length) return reihe;
  [reihe[stelle], reihe[ziel]] = [reihe[ziel]!, reihe[stelle]!];
  return reihe;
}

/* ---------- Stummschalten ---------- */

export type StummVorgabe = '8h' | '1w' | 'immer';

export const STUMM_VORGABEN: { wert: StummVorgabe; label: string }[] = [
  { wert: '8h', label: '8 Stunden' },
  { wert: '1w', label: '1 Woche' },
  { wert: 'immer', label: 'Immer – bis ich es wieder einschalte' },
];

/** „Immer“ ist ein fernes Datum: Der Server kennt kein „unendlich“, nur einen Zeitpunkt. */
export const STUMM_IMMER = '9999-12-31T00:00:00.000Z';

export function stummBis(vorgabe: StummVorgabe, jetzt = Date.now()): string {
  if (vorgabe === 'immer') return STUMM_IMMER;
  const stunden = vorgabe === '8h' ? 8 : 24 * 7;
  return new Date(jetzt + stunden * 3_600_000).toISOString();
}

export function istStumm(chat: ConversationDto, jetzt = Date.now()): boolean {
  return Boolean(chat.mutedUntil && new Date(chat.mutedUntil).getTime() > jetzt);
}

export function stummText(chat: ConversationDto, jetzt = Date.now()): string | null {
  if (!istStumm(chat, jetzt)) return null;
  const bis = new Date(chat.mutedUntil!);
  if (bis.getUTCFullYear() >= 9000) return 'Stumm, bis du es wieder einschaltest';
  return `Stumm bis ${bis.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}`;
}

/* ---------- Wischen ---------- */

/** Ab hier zählt ein Wisch (Pixel) – mindestens, bei breiten Zeilen ein Viertel. */
export const WISCH_MINDEST = 72;
/** Weiter wandert die Zeile nicht mit. */
export const WISCH_MAX = 120;

export type WischAktion = 'archivieren' | 'lesen';

/**
 * Wohin ein Wisch führt: nach links archivieren, nach rechts gelesen bzw.
 * ungelesen umschalten. Nur, wenn er deutlich waagerecht war – sonst ist es
 * Blättern in der Liste und darf nichts auslösen.
 */
export function wischErgebnis(dx: number, dy: number, breite: number): WischAktion | null {
  if (Math.abs(dx) < Math.abs(dy) * 1.5) return null;
  const schwelle = Math.max(WISCH_MINDEST, breite * 0.25);
  if (dx <= -schwelle) return 'archivieren';
  if (dx >= schwelle) return 'lesen';
  return null;
}

/** Wie weit die Zeile dem Finger folgt (gedämpft, begrenzt). */
export function wischVersatz(dx: number, dy: number): number {
  if (Math.abs(dx) < Math.abs(dy)) return 0;
  return Math.max(-WISCH_MAX, Math.min(WISCH_MAX, dx));
}
