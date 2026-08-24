import { createElement } from 'react';
import { defineWebModule } from '../types.js';
import { useChat } from '../../state/chat.js';
import { ChatListScreen } from './ChatListScreen.js';
import { ChatScreen } from './ChatScreen.js';
import { SystemBubble } from './SystemBubble.js';
import { TextBubble } from './TextBubble.js';
import './styles.css';

/**
 * Messenger – the first feature module of Initiative.
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
      useBadge: () =>
        useChat((state) =>
          state.conversations.reduce(
            (sum, conversation) => sum + (conversation.archived ? 0 : conversation.unreadCount),
            0,
          ),
        ),
    },
  ],
  routes: [
    { path: '/chats', element: createElement(ChatListScreen) },
    { path: '/chats/:conversationId', element: createElement(ChatScreen) },
  ],
  messageRenderers: {
    text: TextBubble,
    system: SystemBubble,
  },
});
