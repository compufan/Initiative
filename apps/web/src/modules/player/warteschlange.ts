/**
 * Was der globale Sprachnachrichten-Spieler als Nächstes spielt – und wo er
 * stehen geblieben war. Reine Funktionen, ohne DOM: geprüft in
 * `warteschlange.test.ts`.
 */
import type { AttachmentDto, MessageDto } from '@initiative/shared';

/** Ein Stück im Spieler: eine Sprachnachricht samt allem für die Anzeige. */
export interface Titel {
  conversationId: string;
  messageId: string;
  attachment: AttachmentDto;
  /** Für Sperrbildschirm und Mini-Leiste: wer, in welchem Chat. */
  absender: string;
  chat: string;
}

export const GESCHWINDIGKEITEN = [1, 1.5, 2] as const;

export function naechsteGeschwindigkeit(jetzt: number): number {
  const index = GESCHWINDIGKEITEN.indexOf(jetzt as (typeof GESCHWINDIGKEITEN)[number]);
  return GESCHWINDIGKEITEN[(index + 1) % GESCHWINDIGKEITEN.length];
}

/** Ist das eine Sprachnachricht (und keine Audio-DATEI)? */
export function istSprachnachricht(
  message: Pick<MessageDto, 'type' | 'attachments' | 'deletedAt'>,
) {
  return (
    message.type === 'audio' &&
    !message.deletedAt &&
    message.attachments.some((anhang) => anhang.kind === 'audio' && anhang.status === 'ready')
  );
}

/**
 * Die nächste Sprachnachricht nach `nachId` im Verlauf (ältere zuerst) –
 * wie bei WhatsApp: Hört man eine, kommt die darauffolgende von selbst.
 * Eigene werden übersprungen, wenn `ohneVon` gesetzt ist (die kennt man).
 */
export function naechsteSprachnachricht(
  verlauf: readonly MessageDto[],
  nachId: string,
  ohneVon?: string,
): MessageDto | null {
  const index = verlauf.findIndex((nachricht) => nachricht.id === nachId);
  if (index < 0) return null;
  for (let i = index + 1; i < verlauf.length; i += 1) {
    const kandidat = verlauf[i];
    if (!istSprachnachricht(kandidat)) continue;
    if (ohneVon && kandidat.senderId === ohneVon) continue;
    return kandidat;
  }
  return null;
}

/* ---------- Fortschritt merken ------------------------------------------ */

/** Höchstens so viele Stände – älteste fallen heraus. */
export const STAENDE_MAX = 200;

export type Staende = Record<string, { s: number; t: number }>;

/**
 * Den Stand einer Sprachnachricht merken. Am Ende (letzte Sekunde) oder ganz
 * am Anfang wird er vergessen: Dann gibt es nichts fortzusetzen.
 */
export function standMerken(
  staende: Staende,
  anhangId: string,
  sekunden: number,
  dauer: number,
  jetzt = Date.now(),
): Staende {
  const neu: Staende = { ...staende };
  if (!Number.isFinite(sekunden) || sekunden < 1 || (dauer > 0 && sekunden >= dauer - 1)) {
    delete neu[anhangId];
    return neu;
  }
  neu[anhangId] = { s: Math.round(sekunden * 10) / 10, t: jetzt };
  const schluessel = Object.keys(neu);
  if (schluessel.length > STAENDE_MAX) {
    schluessel
      .sort((a, b) => neu[a].t - neu[b].t)
      .slice(0, schluessel.length - STAENDE_MAX)
      .forEach((alt) => delete neu[alt]);
  }
  return neu;
}

/** Wo weitermachen? 0, wenn nichts gemerkt ist oder es nicht mehr passt. */
export function fortsetzenBei(staende: Staende, anhangId: string, dauer: number): number {
  const stand = staende[anhangId]?.s ?? 0;
  if (dauer > 0 && stand >= dauer - 1) return 0;
  return Math.max(0, stand);
}
