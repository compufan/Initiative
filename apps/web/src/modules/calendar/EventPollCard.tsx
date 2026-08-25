import { useEffect, useMemo, useState } from 'react';
import type { CalendarEventDto, PollDto } from '@initiative/shared';
import { Spinner } from '../../components/Feedback.js';
import { api } from '../../lib/api.js';
import { useChat } from '../../state/chat.js';
import { useMyId } from '../../state/session.js';
import { toast } from '../../state/ui.js';
import { formatFullDate, formatTime } from './helpers.js';

interface EventPollCardProps {
  event: CalendarEventDto;
  /** Ob ich den Termin verwalten darf – nur dann lässt sich der Zeitpunkt setzen. */
  canManage: boolean;
  onConfirmed: (event: CalendarEventDto) => void;
}

const ANTWORTEN = [
  { wert: 'yes' as const, label: 'Passt', symbol: '✅' },
  { wert: 'maybe' as const, label: 'Vielleicht', symbol: '🤔' },
  { wert: 'no' as const, label: 'Passt nicht', symbol: '❌' },
];

/**
 * Die laufende Terminfindung, direkt am Termin.
 *
 * Es ist dieselbe Umfrage wie im Chat, mit demselben Ergebnis: Wer hier
 * antwortet, hat auch dort geantwortet. Deshalb wird unten auch aufgezählt,
 * wo überall gefragt wird – sonst wirkt es wie zwei getrennte Abstimmungen.
 */
export function EventPollCard({ event, canManage, onConfirmed }: EventPollCardProps) {
  const myId = useMyId();
  const conversations = useChat((state) => state.conversations);
  const [poll, setPoll] = useState<PollDto | null>(null);
  const [orte, setOrte] = useState<string[]>([]);
  const [laedt, setLaedt] = useState(true);
  const [busy, setBusy] = useState(false);

  const pollId = event.pollId;

  useEffect(() => {
    if (!pollId) return undefined;
    let abgebrochen = false;
    setLaedt(true);
    void (async () => {
      try {
        const [geladen, auftritte] = await Promise.all([
          api.polls.byId(pollId),
          api.polls.placements(pollId).catch(() => null),
        ]);
        if (abgebrochen) return;
        setPoll(geladen);
        setOrte(auftritte?.conversationIds ?? []);
      } catch (error) {
        if (!abgebrochen) toast(error instanceof Error ? error.message : 'Abstimmung nicht ladbar');
      } finally {
        if (!abgebrochen) setLaedt(false);
      }
    })();
    return () => {
      abgebrochen = true;
    };
  }, [pollId]);

  const meineStimmen = useMemo(() => {
    const map = new Map<string, 'yes' | 'no' | 'maybe'>();
    for (const vote of poll?.votes ?? []) {
      if (vote.userId === myId) map.set(vote.optionId, vote.value);
    }
    return map;
  }, [poll, myId]);

  if (!pollId) return null;

  async function stimmen(optionId: string, wert: 'yes' | 'no' | 'maybe') {
    if (!pollId) return;
    setBusy(true);
    try {
      setPoll(await api.polls.vote(pollId, [{ optionId, value: wert }]));
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Antwort nicht gespeichert');
    } finally {
      setBusy(false);
    }
  }

  async function festlegen(optionId: string) {
    setBusy(true);
    try {
      onConfirmed(await api.calendar.confirm(event.id, { optionId }));
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Festlegen fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  }

  const chatNamen = orte
    .map((id) => conversations.find((chat) => chat.id === id)?.title ?? null)
    .filter((name): name is string => Boolean(name));

  return (
    <section className="card stack" aria-labelledby="cal-poll-title">
      <h2 id="cal-poll-title" className="cal-block-title">
        Zeitpunkt wird abgestimmt
      </h2>

      {laedt ? (
        <Spinner label="Abstimmung wird geladen …" />
      ) : !poll ? (
        <p className="cal-hint">Die Abstimmung ist nicht mehr verfügbar.</p>
      ) : (
        <>
          <ul className="cal-poll-list">
            {poll.options.map((option) => {
              const zahlen = poll.tally[option.id];
              const meine = meineStimmen.get(option.id);
              const start = option.startsAt ? new Date(option.startsAt) : null;
              return (
                <li key={option.id} className="cal-poll-option">
                  <div className="cal-poll-when">
                    <strong>{start ? formatFullDate(start) : option.label}</strong>
                    {start && <span className="cal-doc-meta">{formatTime(start)}</span>}
                  </div>
                  <div className="cal-poll-answers">
                    {ANTWORTEN.map((antwort) => (
                      <button
                        key={antwort.wert}
                        type="button"
                        className={`btn btn-sm ${meine === antwort.wert ? 'stk-chip-active' : ''}`}
                        disabled={busy}
                        aria-pressed={meine === antwort.wert}
                        onClick={() => void stimmen(option.id, antwort.wert)}
                      >
                        {antwort.symbol} {antwort.label}
                      </button>
                    ))}
                  </div>
                  <div className="cal-poll-counts">
                    <span title="Passt">✅ {zahlen?.yes ?? 0}</span>
                    <span title="Vielleicht">🤔 {zahlen?.maybe ?? 0}</span>
                    <span title="Passt nicht">❌ {zahlen?.no ?? 0}</span>
                    {canManage && (
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        disabled={busy}
                        onClick={() => void festlegen(option.id)}
                      >
                        Diesen nehmen
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

          {chatNamen.length > 1 && (
            <p className="cal-hint">
              Dieselbe Abstimmung läuft in: {chatNamen.join(', ')}. Ein Ergebnis für alle – wer
              dort antwortet, hat auch hier geantwortet.
            </p>
          )}
        </>
      )}
    </section>
  );
}
