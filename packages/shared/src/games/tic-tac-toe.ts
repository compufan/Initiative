import type { GameDefinition, GameMoveResult, GameOutcome, GameSeat } from './types.js';

export interface TicTacToeState {
  board: (number | null)[];
  turn: number;
  winner: number | null;
  draw: boolean;
  /** Indexes of the winning line, for highlighting. */
  line: number[] | null;
}

export interface TicTacToeMove {
  cell: number;
}

const LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

export const ticTacToe: GameDefinition<TicTacToeState, TicTacToeMove> = {
  key: 'tic-tac-toe',
  name: 'Tic Tac Toe',
  description: 'Drei in einer Reihe – der Klassiker für zwischendurch.',
  emoji: '⭕',
  minPlayers: 2,
  maxPlayers: 2,

  createInitialState(): TicTacToeState {
    return { board: Array(9).fill(null), turn: 0, winner: null, draw: false, line: null };
  },

  parseMove(raw: unknown): TicTacToeMove | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const cell = (raw as { cell?: unknown }).cell;
    if (typeof cell !== 'number' || !Number.isInteger(cell) || cell < 0 || cell > 8) return null;
    return { cell };
  },

  applyMove(state, move, ctx): GameMoveResult<TicTacToeState> {
    if (state.winner != null || state.draw) return { ok: false, error: 'Das Spiel ist beendet.' };
    if (ctx.seat !== state.turn) return { ok: false, error: 'Du bist nicht am Zug.' };
    if (state.board[move.cell] != null) return { ok: false, error: 'Feld ist bereits belegt.' };

    const board = state.board.slice();
    board[move.cell] = ctx.seat;

    let winner: number | null = null;
    let line: number[] | null = null;
    for (const candidate of LINES) {
      const [a, b, c] = candidate as [number, number, number];
      if (board[a] != null && board[a] === board[b] && board[a] === board[c]) {
        winner = board[a]!;
        line = candidate;
        break;
      }
    }
    const draw = winner == null && board.every((cell) => cell != null);

    return {
      ok: true,
      state: {
        board,
        turn: winner == null && !draw ? (state.turn === 0 ? 1 : 0) : state.turn,
        winner,
        draw,
        line,
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

  describe(state, players: GameSeat[]) {
    if (state.winner != null) {
      const seat = players.find((p) => p.seat === state.winner);
      return seat ? 'Sieg für Spieler ' + (state.winner + 1) : 'Spiel beendet';
    }
    if (state.draw) return 'Unentschieden';
    return 'Spieler ' + (state.turn + 1) + ' ist am Zug';
  },
};
