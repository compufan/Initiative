import { useMemo } from 'react';
import { EmptyState } from '../../components/Feedback.js';
import { OccurrenceList } from './OccurrenceList.js';
import {
  AGENDA_DAYS,
  addDays,
  dayKey,
  formatDayHeading,
  formatShortDate,
  startOfDay,
  type Occurrence,
} from './helpers.js';

interface AgendaViewProps {
  byDay: Map<string, Occurrence[]>;
  onCreate: () => void;
  /** „Termin abstimmen“ – wenn der Zeitpunkt noch offen ist. */
  onPlan?: () => void;
  /** Ob gerade gesucht oder gefiltert wird – für einen ehrlichen Leerzustand. */
  gefiltert?: boolean;
  onZuruecksetzen?: () => void;
}

/** Flat list of the next ~60 days, grouped by day and skipping empty ones. */
export function AgendaView({
  byDay,
  onCreate,
  onPlan,
  gefiltert,
  onZuruecksetzen,
}: AgendaViewProps) {
  const days = useMemo(() => {
    const first = startOfDay(new Date());
    const result: { key: string; date: Date; occurrences: Occurrence[] }[] = [];
    for (let offset = 0; offset <= AGENDA_DAYS; offset += 1) {
      const date = addDays(first, offset);
      const key = dayKey(date);
      const occurrences = byDay.get(key);
      if (occurrences && occurrences.length > 0) result.push({ key, date, occurrences });
    }
    return result;
  }, [byDay]);

  // Zwei verschiedene Aussagen, die man nicht verwechseln darf: „da ist
  // nichts“ und „dein Filter lässt nichts übrig“. Die zweite mit dem Angebot
  // zurückzusetzen, sonst sucht man den Ausweg.
  if (days.length === 0 && gefiltert) {
    return (
      <EmptyState
        emoji="🔍"
        title="Nichts gefunden"
        description="In den nächsten 60 Tagen passt nichts zu deiner Suche."
        action={
          onZuruecksetzen && (
            <button type="button" className="btn" onClick={onZuruecksetzen}>
              Filter zurücksetzen
            </button>
          )
        }
      />
    );
  }

  if (days.length === 0) {
    return (
      <EmptyState
        emoji="📅"
        title="Nichts geplant"
        description="In den nächsten 60 Tagen steht nichts an. Leg den ersten Termin an."
        action={
          <div className="cal-empty-actions">
            <button type="button" className="btn btn-primary" onClick={onCreate}>
              Termin anlegen
            </button>
            {onPlan && (
              <button type="button" className="btn" onClick={onPlan}>
                Termin abstimmen
              </button>
            )}
          </div>
        }
      />
    );
  }

  return (
    <section className="cal-agenda" aria-label="Agenda">
      {days.map((day) => (
        <div key={day.key} className="cal-agenda-day">
          <div className="cal-agenda-head">
            <h2 className="cal-day-heading">{formatDayHeading(day.date)}</h2>
            <span className="cal-agenda-date">{formatShortDate(day.date)}</span>
          </div>
          <OccurrenceList occurrences={day.occurrences} />
        </div>
      ))}
    </section>
  );
}
