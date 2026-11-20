import { defineWebModule } from '../types.js';
import { AnrufOberflaeche } from './AnrufOberflaeche.js';
import { verdrahten } from './anruf.js';
import './styles.css';

/**
 * 1:1-Anrufe (Audio/Video) per WebRTC. Die Knöpfe sitzen im Kopf des
 * Direktchats (`AnrufKnoepfe`), die Oberfläche liegt über der ganzen App.
 */
export default defineWebModule({
  key: 'anruf',
  title: 'Anrufe',
  description: 'Sprach- und Videoanrufe im Direktchat.',
  overlay: AnrufOberflaeche,
  init: () => verdrahten(),
});
