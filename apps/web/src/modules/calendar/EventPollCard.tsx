import { useEffect, useMemo, useState } from 'react';
import type { CalendarEventDto, ConversationDto, PollDto } from '@initiative/shared';
import { Spinner } from '../../components/Feedback.js';
import { api } from '../../lib/api.js';
import { realtime } from '../../lib/realtime.js';
import { useChat } from '../../state/chat.js';
import { useMyId } from '../../state/session.js';
import { toast } from '../../state/ui.js';
import { conversationLabel, formatFullDate, formatTime } from './helpers.js';

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

  /*
   * Mitbekommen, wenn woanders abgestimmt wird.
   *
   * Der ganze Sinn der gespiegelten Umfrage ist, dass eine Antwort im
   * Einzelchat auch am Termin steht. Ohne dieses Zuhoeren erschien sie erst
   * nach dem Neuladen – der Server schickt sie laengst an alle Beteiligten.
   */
  useEffect(() => {
    if (!pollId) return undefined;
    return realtime.on('poll.updated', (payload) => {
      if (payload.poll.id === pollId) setPoll(payload.poll);
    });
  }, [pollId]);

  /** Wo die Umfrage ueberall auftritt – nachtraeglich aenderbar. */
  async function auftrittUmschalten(conversationId: string, an: boolean) {
    if (!pollId) return;
    setBusy(true);
    try {
      if (an) {
        await api.polls.place(pollId, conversationId);
        setOrte((liste) => [...new Set([...liste, conversationId])]);
      } else {
        await api.polls.unplace(pollId, conversationId);
        setOrte((liste) => liste.filter((id) => id !== conversationId));
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Nicht geändert');
    } finally {
      setBusy(false);
    }
  }

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

  // Auch Direktchats nennen. Vorher wurde nur `title` genommen – und der ist
  // bei einem Direktchat leer, sodass genau die Chats aus der Aufzaehlung
  // fielen, um die es bei der Spiegelung geht.
  const chatNamen = orte.map((id) => chatName(conversations, id, myId));

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

          {chatNamen.length > 0 && (
            <p className="cal-hint">
              Dieselbe Abstimmung läuft in: {chatNamen.join(', ')}. Ein Ergebnis für alle – wer
              dort antwortet, hat auch hier geantwortet.
            </p>
          )}

          {/*
            Spiegeln liess sich bisher nur im Augenblick des Anlegens. Wer
            hinterher merkte, dass noch jemand gefragt werden muss, hatte keine
            Handhabe – obwohl der Server es kann und der Aufruf im Client
            fertig dalag, nur nirgends benutzt wurde.
          */}
          {canManage && (
            <details className="cal-mirror">
              <summary>Wo wird gefragt?</summary>
              <p className="cal-hint">
                Ein Ergebnis für alle. Eine Antwort in einem dieser Chats zählt überall.
              </p>
              {conversations.map((chat) => (
                <label key={chat.id} className="cal-check">
                  <input
                    type="checkbox"
                    disabled={busy || chat.id === event.conversationId}
                    checked={orte.includes(chat.id) || chat.id === event.conversationId}
                    onChange={(änderung) =>
                      void auftrittUmschalten(chat.id, änderung.target.checked)
                    }
                  />
                  <span className="truncate">
                    {chatName(conversations, chat.id, myId)}
                    {chat.id === event.conversationId && ' (Ursprung)'}
                  </span>
                </label>
              ))}
            </details>
          )}
        </>
      )}
    </section>
  );
}

/** Der Name eines Chats – bei Direktchats der des Gegenübers. */
function chatName(conversations: ConversationDto[], id: string, myId: string): string {
  return conversationLabel(
    conversations.find((chat) => chat.id === id),
    myId,
  ) ?? 'Chat';
}
