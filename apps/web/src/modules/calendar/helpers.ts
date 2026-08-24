import { useEffect, useMemo, useRef, useState } from 'react';
import {
  describeRrule,
  expandOccurrences,
  parseRrule,
  type CalendarEventDto,
  type ConversationDto,
  type RsvpStatus,
  type UserDto,
} from '@initiative/shared';
import { api } from '../../lib/api.js';
import { useChat } from '../../state/chat.js';

/**
 * Shared helpers of the calendar module: date maths, German formatting,
 * occurrence expansion and the small lookups the screens need. Everything that
 * has to look identical in the month grid, the agenda, the chat bubble and the
 * detail screen lives here exactly once.
 */

export const AGENDA_DAYS = 60;
export const DAY_MS = 86_400_000;

/* ---------- dates ---------- */

const timeFormat = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });
const monthYearFormat = new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric' });
const monthShortFormat = new Intl.DateTimeFormat('de-DE', { month: 'short' });
const shortDateFormat = new Intl.DateTimeFormat('de-DE', {
  day: '2-digit',
  month: '2-digit',
  year: '2-digit',
});
const dayHeadingFormat = new Intl.DateTimeFormat('de-DE', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});
const dayHeadingYearFormat = new Intl.DateTimeFormat('de-DE', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});
const fullDateFormat = new Intl.DateTimeFormat('de-DE', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});
const weekdayShortFormat = new Intl.DateTimeFormat('de-DE', { weekday: 'short' });

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** DST-safe day arithmetic (setDate keeps the wall-clock time). */
export function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

export function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function addMonths(date: Date, months: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + months, 1);
}

export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function isSameDay(a: Date, b: Date): boolean {
  return dayKey(a) === dayKey(b);
}

/** Whole days between today and the given day (0 = today, 1 = tomorrow). */
export function dayOffset(date: Date): number {
  return Math.round((startOfDay(date).getTime() - startOfDay(new Date()).getTime()) / DAY_MS);
}

/** Monday-first grid of six weeks covering the given month. */
export function monthGridDays(month: Date): Date[] {
  const first = startOfMonth(month);
  const offset = (first.getDay() + 6) % 7;
  const start = addDays(first, -offset);
  return Array.from({ length: 42 }, (_, index) => addDays(start, index));
}

/** ['Mo', 'Di', …] – derived from the locale instead of hard-coded. */
export function weekdayShortLabels(): string[] {
  // 2024-01-01 was a Monday, so the offsets line up with the grid.
  return Array.from({ length: 7 }, (_, index) =>
    weekdayShortFormat.format(new Date(2024, 0, 1 + index)).replace('.', ''),
  );
}

export function formatTime(date: Date): string {
  return timeFormat.format(date);
}

export function formatMonthTitle(month: Date): string {
  return monthYearFormat.format(month);
}

export function formatMonthShort(date: Date): string {
  return monthShortFormat.format(date).replace('.', '');
}

export function formatShortDate(date: Date): string {
  return shortDateFormat.format(date);
}

export function formatFullDate(date: Date): string {
  return fullDateFormat.format(date);
}

/** "Heute", "Morgen", "Gestern" or a full German weekday heading. */
export function formatDayHeading(date: Date): string {
  const offset = dayOffset(date);
  if (offset === 0) return 'Heute';
  if (offset === 1) return 'Morgen';
  if (offset === -1) return 'Gestern';
  return date.getFullYear() === new Date().getFullYear()
    ? dayHeadingFormat.format(date)
    : dayHeadingYearFormat.format(date);
}

/* ---------- date/time inputs ---------- */

