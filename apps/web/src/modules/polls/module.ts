import { defineWebModule } from '../types.js';
import { DatePollComposerSheet } from './DatePollComposerSheet.js';
import { PollBubble } from './PollBubble.js';
import { PollComposerSheet } from './PollComposerSheet.js';
import './styles.css';

/**
 * Polls – including the Terminfindung.
 *
 * The module owns no screen: it contributes the two composer actions that
 * create a poll and the chat card that everybody votes in. A finished
 * Terminfindung hands its winning slot over to the calendar module.
 */
export default defineWebModule({
  key: 'polls',
  title: 'Umfragen',
  description: 'Abstimmungen im Chat und die Terminfindung, aus der ein Termin wird.',
  messageRenderers: {
    poll: PollBubble,
  },
  composerActions: [
    { key: 'poll', label: 'Umfrage', icon: '📊', order: 70, render: PollComposerSheet },
    {
      key: 'date-poll',
      label: 'Terminfindung',
      icon: '🗓️',
      order: 71,
      render: DatePollComposerSheet,
    },
  ],
});
