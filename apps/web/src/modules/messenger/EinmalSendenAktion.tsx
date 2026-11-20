import { useRef, useState } from 'react';
import { LIMITS } from '@initiative/shared';
import { Sheet } from '../../components/Sheet.js';
import { useChat } from '../../state/chat.js';
import { toast } from '../../state/ui.js';
import type { ComposerActionProps } from '../types.js';

/**
 * Ein Foto oder Video, das jeder Empfänger genau einmal öffnen kann.
 *
 * Aus der Galerie oder direkt mit der Kamera. Es entsteht absichtlich keine
 * Vorschau und keine Miniatur – die läge sonst dauerhaft im Verlauf. Der
 * Schalter steht standardmässig an; wer ihn abschaltet, sendet ein
 * gewöhnliches Foto/Video.
 */
export function EinmalSendenAktion({ conversationId, onClose }: ComposerActionProps) {
  const galerie = useRef<HTMLInputElement>(null);
  const kamera = useRef<HTMLInputElement>(null);
  const [einmal, setEinmal] = useState(true);

  async function gewaehlt(dateien: FileList | null) {
    const datei = dateien?.[0];
    if (!datei) return;
    const istVideo = datei.type.startsWith('video/');
    if (!istVideo && !datei.type.startsWith('image/')) {
      toast('Nur Fotos und Videos', 'error');
      return;
    }
    const art = istVideo ? 'video' : 'image';
    if (datei.size > LIMITS.maxUploadBytes[art]) {
      toast('Die Datei ist zu gross', 'error');
      return;
    }
    onClose();
    try {
      await useChat.getState().sendMessage(conversationId, {
        type: art,
        attachments: [{ kind: art, mime: datei.type, fileName: datei.name || art, blob: datei }],
        ...(einmal ? { metadata: { einmalAnsehen: true } } : {}),
      });
    } catch {
      toast('Senden hat nicht geklappt', 'error');
    }
  }

  return (
    <Sheet open onClose={onClose} title="Einmal ansehen">
      <div className="stack">
        <label className="list-row msg-stufe">
          <input type="checkbox" checked={einmal} onChange={(event) => setEinmal(event.target.checked)} />
          <span>
            Einmal ansehbar
            <small className="msg-action-hint">
              Jede Person kann es genau einmal öffnen. Keine Vorschau, kein Weiterleiten, kein
              Speichern.
            </small>
          </span>
        </label>
        <div className="row" style={{ gap: 'var(--space-2)' }}>
          <button type="button" className="btn" style={{ flex: 1 }} onClick={() => galerie.current?.click()}>
            🖼️ Galerie
          </button>
          <button type="button" className="btn" style={{ flex: 1 }} onClick={() => kamera.current?.click()}>
            📷 Kamera
          </button>
        </div>
        <p className="msg-hinweis-ehrlich" role="note">
          ⚠️ Bildschirmfotos und Abfotografieren lassen sich im Web nicht verhindern.
        </p>
        <input
          ref={galerie}
          type="file"
          accept="image/*,video/*"
          hidden
          aria-label="Foto oder Video aus der Galerie"
          onChange={(event) => void gewaehlt(event.target.files)}
        />
        <input
          ref={kamera}
          type="file"
          accept="image/*,video/*"
          capture="environment"
          hidden
          aria-label="Foto oder Video mit der Kamera"
          onChange={(event) => void gewaehlt(event.target.files)}
        />
      </div>
    </Sheet>
  );
}
