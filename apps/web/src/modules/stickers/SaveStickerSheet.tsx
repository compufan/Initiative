import { useEffect, useState } from 'react';
import { Sheet } from '../../components/Sheet.js';
import { herunterladen } from '../../lib/herunterladen.js';
import { toast } from '../../state/ui.js';
import type { MessageActionProps } from '../types.js';
import { errorMessage, stickerBytes, stickerFileName, stickerSrc } from './helpers.js';

/**
 * Einen Sticker aus dem Chat auf dem Gerät speichern.
 *
 * Auch fremde: Wer einen Sticker geschickt bekommt, den er gut findet, soll
 * ihn behalten können, ohne die Absenderin zu fragen. Das Paket ist damit
 * nicht bei ihm – dafür gibt es die Bibliothek –, aber das Bild schon.
 *
 * **Warum die Bytes schon beim Öffnen geholt werden.** Auf dem iPhone läuft
 * das Speichern in der installierten App über das Teilen-Blatt, und das
 * verlangt eine *frische* Nutzerhandlung. Wer erst auf Knopfdruck herunterlädt
 * und danach teilt, hat sie zwischendurch verbraucht: Safari lehnt ab, der
 * Rückfall auf einen Download-Verweis tut in der installierten App nichts –
 * und der Knopf meldete trotzdem Erfolg. Deshalb ist beim Antippen alles
 * schon da, und der Knopf tut nur noch das eine.
 */
export function SaveStickerSheet({ message, onClose }: MessageActionProps) {
  const sticker = message.sticker;
  const url = sticker?.url;
  const [daten, setDaten] = useState<Blob | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [fertig, setFertig] = useState(false);

  useEffect(() => {
    if (!url) return undefined;
    let weg = false;
    setFehler(null);
    stickerBytes(url)
      .then((blob) => {
        if (!weg) setDaten(blob);
      })
      .catch((error: unknown) => {
        if (!weg) setFehler(errorMessage(error, 'Der Sticker konnte nicht geladen werden'));
      });
    return () => {
      weg = true;
    };
  }, [url]);

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
    if (!daten) return;
    try {
      const weg = await herunterladen(daten, stickerFileName(daten.type));
      if (weg !== 'abgebrochen') setFertig(true);
    } catch (error) {
      toast(errorMessage(error, 'Speichern fehlgeschlagen'), 'error');
    }
  }

  return (
    <Sheet open onClose={onClose} title="Sticker speichern">
      <div className="stk-save-preview">
        <img src={stickerSrc(sticker.url)} alt="" width={128} height={128} loading="lazy" />
      </div>
      <p className="muted stk-save-note">Aus dem Paket „{sticker.packName}“.</p>
      {fehler && <p className="stk-hint stk-hint-warn">{fehler}</p>}
      <button
        type="button"
        className="btn btn-primary btn-block"
        onClick={() => void speichern()}
        disabled={!daten || fertig}
      >
        {fertig ? '✓ Gespeichert' : daten ? '⬇ Aufs Handy speichern' : 'Wird vorbereitet …'}
      </button>
      <button type="button" className="btn btn-ghost btn-block" onClick={onClose}>
        Schließen
      </button>
    </Sheet>
  );
}
