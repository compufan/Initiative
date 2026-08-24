import {
  messagePreview,
  truncate,
  uuidv7,
  type MessageDto,
  type MessageMetadata,
  type MessageSnippet,
  type MessageType,
  type ReactionDto,
} from '@initiative/shared';
import type { AppContext } from '../context.js';
import { jsonb, type Sql } from '../db/client.js';
import type { AttachmentRow, MessageRow, ReactionRow } from '../db/types.js';
import { groupBy, iso, isoRequired } from '../lib/http.js';
import { badRequest, notFound } from '../lib/errors.js';
import { loadAttachmentsByMessageIds, toAttachmentDto } from './attachments.js';
import { runMessageExpanders } from './message-expanders.js';
import { getMemberIds, touchConversation } from './conversation-core.js';
import { notifyNewMessage } from './notify.js';

export function toMessageSnippet(row: MessageRow, attachmentKind: string | null): MessageSnippet {
  return {
    id: row.id,
    senderId: row.senderId,
    type: row.type,
    body: row.deletedAt ? null : row.body,
    attachmentKind,
    deletedAt: iso(row.deletedAt),
  };
}

function baseDto(row: MessageRow): MessageDto {
  return {
    id: row.id,
    conversationId: row.conversationId,
    senderId: row.senderId,
    type: row.type,
    body: row.deletedAt ? null : row.body,
    attachments: [],
    replyToId: row.replyToId,
    replyTo: null,
    metadata: row.deletedAt ? {} : (row.metadata ?? {}),
    reactions: [],
    clientId: row.clientId,
    createdAt: isoRequired(row.createdAt),
    editedAt: iso(row.editedAt),
    deletedAt: iso(row.deletedAt),
  };
}

/** Load attachments, reactions, reply previews and module expansions in bulk. */
export async function hydrateMessages(
  sql: Sql,
  rows: MessageRow[],
  viewerId: string,
): Promise<MessageDto[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const replyIds = [...new Set(rows.map((row) => row.replyToId).filter((id): id is string => !!id))];

  const [attachments, reactionRows, replyRows, expansions] = await Promise.all([
    loadAttachmentsByMessageIds(sql, ids),
    sql<ReactionRow[]>`select * from reactions where message_id = any(${ids})`,
    replyIds.length > 0
      ? sql<MessageRow[]>`select * from messages where id = any(${replyIds})`
      : Promise.resolve([] as MessageRow[]),
    runMessageExpanders({ sql, viewerId, messages: rows }),
  ]);

  const replyAttachmentKinds = new Map<string, string>();
  if (replyRows.length > 0) {
    const kinds = await sql<Pick<AttachmentRow, 'messageId' | 'kind'>[]>`
      select message_id, kind from attachments where message_id = any(${replyRows.map((r) => r.id)})
    `;
    for (const row of kinds) {
      if (row.messageId && !replyAttachmentKinds.has(row.messageId)) {
        replyAttachmentKinds.set(row.messageId, row.kind);
      }
    }
  }
  const replies = new Map(
    replyRows.map((row) => [row.id, toMessageSnippet(row, replyAttachmentKinds.get(row.id) ?? null)]),
  );

  const reactionsByMessage = groupBy(reactionRows, (row) => row.messageId);

  return rows.map((row) => {
    const dto = baseDto(row);
    dto.attachments = row.deletedAt ? [] : (attachments.get(row.id) ?? []);
    dto.replyTo = row.replyToId ? (replies.get(row.replyToId) ?? null) : null;
    dto.reactions = toReactionDtos(reactionsByMessage.get(row.id) ?? []);
    if (!row.deletedAt) Object.assign(dto, expansions.get(row.id) ?? {});
    return dto;
  });
}

export function toReactionDtos(rows: ReactionRow[]): ReactionDto[] {
  const byEmoji = groupBy(rows, (row) => row.emoji);
  return [...byEmoji.entries()]
    .map(([emoji, items]) => ({ emoji, userIds: items.map((item) => item.userId) }))
    .sort((a, b) => b.userIds.length - a.userIds.length || a.emoji.localeCompare(b.emoji));
}

