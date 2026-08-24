import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ConversationDto, GameSessionDto } from '@initiative/shared';
import { Avatar } from '../../components/Avatar.js';
import { EmptyState, Spinner } from '../../components/Feedback.js';
import { Sheet } from '../../components/Sheet.js';
import { api } from '../../lib/api.js';
import { useChat } from '../../state/chat.js';
import { useMyId } from '../../state/session.js';
import { toast } from '../../state/ui.js';
import { conversationLabel, errorMessage, useGameCatalog } from './helpers.js';

interface GameSetupProps {
  open: boolean;
  onClose: () => void;
  /** Preselected chat; with `lockConversation` it cannot be changed. */
  conversationId?: string | null;
  lockConversation?: boolean;
  /** Preselected game. */
  gameKey?: string | null;
  onCreated?: (session: GameSessionDto) => void;
}

function memberLabel(conversation: ConversationDto, userId: string): string {
  const member = conversation.members.find((item) => item.userId === userId);
  if (!member) return 'Mitglied';
  const nickname = member.nickname?.trim();
  return nickname && nickname.length > 0 ? nickname : member.user.displayName;
}

/**
 * Start a match: pick the game, the chat and – in groups – who plays.
 *
 * The server creates the session and announces it in the chat, so there is
 * nothing to send here afterwards.
 */
