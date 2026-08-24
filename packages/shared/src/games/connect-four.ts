import type { GameDefinition, GameMoveResult, GameOutcome } from './types.js';

export const CONNECT_FOUR_COLS = 7;
export const CONNECT_FOUR_ROWS = 6;

export interface ConnectFourState {
  /** Column-major stacks; index 0 is the bottom of the column. */
  columns: number[][];
  turn: number;
  winner: number | null;
  draw: boolean;
  lastMove: { col: number; row: number } | null;
}

export interface ConnectFourMove {
  col: number;
}

function cellAt(state: ConnectFourState, col: number, row: number): number | null {
  const column = state.columns[col];
  if (!column) return null;
  return row < column.length ? column[row]! : null;
}

function hasFour(state: ConnectFourState, col: number, row: number, seat: number): boolean {
  const dirs: [number, number][] = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ];
  for (const [dc, dr] of dirs) {
    let count = 1;
    for (const sign of [1, -1]) {
      let c = col + dc * sign;
      let r = row + dr * sign;
      while (cellAt(state, c, r) === seat) {
        count += 1;
        c += dc * sign;
        r += dr * sign;
      }
    }
    if (count >= 4) return true;
  }
  return false;
}

export const connectFour: GameDefinition<ConnectFourState, ConnectFourMove> = {
  key: 'connect-four',
  name: 'Vier gewinnt',
  description: 'Vier Steine in einer Reihe – waagerecht, senkrecht oder diagonal.',
  emoji: '🔴',
  minPlayers: 2,
  maxPlayers: 2,

  createInitialState(): ConnectFourState {
    return {
      columns: Array.from({ length: CONNECT_FOUR_COLS }, () => []),
      turn: 0,
      winner: null,
      draw: false,
      lastMove: null,
    };
  },

  parseMove(raw: unknown): ConnectFourMove | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const col = (raw as { col?: unknown }).col;
    if (typeof col !== 'number' || !Number.isInteger(col) || col < 0 || col >= CONNECT_FOUR_COLS) {
      return null;
    }
    return { col };
  },

  applyMove(state, move, ctx): GameMoveResult<ConnectFourState> {
    if (state.winner != null || state.draw) return { ok: false, error: 'Das Spiel ist beendet.' };
    if (ctx.seat !== state.turn) return { ok: false, error: 'Du bist nicht am Zug.' };
    const column = state.columns[move.col];
    if (!column) return { ok: false, error: 'Ungültige Spalte.' };
    if (column.length >= CONNECT_FOUR_ROWS) return { ok: false, error: 'Spalte ist voll.' };

    const columns = state.columns.map((c) => c.slice());
    columns[move.col]!.push(ctx.seat);
    const row = columns[move.col]!.length - 1;
    const next: ConnectFourState = { ...state, columns, lastMove: { col: move.col, row } };

    const won = hasFour(next, move.col, row, ctx.seat);
    const full = columns.every((c) => c.length >= CONNECT_FOUR_ROWS);

    return {
      ok: true,
      state: {
        ...next,
        winner: won ? ctx.seat : null,
        draw: !won && full,
        turn: won || full ? state.turn : state.turn === 0 ? 1 : 0,
      },
    };
  },

  currentSeat(state) {
    return state.winner == null && !state.draw ? state.turn : null;
  },

  getOutcome(state): GameOutcome {
    return {
      finished: state.winner != null || state.draw,
      draw: state.draw,
      winnerSeats: state.winner != null ? [state.winner] : [],
    };
  },

  describe(state) {
    if (state.winner != null) return 'Sieg für Spieler ' + (state.winner + 1);
    if (state.draw) return 'Unentschieden';
    return 'Spieler ' + (state.turn + 1) + ' ist am Zug';
  },
};
