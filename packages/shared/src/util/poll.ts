import type { PollOptionDto, PollVoteDto } from '../schemas/poll.js';

export interface OptionTally {
  yes: number;
  maybe: number;
  no: number;
  /** yes = 1 point, maybe = 0.5 – used to rank date-poll slots. */
  score: number;
}

export type PollTally = Record<string, OptionTally>;

export function tallyVotes(options: PollOptionDto[], votes: PollVoteDto[]): PollTally {
  const tally: PollTally = {};
  for (const option of options) tally[option.id] = { yes: 0, maybe: 0, no: 0, score: 0 };
  for (const vote of votes) {
    const entry = tally[vote.optionId];
    if (!entry) continue;
    entry[vote.value] += 1;
  }
  for (const entry of Object.values(tally)) {
    entry.score = entry.yes + entry.maybe * 0.5;
  }
  return tally;
}

export function countVoters(votes: PollVoteDto[]): number {
  return new Set(votes.map((vote) => vote.userId)).size;
}

/**
 * Best slot for a date poll: highest score, ties broken by fewer "no" votes and
 * then by the earlier start date, so results are deterministic for everyone.
 */
export function bestOption(options: PollOptionDto[], tally: PollTally): PollOptionDto | null {
  let best: PollOptionDto | null = null;
  let bestEntry: OptionTally | null = null;
  for (const option of options) {
    const entry = tally[option.id];
    if (!entry) continue;
    if (!bestEntry || !best) {
      best = option;
      bestEntry = entry;
      continue;
    }
    if (entry.score > bestEntry.score) {
      best = option;
      bestEntry = entry;
    } else if (entry.score === bestEntry.score) {
      if (entry.no < bestEntry.no) {
        best = option;
        bestEntry = entry;
      } else if (entry.no === bestEntry.no && option.startsAt && best.startsAt) {
        if (new Date(option.startsAt).getTime() < new Date(best.startsAt).getTime()) {
          best = option;
          bestEntry = entry;
        }
      }
    }
  }
  return best;
}

/** Accepts both the API DTO (ISO strings) and a raw database row (Date objects). */
export function isPollClosed(
  poll: { closedAt: Date | string | null; closesAt: Date | string | null },
  now = new Date(),
): boolean {
  if (poll.closedAt) return true;
  if (poll.closesAt && new Date(poll.closesAt).getTime() <= now.getTime()) return true;
  return false;
}
