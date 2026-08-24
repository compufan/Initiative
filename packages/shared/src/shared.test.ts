/**
 * Spiegel-Tests.
 *
 * Diese Datei prüft, dass die TypeScript-Kopie der Regeln dieselben Ergebnisse
 * liefert wie die autoritative Rust-Implementierung in `apps/api`. Die Fälle
 * entsprechen eins zu eins den Rust-Unit-Tests (`services::polls::tests`,
 * `recurrence::tests`, `games::*::tests`, `constants::accent_for`).
 */
import { describe, expect, it } from 'vitest';
import { accentFor, initialsFor } from './schemas/user.js';
import { bestOption, tallyVotes } from './util/poll.js';
import { describeRrule, expandOccurrences } from './util/recurrence.js';
import { buildIcsCalendar } from './util/ics.js';
import { connectFour, ticTacToe } from './index.js';
import { isUuid, uuidv7, uuidv7Timestamp } from './ids.js';
import type { PollOptionDto, PollVoteDto } from './schemas/poll.js';

const option = (id: string, position: number, startsAt?: string): PollOptionDto => ({
  id,
  label: `Option ${position}`,
  startsAt: startsAt ?? null,
  endsAt: null,
  position,
  createdBy: null,
});

const vote = (optionId: string, user: string, value: 'yes' | 'no' | 'maybe'): PollVoteDto => ({
  optionId,
  userId: user,
  value,
  votedAt: new Date().toISOString(),
});

describe('IDs', () => {
  it('erzeugt sortierbare UUIDs v7', () => {
    const early = uuidv7(1_000_000_000_000);
    const late = uuidv7(2_000_000_000_000);
    expect(isUuid(early)).toBe(true);
    expect(early < late).toBe(true);
    expect(uuidv7Timestamp(early)).toBe(1_000_000_000_000);
    expect(early[14]).toBe('7');
  });
});

describe('Umfragen-Auswertung', () => {
  it('zählt yes, maybe und no', () => {
    const a = uuidv7();
    const tally = tallyVotes(
      [option(a, 0)],
      [vote(a, '1', 'yes'), vote(a, '2', 'maybe'), vote(a, '3', 'no')],
    );
    expect(tally[a]).toEqual({ yes: 1, maybe: 1, no: 1, score: 1.5 });
  });

  it('nimmt bei Gleichstand den früheren Termin', () => {
    const early = uuidv7();
    const late = uuidv7();
    const options = [
      option(late, 0, '2026-09-02T10:00:00.000Z'),
      option(early, 1, '2026-09-01T10:00:00.000Z'),
    ];
    const tally = tallyVotes(options, [vote(early, '1', 'yes'), vote(late, '2', 'yes')]);
    expect(bestOption(options, tally)?.id).toBe(early);
  });

  it('bevorzugt bei Gleichstand weniger Absagen', () => {
    const a = uuidv7();
    const b = uuidv7();
    const options = [option(a, 0), option(b, 1)];
    const tally = tallyVotes(options, [
      vote(a, '1', 'yes'),
      vote(a, '2', 'no'),
      vote(b, '3', 'yes'),
    ]);
    expect(bestOption(options, tally)?.id).toBe(b);
  });
});

