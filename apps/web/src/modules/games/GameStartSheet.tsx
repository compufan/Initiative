import { useNavigate } from 'react-router-dom';
import type { ComposerActionProps } from '../types.js';
import { GameSetup } from './GameSetup.js';

/**
 * Composer action "Spiel": pick a game for the open chat. The API announces the
 * new match in the chat, so we can jump straight to the board.
 */
export function GameStartSheet({ conversationId, onClose }: ComposerActionProps) {
  const navigate = useNavigate();
  return (
    <GameSetup
      open
      onClose={onClose}
      conversationId={conversationId}
      lockConversation
      onCreated={(session) => navigate(`/spiele/${session.id}`)}
    />
  );
}
