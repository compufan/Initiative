import type { ConversationDto } from '@initiative/shared';
import type { MessageRendererProps } from '../types.js';
import { useMyId } from '../../state/session.js';
import { memberName } from './helpers.js';

function nameOf(conversation: ConversationDto | null, userId: string | null, myId: string): string {
  if (!userId) return 'Jemand';
  if (userId === myId) return 'Du';
  const member = conversation?.members.find((item) => item.userId === userId);
  return member ? memberName(member) : 'Jemand';
}

function joinNames(names: string[]): string {
  if (names.length === 0) return 'jemanden';
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(', ')} und ${names[names.length - 1]}`;
}

export function describe(
  kind: string,
  actor: string,
  targets: string[],
  conversation: ConversationDto | null,
  text?: string | null,
): string {
  const isMe = actor === 'Du';
  const hat = isMe ? 'hast' : 'hat';
  switch (kind) {
    // Gruppenverwaltung: `text` ist der Rumpf der Systemzeile (neuer Name,
    // geänderte Schalter) – der Server setzt ihn, damit auch spätere Namen
    // die Zeile nicht umschreiben.
    case 'conversation.renamed':
      return text
        ? `${actor} ${hat} die Gruppe in „${text}“ umbenannt`
        : `${actor} ${hat} die Gruppe umbenannt`;
    case 'conversation.avatar':
      return `${actor} ${hat} das Gruppenbild geändert`;
    case 'conversation.avatar.removed':
      return `${actor} ${hat} das Gruppenbild entfernt`;
    case 'conversation.description':
      return `${actor} ${hat} die Beschreibung geändert`;
    case 'conversation.settings':
      return text
        ? `${actor} ${hat} die Gruppeneinstellungen geändert: ${text}`
        : `${actor} ${hat} die Gruppeneinstellungen geändert`;
    case 'member.promoted':
      return `${actor} ${hat} ${joinNames(targets)} zum Admin gemacht`;
    case 'member.demoted':
      return `${actor} ${hat} ${joinNames(targets)} die Adminrechte entzogen`;
    case 'owner.transferred':
      return `${actor} ${hat} die Gruppe an ${joinNames(targets)} übergeben`;
    case 'member.joined':
      return `${actor} ${isMe ? 'bist' : 'ist'} über einen Einladungslink beigetreten`;
    case 'member.approved':
      return `${actor} ${hat} ${joinNames(targets)} aufgenommen`;
    case 'conversation.created':
      return `${actor} ${isMe ? 'hast' : 'hat'} ${
        conversation?.type === 'group' ? 'die Gruppe' : 'den Chat'
      } erstellt`;
    case 'members.added':
      return `${actor} ${isMe ? 'hast' : 'hat'} ${joinNames(targets)} hinzugefügt`;
    case 'member.left':
      return `${actor} ${isMe ? 'hast' : 'hat'} den Chat verlassen`;
    case 'member.removed':
      return `${actor} ${isMe ? 'hast' : 'hat'} ${joinNames(targets)} entfernt`;
    // Der Server bestimmt einen neuen Besitzer, wenn der bisherige geht (Austritt
    // oder Kontolöschung); Handelnder ist der Nachfolger.
    case 'owner.changed':
      return `${actor} ${isMe ? 'bist' : 'ist'} jetzt Besitzer der Gruppe`;
    default:
      return '';
  }
}

/** Centered, quiet line for membership and lifecycle events. */
export function SystemBubble({ message, conversation }: MessageRendererProps) {
  const myId = useMyId();
  const system = message.metadata.system;
  const actor = nameOf(conversation, system?.actorId ?? message.senderId, myId);
  const targets = (system?.targetIds ?? []).map((id) => nameOf(conversation, id, myId));
  const text =
    (system ? describe(system.kind, actor, targets, conversation, message.body) : '') ||
    message.body?.trim() ||
    'Der Chat wurde aktualisiert';

  return (
    <div className="msg-system">
      <span>{text}</span>
    </div>
  );
}
