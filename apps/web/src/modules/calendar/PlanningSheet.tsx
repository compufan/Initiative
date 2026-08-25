import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LIMITS, type CalendarEventDto, type ConversationDto } from '@initiative/shared';
import { Sheet } from '../../components/Sheet.js';
import { api } from '../../lib/api.js';
import { useChat } from '../../state/chat.js';
import { toast } from '../../state/ui.js';
import { toLocalInput } from './helpers.js';

interface PlanningSheetProps {
  open: boolean;
  onClose: () => void;
  initialDate?: Date;
  onSaved?: (event: CalendarEventDto) => void;
}

interface Slot {
  key: string;
  startsAt: string;
  endsAt: string;
}

let laufendeNummer = 0;
function neuerSlot(start: Date): Slot {
  laufendeNummer += 1;
  const ende = new Date(start.getTime() + 60 * 60 * 1000);
  return {
    key: `slot-${laufendeNummer}`,
    startsAt: toLocalInput(start),
    endsAt: toLocalInput(ende),
  };
}

/**
 * „Termin abstimmen“ – ein Termin, dessen Zeitpunkt noch offen ist.
 *
 * Das Besondere steht unten: Die Abstimmung kann zusätzlich in Einzelchats
 * gestellt werden, und bleibt trotzdem **eine** Abstimmung. Wer in seinem
 * Einzelchat antwortet, hat damit auch für die Gruppe geantwortet.
 */
export function PlanningSheet({ open, onClose, initialDate, onSaved }: PlanningSheetProps) {
  const navigate = useNavigate();
  const conversations = useChat((state) => state.conversations);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [conversationId, setConversationId] = useState('');
  const [alsoIn, setAlsoIn] = useState<string[]>([]);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const basis = new Date(initialDate ?? new Date());
    basis.setHours(19, 0, 0, 0);
    const naechste = new Date(basis.getTime() + 7 * 24 * 60 * 60 * 1000);
    setSlots([neuerSlot(basis), neuerSlot(naechste)]);
    setTitle('');
    setDescription('');
    setLocation('');
    setAlsoIn([]);
    setConversationId((wert) => wert || (conversations[0]?.id ?? ''));
  }, [open, initialDate, conversations]);

  const gruppen = conversations.filter((chat) => chat.id !== conversationId);

  function setSlot(key: string, feld: 'startsAt' | 'endsAt', wert: string) {
    setSlots((liste) =>
      liste.map((slot) => (slot.key === key ? { ...slot, [feld]: wert } : slot)),
    );
  }

  async function speichern() {
    const sauber = title.trim();
    if (!sauber) {
      toast('Der Termin braucht einen Namen.');
      return;
    }
    if (!conversationId) {
      toast('Wähle den Chat, in dem abgestimmt wird.');
      return;
    }
    const gefuellt = slots.filter((slot) => slot.startsAt);
    if (gefuellt.length < 2) {
      toast('Es braucht mindestens zwei Vorschläge – sonst gibt es nichts zu entscheiden.');
      return;
    }

    setBusy(true);
    try {
      const event = await api.calendar.plan({
        conversationId,
        title: sauber,
        description: description.trim() || undefined,
        location: location.trim() || undefined,
        slots: gefuellt.map((slot) => ({
          startsAt: new Date(slot.startsAt).toISOString(),
          endsAt: slot.endsAt ? new Date(slot.endsAt).toISOString() : undefined,
        })),
        alsoIn: alsoIn.length > 0 ? alsoIn : undefined,
      });
      onSaved?.(event);
      onClose();
      navigate(`/kalender/termin/${event.id}`);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Anlegen fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Termin abstimmen"
      actions={
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => void speichern()}
        >
          {busy ? 'Legt an …' : 'Abstimmen lassen'}
        </button>
      }
    >
      <div className="stack">
        <p className="cal-hint">
          Der Termin steht schon im Kalender – mit dem frühesten Vorschlag und dem Vermerk „in
          Abstimmung“. Sobald entschieden ist, rückt er an seinen Platz.
        </p>

        <div className="field">
          <label htmlFor="plan-title">Worum geht es?</label>
          <input
            id="plan-title"
            className="input"
            value={title}
            maxLength={LIMITS.eventTitleMax}
            placeholder="Grillabend"
            onChange={(event) => setTitle(event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="plan-chat">Abstimmen im Chat</label>
          <select
            id="plan-chat"
            className="select"
            value={conversationId}
            onChange={(event) => setConversationId(event.target.value)}
          >
            <option value="">Bitte wählen</option>
            {conversations.map((chat) => (
              <option key={chat.id} value={chat.id}>
                {chatName(chat)}
              </option>
            ))}
          </select>
        </div>

        <fieldset className="field">
          <legend>Vorschläge</legend>
          {slots.map((slot, index) => (
            <div key={slot.key} className="cal-slot">
              <span className="cal-slot-nr">{index + 1}.</span>
              <input
                type="datetime-local"
                className="input"
                aria-label={`Vorschlag ${index + 1}, Beginn`}
                value={slot.startsAt}
                onChange={(event) => setSlot(slot.key, 'startsAt', event.target.value)}
              />
              <input
                type="datetime-local"
                className="input"
                aria-label={`Vorschlag ${index + 1}, Ende`}
                value={slot.endsAt}
                onChange={(event) => setSlot(slot.key, 'endsAt', event.target.value)}
              />
              {slots.length > 2 && (
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Vorschlag ${index + 1} entfernen`}
                  onClick={() => setSlots((liste) => liste.filter((s) => s.key !== slot.key))}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            className="btn btn-sm"
            disabled={slots.length >= LIMITS.pollOptionsMax}
            onClick={() => {
              const letzter = slots.at(-1);
              const basis = letzter?.startsAt ? new Date(letzter.startsAt) : new Date();
              basis.setDate(basis.getDate() + 7);
              setSlots((liste) => [...liste, neuerSlot(basis)]);
            }}
          >
            Vorschlag hinzufügen
          </button>
        </fieldset>

        {gruppen.length > 0 && (
          <fieldset className="field">
            <legend>Auch in diesen Chats fragen</legend>
            <p className="cal-hint">
              Dieselbe Abstimmung, ein Ergebnis. Wer dort antwortet, hat damit auch hier
              geantwortet – niemand muss zweimal abstimmen.
            </p>
            {gruppen.map((chat) => (
              <label key={chat.id} className="cal-check">
                <input
                  type="checkbox"
                  checked={alsoIn.includes(chat.id)}
                  onChange={(event) =>
                    setAlsoIn((liste) =>
                      event.target.checked
                        ? [...liste, chat.id]
                        : liste.filter((id) => id !== chat.id),
                    )
                  }
                />
                <span className="truncate">{chatName(chat)}</span>
              </label>
            ))}
          </fieldset>
        )}

        <div className="field">
          <label htmlFor="plan-location">Ort (freiwillig)</label>
          <input
            id="plan-location"
            className="input"
            value={location}
            maxLength={200}
            onChange={(event) => setLocation(event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="plan-desc">Beschreibung (freiwillig)</label>
          <textarea
            id="plan-desc"
            className="textarea"
            rows={2}
            value={description}
            maxLength={LIMITS.eventDescriptionMax}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>
      </div>
    </Sheet>
  );
}

function chatName(chat: ConversationDto): string {
  return chat.title ?? (chat.type === 'group' ? 'Gruppe' : 'Chat');
}
