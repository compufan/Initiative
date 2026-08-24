import { useMemo, useState } from 'react';
import { Sheet } from '../../components/Sheet.js';
import { ApiError, api } from '../../lib/api.js';
import { toast } from '../../state/ui.js';
import type { ComposerActionProps } from '../types.js';
import { MiniCalendar } from './MiniCalendar.js';
import {
  DURATION_OPTIONS,
  MAX_OPTIONS,
  MAX_QUESTION,
  TIME_PRESETS,
  addDays,
  atMinutes,
  buildSlot,
  dayFromKey,
  dayKey,
  formatDayHeading,
  formatMinutes,
  parseTime,
  startOfMonth,
  type SlotDuration,
} from './helpers.js';

/** First suggestion of a freshly picked day. */
const DEFAULT_MINUTES = 10 * 60;

interface Slot {
  key: string;
  startsAt: string;
  endsAt: string;
}

/**
 * Composer action "Terminfindung".
 *
 * Tap the days in the mini calendar, give every day one or more times and the
 * sheet turns that into the date proposals of a poll – the part everybody
 * answers with ✓ / ? / ✕ afterwards.
 */
export function DatePollComposerSheet({ conversationId, onClose }: ComposerActionProps) {
  const [title, setTitle] = useState('');
  const [duration, setDuration] = useState<SlotDuration>(60);
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const [days, setDays] = useState<Record<string, number[]>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [anonymous, setAnonymous] = useState(false);
  const [allowAddOptions, setAllowAddOptions] = useState(false);
  const [hasDeadline, setHasDeadline] = useState(false);
  const [endDay, setEndDay] = useState(() => dayKey(addDays(new Date(), 3)));
  const [endTime, setEndTime] = useState('18:00');
  const [saving, setSaving] = useState(false);

  const dayKeys = useMemo(() => Object.keys(days).sort(), [days]);

  const slots = useMemo<Slot[]>(() => {
    const list: Slot[] = [];
    for (const key of Object.keys(days).sort()) {
      const day = dayFromKey(key);
      if (!day) continue;
      if (duration === 'allDay') {
        list.push({ key, ...buildSlot(day, 0, 'allDay') });
        continue;
      }
      for (const minutes of days[key] ?? []) {
        list.push({ key: `${key}:${minutes}`, ...buildSlot(day, minutes, duration) });
      }
    }
    return list.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  }, [days, duration]);

  function toggleDay(key: string): void {
    setDays((current) => {
      if (current[key]) {
        const next = { ...current };
        delete next[key];
        return next;
      }
      return { ...current, [key]: [DEFAULT_MINUTES] };
    });
  }

  function addTime(key: string, minutes: number): void {
    setDays((current) => {
      const times = current[key] ?? [];
      if (times.includes(minutes)) return current;
      return { ...current, [key]: [...times, minutes].sort((a, b) => a - b) };
    });
  }

  function removeTime(key: string, minutes: number): void {
    setDays((current) => ({
      ...current,
      [key]: (current[key] ?? []).filter((value) => value !== minutes),
    }));
  }

  /** Quick row: the preset is set on every day, or dropped from every day. */
  function toggleTimeEverywhere(minutes: number): void {
    setDays((current) => {
      const keys = Object.keys(current);
      if (keys.length === 0) return current;
      const everywhere = keys.every((key) => (current[key] ?? []).includes(minutes));
      const next: Record<string, number[]> = {};
      for (const key of keys) {
        const times = current[key] ?? [];
        next[key] = everywhere
          ? times.filter((value) => value !== minutes)
          : times.includes(minutes)
            ? times
            : [...times, minutes].sort((a, b) => a - b);
      }
      return next;
    });
  }

  function addDraft(key: string): void {
    const minutes = parseTime(drafts[key] ?? '');
    if (minutes == null) {
      toast('Bitte gib eine gültige Uhrzeit an', 'error');
      return;
    }
    addTime(key, minutes);
    setDrafts((current) => ({ ...current, [key]: '' }));
  }

  function deadlineIso(): string | null | undefined {
    if (!hasDeadline) return null;
    const day = dayFromKey(endDay);
    const minutes = parseTime(endTime);
    if (!day || minutes == null) return undefined;
    const date = atMinutes(day, minutes);
    return date.getTime() <= Date.now() ? undefined : date.toISOString();
  }

  async function save(): Promise<void> {
    if (saving) return;
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      toast('Die Terminfindung braucht einen Titel', 'error');
      return;
    }
    if (slots.length < 2) {
      toast('Bitte schlage mindestens zwei Termine vor', 'error');
      return;
    }
    if (slots.length > MAX_OPTIONS) {
      toast(`Höchstens ${MAX_OPTIONS} Vorschläge sind möglich`, 'error');
      return;
    }
    const closesAt = deadlineIso();
    if (closesAt === undefined) {
      toast('Das Ende der Abstimmung muss in der Zukunft liegen', 'error');
      return;
    }

    setSaving(true);
    try {
      await api.polls.create({
        conversationId,
        kind: 'date',
        question: trimmed.slice(0, MAX_QUESTION),
        options: slots.map((slot) => ({ startsAt: slot.startsAt, endsAt: slot.endsAt })),
        multiple: true,
        anonymous,
        allowAddOptions,
        closesAt,
      });
      onClose();
    } catch (error) {
      toast(
        error instanceof ApiError && error.isOffline
          ? 'Keine Verbindung – die Terminfindung wurde nicht erstellt'
          : error instanceof ApiError
            ? error.message
            : 'Die Terminfindung konnte nicht erstellt werden',
        'error',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open onClose={onClose} title="Terminfindung">
      <div className="field">
        <label htmlFor="poll-date-title">Titel</label>
        <input
          id="poll-date-title"
          className="input"
          value={title}
          maxLength={MAX_QUESTION}
          placeholder="Wann passt es euch?"
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>

      <div className="field">
        <span className="poll-field-label">Dauer je Termin</span>
        <div className="poll-chips" role="group" aria-label="Dauer je Termin">
          {DURATION_OPTIONS.map((option) => (
            <button
              key={String(option.value)}
              type="button"
              className={`poll-chip${duration === option.value ? ' is-active' : ''}`}
              aria-pressed={duration === option.value}
              onClick={() => setDuration(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <span className="poll-field-label">Tage auswählen</span>
        <MiniCalendar
          month={month}
          onMonthChange={setMonth}
          selected={dayKeys}
          onToggleDay={toggleDay}
        />
      </div>

      {dayKeys.length === 0 ? (
        <p className="poll-note">Tippe im Kalender auf die Tage, die infrage kommen.</p>
      ) : (
        <>
          {duration !== 'allDay' && (
            <div className="poll-quick">
              <span className="poll-hint">Für alle Tage:</span>
              <div className="poll-chips" role="group" aria-label="Schnellauswahl für alle Tage">
                {TIME_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    className="poll-chip"
                    onClick={() => toggleTimeEverywhere(preset.minutes)}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <ul className="poll-days poll-scroll">
            {dayKeys.map((key) => {
              const day = dayFromKey(key);
              if (!day) return null;
              const heading = formatDayHeading(day);
              const times = days[key] ?? [];
              return (
                <li key={key} className="poll-day">
                  <div className="poll-day-head">
                    <strong>{heading}</strong>
                    <button
                      type="button"
                      className="icon-btn poll-tool"
                      aria-label={`${heading} entfernen`}
                      onClick={() => toggleDay(key)}
                    >
                      ✕
                    </button>
                  </div>

                  {duration === 'allDay' ? (
                    <span className="poll-hint">Ganztägiger Vorschlag</span>
                  ) : (
                    <>
                      <div className="poll-chips">
                        {times.map((minutes) => (
                          <button
                            key={minutes}
                            type="button"
                            className="poll-chip is-active"
                            aria-label={`${formatMinutes(minutes)} entfernen`}
                            onClick={() => removeTime(key, minutes)}
                          >
                            {formatMinutes(minutes)} <span aria-hidden="true">✕</span>
                          </button>
                        ))}
                        {TIME_PRESETS.filter((preset) => !times.includes(preset.minutes)).map(
                          (preset) => (
                            <button
                              key={preset.label}
                              type="button"
                              className="poll-chip"
                              onClick={() => addTime(key, preset.minutes)}
                            >
                              ＋ {preset.label}
                            </button>
                          ),
                        )}
                      </div>

                      <div className="poll-day-add">
                        <input
                          className="input"
                          type="time"
                          value={drafts[key] ?? ''}
                          aria-label={`Uhrzeit für ${heading}`}
                          onChange={(event) =>
                            setDrafts((current) => ({ ...current, [key]: event.target.value }))
                          }
                        />
                        <button type="button" className="btn btn-sm" onClick={() => addDraft(key)}>
                          Uhrzeit
                        </button>
                      </div>

                      {times.length === 0 && (
                        <span className="poll-hint">
                          Ohne Uhrzeit entsteht für diesen Tag kein Vorschlag.
                        </span>
                      )}
                    </>
                  )}
                </li>
              );
            })}
          </ul>

          <p className={`poll-count${slots.length > MAX_OPTIONS ? ' is-over' : ''}`}>
            {slots.length} von {MAX_OPTIONS} Vorschlägen
          </p>
        </>
      )}

      <label className="poll-switch">
        <span>
          Anonym
          <span className="poll-hint">Nur du siehst, wer wie geantwortet hat.</span>
        </span>
        <input
          type="checkbox"
          checked={anonymous}
          onChange={(event) => setAnonymous(event.target.checked)}
        />
      </label>

      <label className="poll-switch">
        <span>
          Vorschläge erlauben
          <span className="poll-hint">Alle dürfen weitere Termine vorschlagen.</span>
        </span>
        <input
          type="checkbox"
          checked={allowAddOptions}
          onChange={(event) => setAllowAddOptions(event.target.checked)}
        />
      </label>

      <label className="poll-switch">
        <span>Ende der Abstimmung</span>
        <input
          type="checkbox"
          checked={hasDeadline}
          onChange={(event) => setHasDeadline(event.target.checked)}
        />
      </label>

      {hasDeadline && (
        <div className="poll-deadline">
          <div className="field">
            <label htmlFor="poll-date-end-day">Datum</label>
            <input
              id="poll-date-end-day"
              className="input"
              type="date"
              value={endDay}
              onChange={(event) => setEndDay(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="poll-date-end-time">Uhrzeit</label>
            <input
              id="poll-date-end-time"
              className="input"
              type="time"
              value={endTime}
              onChange={(event) => setEndTime(event.target.value)}
            />
          </div>
        </div>
      )}

      <div className="row row-between">
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
          Abbrechen
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void save()}
          disabled={saving || title.trim().length === 0 || slots.length < 2}
        >
          {saving ? 'Wird erstellt …' : 'Terminfindung senden'}
        </button>
      </div>
    </Sheet>
  );
}
