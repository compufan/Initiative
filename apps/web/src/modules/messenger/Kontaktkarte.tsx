import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ConversationDto, UserDto } from '@initiative/shared';
import { Avatar } from '../../components/Avatar.js';
import { Sheet } from '../../components/Sheet.js';
import { api } from '../../lib/api.js';
import { useChat } from '../../state/chat.js';
import { useMyId } from '../../state/session.js';
import { toast } from '../../state/ui.js';
import type { ComposerActionProps, MessageRendererProps } from '../types.js';
import { conversationTitle } from './helpers.js';
import { darfModerieren } from './gruppenRechte.js';

/**
 * Meine Kontakte: alle, mit denen ich einen Chat teile – so definiert die App
 * „Kontakt“ auch für die Privatsphäre. Ein eigenes Adressbuch gibt es nicht.
 */
export function kontakteAus(conversations: ConversationDto[], ich: string): UserDto[] {
  const nachId = new Map<string, UserDto>();
  for (const chat of conversations) {
    for (const member of chat.members) {
      if (member.userId !== ich && !nachId.has(member.userId)) nachId.set(member.userId, member.user);
    }
  }
  return [...nachId.values()].sort((a, b) => a.displayName.localeCompare(b.displayName, 'de'));
}

/** Kontakt teilen: eine Person aus meinen Kontakten als Karte senden. */
export function KontaktTeilenAktion({ conversationId, onClose }: ComposerActionProps) {
  const ich = useMyId();
  const conversations = useChat((state) => state.conversations);
  const kontakte = useMemo(() => kontakteAus(conversations, ich), [conversations, ich]);
  const [suche, setSuche] = useState('');
  const gefiltert = kontakte.filter((k) => {
    const nadel = suche.trim().toLocaleLowerCase('de');
    return (
      !nadel ||
      k.displayName.toLocaleLowerCase('de').includes(nadel) ||
      k.username.toLocaleLowerCase('de').includes(nadel)
    );
  });

  async function teilen(person: UserDto) {
    onClose();
    try {
      await useChat.getState().sendMessage(conversationId, {
        type: 'contact',
        metadata: { kontakt: { userId: person.id } },
      });
    } catch {
      toast('Kontakt konnte nicht geteilt werden', 'error');
    }
  }

  return (
    <Sheet open onClose={onClose} title="Kontakt teilen">
      <div className="stack">
        <div className="field">
          <label htmlFor="kontakt-suche">Suchen</label>
          <input
            id="kontakt-suche"
            className="input"
            type="search"
            value={suche}
            autoFocus
            onChange={(event) => setSuche(event.target.value)}
          />
        </div>
        {gefiltert.length === 0 ? (
          <p className="msg-action-hint">Keine Kontakte gefunden.</p>
        ) : (
          <div className="list msg-kontakt-liste">
            {gefiltert.map((person) => (
              <button
                key={person.id}
                type="button"
                className="list-row"
                onClick={() => void teilen(person)}
              >
                <Avatar name={person.displayName} id={person.id} url={person.avatarUrl} size={36} />
                <span>
                  {person.displayName}
                  <small className="msg-action-hint">@{person.username}</small>
                </span>
              </button>
            ))}
          </div>
        )}
        <p className="msg-action-hint">
          Geteilt werden Name und Profilbild – so, wie die Empfänger sie ohnehin sehen dürften.
        </p>
      </div>
    </Sheet>
  );
}

/** Die Karte im Chat: Name, Bild, „Nachricht schreiben“, „Zu Gruppe hinzufügen“. */
export function KontaktBubble({ message, isMine }: MessageRendererProps) {
  const navigate = useNavigate();
  const ich = useMyId();
  const profil = message.metadata?.kontaktProfil;
  const [gruppenWahl, setGruppenWahl] = useState(false);
  const conversations = useChat((state) => state.conversations);
  const tone = isMine ? 'msg-bubble-mine' : 'msg-bubble-theirs';

  if (message.deletedAt) {
    return (
      <div className={`msg-bubble ${tone} msg-bubble-deleted`}>
        <em>Diese Nachricht wurde gelöscht</em>
      </div>
    );
  }
  if (!profil) {
    return (
      <div className={`msg-bubble ${tone} msg-kontakt`}>
        <span aria-hidden="true">👤</span> <em>Kontakt nicht verfügbar</em>
      </div>
    );
  }
  const gruppen = conversations.filter(
    (c) => c.type === 'group' && darfModerieren(c, ich) && !c.members.some((m) => m.userId === profil.id),
  );

  async function schreiben() {
    if (!profil) return;
    try {
      const chat = await api.conversations.create({ type: 'direct', memberIds: [profil.id] });
      useChat.getState().upsertConversation(chat);
      navigate(`/chats/${chat.id}`);
    } catch (fehler) {
      toast(fehler instanceof Error ? fehler.message : 'Chat konnte nicht gestartet werden', 'error');
    }
  }

  async function hinzufuegen(gruppe: ConversationDto) {
    if (!profil) return;
    setGruppenWahl(false);
    try {
      const neu = await api.conversations.addMembers(gruppe.id, [profil.id]);
      useChat.getState().upsertConversation(neu);
      toast(`${profil.displayName} ist jetzt in „${conversationTitle(neu, ich)}“`, 'success');
    } catch (fehler) {
      toast(fehler instanceof Error ? fehler.message : 'Hinzufügen hat nicht geklappt', 'error');
    }
  }

  return (
    <div className={`msg-bubble ${tone} msg-kontakt`}>
      <div className="msg-kontakt-kopf">
        <Avatar name={profil.displayName} id={profil.id} url={profil.avatarUrl} size={44} />
        <span>
          <strong>{profil.displayName}</strong>
          <small>@{profil.username}</small>
        </span>
      </div>
      {profil.id !== ich && (
        <div className="msg-kontakt-knoepfe">
          <button type="button" className="btn btn-sm" onClick={() => void schreiben()}>
            Nachricht schreiben
          </button>
          {gruppen.length > 0 && (
            <button type="button" className="btn btn-sm" onClick={() => setGruppenWahl(true)}>
              Zu Gruppe hinzufügen
            </button>
          )}
        </div>
      )}
      <Sheet open={gruppenWahl} onClose={() => setGruppenWahl(false)} title="Zu Gruppe hinzufügen">
        <div className="list">
          {gruppen.map((gruppe) => (
            <button key={gruppe.id} type="button" className="list-row" onClick={() => void hinzufuegen(gruppe)}>
              <span aria-hidden="true">👥</span>
              <span>{conversationTitle(gruppe, ich)}</span>
            </button>
          ))}
        </div>
      </Sheet>
    </div>
  );
}
