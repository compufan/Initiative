/** Shared limits and enumerations. Client and server both validate against these. */

export const API_VERSION = 'v1';
export const API_PREFIX = `/api/${API_VERSION}`;
export const REALTIME_PATH = '/ws';
export const PROTOCOL_VERSION = 1;

export const MESSAGE_TYPES = [
  'text',
  'image',
  'video',
  'audio',
  'file',
  'sticker',
  'poll',
  'event',
  'game',
  'system',
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export const ATTACHMENT_KINDS = ['image', 'video', 'audio', 'file', 'sticker'] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

export const CONVERSATION_TYPES = ['direct', 'group'] as const;
export type ConversationType = (typeof CONVERSATION_TYPES)[number];

export const MEMBER_ROLES = ['owner', 'admin', 'member'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const RSVP_STATUSES = ['yes', 'no', 'maybe', 'pending'] as const;
export type RsvpStatus = (typeof RSVP_STATUSES)[number];

export const POLL_KINDS = ['choice', 'date'] as const;
export type PollKind = (typeof POLL_KINDS)[number];

/** Date polls use a three-state vote, choice polls only ever store `yes`. */
export const VOTE_VALUES = ['yes', 'no', 'maybe'] as const;
export type VoteValue = (typeof VOTE_VALUES)[number];

export const GAME_STATUSES = ['open', 'active', 'finished', 'aborted'] as const;
export type GameStatus = (typeof GAME_STATUSES)[number];

export const LIMITS = {
  usernameMin: 3,
  usernameMax: 32,
  displayNameMax: 64,
  bioMax: 280,
  messageBodyMax: 8000,
  conversationTitleMax: 80,
  pollQuestionMax: 300,
  pollOptionMax: 120,
  pollOptionsMax: 30,
  eventTitleMax: 160,
  eventDescriptionMax: 4000,
  stickerPackNameMax: 60,
  stickersPerPackMax: 120,
  collectionNameMax: 120,
  collectionDescriptionMax: 2000,
  collectionItemTitleMax: 200,
  collectionItemNoteMax: 2000,
  /** Wie tief Ordner ineinander liegen dürfen. */
  collectionDepthMax: 8,
  attachmentsPerMessage: 10,
  messagePageSize: 50,
  messagePageSizeMax: 100,
  /** Inline preview (tiny JPEG data URL) shipped with image/video attachments. */
  previewDataUrlMax: 32_000,
  /** Hard upload ceilings enforced by the API before a presigned URL is issued. */
  maxUploadBytes: {
    image: 25 * 1024 * 1024,
    video: 200 * 1024 * 1024,
    audio: 50 * 1024 * 1024,
    file: 100 * 1024 * 1024,
    sticker: 2 * 1024 * 1024,
  } as Record<AttachmentKind, number>,
} as const;

export const ALLOWED_MIME: Record<AttachmentKind, string[]> = {
  image: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/heic'],
  video: ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska'],
  audio: ['audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/wav'],
  sticker: ['image/webp', 'image/png'],
  file: [],
};

export const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🎉', '🔥'] as const;

/** Feature modules shipped with the app. New modules simply extend this list. */
export const CORE_MODULE_KEYS = ['messenger', 'calendar', 'games'] as const;
