import { z } from 'zod';
import {
  CONVERSATION_TYPES,
  LIMITS,
  MEMBER_ROLES,
  type ConversationType,
  type MemberRole,
} from '../constants.js';
import type { UserDto } from './user.js';
import type { MessageDto } from './message.js';

export interface ConversationMemberDto {
  userId: string;
  role: MemberRole;
  joinedAt: string;
  nickname: string | null;
  lastReadMessageId: string | null;
  /**
   * Ab wann dieses Mitglied den Verlauf sieht; `null` heisst „von Anfang an".
   * Wer neu dazukommt, sieht ab dem Beitritt – alles davor gibt es nur auf
   * Antrag, dem alle anderen zustimmen müssen.
   */
  siehtAb: string | null;
  user: UserDto;
}

/** Ein Antrag, den Verlauf vor dem eigenen Beitritt sehen zu dürfen. */
export interface VerlaufsantragDto {
  id: string;
  conversationId: string;
  antragsteller: string;
  status: 'offen' | 'angenommen' | 'abgelehnt' | 'zurueckgezogen';
  /** Wer noch nicht abgestimmt hat – aus der heutigen Mitgliederliste. */
  offenBei: string[];
  zugestimmt: string[];
  abgelehnt: string[];
}

export interface ConversationDto {
  id: string;
  type: ConversationType;
  /** For direct chats the title is derived from the counterpart on the client. */
  title: string | null;
  avatarUrl: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  members: ConversationMemberDto[];
  lastMessage: MessageDto | null;
  unreadCount: number;
  /**
   * Ob vor der eigenen Grenze noch Nachrichten liegen, die man nicht sieht.
   * Nur dann lohnt ein Antrag – `siehtAb` steht auch beim Gründer, der nichts
   * zu beantragen hat.
   */
  verdeckterVerlauf: boolean;
  mutedUntil: string | null;
  /** Whether the viewer archived this conversation. */
  archived: boolean;
}

export const createConversationSchema = z
  .object({
    type: z.enum(CONVERSATION_TYPES).default('direct'),
    title: z.string().trim().min(1).max(LIMITS.conversationTitleMax).optional(),
    memberIds: z.array(z.string().uuid()).min(1).max(200),
    avatarAttachmentId: z.string().uuid().optional(),
  })
  .refine((v) => v.type !== 'direct' || v.memberIds.length === 1, {
    message: 'direct conversations need exactly one counterpart',
    path: ['memberIds'],
  });
export type CreateConversationInput = z.infer<typeof createConversationSchema>;

export const updateConversationSchema = z.object({
  title: z.string().trim().min(1).max(LIMITS.conversationTitleMax).nullable().optional(),
  avatarAttachmentId: z.string().uuid().nullable().optional(),
  mutedUntil: z.string().datetime({ offset: true }).nullable().optional(),
  archived: z.boolean().optional(),
});
export type UpdateConversationInput = z.infer<typeof updateConversationSchema>;

export const addMembersSchema = z.object({
  memberIds: z.array(z.string().uuid()).min(1).max(100),
});

export const updateMemberSchema = z.object({
  role: z.enum(MEMBER_ROLES).optional(),
  nickname: z.string().trim().max(LIMITS.displayNameMax).nullable().optional(),
});

export const markReadSchema = z.object({ messageId: z.string().uuid() });
