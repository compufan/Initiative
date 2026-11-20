import { useState } from 'react';
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
  if (poll.quiz) return <QuizOptionen poll={poll} disabled={disabled} onVote={onVote} />;
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

/**
 * Quiz: Erst wählen (bei mehreren richtigen mit „Antwort abgeben“), dann die
 * Auflösung – richtig grün mit ✓, die eigene falsche mit ✗, nicht nur über
 * die Farbe. Vor der eigenen Stimme keine Zahlen: Wer sähe, wohin die
 * Mehrheit tippt, schriebe ab. Die Auflösung kommt vom Server und nur, wenn
 * man abgestimmt hat.
 */
function QuizOptionen({ poll, disabled, onVote }: ChoiceOptionsProps) {
  const [auswahl, setAuswahl] = useState<Set<string>>(new Set());
  const mine = new Set(poll.myVotes.map((vote) => vote.optionId));
  const aufgeloest = poll.aufloesung != null && (mine.size > 0 || poll.closedAt != null);
  const richtig = new Set(poll.aufloesung?.richtig ?? []);
  const beantwortet = mine.size > 0;
  const zuWaehlen = !beantwortet && !disabled;

  function waehlen(optionId: string): void {
    if (!zuWaehlen) return;
    if (!poll.multiple) {
      onVote([{ optionId, value: 'yes' }]);
      return;
    }
    const next = new Set(auswahl);
    if (next.has(optionId)) next.delete(optionId);
    else next.add(optionId);
    setAuswahl(next);
  }

  const alleRichtig =
    beantwortet && [...mine].every((id) => richtig.has(id)) && mine.size === richtig.size;

  return (
    <>
      <ul className="poll-options poll-scroll">
        {poll.options.map((option) => {
          const istMeins = mine.has(option.id) || auswahl.has(option.id);
          const istRichtig = aufgeloest && richtig.has(option.id);
          const istFalsch = aufgeloest && mine.has(option.id) && !richtig.has(option.id);
          const percent = percentOf(poll, option.id);
          const zustand = istRichtig ? ', richtige Antwort' : istFalsch ? ', falsch' : '';
          return (
            <li key={option.id}>
              <button
                type="button"
                className={`poll-option${istMeins ? ' is-mine' : ''}${istRichtig ? ' is-richtig' : ''}${istFalsch ? ' is-falsch' : ''}`}
                aria-pressed={istMeins}
                aria-label={`${optionLabel(option)}${zustand}`}
                disabled={!zuWaehlen}
                onClick={() => waehlen(option.id)}
              >
                {aufgeloest && (
                  <span className="poll-option-fill" style={{ width: `${percent}%` }} aria-hidden="true" />
                )}
                <span className="poll-option-body">
                  <span className="poll-option-mark" aria-hidden="true">
                    {istRichtig ? '✓' : istFalsch ? '✗' : istMeins ? '•' : ''}
                  </span>
                  <span className="poll-option-label">{optionLabel(option)}</span>
                  {aufgeloest && (
                    <span className="poll-option-count">
                      {tallyOf(poll, option.id).yes} · {percent}%
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {poll.multiple && zuWaehlen && (
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={auswahl.size === 0}
          onClick={() => onVote([...auswahl].map((optionId) => ({ optionId, value: 'yes' as VoteValue })))}
        >
          Antwort abgeben
        </button>
      )}
      {aufgeloest && beantwortet && (
        <p className={`poll-quiz-ergebnis ${alleRichtig ? 'is-richtig' : 'is-falsch'}`} role="status">
          {alleRichtig ? '🎉 Richtig!' : 'Leider falsch.'}
        </p>
      )}
      {aufgeloest && poll.aufloesung?.erklaerung && (
        <p className="poll-quiz-erklaerung">💡 {poll.aufloesung.erklaerung}</p>
      )}
      {!beantwortet && <p className="poll-hint">Quiz – die erste Antwort zählt.</p>}
    </>
  );
}
