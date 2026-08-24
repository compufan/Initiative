import type { ComposerActionProps } from '../types.js';
import { EventEditor } from './EventEditor.js';

/**
 * Composer action "Termin": the editor with the current chat already attached –
 * the created event is announced in the chat unless the user opts out.
 */
export function EventComposerSheet({ conversationId, onClose }: ComposerActionProps) {
  return <EventEditor open onClose={onClose} conversationId={conversationId} lockConversation />;
}
