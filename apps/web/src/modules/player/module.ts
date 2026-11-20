import { defineWebModule } from '../types.js';
import { MiniSpieler } from './MiniSpieler.js';
import { schliessen } from './spieler.js';
import './styles.css';

/**
 * Globaler Spieler für Sprachnachrichten – spielt weiter, wenn man den Chat
 * verlässt, mit Mini-Leiste und Sperrbildschirm-Steuerung.
 */
export default defineWebModule({
  key: 'player',
  title: 'Sprachnachrichten-Spieler',
  description: 'Sprachnachrichten im Hintergrund weiterhören.',
  overlay: MiniSpieler,
  // Beim Abmelden darf nichts weiterspielen.
  init: () => () => schliessen(),
});
