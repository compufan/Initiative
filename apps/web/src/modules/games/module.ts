import { createElement } from 'react';
import { defineWebModule } from '../types.js';
import { GameBubble } from './GameBubble.js';
import { GameScreen } from './GameScreen.js';
import { GameStartSheet } from './GameStartSheet.js';
import { GamesScreen } from './GamesScreen.js';
import './styles.css';

/**
 * Mini games – the playful module of Initiative.
 *
 * The rules live in the Rust API (`apps/api/src/games`) and are mirrored in
 * `@initiative/shared` for the optimistic display; this module only draws the
 * boards. A new game needs an entry in `boards/registry.ts` – nothing here has
 * to change.
 */
export default defineWebModule({
  key: 'games',
  title: 'Spiele',
  description: 'Tic Tac Toe, Vier gewinnt und alles, was noch dazukommt – direkt im Chat.',
  nav: [{ path: '/spiele', label: 'Spiele', icon: '🎮', order: 30 }],
  routes: [
    { path: '/spiele', element: createElement(GamesScreen) },
    { path: '/spiele/:sessionId', element: createElement(GameScreen) },
  ],
  messageRenderers: {
    game: GameBubble,
  },
  composerActions: [{ key: 'game', label: 'Spiel', icon: '🎮', order: 80, render: GameStartSheet }],
});
