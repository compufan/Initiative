import type { StickerDto, StickerPackDto } from '@initiative/shared';
import type { Sql } from '../db/client.js';
import type { AttachmentRow, StickerPackRow, StickerRow } from '../db/types.js';
import { groupBy, isoRequired } from '../lib/http.js';
import { notFound } from '../lib/errors.js';
import { mediaUrl } from './attachments.js';
import type { MessageExpander } from './message-expanders.js';

export function toStickerDto(row: StickerRow, packName: string): StickerDto {
  return {
    id: row.id,
    packId: row.packId,
    packName,
    url: mediaUrl(row.attachmentId),
    emoji: row.emoji,
    width: row.width,
    height: row.height,
    createdAt: isoRequired(row.createdAt),
  };
}

export function toStickerPackDto(
  pack: StickerPackRow,
  stickers: StickerRow[],
  installed: boolean,
): StickerPackDto {
  const sorted = stickers.slice().sort((a, b) => a.position - b.position);
  const cover = sorted.find((sticker) => sticker.id === pack.coverStickerId) ?? sorted[0];
  return {
    id: pack.id,
    name: pack.name,
    ownerId: pack.ownerId ?? '',
    coverUrl: cover ? mediaUrl(cover.attachmentId) : null,
    isPublic: pack.isPublic,
    installed,
    stickerCount: sorted.length,
    stickers: sorted.map((sticker) => toStickerDto(sticker, pack.name)),
    createdAt: isoRequired(pack.createdAt),
  };
}

export async function loadPackDtos(
  sql: Sql,
  packIds: string[],
  viewerId: string,
): Promise<Map<string, StickerPackDto>> {
  if (packIds.length === 0) return new Map();
  const [packs, stickers, installs] = await Promise.all([
    sql<StickerPackRow[]>`select * from sticker_packs where id = any(${packIds})`,
    sql<StickerRow[]>`select * from stickers where pack_id = any(${packIds}) order by position asc`,
    sql<{ packId: string }[]>`
      select pack_id from sticker_pack_installs
      where user_id = ${viewerId} and pack_id = any(${packIds})
    `,
  ]);
  const byPack = groupBy(stickers, (row) => row.packId);
  const installed = new Set(installs.map((row) => row.packId));
  return new Map(
    packs.map((pack) => [
      pack.id,
      toStickerPackDto(pack, byPack.get(pack.id) ?? [], installed.has(pack.id)),
    ]),
  );
}

export async function loadPackDto(sql: Sql, packId: string, viewerId: string): Promise<StickerPackDto> {
  const dto = (await loadPackDtos(sql, [packId], viewerId)).get(packId);
  if (!dto) throw notFound('Sticker-Paket nicht gefunden');
  return dto;
}

export async function loadStickerDtos(sql: Sql, stickerIds: string[]): Promise<Map<string, StickerDto>> {
  if (stickerIds.length === 0) return new Map();
  const rows = await sql<(StickerRow & { packName: string })[]>`
    select s.*, p.name as pack_name
    from stickers s
    join sticker_packs p on p.id = s.pack_id
    where s.id = any(${stickerIds})
  `;
  return new Map(rows.map((row) => [row.id, toStickerDto(row, row.packName)]));
}

/** Attachments that back a sticker must never be reused as chat attachments. */
export async function markAttachmentAsSticker(sql: Sql, attachmentId: string): Promise<AttachmentRow> {
  const rows = await sql<AttachmentRow[]>`
    update attachments set status = 'ready', kind = 'sticker'
    where id = ${attachmentId} and message_id is null
    returning *
  `;
  const row = rows[0];
  if (!row) throw notFound('Sticker-Datei nicht gefunden');
  return row;
}

/** Embeds the referenced sticker into every `sticker` message. */
export const stickerExpander: MessageExpander = {
  key: 'stickers',
  async expand({ sql, messages }) {
    const ids = [
      ...new Set(
        messages.map((message) => message.metadata?.stickerId).filter((id): id is string => !!id),
      ),
    ];
    const stickers = await loadStickerDtos(sql, ids);
    const result = new Map<string, { sticker?: StickerDto }>();
    for (const message of messages) {
      const stickerId = message.metadata?.stickerId;
      if (!stickerId) continue;
      const sticker = stickers.get(stickerId);
      if (sticker) result.set(message.id, { sticker });
    }
    return result;
  },
};
