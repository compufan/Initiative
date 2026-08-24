import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Avatar } from '../../components/Avatar.js';
import { EmptyState, Spinner } from '../../components/Feedback.js';
import { Screen } from '../../components/Screen.js';
import { Sheet } from '../../components/Sheet.js';
import { api } from '../../lib/api.js';
import { useChat } from '../../state/chat.js';
import { useMyId } from '../../state/session.js';
import { toast, useHideNav } from '../../state/ui.js';
import { GameBoard } from './GameBoard.js';
import { useLiveGameSession } from './useGameSession.js';
import {
  applyMoveLocally,
  conversationLabel,
  errorMessage,
  gameInfoFor,
  isFinished,
  mySeatIn,
  nameFrom,
  seatClass,
  statusInfo,
  useGameCatalog,
  useUserLookup,
} from './helpers.js';

/**
 * The full match: board, player bar and the actions around a game.
 *
 * Every move goes to the server with the version it was based on; the local
 * rules only paint the result ahead of time. `game.updated` keeps the screen in
 * sync while the opponent plays.
 */
export function GameScreen() {
  useHideNav();
  const params = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const myId = useMyId();
  const { games } = useGameCatalog();
  const sessionId = params.sessionId ?? '';

  const { session, loading, failed, offline, apply, predict, rollback, reload } =
    useLiveGameSession(sessionId || null);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const conversationId = session?.conversationId ?? null;
  const conversation = useChat(
    (state) => state.conversations.find((item) => item.id === conversationId) ?? null,
  );

  useEffect(() => {
    if (conversationId) void useChat.getState().ensureConversation(conversationId);
  }, [conversationId]);

  const playerIds = useMemo(
    () => (session ? session.players.map((player) => player.userId) : []),
    [session],
  );
  const users = useUserLookup(playerIds);
  const nameOf = (userId: string) => (userId === myId ? 'Du' : nameFrom(users, userId));

  async function submitMove(move: unknown) {
    if (!session || busy) return;
    const base = session;
    const local = applyMoveLocally(base, move, myId);
    if (!local.ok) {
      toast(local.error, 'error');
      return;
    }
    setBusy(true);
    predict(local.session, base.version);
    try {
      apply(await api.games.move(base.id, move, base.version));
    } catch (error) {
      rollback(base);
      toast(errorMessage(error, 'Zug konnte nicht gesendet werden'), 'error');
      void reload();
    } finally {
      setBusy(false);
    }
  }

  async function join() {
    if (!session || busy) return;
    setBusy(true);
    try {
      apply(await api.games.join(session.id));
      toast('Du bist dabei', 'success');
    } catch (error) {
      toast(errorMessage(error, 'Beitreten fehlgeschlagen'), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function abort() {
    if (!session || busy) return;
    setBusy(true);
    try {
      apply(await api.games.abort(session.id));
      setConfirmOpen(false);
      toast('Du hast aufgegeben', 'info');
    } catch (error) {
      toast(errorMessage(error, 'Aufgeben fehlgeschlagen'), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function rematch() {
    if (!session || busy) return;
    setBusy(true);
    try {
      const created = await api.games.create({
        conversationId: session.conversationId,
        gameKey: session.gameKey,
        opponentIds: session.players
          .map((player) => player.userId)
          .filter((userId) => userId !== myId),
      });
      navigate(`/spiele/${created.id}`, { replace: true });
    } catch (error) {
      toast(errorMessage(error, 'Revanche konnte nicht gestartet werden'), 'error');
    } finally {
      setBusy(false);
    }
  }

  // A deep link (push notification) has no history to go back to.
  const back = location.key === 'default' ? '/spiele' : true;

  if (!session) {
    return (
      <Screen title="Spiel" back="/spiele">
        {loading ? (
          <Spinner label="Spiel wird geladen" />
        ) : (
          <EmptyState
            emoji="🎮"
            title={offline ? 'Keine Verbindung' : 'Spiel nicht gefunden'}
            description={
              offline
                ? 'Die Partie liegt auf dem Server – sobald du wieder online bist, geht es weiter.'
                : failed
                  ? 'Die Partie konnte nicht geladen werden. Vielleicht gehörst du nicht zu diesem Chat.'
                  : 'Diese Partie gibt es nicht mehr.'
            }
            action={
              <Link className="btn btn-primary" to="/spiele">
                Zu den Spielen
              </Link>
            }
          />
        )}
      </Screen>
    );
  }

  const info = gameInfoFor(session.gameKey, games);
  const mySeat = mySeatIn(session, myId);
  const status = statusInfo(session, myId, nameOf);
  const players = session.players.slice().sort((a, b) => a.seat - b.seat);
  const finished = isFinished(session);
  const canJoin =
    session.status === 'open' && mySeat == null && session.players.length < info.maxPlayers;

  return (
    <Screen
      title={`${info.emoji} ${info.name}`}
      subtitle={conversation ? conversationLabel(conversation, myId) : 'Partie'}
      back={back}
      actions={
        <button
          type="button"
          className="icon-btn"
          aria-label="Spielstand neu laden"
          onClick={() => void reload()}
        >
          ⟳
        </button>
      }
    >
      <ul className="game-players" aria-label="Mitspielende">
        {players.map((player) => {
          const user = users[player.userId];
          const name = player.userId === myId ? 'Du' : nameFrom(users, player.userId);
          const turn = session.status === 'active' && session.turnUserId === player.userId;
          const won = session.winnerUserIds.includes(player.userId);
          return (
            <li
              key={player.userId}
              className={`game-player ${seatClass(player.seat)}${turn ? ' is-turn' : ''}`}
            >
              <Avatar name={name} id={player.userId} url={user?.avatarUrl ?? null} size={44} />
              <span className="game-player-name truncate">{name}</span>
              <span className="game-player-state">
                {won ? '👑 Sieg' : turn ? 'am Zug' : finished ? '–' : 'wartet'}
              </span>
            </li>
          );
        })}
        {players.length < info.minPlayers && (
          <li className="game-player game-player-empty">
            <span className="game-player-slot" aria-hidden="true">
              ＋
            </span>
            <span className="game-player-name truncate">Freier Platz</span>
            <span className="game-player-state">offen</span>
          </li>
        )}
      </ul>

      <GameBoard
        session={session}
        mySeat={mySeat}
        onMove={(move) => void submitMove(move)}
        busy={busy}
      />

      {busy && <Spinner label="Zug wird gesendet" />}

      {canJoin && (
        <button
          type="button"
          className="btn btn-primary btn-block"
          disabled={busy}
          onClick={() => void join()}
        >
          Mitspielen
        </button>
      )}

      {mySeat == null && !canJoin && !finished && (
        <p className="game-note">Du schaust bei dieser Partie zu.</p>
      )}

      <div className="game-actions">
        {finished ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void rematch()}
          >
            🔁 Revanche
          </button>
        ) : (
          mySeat != null && (
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={() => setConfirmOpen(true)}
            >
              🏳️ Aufgeben
            </button>
          )
        )}
        {session.conversationId && (
          <Link className="btn" to={`/chats/${session.conversationId}`}>
            💬 Zum Chat
          </Link>
        )}
      </div>

      <p className="game-note faint">
        {finished ? status.text : 'Züge prüft der Server – dein Gegenüber sieht sie sofort.'}
      </p>

      <Sheet
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        variant="modal"
        title="Aufgeben?"
      >
        <p className="muted">
          Die Partie endet sofort und{' '}
          {players.length > 1 ? 'dein Gegenüber gewinnt' : 'wird abgebrochen'}.
        </p>
        <div className="game-confirm-actions">
          <button type="button" className="btn" onClick={() => setConfirmOpen(false)}>
            Weiterspielen
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy}
            onClick={() => void abort()}
          >
            Aufgeben
          </button>
        </div>
      </Sheet>
    </Screen>
  );
}
