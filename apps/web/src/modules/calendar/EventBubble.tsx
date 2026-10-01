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

/** Was eine Karte sagt, deren Termin nicht mehr zu sehen ist. */
function wegText(grund: 'geloescht' | 'ausgeladen' | undefined): string {
  if (grund === 'geloescht') return 'Dieser Termin wurde gelöscht.';
  if (grund === 'ausgeladen') return 'Du bist nicht mehr zu diesem Termin eingeladen.';
  return 'Termin nicht verfügbar.';
}

/**
 * Chat bubble for an announced event: date block, facts and the RSVP row.
 *
 * Die Karte hält keinen eigenen Stand: Sie zeigt den Termin, den der
 * Chat-Speicher ihr gibt (`message.event`), und der wird bei jeder Änderung des
 * Termins in allen Chats nachgeführt – auch in nicht geöffneten. Eine Zusage in
 * einem anderen Chat steht damit hier schon, wenn man zurückkehrt.
 *
 * Fünf Zustände: gelöscht (die Nachricht selbst), Termin nicht (mehr) sichtbar
 * – ohne Kennung, wenn man nie eingeladen war –, abgesagt, geladen und der
 * Normalfall.
 */
export function EventBubble({ message, isMine }: MessageRendererProps) {
  // Ist der Termin schon als nicht mehr sichtbar bekannt, wird er nicht noch
  // einmal abgerufen: Es gäbe nur ein 404.
  const eventId = message.terminGrund
    ? null
    : (message.metadata.eventId ?? message.event?.id ?? null);
  const { event, setEvent, loading, deleted, grund } = useLiveEvent(
    eventId,
    message.terminGrund ? null : (message.event ?? null),
  );
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

  if (message.terminGrund || deleted) {
    return (
      <div className={`cal-bubble ${tone}`}>
        <p className="cal-bubble-note">{wegText(message.terminGrund ?? grund)}</p>
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
  const abgesagt = event.status === 'cancelled';

  return (
    <div
      className={`cal-bubble ${tone} ${abgesagt ? 'is-abgesagt' : ''}`}
      style={{ borderLeftColor: eventColor(event) }}
    >
      <Link className="cal-bubble-head" to={`/kalender/termin/${event.id}`}>
        <span className="cal-date-block">
          <span className="cal-date-day">{occurrence.start.getDate()}</span>
          <span className="cal-date-month">{formatMonthShort(occurrence.start)}</span>
        </span>
        <span className="cal-bubble-main">
          <span className="cal-bubble-title">{event.title}</span>
          {abgesagt && <span className="cal-bubble-abgesagt">⛔ Abgesagt</span>}
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

      {/* Bei einem abgesagten Termin gibt es nichts mehr zu beantworten. */}
      {!abgesagt && <RsvpButtons event={event} onChanged={setEvent} compact />}
    </div>
  );
}
