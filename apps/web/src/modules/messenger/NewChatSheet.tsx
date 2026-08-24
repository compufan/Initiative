import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LIMITS, type UserDto } from '@initiative/shared';
import { Avatar } from '../../components/Avatar.js';
import { Sheet } from '../../components/Sheet.js';
import { api } from '../../lib/api.js';
import { useChat } from '../../state/chat.js';
import { toast } from '../../state/ui.js';
import { UserSearch } from './UserSearch.js';

type Mode = 'direct' | 'group';

interface NewChatSheetProps {
  open: boolean;
  onClose: () => void;
}

/** Start a 1:1 chat or build a group in one place. */
export function NewChatSheet({ open, onClose }: NewChatSheetProps) {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>('direct');
  const [picked, setPicked] = useState<UserDto[]>([]);
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
    setBusy(true);
    try {
      const conversation = await api.conversations.create({
        type: 'group',
        memberIds: picked.map((user) => user.id),
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

  function togglePick(user: UserDto) {
    setPicked((current) =>
      current.some((item) => item.id === user.id)
        ? current.filter((item) => item.id !== user.id)
        : [...current, user],
    );
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

      {mode === 'group' && picked.length > 0 && (
        <div className="msg-chip-row">
          {picked.map((user) => (
            <button
              key={user.id}
              type="button"
              className="msg-chip"
              onClick={() => togglePick(user)}
              aria-label={`${user.displayName} entfernen`}
            >
              <Avatar name={user.displayName} id={user.id} url={user.avatarUrl} size={22} />
              <span className="truncate">{user.displayName}</span>
              <span aria-hidden="true">✕</span>
            </button>
          ))}
        </div>
      )}

      <UserSearch
        autoFocus
        placeholder={mode === 'direct' ? 'Wen möchtest du anschreiben?' : 'Mitglieder suchen'}
        selectedIds={picked.map((user) => user.id)}
        onPick={(user) => (mode === 'direct' ? void open1to1(user) : togglePick(user))}
      />

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
