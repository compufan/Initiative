import { useEffect, useState } from 'react';
import { Sheet } from '../../components/Sheet.js';
import { toast } from '../../state/ui.js';
import type { MessageActionProps } from '../types.js';
import { errorMessage, stickerAufsGeraet, stickerSrc } from './helpers.js';

/**
 * Einen Sticker aus dem Chat auf dem Gerät speichern.
 *
 * Auch fremde: Wer einen Sticker geschickt bekommt, den er gut findet, soll
 * ihn behalten können, ohne die Absenderin zu fragen. Das Paket ist damit
 * nicht bei ihm – dafür gibt es die Bibliothek –, aber das Bild schon.
 *
 * Warum ein eigenes Blatt und nicht ein Knopf, der sofort lädt: Auf dem iPhone
 * geht das Speichern übers Teilen-Blatt, und das braucht eine frische
 * Nutzerhandlung. Ein Knopf, den man hier drückt, ist genau das; ein
 * Menüeintrag, der nebenbei etwas anstösst, wäre es nicht.
 */
export function SaveStickerSheet({ message, onClose }: MessageActionProps) {
  const sticker = message.sticker;
  const [laeuft, setLaeuft] = useState(false);
  const [fertig, setFertig] = useState(false);

  // Nach dem Speichern schliessen – aber nicht sofort, sonst sieht niemand,
  // dass es geklappt hat.
  useEffect(() => {
    if (!fertig) return undefined;
    const timer = window.setTimeout(onClose, 1200);
    return () => window.clearTimeout(timer);
  }, [fertig, onClose]);

  if (!sticker) {
    return (
      <Sheet open onClose={onClose} title="Sticker">
        <p className="muted">Dieser Sticker ist nicht mehr verfügbar.</p>
      </Sheet>
    );
  }

  async function speichern() {
    if (!sticker) return;
    setLaeuft(true);
    try {
      const weg = await stickerAufsGeraet(sticker.url);
      if (weg !== 'abgebrochen') setFertig(true);
    } catch (error) {
      toast(errorMessage(error, 'Speichern fehlgeschlagen'), 'error');
    } finally {
      setLaeuft(false);
    }
  }

  return (
    <Sheet open onClose={onClose} title="Sticker speichern">
      <div className="stk-save-preview">
        <img src={stickerSrc(sticker.url)} alt="" width={128} height={128} loading="lazy" />
      </div>
      <p className="muted stk-save-note">Aus dem Paket „{sticker.packName}“.</p>
      <button
        type="button"
        className="btn btn-primary btn-block"
        onClick={() => void speichern()}
        disabled={laeuft || fertig}
      >
        {fertig ? '✓ Gespeichert' : laeuft ? 'Wird gespeichert …' : '⬇ Aufs Handy speichern'}
      </button>
      <button type="button" className="btn btn-ghost btn-block" onClick={onClose}>
        Schließen
      </button>
    </Sheet>
  );
}
