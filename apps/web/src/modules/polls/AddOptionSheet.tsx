import { useState } from 'react';
import type { PollDto } from '@initiative/shared';
import { Sheet } from '../../components/Sheet.js';
import { ApiError, api } from '../../lib/api.js';
import { toast } from '../../state/ui.js';
import {
  DURATION_OPTIONS,
  MAX_OPTION_LABEL,
  MAX_OPTIONS,
  buildSlot,
  dayFromKey,
  dayKey,
  parseTime,
  type SlotDuration,
} from './helpers.js';

interface AddOptionSheetProps {
  poll: PollDto;
  onClose: () => void;
  onAdded: (poll: PollDto) => void;
}

/** Adds one more choice or one more date proposal to a running poll. */
export function AddOptionSheet({ poll, onClose, onAdded }: AddOptionSheetProps) {
  const isDate = poll.kind === 'date';
  const [label, setLabel] = useState('');
  const [day, setDay] = useState(() => dayKey(new Date()));
  const [time, setTime] = useState('10:00');
  const [duration, setDuration] = useState<SlotDuration>(60);
  const [saving, setSaving] = useState(false);

  const full = poll.options.length >= MAX_OPTIONS;

  async function save(): Promise<void> {
    if (saving || full) return;
    let body: { label?: string; startsAt?: string; endsAt?: string };

    if (isDate) {
      const date = dayFromKey(day);
      if (!date) {
        toast('Bitte wähle ein gültiges Datum', 'error');
        return;
      }
      const minutes = duration === 'allDay' ? 0 : parseTime(time);
      if (minutes == null) {
        toast('Bitte gib eine gültige Uhrzeit an', 'error');
        return;
      }
      body = buildSlot(date, minutes, duration);
    } else {
      const trimmed = label.trim();
      if (trimmed.length === 0) {
        toast('Bitte gib der Option einen Text', 'error');
        return;
      }
      body = { label: trimmed.slice(0, MAX_OPTION_LABEL) };
    }

    setSaving(true);
    try {
      onAdded(await api.polls.addOption(poll.id, body));
      toast(isDate ? 'Vorschlag ergänzt' : 'Option ergänzt', 'success');
      onClose();
    } catch (error) {
      toast(
        error instanceof ApiError && error.isOffline
          ? 'Keine Verbindung – bitte später erneut versuchen'
          : error instanceof ApiError
            ? error.message
            : 'Die Option konnte nicht ergänzt werden',
        'error',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open onClose={onClose} title={isDate ? 'Vorschlag ergänzen' : 'Option ergänzen'}>
      {full ? (
        <p className="poll-note">Diese Umfrage hat bereits die maximale Anzahl an Optionen.</p>
      ) : isDate ? (
        <>
          <div className="field">
            <label htmlFor="poll-add-day">Tag</label>
            <input
              id="poll-add-day"
              className="input"
              type="date"
              value={day}
              onChange={(event) => setDay(event.target.value)}
            />
          </div>

          <div className="field">
            <span className="poll-field-label">Dauer</span>
            <div className="poll-chips" role="group" aria-label="Dauer">
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

          {duration !== 'allDay' && (
            <div className="field">
              <label htmlFor="poll-add-time">Uhrzeit</label>
              <input
                id="poll-add-time"
                className="input"
                type="time"
                value={time}
                onChange={(event) => setTime(event.target.value)}
              />
            </div>
          )}
        </>
      ) : (
        <div className="field">
          <label htmlFor="poll-add-label">Option</label>
          <input
            id="poll-add-label"
            className="input"
            value={label}
            maxLength={MAX_OPTION_LABEL}
            placeholder="Noch eine Möglichkeit"
            onChange={(event) => setLabel(event.target.value)}
          />
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
          disabled={saving || full}
        >
          {saving ? 'Wird gespeichert …' : 'Hinzufügen'}
        </button>
      </div>
    </Sheet>
  );
}
