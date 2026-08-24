import type { PollDto, VoteValue } from '@initiative/shared';
import {
  VOTE_META,
  VOTE_ORDER,
  formatDayMonth,
  formatSlotTime,
  formatWeekday,
  myVoteMap,
  optionStart,
  tallyOf,
} from './helpers.js';

interface DateMatrixProps {
  poll: PollDto;
  /** Id of the leading proposal, highlighted as "Bester Termin". */
  bestId: string | null;
  disabled: boolean;
  onVote: (votes: { optionId: string; value: VoteValue }[]) => void;
}

/**
 * Terminfindung: one compact row per proposal with ✓ / ? / ✕ and the running
 * count. Rows stay the same height with 3 or with 30 proposals – the list
 * scrolls inside the bubble instead of growing the chat.
 */
export function DateMatrix({ poll, bestId, disabled, onVote }: DateMatrixProps) {
  const mine = myVoteMap(poll);

  function choose(optionId: string, value: VoteValue): void {
    if (disabled) return;
    const next = { ...mine };
    if (next[optionId] === value) delete next[optionId];
    else next[optionId] = value;
    onVote(Object.entries(next).map(([id, vote]) => ({ optionId: id, value: vote })));
  }

  return (
    <ul className="poll-slots poll-scroll">
      {poll.options.map((option) => {
        const start = optionStart(option);
        const tally = tallyOf(poll, option.id);
        const best = option.id === bestId;
        return (
          <li key={option.id} className={`poll-slot${best ? ' is-best' : ''}`}>
            <div className="poll-slot-info">
              <span className="poll-slot-day">
                {start ? `${formatWeekday(start)}, ${formatDayMonth(start)}` : 'Ohne Datum'}
              </span>
              <span className="poll-slot-time">{formatSlotTime(option)}</span>
              <span className="poll-slot-counts">
                {tally.yes} {VOTE_META.yes.symbol}
                {tally.maybe > 0 && ` · ${tally.maybe} ${VOTE_META.maybe.symbol}`}
                {tally.no > 0 && ` · ${tally.no} ${VOTE_META.no.symbol}`}
              </span>
              {best && <span className="poll-best-tag">Bester Termin</span>}
            </div>
            <div
              className="poll-slot-actions"
              role="group"
              aria-label={`Deine Antwort für ${formatSlotTime(option)}`}
            >
              {VOTE_ORDER.map((value) => {
                const active = mine[option.id] === value;
                return (
                  <button
                    key={value}
                    type="button"
                    className={`poll-vote poll-vote-${value}${active ? ' is-active' : ''}`}
                    aria-pressed={active}
                    aria-label={VOTE_META[value].label}
                    disabled={disabled}
                    onClick={() => choose(option.id, value)}
                  >
                    <span aria-hidden="true">{VOTE_META[value].symbol}</span>
                  </button>
                );
              })}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
