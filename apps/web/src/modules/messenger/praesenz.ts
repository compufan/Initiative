import type { ConversationDto } from '@initiative/shared';
import type { ChatMessage } from '../../state/chat.js';
import { counterpartOf } from './helpers.js';

/**
 * Enge Auswahl aus dem Chat-Zustand – damit nicht jede Kleinigkeit den ganzen
 * Verlauf neu zeichnet.
 *
 * # Warum das zählt
 *
 * `presence` ist EINE Karte für alle Kontakte. Jede Meldung „X ist online"
 * baut sie neu – und wer die ganze Karte abonniert, zeichnet bei jedem
 * Kontakt neu, nicht nur bei dem, den er zeigt. Im offenen Chat hiess das:
 * Hundert Blasen neu, weil irgendein dritter Kontakt die App geöffnet hat.
 *
 * Die Funktionen hier sind rein, damit der Test sie ohne DOM prüfen kann; die
 * Bildschirme rufen sie aus ihren `useChat`-Selektoren.
 */

export interface PraesenzEintrag {
  online: boolean;
  lastSeenAt: string | null;
}

export type PraesenzKarte = Record<string, PraesenzEintrag>;

/**
 * Der Eintrag EINES Kontakts.
 *
 * Gibt das gespeicherte Objekt selbst zurück, keine Kopie: Ein Update für
 * jemand anderen lässt dieses Objekt unangetastet (`{ ...karte, [x]: … }`),
 * also bleibt es dasselbe – und `useChat` vergleicht mit `Object.is`.
 */
export function praesenzVon(
  karte: PraesenzKarte,
  userId: string | null | undefined,
): PraesenzEintrag | undefined {
  return userId ? karte[userId] : undefined;
}

/** Die Gegenüber aller Einzelchats – deren Online-Punkt die Liste zeigt. */
export function gegenueberIds(conversations: ConversationDto[], myId: string): string[] {
  const ids: string[] = [];
  for (const conversation of conversations) {
    const gegenueber = counterpartOf(conversation, myId);
    if (gegenueber) ids.push(gegenueber.userId);
  }
  return ids;
}

/**
 * Wer von `ids` gerade online ist – in der Reihenfolge von `ids`.
 *
 * Ein neues Feld bei jedem Aufruf, aber mit gleichem Inhalt, solange sich bei
 * diesen Kontakten nichts ändert. Mit `useShallow` verglichen, zeichnet die
 * Liste dann nur neu, wenn ein gezeigter Punkt wirklich wechselt – und nicht,
 * wenn jemand ausserhalb der Liste kommt oder geht, oder nur sein „zuletzt
 * gesehen" sich verschiebt.
 */
export function onlineUnter(karte: PraesenzKarte, ids: readonly string[]): string[] {
  return ids.filter((id) => karte[id]?.online === true);
}

/** Was `MessageBubble` bekommt – hier, damit der Vergleich ohne React testbar ist. */
export interface BlasenProps {
  message: ChatMessage;
  conversation: ConversationDto | null;
  showSender: boolean;
  showAvatar: boolean;
  onOpenActions: (message: ChatMessage) => void;
  onJumpTo: (messageId: string) => void;
}

/**
 * Ob eine Blase neu gezeichnet werden muss – der Vergleich für `React.memo`.
 *
 * Alles wird wie üblich nach Kennung verglichen, AUSSER dem Chat: Das
 * Chat-Objekt wird bei JEDER neuen Nachricht neu gebaut (`lastMessage`,
 * `unreadCount`), und mit ihm zeichnete jede Blase im Verlauf neu. Eine Blase
 * liest vom Chat aber nur, wer darin ist (`members` – Namen, Bilder) und ob er
 * eine Gruppe ist (`type`). Ändert sich eines davon, ist das Objekt `members`
 * ein neues, und die Blase zeichnet wie bisher.
 *
 * Wer einem Renderer einmal ein anderes Feld des Chats zu lesen gibt, muss es
 * hier ergänzen – sonst bleibt die Blase beim alten Stand stehen.
 */
export function blasenPropsGleich(vorher: BlasenProps, nachher: BlasenProps): boolean {
  return (
    vorher.message === nachher.message &&
    vorher.showSender === nachher.showSender &&
    vorher.showAvatar === nachher.showAvatar &&
    vorher.onOpenActions === nachher.onOpenActions &&
    vorher.onJumpTo === nachher.onJumpTo &&
    chatFuerBlaseGleich(vorher.conversation, nachher.conversation)
  );
}

function chatFuerBlaseGleich(a: ConversationDto | null, b: ConversationDto | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.id === b.id && a.type === b.type && a.members === b.members;
}
