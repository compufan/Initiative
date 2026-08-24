import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { bestOption, type CalendarEventDto } from '@initiative/shared';
import { ApiError, api } from '../../lib/api.js';
import { useMyId } from '../../state/session.js';
import { toast } from '../../state/ui.js';
import type { MessageRendererProps } from '../types.js';
import { AddOptionSheet } from './AddOptionSheet.js';
import { ChoiceOptions } from './ChoiceOptions.js';
import { CreateEventSheet } from './CreateEventSheet.js';
import { DateMatrix } from './DateMatrix.js';
import { PollVoters } from './PollVoters.js';
import { closesInLabel, countLabel, isCreator, pollClosed } from './helpers.js';
import { useLivePoll, useMembers } from './usePoll.js';

/**
 * Chat card of a poll and of a Terminfindung.
 *
 * Choice polls show bars, date polls a compact ✓ / ? / ✕ matrix. Votes are
 * applied optimistically and corrected by the `poll.updated` event, so every
 * participant sees the same counts within a moment.
 */
export function PollBubble({ message, isMine }: MessageRendererProps) {
  const myId = useMyId();
  const pollId = message.metadata.pollId ?? message.poll?.id ?? null;
  const { poll, loading, failed, busy, apply, submit } = useLivePoll(pollId, message.poll ?? null);
  const members = useMembers(message.conversationId);
  const [addOpen, setAddOpen] = useState(false);
  const [eventOpen, setEventOpen] = useState(false);
  const [managing, setManaging] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const closesAt = poll?.closesAt ?? null;
  const closedAt = poll?.closedAt ?? null;

  // A pending deadline has to age on its own while the chat stays open.
  useEffect(() => {
    if (!closesAt || closedAt) return undefined;
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [closesAt, closedAt]);

  const tone = isMine ? ' is-mine' : '';

  if (message.deletedAt) {
    return (
      <div
        className={`msg-bubble ${isMine ? 'msg-bubble-mine' : 'msg-bubble-theirs'} msg-bubble-deleted`}
      >
        <em>Diese Nachricht wurde gelöscht</em>
      </div>
    );
  }

  if (!poll) {
    return (
      <div className={`poll-bubble${tone}`}>
        <p className="poll-note">
          {loading
            ? 'Umfrage wird geladen …'
            : failed
              ? 'Die Umfrage konnte nicht geladen werden.'
              : 'Umfrage nicht verfügbar.'}
        </p>
      </div>
    );
  }

  const isDate = poll.kind === 'date';
  const closed = pollClosed(poll);
  const mine = isCreator(poll, myId);
  const deadline = closesInLabel(poll, now);
  const best = isDate ? bestOption(poll.options, poll.tally) : null;
  const bestId = best && poll.voterCount > 0 && poll.tally[best.id]?.score > 0 ? best.id : null;
  const canAdd = !closed && (poll.allowAddOptions || mine);

  async function toggleClosed(): Promise<void> {
    if (!poll || managing) return;
    setManaging(true);
    try {
      apply(closed ? await api.polls.reopen(poll.id) : await api.polls.close(poll.id));
      toast(closed ? 'Umfrage wieder geöffnet' : 'Umfrage beendet', 'success');
    } catch (error) {
      toast(
        error instanceof ApiError && error.isOffline
          ? 'Keine Verbindung – bitte später erneut versuchen'
          : error instanceof ApiError
            ? error.message
            : 'Die Umfrage konnte nicht geändert werden',
        'error',
      );
    } finally {
      setManaging(false);
    }
  }

  function eventCreated(event: CalendarEventDto, closedPoll: boolean): void {
    if (!poll) return;
    apply({
      ...poll,
      createdEventId: event.id,
      closedAt: closedPoll ? (poll.closedAt ?? new Date().toISOString()) : poll.closedAt,
    });
  }

  return (
    <div className={`poll-bubble${tone}`}>
      <div className="poll-head">
        <span className="poll-kind" aria-hidden="true">
          {isDate ? '🗓️' : '📊'}
        </span>
        <h3 className="poll-question">{poll.question}</h3>
      </div>

      {poll.description && <p className="poll-description">{poll.description}</p>}

      <div className="poll-badges">
        {isDate && <span className="badge">Terminfindung</span>}
        {!isDate && poll.multiple && <span className="badge">Mehrfachauswahl</span>}
        {poll.anonymous && <span className="badge">anonym</span>}
        {closed && <span className="badge poll-badge-closed">geschlossen</span>}
        {!closed && deadline && <span className="badge badge-accent">{deadline}</span>}
      </div>

      {isDate ? (
        <DateMatrix
          poll={poll}
          bestId={bestId}
          disabled={closed || busy}
          onVote={(votes) => void submit(votes)}
        />
      ) : (
        <ChoiceOptions
          poll={poll}
          disabled={closed || busy}
          onVote={(votes) => void submit(votes)}
        />
      )}

      <p className="poll-summary">
        {poll.voterCount === 0
          ? 'Noch niemand hat abgestimmt'
          : countLabel(poll.voterCount, 'Stimme', 'Stimmen')}
        {closed && ' · beendet'}
      </p>

      <PollVoters poll={poll} members={members} myId={myId} />

      {poll.createdEventId && (
        <Link className="poll-event-link" to={`/kalender/termin/${poll.createdEventId}`}>
          <span aria-hidden="true">📅</span>
          <span>Termin erstellt – ansehen</span>
        </Link>
      )}

      {(canAdd || mine) && (
        <div className="poll-actions">
          {canAdd && (
            <button type="button" className="btn btn-sm" onClick={() => setAddOpen(true)}>
              {isDate ? 'Vorschlag ergänzen' : 'Option ergänzen'}
            </button>
          )}
          {mine && isDate && !poll.createdEventId && poll.options.length > 0 && (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => setEventOpen(true)}
            >
              Termin erstellen
            </button>
          )}
          {mine && (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={managing}
              onClick={() => void toggleClosed()}
            >
              {closed ? 'Wieder öffnen' : 'Umfrage beenden'}
            </button>
          )}
        </div>
      )}

      {addOpen && <AddOptionSheet poll={poll} onClose={() => setAddOpen(false)} onAdded={apply} />}
      {eventOpen && (
        <CreateEventSheet
          poll={poll}
          onClose={() => setEventOpen(false)}
          onCreated={eventCreated}
        />
      )}
    </div>
  );
}
