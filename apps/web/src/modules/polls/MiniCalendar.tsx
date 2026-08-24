import { useMemo } from 'react';
import {
  addMonths,
  dayKey,
  formatDayHeading,
  formatMonthTitle,
  isSameDay,
  monthGridDays,
  startOfDay,
  weekdayShortLabels,
} from './helpers.js';

interface MiniCalendarProps {
  month: Date;
  onMonthChange: (month: Date) => void;
  /** Day keys (`YYYY-MM-DD`) that are currently picked. */
  selected: string[];
  onToggleDay: (key: string) => void;
}

/** Monday-first month grid; tapping a day picks or drops it. Past days are off. */
export function MiniCalendar({ month, onMonthChange, selected, onToggleDay }: MiniCalendarProps) {
  const days = useMemo(() => monthGridDays(month), [month]);
  const weekdays = useMemo(() => weekdayShortLabels(), []);
  const today = startOfDay(new Date());

  return (
    <div className="poll-cal">
      <header className="poll-cal-head">
        <button
          type="button"
          className="icon-btn"
          aria-label="Vorheriger Monat"
          onClick={() => onMonthChange(addMonths(month, -1))}
        >
          ‹
        </button>
        <strong>{formatMonthTitle(month)}</strong>
        <button
          type="button"
          className="icon-btn"
          aria-label="Nächster Monat"
          onClick={() => onMonthChange(addMonths(month, 1))}
        >
          ›
        </button>
      </header>

      <div className="poll-cal-weekdays" aria-hidden="true">
        {weekdays.map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>

      <div className="poll-cal-grid" role="group" aria-label={formatMonthTitle(month)}>
        {days.map((day) => {
          const key = dayKey(day);
          const outside = day.getMonth() !== month.getMonth();
          const past = day.getTime() < today.getTime();
          const active = selected.includes(key);
          return (
            <button
              key={key}
              type="button"
              className={`poll-cal-cell${outside ? ' is-outside' : ''}${
                isSameDay(day, today) ? ' is-today' : ''
              }${active ? ' is-active' : ''}`}
              aria-pressed={active}
              aria-label={formatDayHeading(day)}
              disabled={past}
              onClick={() => onToggleDay(key)}
            >
              {day.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}