export function GameSetup({
  open,
  onClose,
  conversationId,
  lockConversation,
  gameKey,
  onCreated,
}: GameSetupProps) {
  const myId = useMyId();
  const { games, loading, failed } = useGameCatalog();
  const conversations = useChat((state) => state.conversations);

  const chats = useMemo(
    () => conversations.filter((item) => !item.archived && item.members.length > 1),
    [conversations],
  );

  const [chatId, setChatId] = useState<string>(conversationId ?? chats[0]?.id ?? '');
  const [selectedGame, setSelectedGame] = useState<string>(gameKey ?? '');
  const [opponents, setOpponents] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (conversationId) setChatId(conversationId);
    else if (!chatId && chats[0]) setChatId(chats[0].id);
  }, [conversationId, chats, chatId]);

  useEffect(() => {
    if (gameKey) setSelectedGame(gameKey);
    else if (!selectedGame && games[0]) setSelectedGame(games[0].key);
  }, [gameKey, games, selectedGame]);

  const chat = chats.find((item) => item.id === chatId) ?? null;
  const info = games.find((item) => item.key === selectedGame) ?? null;
  const candidates = useMemo(
    () => (chat ? chat.members.filter((member) => member.userId !== myId) : []),
    [chat, myId],
  );

  // Direct chats have exactly one opponent, groups start with nobody picked.
  // Only a different chat resets the selection – an incoming message must not.
  const pickedFor = useRef('');
  useEffect(() => {
    if (!chat || pickedFor.current === chat.id) return;
    pickedFor.current = chat.id;
    setOpponents(
      chat.type === 'direct'
        ? chat.members.filter((member) => member.userId !== myId).map((member) => member.userId)
        : [],
    );
  }, [chat, myId]);

  const maxOpponents = Math.max(1, (info?.maxPlayers ?? 2) - 1);
  const minOpponents = Math.max(1, (info?.minPlayers ?? 2) - 1);
  const ready = Boolean(chat && info) && opponents.length >= minOpponents;

  function toggleOpponent(userId: string) {
    setOpponents((current) => {
      if (current.includes(userId)) return current.filter((item) => item !== userId);
      if (current.length >= maxOpponents) {
        toast(
          maxOpponents === 1
            ? 'Dieses Spiel ist für zwei Personen'
            : `Höchstens ${maxOpponents} Mitspielende`,
          'info',
        );
        return current;
      }
      return [...current, userId];
    });
  }

  async function create() {
    if (!chat || !info || saving) return;
    if (opponents.length < minOpponents) {
      toast('Wähle mindestens eine Person aus', 'error');
      return;
    }
    setSaving(true);
    try {
      const session = await api.games.create({
        conversationId: chat.id,
        gameKey: info.key,
        opponentIds: opponents,
      });
      toast(`${info.name} gestartet`, 'success');
      onClose();
      onCreated?.(session);
    } catch (error) {
      toast(errorMessage(error, 'Spiel konnte nicht gestartet werden'), 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="Spiel starten">
      {loading && games.length === 0 && <Spinner label="Spiele werden geladen …" />}

      {failed && games.length > 0 && (
        <p className="game-note">
          Der Katalog konnte nicht geladen werden – du siehst die Spiele, die deine App kennt.
        </p>
      )}

      {games.length > 0 && (
        <div className="game-pick" role="radiogroup" aria-label="Spiel">
          {games.map((game) => (
            <button
              key={game.key}
              type="button"
              role="radio"
              aria-checked={game.key === selectedGame}
              className={`game-pick-tile${game.key === selectedGame ? ' is-active' : ''}`}
              onClick={() => setSelectedGame(game.key)}
            >
              <span className="game-pick-emoji" aria-hidden="true">
                {game.emoji}
              </span>
              <span className="game-pick-name">{game.name}</span>
              <span className="game-pick-players">
                {game.minPlayers === game.maxPlayers
                  ? `${game.minPlayers} Spielende`
                  : `${game.minPlayers}–${game.maxPlayers} Spielende`}
              </span>
            </button>
          ))}
        </div>
      )}

      {info && <p className="game-note">{info.description}</p>}

      {chats.length === 0 ? (
        <EmptyState
          emoji="💬"
          title="Noch kein Chat"
          description="Spiele laufen immer in einem Chat. Starte zuerst einen Chat mit jemandem."
          action={
            <Link className="btn btn-primary" to="/chats" onClick={onClose}>
              Zu den Chats
            </Link>
          }
        />
      ) : (
        <>
          {lockConversation && chat ? (
            <p className="game-note">
              Die Partie läuft in <strong>{conversationLabel(chat, myId)}</strong>.
            </p>
          ) : (
            <div className="field">
              <label htmlFor="game-chat">Chat</label>
              <select
                id="game-chat"
                className="select"
                value={chatId}
                onChange={(event) => setChatId(event.target.value)}
              >
                {chats.map((item) => (
                  <option key={item.id} value={item.id}>
                    {conversationLabel(item, myId)}
                  </option>
                ))}
              </select>
            </div>
          )}

          {chat && chat.type === 'direct' && candidates[0] && (
            <p className="game-note">
              Gegner: <strong>{memberLabel(chat, candidates[0].userId)}</strong>
            </p>
          )}

          {chat && chat.type === 'group' && (
            <div className="stack">
              <span className="game-label">
                Wer spielt mit?{' '}
                <span className="muted">
                  ({opponents.length}/{maxOpponents})
                </span>
              </span>
              <div className="list game-member-list">
                {candidates.map((member) => {
                  const checked = opponents.includes(member.userId);
                  return (
                    <button
                      key={member.userId}
                      type="button"
                      role="checkbox"
                      aria-checked={checked}
                      className="list-row game-member"
                      onClick={() => toggleOpponent(member.userId)}
                    >
                      <Avatar
                        name={memberLabel(chat, member.userId)}
                        id={member.userId}
                        url={member.user.avatarUrl}
                        size={36}
                      />
                      <span className="truncate" style={{ flex: 1 }}>
                        {memberLabel(chat, member.userId)}
                      </span>
                      <span className={`game-check${checked ? ' is-on' : ''}`} aria-hidden="true">
                        {checked ? '✓' : ''}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <button
            type="button"
            className="btn btn-primary btn-block"
            disabled={!ready || saving}
            onClick={() => void create()}
          >
            {saving ? 'Wird gestartet …' : 'Spiel starten'}
          </button>
        </>
      )}
    </Sheet>
  );
}
