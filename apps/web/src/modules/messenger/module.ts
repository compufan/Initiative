import { createElement } from 'react';
import { defineWebModule } from '../types.js';
import { useChat } from '../../state/chat.js';
import { ChatListScreen } from './ChatListScreen.js';
import { ChatScreen } from './ChatScreen.js';
import { GespeichertScreen } from './GespeichertScreen.js';
import { ShareTargetScreen } from './ShareTargetScreen.js';
import { SystemBubble } from './SystemBubble.js';
import { TextBubble } from './TextBubble.js';
import { BeitrittScreen } from './BeitrittScreen.js';
import { MeldenAktion } from './MeldenAktion.js';
import { reiterZahl } from './chatliste.js';
import { leerenVerdrahten } from './leeren.js';
import './styles.css';

/**
 * Messenger – the first feature module of Initiative.
import './welle2.css';
 *
 * It owns the chat list, the chat view and the composer, and it contributes the
 * two message renderers every other module can rely on as a fallback.
 */
export default defineWebModule({
  key: 'messenger',
  title: 'Chats',
  description: 'Direktnachrichten, Gruppen und der gemeinsame Verlauf',
  nav: [
    {
      path: '/chats',
      label: 'Chats',
      icon: '💬',
      order: 10,
      // Ein als ungelesen markierter Chat zählt eins (siehe `reiterZahl`).
      useBadge: () => useChat((state) => reiterZahl(state.conversations)),
    },
  ],
  routes: [
    { path: '/chats', element: createElement(ChatListScreen) },
    { path: '/chats/:conversationId', element: createElement(ChatScreen) },
    // Gespeicherte Nachrichten über alle Chats (aus dem Chat-Menü und der Chatliste).
    { path: '/gespeichert', element: createElement(GespeichertScreen) },
    // Ziel des System-Teilen-Dialogs (share_target im Manifest).
    { path: '/teilen', element: createElement(ShareTargetScreen) },
    // Einladungslink einer Gruppe – Vorschau ohne Inhalt, dann beitreten.
    { path: '/join/:token', element: createElement(BeitrittScreen) },
  ],
  messageActions: [
    {
      key: 'melden',
      label: 'Melden',
      icon: '🚩',
      order: 90,
      // Eigene, gelöschte und Systemzeilen meldet man nicht.
      applies: (message) =>
        message.type !== 'system' && !message.deletedAt && message.senderId != null,
      render: MeldenAktion,
    },
  ],
  // Geleerte Chats auch im Gerät leeren – auf allen Geräten (siehe `leeren.ts`).
  init: leerenVerdrahten,
  messageRenderers: {
    text: TextBubble,
    system: SystemBubble,
  },
});