export function toDateInput(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function toTimeInput(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Combines the two native inputs into a local Date (null when incomplete). */
export function fromInputs(dateValue: string, timeValue: string): Date | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue.trim());
  const timeMatch = /^(\d{1,2}):(\d{2})/.exec(timeValue.trim());
  if (!dateMatch || !timeMatch) return null;
  const date = new Date(
    Number(dateMatch[1]),
    Number(dateMatch[2]) - 1,
    Number(dateMatch[3]),
    Number(timeMatch[1]),
    Number(timeMatch[2]),
    0,
    0,
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

/** `YYYYMMDDTHHMMSSZ` – the stamp format RRULE UNTIL expects. */
export function toIcsStamp(date: Date): string {
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

/** Next full half hour – the default start of a new event. */
export function nextSlot(base = new Date()): Date {
  const date = new Date(base.getTime());
  date.setSeconds(0, 0);
  date.setMinutes(date.getMinutes() > 30 ? 60 : 30);
  return date;
}

/* ---------- occurrences ---------- */

export interface Occurrence {
  /** Stable key for lists: event id plus the index inside the series. */
  key: string;
  index: number;
  event: CalendarEventDto;
  start: Date;
  end: Date;
}

/** Unfolds recurring events into the concrete occurrences of a window. */
export function buildOccurrences(events: CalendarEventDto[], from: Date, to: Date): Occurrence[] {
  const result: Occurrence[] = [];
  for (const event of events) {
    const expanded = expandOccurrences(
      { startsAt: event.startsAt, endsAt: event.endsAt, rrule: event.rrule },
      from,
      to,
    );
    for (const occurrence of expanded) {
      result.push({
        key: `${event.id}:${occurrence.index}`,
        index: occurrence.index,
        event,
        start: occurrence.startsAt,
        end: occurrence.endsAt,
      });
    }
  }
  // Within a day the all-day events come first, then everything by start time.
  return result.sort((a, b) => {
    const byDay = startOfDay(a.start).getTime() - startOfDay(b.start).getTime();
    if (byDay !== 0) return byDay;
    const byAllDay = Number(b.event.allDay) - Number(a.event.allDay);
    if (byAllDay !== 0) return byAllDay;
    return (
      a.start.getTime() - b.start.getTime() || a.event.title.localeCompare(b.event.title, 'de')
    );
  });
}

/**
 * The occurrence a chat bubble or the detail screen should show: the next one
 * that has not finished yet, otherwise the (past) first date of the series.
 */
export function nextOccurrence(event: CalendarEventDto, reference = new Date()): Occurrence {
  const upcoming = buildOccurrences([event], reference, addDays(reference, 730))[0];
  if (upcoming) return upcoming;
  return {
    key: `${event.id}:0`,
    index: 0,
    event,
    start: new Date(event.startsAt),
    end: new Date(event.endsAt),
  };
}

/** Every day an occurrence touches – multi-day events show up on each of them. */
export function coveredDayKeys(occurrence: Occurrence): string[] {
  const first = startOfDay(occurrence.start);
  const endMs = Math.max(occurrence.end.getTime(), occurrence.start.getTime());
  let last = startOfDay(new Date(endMs));
  // An end exactly at midnight still belongs to the day before.
  if (last.getTime() === endMs && last.getTime() > first.getTime()) last = addDays(last, -1);
  const keys: string[] = [];
  for (
    let day = first;
    day.getTime() <= last.getTime() && keys.length < 90;
    day = addDays(day, 1)
  ) {
    keys.push(dayKey(day));
  }
  return keys;
}

/** Day key → occurrences of that day, already sorted by start time. */
export function groupByDay(occurrences: Occurrence[]): Map<string, Occurrence[]> {
  const map = new Map<string, Occurrence[]>();
  for (const occurrence of occurrences) {
    for (const key of coveredDayKeys(occurrence)) {
      const list = map.get(key);
      if (list) list.push(occurrence);
      else map.set(key, [occurrence]);
    }
  }
  return map;
}

export function formatOccurrenceTime(occurrence: Occurrence): string {
  if (occurrence.event.allDay) {
    return isSameDay(occurrence.start, occurrence.end)
      ? 'Ganztägig'
      : `Ganztägig bis ${formatShortDate(occurrence.end)}`;
  }
  const start = formatTime(occurrence.start);
  if (occurrence.end.getTime() <= occurrence.start.getTime()) return `${start} Uhr`;
  if (isSameDay(occurrence.start, occurrence.end)) {
    return `${start}–${formatTime(occurrence.end)} Uhr`;
  }
  return `${start} Uhr – ${formatShortDate(occurrence.end)}, ${formatTime(occurrence.end)} Uhr`;
}

/* ---------- presentation ---------- */

export const EVENT_COLORS: { value: string; label: string }[] = [
  { value: '#6d7cff', label: 'Blau' },
  { value: '#22d3ee', label: 'Türkis' },
  { value: '#34d399', label: 'Grün' },
  { value: '#fbbf24', label: 'Gelb' },
  { value: '#f97316', label: 'Orange' },
  { value: '#f87171', label: 'Rot' },
  { value: '#ec4899', label: 'Pink' },
  { value: '#a855f7', label: 'Lila' },
];

export function eventColor(event: CalendarEventDto): string {
  const color = event.color?.trim() ?? '';
  return /^#[0-9a-f]{6}$/i.test(color) ? color : 'var(--accent)';
}

export interface RsvpMeta {
  label: string;
  symbol: string;
  color: string;
}

export function rsvpMeta(status: RsvpStatus | null): RsvpMeta {
  switch (status) {
    case 'yes':
      return { label: 'Zugesagt', symbol: '✓', color: 'var(--success)' };
    case 'maybe':
      return { label: 'Vielleicht', symbol: '?', color: 'var(--warning)' };
    case 'no':
      return { label: 'Abgesagt', symbol: '✕', color: 'var(--danger)' };
    default:
      return { label: 'Offen', symbol: '•', color: 'var(--text-faint)' };
  }
}

export function myRsvp(event: CalendarEventDto, myId: string): RsvpStatus | null {
  return event.attendees.find((attendee) => attendee.userId === myId)?.status ?? null;
}

export function rsvpCounts(event: CalendarEventDto): { yes: number; maybe: number; no: number } {
  const counts = { yes: 0, maybe: 0, no: 0 };
  for (const attendee of event.attendees) {
    if (attendee.status === 'yes') counts.yes += 1;
    else if (attendee.status === 'maybe') counts.maybe += 1;
    else if (attendee.status === 'no') counts.no += 1;
  }
  return counts;
}

export function recurrenceHint(rrule: string | null): string | null {
  const description = describeRrule(rrule);
  return description ? `Wiederholt sich ${description}` : null;
}

/** Chat name for the "aus diesem Chat" hint (null for personal events). */
export function conversationLabel(
  conversation: ConversationDto | null | undefined,
  myId: string,
): string | null {
  if (!conversation) return null;
  if (conversation.type === 'group') {
    const title = conversation.title?.trim();
    return title && title.length > 0 ? title : 'Gruppe';
  }
  const other =
    conversation.members.find((member) => member.userId !== myId) ??
    conversation.members[0] ??
    null;
  if (!other) return 'Chat';
  const nickname = other.nickname?.trim();
  return nickname && nickname.length > 0 ? nickname : other.user.displayName;
}

/* ---------- recurrence editor ---------- */

export type RepeatFreq = 'none' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
export type RepeatEnd = 'never' | 'count' | 'until';

export interface RepeatState {
  freq: RepeatFreq;
  interval: number;
  end: RepeatEnd;
  count: number;
  until: string;
  /** Preserved BYDAY of an existing weekly rule (the editor does not offer it). */
  byDay: string | null;
}

export const REPEAT_OPTIONS: { value: RepeatFreq; label: string; unit: string }[] = [
  { value: 'none', label: 'Keine', unit: '' },
  { value: 'DAILY', label: 'Täglich', unit: 'Tage' },
  { value: 'WEEKLY', label: 'Wöchentlich', unit: 'Wochen' },
  { value: 'MONTHLY', label: 'Monatlich', unit: 'Monate' },
  { value: 'YEARLY', label: 'Jährlich', unit: 'Jahre' },
];

export function defaultRepeat(reference = new Date()): RepeatState {
  return {
    freq: 'none',
    interval: 1,
    end: 'never',
    count: 10,
    until: toDateInput(addDays(reference, 30)),
    byDay: null,
  };
}

export function repeatFromRrule(rrule: string | null, reference = new Date()): RepeatState {
  const parsed = parseRrule(rrule);
  if (!parsed) return defaultRepeat(reference);
  const byDay = /BYDAY=([A-Za-z,]+)/.exec(rrule ?? '')?.[1]?.toUpperCase() ?? null;
  return {
    freq: parsed.freq,
    interval: parsed.interval,
    end: parsed.count != null ? 'count' : parsed.until ? 'until' : 'never',
    count: parsed.count ?? 10,
    until: parsed.until ? toDateInput(parsed.until) : toDateInput(addDays(reference, 30)),
    byDay: parsed.freq === 'WEEKLY' ? byDay : null,
  };
}

export function buildRrule(state: RepeatState): string | null {
  if (state.freq === 'none') return null;
  const parts = [`FREQ=${state.freq}`];
  const interval = Math.min(99, Math.max(1, Math.round(state.interval || 1)));
  if (interval > 1) parts.push(`INTERVAL=${interval}`);
  if (state.freq === 'WEEKLY' && state.byDay) parts.push(`BYDAY=${state.byDay}`);
  if (state.end === 'count') {
    parts.push(`COUNT=${Math.min(365, Math.max(1, Math.round(state.count || 1)))}`);
  }
  if (state.end === 'until') {
    const until = fromInputs(state.until, '23:59');
    if (until) parts.push(`UNTIL=${toIcsStamp(until)}`);
  }
  return parts.join(';');
}

/* ---------- reminders ---------- */

export const REMINDER_OPTIONS: { minutes: number; label: string }[] = [
  { minutes: 10, label: '10 Min' },
  { minutes: 60, label: '1 Std' },
  { minutes: 1440, label: '1 Tag' },
];

export function reminderLabel(minutes: number): string {
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return days === 1 ? '1 Tag vorher' : `${days} Tage vorher`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? '1 Stunde vorher' : `${hours} Stunden vorher`;
  }
  return `${minutes} Minuten vorher`;
}

/* ---------- urls ---------- */

/** The ICS endpoints may be relative – calendar apps need an absolute URL. */
export function absoluteUrl(url: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//')) return url;
  if (typeof window === 'undefined') return url;
  return `${window.location.origin}${url.startsWith('/') ? '' : '/'}${url}`;
}

export function webcalUrl(url: string): string {
  return absoluteUrl(url).replace(/^https?:/i, 'webcal:');
}

export async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* fall back to the legacy path below (iOS without permission) */
  }
  try {
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand('copy');
    document.body.removeChild(area);
    return copied;
  } catch {
    return false;
  }
}

