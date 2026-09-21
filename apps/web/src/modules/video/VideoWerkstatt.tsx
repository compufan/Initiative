import { useState } from 'react';
import { LIMITS, type AttachmentDto } from '@initiative/shared';

import { toast } from '../../state/ui.js';
import { errorMessage, mediaBytes } from '../media/helpers.js';
import { VideoEditorSheet } from './VideoEditorSheet.js';
import { VideoGifSheet } from './VideoGifSheet.js';
import { SavePackSheet } from '../stickers/SavePackSheet.js';

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
  className2,
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
  /** Die Form des zweiten Knopfes – siehe `className`. */
  className2?: string;
}) {
  const [daten, setDaten] = useState<{ id: string; blob: Blob } | null>(null);
  const [offen, setOffen] = useState<'aus' | 'gif' | 'bearbeiten'>('aus');
  const [laedt, setLaedt] = useState(false);
  /**
   * Das fertige GIF, das gerade in ein Sticker-Paket wandert.
   *
   * Steht HIER und nicht im GIF-Blatt, damit jener Weg die Sticker-Welt nicht
   * mitschleppt. Das Blatt darüber bleibt offen: Wer die Paketwahl abbricht,
   * kommt zum Ergebnis zurück und muss das GIF nicht noch einmal rechnen –
   * das sind je nach Güte Minuten.
   */
  const [stickerGif, setStickerGif] = useState<{
    blob: Blob;
    breite: number;
    hoehe: number;
  } | null>(null);

  async function oeffnen(ziel: 'gif' | 'bearbeiten') {
    if (laedt) return;
    setLaedt(true);
    try {
      // Einmal holen reicht: Wer erst ein GIF macht und danach bearbeitet,
      // lädt DASSELBE Video nicht zweimal herunter.
      const blob = daten?.id === video.id ? daten.blob : await mediaBytes(video);
      setDaten({ id: video.id, blob });
      setOffen(ziel);
      onOffen?.(true);
    } catch (ausfall) {
      toast(errorMessage(ausfall, 'Das Video konnte nicht geladen werden'), 'error');
    } finally {
      setLaedt(false);
    }
  }

  function schliessen() {
    setOffen('aus');
    setStickerGif(null);
    onOffen?.(false);
  }

  return (
    <>
      <button
        type="button"
        className={className ?? 'media-round-btn'}
        onClick={() => void oeffnen('bearbeiten')}
        disabled={laedt}
        aria-label="Video bearbeiten"
        title="Zuschneiden, Licht, Farbe, Freistellen, Tiefenschärfe"
      >
        {laedt ? '…' : '✏️'}
      </button>
      <button
        type="button"
        className={className2 ?? 'media-round-btn'}
        onClick={() => void oeffnen('gif')}
        disabled={laedt}
        aria-label="GIF aus dem Video machen"
        title="Ausschnitt wählen, freistellen, als GIF speichern"
      >
        🎞️
      </button>

      {offen === 'gif' && daten && (
        <VideoGifSheet
          video={daten.blob}
          name={video.fileName ?? undefined}
          onFertig={ablegen}
          alsSticker={(blob, breite, hoehe) => setStickerGif({ blob, breite, hoehe })}
          stickerGrenzeBytes={LIMITS.maxUploadBytes.sticker}
          zielName={zielName}
          onClose={schliessen}
        />
      )}
      {stickerGif && (
        <SavePackSheet
          blob={stickerGif.blob}
          mime="image/gif"
          breite={stickerGif.breite}
          hoehe={stickerGif.hoehe}
          onClose={() => setStickerGif(null)}
          onSaved={() => {
            // Gespeichert heisst fertig: Das GIF liegt im Paket, und das
            // Ergebnisblatt hätte nichts mehr anzubieten.
            setStickerGif(null);
            schliessen();
          }}
        />
      )}
      {offen === 'bearbeiten' && daten && (
        <VideoEditorSheet
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
