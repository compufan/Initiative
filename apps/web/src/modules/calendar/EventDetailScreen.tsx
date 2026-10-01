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
import { EventDocuments } from './EventDocuments.js';
import { EventEditor } from './EventEditor.js';
import { EventNotes } from './EventNotes.js';
import { EventPollCard } from './EventPollCard.js';
import { EventExpenses } from './EventExpenses.js';
import { EventCollection } from './EventCollection.js';
import { EinladungsWahl } from './EinladungsWahl.js';
import { LEERE_AUSWAHL, terminOhneZustellung, type Auswahl } from './einladung.js';
import { RsvpButtons } from './RsvpButtons.js';
import { ZustellungHinweis } from './ZustellungHinweis.js';
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
  const { event, setEvent, loading, failed, deleted, grund } = useLiveEvent(eventId || null);

  const [editorOpen, setEditorOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [absagenOpen, setAbsagenOpen] = useState(false);
  const [absagend, setAbsagend] = useState(false);
  const [austragenOpen, setAustragenOpen] = useState(false);
  const [austragend, setAustragend] = useState(false);
  /** Wen der Ersteller gerade ausladen will und der schon zugesagt hatte – die Rückfrage. */
  const [ausladenFrage, setAusladenFrage] = useState<string | null>(null);

  const attendeeIds = useMemo(
    () => (event ? event.attendees.map((attendee) => attendee.userId) : []),
    [event],
  );
  const users = useUserLookup(attendeeIds);
  const conversation = useChat(
    (state) => state.conversations.find((item) => item.id === event?.conversationId) ?? null,
  );

  /*
   * Wer neu eingeladen werden soll. Die Liste kommt aus den Kontakten (alle, mit
   * denen man einen Chat teilt), nicht mehr aus dem einen Chat des Termins: Ein
   * Termin hat nicht mehr „seinen“ Chat, und wer schon dabei ist, steht nicht
   * zur Wahl.
   */
  const bisher = useMemo(() => {
    const antworten: Record<string, RsvpStatus> = {};
    for (const teilnehmer of event?.attendees ?? []) {
      if (teilnehmer.userId !== event?.createdBy) antworten[teilnehmer.userId] = teilnehmer.status;
    }
    return antworten;
  }, [event]);

  const [einladenAuswahl, setEinladenAuswahl] = useState<Auswahl>(LEERE_AUSWAHL);
  const [laedtEin, setLaedtEin] = useState(false);
  /**
   * Was der Server zuletzt über die Zustellung gesagt hat (Einladen, Ausladen).
   * Das Hinweisfeld „Einladungen nicht zugestellt“ richtet sich danach, statt bis
   * zum erneuten Öffnen der Seite zu warten.
   */
  const [zustellAntwort, setZustellAntwort] = useState<{ ausstehend: number } | null>(null);

  async function einladen(neue: string[]) {
    if (!event || neue.length === 0) return;
    setLaedtEin(true);
    try {
      const antwort = await api.calendar.invite(
        event.id,
        event.attendees.map((teilnehmer) => teilnehmer.userId),
        neue,
        event.createdBy,
      );
      setEvent(terminOhneZustellung(antwort));
      setEinladenAuswahl(LEERE_AUSWAHL);
      const ausstehend = antwort.zustellung?.ausstehend ?? 0;
      if (antwort.zustellung) setZustellAntwort({ ausstehend });
      const eingeladen = neue.length === 1 ? 'Eingeladen.' : `${neue.length} eingeladen.`;
      // Fehlt eine Karte, meldet es der Ton – wie im Editor. Ein grünes
      // „Eingeladen“ ließe den Ersteller glauben, es sei alles angekommen.
      toast(
        ausstehend > 0
          ? `${eingeladen} ${ausstehend === 1 ? 'Eine Einladung konnte' : `${ausstehend} Einladungen konnten`} nicht zugestellt werden – unten lässt sich das erneut versuchen.`
          : eingeladen,
        ausstehend > 0 ? 'error' : 'success',
      );
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Einladen fehlgeschlagen', 'error');
    } finally {
      setLaedtEin(false);
    }
  }

  async function ausladen(userId: string) {
    if (!event) return;
    try {
      const antwort = await api.calendar.uninvite(event.id, userId);
      setEvent(terminOhneZustellung(antwort));
      if (antwort.zustellung) setZustellAntwort({ ausstehend: antwort.zustellung.ausstehend });
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Ausladen fehlgeschlagen', 'error');
    }
  }

  /**
   * Sich selbst austragen. Wer eingeladen wurde, ohne gefragt zu werden, hat
   * sonst keine Möglichkeit, den Termin wieder loszuwerden: Er bliebe im Kalender
   * und in den Chats, bis der Ersteller ihn entfernt. Der Zugang endet sofort.
   */
  async function austragen() {
    if (!event || austragend) return;
    setAustragend(true);
    try {
      await api.calendar.uninvite(event.id, myId);
      toast('Du bist nicht mehr zu diesem Termin eingeladen.', 'success');
      setAustragenOpen(false);
      navigate('/kalender');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Austragen fehlgeschlagen', 'error');
      setAustragend(false);
    }
  }

  /**
   * Absagen lässt den Termin und seine Karten stehen („Abgesagt“) und
   * benachrichtigt alle; Löschen räumt auf. `wiederaufnehmen` nimmt es zurück.
   */
  async function absagen(wiederaufnehmen: boolean) {
    if (!event || absagend) return;
    setAbsagend(true);
    try {
      const antwort = wiederaufnehmen
        ? await api.calendar.wiederaufnehmen(event.id)
        : await api.calendar.absagen(event.id);
      setEvent(terminOhneZustellung(antwort));
      if (antwort.zustellung) setZustellAntwort({ ausstehend: antwort.zustellung.ausstehend });
      toast(wiederaufnehmen ? 'Termin findet wieder statt' : 'Termin abgesagt', 'success');
      setAbsagenOpen(false);
    } catch (error) {
      toast(
        error instanceof Error && error.message
          ? error.message
          : wiederaufnehmen
            ? 'Termin konnte nicht wieder aufgenommen werden'
            : 'Termin konnte nicht abgesagt werden',
        'error',
      );
    } finally {
      setAbsagend(false);
    }
  }

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
    // Der Grund kommt aus dem Rundruf. Ohne ihn (ein Nachladen, das mit 403 oder
    // 404 endete) weiss man nur, dass der Termin nicht mehr erreichbar ist.
    const ausgeladen = grund === 'ausgeladen';
    const unbekannt = grund === undefined;
    return (
      <Screen title="Termin" back="/kalender">
        <EmptyState
          emoji={ausgeladen || unbekannt ? '📅' : '🗑️'}
          title={
            ausgeladen
              ? 'Nicht mehr eingeladen'
              : unbekannt
                ? 'Termin nicht mehr verfügbar'
                : 'Termin gelöscht'
          }
          description={
            ausgeladen
              ? 'Du bist nicht mehr zu diesem Termin eingeladen.'
              : unbekannt
                ? 'Dieser Termin ist für dich nicht mehr sichtbar.'
                : 'Dieser Termin existiert nicht mehr.'
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

      {event.status === 'cancelled' && (
        <p className="cal-note" role="status">
          ⛔ Dieser Termin ist abgesagt. Zu- und Absagen sind gesperrt.
        </p>
      )}

      {event.status === 'planning' && (
        <EventPollCard event={event} canManage={isCreator} onConfirmed={setEvent} />
      )}

      {isCreator && (
        <ZustellungHinweis eventId={event.id} antwort={zustellAntwort} stand={event.stand} />
      )}

      <section className="card cal-block" aria-label="Deine Antwort">
        <h2 className="cal-block-title">
          {/* Solange der Zeitpunkt offen ist, waere "Bist du dabei?" die
              falsche Frage - beantwortet wird sie in der Abstimmung. */}
          {event.status === 'planning' ? 'Grundsätzlich dabei?' : 'Bist du dabei?'}
        </h2>
        <RsvpButtons event={event} onChanged={setEvent} gesperrt={event.status === 'cancelled'} />
        <p className="cal-hint">
          {mine && mine !== 'pending'
            ? `Du hast ${rsvpMeta(mine).label.toLowerCase()}.`
            : 'Du hast noch nicht geantwortet.'}
        </p>
        {/* Wer nicht dabei sein will, trägt sich aus: Mit „Nein“ bliebe der
            Termin in Kalender und Chats stehen. */}
        {!isCreator && (
          <button type="button" className="btn btn-sm" onClick={() => setAustragenOpen(true)}>
            Aus dem Termin austragen
          </button>
        )}
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
                  {/* Ausladen. Eine Einladung, die sich nicht zuruecknehmen
                      laesst, ist keine Einladung, sondern eine Falle. */}
                  {isCreator && attendee.userId !== event.createdBy && (
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`${name} ausladen`}
                      title="Ausladen"
                      onClick={() =>
                        attendee.status === 'yes' || attendee.status === 'maybe'
                          ? setAusladenFrage(attendee.userId)
                          : void ausladen(attendee.userId)
                      }
                    >
                      ✕
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {/* Nachtraeglich einladen. Ging vorher gar nicht – die Runde stand mit
            dem Anlegen fest. */}
        {/* Nicht, solange über den Zeitpunkt abgestimmt wird: Wer jetzt dazukäme,
            bekäme eine Karte, könnte aber nicht abstimmen. */}
        {isCreator && event.status !== 'planning' && (
          <details className="cal-invite">
            <summary>Jemanden einladen</summary>
            {/*
                Auswählen und Einladen sind zwei Schritte.

                Vorher stand `gewaehlt={[]}` da, und `onChange` lud sofort ein.
                „Alle auswählen“ – ein Knopf, der nach Vorbereiten klingt –
                verschickte damit in einem Zug Einladungen an jeden
                Vorgeschlagenen. Zurücknehmen liess sich das nur einzeln über
                „Ausladen“. Die Häkchen blieben danach leer und der Zähler
                stand weiter auf „0 Personen“ – man sah nicht einmal, was man
                gerade getan hatte.
            */}
            <EinladungsWahl
              myId={myId}
              auswahl={einladenAuswahl}
              onChange={setEinladenAuswahl}
              senden
              onSenden={() => {}}
              einzelchats
              onEinzelchats={() => {}}
              bisher={bisher}
              nurNeue
            />
            <button
              type="button"
              className="btn btn-primary btn-block"
              disabled={einladenAuswahl.personen.length === 0 || laedtEin}
              onClick={() => void einladen(einladenAuswahl.personen)}
            >
              {einladenAuswahl.personen.length <= 1
                ? 'Einladen'
                : `${einladenAuswahl.personen.length} Personen einladen`}
            </button>
          </details>
        )}
      </section>

      <EventNotes
        eventId={event.id}
        canManage={isCreator}
        people={attendees.map((attendee) => ({
          id: attendee.userId,
          displayName:
            attendee.userId === myId ? 'Du' : (users[attendee.userId]?.displayName ?? 'Unbekannt'),
        }))}
      />

      <EventDocuments eventId={event.id} canManage={isCreator} />

      <EventExpenses eventId={event.id} conversationId={event.conversationId} />

      <EventCollection event={event} canManage={isCreator} onChanged={setEvent} />

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
          {/* Absagen ist der freundliche Weg, Löschen der Aufräumweg: Beides
              steht nebeneinander, damit klar ist, was welches tut. */}
          {event.status === 'cancelled' ? (
            <button
              type="button"
              className="btn btn-block"
              disabled={absagend}
              onClick={() => void absagen(true)}
            >
              ↩ Termin findet doch statt
            </button>
          ) : (
            event.status === 'confirmed' && (
              <button type="button" className="btn btn-block" onClick={() => setAbsagenOpen(true)}>
                ⛔ Termin absagen
              </button>
            )
          )}
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
          „{event.title}“ wird für alle Teilnehmenden entfernt, auch die Karten in den Chats. Das
          lässt sich nicht rückgängig machen. Findet der Termin nur nicht statt, nimm „Absagen“:
          Dann bleibt er sichtbar.
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

      <Sheet
        open={absagenOpen}
        onClose={() => setAbsagenOpen(false)}
        variant="modal"
        title="Termin absagen?"
      >
        <p className="muted">
          „{event.title}“ bleibt in den Chats und im Kalender stehen, als abgesagt gekennzeichnet.
          Alle Eingeladenen werden benachrichtigt und können nicht mehr zu- oder absagen. Du kannst
          den Termin später wieder aufnehmen.
        </p>
        <div className="cal-confirm-actions">
          <button type="button" className="btn" onClick={() => setAbsagenOpen(false)}>
            Abbrechen
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={absagend}
            onClick={() => void absagen(false)}
          >
            {absagend ? 'Wird abgesagt …' : 'Absagen'}
          </button>
        </div>
      </Sheet>

      <Sheet
        open={austragenOpen}
        onClose={() => setAustragenOpen(false)}
        variant="modal"
        title="Aus dem Termin austragen?"
      >
        <p className="muted">
          „{event.title}“ verschwindet aus deinem Kalender und deinen Chats, und du siehst weder
          Notizen noch Unterlagen mehr. Nur wer den Termin angelegt hat, kann dich wieder einladen.
        </p>
        <div className="cal-confirm-actions">
          <button type="button" className="btn" onClick={() => setAustragenOpen(false)}>
            Abbrechen
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={austragend}
            onClick={() => void austragen()}
          >
            {austragend ? 'Wird ausgetragen …' : 'Austragen'}
          </button>
        </div>
      </Sheet>

      <Sheet
        open={ausladenFrage != null}
        onClose={() => setAusladenFrage(null)}
        variant="modal"
        title="Wirklich ausladen?"
      >
        <p className="muted">
          {ausladenFrage ? (users[ausladenFrage]?.displayName ?? 'Diese Person') : ''} hatte
          zugesagt. Der Zugang endet sofort, die Karte im Einzelchat wird gelöscht.
        </p>
        <div className="cal-confirm-actions">
          <button type="button" className="btn" onClick={() => setAusladenFrage(null)}>
            Abbrechen
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => {
              const wen = ausladenFrage;
              setAusladenFrage(null);
              if (wen) void ausladen(wen);
            }}
          >
            Ausladen
          </button>
        </div>
      </Sheet>
    </Screen>
  );
}
