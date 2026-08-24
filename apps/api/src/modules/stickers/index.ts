import {
  LIMITS,
  addStickerSchema,
  createStickerPackSchema,
  updateStickerPackSchema,
  uuidSchema,
  uuidv7,
} from '@initiative/shared';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';
import type { StickerPackRow, StickerRow } from '../../db/types.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { parseBody, parseParams, parseQuery } from '../../lib/http.js';
import { requireUserId } from '../../lib/auth.js';
import { registerMessageExpander } from '../../services/message-expanders.js';
import {
  loadPackDto,
  loadPackDtos,
  markAttachmentAsSticker,
  stickerExpander,
} from '../../services/stickers.js';
import { defineModule } from '../types.js';

const packParams = z.object({ id: uuidSchema });
const stickerParams = z.object({ id: uuidSchema, stickerId: uuidSchema });

export default defineModule({
  key: 'stickers',
  description: 'Sticker-Pakete und selbst erstellte Sticker',
  register(app: FastifyInstance, ctx: AppContext) {
    const { sql } = ctx;
    registerMessageExpander(stickerExpander);

    /** Own packs plus everything the user installed. */
    app.get('/stickers/packs', { preHandler: app.authenticate }, async (request) => {
      const userId = requireUserId(request);
      const rows = await sql<{ id: string }[]>`
        select p.id
        from sticker_packs p
        left join sticker_pack_installs i on i.pack_id = p.id and i.user_id = ${userId}
        where p.owner_id = ${userId} or i.user_id is not null
        order by p.created_at asc
      `;
      const packs = await loadPackDtos(sql, rows.map((row) => row.id), userId);
      return { items: rows.map((row) => packs.get(row.id)).filter(Boolean) };
    });

    app.get('/stickers/discover', { preHandler: app.authenticate }, async (request) => {
      const userId = requireUserId(request);
      const { q } = parseQuery(z.object({ q: z.string().trim().max(64).optional() }), request);
      const rows = await sql<{ id: string }[]>`
        select p.id
        from sticker_packs p
        where p.is_public = true
          and p.owner_id <> ${userId}
          ${q ? sql`and lower(p.name) like ${`%${q.toLowerCase()}%`}` : sql``}
        order by p.updated_at desc
        limit 50
      `;
      const packs = await loadPackDtos(sql, rows.map((row) => row.id), userId);
      return { items: rows.map((row) => packs.get(row.id)).filter(Boolean) };
    });

    app.get('/stickers/packs/:id', { preHandler: app.authenticate }, async (request) => {
      const userId = requireUserId(request);
      const { id } = parseParams(packParams, request);
      await requireReadablePack(ctx, id, userId);
      return loadPackDto(sql, id, userId);
    });

    app.post('/stickers/packs', { preHandler: app.authenticate }, async (request, reply) => {
      const userId = requireUserId(request);
      const input = parseBody(createStickerPackSchema, request);
      const packId = uuidv7();
      await sql`
        insert into sticker_packs ${sql({
          id: packId,
          ownerId: userId,
          name: input.name,
          isPublic: input.isPublic,
        })}
      `;
      // The owner always has their own packs on the keyboard.
      await sql`
        insert into sticker_pack_installs ${sql({ packId, userId })}
        on conflict (pack_id, user_id) do nothing
      `;
      reply.status(201);
      return loadPackDto(sql, packId, userId);
    });

    app.patch('/stickers/packs/:id', { preHandler: app.authenticate }, async (request) => {
      const userId = requireUserId(request);
      const { id } = parseParams(packParams, request);
      const input = parseBody(updateStickerPackSchema, request);
      await requireOwnPack(ctx, id, userId);

      const patch: Record<string, unknown> = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.isPublic !== undefined) patch.isPublic = input.isPublic;
      if (input.coverStickerId !== undefined) {
        if (input.coverStickerId) {
          const owned = await sql<{ id: string }[]>`
            select id from stickers where id = ${input.coverStickerId} and pack_id = ${id}
          `;
          if (owned.length === 0) throw badRequest('Sticker gehört nicht zu diesem Paket');
        }
        patch.coverStickerId = input.coverStickerId;
      }
      if (Object.keys(patch).length > 0) {
        patch.updatedAt = new Date();
        await sql`update sticker_packs set ${sql(patch)} where id = ${id}`;
      }
      return loadPackDto(sql, id, userId);
    });

    app.delete('/stickers/packs/:id', { preHandler: app.authenticate }, async (request, reply) => {
      const userId = requireUserId(request);
      const { id } = parseParams(packParams, request);
      await requireOwnPack(ctx, id, userId);
      await sql`delete from sticker_packs where id = ${id}`;
      reply.status(204);
      return null;
    });

    app.post('/stickers/packs/:id/stickers', { preHandler: app.authenticate }, async (request, reply) => {
      const userId = requireUserId(request);
      const { id } = parseParams(packParams, request);
      const input = parseBody(addStickerSchema, request);
      await requireOwnPack(ctx, id, userId);

      const count = await sql<{ count: number }[]>`
        select count(*)::int as count from stickers where pack_id = ${id}
      `;
      if ((count[0]?.count ?? 0) >= LIMITS.stickersPerPackMax) {
        throw badRequest(`Ein Paket fasst maximal ${LIMITS.stickersPerPackMax} Sticker`);
      }

      const attachment = await sql<{ id: string; uploaderId: string | null }[]>`
        select id, uploader_id from attachments where id = ${input.attachmentId}
      `;
      if (!attachment[0] || attachment[0].uploaderId !== userId) {
        throw forbidden('Sticker-Datei gehört dir nicht');
      }
      const ready = await markAttachmentAsSticker(sql, input.attachmentId);

      await sql`
        insert into stickers ${sql({
          id: uuidv7(),
          packId: id,
          attachmentId: ready.id,
          emoji: input.emoji ?? null,
          width: ready.width ?? 512,
          height: ready.height ?? 512,
          position: count[0]?.count ?? 0,
        })}
      `;
      await sql`update sticker_packs set updated_at = now() where id = ${id}`;
      reply.status(201);
      return loadPackDto(sql, id, userId);
    });

    app.delete(
      '/stickers/packs/:id/stickers/:stickerId',
      { preHandler: app.authenticate },
      async (request, reply) => {
        const userId = requireUserId(request);
        const { id, stickerId } = parseParams(stickerParams, request);
        await requireOwnPack(ctx, id, userId);
        const rows = await sql<StickerRow[]>`
          delete from stickers where id = ${stickerId} and pack_id = ${id} returning *
        `;
        if (rows[0]) {
          await sql`delete from attachments where id = ${rows[0].attachmentId}`;
        }
        reply.status(204);
        return null;
      },
    );

    app.post('/stickers/packs/:id/install', { preHandler: app.authenticate }, async (request) => {
      const userId = requireUserId(request);
      const { id } = parseParams(packParams, request);
      await requireReadablePack(ctx, id, userId);
      await sql`
        insert into sticker_pack_installs ${sql({ packId: id, userId })}
        on conflict (pack_id, user_id) do nothing
      `;
      return loadPackDto(sql, id, userId);
    });

    app.delete('/stickers/packs/:id/install', { preHandler: app.authenticate }, async (request, reply) => {
      const userId = requireUserId(request);
      const { id } = parseParams(packParams, request);
      await sql`delete from sticker_pack_installs where pack_id = ${id} and user_id = ${userId}`;
      reply.status(204);
      return null;
    });
  },
});

async function loadPack(ctx: AppContext, packId: string): Promise<StickerPackRow> {
  const rows = await ctx.sql<StickerPackRow[]>`select * from sticker_packs where id = ${packId}`;
  const row = rows[0];
  if (!row) throw notFound('Sticker-Paket nicht gefunden');
  return row;
}

async function requireOwnPack(ctx: AppContext, packId: string, userId: string): Promise<StickerPackRow> {
  const pack = await loadPack(ctx, packId);
  if (pack.ownerId !== userId) throw forbidden('Das ist nicht dein Sticker-Paket');
  return pack;
}

async function requireReadablePack(
  ctx: AppContext,
  packId: string,
  userId: string,
): Promise<StickerPackRow> {
  const pack = await loadPack(ctx, packId);
  if (!pack.isPublic && pack.ownerId !== userId) throw forbidden('Dieses Paket ist privat');
  return pack;
}
