import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LIMITS, type UserDto } from '@initiative/shared';
import { PersonenWahl } from '../../components/PersonenWahl.js';
import { Sheet } from '../../components/Sheet.js';
import { api } from '../../lib/api.js';
import { useChat } from '../../state/chat.js';
import { useMyId } from '../../state/session.js';
import { toast } from '../../state/ui.js';
import { UserSearch } from './UserSearch.js';

type Mode = 'direct' | 'group';

/** Was das Schema erlaubt (packages/shared/src/schemas/conversation.ts). */
const GRUPPE_MAX = 200;

interface NewChatSheetProps {
  open: boolean;
  onClose: () => void;
}

/** Start a 1:1 chat or build a group in one place. */
export function NewChatSheet({ open, onClose }: NewChatSheetProps) {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>('direct');
  const conversations = useChat((state) => state.conversations);
  const myId = useMyId();
  const [picked, setPicked] = useState<string[]>([]);

  /**
   * Wen man schon kennt – aus den eigenen Unterhaltungen.
   *
   * „Dieselben Leute wie in der grossen Gruppe, aber ohne zwei“ war bisher
   * reine Tipparbeit, obwohl die App diese Leute längst kennt.
   */
  const bekannte = useMemo(() => {
    const gesammelt = new Map<string, { id: string; displayName: string }>();
    for (const chat of conversations) {
      for (const mitglied of chat.members) {
        if (mitglied.userId === myId) continue;
        gesammelt.set(mitglied.userId, {
          id: mitglied.userId,
          displayName: mitglied.user.displayName,
        });
      }
    }
    return [...gesammelt.values()].sort((a, b) => a.displayName.localeCompare(b.displayName, 'de'));
  }, [conversations, myId]);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setMode('direct');
      setPicked([]);
      setTitle('');
      setBusy(false);
    }
  }, [open]);

  async function open1to1(user: UserDto) {
    setBusy(true);
    try {
      const conversation = await api.conversations.create({ type: 'direct', memberIds: [user.id] });
      useChat.getState().upsertConversation(conversation);
      onClose();
      navigate(`/chats/${conversation.id}`);
    } catch {
      toast('Chat konnte nicht gestartet werden', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function createGroup() {
    if (picked.length === 0) return;
    if (picked.length > GRUPPE_MAX) {
      // Sonst kommt die Absage erst vom Server, nachdem man 200 Leute
      // ausgewählt hat und nicht mehr weiss, welche zu viel sind.
      toast(`Eine Gruppe fasst höchstens ${GRUPPE_MAX} Mitglieder`, 'error');
      return;
    }
    setBusy(true);
    try {
      const conversation = await api.conversations.create({
        type: 'group',
        memberIds: picked,
        title: title.trim() || undefined,
      });
      useChat.getState().upsertConversation(conversation);
      onClose();
      navigate(`/chats/${conversation.id}`);
    } catch {
      toast('Gruppe konnte nicht erstellt werden', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="Neuer Chat">
      <div className="msg-segment" role="tablist" aria-label="Chat-Art">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'direct'}
          className={mode === 'direct' ? 'active' : undefined}
          onClick={() => setMode('direct')}
        >
          Direkt
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'group'}
          className={mode === 'group' ? 'active' : undefined}
          onClick={() => setMode('group')}
        >
          Gruppe
        </button>
      </div>

      {mode === 'group' && (
        <div className="field">
          <label htmlFor="group-title">Gruppenname</label>
          <input
            id="group-title"
            className="input"
            maxLength={LIMITS.conversationTitleMax}
            placeholder="z. B. Wochenendtrip"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </div>
      )}

      {/* Direkt bleibt beim Suchen-und-Antippen: Dort ist genau EINER gemeint,
          der Chat entsteht mit dem Antippen, und eine Sammelauswahl wäre dort
          schlicht falsch. Erst die Gruppe ist eine Mehrfachauswahl. */}
      {mode === 'direct' ? (
        <UserSearch
          autoFocus
          placeholder="Wen möchtest du anschreiben?"
          onPick={(user) => void open1to1(user)}
        />
      ) : (
        <PersonenWahl
          label="Wer in die Gruppe soll"
          suchePlatzhalter="Mitglieder suchen"
          vorschlaege={bekannte}
          gewaehlt={picked}
          onChange={setPicked}
        />
      )}

      {mode === 'group' && (
        <button
          type="button"
          className="btn btn-primary btn-block"
          disabled={busy || picked.length === 0}
          onClick={() => void createGroup()}
        >
          Gruppe erstellen
        </button>
      )}
    </Sheet>
  );
}
