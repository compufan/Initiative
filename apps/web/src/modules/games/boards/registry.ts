import type { ComponentType } from 'react';
import type { GameSessionDto } from '@initiative/shared';
import { ConnectFourBoard, ConnectFourMini } from './ConnectFourBoard.js';
import { TicTacToeBoard, TicTacToeMini } from './TicTacToeBoard.js';

/**
 * Everything a board needs. The board only draws and reports the move it wants
 * to make – validating, persisting and broadcasting is the server's job.
 */
export interface GameBoardProps {
  session: GameSessionDto;
  /** Seat of the viewer, or null when only watching. */
  mySeat: number | null;
  onMove(move: unknown): void;
  /** A move is on the wire – ignore further input until it comes back. */
  busy: boolean;
}

/** Compact, non-interactive board for chat bubbles and lists. */
export interface GameMiniBoardProps {
  session: GameSessionDto;
}

/**
 * Board registry – the extension point of this module.
 *
 * A new mini game needs three things:
 *   1. the authoritative rules in `apps/api/src/games/<name>.rs` (+ `games/mod.rs`),
 *   2. the identical TypeScript copy in `packages/shared/src/games/` for the
 *      optimistic display (+ `registerGame` in `games/registry.ts`),
 *   3. one entry here that maps the game key to its board.
 *
 * Nothing else in the app has to change: chat bubble, screens, realtime and the
 * catalog pick the new game up through this map.
 */
export const gameBoards: Record<string, ComponentType<GameBoardProps>> = {
  'tic-tac-toe': TicTacToeBoard,
  'connect-four': ConnectFourBoard,
};

/**
 * Optional previews for the chat bubble. A game without an entry simply falls
 * back to its emoji, so registering a board stays enough.
 */
export const gameMiniBoards: Record<string, ComponentType<GameMiniBoardProps>> = {
  'tic-tac-toe': TicTacToeMini,
  'connect-four': ConnectFourMini,
};
