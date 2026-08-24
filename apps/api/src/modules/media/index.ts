import {
  ALLOWED_MIME,
  API_PREFIX,
  LIMITS,
  createUploadSchema,
  completeUploadSchema,
  uuidSchema,
  uuidv7,
  type AttachmentKind,
} from '@initiative/shared';
import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../../context.js';
import type { AttachmentRow } from '../../db/types.js';
import { badRequest, forbidden, notFound, tooLarge, unsupportedMedia } from '../../lib/errors.js';
import { parseBody, parseParams } from '../../lib/http.js';
import { requireUserId } from '../../lib/auth.js';
import { extensionForMime, extensionOf, storageKeyFor, type ByteRange } from '../../storage/index.js';
import { toAttachmentDto } from '../../services/attachments.js';
import { defineModule } from '../types.js';

const idParams = z.object({ id: uuidSchema });

/** Uploads that never completed are cleaned up after a day. */
const PENDING_TTL_HOURS = 24;

function assertMime(kind: AttachmentKind, mime: string): void {
  const allowed = ALLOWED_MIME[kind];
  if (allowed.length === 0) return; // `file` accepts anything
  const normalised = mime.split(';')[0]!.trim().toLowerCase();
  if (!allowed.includes(normalised)) {
    throw unsupportedMedia(`${mime} ist für ${kind} nicht erlaubt`);
  }
}

function parseRange(header: string | undefined, totalSize: number | null): ByteRange | null {
  if (!header || !header.startsWith('bytes=')) return null;
  const [startRaw, endRaw] = header.slice(6).split('-');
  const start = Number.parseInt(startRaw ?? '', 10);
  const end = endRaw ? Number.parseInt(endRaw, 10) : undefined;
  if (Number.isNaN(start)) {
    // Suffix range ("bytes=-500") – only answerable when the size is known.
    if (end != null && totalSize != null) return { start: Math.max(0, totalSize - end) };
    return null;
  }
  return { start, end: end != null && !Number.isNaN(end) ? end : undefined };
}

export default defineModule({
  key: 'media',
  description: 'Uploads, Auslieferung und Streaming von Medien',
  register(app: FastifyInstance, ctx: AppContext) {
    const { sql, storage, env } = ctx;

    app.post('/media/uploads', { preHandler: app.authenticate }, async (request, reply) => {
      const userId = requireUserId(request);
      const input = parseBody(createUploadSchema, request);

      assertMime(input.kind, input.mime);
      const limit = LIMITS.maxUploadBytes[input.kind];
      if (input.size > limit) {
        throw tooLarge(`Maximal ${Math.round(limit / 1024 / 1024)} MB für ${input.kind}`);
      }

      const fileName = input.fileName?.slice(0, 200) ?? null;
      const extension = extensionOf(fileName) ?? extensionForMime(input.mime);
      const storageKey = storageKeyFor(input.kind, userId, `x${extension}`);
      const attachmentId = uuidv7();

      await sql`
        insert into attachments ${sql({
          id: attachmentId,
          uploaderId: userId,
          kind: input.kind,
          mime: input.mime,
          size: input.size,
          fileName,
          storageKey,
          status: 'pending',
        })}
      `;

      // Opportunistic housekeeping; cheap and keeps orphans from piling up.
      void sql`
        delete from attachments
        where status = 'pending'
          and message_id is null
          and created_at < now() - make_interval(hours => ${PENDING_TTL_HOURS})
      `.catch(() => {});

      if (storage.supportsPresignedUpload) {
        const target = await storage.createPresignedUpload(storageKey, input.mime, input.size);
        reply.status(201);
        return {
          attachmentId,
          strategy: 'presigned' as const,
          uploadUrl: target.url,
          headers: target.headers,
          expiresAt: target.expiresAt.toISOString(),
        };
      }

      reply.status(201);
      return {
        attachmentId,
        strategy: 'direct' as const,
        uploadUrl: `${env.PUBLIC_API_URL.replace(/\/$/, '')}${API_PREFIX}/media/uploads/${attachmentId}/data`,
        headers: {},
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      };
    });

    app.post('/media/uploads/:id/data', { preHandler: app.authenticate }, async (request) => {
      const userId = requireUserId(request);
      const { id } = parseParams(idParams, request);
      const attachment = await requireOwnPending(ctx, id, userId);

      const file = await request.file();
      if (!file) throw badRequest('Es wurde keine Datei übertragen');

      await storage.put(attachment.storageKey, file.file, attachment.mime);
      if (file.file.truncated) {
        await storage.delete(attachment.storageKey).catch(() => {});
        await sql`delete from attachments where id = ${id}`;
        throw tooLarge('Datei überschreitet das Upload-Limit');
      }

      const rows = await sql<AttachmentRow[]>`
        update attachments set status = 'ready', file_name = coalesce(file_name, ${file.filename ?? null})
        where id = ${id}
        returning *
      `;
      return toAttachmentDto(rows[0]!);
    });

    app.post('/media/uploads/:id/complete', { preHandler: app.authenticate }, async (request) => {
      const userId = requireUserId(request);
      const { id } = parseParams(idParams, request);
      const input = parseBody(completeUploadSchema, request);
      const attachment = await requireOwn(ctx, id, userId);

      if (input.previewDataUrl && input.previewDataUrl.length > LIMITS.previewDataUrlMax) {
        throw badRequest('Vorschaubild ist zu groß');
      }

      const patch: Record<string, unknown> = { status: 'ready' };
      if (input.width != null) patch.width = input.width;
      if (input.height != null) patch.height = input.height;
      if (input.durationMs != null) patch.durationMs = input.durationMs;
      if (input.waveform != null) patch.waveform = sql.json(input.waveform as never);
      if (input.previewDataUrl != null) patch.previewDataUrl = input.previewDataUrl;

      const rows = await sql<AttachmentRow[]>`
        update attachments set ${sql(patch)} where id = ${attachment.id} returning *
      `;
      return toAttachmentDto(rows[0]!);
    });

    /**
     * Delivery. The attachment id is a UUID v7 with 74 random bits and acts as a
     * capability URL, so <img>, <video> and the service-worker cache work without
     * an Authorization header. Nothing is listed or guessable.
     */
    app.get('/media/:id', async (request, reply) => deliver(ctx, request, reply, false));
    app.get('/media/:id/download', async (request, reply) => deliver(ctx, request, reply, true));

    app.delete('/media/:id', { preHandler: app.authenticate }, async (request, reply) => {
      const userId = requireUserId(request);
      const { id } = parseParams(idParams, request);
      const attachment = await requireOwn(ctx, id, userId);
      if (attachment.messageId) throw forbidden('Bereits gesendete Anhänge können nicht gelöscht werden');
      await storage.delete(attachment.storageKey).catch(() => {});
      await sql`delete from attachments where id = ${id}`;
      reply.status(204);
      return null;
    });
  },
});

