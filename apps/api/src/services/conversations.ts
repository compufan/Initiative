import type { ConversationDto, ConversationMemberDto, UserDto } from '@initiative/shared';
import type { AppContext } from '../context.js';
import type { Sql } from '../db/client.js';
import type { ConversationMemberRow, ConversationRow, MessageRow } from '../db/types.js';
import { groupBy, iso, isoRequired } from '../lib/http.js';
import { mediaUrl } from './attachments.js';
import { getMemberRows } from './conversation-core.js';
import { hydrateMessages } from './messages.js';
import { loadUsersByIds } from './users.js';

export * from './conversation-core.js';

interface LoadOptions {
  ids?: string[];
  includeArchived?: boolean;
  limit?: number;
}

/** Assemble the viewer specific conversation list in a fixed number of queries. */
export async function loadConversationDtos(
  sql: Sql,
  viewerId: string,
  options: LoadOptions = {},
): Promise<ConversationDto[]> {
  const rows = await sql<(ConversationRow & { archived: boolean; mutedUntil: Date | null })[]>`
    select c.*, cm.archived, cm.muted_until
    from conversations c
    join conversation_members cm on cm.conversation_id = c.id and cm.user_id = ${viewerId}
    where true
      ${options.ids && options.ids.length > 0 ? sql`and c.id = any(${options.ids})` : sql``}
      ${options.includeArchived ? sql`` : sql`and cm.archived = false`}
    order by coalesce(c.last_message_at, c.created_at) desc
    limit ${options.limit ?? 200}
  `;
  if (rows.length === 0) return [];

  const conversationIds = rows.map((row) => row.id);
  const [memberRows, lastMessageRows, unreadRows] = await Promise.all([
    getMemberRows(sql, conversationIds),
    sql<MessageRow[]>`
      select distinct on (conversation_id) *
      from messages
      where conversation_id = any(${conversationIds}) and deleted_at is null
      order by conversation_id, id desc
    `,
    sql<{ conversationId: string; unread: number }[]>`
      select cm.conversation_id, count(m.id)::int as unread
      from conversation_members cm
      join messages m
        on m.conversation_id = cm.conversation_id
       and m.deleted_at is null
       and (m.sender_id is null or m.sender_id <> cm.user_id)
       and (cm.last_read_message_id is null or m.id > cm.last_read_message_id)
      where cm.user_id = ${viewerId} and cm.conversation_id = any(${conversationIds})
      group by cm.conversation_id
    `,
  ]);

  const [users, lastMessages] = await Promise.all([
    loadUsersByIds(sql, memberRows.map((row) => row.userId)),
    hydrateMessages(sql, lastMessageRows, viewerId),
  ]);

  const membersByConversation = groupBy(memberRows, (row) => row.conversationId);
  const lastByConversation = new Map(lastMessages.map((message) => [message.conversationId, message]));
  const unreadByConversation = new Map(unreadRows.map((row) => [row.conversationId, row.unread]));

  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    title: row.title,
    avatarUrl: row.avatarAttachmentId ? mediaUrl(row.avatarAttachmentId) : null,
    createdBy: row.createdBy ?? '',
    createdAt: isoRequired(row.createdAt),
    updatedAt: isoRequired(row.updatedAt),
    members: toMemberDtos(membersByConversation.get(row.id) ?? [], users),
    lastMessage: lastByConversation.get(row.id) ?? null,
    unreadCount: unreadByConversation.get(row.id) ?? 0,
    mutedUntil: iso(row.mutedUntil),
    archived: row.archived,
  }));
}

function toMemberDtos(
  rows: ConversationMemberRow[],
  users: Map<string, UserDto>,
): ConversationMemberDto[] {
  return rows.map((row) => ({
    userId: row.userId,
    role: row.role,
    joinedAt: isoRequired(row.joinedAt),
    nickname: row.nickname,
    lastReadMessageId: row.lastReadMessageId,
    user: users.get(row.userId) ?? fallbackUser(row.userId),
  }));
}

function fallbackUser(userId: string): UserDto {
  return {
    id: userId,
    username: 'unbekannt',
    displayName: 'Unbekannt',
    avatarUrl: null,
    bio: null,
    accent: '#78716c',
    lastSeenAt: null,
    createdAt: new Date(0).toISOString(),
  };
}

export async function loadConversationDto(
  sql: Sql,
  viewerId: string,
  conversationId: string,
): Promise<ConversationDto | null> {
  const [dto] = await loadConversationDtos(sql, viewerId, {
    ids: [conversationId],
    includeArchived: true,
  });
  return dto ?? null;
}

/** Conversation payloads are viewer specific, so every member gets their own copy. */
export async function broadcastConversation(
  ctx: AppContext,
  conversationId: string,
  userIds?: string[],
): Promise<void> {
  const targets = userIds ?? (await getMemberRows(ctx.sql, [conversationId])).map((row) => row.userId);
  await Promise.all(
    targets.map(async (userId) => {
      const conversation = await loadConversationDto(ctx.sql, userId, conversationId);
      if (conversation) {
        await ctx.hub.publish([userId], { type: 'conversation.updated', payload: { conversation } });
      }
    }),
  );
}

/** Existing 1:1 chat between two users, if any. */
export async function findDirectConversation(
  sql: Sql,
  userA: string,
  userB: string,
): Promise<string | null> {
  const rows = await sql<{ id: string }[]>`
    select c.id
    from conversations c
    join conversation_members a on a.conversation_id = c.id and a.user_id = ${userA}
    join conversation_members b on b.conversation_id = c.id and b.user_id = ${userB}
    where c.type = 'direct'
    limit 1
  `;
  return rows[0]?.id ?? null;
}
