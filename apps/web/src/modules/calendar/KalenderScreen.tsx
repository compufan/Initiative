import { useMemo, useState } from 'react';
import {
  EVENT_STATUSES,
  RSVP_STATUSES,
  type EventStatus,
  type RsvpStatus,
} from '@initiative/shared';
import { Screen } from '../../components/Screen.js';
import { Spinner } from '../../components/Feedback.js';
import { useListenfilter, type Facette } from '../../components/Listenfilter.js';
import { useChat } from '../../state/chat.js';
import { useMyId } from '../../state/session.js';
import { AgendaView } from './AgendaView.js';
import { EventEditor } from './EventEditor.js';
import { PlanningSheet } from './PlanningSheet.js';
import { MonthView } from './MonthView.js';
import { SubscribeCard } from './SubscribeCard.js';
import { useCalendarEvents } from './useCalendarEvents.js';
import {
  AGENDA_DAYS,
  addDays,
  buildOccurrences,
  groupByDay,
  conversationLabel,
  monthGridDays,
  startOfDay,
  startOfMonth,
  type Occurrence,
} from './helpers.js';

type View = 'month' | 'agenda';

const STATUS_TEXT: Record<EventStatus, string> = {
  planning: 'In Abstimmung',
  confirmed: 'Steht fest',
  cancelled: 'Abgesagt',
};

const RSVP_TEXT: Record<RsvpStatus, string> = {
  yes: 'Zugesagt',
  no: 'Abgesagt',
  maybe: 'Vielleicht',
  pending: 'Noch offen',
};

