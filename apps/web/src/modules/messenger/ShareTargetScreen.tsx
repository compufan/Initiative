import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { formatBytes } from '@initiative/shared';
import { Avatar } from '../../components/Avatar.js';
import { EmptyState, Spinner } from '../../components/Feedback.js';
import { Screen } from '../../components/Screen.js';
import type { OutboxAttachment } from '../../lib/db.js';
import { prepareImage, videoPreview } from '../../lib/upload.js';
import { useChat } from '../../state/chat.js';
import { useSession } from '../../state/session.js';
import { toast } from '../../state/ui.js';
import { conversationTitle } from './helpers.js';

/**
 * Ziel des System-Teilen-Dialogs.
 *
 * Das Manifest meldet `/teilen` als `share_target` an; der Service Worker nimmt
 * den POST entgegen, legt Text und Dateien beiseite und leitet hierher um. Diese
 * Seite holt sich die Ablage ab und lässt einen Chat auswählen.
 */

interface SharePayload {
  title: string;
  text: string;
  url: string;
  files: File[];
}

const MAX_FILES = 10;

async function readShare(id: string): Promise<SharePayload | null> {
  if (!('serviceWorker' in navigator)) return null;
  const registration = await navigator.serviceWorker.ready;
  const worker = registration.active;
  if (!worker) return null;

  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = window.setTimeout(() => resolve(null), 4000);
    channel.port1.onmessage = (event) => {
      window.clearTimeout(timer);
      resolve((event.data as SharePayload | null) ?? null);
    };
    worker.postMessage({ type: 'GET_SHARE', id }, [channel.port2]);
  });
}

function kindOf(file: File): OutboxAttachment['kind'] {
  const mime = file.type.toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

/** Bereitet eine geteilte Datei so auf, wie es der Composer auch täte. */
async function toAttachment(file: File): Promise<OutboxAttachment> {
  const kind = kindOf(file);
  const fileName = file.name || `geteilt-${Date.now()}`;

  if (kind === 'image') {
    try {
      const prepared = await prepareImage(file);
      return {
        kind,
        mime: prepared.mime,
        fileName,
        blob: prepared.blob,
        width: prepared.width,
        height: prepared.height,
        previewDataUrl: prepared.previewDataUrl,
      };
    } catch {
      // Exotische Formate (HEIC auf manchen Geräten) gehen unverändert raus.
    }
  }

  if (kind === 'video') {
    const preview = await videoPreview(file);
    return {
      kind,
      mime: file.type || 'video/mp4',
      fileName,
      blob: file,
      ...(preview
        ? {
            width: preview.width,
            height: preview.height,
            durationMs: preview.durationMs,
            previewDataUrl: preview.previewDataUrl,
          }
        : {}),
    };
  }

  return { kind, mime: file.type || 'application/octet-stream', fileName, blob: file };
}

export function ShareTargetScreen() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const shareId = params.get('share');

  const [payload, setPayload] = useState<SharePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState<string | null>(null);

  const conversations = useChat((state) => state.conversations);
  const presence = useChat((state) => state.presence);
  const myId = useSession((state) => state.user?.id ?? '');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Ohne id (oder ohne laufenden Service Worker) bleibt nur der Fallback
      // über die Query-Parameter, die manche Systeme direkt anhängen.
      const fromWorker = shareId ? await readShare(shareId) : null;
      if (cancelled) return;
      setPayload(
        fromWorker ?? {
          title: params.get('title') ?? '',
          text: params.get('text') ?? '',
          url: params.get('url') ?? '',
          files: [],
        },
      );
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [shareId, params]);

  const caption = useMemo(() => {
    if (!payload) return '';
    return [payload.title, payload.text, payload.url]
      .map((part) => part.trim())
      .filter(Boolean)
      .join('\n');
  }, [payload]);

  const files = payload?.files.slice(0, MAX_FILES) ?? [];
  const nothingToShare = !loading && files.length === 0 && caption.length === 0;

  async function shareWith(conversationId: string) {
    if (!payload || sending) return;
    setSending(conversationId);
    try {
      const attachments = await Promise.all(files.map(toAttachment));
      // Der Typ richtet sich nach dem ersten Anhang; ohne Anhang wird es Text.
      await useChat.getState().sendMessage(conversationId, {
        type: attachments[0]?.kind ?? 'text',
        body: caption || null,
        attachments,
      });
      navigate(`/chats/${conversationId}`, { replace: true });
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Teilen fehlgeschlagen', 'error');
      setSending(null);
    }
  }

  return (
    <Screen title="Teilen" subtitle="In welchen Chat?" back="/chats">
      {loading && <Spinner label="Geteilte Inhalte werden gelesen …" />}

      {nothingToShare && (
        <EmptyState
          emoji="📭"
          title="Nichts zum Teilen"
          description="Der Inhalt ist nicht mehr verfügbar. Teile ihn noch einmal aus der anderen App."
        />
      )}

      {!loading && !nothingToShare && (
        <>
          <div className="card stack">
            <strong>Das wird gesendet</strong>
            {caption && <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{caption}</p>}
            {files.length > 0 && (
              <ul className="stack" style={{ margin: 0, padding: 0, listStyle: 'none' }}>
                {files.map((file, index) => (
                  <li key={`${file.name}-${index}`} className="row" style={{ gap: 10 }}>
                    <span aria-hidden="true">
                      {kindOf(file) === 'image' ? '🖼️' : kindOf(file) === 'video' ? '🎬' : '📎'}
                    </span>
                    <span className="truncate">{file.name || 'Datei'}</span>
                    <span className="faint" style={{ marginLeft: 'auto' }}>
                      {formatBytes(file.size)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {conversations.length === 0 ? (
            <EmptyState
              emoji="💬"
              title="Noch keine Chats"
              description="Lege zuerst einen Chat an, dann kannst du hierher teilen."
            />
          ) : (
            <div className="card list" style={{ padding: 0, overflow: 'hidden' }}>
              {conversations.map((conversation) => {
                const counterpart =
                  conversation.type === 'direct'
                    ? conversation.members.find((member) => member.userId !== myId)?.user
                    : undefined;
                return (
                  <button
                    key={conversation.id}
                    type="button"
                    className="list-row"
                    disabled={sending != null}
                    onClick={() => void shareWith(conversation.id)}
                  >
                    <Avatar
                      name={conversationTitle(conversation, myId)}
                      id={counterpart?.id ?? conversation.id}
                      url={counterpart?.avatarUrl ?? conversation.avatarUrl}
                      online={counterpart ? presence[counterpart.id]?.online : undefined}
                    />
                    <span className="truncate" style={{ flex: 1, fontWeight: 600 }}>
                      {conversationTitle(conversation, myId)}
                    </span>
                    {sending === conversation.id ? (
                      <span className="spinner" aria-label="Wird gesendet" />
                    ) : (
                      <span className="faint" aria-hidden="true">
                        ›
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}
    </Screen>
  );
}
