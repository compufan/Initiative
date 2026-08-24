import type { Readable } from 'node:stream';
import type { AttachmentKind } from '@initiative/shared';

export interface PresignedUpload {
  url: string;
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface ObjectStream {
  stream: Readable;
  size: number | null;
  mime: string | null;
}

/**
 * Storage abstraction.
 *
 * `r2` / `s3` hand out presigned URLs so large media never passes through the
 * API container; `local` keeps files on disk for development and single-server
 * self-hosting. Adding another backend only means implementing this interface.
 */
export interface StorageDriver {
  readonly kind: 'r2' | 's3' | 'local';
  readonly supportsPresignedUpload: boolean;
  createPresignedUpload(key: string, mime: string, size: number): Promise<PresignedUpload>;
  /** Absolute URL for the client, or null when the API has to stream the bytes. */
  createDownloadUrl(
    key: string,
    options?: { fileName?: string | null; mime?: string | null; download?: boolean },
  ): Promise<string | null>;
  put(key: string, body: Buffer | Readable, mime: string): Promise<void>;
  createReadStream(key: string): Promise<ObjectStream | null>;
  delete(key: string): Promise<void>;
}

export function storageKeyFor(kind: AttachmentKind, ownerId: string, fileName?: string | null): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const ext = extensionOf(fileName) ?? '';
  const random = Math.random().toString(36).slice(2, 10);
  return `${kind}/${yyyy}/${mm}/${ownerId}/${Date.now().toString(36)}-${random}${ext}`;
}

export function extensionOf(fileName?: string | null): string | null {
  if (!fileName) return null;
  const match = /\.([a-z0-9]{1,8})$/i.exec(fileName);
  return match ? `.${match[1]!.toLowerCase()}` : null;
}

const MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'audio/webm': '.webm',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/wav': '.wav',
  'application/pdf': '.pdf',
};

export function extensionForMime(mime: string): string {
  return MIME_EXTENSIONS[mime.toLowerCase()] ?? '';
}