export async function loadMessage(
  sql: Sql,
  messageId: string,
  viewerId: string,
): Promise<MessageDto | null> {
  const rows = await sql<MessageRow[]>`select * from messages where id = ${messageId}`;
  if (rows.length === 0) return null;
  const [dto] = await hydrateMessages(sql, rows, viewerId);
  return dto ?? null;
}

export interface CreateMessageInput {
  conversationId: string;
  senderId: string | null;
  type?: MessageType;
  body?: string | null;
  attachmentIds?: string[];
  replyToId?: string | null;
  clientId?: string | null;
  metadata?: MessageMetadata;
  /** Skip push notifications – used for system messages. */
  silent?: boolean;
}

/**
 * Single entry point for putting a message into a conversation. Feature modules
 * (polls, calendar, games …) use it so their cards appear in the chat, get
 * broadcast over the realtime bus and trigger push notifications like any other
 * message.
 */
export async function createMessage(ctx: AppContext, input: CreateMessageInput): Promise<MessageDto> {
  const { sql } = ctx;
  const type = input.type ?? 'text';
  const body = input.body?.trim() ? input.body.trim() : null;

  if (input.clientId && input.senderId) {
    const existing = await sql<MessageRow[]>`
      select * from messages
      where conversation_id = ${input.conversationId}
        and sender_id = ${input.senderId}
        and client_id = ${input.clientId}
      limit 1
    `;
    if (existing[0]) {
      const [dto] = await hydrateMessages(sql, existing, input.senderId);
      return dto!;
    }
  }

  if (input.replyToId) {
    const reply = await sql<{ id: string }[]>`
      select id from messages where id = ${input.replyToId} and conversation_id = ${input.conversationId}
    `;
    if (reply.length === 0) throw badRequest('Antwort bezieht sich auf eine unbekannte Nachricht');
  }

  const id = uuidv7();
  const row = {
    id,
    conversationId: input.conversationId,
    senderId: input.senderId,
    type,
    body,
    replyToId: input.replyToId ?? null,
    metadata: jsonb(sql, input.metadata ?? {}),
    clientId: input.clientId ?? null,
  };

  const inserted = await sql<MessageRow[]>`
    insert into messages ${sql(row)} returning *
  `;
  const messageRow = inserted[0];
  if (!messageRow) throw new Error('failed to insert message');

  const attachmentIds = input.attachmentIds ?? [];
  if (attachmentIds.length > 0) {
    await sql`
      update attachments
      set message_id = ${id}, status = 'ready'
      where id = any(${attachmentIds})
        and message_id is null
        ${input.senderId ? sql`and uploader_id = ${input.senderId}` : sql``}
    `;
  }

  await touchConversation(sql, input.conversationId);

  const [dto] = await hydrateMessages(sql, [messageRow], input.senderId ?? '');
  const message = dto!;

  const memberIds = await getMemberIds(sql, input.conversationId);
  await ctx.hub.publish(memberIds, { type: 'message.new', payload: { message } });

  if (!input.silent) {
    await notifyNewMessage(ctx, message, memberIds);
  }
  return message;
}

/** Re-send an updated message to every member (edits, reactions, expansions). */
export async function publishMessageUpdate(ctx: AppContext, message: MessageDto): Promise<void> {
  const memberIds = await getMemberIds(ctx.sql, message.conversationId);
  await ctx.hub.publish(memberIds, { type: 'message.updated', payload: { message } });
}

/** Refresh the chat card that belongs to an entity (poll, event, game). */
export async function republishMessage(
  ctx: AppContext,
  messageId: string | null,
  viewerId: string,
): Promise<void> {
  if (!messageId) return;
  const message = await loadMessage(ctx.sql, messageId, viewerId);
  if (message) await publishMessageUpdate(ctx, message);
}

export async function requireMessage(sql: Sql, messageId: string): Promise<MessageRow> {
  const rows = await sql<MessageRow[]>`select * from messages where id = ${messageId}`;
  const row = rows[0];
  if (!row) throw notFound('Nachricht nicht gefunden');
  return row;
}

export function previewFor(message: MessageDto): string {
  return truncate(messagePreview(message), 120);
}
