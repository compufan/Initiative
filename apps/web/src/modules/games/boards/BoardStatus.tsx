import { useMemo } from 'react';
import type { GameSessionDto } from '@initiative/shared';
import { useMyId } from '../../../state/session.js';
import { nameFrom, seatClass, statusInfo, useUserLookup } from '../helpers.js';

/**
 * Turn indicator under a board: "Du bist am Zug", "Wartet auf Anna" or the
 * final score. Shared by every board so a new game gets it for free.
 */
export function BoardStatus({ session }: { session: GameSessionDto }) {
  const myId = useMyId();
  const playerIds = useMemo(
    () => session.players.map((player) => player.userId),
    [session.players],
  );
  const users = useUserLookup(playerIds);
  const status = statusInfo(session, myId, (userId) => nameFrom(users, userId));
  const activeSeat =
    session.players.find((player) => player.userId === session.turnUserId)?.seat ?? null;

  return (
    <p className={`game-turn game-turn-${status.tone}`} role="status">
      {status.tone === 'turn' || status.tone === 'wait' ? (
        <span className={`game-dot ${seatClass(activeSeat)}`} aria-hidden="true" />
      ) : null}
      {status.text}
    </p>
  );
}
