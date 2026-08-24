import { useMemo } from 'react';
import { useChat } from '../../state/chat.js';
import { useMyId } from '../../state/session.js';
import { EventRow } from './EventRow.js';
import { conversationLabel, myRsvp, type Occurrence } from './helpers.js';

interface OccurrenceListProps {
  occurrences: Occurrence[];
  emptyText?: string;
}

/** Renders a day's events – used by the month grid and the agenda alike. */
export function OccurrenceList({ occurrences, emptyText }: OccurrenceListProps) {
  const myId = useMyId();
  const conversations = useChat((state) => state.conversations);

  const labels = useMemo(() => {
    const map: Record<string, string> = {};
    for (const conversation of conversations) {
      const label = conversationLabel(conversation, myId);
      if (label) map[conversation.id] = label;
    }
    return map;
  }, [conversations, myId]);

  if (occurrences.length === 0) {
    return emptyText ? <p className="cal-empty-line">{emptyText}</p> : null;
  }

  return (
    <div className="cal-list">
      {occurrences.map((occurrence) => (
        <EventRow
          key={occurrence.key}
          occurrence={occurrence}
          chatLabel={
            occurrence.event.conversationId
              ? (labels[occurrence.event.conversationId] ?? null)
              : null
          }
          rsvp={myRsvp(occurrence.event, myId)}
        />
      ))}
    </div>
  );
}
