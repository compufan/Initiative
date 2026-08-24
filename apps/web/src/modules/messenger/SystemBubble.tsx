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

function describe(
  kind: string,
  actor: string,
  targets: string[],
  conversation: ConversationDto | null,
): string {
  const isMe = actor === 'Du';
  switch (kind) {
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
    (system ? describe(system.kind, actor, targets, conversation) : '') ||
    message.body?.trim() ||
    'Der Chat wurde aktualisiert';

  return (
    <div className="msg-system">
      <span>{text}</span>
    </div>
  );
}
