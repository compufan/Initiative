import { useEffect } from 'react';
import type { MessageActionProps } from '../types.js';
import { useMyId } from '../../state/session.js';
import { MeldenSheet } from './GruppenVerwaltung.js';
import { senderName } from './helpers.js';

/**
 * „Melden“ im Menü einer Nachricht – als Eintrag eines Moduls, damit das
 * Nachrichtenmenü selbst nichts davon wissen muss (`messageActions`).
 */
export function MeldenAktion({ message, conversation, onClose }: MessageActionProps) {
  const myId = useMyId();
  const eigene = message.senderId === myId;
  // Eigene Nachrichten meldet man nicht; der Eintrag schliesst sich gleich wieder.
  useEffect(() => {
    if (eigene) onClose();
  }, [eigene, onClose]);
  if (eigene) return null;
  return (
    <MeldenSheet
      ziel={{ messageId: message.id, name: senderName(conversation, message.senderId) }}
      onClose={onClose}
    />
  );
}
