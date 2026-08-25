import { createElement } from 'react';
import { defineWebModule } from '../types.js';
import { AddToCollectionSheet } from './AddToCollectionSheet.js';
import { DateienScreen } from './DateienScreen.js';
import './styles.css';

/**
 * Dateien & Sammlungen.
 *
 * Ordner mit Berechtigungen, in denen dieselben Anhänge liegen, die auch im
 * Chat verschickt werden – eine Datei bekommt hier einen zweiten Platz, statt
 * noch einmal hochgeladen zu werden.
 *
 * Der Weg hinein führt über den Chat: Nachricht lange antippen → „Zur
 * Sammlung hinzufügen“. Das steht jedem im Chat offen, nicht nur dem, der die
 * Datei geschickt hat.
 */
export default defineWebModule({
  key: 'files',
  title: 'Dateien',
  description: 'Ordner und Dateien mit Berechtigungen – geteilt mit einzelnen oder einem Chat.',
  nav: [{ path: '/dateien', label: 'Dateien', icon: '📁', order: 30 }],
  routes: [
    { path: '/dateien', element: createElement(DateienScreen) },
    { path: '/dateien/:collectionId', element: createElement(DateienScreen) },
  ],
  messageActions: [
    {
      key: 'add-to-collection',
      label: 'Zur Sammlung hinzufügen',
      icon: '📁',
      order: 30,
      // Nur bei Nachrichten, an denen wirklich etwas hängt.
      applies: (message) => message.attachments.length > 0 && !message.deletedAt,
      render: AddToCollectionSheet,
    },
  ],
});
