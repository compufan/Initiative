import {
  LIMITS,
  VOTE_VALUES,
  countVoters,
  isPollClosed,
  tallyVotes,
  type PollDto,
  type PollOptionDto,
  type PollTally,
  type PollVoteDto,
  type VoteValue,
} from '@initiative/shared';

/**
 * Shared helpers of the polls module: German formatting, the little bit of date
 * maths the mini calendar needs and the optimistic vote arithmetic. Everything
 * that has to look identical in the chat bubble and in both composers lives
 * here exactly once.
 */

export const MAX_OPTIONS = LIMITS.pollOptionsMax;
export const MAX_QUESTION = LIMITS.pollQuestionMax;
export const MAX_OPTION_LABEL = LIMITS.pollOptionMax;
export const MAX_DESCRIPTION = 2000;

export const DAY_MS = 86_400_000;

/* ---------- vote values ---------- */

export interface VoteMeta {
  symbol: string;
  label: string;
  color: string;
}

export const VOTE_META: Record<VoteValue, VoteMeta> = {
  yes: { symbol: '✓', label: 'Ja', color: 'var(--success)' },
  maybe: { symbol: '?', label: 'Vielleicht', color: 'var(--warning)' },
  no: { symbol: '✕', label: 'Nein', color: 'var(--danger)' },
};

const VOTE_RANK: Record<VoteValue, number> = { yes: 0, maybe: 1, no: 2 };

/** The three answers of a date poll in the order the matrix shows them. */
export const VOTE_ORDER: VoteValue[] = [...VOTE_VALUES].sort((a, b) => VOTE_RANK[a] - VOTE_RANK[b]);

/* ---------- dates ---------- */

const weekdayShortFormat = new Intl.DateTimeFormat('de-DE', { weekday: 'short' });
const weekdayLongFormat = new Intl.DateTimeFormat('de-DE', { weekday: 'long' });
const dayMonthFormat = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit' });
const dayMonthLongFormat = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'long' });
const monthYearFormat = new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric' });
const timeFormat = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });

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

