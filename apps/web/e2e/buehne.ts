import { createElement } from 'react';
import { createRoot } from 'react-dom/client';

import { VideoEditorSheet } from '../src/modules/video/VideoEditorSheet.js';

/**
 * Eine Bühne für Oberflächenprüfungen, die keine Anmeldung brauchen.
 *
 * Das Videoblatt hängt sonst an einer Nachricht oder einer Datei, und bis
 * dorthin führt der Weg über Anmeldung, Datenbank und Hochladen – drei
 * Dinge, die mit Schneiden und Bearbeiten nichts zu tun haben. Hier wird es
 * direkt in die Seite gesetzt, mit einem Video aus der Prüfung selbst.
 *
 * Geladen wird die Datei im Browser über den Entwicklungsserver
 * (`import('/e2e/buehne.ts')`), damit React und das Blatt aus DERSELBEN
 * Quelle kommen wie in der App.
 */
export function videoBlattZeigen(video: Blob): { fertig: Promise<Blob>; weg: () => void } {
  const platz = document.createElement('div');
  document.body.appendChild(platz);
  const wurzel = createRoot(platz);
  let abgeben: (blob: Blob) => void = () => undefined;
  const fertig = new Promise<Blob>((auf) => {
    abgeben = auf;
  });
  const weg = () => {
    wurzel.unmount();
    platz.remove();
  };
  wurzel.render(
    createElement(VideoEditorSheet, {
      video,
      name: 'pruefung.webm',
      zielName: 'Übernehmen',
      onFertig: (blob: Blob) => abgeben(blob),
      onClose: weg,
    }),
  );
  return { fertig, weg };
}
