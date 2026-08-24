/**
 * Spielregeln für die Darstellung im Client.
 *
 * Autoritativ sind die Regeln in `apps/api/src/games/` – der Server prüft jeden
 * Zug und schickt den neuen Spielstand zurück. Diese Kopie erlaubt dem Client
 * nur, Züge sofort optimistisch anzuzeigen und ungültige Eingaben vorab
 * abzufangen. Ein neues Spiel braucht beide Seiten plus ein Brett unter
 * `apps/web/src/modules/games/boards/`.
 */
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
