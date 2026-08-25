import { createElement } from 'react';
import { defineWebModule } from '../types.js';
import { StickerBubble } from './StickerBubble.js';
import { StickerLibraryScreen } from './StickerLibraryScreen.js';
import { StickerPickerSheet } from './StickerPickerSheet.js';
import { SaveStickerSheet } from './SaveStickerSheet.js';
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
  messageActions: [
    {
      key: 'sticker-speichern',
      label: 'Sticker aufs Handy',
      icon: '⬇',
      order: 40,
      // Auch bei fremden Stickern: Ein Bild behalten zu duerfen, das einem
      // geschickt wurde, ist keine Frage der Rechte am Paket.
      applies: (message) => Boolean(message.sticker) && !message.deletedAt,
      render: SaveStickerSheet,
    },
  ],
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
