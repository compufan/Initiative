import type { Sql } from '../db/client.js';
import type { ConversationMemberRow, ConversationRow } from '../db/types.js';
import { forbidden, notFound } from '../lib/errors.js';

/** Low-level membership helpers – kept separate so other services can depend on
 *  them without pulling in the (much heavier) conversation DTO assembly. */

export async function requireConversation(sql: Sql, conversationId: string): Promise<ConversationRow> {
  const rows = await sql<ConversationRow[]>`select * from conversations where id = ${conversationId}`;
  const row = rows[0];
  if (!row) throw notFound('Chat nicht gefunden');
  return row;
}

export async function getMembership(
  sql: Sql,
  conversationId: string,
  userId: string,
): Promise<ConversationMemberRow | null> {
  const rows = await sql<ConversationMemberRow[]>`
    select * from conversation_members
    where conversation_id = ${conversationId} and user_id = ${userId}
  `;
  return rows[0] ?? null;
}

export async function assertMembership(
  sql: Sql,
  conversationId: string,
  userId: string,
): Promise<ConversationMemberRow> {
  const membership = await getMembership(sql, conversationId, userId);
  if (!membership) throw forbidden('Du bist kein Mitglied dieses Chats');
  return membership;
}

export async function assertCanModerate(
  sql: Sql,
  conversationId: string,
  userId: string,
): Promise<ConversationMemberRow> {
  const membership = await assertMembership(sql, conversationId, userId);
  if (membership.role === 'member') throw forbidden('Nur Admins dürfen das ändern');
  return membership;
}

export async function getMemberIds(sql: Sql, conversationId: string): Promise<string[]> {
  const rows = await sql<{ userId: string }[]>`
    select user_id from conversation_members where conversation_id = ${conversationId}
  `;
  return rows.map((row) => row.userId);
}

export async function getMemberRows(
  sql: Sql,
  conversationIds: string[],
): Promise<ConversationMemberRow[]> {
  if (conversationIds.length === 0) return [];
  return sql<ConversationMemberRow[]>`
    select * from conversation_members
    where conversation_id = any(${conversationIds})
    order by joined_at asc
  `;
}

export async function touchConversation(sql: Sql, conversationId: string): Promise<void> {
  await sql`
    update conversations
    set last_message_at = now(), updated_at = now()
    where id = ${conversationId}
  `;
}
