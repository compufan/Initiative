import { z } from 'zod';
import { GAME_STATUSES, type GameStatus } from '../constants.js';

export interface GamePlayerDto {
  userId: string;
  /** Seat index inside the match (0-based); maps to the game's player slots. */
  seat: number;
  joinedAt: string;
}

export interface GameSessionDto {
  id: string;
  conversationId: string;
  messageId: string | null;
  gameKey: string;
  status: GameStatus;
  players: GamePlayerDto[];
  /** Game specific state, validated by the game definition on the server. */
  state: unknown;
  turnUserId: string | null;
  winnerUserIds: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface GameInfoDto {
  key: string;
  name: string;
  description: string;
  emoji: string;
  minPlayers: number;
  maxPlayers: number;
}

export const createGameSessionSchema = z.object({
  conversationId: z.string().uuid(),
  gameKey: z.string().min(1).max(64),
  /** Optional opponents to seat immediately; otherwise the match stays open. */
  opponentIds: z.array(z.string().uuid()).max(8).optional(),
});

export const gameMoveSchema = z.object({
  move: z.unknown(),
  /** Optimistic-concurrency guard: reject the move if the state moved on. */
  version: z.number().int().nonnegative().optional(),
});