/* ---------- lookups ---------- */

/**
 * Resolves attendee ids to users: chat members are already in the store, the
 * rest is fetched once per id (failures are remembered so we never loop).
 */
export function useUserLookup(userIds: string[]): Record<string, UserDto> {
  const conversations = useChat((state) => state.conversations);
  const [fetched, setFetched] = useState<Record<string, UserDto>>({});
  const requested = useRef(new Set<string>());

  const known = useMemo(() => {
    const map: Record<string, UserDto> = {};
    for (const conversation of conversations) {
      for (const member of conversation.members) map[member.userId] = member.user;
    }
    return map;
  }, [conversations]);

  const wanted = userIds.join(',');

  useEffect(() => {
    let cancelled = false;
    const missing = wanted
      .split(',')
      .filter((id) => id.length > 0 && !known[id] && !requested.current.has(id));
    if (missing.length === 0) return undefined;
    for (const id of missing) requested.current.add(id);
    void Promise.all(missing.map((id) => api.users.byId(id).catch(() => null))).then((users) => {
      if (cancelled) return;
      const found = users.filter((user): user is UserDto => user != null);
      if (found.length === 0) return;
      setFetched((current) => {
        const next = { ...current };
        for (const user of found) next[user.id] = user;
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [wanted, known]);

  return useMemo(() => ({ ...known, ...fetched }), [known, fetched]);
}
