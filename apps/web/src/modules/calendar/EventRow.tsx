import { Link } from 'react-router-dom';
import type { RsvpStatus } from '@initiative/shared';
import { eventColor, formatTime, isSameDay, rsvpMeta, type Occurrence } from './helpers.js';

interface EventRowProps {
  occurrence: Occurrence;
  /** Chat the event came from – null for personal events. */
  chatLabel: string | null;
  rsvp: RsvpStatus | null;
}

/** One event in the agenda or under a tapped day of the month grid. */
export function EventRow({ occurrence, chatLabel, rsvp }: EventRowProps) {
  const { event, start, end } = occurrence;
  const meta = [event.location?.trim(), chatLabel].filter((value): value is string =>
    Boolean(value && value.length > 0),
  );
  const status = rsvp ? rsvpMeta(rsvp) : null;
  const showEnd = !event.allDay && end.getTime() > start.getTime() && isSameDay(start, end);

  return (
    <Link className="cal-row" to={`/kalender/termin/${event.id}`}>
      <span className="cal-row-bar" style={{ background: eventColor(event) }} aria-hidden="true" />
      <span className="cal-row-time">
        {event.allDay ? (
          <span className="cal-row-allday">ganztägig</span>
        ) : (
          <>
            <span className="cal-row-start">{formatTime(start)}</span>
            {showEnd && <span className="cal-row-end">{formatTime(end)}</span>}
          </>
        )}
      </span>
      <span className="cal-row-main">
        <span className="cal-row-title truncate">
          {event.title}
          {/* Ein Termin in Abstimmung steht mit dem fruehesten Vorschlag im
              Kalender. Ohne diesen Hinweis liest man ihn als feststehend. */}
          {event.status === 'planning' && <span className="cal-tag">in Abstimmung</span>}
          {event.status === 'cancelled' && <span className="cal-tag cal-tag-off">abgesagt</span>}
        </span>
        {meta.length > 0 && <span className="cal-row-meta truncate">{meta.join(' · ')}</span>}
      </span>
      {status && (
        <span
          className="cal-rsvp-dot"
          style={{ background: status.color }}
          title={status.label}
          aria-label={status.label}
        />
      )}
    </Link>
  );
}
