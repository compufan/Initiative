import type { GameDefinition } from './types.js';
import { ticTacToe } from './tic-tac-toe.js';
import { connectFour } from './connect-four.js';

const registry = new Map<string, GameDefinition<any, any>>();

/** Register a game so both API and client can resolve it by key. */
export function registerGame(definition: GameDefinition<any, any>): void {
  registry.set(definition.key, definition);
}

export function getGame(key: string): GameDefinition<any, any> | undefined {
  return registry.get(key);
}

export function listGames(): GameDefinition<any, any>[] {
  return [...registry.values()];
}

registerGame(ticTacToe);
registerGame(connectFour);
