import type { TicTacToeState } from '@initiative/shared';
import type { GameBoardProps, GameMiniBoardProps } from './registry.js';
import { BoardStatus } from './BoardStatus.js';
import { seatClass } from '../helpers.js';

const SIZE = 3;
const MARKS = ['✕', '◯', '△', '□'];

function markOf(seat: number | null): string {
  return seat == null ? '' : (MARKS[seat % MARKS.length] ?? '?');
}

function markName(seat: number | null): string {
  if (seat == null) return 'leer';
  return seat === 0 ? 'X' : seat === 1 ? 'O' : `Spieler ${seat + 1}`;
}

/** Reads the server state defensively – an unknown shape renders as empty. */
function readState(raw: unknown): TicTacToeState {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<TicTacToeState>;
  const board = Array.isArray(value.board) ? value.board : [];
  return {
    board: Array.from({ length: SIZE * SIZE }, (_, index) =>
      typeof board[index] === 'number' ? (board[index] as number) : null,
    ),
    turn: typeof value.turn === 'number' ? value.turn : 0,
    winner: typeof value.winner === 'number' ? value.winner : null,
    draw: value.draw === true,
    line: Array.isArray(value.line)
      ? value.line.filter((index): index is number => typeof index === 'number')
      : null,
  };
}

/** 3x3 board: big fields, marks in the seat colours, winning line highlighted. */
export function TicTacToeBoard({ session, mySeat, onMove, busy }: GameBoardProps) {
  const state = readState(session.state);
  const myTurn = session.status === 'active' && mySeat != null && state.turn === mySeat;
  const line = state.line ?? [];

  return (
    <div className="game-board-wrap">
      <div className="ttt-board" role="grid" aria-label="Tic Tac Toe Spielbrett">
        {Array.from({ length: SIZE }, (_, row) => (
          <div className="ttt-row" role="row" key={row}>
            {Array.from({ length: SIZE }, (_, column) => {
              const index = row * SIZE + column;
              const seat = state.board[index] ?? null;
              const won = line.includes(index);
              return (
                <button
                  key={column}
                  type="button"
                  role="gridcell"
                  className={`ttt-cell ${seatClass(seat)}${won ? ' is-win' : ''}${
                    seat == null && myTurn ? ' is-open' : ''
                  }`}
                  aria-label={`Zeile ${row + 1}, Spalte ${column + 1}, ${markName(seat)}`}
                  disabled={busy || !myTurn || seat != null}
                  onClick={() => onMove({ cell: index })}
                >
                  <span aria-hidden="true">{markOf(seat)}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {mySeat != null && !state.draw && state.winner == null && (
        <p className="game-hint">
          Du spielst{' '}
          <span className={`game-mark ${seatClass(mySeat)}`} aria-hidden="true">
            {markOf(mySeat)}
          </span>
        </p>
      )}

      <BoardStatus session={session} />
    </div>
  );
}

/** Compact preview for the chat bubble. */
export function TicTacToeMini({ session }: GameMiniBoardProps) {
  const state = readState(session.state);
  const line = state.line ?? [];
  return (
    <div className="ttt-mini" aria-hidden="true">
      {state.board.map((seat, index) => (
        <span
          key={index}
          className={`ttt-mini-cell ${seatClass(seat)}${line.includes(index) ? ' is-win' : ''}`}
        >
          {markOf(seat)}
        </span>
      ))}
    </div>
  );
}