/** Calendar home: month grid, agenda, subscription card and the new-event FAB. */
export function KalenderScreen() {
  const myId = useMyId();
  const conversations = useChat((state) => state.conversations);
  const [view, setView] = useState<View>('month');
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const [selectedDay, setSelectedDay] = useState(() => startOfDay(new Date()));
  const [editorOpen, setEditorOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);

  // One window covers both views, so switching between them never refetches.
  const range = useMemo(() => {
    const grid = monthGridDays(month);
    const today = startOfDay(new Date());
    const from = new Date(Math.min(grid[0].getTime(), today.getTime()));
    const to = new Date(
      Math.max(addDays(grid[41], 1).getTime(), addDays(today, AGENDA_DAYS + 1).getTime()),
    );
    return { from, to };
  }, [month]);

  const { events, loading, offline, failed, reload, apply } = useCalendarEvents(
    range.from,
    range.to,
  );

  const occurrences = useMemo(
    () => buildOccurrences(events, range.from, range.to),
    [events, range],
  );

  // Der Name eines Chats steht nicht am Termin, sondern nur seine Kennung.
  const chatNamen = useMemo(() => {
    // Denselben Namen wie die Terminzeile darunter: `conversationLabel`
    // bevorzugt den Spitznamen. Eine eigene Fassung nannte den Anzeigenamen –
    // und dann widersprach der Filterknopf dem, was in der Liste stand.
    const namen = new Map(
      conversations.map((chat) => [chat.id, conversationLabel(chat, myId) ?? 'Chat']),
    );
    return (id: string) => namen.get(id) ?? 'Chat';
  }, [conversations, myId]);

  const facetten: Facette<Occurrence>[] = useMemo(
    () => [
      {
        key: 'status',
        label: 'Zustand',
        reihenfolge: [...EVENT_STATUSES],
        werte: (vorkommen) => [
          { id: vorkommen.event.status, label: STATUS_TEXT[vorkommen.event.status] },
        ],
      },
      {
        key: 'chat',
        label: 'Chat',
        werte: (vorkommen) =>
          vorkommen.event.conversationId
            ? [
                {
                  id: vorkommen.event.conversationId,
                  label: chatNamen(vorkommen.event.conversationId),
                },
              ]
            : [{ id: 'ohne', label: 'Nur für mich' }],
      },
      {
        key: 'antwort',
        label: 'Meine Antwort',
        reihenfolge: [...RSVP_STATUSES, 'keine'],
        werte: (vorkommen) => {
          const eigene = vorkommen.event.attendees.find((gast) => gast.userId === myId);
          return [
            eigene
              ? { id: eigene.status, label: RSVP_TEXT[eigene.status] }
              : { id: 'keine', label: 'Nicht eingeladen' },
          ];
        },
      },
    ],
    [chatNamen, myId],
  );

  const filter = useListenfilter(occurrences, {
    suchePlatzhalter: 'Termin suchen …',
    suchtext: (vorkommen) =>
      `${vorkommen.event.title} ${vorkommen.event.location ?? ''} ${vorkommen.event.description ?? ''}`,
    facetten,
  });

  const byDay = useMemo(() => groupByDay(filter.gefiltert), [filter.gefiltert]);

  function changeMonth(next: Date) {
    setMonth(next);
    const today = new Date();
    setSelectedDay(
      next.getFullYear() === today.getFullYear() && next.getMonth() === today.getMonth()
        ? startOfDay(today)
        : startOfMonth(next),
    );
  }

  function goToday() {
    const today = new Date();
    setMonth(startOfMonth(today));
    setSelectedDay(startOfDay(today));
    setView('month');
  }

  return (
    <Screen
      title="Kalender"
      actions={
        <button type="button" className="btn btn-sm" onClick={goToday}>
          Heute
        </button>
      }
    >
      <div className="cal-segment cal-segment-view" role="tablist" aria-label="Ansicht">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'month'}
          className={view === 'month' ? 'is-active' : undefined}
          onClick={() => setView('month')}
        >
          Monat
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'agenda'}
          className={view === 'agenda' ? 'is-active' : undefined}
          onClick={() => setView('agenda')}
        >
          Agenda
        </button>
      </div>

      {/* Die Leiste gilt fuer beide Ansichten. Sonst zeigte das Monatsraster
          nach dem Umschalten wieder alles, obwohl ein Filter gesetzt ist. */}
      {events.length > 0 && filter.steuerung}

      {failed && (
        <div className="card cal-notice">
          <p>
            {offline
              ? 'Keine Verbindung – die Termine sind gerade nicht abrufbar.'
              : 'Die Termine konnten nicht geladen werden.'}
          </p>
          <button type="button" className="btn btn-sm" onClick={() => void reload()}>
            Erneut versuchen
          </button>
        </div>
      )}

      {loading && events.length === 0 ? (
        <Spinner label="Termine werden geladen" />
      ) : view === 'month' ? (
        <MonthView
          month={month}
          onMonthChange={changeMonth}
          selectedDay={selectedDay}
          onSelectDay={setSelectedDay}
          byDay={byDay}
        />
      ) : (
        <AgendaView
          byDay={byDay}
          gefiltert={filter.aktiv}
          onZuruecksetzen={filter.zuruecksetzen}
          onCreate={() => setEditorOpen(true)}
          onPlan={() => setPlanOpen(true)}
        />
      )}

      <SubscribeCard />

      <div className="cal-fab-spacer" aria-hidden="true" />

      {/* Zwei Wege zu einem Termin: Zeitpunkt steht fest, oder er wird
          abgestimmt. Beides gehoert hierher - der abgestimmte Termin steht
          von Anfang an im Kalender, nur eben als "in Abstimmung". */}
      <div className="cal-fab-group">
        <button type="button" className="cal-fab cal-fab-plan" onClick={() => setPlanOpen(true)}>
          <span aria-hidden="true">🗳️</span>
          <span>Abstimmen</span>
        </button>
        <button type="button" className="cal-fab" onClick={() => setEditorOpen(true)}>
          <span aria-hidden="true">＋</span>
          <span>Neuer Termin</span>
        </button>
      </div>

      <EventEditor
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        initialDate={selectedDay}
        onSaved={apply}
      />

      <PlanningSheet
        open={planOpen}
        onClose={() => setPlanOpen(false)}
        initialDate={selectedDay}
        onSaved={apply}
      />
    </Screen>
  );
}
