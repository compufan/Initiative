import { z } from 'zod';
import { CONVERSATION_TYPES, LIMITS, MEMBER_ROLES, type ConversationType, type MemberRole } from '../constants.js';
import type { UserDto } from './user.js';
import type { MessageDto } from './message.js';

export interface ConversationMemberDto {
  userId: string;
  role: MemberRole;
  joinedAt: string;
  nickname: string | null;
  lastReadMessageId: string | null;
  user: UserDto;
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
