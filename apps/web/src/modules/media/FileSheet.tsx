import { useState, type ChangeEvent } from 'react';
import { LIMITS, formatBytes } from '@initiative/shared';
import { Sheet } from '../../components/Sheet.js';
import { EmptyState } from '../../components/Feedback.js';
import type { ComposerActionProps } from '../types.js';
import {
  buildAttachment,
  fileIconFor,
  mimeForFile,
  sendMedia,
  withinUploadLimit,
} from './helpers.js';

/** Any file, checked against the shared upload ceiling before it is queued. */
export function FileSheet({ conversationId, onClose }: ComposerActionProps) {
  const [file, setFile] = useState<File | null>(null);
  const [caption, setCaption] = useState('');
  const [sending, setSending] = useState(false);

  const pick = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0] ?? null;
    event.target.value = '';
    if (!chosen) return;
    if (!withinUploadLimit('file', chosen.size, chosen.name)) return;
    setFile(chosen);
  };

  const send = async () => {
    if (!file || sending) return;
    setSending(true);
    const ok = await sendMedia(conversationId, 'file', caption, [
      buildAttachment({
        kind: 'file',
        mime: mimeForFile(file),
        fileName: file.name,
        blob: file,
      }),
    ]);
    setSending(false);
    if (ok) onClose();
  };

  return (
    <Sheet open onClose={onClose} title="Datei senden">
      <label className="btn btn-primary btn-block">
        {file ? 'Andere Datei wählen' : 'Datei auswählen'}
        <input type="file" className="media-visually-hidden" onChange={pick} />
      </label>

      {file ? (
        <>
          <div className="card media-file-card">
            <span className="media-file-icon" aria-hidden="true">
              {fileIconFor(mimeForFile(file), file.name)}
            </span>
            <span className="media-file-text">
              <span className="media-file-name truncate">{file.name}</span>
              <span className="media-file-meta">{formatBytes(file.size)}</span>
            </span>
          </div>

          <input
            className="input"
            value={caption}
            onChange={(event) => setCaption(event.target.value)}
            placeholder="Nachricht dazu (optional)"
            aria-label="Nachricht zur Datei"
          />

          <button
            type="button"
            className="btn btn-primary btn-block"
            onClick={() => void send()}
            disabled={sending}
          >
            {sending ? 'Wird gesendet …' : 'Senden'}
          </button>
        </>
      ) : (
        <EmptyState
          emoji="📎"
          title="Noch keine Datei gewählt"
          description={`Dokumente, PDFs, Archive – bis zu ${formatBytes(LIMITS.maxUploadBytes.file)} pro Datei.`}
        />
      )}
    </Sheet>
  );
}
