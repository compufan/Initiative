import { useMemo } from 'react';
import { OccurrenceList } from './OccurrenceList.js';
import {
  addMonths,
  dayKey,
  eventColor,
  formatDayHeading,
  formatMonthTitle,
  isSameDay,
  monthGridDays,
  weekdayShortLabels,
  type Occurrence,
} from './helpers.js';

interface MonthViewProps {
  month: Date;
  onMonthChange: (month: Date) => void;
  selectedDay: Date;
  onSelectDay: (day: Date) => void;
  byDay: Map<string, Occurrence[]>;
}

const MAX_DOTS = 3;

/** Monday-first month grid with a dot per event and the tapped day below it. */
export function MonthView({
  month,
  onMonthChange,
  selectedDay,
  onSelectDay,
  byDay,
}: MonthViewProps) {
  const days = useMemo(() => monthGridDays(month), [month]);
  const weekdays = useMemo(() => weekdayShortLabels(), []);
  const today = new Date();
  const selectedKey = dayKey(selectedDay);
  const selected = byDay.get(selectedKey) ?? [];

  return (
    <section className="card cal-month" aria-label="Monatsansicht">
      <header className="cal-month-head">
        <button
          type="button"
          className="icon-btn"
          aria-label="Vorheriger Monat"
          onClick={() => onMonthChange(addMonths(month, -1))}
        >
          ‹
        </button>
        <strong className="cal-month-title">{formatMonthTitle(month)}</strong>
        <button
          type="button"
          className="icon-btn"
          aria-label="Nächster Monat"
          onClick={() => onMonthChange(addMonths(month, 1))}
        >
          ›
        </button>
      </header>

      <div className="cal-weekdays" aria-hidden="true">
        {weekdays.map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>

      <div className="cal-grid" role="group" aria-label={formatMonthTitle(month)}>
        {days.map((day) => {
          const key = dayKey(day);
          const events = byDay.get(key) ?? [];
          const outside = day.getMonth() !== month.getMonth();
          const isToday = isSameDay(day, today);
          const isSelected = key === selectedKey;
          return (
            <button
              key={key}
              type="button"
              aria-pressed={isSelected}
              aria-label={`${formatDayHeading(day)}, ${
                events.length === 1 ? '1 Termin' : `${events.length} Termine`
              }`}
              className={`cal-cell${outside ? ' is-outside' : ''}${isToday ? ' is-today' : ''}${
                isSelected ? ' is-selected' : ''
              }`}
              onClick={() => onSelectDay(day)}
            >
              <span className="cal-cell-number">{day.getDate()}</span>
              <span className="cal-cell-dots">
                {events.slice(0, MAX_DOTS).map((occurrence) => (
                  <span
                    key={occurrence.key}
                    className="cal-dot"
                    style={{ background: eventColor(occurrence.event) }}
                  />
                ))}
                {events.length > MAX_DOTS && <span className="cal-dot-more">+</span>}
              </span>
            </button>
          );
        })}
      </div>

      <div className="cal-day-panel">
        <h2 className="cal-day-heading">{formatDayHeading(selectedDay)}</h2>
        <OccurrenceList occurrences={selected} emptyText="Keine Termine an diesem Tag." />
      </div>
    </section>
  );
}
