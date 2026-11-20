/**
 * „Chat leeren“ auch im Gerät durchsetzen.
 *
 * Der Server liefert nach dem Leeren nichts mehr von vorher (die Grenze
 * `sieht_ab` zieht mit, siehe `services::conversations::leeren`). Im Speicher
 * und im Zwischenspeicher (IndexedDB) dieses Geräts – und jedes anderen Geräts
 * derselben Person – stehen die alten Nachrichten aber noch. Hier fallen sie
 * heraus, sobald ein Chat mit `clearedUntil` ankommt: nach dem eigenen Leeren,
 * per Rundruf auf den anderen Geräten und beim Start aus dem Zwischenspeicher.
 */
import type { ConversationDto } from '@initiative/shared';
import { dropCachedMessage, readCachedMessages } from '../../lib/db.js';
import { useChat } from '../../state/chat.js';

/** Welche Grenze je Chat schon angewandt wurde – damit nicht jede Änderung neu filtert. */
const angewandt = new Map<string, string>();

function vorDerGrenze(createdAt: string, grenze: number): boolean {
  const zeit = Date.parse(createdAt);
  return !Number.isNaN(zeit) && zeit <= grenze;
}

export async function geleertAnwenden(chat: ConversationDto): Promise<void> {
  if (!chat.clearedUntil || angewandt.get(chat.id) === chat.clearedUntil) return;
  angewandt.set(chat.id, chat.clearedUntil);
  const grenze = Date.parse(chat.clearedUntil);
  if (Number.isNaN(grenze)) return;

  useChat.setState((state) => {
    const liste = state.messages[chat.id];
    if (!liste?.some((nachricht) => vorDerGrenze(nachricht.createdAt, grenze))) return state;
    return {
      messages: {
        ...state.messages,
        // Was noch unterwegs ist (Outbox), bleibt: Es ist nach dem Leeren entstanden.
        [chat.id]: liste.filter(
          (nachricht) =>
            ('pending' in nachricht && nachricht.pending) ||
            !vorDerGrenze(nachricht.createdAt, grenze),
        ),
      },
    };
  });
  try {
    const gespeichert = await readCachedMessages(chat.id);
    await Promise.all(
      gespeichert
        .filter((nachricht) => vorDerGrenze(nachricht.createdAt, grenze))
        .map((nachricht) => dropCachedMessage(nachricht.id)),
    );
  } catch {
    // Ohne Zwischenspeicher (privates Fenster) gibt es dort auch nichts zu löschen.
  }
}

/** Beim Start verdrahten: jede Änderung der Chatliste auf neue Grenzen prüfen. */
export function leerenVerdrahten(): () => void {
  const pruefen = (chats: ConversationDto[]) => {
    for (const chat of chats) {
      if (chat.clearedUntil && angewandt.get(chat.id) !== chat.clearedUntil) {
        void geleertAnwenden(chat);
      }
    }
  };
  pruefen(useChat.getState().conversations);
  return useChat.subscribe((jetzt, vorher) => {
    if (jetzt.conversations !== vorher.conversations) pruefen(jetzt.conversations);
  });
}
