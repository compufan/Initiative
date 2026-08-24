import { Link } from 'react-router-dom';
import type { MessageRendererProps } from '../types.js';
import { RsvpButtons } from './RsvpButtons.js';
import { useLiveEvent } from './useCalendarEvents.js';
import {
  eventColor,
  formatMonthShort,
  formatOccurrenceTime,
  nextOccurrence,
  recurrenceHint,
  rsvpCounts,
} from './helpers.js';

/** Chat bubble for an announced event: date block, facts and the RSVP row. */
export function EventBubble({ message, isMine }: MessageRendererProps) {
  const eventId = message.metadata.eventId ?? message.event?.id ?? null;
  const { event, setEvent, loading, deleted } = useLiveEvent(eventId, message.event ?? null);
  const tone = isMine ? 'is-mine' : '';

  if (message.deletedAt) {
    return (
      <div
        className={`msg-bubble ${isMine ? 'msg-bubble-mine' : 'msg-bubble-theirs'} msg-bubble-deleted`}
      >
        <em>Diese Nachricht wurde gelöscht</em>
      </div>
    );
  }

  if (deleted) {
    return (
      <div className={`cal-bubble ${tone}`}>
        <p className="cal-bubble-note">Dieser Termin wurde gelöscht.</p>
      </div>
    );
  }

  if (!event) {
    return (
      <div className={`cal-bubble ${tone}`}>
        <p className="cal-bubble-note">
          {loading ? 'Termin wird geladen …' : 'Termin nicht verfügbar.'}
        </p>
      </div>
    );
  }

  const occurrence = nextOccurrence(event);
  const repeat = recurrenceHint(event.rrule);
  const counts = rsvpCounts(event);

  return (
    <div className={`cal-bubble ${tone}`} style={{ borderLeftColor: eventColor(event) }}>
      <Link className="cal-bubble-head" to={`/kalender/termin/${event.id}`}>
        <span className="cal-date-block">
          <span className="cal-date-day">{occurrence.start.getDate()}</span>
          <span className="cal-date-month">{formatMonthShort(occurrence.start)}</span>
        </span>
        <span className="cal-bubble-main">
          <span className="cal-bubble-title">{event.title}</span>
          <span className="cal-bubble-line">🕒 {formatOccurrenceTime(occurrence)}</span>
          {event.location && <span className="cal-bubble-line truncate">📍 {event.location}</span>}
          {repeat && <span className="cal-bubble-line">🔁 {repeat}</span>}
        </span>
      </Link>

      {message.body && message.body.trim().length > 0 && (
        <p className="cal-bubble-body">{message.body}</p>
      )}

      <p className="cal-bubble-counts">
        {counts.yes} zugesagt · {counts.maybe} vielleicht · {counts.no} abgesagt
      </p>

      <RsvpButtons event={event} onChanged={setEvent} compact />
    </div>
  );
}
