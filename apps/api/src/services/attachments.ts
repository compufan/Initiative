import { API_PREFIX, type AttachmentDto } from '@initiative/shared';
import type { Sql } from '../db/client.js';
import type { AttachmentRow } from '../db/types.js';
import { env } from '../env.js';
import { groupBy, isoRequired } from '../lib/http.js';

/** Absolute URL that resolves to the stored object (redirect or stream). */
export function mediaUrl(attachmentId: string): string {
  return `${env().PUBLIC_API_URL.replace(/\/$/, '')}${API_PREFIX}/media/${attachmentId}`;
}

export function toAttachmentDto(row: AttachmentRow): AttachmentDto {
  return {
    id: row.id,
    kind: row.kind,
    mime: row.mime,
    size: typeof row.size === 'string' ? Number.parseInt(row.size, 10) : row.size,
    fileName: row.fileName,
    width: row.width,
    height: row.height,
    durationMs: row.durationMs,
    waveform: row.waveform ?? null,
    previewDataUrl: row.previewDataUrl,
    url: mediaUrl(row.id),
    status: row.status,
    createdAt: isoRequired(row.createdAt),
  };
}

export async function loadAttachmentsByMessageIds(
  sql: Sql,
  messageIds: string[],
): Promise<Map<string, AttachmentDto[]>> {
  if (messageIds.length === 0) return new Map();
  const rows = await sql<AttachmentRow[]>`
    select * from attachments
    where message_id = any(${messageIds})
    order by created_at asc
  `;
  const grouped = groupBy(rows, (row) => row.messageId as string);
  const result = new Map<string, AttachmentDto[]>();
  for (const [messageId, items] of grouped) result.set(messageId, items.map(toAttachmentDto));
  return result;
}

export async function loadAttachments(sql: Sql, ids: string[]): Promise<AttachmentRow[]> {
  if (ids.length === 0) return [];
  return sql<AttachmentRow[]>`select * from attachments where id = any(${ids})`;
}

/** Attachment URL for avatars, sticker images and other single references. */
export async function attachmentUrlFor(
  sql: Sql,
  attachmentId: string | null,
): Promise<string | null> {
  if (!attachmentId) return null;
  const rows = await sql<{ id: string }[]>`select id from attachments where id = ${attachmentId}`;
  return rows[0] ? mediaUrl(rows[0].id) : null;
}
