import { z } from 'zod';
import { ATTACHMENT_KINDS, LIMITS, type AttachmentKind } from '../constants.js';

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
  /**
   * Wie ungern diese Datei auf den grossen, langsamen Speicher wandert.
   *
   * `niedrig` heisst „darf sofort dorthin", `hoch` heisst „erst, wenn es gar
   * nicht anders geht". Die Einstellung hängt an der Datei, nicht am
   * Sammlungseintrag: Es gibt sie nur einmal.
   */
  prioritaet: Prioritaet;
  /**
   * Wo die Bytes gerade liegen. `fern` heisst: auf dem grossen Speicher, das
   * erste Laden dauert einen Moment länger.
   */
  ablage: 'lokal' | 'wandert' | 'fern';
  createdAt: string;
}

export const PRIORITAETEN = ['niedrig', 'normal', 'hoch'] as const;
export type Prioritaet = (typeof PRIORITAETEN)[number];

/** Was in der Oberfläche steht – und was es bedeutet. */
export const PRIORITAET_TEXT: Record<Prioritaet, { label: string; hinweis: string }> = {
  niedrig: {
    label: 'Niedrig',
    hinweis: 'Wandert sofort auf den grossen Speicher. Lädt dafür etwas langsamer.',
  },
  normal: {
    label: 'Normal',
    hinweis: 'Wandert, wenn der Platz knapp wird – ältere und grössere zuerst.',
  },
  hoch: {
    label: 'Hoch',
    hinweis: 'Bleibt so lange wie möglich schnell erreichbar.',
  },
};

export const prioritaetSetzenSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
  prioritaet: z.enum(PRIORITAETEN),
});
export type PrioritaetSetzenInput = z.infer<typeof prioritaetSetzenSchema>;

export const teilenSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(LIMITS.attachmentsPerMessage),
  conversationId: z.string().uuid(),
  body: z.string().max(2000).optional(),
});
export type TeilenInput = z.infer<typeof teilenSchema>;

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
