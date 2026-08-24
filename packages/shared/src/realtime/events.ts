import type { ConversationDto } from '../schemas/conversation.js';
import type { MessageDto, ReactionDto } from '../schemas/message.js';
import type { PollDto } from '../schemas/poll.js';
import type { CalendarEventDto } from '../schemas/calendar.js';
import type { GameSessionDto } from '../schemas/game.js';
import type { UserDto } from '../schemas/user.js';

/**
 * Realtime protocol.
 *
 * Both directions use the same envelope so future modules can add their own
 * event types without touching the transport: unknown `type` values are ignored
 * by older clients instead of breaking the connection.
 */
export interface RealtimeEnvelope<T = unknown> {
  v: number;
  /** Monotonic id per connection, used to correlate acks. */
  id?: string;
  type: string;
  ts: string;
  payload: T;
}

export type ServerEvent =
  | { type: 'hello'; payload: { userId: string; connectionId: string; serverTime: string } }
  | { type: 'pong'; payload: { ts: string } }
  | { type: 'message.new'; payload: { message: MessageDto } }
  | { type: 'message.updated'; payload: { message: MessageDto } }
  | { type: 'message.deleted'; payload: { conversationId: string; messageId: string } }
  | { type: 'message.reactions'; payload: { conversationId: string; messageId: string; reactions: ReactionDto[] } }
  | { type: 'conversation.updated'; payload: { conversation: ConversationDto } }
  | { type: 'conversation.removed'; payload: { conversationId: string } }
  | { type: 'read.updated'; payload: { conversationId: string; userId: string; lastReadMessageId: string } }
  | { type: 'typing'; payload: { conversationId: string; userId: string; until: string } }
  | { type: 'presence'; payload: { userId: string; online: boolean; lastSeenAt: string | null } }
  | { type: 'poll.updated'; payload: { poll: PollDto } }
  | { type: 'event.updated'; payload: { event: CalendarEventDto } }
  | { type: 'event.deleted'; payload: { eventId: string; conversationId: string | null } }
  | { type: 'game.updated'; payload: { session: GameSessionDto } }
  | { type: 'user.updated'; payload: { user: UserDto } }
  /** Payload too large for the broadcast bus – clients should refetch. */
  | { type: 'sync.hint'; payload: { conversationId?: string; scope: string } }
  | { type: 'error'; payload: { code: string; message: string } };

export type ServerEventType = ServerEvent['type'];

export type ClientEvent =
  | { type: 'ping'; payload: Record<string, never> }
  | { type: 'typing'; payload: { conversationId: string; typing: boolean } }
  | { type: 'read'; payload: { conversationId: string; messageId: string } }
  | { type: 'subscribe'; payload: { conversationIds: string[] } };

export type ClientEventType = ClientEvent['type'];

export function envelope<T>(type: string, payload: T, id?: string): RealtimeEnvelope<T> {
  return { v: 1, type, ts: new Date().toISOString(), payload, ...(id ? { id } : {}) };
}

export function parseEnvelope(raw: string): RealtimeEnvelope | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as RealtimeEnvelope).type === 'string'
    ) {
      return value as RealtimeEnvelope;
    }
  } catch {
    /* ignore malformed frames */
  }
  return null;
}

/** Typing indicators expire on their own so a dropped socket cannot pin them. */
export const TYPING_TTL_MS = 6000;
export const HEARTBEAT_INTERVAL_MS = 25_000;
