import { describe, expect, it } from 'vitest';
import { ticTacToe, type GameSessionDto } from '@initiative/shared';
import {
  applyMoveLocally,
  compareSessions,
  gameInfoFor,
  playersLabel,
  seatClass,
  statusInfo,
} from './helpers.js';

const ME = '11111111-1111-7111-8111-111111111111';
const OTHER = '22222222-2222-7222-8222-222222222222';

function session(overrides: Partial<GameSessionDto> = {}): GameSessionDto {
  return {
    id: '33333333-3333-7333-8333-333333333333',
    conversationId: '44444444-4444-7444-8444-444444444444',
    messageId: null,
    gameKey: 'tic-tac-toe',
    status: 'active',
    players: [
      { userId: ME, seat: 0, joinedAt: '2026-08-24T10:00:00.000Z' },
      { userId: OTHER, seat: 1, joinedAt: '2026-08-24T10:00:00.000Z' },
    ],
    state: ticTacToe.createInitialState([
      { seat: 0, userId: ME },
      { seat: 1, userId: OTHER },
    ]),
    turnUserId: ME,
    winnerUserIds: [],
    createdBy: ME,
    createdAt: '2026-08-24T10:00:00.000Z',
    updatedAt: '2026-08-24T10:00:00.000Z',
    version: 0,
    ...overrides,
  };
}

const nameOf = (userId: string) => (userId === OTHER ? 'Anna' : 'Ben');

describe('status line', () => {
  it('names the player who has to move', () => {
    expect(statusInfo(session(), ME, nameOf)).toEqual({ text: 'Du bist am Zug', tone: 'turn' });
    expect(statusInfo(session({ turnUserId: OTHER }), ME, nameOf)).toEqual({
      text: 'Wartet auf Anna',
      tone: 'wait',
    });
  });

  it('reports the result of a finished match', () => {
    expect(statusInfo(session({ status: 'finished', winnerUserIds: [ME] }), ME, nameOf).text).toBe(
      'Du hast gewonnen',
    );
    expect(
      statusInfo(session({ status: 'finished', winnerUserIds: [OTHER] }), ME, nameOf).text,
    ).toBe('Sieg für Anna');
    expect(statusInfo(session({ status: 'finished' }), ME, nameOf).text).toBe('Unentschieden');
  });

  it('names who gave up', () => {
    expect(
      statusInfo(session({ status: 'aborted', winnerUserIds: [OTHER] }), ME, nameOf).text,
    ).toBe('Du hast aufgegeben');
  });

  it('waits for players while the match is open', () => {
    expect(statusInfo(session({ status: 'open', turnUserId: null }), ME, nameOf).tone).toBe('open');
  });
});

describe('players label', () => {
  it('puts the viewer first as "Du"', () => {
    expect(playersLabel(session(), ME, nameOf)).toBe('Du gegen Anna');
  });

  it('mentions a missing opponent', () => {
    const open = session({
      players: [{ userId: ME, seat: 0, joinedAt: '2026-08-24T10:00:00.000Z' }],
    });
    expect(playersLabel(open, ME, nameOf)).toBe('Du wartest auf Mitspieler');
  });
});

describe('optimistic moves', () => {
  it('applies a legal move and hands the turn over', () => {
    const result = applyMoveLocally(session(), { cell: 4 }, ME);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session.turnUserId).toBe(OTHER);
    expect((result.session.state as { board: (number | null)[] }).board[4]).toBe(0);
  });

  it('rejects a move that is not mine', () => {
    const result = applyMoveLocally(session({ turnUserId: OTHER }), { cell: 0 }, OTHER);
    expect(result).toEqual({ ok: false, error: 'Du bist nicht am Zug.' });
  });

  it('rejects malformed input before it hits the network', () => {
    expect(applyMoveLocally(session(), { cell: 99 }, ME)).toEqual({
      ok: false,
      error: 'Ungültiger Zug.',
    });
  });

  it('finishes the match when the line is complete', () => {
    const state = {
      board: [0, 0, null, 1, 1, null, null, null, null],
      turn: 0,
      winner: null,
      draw: false,
      line: null,
    };
    const result = applyMoveLocally(session({ state }), { cell: 2 }, ME);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session.status).toBe('finished');
    expect(result.session.winnerUserIds).toEqual([ME]);
    expect(result.session.turnUserId).toBeNull();
  });
});

describe('list order', () => {
  it('shows my turn first, then running matches, then finished ones', () => {
    const mine = session({ id: 'a', turnUserId: ME });
    const theirs = session({ id: 'b', turnUserId: OTHER });
    const over = session({
      id: 'c',
      status: 'finished',
      turnUserId: null,
      updatedAt: '2026-08-25T10:00:00.000Z',
    });
    expect([over, theirs, mine].sort(compareSessions(ME)).map((item) => item.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });
});

describe('catalog fallback', () => {
  it('falls back to the local copy of the rules', () => {
    expect(gameInfoFor('tic-tac-toe').name).toBe('Tic Tac Toe');
    expect(gameInfoFor('nope').emoji).toBe('🎮');
  });

  it('gives every seat its own colour class', () => {
    expect(seatClass(0)).not.toBe(seatClass(1));
    expect(seatClass(null)).toBe('game-seat-none');
  });
});
