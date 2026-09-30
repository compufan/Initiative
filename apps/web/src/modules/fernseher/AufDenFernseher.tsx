import type { MessageActionProps } from '../types.js';
import { FernsehSheet } from './FernsehSheet.js';

/**
 * „Auf den Fernseher“ aus dem Chat heraus.
 *
 * # Warum das neben dem Streamknopf steht
 *
 * An einem Video im Chat hängt bereits ein 📺, und wo ein Chromecast oder ein
 * AirPlay-Gerät in Reichweite ist, ist der der schnellere Weg: ein Fingertipp.
 *
 * Dieser Weg hier setzt nichts voraus ausser einem Fernseher mit Browser – und
 * er kann etwas, was der andere gar nicht kann: FOTOS. Remote Playback und
 * AirPlay kennen ausschliesslich Medienelemente; ein Bild lässt sich damit
 * nicht schicken. Am Ende des Blattes steht der dritte Weg, die Spiegelung
 * des Telefons – deshalb gehen die Anhänge selbst mit (`ansicht`).
 */
export function AufDenFernseher({ message, onClose }: MessageActionProps) {
  const anhaenge = message.attachments.filter(
    (anhang) => anhang.kind === 'image' || anhang.kind === 'video',
  );
  const zeigbare = anhaenge.map((anhang) => anhang.id);

  return (
    <FernsehSheet
      open
      onClose={onClose}
      attachmentIds={zeigbare}
      ansicht={anhaenge}
      titel={
        zeigbare.length === 1 ? 'Auf den Fernseher' : `${zeigbare.length} Stück auf den Fernseher`
      }
    />
  );
}
