import { createElement } from 'react';
import { defineWebModule } from '../types.js';
import { StickerBubble } from './StickerBubble.js';
import { StickerLibraryScreen } from './StickerLibraryScreen.js';
import { StickerPickerSheet } from './StickerPickerSheet.js';
import './styles.css';

/**
 * Sticker module – the keyboard in the composer, the studio for own stickers
 * and the library at `/sticker`. It has no navigation entry: stickers are
 * reached from a chat or from the profile screen.
 */
export default defineWebModule({
  key: 'stickers',
  title: 'Sticker',
  description: 'Sticker senden, eigene Sticker erstellen und Pakete verwalten.',
  routes: [{ path: '/sticker', element: createElement(StickerLibraryScreen) }],
  messageRenderers: { sticker: StickerBubble },
  composerActions: [
    {
      key: 'sticker',
      label: 'Sticker',
      icon: '🌟',
      order: 50,
      // Eigener Knopf in der Eingabezeile – siehe `pinned` in ../types.ts.
      pinned: true,
      render: StickerPickerSheet,
    },
  ],
});
