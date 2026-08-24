import { useState } from 'react';
import type { CalendarEventDto, RsvpStatus } from '@initiative/shared';
import { api } from '../../lib/api.js';
import { useMyId } from '../../state/session.js';
import { toast } from '../../state/ui.js';
import { myRsvp } from './helpers.js';

const CHOICES: { status: RsvpStatus; label: string; short: string; icon: string }[] = [
  { status: 'yes', label: 'Zusagen', short: 'Ja', icon: '✓' },
  { status: 'maybe', label: 'Vielleicht', short: 'Vielleicht', icon: '?' },
  { status: 'no', label: 'Absagen', short: 'Nein', icon: '✕' },
];

interface RsvpButtonsProps {
  event: CalendarEventDto;
  /** The updated event coming back from the API. */
  onChanged: (event: CalendarEventDto) => void;
  compact?: boolean;
}

/** Zu-/Absagen with an optimistic state that snaps back when the call fails. */
export function RsvpButtons({ event, onChanged, compact }: RsvpButtonsProps) {
  const myId = useMyId();
  const [pending, setPending] = useState<RsvpStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const active = pending ?? myRsvp(event, myId);

  async function choose(status: RsvpStatus) {
    if (busy) return;
    setBusy(true);
    setPending(status);
    try {
      onChanged(await api.calendar.rsvp(event.id, status));
    } catch {
      toast('Deine Antwort konnte nicht gespeichert werden', 'error');
    } finally {
      setPending(null);
      setBusy(false);
    }
  }

  return (
    <div
      className={`cal-rsvp ${compact ? 'is-compact' : ''}`}
      role="group"
      aria-label="Deine Antwort"
    >
      {CHOICES.map((choice) => (
        <button
          key={choice.status}
          type="button"
          className={`cal-rsvp-btn cal-rsvp-${choice.status} ${active === choice.status ? 'is-active' : ''}`}
          aria-pressed={active === choice.status}
          aria-label={choice.label}
          disabled={busy}
          onClick={() => void choose(choice.status)}
        >
          <span className="cal-rsvp-icon" aria-hidden="true">
            {choice.icon}
          </span>
          <span>{compact ? choice.short : choice.label}</span>
        </button>
      ))}
    </div>
  );
}
