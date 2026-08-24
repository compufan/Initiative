import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ConversationDto, UserDto } from '@initiative/shared';
import { Avatar } from '../../components/Avatar.js';
import { Sheet } from '../../components/Sheet.js';
import { api } from '../../lib/api.js';
import { useChat } from '../../state/chat.js';
import { useMyId } from '../../state/session.js';
import { toast } from '../../state/ui.js';
import { UserSearch } from './UserSearch.js';
import {
  canModerate,
  conversationAvatar,
  conversationTitle,
  formatLastSeen,
  memberCountLabel,
  memberName,
  roleLabel,
} from './helpers.js';

const MUTE_PRESETS: { label: string; hours: number | null }[] = [
  { label: '1 Stunde', hours: 1 },
  { label: '8 Stunden', hours: 8 },
  { label: '1 Woche', hours: 24 * 7 },
  { label: 'Aus', hours: null },
];

interface ChatInfoSheetProps {
  open: boolean;
  conversation: ConversationDto | null;
  onClose: () => void;
}

export function ChatInfoSheet({ open, conversation, onClose }: ChatInfoSheetProps) {
  const navigate = useNavigate();
  const myId = useMyId();
  const presence = useChat((state) => state.presence);
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<UserDto[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);

  useEffect(() => {
    if (!open) {
      setAdding(false);
      setPicked([]);
      setConfirmLeave(false);
    }
  }, [open]);

  if (!conversation) return null;

  const isGroup = conversation.type === 'group';
  const moderator = canModerate(conversation, myId);
  const avatar = conversationAvatar(conversation, myId);
  const muted = conversation.mutedUntil && new Date(conversation.mutedUntil).getTime() > Date.now();

  async function apply(patch: Record<string, unknown>, message: string, failure: string) {
    if (!conversation) return;
    setBusy(true);
    try {
      const updated = await api.conversations.update(conversation.id, patch);
      useChat.getState().upsertConversation(updated);
      toast(message, 'success');
    } catch {
      toast(failure, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function addMembers() {
    if (!conversation || picked.length === 0) return;
    setBusy(true);
    try {
      const updated = await api.conversations.addMembers(
        conversation.id,
        picked.map((user) => user.id),
      );
      useChat.getState().upsertConversation(updated);
      setPicked([]);
      setAdding(false);
      toast('Mitglieder hinzugefügt', 'success');
    } catch {
      toast('Mitglieder konnten nicht hinzugefügt werden', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function leave() {
    if (!conversation) return;
    setBusy(true);
    try {
      await api.conversations.removeMember(conversation.id, myId);
      useChat.getState().removeConversation(conversation.id);
      onClose();
      navigate('/chats', { replace: true });
    } catch {
      toast('Chat konnte nicht verlassen werden', 'error');
    } finally {
      setBusy(false);
    }
  }

  if (adding) {
    return (
      <Sheet open={open} onClose={onClose} title="Mitglieder hinzufügen">
        <div className="stack">
          <UserSearch
            autoFocus
            excludeIds={conversation.members.map((member) => member.userId)}
            selectedIds={picked.map((user) => user.id)}
            onPick={(user) =>
              setPicked((current) =>
                current.some((item) => item.id === user.id)
                  ? current.filter((item) => item.id !== user.id)
                  : [...current, user],
              )
            }
          />
          <div className="row" style={{ gap: 'var(--space-2)' }}>
            <button type="button" className="btn btn-ghost" onClick={() => setAdding(false)}>
              Zurück
            </button>
            <button
              type="button"
              className="btn btn-primary"
              style={{ flex: 1 }}
              disabled={busy || picked.length === 0}
              onClick={() => void addMembers()}
            >
              {picked.length > 0 ? `${picked.length} hinzufügen` : 'Hinzufügen'}
            </button>
          </div>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet open={open} onClose={onClose} title="Chat-Info">
      <div className="msg-info-head">
        <Avatar name={avatar.name} id={avatar.id} url={avatar.url} size={64} />
        <div style={{ minWidth: 0 }}>
          <strong className="truncate" style={{ display: 'block' }}>
            {conversationTitle(conversation, myId)}
          </strong>
          <span className="muted" style={{ fontSize: '0.85rem' }}>
            {isGroup ? memberCountLabel(conversation) : 'Direktchat'}
          </span>
        </div>
      </div>

      <section className="stack">
        <span className="msg-info-label">Stummschalten</span>
        <div className="msg-chip-row">
          {MUTE_PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              className={`btn btn-sm ${preset.hours == null && !muted ? 'btn-primary' : ''}`}
              disabled={busy}
              onClick={() =>
                void apply(
                  {
                    mutedUntil:
                      preset.hours == null
                        ? null
                        : new Date(Date.now() + preset.hours * 3_600_000).toISOString(),
                  },
                  preset.hours == null ? 'Benachrichtigungen wieder an' : 'Chat stummgeschaltet',
                  'Stummschalten fehlgeschlagen',
                )
              }
            >
              {preset.label}
            </button>
          ))}
        </div>
        {muted && (
          <span className="muted" style={{ fontSize: '0.82rem' }}>
            Stumm bis {new Date(conversation.mutedUntil ?? '').toLocaleString('de-DE')}
          </span>
        )}
      </section>

      <section className="stack">
        <span className="msg-info-label">
          {isGroup ? memberCountLabel(conversation) : 'Mitglieder'}
        </span>
        <div className="list msg-picker-list">
          {conversation.members.map((member) => {
            const online = presence[member.userId]?.online ?? false;
            const lastSeen = presence[member.userId]?.lastSeenAt ?? member.user.lastSeenAt;
            return (
              <div key={member.userId} className="list-row">
                <Avatar
                  name={memberName(member)}
                  id={member.userId}
                  url={member.user.avatarUrl}
                  size={40}
                  online={online}
                />
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span className="truncate" style={{ display: 'block', fontWeight: 600 }}>
                    {memberName(member)}
                    {member.userId === myId ? ' (du)' : ''}
                  </span>
                  <span className="muted truncate" style={{ display: 'block', fontSize: '0.8rem' }}>
                    {online ? 'online' : formatLastSeen(lastSeen)}
                  </span>
                </span>
                <span className="badge">{roleLabel(member.role)}</span>
              </div>
            );
          })}
        </div>
        {isGroup && moderator && (
          <button type="button" className="btn btn-block" onClick={() => setAdding(true)}>
            ＋ Mitglieder hinzufügen
          </button>
        )}
      </section>

      <section className="stack">
        <button
          type="button"
          className="btn btn-block"
          disabled={busy}
          onClick={() =>
            void apply(
              { archived: !conversation.archived },
              conversation.archived ? 'Chat wiederhergestellt' : 'Chat archiviert',
              'Archivieren fehlgeschlagen',
            )
          }
        >
          {conversation.archived ? '📥 Aus dem Archiv holen' : '🗄️ Chat archivieren'}
        </button>
        <button
          type="button"
          className="btn btn-danger btn-block"
          disabled={busy}
          onClick={() => (confirmLeave ? void leave() : setConfirmLeave(true))}
        >
          {confirmLeave ? 'Wirklich verlassen?' : 'Chat verlassen'}
        </button>
      </section>
    </Sheet>
  );
}
