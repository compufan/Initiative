/**
 * Minimal RRULE support (subset of RFC 5545) – enough for "every day / week /
 * month / year", optional interval, BYDAY for weekly rules and COUNT or UNTIL
 * as the stop condition. Expansion happens on demand for a requested window, so
 * infinite series never have to be materialised in the database.
 */

export interface ParsedRule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  count: number | null;
  until: Date | null;
  byDay: number[] | null;
}

const DAY_INDEX: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

export function parseRrule(rrule: string | null | undefined): ParsedRule | null {
  if (!rrule) return null;
  const parts = rrule
    .replace(/^RRULE:/i, '')
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean);
  const map = new Map<string, string>();
  for (const part of parts) {
    const [key, value] = part.split('=');
    if (key && value) map.set(key.toUpperCase(), value.toUpperCase());
  }
  const freq = map.get('FREQ');
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY') return null;

  const interval = Number.parseInt(map.get('INTERVAL') ?? '1', 10);
  const countRaw = map.get('COUNT');
  const untilRaw = map.get('UNTIL');
  const byDayRaw = map.get('BYDAY');

  return {
    freq,
    interval: Number.isFinite(interval) && interval > 0 ? interval : 1,
    count: countRaw ? Number.parseInt(countRaw, 10) : null,
    until: untilRaw ? parseIcsDate(untilRaw) : null,
    byDay: byDayRaw
      ? byDayRaw
          .split(',')
          .map((d) => DAY_INDEX[d.trim().slice(-2)])
          .filter((d): d is number => d != null)
      : null,
  };
}

function parseIcsDate(value: string): Date | null {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(value.trim());
  if (!match) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const [, y, m, d, hh, mm, ss] = match;
  return new Date(
    Date.UTC(
      Number(y),
      Number(m) - 1,
      Number(d),
      Number(hh ?? 0),
      Number(mm ?? 0),
      Number(ss ?? 0),
    ),
  );
}

function addUnits(date: Date, rule: ParsedRule, steps: number): Date {
  const next = new Date(date.getTime());
  switch (rule.freq) {
    case 'DAILY':
      next.setUTCDate(next.getUTCDate() + rule.interval * steps);
      break;
    case 'WEEKLY':
      next.setUTCDate(next.getUTCDate() + 7 * rule.interval * steps);
      break;
    case 'MONTHLY':
      next.setUTCMonth(next.getUTCMonth() + rule.interval * steps);
      break;
    case 'YEARLY':
      next.setUTCFullYear(next.getUTCFullYear() + rule.interval * steps);
      break;
  }
  return next;
}

export interface ExpansionInput {
  startsAt: string | Date;
  endsAt: string | Date;
  rrule?: string | null;
}

export interface ExpandedOccurrence {
  index: number;
  startsAt: Date;
  endsAt: Date;
}

const MAX_OCCURRENCES = 500;

/** Materialise every occurrence overlapping [windowStart, windowEnd]. */
export function expandOccurrences(
  input: ExpansionInput,
  windowStart: Date,
  windowEnd: Date,
): ExpandedOccurrence[] {
  const start = input.startsAt instanceof Date ? input.startsAt : new Date(input.startsAt);
  const end = input.endsAt instanceof Date ? input.endsAt : new Date(input.endsAt);
  const durationMs = Math.max(0, end.getTime() - start.getTime());
  const rule = parseRrule(input.rrule);

  if (!rule) {
    return start.getTime() <= windowEnd.getTime() && end.getTime() >= windowStart.getTime()
      ? [{ index: 0, startsAt: start, endsAt: end }]
      : [];
  }

  const result: ExpandedOccurrence[] = [];
  const weeklyDays = rule.freq === 'WEEKLY' && rule.byDay?.length ? rule.byDay : null;
  let emitted = 0;

  for (let step = 0; step < MAX_OCCURRENCES; step += 1) {
    const base = addUnits(start, rule, step);
    if (base.getTime() > windowEnd.getTime() && emitted > 0) break;
    if (rule.until && base.getTime() > rule.until.getTime()) break;

    const candidates: Date[] = [];
    if (weeklyDays) {
      // Anchor to the Sunday of the occurrence week, then pick the BYDAY offsets.
      const weekStart = new Date(base.getTime());
      weekStart.setUTCDate(weekStart.getUTCDate() - weekStart.getUTCDay());
      for (const day of [...weeklyDays].sort((a, b) => a - b)) {
        const candidate = new Date(weekStart.getTime());
        candidate.setUTCDate(candidate.getUTCDate() + day);
        candidate.setUTCHours(
          start.getUTCHours(),
          start.getUTCMinutes(),
          start.getUTCSeconds(),
          start.getUTCMilliseconds(),
        );
        if (candidate.getTime() >= start.getTime()) candidates.push(candidate);
      }
    } else {
      candidates.push(base);
    }

    for (const candidate of candidates) {
      if (rule.count != null && emitted >= rule.count) return result;
      if (rule.until && candidate.getTime() > rule.until.getTime()) return result;
      emitted += 1;
      const occurrenceEnd = new Date(candidate.getTime() + durationMs);
      if (
        candidate.getTime() <= windowEnd.getTime() &&
        occurrenceEnd.getTime() >= windowStart.getTime()
      ) {
        result.push({ index: emitted - 1, startsAt: candidate, endsAt: occurrenceEnd });
      }
    }

    if (rule.count != null && emitted >= rule.count) break;
    if (base.getTime() > windowEnd.getTime()) break;
  }

  return result;
}

export function describeRrule(rrule: string | null | undefined): string | null {
  const rule = parseRrule(rrule);
  if (!rule) return null;
  const every = rule.interval > 1 ? `alle ${rule.interval} ` : 'jede';
  const unit = { DAILY: 'Tage', WEEKLY: 'Wochen', MONTHLY: 'Monate', YEARLY: 'Jahre' }[rule.freq];
  const singular = { DAILY: 'n Tag', WEEKLY: ' Woche', MONTHLY: 'n Monat', YEARLY: 's Jahr' }[
    rule.freq
  ];
  const base = rule.interval > 1 ? `${every}${unit}` : `${every}${singular}`;
  const suffix = rule.count
    ? `, ${rule.count}×`
    : rule.until
      ? ` bis ${rule.until.toLocaleDateString('de-DE')}`
      : '';
  return base + suffix;
}
