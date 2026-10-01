import type { ComposerActionProps } from '../types.js';
import { EventEditor } from './EventEditor.js';

/**
 * Composer action "Termin": the editor with the current chat as the starting
 * point – im Gruppenchat sind alle Mitglieder eingeladen und der Chat ist als
 * Ziel gewählt, im Einzelchat das Gegenüber. Alles lässt sich im Editor ändern.
 */
export function EventComposerSheet({ conversationId, onClose }: ComposerActionProps) {
  return <EventEditor open onClose={onClose} conversationId={conversationId} />;
}
