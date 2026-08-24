import { useMemo, useState } from 'react';
import { Screen } from '../../components/Screen.js';
import { Spinner } from '../../components/Feedback.js';
import { AgendaView } from './AgendaView.js';
import { EventEditor } from './EventEditor.js';
import { MonthView } from './MonthView.js';
import { SubscribeCard } from './SubscribeCard.js';
import { useCalendarEvents } from './useCalendarEvents.js';
import {
  AGENDA_DAYS,
  addDays,
  buildOccurrences,
  groupByDay,
  monthGridDays,
  startOfDay,
  startOfMonth,
} from './helpers.js';

type View = 'month' | 'agenda';

/** Calendar home: month grid, agenda, subscription card and the new-event FAB. */
export function KalenderScreen() {
  const [view, setView] = useState<View>('month');
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const [selectedDay, setSelectedDay] = useState(() => startOfDay(new Date()));
  const [editorOpen, setEditorOpen] = useState(false);

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

  const byDay = useMemo(
    () => groupByDay(buildOccurrences(events, range.from, range.to)),
    [events, range],
  );

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
        <AgendaView byDay={byDay} onCreate={() => setEditorOpen(true)} />
      )}

      <SubscribeCard />

      <div className="cal-fab-spacer" aria-hidden="true" />

      <button type="button" className="cal-fab" onClick={() => setEditorOpen(true)}>
        <span aria-hidden="true">＋</span>
        <span>Neuer Termin</span>
      </button>

      <EventEditor
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        initialDate={selectedDay}
        onSaved={apply}
      />
    </Screen>
  );
}
