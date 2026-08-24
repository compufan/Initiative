/**
 * Row shapes as returned by postgres.js (columns already camelCased).
 * These mirror `migrations/0001_init.sql`.
 */
import type {
  AttachmentKind,
  ConversationType,
  GameStatus,
  MemberRole,
  MessageType,
  PollKind,
  RsvpStatus,
  VoteValue,
} from '@initiative/shared';
import type { MessageMetadata, UserSettings } from '@initiative/shared';

export interface UserRow {
  id: string;
  username: string;
  displayName: string;
  bio: string | null;
  passwordHash: string;
  avatarAttachmentId: string | null;
  calendarToken: string;
  settings: Partial<UserSettings>;
  lastSeenAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RefreshTokenRow {
  id: string;
  userId: string;
  tokenHash: string;
  userAgent: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface PushSubscriptionRow {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
  failureCount: number;
  lastSuccessAt: Date | null;
  createdAt: Date;
}

export interface ConversationRow {
  id: string;
  type: ConversationType;
  title: string | null;
  avatarAttachmentId: string | null;
  createdBy: string | null;
  lastMessageAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConversationMemberRow {
  conversationId: string;
  userId: string;
  role: MemberRole;
  nickname: string | null;
  lastReadMessageId: string | null;
  mutedUntil: Date | null;
  archived: boolean;
  joinedAt: Date;
}

export interface MessageRow {
  id: string;
  conversationId: string;
  senderId: string | null;
  type: MessageType;
  body: string | null;
  replyToId: string | null;
  metadata: MessageMetadata;
  clientId: string | null;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
}

export interface AttachmentRow {
  id: string;
  messageId: string | null;
  uploaderId: string | null;
  kind: AttachmentKind;
  mime: string;
  size: string | number;
  fileName: string | null;
  storageKey: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  waveform: number[] | null;
  previewDataUrl: string | null;
  status: 'pending' | 'ready';
  createdAt: Date;
}

export interface ReactionRow {
  messageId: string;
  userId: string;
  emoji: string;
  createdAt: Date;
}

export interface StickerPackRow {
  id: string;
  ownerId: string | null;
  name: string;
  coverStickerId: string | null;
  isPublic: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface StickerRow {
  id: string;
  packId: string;
  attachmentId: string;
  emoji: string | null;
  width: number;
  height: number;
  position: number;
  createdAt: Date;
}

export interface PollRow {
  id: string;
  conversationId: string;
  messageId: string | null;
  createdBy: string | null;
  kind: PollKind;
  question: string;
  description: string | null;
  multiple: boolean;
  anonymous: boolean;
  allowAddOptions: boolean;
  closesAt: Date | null;
  closedAt: Date | null;
  createdEventId: string | null;
  createdAt: Date;
}

export interface PollOptionRow {
  id: string;
  pollId: string;
  label: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  position: number;
  createdBy: string | null;
}

export interface PollVoteRow {
  pollId: string;
  optionId: string;
  userId: string;
  value: VoteValue;
  votedAt: Date;
}

export interface CalendarEventRow {
  id: string;
  conversationId: string | null;
  createdBy: string | null;
  messageId: string | null;
  title: string;
  description: string | null;
  location: string | null;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  rrule: string | null;
  color: string | null;
  reminderMinutes: number[];
  sourcePollId: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface EventAttendeeRow {
  eventId: string;
  userId: string;
  status: RsvpStatus;
  respondedAt: Date | null;
}

export interface GameSessionRow {
  id: string;
  conversationId: string;
  messageId: string | null;
  gameKey: string;
  status: GameStatus;
  state: unknown;
  players: { seat: number; userId: string; joinedAt: string }[];
  turnUserId: string | null;
  winnerUserIds: string[];
  version: number;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}
