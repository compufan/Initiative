import { useState } from 'react';
import { LIMITS, bestOption, type CalendarEventDto, type PollDto } from '@initiative/shared';
import { Sheet } from '../../components/Sheet.js';
import { ApiError, api } from '../../lib/api.js';
import { toast } from '../../state/ui.js';
import { formatSlotLong } from './helpers.js';

interface CreateEventSheetProps {
  poll: PollDto;
  onClose: () => void;
  onCreated: (event: CalendarEventDto, closedPoll: boolean) => void;
}

/**
 * Terminfindung → Termin.
 *
 * The winning proposal is preselected; the answers of the poll become the
 * RSVP states of the new event, so nobody has to reply twice.
 */
export function CreateEventSheet({ poll, onClose, onCreated }: CreateEventSheetProps) {
  /*
   * „Die meisten Zusagen“ nur, wenn überhaupt jemand zugesagt hat.
   *
   * `bestOption` gibt bei leerer Auswertung den frühesten Vorschlag zurück –
   * eine vernünftige Vorauswahl, aber keine Aussage über Stimmen. Der Hinweis
   * behauptete trotzdem „Der Vorschlag mit den meisten Zusagen“, auch wenn
   * niemand geantwortet hatte. Die Blase nebenan (PollBubble.tsx) hält
   * denselben Riegel schon vor.
   */
  const best = bestOption(poll.options, poll.tally);
  /*
   * Drei Lagen, nicht zwei.
   *
   * „Noch keine Antworten" stimmt nur, solange auch niemand geantwortet hat.
   * Haben alle geantwortet und alle abgesagt, ist `voterCount` grösser null
   * und die Punktzahl trotzdem null – dann behauptete der Satz Schweigen, wo
   * eine klare Absage steht.
   */
  const hatStimmen = Boolean(best && poll.voterCount > 0 && (poll.tally[best.id]?.score ?? 0) > 0);
  const niemandGefragt = poll.voterCount === 0;
  const [optionId, setOptionId] = useState(best?.id ?? poll.options[0]?.id ?? '');
  const [title, setTitle] = useState(poll.question);
  const [location, setLocation] = useState('');
  const [description, setDescription] = useState(poll.description ?? '');
  const [closePoll, setClosePoll] = useState(true);
  const [saving, setSaving] = useState(false);

  async function save(): Promise<void> {
    if (saving) return;
    const trimmed = title.trim();
    if (optionId.length === 0) {
      toast('Bitte wähle einen Vorschlag', 'error');
      return;
    }
    if (trimmed.length === 0) {
      toast('Der Termin braucht einen Titel', 'error');
      return;
    }
    setSaving(true);
    try {
      const event = await api.polls.createEvent(poll.id, {
        optionId,
        title: trimmed,
        location: location.trim() || null,
        description: description.trim() || null,
        closePoll,
      });
      toast('Termin erstellt', 'success');
      onCreated(event, closePoll);
      onClose();
    } catch (error) {
      toast(
        error instanceof ApiError && error.isOffline
          ? 'Keine Verbindung – der Termin wurde nicht erstellt'
          : error instanceof ApiError
            ? error.message
            : 'Der Termin konnte nicht erstellt werden',
        'error',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open onClose={onClose} title="Termin erstellen">
      <div className="field">
        <label htmlFor="poll-event-option">Vorschlag</label>
        <select
          id="poll-event-option"
          className="select"
          value={optionId}
          onChange={(event) => setOptionId(event.target.value)}
        >
          {poll.options.map((option) => (
            <option key={option.id} value={option.id}>
              {formatSlotLong(option)}
            </option>
          ))}
        </select>
        {best?.id === optionId && (
          <span className="poll-hint">
            {hatStimmen
              ? 'Der Vorschlag mit den meisten Zusagen.'
              : niemandGefragt
                ? 'Noch keine Antworten – vorausgewählt ist der früheste Vorschlag.'
                : 'Bisher hat niemand zugesagt – vorausgewählt ist der früheste Vorschlag.'}
          </span>
        )}
      </div>

      <div className="field">
        <label htmlFor="poll-event-title">Titel</label>
        <input
          id="poll-event-title"
          className="input"
          value={title}
          maxLength={LIMITS.eventTitleMax}
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="poll-event-location">Ort (optional)</label>
        <input
          id="poll-event-location"
          className="input"
          value={location}
          maxLength={300}
          placeholder="z. B. Vereinsheim"
          onChange={(event) => setLocation(event.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="poll-event-description">Beschreibung (optional)</label>
        <textarea
          id="poll-event-description"
          className="textarea"
          value={description}
          maxLength={LIMITS.eventDescriptionMax}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>

      <label className="poll-switch">
        <span>Umfrage danach beenden</span>
        <input
          type="checkbox"
          checked={closePoll}
          onChange={(event) => setClosePoll(event.target.checked)}
        />
      </label>

      <div className="row row-between">
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
          Abbrechen
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void save()}
          disabled={saving}
        >
          {saving ? 'Wird erstellt …' : 'Termin erstellen'}
        </button>
      </div>
    </Sheet>
  );
}
