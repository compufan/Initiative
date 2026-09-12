import { useState } from 'react';
import type { AttachmentDto } from '@initiative/shared';
import { BildEditor } from '../bild/BildEditor.js';
import { StickerStudio } from '../stickers/StickerStudio.js';
import { toast } from '../../state/ui.js';
import { errorMessage, mediaBytes } from './helpers.js';

interface FotoWerkstattProps {
  foto: AttachmentDto;
  /**
   * Wohin eine bearbeitete Fassung gehört. Fehlt es, bleibt das Speichern aufs
   * Telefon – der Editor sagt das dann auch, statt einen Knopf anzubieten, der
   * nichts tut.
   */
  ablegen?: (blob: Blob, name: string) => Promise<void>;
  /**
   * Wohin ein REZEPT geht – das unberührte Bild und die Bearbeitung daneben.
   *
   * Getrennt von `ablegen`, weil es etwas anderes abgibt: zwei Dateien statt
   * einer. Fehlt es, gibt es den Knopf im Editor nicht.
   */
  alsRezept?: (original: Blob, rezept: Blob, name: string) => Promise<void>;
  /** Was auf dem Speichern-Knopf steht, z. B. „In den Chat“. */
  zielName?: string;
  /** Wird gerufen, sobald eine Werkstatt aufgeht – damit der Betrachter Platz macht. */
  onOffen?: (offen: boolean) => void;
}

/**
 * Die beiden Wege aus einem Foto heraus: bearbeiten oder einen Sticker daraus
 * machen.
 *
 * Beides braucht dieselbe Vorarbeit – die Bilddaten holen – und beides
 * überschreibt nie das Original. Deshalb steht es hier an einer Stelle und
 * nicht zweimal, einmal im Chat und einmal in den Sammlungen.
 */
export function FotoWerkstatt({ foto, ablegen, alsRezept, zielName, onOffen }: FotoWerkstattProps) {
  /*
   * Die Bytes MIT ihrer Anhangkennung merken.
   *
   * Vorher lag hier nur der Blob. In der Lightbox wechselt `foto` beim
   * Wischen, der gemerkte Blob aber nicht – wer Bild A bearbeitete, zu B
   * wischte und wieder auf den Stift tippte, bekam A in den Editor und
   * speicherte es über B. Nichts daran sah falsch aus, bis das Ergebnis im
   * Chat stand.
   *
   * Mit der Kennung daneben kann der Zwischenspeicher gar nicht mehr zum
   * falschen Bild gehören: Er gilt oder er gilt nicht.
   */
  const [daten, setDaten] = useState<{ id: string; blob: Blob } | null>(null);
  const [modus, setModus] = useState<'aus' | 'bearbeiten' | 'sticker'>('aus');
  const [laedt, setLaedt] = useState(false);

  async function oeffnen(ziel: 'bearbeiten' | 'sticker') {
    if (laedt) return;
    setLaedt(true);
    try {
      // Einmal holen reicht: Wer erst bearbeitet und danach einen Sticker will,
      // laedt DASSELBE Bild nicht zweimal herunter.
      const blob = daten?.id === foto.id ? daten.blob : await mediaBytes(foto);
      setDaten({ id: foto.id, blob });
      setModus(ziel);
      onOffen?.(true);
    } catch (error) {
      toast(errorMessage(error, 'Das Bild konnte nicht geladen werden'), 'error');
    } finally {
      setLaedt(false);
    }
  }

  function schliessen() {
    setModus('aus');
    onOffen?.(false);
  }

  return (
    <>
      <button
        type="button"
        className="media-round-btn"
        onClick={() => void oeffnen('bearbeiten')}
        disabled={laedt}
        aria-label="Bild bearbeiten"
        title="Zuschneiden, drehen, malen, beschriften"
      >
        {laedt ? '…' : '✏️'}
      </button>
      <button
        type="button"
        className="media-round-btn"
        onClick={() => void oeffnen('sticker')}
        disabled={laedt}
        aria-label="Sticker daraus machen"
        title="Freistellen und als Sticker speichern"
      >
        🪄
      </button>

      {modus === 'bearbeiten' && daten && (
        <BildEditor
          quelle={daten.blob}
          name={foto.fileName}
          onClose={schliessen}
          onFertig={ablegen}
          onRezept={alsRezept}
          zielName={zielName}
        />
      )}
      {modus === 'sticker' && daten && (
        <StickerStudio startBild={daten.blob} onClose={schliessen} onSaved={schliessen} />
      )}
    </>
  );
}
