import { api } from '../lib/api.js';

/**
 * „Zugestellt“ melden – gebündelt und gedrosselt.
 *
 * Jede eingetroffene Nachricht einzeln zu melden hiesse in einer lebhaften
 * Gruppe: eine Anfrage je Nachricht und Empfänger. Stattdessen merkt sich
 * dieses Gerät je Chat die neueste fremde Nachricht, die es bekommen hat, und
 * schickt alles Gesammelte höchstens alle [`TAKT_MS`] in EINER Anfrage. Der
 * Server rückt nur vor (UUIDv7, zeitlich sortiert); eine doppelte oder
 * veraltete Meldung ist harmlos.
 *
 * Über REST statt über die Leitung, aus demselben Grund wie beim Lesen: Der
 * Socket quittiert nichts, und eine halboffene Leitung (iPhone) verschluckte
 * die Meldung. Scheitert die Anfrage, bleibt das Gesammelte für den nächsten
 * Takt liegen.
 */
export const TAKT_MS = 1500;
const NOCHMAL_MS = 15_000;
const JE_ANFRAGE = 100;

const vorgemerkt = new Map<string, string>();
const gemeldet = new Map<string, string>();
let wecker: ReturnType<typeof setTimeout> | null = null;

export function zustellungVormerken(conversationId: string, messageId: string): void {
  if (!messageId || messageId.startsWith('local:')) return;
  const bekannt = gemeldet.get(conversationId);
  if (bekannt && bekannt >= messageId) return;
  const bisher = vorgemerkt.get(conversationId);
  if (bisher && bisher >= messageId) return;
  vorgemerkt.set(conversationId, messageId);
  planen(TAKT_MS);
}

function planen(ms: number): void {
  if (wecker != null) return;
  wecker = setTimeout(() => {
    wecker = null;
    void senden();
  }, ms);
}

async function senden(): Promise<void> {
  if (vorgemerkt.size === 0) return;
  const eintraege = [...vorgemerkt.entries()]
    .slice(0, JE_ANFRAGE)
    .map(([conversationId, messageId]) => ({ conversationId, messageId }));
  for (const { conversationId } of eintraege) vorgemerkt.delete(conversationId);
  try {
    await api.messages.zugestellt(eintraege);
    for (const { conversationId, messageId } of eintraege) {
      const bekannt = gemeldet.get(conversationId);
      if (!bekannt || bekannt < messageId) gemeldet.set(conversationId, messageId);
    }
    if (vorgemerkt.size > 0) planen(TAKT_MS);
  } catch {
    // Zurücklegen, was nicht inzwischen von Neuerem überholt wurde.
    for (const { conversationId, messageId } of eintraege) {
      const neuer = vorgemerkt.get(conversationId);
      if (!neuer || neuer < messageId) vorgemerkt.set(conversationId, messageId);
    }
    planen(NOCHMAL_MS);
  }
}

/** Sofort senden (Tests, Abmelden). */
export async function zustellungJetzt(): Promise<void> {
  if (wecker != null) {
    clearTimeout(wecker);
    wecker = null;
  }
  await senden();
}

/** Nach dem Abmelden: nichts vom alten Konto weiterschicken. */
export function zustellungVergessen(): void {
  if (wecker != null) clearTimeout(wecker);
  wecker = null;
  vorgemerkt.clear();
  gemeldet.clear();
}
