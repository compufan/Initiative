import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { LIMITS, formatBytes, formatDuration } from '@initiative/shared';
import { Sheet } from '../../components/Sheet.js';
import { EmptyState, Spinner } from '../../components/Feedback.js';
import { prepareImage, videoPreview } from '../../lib/upload.js';
import type { ComposerActionProps } from '../types.js';
import { toast } from '../../state/ui.js';
import {
  buildAttachment,
  errorMessage,
  kindForFile,
  mimeForFile,
  sendMedia,
  withinUploadLimit,
} from './helpers.js';

interface GalleryItem {
  id: string;
  kind: 'image' | 'video';
  blob: Blob;
  mime: string;
  fileName: string;
  url: string;
  width?: number;
  height?: number;
  durationMs?: number;
  previewDataUrl?: string;
  size: number;
}

const MAX_SELECTION = 20;

/** Photo and video picker with a preview grid and one shared caption. */
export function GallerySheet({ conversationId, onClose }: ComposerActionProps) {
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [caption, setCaption] = useState('');
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const itemsRef = useRef<GalleryItem[]>([]);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  // Release every preview URL when the sheet closes.
  useEffect(
    () => () => {
      itemsRef.current.forEach((item) => URL.revokeObjectURL(item.url));
    },
    [],
  );

  const pick = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length === 0) return;

    setLoading(true);
    const next: GalleryItem[] = [];
    try {
      for (const file of files) {
        if (items.length + next.length >= MAX_SELECTION) {
          toast(`Es können höchstens ${MAX_SELECTION} Dateien auf einmal gesendet werden`, 'info');
          break;
        }
        const kind = kindForFile(file);
        if (kind !== 'image' && kind !== 'video') {
          toast(`„${file.name}“ ist kein Foto und kein Video`, 'error');
          continue;
        }
        if (!withinUploadLimit(kind, file.size, file.name)) continue;

        try {
          if (kind === 'image') {
            const prepared = await prepareImage(file);
            next.push({
              id: `${file.name}-${file.lastModified}-${next.length}`,
              kind,
              blob: prepared.blob,
              mime: prepared.mime,
              fileName: file.name,
              url: URL.createObjectURL(prepared.blob),
              width: prepared.width,
              height: prepared.height,
              previewDataUrl: prepared.previewDataUrl,
              size: prepared.blob.size,
            });
          } else {
            const preview = await videoPreview(file);
            next.push({
              id: `${file.name}-${file.lastModified}-${next.length}`,
              kind,
              blob: file,
              mime: mimeForFile(file),
              fileName: file.name,
              url: URL.createObjectURL(file),
              width: preview?.width,
              height: preview?.height,
              durationMs: preview?.durationMs,
              previewDataUrl: preview?.previewDataUrl,
              size: file.size,
            });
          }
        } catch (error) {
          toast(errorMessage(error, `„${file.name}“ konnte nicht gelesen werden`), 'error');
        }
      }
      if (next.length > 0) setItems((current) => [...current, ...next]);
    } finally {
      setLoading(false);
    }
  };

  const remove = (id: string) => {
    setItems((current) => {
      const hit = current.find((item) => item.id === id);
      if (hit) URL.revokeObjectURL(hit.url);
      return current.filter((item) => item.id !== id);
    });
  };

  const send = async () => {
    if (items.length === 0 || sending) return;
    setSending(true);
    try {
      const images = items.filter((item) => item.kind === 'image');
      const videos = items.filter((item) => item.kind === 'video');
      let captionUsed = false;

      for (let index = 0; index < images.length; index += LIMITS.attachmentsPerMessage) {
        const chunk = images.slice(index, index + LIMITS.attachmentsPerMessage);
        const ok = await sendMedia(
          conversationId,
          'image',
          captionUsed ? null : caption,
          chunk.map((item) =>
            buildAttachment({
              kind: 'image',
              mime: item.mime,
              fileName: item.fileName,
              blob: item.blob,
              width: item.width,
              height: item.height,
              previewDataUrl: item.previewDataUrl,
            }),
          ),
        );
        if (!ok) return;
        captionUsed = true;
      }

      for (const item of videos) {
        const ok = await sendMedia(conversationId, 'video', captionUsed ? null : caption, [
          buildAttachment({
            kind: 'video',
            mime: item.mime,
            fileName: item.fileName,
            blob: item.blob,
            width: item.width,
            height: item.height,
            durationMs: item.durationMs,
            previewDataUrl: item.previewDataUrl,
          }),
        ]);
        if (!ok) return;
        captionUsed = true;
      }

      onClose();
    } finally {
      setSending(false);
    }
  };

  const totalSize = items.reduce((sum, item) => sum + item.size, 0);

  return (
    <Sheet open onClose={onClose} title="Foto oder Video">
      <label className="btn btn-primary btn-block">
        {items.length === 0 ? 'Dateien auswählen' : 'Weitere auswählen'}
        <input
          type="file"
          accept="image/*,video/*"
          multiple
          className="media-visually-hidden"
          onChange={(event) => void pick(event)}
        />
      </label>

      {loading && <Spinner label="Vorschau wird erstellt …" />}

      {!loading && items.length === 0 && (
        <EmptyState
          emoji="🖼️"
          title="Noch nichts ausgewählt"
          description="Wähle Fotos oder Videos aus deiner Galerie. Mehrfachauswahl ist möglich."
        />
      )}

      {items.length > 0 && (
        <>
          <div className="media-grid media-grid-3">
            {items.map((item) => (
              <div key={item.id} className="media-tile">
                {item.kind === 'image' ? (
                  <img src={item.url} alt={item.fileName} />
                ) : (
                  <>
                    {item.previewDataUrl ? (
                      <img src={item.previewDataUrl} alt={item.fileName} />
                    ) : (
                      <span className="media-tile-fallback" aria-hidden="true">
                        🎬
                      </span>
                    )}
                    <span className="media-badge">
                      ▶ {item.durationMs ? formatDuration(item.durationMs) : 'Video'}
                    </span>
                  </>
                )}
                <button
                  type="button"
                  className="media-tile-remove"
                  onClick={() => remove(item.id)}
                  aria-label={`${item.fileName} entfernen`}
                >
                  <span className="media-tile-x" aria-hidden="true">
                    ✕
                  </span>
                </button>
              </div>
            ))}
          </div>

          <p className="muted" style={{ margin: 0, fontSize: '0.82rem' }}>
            {items.length} {items.length === 1 ? 'Datei' : 'Dateien'} · {formatBytes(totalSize)}
          </p>

          <input
            className="input"
            value={caption}
            onChange={(event) => setCaption(event.target.value)}
            placeholder="Bildunterschrift (optional)"
            aria-label="Bildunterschrift"
          />

          <button
            type="button"
            className="btn btn-primary btn-block"
            onClick={() => void send()}
            disabled={sending}
          >
            {sending ? 'Wird gesendet …' : `Senden (${items.length})`}
          </button>
        </>
      )}
    </Sheet>
  );
}
