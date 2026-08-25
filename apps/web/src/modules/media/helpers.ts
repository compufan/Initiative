import { useEffect, useState } from 'react';
import {
  LIMITS,
  formatBytes,
  type AttachmentDto,
  type AttachmentKind,
  type MessageType,
} from '@initiative/shared';
import { API_BASE } from '../../lib/api.js';
import type { OutboxAttachment } from '../../lib/db.js';
import { useChat } from '../../state/chat.js';
import { toast } from '../../state/ui.js';

/**
 * Small helpers shared by the media sheets and the chat bubbles. Everything
 * that touches the browser media APIs is funnelled through here so the
 * components stay readable and the quirks (codec suffixes, iOS fallbacks,
 * upload limits) live in exactly one place.
 */

/** `video/webm;codecs=vp9` → `video/webm` – the API only allows bare mime types. */
export function baseMime(mime: string): string {
  return (mime || '').split(';')[0].trim().toLowerCase();
}

/** Attachment URLs are relative to the API, which may live on another host. */
export function mediaSrc(attachment: AttachmentDto): string {
  const url = attachment.url;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//')) return url;
  return `${API_BASE}${url}`;
}

/**
 * Die Bilddaten eines Anhangs – zum Lesen, nicht zum Anzeigen.
 *
 * `mediaSrc` reicht für `<img src>`: Der Browser folgt der Umleitung zum
 * Speicher und zeigt an. Wer die Punkte *lesen* will (bearbeiten, freistellen),
 * braucht den geraden Weg über die API: Nach einer Umleitung auf eine andere
 * Herkunft schickt der Browser `Origin: null`, die CORS-Regel des Speichers
 * greift nicht mehr, und die Leinwand wäre anschliessend „verunreinigt“ – man
 * sähe das Bild, könnte es aber nicht speichern.
 */
export async function mediaBytes(attachment: AttachmentDto): Promise<Blob> {
  // Ohne `credentials`: Die Medienrouten kennen keinen angemeldeten Benutzer,
  // die Anhangskennung ist der Schluessel. Steht `CORS_ORIGINS` auf `*`,
  // schaltet der Server `allow_credentials(false)` – eine Anfrage mit
  // Anmeldedaten wuerde dann vom Browser verworfen.
  const antwort = await fetch(`${mediaSrc(attachment)}/bytes`);
  if (!antwort.ok) throw new Error(`Das Bild konnte nicht geladen werden (${antwort.status})`);
  return await antwort.blob();
}

/**
 * Dieselbe Datei, aber zum Speichern statt zum Anzeigen.
 *
 * Ein `download`-Attribut an einem Verweis wird von jedem Browser ignoriert,
 * wenn das Ziel auf einer anderen Herkunft liegt – und die API liegt das. Der
 * Verweis oeffnete die Datei also, statt sie zu sichern, und in der
 * installierten App auf dem iPhone geschah gar nichts.
 *
 * Die API kann es besser: `/download` schickt `Content-Disposition:
 * attachment`, und daran haelt sich jeder Browser. Kein Umweg ueber den
 * Speicher der App, kein Blob im Arbeitsspeicher – auch ein Video von 300 MB
 * geht so.
 */
export function mediaDownloadSrc(attachment: AttachmentDto): string {
  return `${mediaSrc(attachment)}/download`;
}

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'audio/webm': 'webm',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
};

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  heic: 'image/heic',
  heif: 'image/heic',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  pdf: 'application/pdf',
};

function extensionOf(fileName: string | null | undefined): string {
  if (!fileName || !fileName.includes('.')) return '';
  const parts = fileName.split('.');
  return (parts[parts.length - 1] || '').toLowerCase();
}

export function extensionFor(mime: string): string {
  const base = baseMime(mime);
  const known = EXTENSIONS[base];
  if (known) return known;
  const parts = base.split('/');
  const guess = (parts[1] || '').replace(/[^a-z0-9]/g, '');
  return guess.length > 0 ? guess : 'bin';
}

