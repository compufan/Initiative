import { useState } from 'react';
import { Sheet } from '../../components/Sheet.js';
import { ApiError, api } from '../../lib/api.js';
import { toast } from '../../state/ui.js';
import type { ComposerActionProps } from '../types.js';
import {
  MAX_DESCRIPTION,
  MAX_OPTION_LABEL,
  MAX_OPTIONS,
  MAX_QUESTION,
  addDays,
  atMinutes,
  dayFromKey,
  dayKey,
  parseTime,
} from './helpers.js';

/** Moves an entry inside the list; out-of-range targets are ignored. */
function move(values: string[], from: number, to: number): string[] {
  if (to < 0 || to >= values.length) return values;
  const next = values.slice();
  const [entry] = next.splice(from, 1);
  next.splice(to, 0, entry);
  return next;
}

/**
 * Composer action "Umfrage": question, two to thirty options and the three
 * switches that decide how the poll behaves.
 */
export function PollComposerSheet({ conversationId, onClose }: ComposerActionProps) {
  const [question, setQuestion] = useState('');
  const [description, setDescription] = useState('');
  const [options, setOptions] = useState<string[]>(['', '']);
  const [multiple, setMultiple] = useState(false);
  const [anonymous, setAnonymous] = useState(false);
  const [allowAddOptions, setAllowAddOptions] = useState(false);
  const [hasDeadline, setHasDeadline] = useState(false);
  const [endDay, setEndDay] = useState(() => dayKey(addDays(new Date(), 1)));
  const [endTime, setEndTime] = useState('18:00');
  const [saving, setSaving] = useState(false);

  const filled = options.map((option) => option.trim()).filter((option) => option.length > 0);

  function patchOption(index: number, value: string): void {
    setOptions((current) => current.map((option, at) => (at === index ? value : option)));
  }

  function addOption(): void {
    setOptions((current) => (current.length >= MAX_OPTIONS ? current : [...current, '']));
  }

  function removeOption(index: number): void {
    setOptions((current) =>
      current.length <= 2 ? current : current.filter((_, at) => at !== index),
    );
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
    const trimmed = question.trim();
    if (trimmed.length === 0) {
      toast('Die Umfrage braucht eine Frage', 'error');
      return;
    }
    if (filled.length < 2) {
      toast('Bitte gib mindestens zwei Optionen an', 'error');
      return;
    }
    const closesAt = deadlineIso();
    if (closesAt === undefined) {
      toast('Das Ende der Umfrage muss in der Zukunft liegen', 'error');
      return;
    }

    setSaving(true);
    try {
      await api.polls.create({
        conversationId,
        kind: 'choice',
        question: trimmed.slice(0, MAX_QUESTION),
        description: description.trim() || null,
        options: filled.map((label) => ({ label: label.slice(0, MAX_OPTION_LABEL) })),
        multiple,
        anonymous,
        allowAddOptions,
        closesAt,
      });
      onClose();
    } catch (error) {
      toast(
        error instanceof ApiError && error.isOffline
          ? 'Keine Verbindung – die Umfrage wurde nicht erstellt'
          : error instanceof ApiError
            ? error.message
            : 'Die Umfrage konnte nicht erstellt werden',
        'error',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open onClose={onClose} title="Umfrage">
      <div className="field">
        <label htmlFor="poll-question">Frage</label>
        <input
          id="poll-question"
          className="input"
          value={question}
          maxLength={MAX_QUESTION}
          placeholder="Worüber stimmen wir ab?"
          onChange={(event) => setQuestion(event.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="poll-description">Beschreibung (optional)</label>
        <textarea
          id="poll-description"
          className="textarea"
          value={description}
          maxLength={MAX_DESCRIPTION}
          rows={2}
          placeholder="Kurze Erklärung"
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>

      <div className="field">
        <span className="poll-field-label">
          Optionen{' '}
          <span className="muted">
            ({options.length} von {MAX_OPTIONS})
          </span>
        </span>
        <ul className="poll-editor poll-scroll">
          {options.map((option, index) => (
            <li key={index} className="poll-editor-row">
              <input
                className="input"
                value={option}
                maxLength={MAX_OPTION_LABEL}
                placeholder={`Option ${index + 1}`}
                aria-label={`Option ${index + 1}`}
                onChange={(event) => patchOption(index, event.target.value)}
              />
              <button
                type="button"
                className="icon-btn poll-tool"
                aria-label={`Option ${index + 1} nach oben`}
                disabled={index === 0}
                onClick={() => setOptions((current) => move(current, index, index - 1))}
              >
                ↑
              </button>
              <button
                type="button"
                className="icon-btn poll-tool"
                aria-label={`Option ${index + 1} nach unten`}
                disabled={index === options.length - 1}
                onClick={() => setOptions((current) => move(current, index, index + 1))}
              >
                ↓
              </button>
              <button
                type="button"
                className="icon-btn poll-tool"
                aria-label={`Option ${index + 1} entfernen`}
                disabled={options.length <= 2}
                onClick={() => removeOption(index)}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="btn btn-sm"
          disabled={options.length >= MAX_OPTIONS}
          onClick={addOption}
        >
          ＋ Option
        </button>
      </div>

      <label className="poll-switch">
        <span>
          Mehrfachauswahl
          <span className="poll-hint">Jede Person darf mehrere Optionen wählen.</span>
        </span>
        <input
          type="checkbox"
          checked={multiple}
          onChange={(event) => setMultiple(event.target.checked)}
        />
      </label>

      <label className="poll-switch">
        <span>
          Anonym
          <span className="poll-hint">Nur du siehst, wer wie gestimmt hat.</span>
        </span>
        <input
          type="checkbox"
          checked={anonymous}
          onChange={(event) => setAnonymous(event.target.checked)}
        />
      </label>

      <label className="poll-switch">
        <span>
          Optionen erlauben
          <span className="poll-hint">Alle dürfen weitere Optionen ergänzen.</span>
        </span>
        <input
          type="checkbox"
          checked={allowAddOptions}
          onChange={(event) => setAllowAddOptions(event.target.checked)}
        />
      </label>

      <label className="poll-switch">
        <span>Ende festlegen</span>
        <input
          type="checkbox"
          checked={hasDeadline}
          onChange={(event) => setHasDeadline(event.target.checked)}
        />
      </label>

      {hasDeadline && (
        <div className="poll-deadline">
          <div className="field">
            <label htmlFor="poll-end-day">Datum</label>
            <input
              id="poll-end-day"
              className="input"
              type="date"
              value={endDay}
              onChange={(event) => setEndDay(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="poll-end-time">Uhrzeit</label>
            <input
              id="poll-end-time"
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
          disabled={saving || question.trim().length === 0 || filled.length < 2}
        >
          {saving ? 'Wird erstellt …' : 'Umfrage senden'}
        </button>
      </div>
    </Sheet>
  );
}
