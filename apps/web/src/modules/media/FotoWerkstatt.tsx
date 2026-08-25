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
export function FotoWerkstatt({ foto, ablegen, zielName, onOffen }: FotoWerkstattProps) {
  const [daten, setDaten] = useState<Blob | null>(null);
  const [modus, setModus] = useState<'aus' | 'bearbeiten' | 'sticker'>('aus');
  const [laedt, setLaedt] = useState(false);

  async function oeffnen(ziel: 'bearbeiten' | 'sticker') {
    if (laedt) return;
    setLaedt(true);
    try {
      // Einmal holen reicht: Wer erst bearbeitet und danach einen Sticker will,
      // laedt das Bild nicht zweimal herunter.
      const blob = daten ?? (await mediaBytes(foto));
      setDaten(blob);
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
          quelle={daten}
          name={foto.fileName}
          onClose={schliessen}
          onFertig={ablegen}
          zielName={zielName}
        />
      )}
      {modus === 'sticker' && daten && (
        <StickerStudio startBild={daten} onClose={schliessen} onSaved={schliessen} />
      )}
    </>
  );
}
