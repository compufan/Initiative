import { createElement } from 'react';
import { defineWebModule } from '../types.js';
import { EventBubble } from './EventBubble.js';
import { EventComposerSheet } from './EventComposerSheet.js';
import { EventDetailScreen } from './EventDetailScreen.js';
import { KalenderScreen } from './KalenderScreen.js';
import './styles.css';

/**
 * Calendar – the shared dates of a group.
 *
 * It owns the month and agenda view, the event editor, the chat bubble for
 * announced events and the ICS subscription that pushes everything into the
 * calendar app of the phone.
 */
export default defineWebModule({
  key: 'calendar',
  title: 'Kalender',
  description: 'Termine, Zu- und Absagen, Serientermine und das Kalender-Abo fürs Handy.',
  nav: [{ path: '/kalender', label: 'Kalender', icon: '📅', order: 20 }],
  routes: [
    { path: '/kalender', element: createElement(KalenderScreen) },
    { path: '/kalender/termin/:eventId', element: createElement(EventDetailScreen) },
  ],
  messageRenderers: {
    event: EventBubble,
  },
  composerActions: [
    { key: 'event', label: 'Termin', icon: '📅', order: 60, render: EventComposerSheet },
  ],
});
