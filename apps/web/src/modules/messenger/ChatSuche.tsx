import { useEffect, useRef, useState } from 'react';
import type { ConversationDto, MessageDto, SuchArt } from '@initiative/shared';
import { api } from '../../lib/api.js';
import { useMyId } from '../../state/session.js';
import { memberName } from './helpers.js';
import { suchbegriffSetzen } from './suchbegriff.js';

const FILTER: { art: SuchArt | null; label: string }[] = [
  { art: null, label: 'Alle' },
  { art: 'medien', label: 'Medien' },
  { art: 'links', label: 'Links' },
  { art: 'dateien', label: 'Dateien' },
  { art: 'audio', label: 'Sprache' },
];

/**
 * Suche im Chat: Treffer hervorheben, mit ↑/↓ (oder Enter / Umschalt+Enter)
 * von Treffer zu Treffer springen – auch zu älteren, die erst nachgeladen
 * werden (`jumpTo` holt sie in einem Zug). Filter nach Art und Absender
 * fragen den Server; mit Filter darf der Suchbegriff fehlen.
 */
export function ChatSuche({
  conversationId,
  conversation,
  onSprung,
  onSchliessen,
}: {
  conversationId: string;
  conversation: ConversationDto | null;
  onSprung: (messageId: string) => Promise<void> | void;
  onSchliessen: () => void;
}) {
  const myId = useMyId();
  const [begriff, setBegriff] = useState('');
  const [art, setArt] = useState<SuchArt | null>(null);
  const [absender, setAbsender] = useState<string>('');
  const [treffer, setTreffer] = useState<MessageDto[]>([]);
  const [index, setIndex] = useState(0);
  const [laeuft, setLaeuft] = useState(false);
  const eingabe = useRef<HTMLInputElement>(null);

  useEffect(() => {
    eingabe.current?.focus();
  }, []);

  useEffect(() => {
    const sauber = begriff.trim();
    suchbegriffSetzen(conversationId, sauber.length >= 2 ? sauber : null);
    if (sauber.length < 2 && !art && !absender) {
      setTreffer([]);
      return undefined;
    }
    let aktiv = true;
    const wecker = window.setTimeout(() => {
      setLaeuft(true);
      api.messages
        .search(sauber.length >= 2 ? sauber : '', conversationId, {
          art: art ?? undefined,
          senderId: absender || undefined,
          limit: 50,
        })
        .then(({ items }) => {
          if (!aktiv) return;
          setTreffer(items);
          setIndex(0);
          if (items[0]) void onSprung(items[0].id);
        })
        .catch(() => aktiv && setTreffer([]))
        .finally(() => aktiv && setLaeuft(false));
    }, 300);
    return () => {
      aktiv = false;
      window.clearTimeout(wecker);
    };
    // `onSprung` ist stabil (useCallback ohne Abhängigkeiten).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [begriff, art, absender, conversationId]);

  function gehe(schritt: number) {
    if (treffer.length === 0) return;
    // Treffer kommen neueste zuerst: ↑ heisst älter, also weiter in der Liste.
    const neu = (index + schritt + treffer.length) % treffer.length;
    setIndex(neu);
    void onSprung(treffer[neu].id);
  }

  const status =
    treffer.length > 0
      ? `${index + 1} von ${treffer.length}`
      : laeuft
        ? 'Suche …'
        : begriff.trim().length >= 2 || art || absender
          ? 'Keine Treffer'
          : '';

  return (
    <div className="msg-suche" role="search" aria-label="Im Chat suchen">
      <div className="msg-suche-zeile">
        <input
          ref={eingabe}
          type="search"
          className="input"
          placeholder="Im Chat suchen"
          aria-label="Suchbegriff"
          value={begriff}
          onChange={(event) => setBegriff(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              gehe(event.shiftKey ? -1 : 1);
            } else if (event.key === 'Escape') {
              onSchliessen();
            }
          }}
        />
        <span className="msg-suche-stand faint" aria-live="polite">
          {status}
        </span>
        <button
          type="button"
          className="icon-btn"
          aria-label="Älterer Treffer"
          disabled={treffer.length === 0}
          onClick={() => gehe(1)}
        >
          ↑
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Neuerer Treffer"
          disabled={treffer.length === 0}
          onClick={() => gehe(-1)}
        >
          ↓
        </button>
        <button type="button" className="icon-btn" aria-label="Suche schliessen" onClick={onSchliessen}>
          ✕
        </button>
      </div>
      <div className="msg-suche-filter" role="group" aria-label="Filter">
        {FILTER.map((filter) => (
          <button
            key={filter.label}
            type="button"
            className={`chip ${art === filter.art ? 'is-aktiv' : ''}`}
            aria-pressed={art === filter.art}
            onClick={() => setArt(filter.art)}
          >
            {filter.label}
          </button>
        ))}
        {conversation && conversation.members.length >= 2 && (
          <select
            className="input msg-suche-absender"
            aria-label="Absender"
            value={absender}
            onChange={(event) => setAbsender(event.target.value)}
          >
            <option value="">Alle Absender</option>
            {conversation.members.map((member) => (
              <option key={member.userId} value={member.userId}>
                {member.userId === myId ? 'Ich' : memberName(member)}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}