/** `foto-20260824-101500.webp` – readable in every downloads folder. */
export function timestampName(prefix: string, mime: string): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${prefix}-${stamp}.${extensionFor(mime)}`;
}

export function kindForFile(file: File): AttachmentKind {
  const mime = baseMime(file.type);
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  const mapped = MIME_BY_EXTENSION[extensionOf(file.name)];
  if (mapped?.startsWith('image/')) return 'image';
  if (mapped?.startsWith('video/')) return 'video';
  if (mapped?.startsWith('audio/')) return 'audio';
  return 'file';
}

/** Android sometimes hands over files without a mime type. */
export function mimeForFile(file: File): string {
  if (file.type) return baseMime(file.type);
  return MIME_BY_EXTENSION[extensionOf(file.name)] ?? 'application/octet-stream';
}

export function fileIconFor(mime: string, fileName?: string | null): string {
  const base = baseMime(mime);
  const ext = extensionOf(fileName);
  if (base.startsWith('image/')) return '🖼️';
  if (base.startsWith('video/')) return '🎬';
  if (base.startsWith('audio/')) return '🎧';
  if (base === 'application/pdf' || ext === 'pdf') return '📕';
  if (
    base.includes('zip') ||
    base.includes('compressed') ||
    ['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)
  )
    return '🗜️';
  if (base.includes('word') || ['doc', 'docx', 'odt', 'rtf'].includes(ext)) return '📘';
  if (
    base.includes('sheet') ||
    base.includes('excel') ||
    ['xls', 'xlsx', 'ods', 'csv'].includes(ext)
  )
    return '📗';
  if (
    base.includes('presentation') ||
    base.includes('powerpoint') ||
    ['ppt', 'pptx', 'odp'].includes(ext)
  )
    return '📙';
  if (base.includes('calendar') || ext === 'ics') return '📅';
  if (base.startsWith('text/') || ['txt', 'md', 'json', 'xml', 'log'].includes(ext)) return '📄';
  return '📎';
}

/** mm:ss for running recordings. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export function deviceErrorMessage(error: unknown, device: 'Kamera' | 'Mikrofon'): string {
  const name = error instanceof Error ? error.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return `Du hast den Zugriff auf ${device === 'Kamera' ? 'die Kamera' : 'das Mikrofon'} nicht erlaubt. Du kannst ihn in den Browser-Einstellungen freigeben.`;
    case 'NotFoundError':
    case 'OverconstrainedError':
      return `${device} wurde nicht gefunden.`;
    case 'NotReadableError':
    case 'AbortError':
      return `${device} wird gerade von einer anderen App benutzt.`;
    default:
      return `${device} konnte nicht gestartet werden.`;
  }
}

/** Checks the shared upload ceiling and explains the rejection. */
export function withinUploadLimit(
  kind: AttachmentKind,
  size: number,
  name?: string | null,
): boolean {
  const max = LIMITS.maxUploadBytes[kind];
  if (size <= max) return true;
  const subject = name ? `„${name}“` : 'Die Datei';
  toast(`${subject} ist zu groß (${formatBytes(size)}, erlaubt sind ${formatBytes(max)})`, 'error');
  return false;
}

export function supportsRecorder(): boolean {
  return typeof window !== 'undefined' && typeof window.MediaRecorder !== 'undefined';
}

export function supportsCapture(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);
}

export const VIDEO_MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4',
];

/** iOS Safari only ever records `audio/mp4`. */
export const AUDIO_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/aac',
];

export function pickRecorderMime(candidates: string[]): string | null {
  if (!supportsRecorder() || typeof MediaRecorder.isTypeSupported !== 'function') return null;
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? null;
}

/** Drops empty metadata so the server-side upload schema stays happy. */
export function buildAttachment(input: OutboxAttachment): OutboxAttachment {
  const attachment: OutboxAttachment = {
    kind: input.kind,
    mime: baseMime(input.mime) || 'application/octet-stream',
    fileName: input.fileName,
    blob: input.blob,
  };
  if (input.width && input.width > 0) attachment.width = Math.round(input.width);
  if (input.height && input.height > 0) attachment.height = Math.round(input.height);
  if (input.durationMs && input.durationMs > 0)
    attachment.durationMs = Math.round(input.durationMs);
  if (input.waveform && input.waveform.length > 0) attachment.waveform = input.waveform;
  if (input.previewDataUrl && input.previewDataUrl.length <= LIMITS.previewDataUrlMax) {
    attachment.previewDataUrl = input.previewDataUrl;
  }
  return attachment;
}

/**
 * Hands the media over to the chat store, which uploads it (also offline, via
 * the outbox). Modules never talk to `api.media` directly.
 */
export async function sendMedia(
  conversationId: string,
  type: MessageType,
  caption: string | null,
  attachments: OutboxAttachment[],
): Promise<boolean> {
  try {
    await useChat.getState().sendMessage(conversationId, {
      type,
      body: caption && caption.trim().length > 0 ? caption.trim() : null,
      attachments,
    });
    return true;
  } catch (error) {
    toast(errorMessage(error, 'Senden fehlgeschlagen'), 'error');
    return false;
  }
}

/** Object URL for a blob that is revoked as soon as the blob changes. */
export function useObjectUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return undefined;
    }
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return url;
}

/** Only one voice message / video plays at a time. */
let activePlayback: HTMLMediaElement | null = null;

export function claimPlayback(element: HTMLMediaElement): void {
  if (activePlayback && activePlayback !== element) activePlayback.pause();
  activePlayback = element;
}

export function releasePlayback(element: HTMLMediaElement): void {
  if (activePlayback === element) activePlayback = null;
}

/** Stable pseudo waveform for older voice messages without stored peaks. */
export function fallbackPeaks(seed: string, count = 48): number[] {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  const peaks: number[] = [];
  for (let i = 0; i < count; i += 1) {
    hash = (hash * 1664525 + 1013904223) >>> 0;
    peaks.push(0.25 + ((hash >>> 8) % 1000) / 1400);
  }
  return peaks;
}