async function loadAttachment(ctx: AppContext, id: string): Promise<AttachmentRow> {
  const rows = await ctx.sql<AttachmentRow[]>`select * from attachments where id = ${id}`;
  const row = rows[0];
  if (!row) throw notFound('Datei nicht gefunden');
  return row;
}

async function requireOwn(ctx: AppContext, id: string, userId: string): Promise<AttachmentRow> {
  const attachment = await loadAttachment(ctx, id);
  if (attachment.uploaderId !== userId) throw forbidden('Fremder Upload');
  return attachment;
}

async function requireOwnPending(ctx: AppContext, id: string, userId: string): Promise<AttachmentRow> {
  const attachment = await requireOwn(ctx, id, userId);
  if (attachment.status === 'ready' && attachment.messageId) {
    throw badRequest('Upload wurde bereits abgeschlossen');
  }
  return attachment;
}

async function deliver(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
  download: boolean,
): Promise<unknown> {
  const { id } = parseParams(idParams, request);
  const attachment = await loadAttachment(ctx, id);

  const signed = await ctx.storage.createDownloadUrl(attachment.storageKey, {
    fileName: attachment.fileName,
    mime: attachment.mime,
    download,
  });
  if (signed) {
    // R2/S3 serve the bytes directly – never proxy media through the API.
    return reply.header('cache-control', 'private, max-age=60').redirect(signed, 302);
  }

  const rangeHeader = request.headers.range;
  const probe = rangeHeader ? await ctx.storage.createReadStream(attachment.storageKey) : null;
  const totalSize = probe?.totalSize ?? null;
  if (probe) probe.stream.destroy();

  const range = parseRange(rangeHeader, totalSize);
  const object = await ctx.storage.createReadStream(attachment.storageKey, range ?? undefined);
  if (!object) throw notFound('Datei nicht gefunden');

  reply
    .header('content-type', object.mime ?? attachment.mime)
    .header('cache-control', 'private, max-age=31536000, immutable')
    .header('accept-ranges', 'bytes')
    .header('x-content-type-options', 'nosniff');

  if (download) {
    const name = (attachment.fileName ?? 'datei').replace(/[^\w.\- ]+/g, '_');
    reply.header('content-disposition', `attachment; filename="${name}"`);
  }

  if (range && object.totalSize != null) {
    const start = range.start;
    const end = range.end ?? object.totalSize - 1;
    reply
      .status(206)
      .header('content-range', `bytes ${start}-${end}/${object.totalSize}`)
      .header('content-length', String(object.size ?? end - start + 1));
  } else if (object.size != null) {
    reply.header('content-length', String(object.size));
  }

  return reply.send(object.stream);
}