/** Parses a `YYYY-MM-DD` key back into a local date (midnight). */
export function dayFromKey(key: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function isSameDay(a: Date, b: Date): boolean {
  return dayKey(a) === dayKey(b);
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

export function formatMonthTitle(month: Date): string {
  return monthYearFormat.format(month);
}

export function formatWeekday(date: Date): string {
  return weekdayShortFormat.format(date).replace('.', '');
}

export function formatDayMonth(date: Date): string {
  return dayMonthFormat.format(date);
}

/** "Mo, 3. November" – the heading of a day in the composer. */
export function formatDayHeading(date: Date): string {
  return `${formatWeekday(date)}, ${dayMonthLongFormat.format(date)}`;
}

export function formatClock(date: Date): string {
  return timeFormat.format(date);
}

/** `HH:MM`, the value shape of a native time input. */
export function toTimeInput(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Minutes since midnight; `null` when the value is not a valid `HH:MM`. */
export function parseTime(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function formatMinutes(minutes: number): string {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** Combines a day with minutes since midnight into a local date. */
export function atMinutes(day: Date, minutes: number): Date {
  const date = startOfDay(day);
  date.setMinutes(minutes);
  return date;
}

/* ---------- slot building ---------- */

/** Length of one proposal – `allDay` covers the whole day instead. */
export type SlotDuration = 30 | 60 | 90 | 120 | 'allDay';

export const DURATION_OPTIONS: { value: SlotDuration; label: string }[] = [
  { value: 30, label: '30 Min' },
  { value: 60, label: '1 Std' },
  { value: 90, label: '1,5 Std' },
  { value: 120, label: '2 Std' },
  { value: 'allDay', label: 'Ganztägig' },
];

export const TIME_PRESETS: { label: string; minutes: number }[] = [
  { label: 'Vormittag', minutes: 10 * 60 },
  { label: 'Nachmittag', minutes: 15 * 60 },
  { label: 'Abend', minutes: 19 * 60 },
];

/** A day plus a start time becomes the `startsAt`/`endsAt` pair the API wants. */
export function buildSlot(
  day: Date,
  minutes: number,
  duration: SlotDuration,
): { startsAt: string; endsAt: string } {
  if (duration === 'allDay') {
    const start = startOfDay(day);
    return { startsAt: start.toISOString(), endsAt: addDays(start, 1).toISOString() };
  }
  const start = atMinutes(day, minutes);
  return {
    startsAt: start.toISOString(),
    endsAt: new Date(start.getTime() + duration * 60_000).toISOString(),
  };
}

/* ---------- option slots ---------- */

export function optionStart(option: PollOptionDto): Date | null {
  if (!option.startsAt) return null;
  const date = new Date(option.startsAt);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function optionEnd(option: PollOptionDto): Date | null {
  if (!option.endsAt) return null;
  const date = new Date(option.endsAt);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** A slot that starts at midnight and covers (nearly) a full day. */
export function isAllDaySlot(start: Date, end: Date | null): boolean {
  if (!end) return false;
  if (start.getHours() !== 0 || start.getMinutes() !== 0) return false;
  return end.getTime() - start.getTime() >= DAY_MS - 60_000;
}

/** "10:00–11:00", "10:00 Uhr" or "Ganztägig" for one date proposal. */
export function formatSlotTime(option: PollOptionDto): string {
  const start = optionStart(option);
  if (!start) return option.label || 'Ohne Datum';
  const end = optionEnd(option);
  if (isAllDaySlot(start, end)) return 'Ganztägig';
  if (!end || end.getTime() <= start.getTime()) return `${formatClock(start)} Uhr`;
  if (isSameDay(start, end)) return `${formatClock(start)}–${formatClock(end)}`;
  return `${formatClock(start)} Uhr – ${formatDayMonth(end)}, ${formatClock(end)} Uhr`;
}

/** "Montag, 3. November · 10:00–11:00" – used in the event sheet. */
export function formatSlotLong(option: PollOptionDto): string {
  const start = optionStart(option);
  if (!start) return option.label || 'Ohne Datum';
  return `${weekdayLongFormat.format(start)}, ${dayMonthLongFormat.format(start)} · ${formatSlotTime(option)}`;
}

/** Label for any option – date polls fall back to their slot. */
export function optionLabel(option: PollOptionDto): string {
  const label = option.label?.trim() ?? '';
  if (label.length > 0) return label;
  return optionStart(option) ? formatSlotTime(option) : 'Ohne Titel';
}

/* ---------- poll state ---------- */

export function pollClosed(poll: PollDto): boolean {
  return isPollClosed(poll);
}

/** Anonymous polls only reveal who voted to their creator. */
export function votesVisible(poll: PollDto, myId: string): boolean {
  return !poll.anonymous || poll.createdBy === myId;
}

export function isCreator(poll: PollDto, myId: string): boolean {
  return poll.createdBy === myId;
}

export function myVoteMap(poll: PollDto): Record<string, VoteValue> {
  const map: Record<string, VoteValue> = {};
  for (const vote of poll.myVotes) map[vote.optionId] = vote.value;
  return map;
}

export function tallyOf(poll: PollDto, optionId: string) {
  return poll.tally[optionId] ?? { yes: 0, maybe: 0, no: 0, score: 0 };
}

/** Share of the voters that picked this option (0–100). */
export function percentOf(poll: PollDto, optionId: string): number {
  if (poll.voterCount <= 0) return 0;
  return Math.round((tallyOf(poll, optionId).yes / poll.voterCount) * 100);
}

export function countLabel(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`;
}

/** "endet in 2 Std." – null when the poll has no (pending) deadline. */
export function closesInLabel(poll: PollDto, now = Date.now()): string | null {
  if (!poll.closesAt || poll.closedAt) return null;
  const diff = new Date(poll.closesAt).getTime() - now;
  if (Number.isNaN(diff) || diff <= 0) return null;
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `endet in ${Math.max(1, minutes)} Min.`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `endet in ${countLabel(hours, 'Std.', 'Std.')}`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'endet morgen' : `endet in ${days} Tagen`;
}

/**
 * The poll as it looks right after the viewer tapped – shown until the API (or
 * the `poll.updated` event) answers with the authoritative state.
 *
 * Anonymous polls never hand out the individual votes, so their counters are
 * adjusted by hand instead of being recomputed from the vote list.
 */
export function applyMyVotes(
  poll: PollDto,
  myId: string,
  next: { optionId: string; value: VoteValue }[],
): PollDto {
  const votedAt = new Date().toISOString();
  const mine: PollVoteDto[] = next.map((vote) => ({ ...vote, userId: myId, votedAt }));

  if (votesVisible(poll, myId)) {
    const votes = [...poll.votes.filter((vote) => vote.userId !== myId), ...mine];
    return {
      ...poll,
      votes,
      myVotes: mine,
      tally: tallyVotes(poll.options, votes),
      voterCount: countVoters(votes),
    };
  }

  const tally: PollTally = {};
  for (const option of poll.options) tally[option.id] = { ...tallyOf(poll, option.id) };
  for (const vote of poll.myVotes) {
    const entry = tally[vote.optionId];
    if (entry) entry[vote.value] = Math.max(0, entry[vote.value] - 1);
  }
  for (const vote of mine) {
    const entry = tally[vote.optionId];
    if (entry) entry[vote.value] += 1;
  }
  for (const entry of Object.values(tally)) entry.score = entry.yes + entry.maybe * 0.5;

  const delta = (mine.length > 0 ? 1 : 0) - (poll.myVotes.length > 0 ? 1 : 0);
  return { ...poll, myVotes: mine, tally, voterCount: Math.max(0, poll.voterCount + delta) };
}

/** Everyone who voted, in the order the members appear in the poll. */
export function voterIds(poll: PollDto): string[] {
  const seen: string[] = [];
  for (const vote of poll.votes) {
    if (!seen.includes(vote.userId)) seen.push(vote.userId);
  }
  return seen;
}
