import type { ChatMessage } from './chat.js';

/**
 * Die Warteschlange für alles, was eine bestehende Nachricht ändert:
 * Bearbeiten, Löschen, Reaktionen und Sternchen.
 *
 * # Warum eine zweite Warteschlange neben der Outbox
 *
 * Die Outbox trägt NEUE Nachrichten, mit Anhängen, Wiederholungsschlüssel
 * und Hochladen. Was hier steht, ist leichter: ein Aufruf auf eine bestehende
 * Kennung. Jeder davon ist beim Server wiederholbar ohne Folgen – derselbe
 * Text noch einmal ändert nichts (`edit`), ein zweites Löschen findet nichts
 * mehr (`deleted_at is null`), eine Reaktion setzt `on conflict do nothing`
 * bzw. löscht, was nicht da ist, ein Stern ebenso. Genau-einmal heisst hier
 * also: höchstens so oft, wie es egal ist.
 *
 * # Zusammenfassen
 *
 * Je Nachricht und Sache gilt die letzte Absicht (`schluessel`): Wer offline
 * zweimal auf ❤️ tippt, hat am Ende nicht reagiert – gesendet wird EIN
 * „entfernen“, kein Hin und Her. Ein Löschen „für alle“ macht alle anderen
 * Aktionen derselben Nachricht überflüssig.
 *
 * # Sichtbar sofort
 *
 * Die Oberfläche zeigt die Änderung gleich (`ueberlagern`), auch nach einem
 * Neustart offline: Was aus dem Zwischenspeicher kommt, wird mit den
 * ausstehenden Aktionen überlagert, bis der Server sie bestätigt hat.
 */
export type Aktion =
  | {
      art: 'bearbeiten';
      messageId: string;
      conversationId: string;
      body: string;
      am: string;
      /** Erwähnungen im neuen Text (fehlt: die alten bleiben). */
      mentions?: string[];
    }
  | { art: 'loeschen'; messageId: string; conversationId: string; scope: 'me' | 'all' }
  | {
      art: 'reaktion';
      messageId: string;
      conversationId: string;
      emoji: string;
      setzen: boolean;
      /** Wer reagiert – für die Überlagerung der Zähler. */
      ich: string;
    }
  | { art: 'stern'; messageId: string; conversationId: string; setzen: boolean };

export interface AktionsEintrag {
  schluessel: string;
  aktion: Aktion;
  versuche: number;
}

export function schluesselVon(aktion: Aktion): string {
  switch (aktion.art) {
    case 'reaktion':
      return `reaktion:${aktion.messageId}:${aktion.emoji}`;
    default:
      return `${aktion.art}:${aktion.messageId}`;
  }
}

/** Reiht eine Aktion ein – rein, für Test und Speicher gleichermassen. */
export function einreihen(liste: readonly AktionsEintrag[], aktion: Aktion): AktionsEintrag[] {
  const schluessel = schluesselVon(aktion);
  let rest = liste.filter((eintrag) => eintrag.schluessel !== schluessel);
  if (aktion.art === 'loeschen' && aktion.scope === 'all') {
    // Was danach kommen sollte, betrifft eine Nachricht, die es nicht mehr gibt.
    rest = rest.filter((eintrag) => eintrag.aktion.messageId !== aktion.messageId);
  }
  return [...rest, { schluessel, aktion, versuche: 0 }];
}

/**
 * Was die Liste zeigt, solange Aktionen ausstehen: bearbeiteter Text,
 * gelöschte Nachrichten weg, Reaktionen gesetzt oder entfernt.
 *
 * Gibt dieselbe Liste zurück, wenn nichts zu ändern ist – damit `memo`
 * nichts neu zeichnet.
 */
export function ueberlagern(
  nachrichten: ChatMessage[],
  ausstehend: readonly AktionsEintrag[],
): ChatMessage[] {
  if (ausstehend.length === 0 || nachrichten.length === 0) return nachrichten;
  const je = new Map<string, Aktion[]>();
  for (const { aktion } of ausstehend) {
    const liste = je.get(aktion.messageId) ?? [];
    liste.push(aktion);
    je.set(aktion.messageId, liste);
  }
  let geaendert = false;
  const aus: ChatMessage[] = [];
  for (const nachricht of nachrichten) {
    const aktionen = je.get(nachricht.id);
    if (!aktionen) {
      aus.push(nachricht);
      continue;
    }
    let neu: ChatMessage | null = nachricht;
    for (const aktion of aktionen) {
      if (!neu) break;
      if (aktion.art === 'loeschen') {
        neu = null;
      } else if (aktion.art === 'bearbeiten') {
        if (neu.body !== aktion.body) neu = { ...neu, body: aktion.body, editedAt: aktion.am };
      } else if (aktion.art === 'reaktion') {
        neu = { ...neu, reactions: reaktionUeberlagern(neu.reactions, aktion) };
      }
    }
    if (neu !== nachricht) geaendert = true;
    if (neu) aus.push(neu);
  }
  return geaendert ? aus : nachrichten;
}

function reaktionUeberlagern(
  reaktionen: ChatMessage['reactions'],
  aktion: Extract<Aktion, { art: 'reaktion' }>,
): ChatMessage['reactions'] {
  const vorhanden = reaktionen.find((r) => r.emoji === aktion.emoji);
  const habe = vorhanden?.userIds.includes(aktion.ich) ?? false;
  if (aktion.setzen === habe) return reaktionen;
  if (aktion.setzen) {
    return vorhanden
      ? reaktionen.map((r) =>
          r.emoji === aktion.emoji ? { ...r, userIds: [...r.userIds, aktion.ich] } : r,
        )
      : [...reaktionen, { emoji: aktion.emoji, userIds: [aktion.ich] }];
  }
  return reaktionen
    .map((r) =>
      r.emoji === aktion.emoji ? { ...r, userIds: r.userIds.filter((id) => id !== aktion.ich) } : r,
    )
    .filter((r) => r.userIds.length > 0);
}
