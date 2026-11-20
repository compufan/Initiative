import { useMemo, useState } from 'react';
import { uuidv7 } from '@initiative/shared';
import { Sheet } from '../../components/Sheet.js';
import { Avatar } from '../../components/Avatar.js';
import { ApiError, api } from '../../lib/api.js';
import { useChat, type ChatMessage } from '../../state/chat.js';
import { useMyId } from '../../state/session.js';
import { toast } from '../../state/ui.js';
import { conversationAvatar, conversationTitle } from './helpers.js';

/**
 * Was sich weiterleiten lässt – dieselbe Liste wie im Server
 * (`services/messages/weiterleiten.rs`, `WEITERLEITBAR`).
 *
 * Umfragen, Termine und Spiele nicht: Ihre Karte ist nur eine Ansicht auf
 * etwas, das an IHREM Chat hängt (wer abstimmen, zusagen, mitspielen darf).
 * Eine Kopie wäre tot oder ein Loch – siehe dort.
 */
export const WEITERLEITBAR = new Set(['text', 'image', 'video', 'audio', 'file', 'sticker', 'rezept']);

export function weiterleitbar(message: ChatMessage): boolean {
  return (
    WEITERLEITBAR.has(message.type) &&
    !message.deletedAt &&
    !message.pending &&
    !message.failed &&
    !message.id.startsWith('local:')
  );
}

interface WeiterleitenSheetProps {
  nachrichten: ChatMessage[];
  onClose: () => void;
  /** Nach dem Weiterleiten, etwa um die Auswahl zu beenden. */
  onFertig?: () => void;
}

export function WeiterleitenSheet({ nachrichten, onClose, onFertig }: WeiterleitenSheetProps) {
  return (
    <Sheet open={nachrichten.length > 0} onClose={onClose} title="Weiterleiten an …">
      {nachrichten.length > 0 && (
        <Auswahl nachrichten={nachrichten} onClose={onClose} onFertig={onFertig} />
      )}
    </Sheet>
  );
}

const ZIELE_MAX = 20;

function Auswahl({ nachrichten, onClose, onFertig }: WeiterleitenSheetProps) {
  const myId = useMyId();
  const conversations = useChat((state) => state.conversations);
  const [suche, setSuche] = useState('');
  const [gewaehlt, setGewaehlt] = useState<string[]>([]);
  const [herkunft, setHerkunft] = useState(true);
  const [laeuft, setLaeuft] = useState(false);

  const moeglich = nachrichten.filter(weiterleitbar);
  const ausgelassen = nachrichten.length - moeglich.length;

  const liste = useMemo(() => {
    const nadel = suche.trim().toLocaleLowerCase('de');
    return conversations
      .filter((c) => !c.archived || gewaehlt.includes(c.id))
      .filter((c) => !nadel || conversationTitle(c, myId).toLocaleLowerCase('de').includes(nadel));
  }, [conversations, suche, myId, gewaehlt]);

  function umschalten(id: string) {
    setGewaehlt((bisher) =>
      bisher.includes(id)
        ? bisher.filter((x) => x !== id)
        : bisher.length >= ZIELE_MAX
          ? bisher
          : [...bisher, id],
    );
  }

  async function senden() {
    if (gewaehlt.length === 0 || moeglich.length === 0) return;
    setLaeuft(true);
    let geschafft = 0;
    try {
      // Der Reihe nach, damit die Reihenfolge im Ziel stimmt.
      for (const nachricht of moeglich) {
        const { items } = await api.messages.weiterleiten(nachricht.id, {
          conversationIds: gewaehlt,
          herkunft,
          clientId: uuidv7(),
        });
        for (const neu of items) useChat.getState().applyMessage(neu);
        geschafft += 1;
      }
      toast(
        moeglich.length === 1
          ? `Weitergeleitet an ${gewaehlt.length === 1 ? '1 Chat' : `${gewaehlt.length} Chats`}`
          : `${moeglich.length} Nachrichten weitergeleitet`,
        'success',
      );
      onFertig?.();
      onClose();
    } catch (error) {
      const text =
        error instanceof ApiError && error.isOffline
          ? 'Weiterleiten geht nur mit Verbindung.'
          : error instanceof Error && error.message
            ? error.message
            : 'Weiterleiten fehlgeschlagen';
      toast(geschafft > 0 ? `${geschafft} weitergeleitet, dann: ${text}` : text, 'error');
    } finally {
      setLaeuft(false);
    }
  }

  return (
    <div className="stack">
      {ausgelassen > 0 && (
        <p className="muted" role="note">
          {ausgelassen === nachrichten.length
            ? 'Umfragen, Termine, Spiele und Hinweise lassen sich nicht weiterleiten.'
            : `${ausgelassen} davon (Umfrage, Termin, Spiel oder Hinweis) wird nicht weitergeleitet.`}
        </p>
      )}
      <input
        type="search"
        className="input"
        placeholder="Chat suchen"
        aria-label="Chat suchen"
        value={suche}
        onChange={(event) => setSuche(event.target.value)}
      />
      <div className="list weiterleiten-liste" role="group" aria-label="Chats">
        {liste.map((c) => {
          const avatar = conversationAvatar(c, myId);
          const an = gewaehlt.includes(c.id);
          return (
            <label key={c.id} className={`list-row weiterleiten-ziel ${an ? 'is-gewaehlt' : ''}`}>
              <input
                type="checkbox"
                checked={an}
                onChange={() => umschalten(c.id)}
                aria-label={conversationTitle(c, myId)}
              />
              <Avatar name={avatar.name} id={avatar.id} url={avatar.url} size={36} />
              <span className="truncate">{conversationTitle(c, myId)}</span>
            </label>
          );
        })}
        {liste.length === 0 && <p className="muted">Kein Chat gefunden.</p>}
      </div>
      <label className="row weiterleiten-herkunft">
        <input
          type="checkbox"
          checked={herkunft}
          onChange={(event) => setHerkunft(event.target.checked)}
        />
        <span>
          Absender nennen
          <small className="msg-action-hint">
            {herkunft
              ? '„Weitergeleitet von …“ – mit dem Namen des ursprünglichen Absenders'
              : 'Nur „Weitergeleitet“, ohne Namen'}
          </small>
        </span>
      </label>
      <button
        type="button"
        className="btn btn-primary"
        disabled={laeuft || gewaehlt.length === 0 || moeglich.length === 0}
        onClick={() => void senden()}
      >
        {laeuft
          ? 'Wird weitergeleitet …'
          : gewaehlt.length === 0
            ? 'Chats auswählen'
            : `Weiterleiten an ${gewaehlt.length}`}
      </button>
    </div>
  );
}
