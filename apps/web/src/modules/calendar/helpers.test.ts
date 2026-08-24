import { describe, expect, it } from 'vitest';
import type { CalendarEventDto } from '@initiative/shared';
import {
  buildOccurrences,
  buildRrule,
  coveredDayKeys,
  dayKey,
  formatOccurrenceTime,
  fromInputs,
  groupByDay,
  monthGridDays,
  nextOccurrence,
  repeatFromRrule,
  weekdayShortLabels,
} from './helpers.js';

function event(overrides: Partial<CalendarEventDto> = {}): CalendarEventDto {
  return {
    id: '11111111-1111-7111-8111-111111111111',
    conversationId: null,
    createdBy: 'me',
    title: 'Test',
    description: null,
    location: null,
    startsAt: '2026-08-24T16:00:00.000Z',
    endsAt: '2026-08-24T17:00:00.000Z',
    allDay: false,
    rrule: null,
    color: null,
    sourcePollId: null,
    attendees: [],
    reminderMinutes: [],
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    ...overrides,
  };
}

describe('month grid', () => {
  it('starts on a Monday and covers six weeks', () => {
    const days = monthGridDays(new Date(2026, 7, 1));
    expect(days).toHaveLength(42);
    expect(days[0].getDay()).toBe(1);
    expect(days.some((day) => dayKey(day) === '2026-08-01')).toBe(true);
    expect(days.some((day) => dayKey(day) === '2026-08-31')).toBe(true);
  });

  it('labels the weekdays in German, Monday first', () => {
    expect(weekdayShortLabels()[0]).toBe('Mo');
    expect(weekdayShortLabels()).toHaveLength(7);
  });
});

describe('occurrences', () => {
  it('expands a weekly series inside the window', () => {
    const series = event({ rrule: 'FREQ=WEEKLY;INTERVAL=1;COUNT=3' });
    const occurrences = buildOccurrences(
      [series],
      new Date('2026-08-01T00:00:00.000Z'),
      new Date('2026-09-30T00:00:00.000Z'),
    );
    expect(occurrences).toHaveLength(3);
    expect(occurrences[1].start.toISOString()).toBe('2026-08-31T16:00:00.000Z');
  });

  it('lists every day a multi-day event touches', () => {
    const trip = event({
      startsAt: '2026-08-24T10:00:00.000Z',
      endsAt: '2026-08-26T10:00:00.000Z',
    });
    const [occurrence] = buildOccurrences(
      [trip],
      new Date('2026-08-01T00:00:00.000Z'),
      new Date('2026-09-01T00:00:00.000Z'),
    );
    expect(coveredDayKeys(occurrence)).toHaveLength(3);
  });

  it('groups by day and keeps all-day events on top', () => {
    const allDay = event({
      id: '22222222-2222-7222-8222-222222222222',
      title: 'Feiertag',
      allDay: true,
      startsAt: '2026-08-24T12:00:00.000Z',
      endsAt: '2026-08-24T12:00:00.000Z',
    });
    const timed = event({
      startsAt: '2026-08-24T06:00:00.000Z',
      endsAt: '2026-08-24T07:00:00.000Z',
    });
    const grouped = groupByDay(
      buildOccurrences(
        [timed, allDay],
        new Date('2026-08-01T00:00:00.000Z'),
        new Date('2026-09-01T00:00:00.000Z'),
      ),
    );
    const day = grouped.get('2026-08-24');
    expect(day?.[0].event.title).toBe('Feiertag');
  });

  it('falls back to the original date for past events', () => {
    const past = event({
      startsAt: '2020-01-01T10:00:00.000Z',
      endsAt: '2020-01-01T11:00:00.000Z',
    });
    expect(nextOccurrence(past, new Date('2026-08-24T00:00:00.000Z')).start.getUTCFullYear()).toBe(
      2020,
    );
  });

  it('labels all-day events without a clock time', () => {
    const allDay = event({
      allDay: true,
      startsAt: '2026-08-24T12:00:00.000Z',
      endsAt: '2026-08-24T12:00:00.000Z',
    });
    const [occurrence] = buildOccurrences(
      [allDay],
      new Date('2026-08-01T00:00:00.000Z'),
      new Date('2026-09-01T00:00:00.000Z'),
    );
    expect(formatOccurrenceTime(occurrence)).toBe('Ganztägig');
  });
});

describe('recurrence rules', () => {
  it('builds and parses a rule without losing anything', () => {
    const rule = buildRrule({
      freq: 'WEEKLY',
      interval: 2,
      end: 'count',
      count: 8,
      until: '',
      byDay: 'MO,WE',
    });
    expect(rule).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=8');
    const parsed = repeatFromRrule(rule);
    expect(parsed).toMatchObject({
      freq: 'WEEKLY',
      interval: 2,
      end: 'count',
      count: 8,
      byDay: 'MO,WE',
    });
  });

  it('turns an until date into a UTC stamp', () => {
    const rule = buildRrule({
      freq: 'DAILY',
      interval: 1,
      end: 'until',
      count: 1,
      until: '2026-09-01',
      byDay: null,
    });
    expect(rule).toMatch(/^FREQ=DAILY;UNTIL=\d{8}T\d{6}Z$/);
  });

  it('has no rule when the event does not repeat', () => {
    expect(
      buildRrule({ freq: 'none', interval: 1, end: 'never', count: 1, until: '', byDay: null }),
    ).toBeNull();
  });
});

describe('inputs', () => {
  it('combines date and time in the local timezone', () => {
    const date = fromInputs('2026-08-24', '18:30');
    expect(date?.getHours()).toBe(18);
    expect(date?.getMinutes()).toBe(30);
  });

  it('rejects incomplete input', () => {
    expect(fromInputs('', '18:30')).toBeNull();
    expect(fromInputs('2026-08-24', '')).toBeNull();
  });
});
