/**
 * Mini-game contract.
 *
 * Game rules live in `@initiative/shared` so the server can validate every move
 * authoritatively while the client renders the exact same state locally. A new
 * game only has to implement this interface and register itself – no changes to
 * the messenger, the transport or the database are required.
 */

export interface GameSeat {
  seat: number;
  userId: string;
}

export interface GameMoveContext {
  seat: number;
  userId: string;
  players: GameSeat[];
}

export type GameMoveResult<S> = { ok: true; state: S } | { ok: false; error: string };

export interface GameOutcome {
  finished: boolean;
  draw: boolean;
  /** Seat indexes that won; empty on draws or while the match is running. */
  winnerSeats: number[];
}

export interface GameDefinition<S = unknown, M = unknown> {
  key: string;
  name: string;
  description: string;
  emoji: string;
  minPlayers: number;
  maxPlayers: number;
  createInitialState(players: GameSeat[]): S;
  /** Narrow untrusted input coming from the network; return null when invalid. */
  parseMove(raw: unknown): M | null;
  applyMove(state: S, move: M, ctx: GameMoveContext): GameMoveResult<S>;
  /** Seat that has to move next, or null when nobody has to. */
  currentSeat(state: S): number | null;
  getOutcome(state: S): GameOutcome;
  /** Short one-line summary shown in the chat bubble / push notification. */
  describe(state: S, players: GameSeat[]): string;
}

export function seatOf(players: GameSeat[], userId: string): number | null {
  const found = players.find((p) => p.userId === userId);
  return found ? found.seat : null;
}

export function userOfSeat(players: GameSeat[], seat: number | null): string | null {
  if (seat == null) return null;
  return players.find((p) => p.seat === seat)?.userId ?? null;
}