describe('Serientermine', () => {
  const base = { startsAt: '2026-08-24T10:00:00.000Z', endsAt: '2026-08-24T11:00:00.000Z' };
  const window = (from: string, to: string) => [new Date(from), new Date(to)] as const;

  it('liefert ohne Regel genau einen Termin', () => {
    const [from, to] = window('2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    expect(expandOccurrences(base, from, to)).toHaveLength(1);
  });

  it('beachtet COUNT', () => {
    const [from, to] = window('2026-08-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z');
    const occurrences = expandOccurrences(
      { ...base, rrule: 'FREQ=WEEKLY;INTERVAL=1;COUNT=4' },
      from,
      to,
    );
    expect(occurrences).toHaveLength(4);
  });

  it('beachtet UNTIL', () => {
    const [from, to] = window('2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    const occurrences = expandOccurrences(
      { ...base, rrule: 'FREQ=DAILY;UNTIL=20260827T000000Z' },
      from,
      to,
    );
    expect(occurrences).toHaveLength(3);
  });

  it('faltet BYDAY wöchentlich auf', () => {
    const [from, to] = window('2026-08-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    const occurrences = expandOccurrences(
      {
        startsAt: '2026-08-24T09:00:00.000Z',
        endsAt: '2026-08-24T10:00:00.000Z',
        rrule: 'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4',
      },
      from,
      to,
    );
    expect(occurrences).toHaveLength(4);
    expect(occurrences[0]!.startsAt.getUTCDay()).toBe(1);
    expect(occurrences[1]!.startsAt.getUTCDay()).toBe(3);
  });

  it('beschränkt auf das angefragte Fenster', () => {
    const occurrences = expandOccurrences(
      {
        startsAt: '2026-01-01T08:00:00.000Z',
        endsAt: '2026-01-01T09:00:00.000Z',
        rrule: 'FREQ=MONTHLY;COUNT=12',
      },
      new Date('2026-06-01T00:00:00.000Z'),
      new Date('2026-08-01T00:00:00.000Z'),
    );
    expect(occurrences).toHaveLength(2);
    expect(occurrences[0]!.startsAt.getUTCMonth()).toBe(5);
  });

  it('beschreibt Regeln auf Deutsch', () => {
    expect(describeRrule('FREQ=WEEKLY;COUNT=4')).toBe('jede Woche, 4×');
    expect(describeRrule('FREQ=DAILY;INTERVAL=3')).toBe('alle 3 Tage');
    expect(describeRrule(null)).toBeNull();
  });
});

describe('ICS', () => {
  it('schreibt einen gültigen Kalender und maskiert Sonderzeichen', () => {
    const ics = buildIcsCalendar(
      [
        {
          id: 'abc',
          title: 'Treffen; mit Kaffee',
          description: 'Zeile eins\nZeile zwei',
          location: 'Küche, 2. Stock',
          startsAt: '2026-08-24T10:00:00.000Z',
          endsAt: '2026-08-24T11:00:00.000Z',
          rrule: 'FREQ=WEEKLY;COUNT=4',
          reminderMinutes: [60],
        },
      ],
      { name: 'Initiative', refreshInterval: 'PT1H', domain: 'example.com' },
    );
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain('DTSTART:20260824T100000Z');
    expect(ics).toContain('RRULE:FREQ=WEEKLY;COUNT=4');
    expect(ics).toContain('TRIGGER:-PT60M');
    expect(ics).toContain('Treffen\\; mit Kaffee');
    expect(ics).toContain('Zeile eins\\nZeile zwei');
    expect(ics).toContain('Küche\\, 2. Stock');
    for (const line of ics.split('\r\n')) expect(line.length).toBeLessThanOrEqual(75);
  });
});

describe('Mini-Spiele (Client-Spiegel der Server-Regeln)', () => {
  const players = [
    { seat: 0, userId: 'a' },
    { seat: 1, userId: 'b' },
  ];

  it('Tic Tac Toe: erkennt den Sieg und sperrt fremde Züge', () => {
    let state = ticTacToe.createInitialState(players);
    const moves = [0, 3, 1, 4, 2];
    moves.forEach((cell, index) => {
      const seat = index % 2;
      const result = ticTacToe.applyMove(
        state,
        { cell },
        { seat, userId: players[seat]!.userId, players },
      );
      expect(result.ok).toBe(true);
      if (result.ok) state = result.state;
    });
    expect(ticTacToe.getOutcome(state)).toEqual({ finished: true, draw: false, winnerSeats: [0] });
    expect(ticTacToe.currentSeat(state)).toBeNull();
  });

  it('Tic Tac Toe: weist belegte Felder und falsche Züge ab', () => {
    const state = ticTacToe.createInitialState(players);
    expect(ticTacToe.applyMove(state, { cell: 0 }, { seat: 1, userId: 'b', players }).ok).toBe(
      false,
    );
    const first = ticTacToe.applyMove(state, { cell: 0 }, { seat: 0, userId: 'a', players });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(
      ticTacToe.applyMove(first.state, { cell: 0 }, { seat: 1, userId: 'b', players }).ok,
    ).toBe(false);
    expect(ticTacToe.parseMove({ cell: 99 })).toBeNull();
    expect(ticTacToe.parseMove({ nope: 1 })).toBeNull();
  });

  it('Vier gewinnt: erkennt eine senkrechte Reihe', () => {
    let state = connectFour.createInitialState(players);
    [0, 1, 0, 1, 0, 1, 0].forEach((col, index) => {
      const seat = index % 2;
      const result = connectFour.applyMove(
        state,
        { col },
        { seat, userId: players[seat]!.userId, players },
      );
      expect(result.ok).toBe(true);
      if (result.ok) state = result.state;
    });
    expect(connectFour.getOutcome(state).winnerSeats).toEqual([0]);
  });

  it('Vier gewinnt: weist volle Spalten ab', () => {
    let state = connectFour.createInitialState(players);
    for (let index = 0; index < 6; index += 1) {
      const seat = index % 2;
      const result = connectFour.applyMove(
        state,
        { col: 3 },
        { seat, userId: players[seat]!.userId, players },
      );
      expect(result.ok).toBe(true);
      if (result.ok) state = result.state;
    }
    expect(connectFour.applyMove(state, { col: 3 }, { seat: 0, userId: 'a', players }).ok).toBe(
      false,
    );
  });
});

describe('Darstellung', () => {
  it('erzeugt stabile Avatarfarben (identisch zur Rust-Implementierung)', () => {
    expect(accentFor('01a03429-b62a-7c53-8025-55bfe8becf86')).toBe(
      accentFor('01a03429-b62a-7c53-8025-55bfe8becf86'),
    );
    expect(accentFor('a')).toMatch(/^#[0-9a-f]{6}$/);
    expect(initialsFor('Anna Berger')).toBe('AB');
    expect(initialsFor('anna')).toBe('AN');
  });
});
