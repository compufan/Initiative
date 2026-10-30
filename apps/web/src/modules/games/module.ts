import { createElement } from 'react';
import { defineWebModule } from '../types.js';
import { nachladbar } from '../../components/Nachladen.js';
import { GameBubble } from './GameBubble.js';
import { GameStartSheet } from './GameStartSheet.js';
import { GamesScreen } from './GamesScreen.js';

/*
 * Das Spielfeld und die Statistik erst holen, wenn jemand dorthin geht.
 *
 * WARUM nicht auch die Übersicht: Sie ist ein Ziel der unteren Leiste und
 * soll beim Antippen sofort stehen. Die Spielseite dagegen öffnet man aus
 * einer Blase oder der Übersicht heraus – ein Augenblick Laden fällt dort
 * nicht auf, und die Statistik mit ihren Diagrammen braucht kaum jemand.
 */
const GameScreen = nachladbar(
  () => import('./GameScreen.js').then((m) => m.GameScreen),
  'bildschirm',
);
const PressenStatistikScreen = nachladbar(
  () => import('./statistik/PressenStatistikScreen.js').then((m) => m.PressenStatistikScreen),
  'bildschirm',
);
const PressenLaufScreen = nachladbar(
  () => import('./statistik/PressenLaeufeListe.js').then((m) => m.PressenLaufScreen),
  'bildschirm',
);
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
    { path: '/spiele/pressen/statistik', element: createElement(PressenStatistikScreen) },
    { path: '/spiele/pressen/statistik/:laufId', element: createElement(PressenLaufScreen) },
    { path: '/spiele/:sessionId', element: createElement(GameScreen) },
  ],
  messageRenderers: {
    game: GameBubble,
  },
  composerActions: [{ key: 'game', label: 'Spiel', icon: '🎮', order: 80, render: GameStartSheet }],
});
