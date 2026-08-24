import type { GameSessionDto } from '@initiative/shared';
import { EmptyState } from '../../components/Feedback.js';
import { gameBoards, gameMiniBoards } from './boards/registry.js';
import { gameInfoFor } from './helpers.js';

interface GameBoardProps {
  session: GameSessionDto;
  mySeat: number | null;
  onMove: (move: unknown) => void;
  busy: boolean;
}

/**
 * Picks the board for a match from the registry. A game the client does not
 * know yet stays readable instead of breaking the screen.
 */
export function GameBoard({ session, mySeat, onMove, busy }: GameBoardProps) {
  const Board = gameBoards[session.gameKey];
  if (!Board) {
    return (
      <EmptyState
        emoji="🕹️"
        title="Spiel nicht unterstützt"
        description="Dieses Spiel kennt deine App noch nicht. Aktualisiere die App, um mitzuspielen."
      />
    );
  }
  return <Board session={session} mySeat={mySeat} onMove={onMove} busy={busy} />;
}

/** Small board preview for chat bubbles and lists. */
export function MiniBoard({ session }: { session: GameSessionDto }) {
  const Mini = gameMiniBoards[session.gameKey];
  if (!Mini) {
    return (
      <span className="game-mini-fallback" aria-hidden="true">
        {gameInfoFor(session.gameKey).emoji}
      </span>
    );
  }
  return <Mini session={session} />;
}
