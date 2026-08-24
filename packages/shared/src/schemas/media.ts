import { z } from 'zod';
import { ATTACHMENT_KINDS, type AttachmentKind } from '../constants.js';

export interface AttachmentDto {
  id: string;
  kind: AttachmentKind;
  mime: string;
  size: number;
  fileName: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  /** Normalised 0..1 peaks for voice messages. */
  waveform: number[] | null;
  /** Tiny inline JPEG/WebP data URL for instant, offline-capable previews. */
  previewDataUrl: string | null;
  /** Relative API URL that redirects to (or streams) the stored object. */
  url: string;
  status: 'pending' | 'ready';
  createdAt: string;
}

export const createUploadSchema = z.object({
  kind: z.enum(ATTACHMENT_KINDS),
  mime: z.string().min(3).max(160),
  size: z.number().int().min(1),
  fileName: z.string().max(256).optional(),
});
export type CreateUploadInput = z.infer<typeof createUploadSchema>;

export interface CreateUploadResult {
  attachmentId: string;
  /**
   * `presigned` → PUT the raw body to `uploadUrl` (Cloudflare R2 / S3).
   * `direct`    → POST multipart/form-data to `uploadUrl` with field `file`.
   */
  strategy: 'presigned' | 'direct';
  uploadUrl: string;
  headers: Record<string, string>;
  expiresAt: string;
}

export const completeUploadSchema = z.object({
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  waveform: z.array(z.number().min(0).max(1)).max(512).optional(),
  previewDataUrl: z.string().startsWith('data:').max(64_000).optional(),
});
export type CompleteUploadInput = z.infer<typeof completeUploadSchema>;
