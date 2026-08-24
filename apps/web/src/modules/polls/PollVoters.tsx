import { useState } from 'react';
import type { PollDto, PollVoteDto } from '@initiative/shared';
import { Avatar } from '../../components/Avatar.js';
import { VOTE_META, optionLabel, votesVisible } from './helpers.js';
import { memberName, type MemberInfo } from './usePoll.js';

interface PollVotersProps {
  poll: PollDto;
  members: Record<string, MemberInfo>;
  myId: string;
}

/**
 * "Wer hat wie gestimmt" – collapsed by default so the bubble stays small.
 * Anonymous polls only show it to their creator; everybody else sees why.
 */
export function PollVoters({ poll, members, myId }: PollVotersProps) {
  const [open, setOpen] = useState(false);
  const visible = votesVisible(poll, myId);

  if (!visible) {
    return (
      <p className="poll-note">
        Anonyme Umfrage – nur die Zahlen sind sichtbar, nicht wer wie gestimmt hat.
      </p>
    );
  }

  if (poll.votes.length === 0) return null;

  const byOption = new Map<string, PollVoteDto[]>();
  for (const vote of poll.votes) {
    const list = byOption.get(vote.optionId);
    if (list) list.push(vote);
    else byOption.set(vote.optionId, [vote]);
  }

  return (
    <div className="poll-voters">
      <button
        type="button"
        className="poll-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span>Wer hat wie gestimmt</span>
        <span aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <div className="poll-voter-list poll-scroll">
          {poll.options.map((option) => {
            const votes = byOption.get(option.id) ?? [];
            if (votes.length === 0) return null;
            return (
              <section key={option.id} className="poll-voter-group">
                <h4 className="poll-voter-title truncate">{optionLabel(option)}</h4>
                <ul className="poll-voter-chips">
                  {votes.map((vote) => {
                    const name = memberName(members, vote.userId, myId);
                    const meta = VOTE_META[vote.value];
                    return (
                      <li key={`${vote.optionId}:${vote.userId}`} className="poll-voter-chip">
                        <Avatar
                          name={name}
                          id={vote.userId}
                          url={members[vote.userId]?.avatarUrl ?? null}
                          size={22}
                        />
                        <span className="truncate">{name}</span>
                        {poll.kind === 'date' && (
                          <span style={{ color: meta.color }} aria-label={meta.label}>
                            {meta.symbol}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
