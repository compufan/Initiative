import type { AttachmentDto } from '@initiative/shared';
import { api } from './api.js';
import type { OutboxAttachment } from './db.js';

/**
 * Two-step upload:
 * 1. ask the API for a target (presigned PUT on R2/S3, or a direct POST when the
 *    server stores files locally),
 * 2. report the metadata so the attachment becomes usable in a message.
 */
/** Nach dieser Zeit gilt ein Upload als gescheitert statt weiter zu hängen. */
const UPLOAD_TIMEOUT_MS = 120_000;

export async function uploadBlob(attachment: OutboxAttachment): Promise<AttachmentDto> {
  const target = await api.media.createUpload({
    kind: attachment.kind,
    mime: attachment.mime,
    size: attachment.blob.size,
    fileName: attachment.fileName,
  });

  if (target.strategy === 'presigned') {
    let response: Response;
    try {
      response = await fetch(target.uploadUrl, {
        method: 'PUT',
        headers: target.headers,
        body: attachment.blob,
        // Ohne Zeitlimit bleibt ein hängender Upload für immer „wird
        // gesendet“ – die Nachricht liess sich dann weder senden noch
        // loswerden.
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new Error(
          `Upload abgebrochen: Der Speicher hat innerhalb von ${Math.round(UPLOAD_TIMEOUT_MS / 1000)} Sekunden nicht geantwortet.`,
        );
      }
      // Der Browser lädt hier direkt in den Bucket. Fehlt dort die CORS-Regel
      // für diese Domain, bricht er ohne Statuscode ab – die blanke
      // fetch-Meldung ("Failed to fetch") sagt niemandem, was zu tun ist.
      throw new Error(
        'Upload zum Speicher blockiert. Meist fehlt im Bucket die CORS-Regel für ' +
          `${window.location.origin} (AllowedMethods PUT und GET, AllowedHeaders content-type). ` +
          `Ursprüngliche Meldung: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok) throw new Error(`Upload fehlgeschlagen (${response.status})`);
    return api.media.completeUpload(target.attachmentId, {
      width: attachment.width,
      height: attachment.height,
      durationMs: attachment.durationMs,
      waveform: attachment.waveform,
      previewDataUrl: attachment.previewDataUrl,
    });
  }

  await api.media.uploadData(target.attachmentId, attachment.blob, attachment.fileName);
  return api.media.completeUpload(target.attachmentId, {
    width: attachment.width,
    height: attachment.height,
    durationMs: attachment.durationMs,
    waveform: attachment.waveform,
    previewDataUrl: attachment.previewDataUrl,
  });
}

export interface PreparedImage {
  blob: Blob;
  mime: string;
  width: number;
  height: number;
  previewDataUrl: string;
}

async function loadBitmap(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(blob);
    } catch {
      /* fall through to the <img> path (older iOS, HEIC) */
    }
  }
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(blob);
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Bild konnte nicht gelesen werden'));
    };
    image.src = url;
  });
}

function drawTo(
  source: ImageBitmap | HTMLImageElement,
  width: number,
  height: number,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas nicht verfügbar');
  context.imageSmoothingQuality = 'high';
  context.drawImage(source as CanvasImageSource, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function toBlob(canvas: HTMLCanvasElement, mime: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Bild konnte nicht kodiert werden'))),
      mime,
      quality,
    );
  });
}

async function supportsWebp(): Promise<boolean> {
  if (webpSupport != null) return webpSupport;
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  webpSupport = canvas.toDataURL('image/webp').startsWith('data:image/webp');
  return webpSupport;
}
let webpSupport: boolean | null = null;

/**
 * Downscale a photo before upload and build the tiny inline preview that makes
 * chats render instantly (and readable offline).
 */
export async function prepareImage(file: Blob, maxDimension = 1920): Promise<PreparedImage> {
  const source = await loadBitmap(file);
  const naturalWidth = 'width' in source ? source.width : 0;
  const naturalHeight = 'height' in source ? source.height : 0;
  const scale = Math.min(1, maxDimension / Math.max(naturalWidth, naturalHeight || 1));
  const width = Math.round(naturalWidth * scale);
  const height = Math.round(naturalHeight * scale);

  const mime = (await supportsWebp()) ? 'image/webp' : 'image/jpeg';
  const full = await toBlob(drawTo(source, width, height), mime, 0.82);

  const previewScale = Math.min(1, 48 / Math.max(width, height || 1));
  const preview = drawTo(source, width * previewScale, height * previewScale);
  const previewDataUrl = preview.toDataURL('image/jpeg', 0.5);

  if ('close' in source) source.close();
  return { blob: full, mime, width, height, previewDataUrl };
}

/** First frame of a video, used as poster image and offline preview. */
export async function videoPreview(
  file: Blob,
): Promise<{ previewDataUrl: string; width: number; height: number; durationMs: number } | null> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(file);
    let settled = false;

    const finish = (value: Awaited<ReturnType<typeof videoPreview>>) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      resolve(value);
    };

    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    video.src = url;

    video.onloadeddata = () => {
      try {
        video.currentTime = Math.min(0.1, (video.duration || 1) / 4);
      } catch {
        finish(null);
      }
    };
    video.onseeked = () => {
      try {
        const scale = Math.min(1, 64 / Math.max(video.videoWidth, video.videoHeight || 1));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
        finish({
          previewDataUrl: canvas.toDataURL('image/jpeg', 0.5),
          width: video.videoWidth,
          height: video.videoHeight,
          durationMs: Math.round((video.duration || 0) * 1000),
        });
      } catch {
        finish(null);
      }
    };
    video.onerror = () => finish(null);
    setTimeout(() => finish(null), 8000);
  });
}

/** Normalised peaks (0..1) for the voice-message waveform. */
export async function waveformFromBlob(blob: Blob, buckets = 64): Promise<number[]> {
  const AudioCtor: typeof AudioContext | undefined =
    window.AudioContext ??
    (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtor) return [];
  const context = new AudioCtor();
  try {
    const buffer = await context.decodeAudioData(await blob.arrayBuffer());
    const channel = buffer.getChannelData(0);
    const size = Math.floor(channel.length / buckets) || 1;
    const peaks: number[] = [];
    for (let i = 0; i < buckets; i += 1) {
      let peak = 0;
      for (let j = 0; j < size; j += 1) {
        const value = Math.abs(channel[i * size + j] ?? 0);
        if (value > peak) peak = value;
      }
      peaks.push(peak);
    }
    const max = Math.max(...peaks, 0.001);
    return peaks.map((peak) => Math.min(1, Number((peak / max).toFixed(3))));
  } catch {
    return [];
  } finally {
    void context.close();
  }
}
