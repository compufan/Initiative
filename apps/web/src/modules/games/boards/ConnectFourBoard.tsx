import type { CSSProperties } from 'react';
import {
  CONNECT_FOUR_COLS as COLS,
  CONNECT_FOUR_ROWS as ROWS,
  type ConnectFourState,
} from '@initiative/shared';
import type { GameBoardProps, GameMiniBoardProps } from './registry.js';
import { BoardStatus } from './BoardStatus.js';
import { seatClass } from '../helpers.js';

const DIRECTIONS: [number, number][] = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
];

/** Reads the server state defensively – an unknown shape renders as empty. */
function readState(raw: unknown): ConnectFourState {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<ConnectFourState>;
  const columns = Array.isArray(value.columns) ? value.columns : [];
  const move = value.lastMove;
  return {
    columns: Array.from({ length: COLS }, (_, col) => {
      const column = columns[col];
      return Array.isArray(column)
        ? column.filter((seat): seat is number => typeof seat === 'number').slice(0, ROWS)
        : [];
    }),
    turn: typeof value.turn === 'number' ? value.turn : 0,
    winner: typeof value.winner === 'number' ? value.winner : null,
    draw: value.draw === true,
    lastMove:
      move && typeof move.col === 'number' && typeof move.row === 'number'
        ? { col: move.col, row: move.row }
        : null,
  };
}

function seatAt(state: ConnectFourState, col: number, row: number): number | null {
  const column = state.columns[col];
  if (!column || row < 0 || row >= column.length) return null;
  return column[row] ?? null;
}

/**
 * The winning four, computed locally for the highlight.
 *
 * The rules only store who won, so the client recomputes which stones did it –
 * a pure display detail that never leaves this component.
 */
function winningCells(state: ConnectFourState): Set<string> {
  const cells = new Set<string>();
  if (state.winner == null) return cells;
  for (let col = 0; col < COLS; col += 1) {
    for (let row = 0; row < ROWS; row += 1) {
      if (seatAt(state, col, row) !== state.winner) continue;
      for (const [dc, dr] of DIRECTIONS) {
        const line: string[] = [];
        for (let step = 0; step < 4; step += 1) {
          const c = col + dc * step;
          const r = row + dr * step;
          if (seatAt(state, c, r) !== state.winner) break;
          line.push(`${c}:${r}`);
        }
        if (line.length === 4) for (const cell of line) cells.add(cell);
      }
    }
  }
  return cells;
}

function columnLabel(column: number[], index: number): string {
  if (column.length === 0) return `Spalte ${index + 1}, leer`;
  if (column.length >= ROWS) return `Spalte ${index + 1}, voll`;
  return `Spalte ${index + 1}, ${column.length} von ${ROWS} Feldern belegt`;
}

/** 7x6 board: tapping a column drops the stone, full columns are disabled. */
export function ConnectFourBoard({ session, mySeat, onMove, busy }: GameBoardProps) {
  const state = readState(session.state);
  const myTurn = session.status === 'active' && mySeat != null && state.turn === mySeat;
  const wins = winningCells(state);

  return (
    <div className="game-board-wrap">
      <div className="c4-board" role="grid" aria-label="Vier gewinnt Spielbrett">
        <div className="c4-cols" role="row">
          {state.columns.map((column, col) => {
            const full = column.length >= ROWS;
            return (
              <button
                key={col}
                type="button"
                role="gridcell"
                className={`c4-col${myTurn && !full ? ' is-open' : ''}`}
                aria-label={columnLabel(column, col)}
                disabled={busy || !myTurn || full}
                onClick={() => onMove({ col })}
              >
                {Array.from({ length: ROWS }, (_, offset) => {
                  const row = ROWS - 1 - offset;
                  const seat = seatAt(state, col, row);
                  const dropped =
                    state.lastMove != null &&
                    state.lastMove.col === col &&
                    state.lastMove.row === row;
                  return (
                    <span key={row} className="c4-slot" aria-hidden="true">
                      <span
                        className={`c4-disc ${seatClass(seat)}${seat == null ? ' is-empty' : ''}${
                          wins.has(`${col}:${row}`) ? ' is-win' : ''
                        }${dropped ? ' is-drop' : ''}`}
                        style={{ '--fall': String(ROWS - row) } as CSSProperties}
                      />
                    </span>
                  );
                })}
              </button>
            );
          })}
        </div>
      </div>

      {mySeat != null && state.winner == null && !state.draw && (
        <p className="game-hint">
          Du spielst{' '}
          <span className={`c4-disc c4-disc-inline ${seatClass(mySeat)}`} aria-hidden="true" />
        </p>
      )}

      <BoardStatus session={session} />
    </div>
  );
}

/** Compact preview for the chat bubble. */
export function ConnectFourMini({ session }: GameMiniBoardProps) {
  const state = readState(session.state);
  return (
    <div className="c4-mini" aria-hidden="true">
      {Array.from({ length: ROWS }, (_, offset) => {
        const row = ROWS - 1 - offset;
        return (
          <span className="c4-mini-row" key={row}>
            {Array.from({ length: COLS }, (_, col) => {
              const seat = seatAt(state, col, row);
              return (
                <span
                  key={col}
                  className={`c4-mini-cell ${seatClass(seat)}${seat == null ? ' is-empty' : ''}`}
                />
              );
            })}
          </span>
        );
      })}
    </div>
  );
}
