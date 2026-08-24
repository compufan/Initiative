import type { PollDto, VoteValue } from '@initiative/shared';
import { optionLabel, percentOf, tallyOf } from './helpers.js';

interface ChoiceOptionsProps {
  poll: PollDto;
  /** Closed poll or a vote that is still on its way to the server. */
  disabled: boolean;
  onVote: (votes: { optionId: string; value: VoteValue }[]) => void;
}

/**
 * Choice poll: one row per option with a bar behind the label. Tapping votes,
 * tapping the own answer again takes it back. Multiple-choice polls keep every
 * selected option, single-choice polls replace the previous answer.
 */
export function ChoiceOptions({ poll, disabled, onVote }: ChoiceOptionsProps) {
  const selected = new Set(poll.myVotes.map((vote) => vote.optionId));

  function toggle(optionId: string): void {
    if (disabled) return;
    if (poll.multiple) {
      const next = new Set(selected);
      if (next.has(optionId)) next.delete(optionId);
      else next.add(optionId);
      onVote([...next].map((id) => ({ optionId: id, value: 'yes' as VoteValue })));
      return;
    }
    onVote(selected.has(optionId) ? [] : [{ optionId, value: 'yes' }]);
  }

  return (
    <ul className="poll-options poll-scroll">
      {poll.options.map((option) => {
        const mine = selected.has(option.id);
        const percent = percentOf(poll, option.id);
        const count = tallyOf(poll, option.id).yes;
        return (
          <li key={option.id}>
            <button
              type="button"
              className={`poll-option${mine ? ' is-mine' : ''}`}
              aria-pressed={mine}
              disabled={disabled}
              onClick={() => toggle(option.id)}
            >
              <span
                className="poll-option-fill"
                style={{ width: `${percent}%` }}
                aria-hidden="true"
              />
              <span className="poll-option-body">
                <span className="poll-option-mark" aria-hidden="true">
                  {mine ? '✓' : ''}
                </span>
                <span className="poll-option-label">{optionLabel(option)}</span>
                <span className="poll-option-count">
                  {count} · {percent}%
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
