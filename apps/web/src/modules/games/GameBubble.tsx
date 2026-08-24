import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import type { MessageRendererProps } from '../types.js';
import { useMyId } from '../../state/session.js';
import { MiniBoard } from './GameBoard.js';
import { useLiveGameSession } from './useGameSession.js';
import {
  gameInfoFor,
  isFinished,
  nameFrom,
  playersLabel,
  statusInfo,
  useGameCatalog,
  useUserLookup,
} from './helpers.js';

/** Chat card for a match: game, players, status, mini board and the way in. */
export function GameBubble({ message, isMine }: MessageRendererProps) {
  const myId = useMyId();
  const { games } = useGameCatalog();
  const sessionId = message.metadata.gameSessionId ?? message.game?.id ?? null;
  const { session, loading } = useLiveGameSession(sessionId, message.game ?? null);
  const playerIds = useMemo(
    () => (session ? session.players.map((player) => player.userId) : []),
    [session],
  );
  const users = useUserLookup(playerIds);
  const tone = isMine ? 'is-mine' : '';

  if (message.deletedAt) {
    return (
      <div
        className={`msg-bubble ${isMine ? 'msg-bubble-mine' : 'msg-bubble-theirs'} msg-bubble-deleted`}
      >
        <em>Diese Nachricht wurde gelöscht</em>
      </div>
    );
  }

  if (!session) {
    return (
      <div className={`game-bubble ${tone}`}>
        <p className="game-bubble-note">
          {loading ? 'Spiel wird geladen …' : 'Spiel nicht verfügbar.'}
        </p>
      </div>
    );
  }

  const info = gameInfoFor(session.gameKey, games);
  const nameOf = (userId: string) => (userId === myId ? 'Du' : nameFrom(users, userId));
  const status = statusInfo(session, myId, nameOf);

  return (
    <div className={`game-bubble ${tone}`}>
      <div className="game-bubble-head">
        <span className="game-bubble-emoji" aria-hidden="true">
          {info.emoji}
        </span>
        <span className="game-bubble-facts">
          <span className="game-bubble-title truncate">{info.name}</span>
          <span className="game-bubble-players truncate">
            {playersLabel(session, myId, nameOf)}
          </span>
        </span>
      </div>

      <MiniBoard session={session} />

      <span className={`game-status game-status-${status.tone}`}>{status.text}</span>

      <Link className="btn btn-primary game-bubble-cta" to={`/spiele/${session.id}`}>
        {isFinished(session) ? 'Ansehen' : 'Spielen'}
      </Link>
    </div>
  );
}
