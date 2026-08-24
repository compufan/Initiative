import { describe, expect, it } from 'vitest';
import type { PollDto, PollOptionDto } from '@initiative/shared';
import {
  applyMyVotes,
  buildSlot,
  closesInLabel,
  formatMinutes,
  formatSlotTime,
  monthGridDays,
  parseTime,
  percentOf,
  votesVisible,
} from './helpers.js';

const ME = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';

function option(id: string, overrides: Partial<PollOptionDto> = {}): PollOptionDto {
  return { id, label: id, startsAt: null, endsAt: null, position: 0, createdBy: ME, ...overrides };
}

function poll(overrides: Partial<PollDto> = {}): PollDto {
  const options = overrides.options ?? [option('a'), option('b')];
  return {
    id: 'cccccccc-cccc-7ccc-8ccc-cccccccccccc',
    conversationId: 'dddddddd-dddd-7ddd-8ddd-dddddddddddd',
    messageId: null,
    createdBy: ME,
    kind: 'choice',
    question: 'Wann?',
    description: null,
    multiple: false,
    anonymous: false,
    allowAddOptions: false,
    closesAt: null,
    closedAt: null,
    votes: [],
    tally: Object.fromEntries(
      options.map((item) => [item.id, { yes: 0, maybe: 0, no: 0, score: 0 }]),
    ),
    voterCount: 0,
    myVotes: [],
    createdEventId: null,
    createdAt: '2026-08-24T10:00:00.000Z',
    ...overrides,
    options,
  };
}

describe('applyMyVotes', () => {
  it('recomputes tally and voters from the vote list when votes are visible', () => {
    const base = poll({
      votes: [{ optionId: 'a', userId: OTHER, value: 'yes', votedAt: '2026-08-24T10:00:00.000Z' }],
      tally: { a: { yes: 1, maybe: 0, no: 0, score: 1 }, b: { yes: 0, maybe: 0, no: 0, score: 0 } },
      voterCount: 1,
    });

    const next = applyMyVotes(base, ME, [{ optionId: 'b', value: 'yes' }]);

    expect(next.myVotes).toHaveLength(1);
    expect(next.tally.a.yes).toBe(1);
    expect(next.tally.b.yes).toBe(1);
    expect(next.voterCount).toBe(2);
  });

  it('replaces the previous own answer instead of adding a second one', () => {
    const base = applyMyVotes(poll(), ME, [{ optionId: 'a', value: 'yes' }]);
    const next = applyMyVotes(base, ME, [{ optionId: 'b', value: 'yes' }]);

    expect(next.myVotes.map((vote) => vote.optionId)).toEqual(['b']);
    expect(next.tally.a.yes).toBe(0);
    expect(next.voterCount).toBe(1);
  });

  it('takes the own vote back when the list is empty', () => {
    const base = applyMyVotes(poll(), ME, [{ optionId: 'a', value: 'yes' }]);
    const next = applyMyVotes(base, ME, []);

    expect(next.myVotes).toEqual([]);
    expect(next.tally.a.yes).toBe(0);
    expect(next.voterCount).toBe(0);
  });

  it('adjusts the counters by hand when the votes stay hidden', () => {
    const base = poll({
      createdBy: OTHER,
      anonymous: true,
      votes: [],
      tally: { a: { yes: 2, maybe: 0, no: 0, score: 2 }, b: { yes: 0, maybe: 0, no: 0, score: 0 } },
      voterCount: 2,
    });
    expect(votesVisible(base, ME)).toBe(false);

    const next = applyMyVotes(base, ME, [{ optionId: 'a', value: 'yes' }]);

    expect(next.votes).toEqual([]);
    expect(next.tally.a.yes).toBe(3);
    expect(next.voterCount).toBe(3);
    expect(percentOf(next, 'a')).toBe(100);
  });

  it('scores a maybe of a date poll as half a yes', () => {
    const next = applyMyVotes(poll({ kind: 'date', multiple: true }), ME, [
      { optionId: 'a', value: 'maybe' },
      { optionId: 'b', value: 'no' },
    ]);

    expect(next.tally.a.score).toBe(0.5);
    expect(next.tally.b.no).toBe(1);
    expect(next.voterCount).toBe(1);
  });
});

describe('slots', () => {
  it('builds a slot of the requested length', () => {
    const day = new Date(2026, 10, 10);
    const slot = buildSlot(day, 10 * 60, 90);
    const start = new Date(slot.startsAt);
    const end = new Date(slot.endsAt);

    expect(start.getHours()).toBe(10);
    expect(end.getTime() - start.getTime()).toBe(90 * 60_000);
    expect(formatSlotTime(option('a', slot))).toBe('10:00–11:30');
  });

  it('covers the whole day for an all-day proposal', () => {
    const slot = buildSlot(new Date(2026, 10, 10), 0, 'allDay');
    const start = new Date(slot.startsAt);

    expect(start.getHours()).toBe(0);
    expect(formatSlotTime(option('a', slot))).toBe('Ganztägig');
  });
});

describe('times', () => {
  it('parses and formats minutes since midnight', () => {
    expect(parseTime('09:05')).toBe(545);
    expect(parseTime('9:05')).toBe(545);
    expect(formatMinutes(545)).toBe('09:05');
    expect(parseTime('24:00')).toBeNull();
    expect(parseTime('abc')).toBeNull();
  });
});

describe('closesInLabel', () => {
  const now = new Date('2026-08-24T10:00:00.000Z').getTime();

  it('describes a pending deadline', () => {
    expect(closesInLabel(poll({ closesAt: '2026-08-24T10:30:00.000Z' }), now)).toBe(
      'endet in 30 Min.',
    );
    expect(closesInLabel(poll({ closesAt: '2026-08-24T14:00:00.000Z' }), now)).toBe(
      'endet in 4 Std.',
    );
    expect(closesInLabel(poll({ closesAt: '2026-08-25T10:00:00.000Z' }), now)).toBe('endet morgen');
  });

  it('stays empty without a deadline, after it passed or once closed', () => {
    expect(closesInLabel(poll(), now)).toBeNull();
    expect(closesInLabel(poll({ closesAt: '2026-08-24T09:00:00.000Z' }), now)).toBeNull();
    expect(
      closesInLabel(
        poll({ closesAt: '2026-08-25T10:00:00.000Z', closedAt: '2026-08-24T09:00:00.000Z' }),
        now,
      ),
    ).toBeNull();
  });
});

describe('monthGridDays', () => {
  it('starts on a Monday and covers six weeks', () => {
    const days = monthGridDays(new Date(2026, 10, 1));
    expect(days).toHaveLength(42);
    expect(days[0].getDay()).toBe(1);
    expect(days.some((day) => day.getMonth() === 10 && day.getDate() === 1)).toBe(true);
  });
});
