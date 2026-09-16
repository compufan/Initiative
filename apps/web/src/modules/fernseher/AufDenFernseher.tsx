import type { MessageActionProps } from '../types.js';
import { FernsehSheet } from './FernsehSheet.js';

/**
 * „Auf den Fernseher“ aus dem Chat heraus.
 *
 * # Warum das neben dem Streamknopf steht
 *
 * An einem Video im Chat hängt bereits ein 📺, und der ist der schnellere Weg:
 * ein Fingertipp, keine Einrichtung. Er setzt aber einen Chromecast oder ein
 * AirPlay-Gerät voraus und erscheint deshalb nur, wenn der Browser wirklich
 * eines gefunden hat.
 *
 * Dieser Weg hier setzt nichts voraus ausser einem Fernseher mit Browser – und
 * er kann etwas, was der andere gar nicht kann: FOTOS. Remote Playback und
 * AirPlay kennen ausschliesslich Medienelemente; ein Bild lässt sich damit
 * nicht schicken.
 */
export function AufDenFernseher({ message, onClose }: MessageActionProps) {
  const zeigbare = message.attachments
    .filter((anhang) => anhang.kind === 'image' || anhang.kind === 'video')
    .map((anhang) => anhang.id);

  return (
    <FernsehSheet
      open
      onClose={onClose}
      attachmentIds={zeigbare}
      titel={
        zeigbare.length === 1 ? 'Auf den Fernseher' : `${zeigbare.length} Stück auf den Fernseher`
      }
    />
  );
}
