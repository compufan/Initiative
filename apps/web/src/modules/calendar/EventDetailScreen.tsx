import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { googleCalendarUrl, type RsvpStatus } from '@initiative/shared';
import { Avatar } from '../../components/Avatar.js';
import { EmptyState, Spinner } from '../../components/Feedback.js';
import { Screen } from '../../components/Screen.js';
import { Sheet } from '../../components/Sheet.js';
import { api } from '../../lib/api.js';
import { useChat } from '../../state/chat.js';
import { useMyId } from '../../state/session.js';
import { toast } from '../../state/ui.js';
import { EventEditor } from './EventEditor.js';
import { RsvpButtons } from './RsvpButtons.js';
import { useLiveEvent } from './useCalendarEvents.js';
import {
  absoluteUrl,
  conversationLabel,
  eventColor,
  formatFullDate,
  formatMonthShort,
  formatOccurrenceTime,
  myRsvp,
  nextOccurrence,
  recurrenceHint,
  reminderLabel,
  rsvpMeta,
  useUserLookup,
} from './helpers.js';

const STATUS_ORDER: Record<RsvpStatus, number> = { yes: 0, maybe: 1, pending: 2, no: 3 };

/** Full view of a single event: facts, RSVP, participants and export. */
export function EventDetailScreen() {
  const params = useParams();
  const navigate = useNavigate();
  const myId = useMyId();
  const eventId = params.eventId ?? '';
  const { event, setEvent, loading, failed, deleted } = useLiveEvent(eventId || null);

  const [editorOpen, setEditorOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const attendeeIds = useMemo(
    () => (event ? event.attendees.map((attendee) => attendee.userId) : []),
    [event],
  );
  const users = useUserLookup(attendeeIds);
  const conversation = useChat(
    (state) => state.conversations.find((item) => item.id === event?.conversationId) ?? null,
  );

  const attendees = useMemo(() => {
    if (!event) return [];
    return event.attendees.slice().sort((a, b) => {
      const order = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
      if (order !== 0) return order;
      return (users[a.userId]?.displayName ?? '').localeCompare(
        users[b.userId]?.displayName ?? '',
        'de',
      );
    });
  }, [event, users]);

  async function remove() {
    if (!event || deleting) return;
    setDeleting(true);
    try {
      await api.calendar.remove(event.id);
      toast('Termin gelöscht', 'success');
      setConfirmOpen(false);
      navigate('/kalender');
    } catch {
      toast('Termin konnte nicht gelöscht werden', 'error');
      setDeleting(false);
    }
  }

  if (loading && !event) {
    return (
      <Screen title="Termin" back="/kalender">
        <Spinner label="Termin wird geladen" />
      </Screen>
    );
  }

  if (deleted) {
    return (
      <Screen title="Termin" back="/kalender">
        <EmptyState
          emoji="🗑️"
          title="Termin gelöscht"
          description="Dieser Termin existiert nicht mehr."
          action={
            <Link className="btn btn-primary" to="/kalender">
              Zum Kalender
            </Link>
          }
        />
      </Screen>
    );
  }

  if (!event) {
    return (
      <Screen title="Termin" back="/kalender">
        <EmptyState
          emoji="📅"
          title="Termin nicht gefunden"
          description={
            failed
              ? 'Der Termin konnte nicht geladen werden. Vielleicht fehlt dir der Zugriff.'
              : 'Dieser Termin ist nicht mehr verfügbar.'
          }
          action={
            <Link className="btn btn-primary" to="/kalender">
              Zum Kalender
            </Link>
          }
        />
      </Screen>
    );
  }

  const occurrence = nextOccurrence(event);
  const repeat = recurrenceHint(event.rrule);
  const isCreator = event.createdBy === myId;
  const chatLabel = conversationLabel(conversation, myId);
  const icsUrl = absoluteUrl(api.calendar.eventIcsUrl(event.id));
  const googleUrl = googleCalendarUrl({
    id: event.id,
    title: event.title,
    description: event.description,
    location: event.location,
    startsAt: occurrence.start,
    endsAt: occurrence.end,
  });
  const mine = myRsvp(event, myId);

  return (
    <Screen
      title={event.title}
      subtitle={formatFullDate(occurrence.start)}
      back="/kalender"
      actions={
        isCreator ? (
          <button
            type="button"
            className="icon-btn"
            aria-label="Termin bearbeiten"
            onClick={() => setEditorOpen(true)}
          >
            ✎
          </button>
        ) : undefined
      }
    >
      <section className="card cal-detail-head" style={{ borderLeftColor: eventColor(event) }}>
        <span className="cal-date-block cal-date-block-lg">
          <span className="cal-date-day">{occurrence.start.getDate()}</span>
          <span className="cal-date-month">{formatMonthShort(occurrence.start)}</span>
        </span>
        <div className="cal-detail-facts">
          <h2 className="cal-detail-title">{event.title}</h2>
          <p className="cal-detail-line">🕒 {formatOccurrenceTime(occurrence)}</p>
          {event.location && <p className="cal-detail-line">📍 {event.location}</p>}
          {repeat && <p className="cal-detail-line">🔁 {repeat}</p>}
          {chatLabel && event.conversationId && (
            <p className="cal-detail-line">
              💬{' '}
              <Link to={`/chats/${event.conversationId}`} className="cal-detail-link">
                {chatLabel}
              </Link>
            </p>
          )}
        </div>
      </section>

      {event.sourcePollId && (
        <p className="cal-note">📊 Dieser Termin ist aus einer Terminumfrage entstanden.</p>
      )}

      {event.description && <p className="cal-detail-description">{event.description}</p>}

      {event.reminderMinutes.length > 0 && (
        <p className="cal-detail-line">
          🔔 {event.reminderMinutes.map((minutes) => reminderLabel(minutes)).join(' · ')}
        </p>
      )}

      <section className="card cal-block" aria-label="Deine Antwort">
        <h2 className="cal-block-title">Bist du dabei?</h2>
        <RsvpButtons event={event} onChanged={setEvent} />
        <p className="cal-hint">
          {mine && mine !== 'pending'
            ? `Du hast ${rsvpMeta(mine).label.toLowerCase()}.`
            : 'Du hast noch nicht geantwortet.'}
        </p>
      </section>

      <section className="card cal-block" aria-label="Teilnehmende">
        <h2 className="cal-block-title">
          Teilnehmende <span className="muted">({attendees.length})</span>
        </h2>
        {attendees.length === 0 ? (
          <p className="cal-empty-line">Noch niemand eingeladen.</p>
        ) : (
          <ul className="cal-attendees">
            {attendees.map((attendee) => {
              const user = users[attendee.userId];
              const name = attendee.userId === myId ? 'Du' : (user?.displayName ?? 'Unbekannt');
              const status = rsvpMeta(attendee.status);
              return (
                <li key={attendee.userId} className="cal-attendee">
                  <Avatar
                    name={name}
                    id={attendee.userId}
                    url={user?.avatarUrl ?? null}
                    size={34}
                  />
                  <span className="cal-attendee-name truncate">{name}</span>
                  <span className="cal-attendee-status" style={{ color: status.color }}>
                    <span aria-hidden="true">{status.symbol}</span> {status.label}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="card cal-block" aria-label="Zum Kalender hinzufügen">
        <h2 className="cal-block-title">Zum Kalender hinzufügen</h2>
        <a className="btn btn-block" href={icsUrl} download="termin.ics">
          📥 ICS-Datei laden (iPhone, Outlook)
        </a>
        <a className="btn btn-block" href={googleUrl} target="_blank" rel="noreferrer noopener">
          🗓️ In Google Kalender öffnen
        </a>
      </section>

      {isCreator && (
        <section className="card cal-block" aria-label="Termin verwalten">
          <h2 className="cal-block-title">Verwalten</h2>
          <button type="button" className="btn btn-block" onClick={() => setEditorOpen(true)}>
            ✎ Termin bearbeiten
          </button>
          <button
            type="button"
            className="btn btn-danger btn-block"
            onClick={() => setConfirmOpen(true)}
          >
            🗑️ Termin löschen
          </button>
        </section>
      )}

      <EventEditor
        open={editorOpen}
        event={event}
        onClose={() => setEditorOpen(false)}
        onSaved={setEvent}
      />

      <Sheet
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        variant="modal"
        title="Termin löschen?"
      >
        <p className="muted">
          „{event.title}“ wird für alle Teilnehmenden entfernt. Das lässt sich nicht rückgängig
          machen.
        </p>
        <div className="cal-confirm-actions">
          <button type="button" className="btn" onClick={() => setConfirmOpen(false)}>
            Abbrechen
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={deleting}
            onClick={() => void remove()}
          >
            {deleting ? 'Wird gelöscht …' : 'Löschen'}
          </button>
        </div>
      </Sheet>
    </Screen>
  );
}
