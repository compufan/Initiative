import { useState } from 'react';
import type { AttachmentDto } from '@initiative/shared';

import { toast } from '../../state/ui.js';
import { errorMessage, mediaBytes } from '../media/helpers.js';
import { VideoGifSheet } from './VideoGifSheet.js';

/**
 * Der Weg aus einem Video heraus – so, wie `FotoWerkstatt` ihn für ein Foto
 * anbietet.
 *
 * # Warum die Bytes hier geholt werden und nicht im Blatt
 *
 * Weil dasselbe Video hintereinander in mehrere Werkzeuge gehen kann, und
 * weil es gross ist. Ein Video von zwanzig Sekunden sind schnell fünfzehn
 * Megabyte; die ein zweites Mal zu laden, nur weil jemand das Blatt geschlossen
 * und wieder geöffnet hat, ist auf einem Mobilfunkvertrag kein Detail.
 *
 * Die Anhangkennung liegt NEBEN dem Blob und nicht in einer zweiten Variablen
 * – derselbe Grund wie bei `FotoWerkstatt`: In der Lightbox wechselt `video`
 * beim Wischen, ein gemerkter Blob aber nicht. Mit der Kennung daneben kann
 * der Zwischenspeicher gar nicht zum falschen Video gehören.
 */
export function VideoWerkstatt({
  video,
  ablegen,
  zielName,
  onOffen,
  className,
}: {
  video: AttachmentDto;
  /** Wohin das fertige GIF gehört. Fehlt es, bleibt das Speichern aufs Gerät. */
  ablegen?: (blob: Blob, name: string) => Promise<void>;
  zielName?: string;
  /** Wird gerufen, sobald das Blatt aufgeht – damit der Betrachter Platz macht. */
  onOffen?: (offen: boolean) => void;
  /**
   * Die Form des Knopfes.
   *
   * In einer Leiste ist er rund wie die Nachbarn (`media-round-btn`), auf
   * einem laufenden Video liegt er als dunkle Scheibe darauf – dieselbe
   * Unterscheidung, die der Fernsehknopf schon trifft.
   */
  className?: string;
}) {
  const [daten, setDaten] = useState<{ id: string; blob: Blob } | null>(null);
  const [offen, setOffen] = useState(false);
  const [laedt, setLaedt] = useState(false);

  async function oeffnen() {
    if (laedt) return;
    setLaedt(true);
    try {
      const blob = daten?.id === video.id ? daten.blob : await mediaBytes(video);
      setDaten({ id: video.id, blob });
      setOffen(true);
      onOffen?.(true);
    } catch (ausfall) {
      toast(errorMessage(ausfall, 'Das Video konnte nicht geladen werden'), 'error');
    } finally {
      setLaedt(false);
    }
  }

  function schliessen() {
    setOffen(false);
    onOffen?.(false);
  }

  return (
    <>
      <button
        type="button"
        className={className ?? 'media-round-btn'}
        onClick={() => void oeffnen()}
        disabled={laedt}
        aria-label="GIF aus dem Video machen"
        title="Ausschnitt wählen, freistellen, als GIF speichern"
      >
        {laedt ? '…' : '🎞️'}
      </button>

      {offen && daten && (
        <VideoGifSheet
          video={daten.blob}
          name={video.fileName ?? undefined}
          onFertig={ablegen}
          zielName={zielName}
          onClose={schliessen}
        />
      )}
    </>
  );
}
