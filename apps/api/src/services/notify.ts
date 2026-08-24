import { messagePreview, truncate, type MessageDto, type PushPayload } from '@initiative/shared';
import type { AppContext } from '../context.js';
import type { UserRow } from '../db/types.js';
import { mergeSettings } from './users.js';

interface NotificationTarget {
  userId: string;
  displayName: string;
  previews: boolean;
}

async function resolveTargets(
  ctx: AppContext,
  conversationId: string,
  memberIds: string[],
  excludeUserId: string | null,
): Promise<NotificationTarget[]> {
  const candidates = memberIds.filter((id) => id !== excludeUserId);
  if (candidates.length === 0) return [];

  const rows = await ctx.sql<(UserRow & { mutedUntil: Date | null })[]>`
    select u.*, cm.muted_until
    from users u
    join conversation_members cm on cm.user_id = u.id and cm.conversation_id = ${conversationId}
    where u.id = any(${candidates})
  `;

  const now = Date.now();
  return rows
    .filter((row) => !row.mutedUntil || row.mutedUntil.getTime() <= now)
    .map((row) => {
      const settings = mergeSettings(row.settings);
      return {
        userId: row.id,
        displayName: row.displayName,
        previews: settings.notifications.previews,
        push: settings.notifications.push,
      };
    })
    .filter((target) => target.push)
    .map(({ userId, displayName, previews }) => ({ userId, displayName, previews }));
}

/** Push notification for a freshly created message. */
export async function notifyNewMessage(
  ctx: AppContext,
  message: MessageDto,
  memberIds: string[],
): Promise<void> {
  if (!ctx.push.enabled) return;

  const targets = await resolveTargets(ctx, message.conversationId, memberIds, message.senderId);
  if (targets.length === 0) return;

  const senderRows = message.senderId
    ? await ctx.sql<Pick<UserRow, 'displayName'>[]>`
        select display_name from users where id = ${message.senderId}
      `
    : [];
  const senderName = senderRows[0]?.displayName ?? 'Initiative';
  const conversationRows = await ctx.sql<{ title: string | null; type: string }[]>`
    select title, type from conversations where id = ${message.conversationId}
  `;
  const conversation = conversationRows[0];
  const title =
    conversation?.type === 'group' && conversation.title
      ? `${senderName} · ${conversation.title}`
      : senderName;

  const withPreview: PushPayload = {
    title,
    body: truncate(messagePreview(message), 140),
    tag: `conversation:${message.conversationId}`,
    url: `/chats/${message.conversationId}`,
    conversationId: message.conversationId,
    messageId: message.id,
    kind: 'message',
  };
  const withoutPreview: PushPayload = { ...withPreview, title: 'Initiative', body: 'Neue Nachricht' };

  const previewUsers = targets.filter((t) => t.previews).map((t) => t.userId);
  const silentUsers = targets.filter((t) => !t.previews).map((t) => t.userId);

  await Promise.all([
    previewUsers.length > 0 ? ctx.push.sendToUsers(previewUsers, withPreview) : Promise.resolve(0),
    silentUsers.length > 0 ? ctx.push.sendToUsers(silentUsers, withoutPreview) : Promise.resolve(0),
  ]);
}

/** Generic push helper for modules (poll closed, event reminder, your turn …). */
export async function notifyUsers(
  ctx: AppContext,
  userIds: string[],
  payload: PushPayload,
): Promise<void> {
  if (!ctx.push.enabled || userIds.length === 0) return;
  await ctx.push.sendToUsers(userIds, payload);
}
