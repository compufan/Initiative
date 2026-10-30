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
  /** Leer bei einer Übung ohne Chat (Pressen gegen den Spiegel): Sie gehört nur ihrem Besitzer. */
  conversationId: string | null;
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
  /** Uhr des Servers beim Ausliefern (Echtzeitspiele schätzen daraus ihre Uhrabweichung). */
  serverTime?: string;
  /** Pressen: Strichmännchen der Spielenden, Benutzer-Kennung → Figur (siehe `pressen-figur.ts`). */
  figuren?: Record<string, unknown>;
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
  /** Ohne Chat: eine Übung allein (nur für Spiele, die mit einer Person laufen). */
  conversationId: z.string().uuid().optional(),
  gameKey: z.string().min(1).max(64),
  /** Optional opponents to seat immediately; otherwise the match stays open. */
  opponentIds: z.array(z.string().uuid()).max(8).optional(),
});

export const gameMoveSchema = z.object({
  move: z.unknown(),
  /** Optimistic-concurrency guard: reject the move if the state moved on. */
  version: z.number().int().nonnegative().optional(),
});
