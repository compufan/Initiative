import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { GameSessionDto } from '@initiative/shared';
import { EmptyState, Spinner } from '../../components/Feedback.js';
import { Screen } from '../../components/Screen.js';
import { useMyId } from '../../state/session.js';
import { GameSetup } from './GameSetup.js';
import { MiniBoard } from './GameBoard.js';
import { useGameSessions } from './useGameSession.js';
import {
  compareSessions,
  gameInfoFor,
  isFinished,
  nameFrom,
  playersLabel,
  statusInfo,
  useGameCatalog,
  useUserLookup,
} from './helpers.js';

const FINISHED_LIMIT = 6;

/** Overview: running matches, recent results and the catalog of games. */
export function GamesScreen() {
  const myId = useMyId();
  const navigate = useNavigate();
  const { games, loading, failed } = useGameCatalog();
  const { sessions, refreshing } = useGameSessions();
  const [setupOpen, setSetupOpen] = useState(false);
  const [preselected, setPreselected] = useState<string | null>(null);

  const playerIds = useMemo(
    () => [...new Set(sessions.flatMap((session) => session.players.map((p) => p.userId)))],
    [sessions],
  );
  const users = useUserLookup(playerIds);
  const nameOf = (userId: string) => (userId === myId ? 'Du' : nameFrom(users, userId));

  const { running, done } = useMemo(() => {
    const sorted = sessions.slice().sort(compareSessions(myId));
    return {
      running: sorted.filter((session) => !isFinished(session)),
      done: sorted.filter(isFinished).slice(0, FINISHED_LIMIT),
    };
  }, [sessions, myId]);

  function start(gameKey: string | null) {
    setPreselected(gameKey);
    setSetupOpen(true);
  }

  const renderRow = (session: GameSessionDto) => {
    const info = gameInfoFor(session.gameKey, games);
    const status = statusInfo(session, myId, nameOf);
    return (
      <Link key={session.id} className="list-row game-row" to={`/spiele/${session.id}`}>
        <span className="game-row-preview" aria-hidden="true">
          <MiniBoard session={session} />
        </span>
        <span className="game-row-facts">
          <span className="game-row-title truncate">
            <span aria-hidden="true">{info.emoji}</span> {info.name}
          </span>
          <span className="game-row-players truncate">{playersLabel(session, myId, nameOf)}</span>
        </span>
        <span className={`game-status game-status-${status.tone}`}>{status.text}</span>
      </Link>
    );
  };

  return (
    <Screen
      title="Spiele"
      actions={
        <button type="button" className="btn btn-sm btn-primary" onClick={() => start(null)}>
          Spiel starten
        </button>
      }
    >
      <section className="stack" aria-label="Laufende Partien">
        <h2 className="game-section-title">
          Laufende Partien {refreshing && <span className="muted">· wird aktualisiert …</span>}
        </h2>
        {running.length === 0 ? (
          <EmptyState
            emoji="🎮"
            title="Keine laufende Partie"
            description="Fordere jemanden aus einem Chat heraus – die Einladung landet direkt im Chatverlauf."
            action={
              <button type="button" className="btn btn-primary" onClick={() => start(null)}>
                Spiel starten
              </button>
            }
          />
        ) : (
          <div className="card game-list">{running.map(renderRow)}</div>
        )}
      </section>

      {done.length > 0 && (
        <section className="stack" aria-label="Beendete Partien">
          <h2 className="game-section-title">Zuletzt gespielt</h2>
          <div className="card game-list">{done.map(renderRow)}</div>
        </section>
      )}

      <section className="stack" aria-label="Spiele">
        <h2 className="game-section-title">Alle Spiele</h2>
        {loading && games.length === 0 && <Spinner label="Katalog wird geladen …" />}
        {failed && games.length > 0 && (
          <p className="game-note">
            Der Katalog kam nicht durch – du siehst die Spiele, die deine App kennt.
          </p>
        )}
        {games.length === 0 && !loading ? (
          <EmptyState
            emoji="🕹️"
            title="Keine Spiele verfügbar"
            description="Der Server hat gerade keinen Spielkatalog. Versuch es später noch einmal."
          />
        ) : (
          <div className="game-catalog">
            {games.map((game) => (
              <article key={game.key} className="card game-card">
                <span className="game-card-emoji" aria-hidden="true">
                  {game.emoji}
                </span>
                <div className="game-card-facts">
                  <h3 className="game-card-title">{game.name}</h3>
                  <p className="game-card-text">{game.description}</p>
                  <p className="game-card-meta">
                    {game.minPlayers === game.maxPlayers
                      ? `${game.minPlayers} Spielende`
                      : `${game.minPlayers}–${game.maxPlayers} Spielende`}
                  </p>
                </div>
                <button type="button" className="btn btn-primary" onClick={() => start(game.key)}>
                  Spielen
                </button>
              </article>
            ))}
          </div>
        )}
      </section>

      <p className="game-note faint">
        Die Spielregeln laufen auf dem Server – jeder Zug wird dort geprüft, damit alle dasselbe
        Spielfeld sehen. <Link to="/chats">Zu den Chats</Link>
      </p>

      <GameSetup
        open={setupOpen}
        onClose={() => setSetupOpen(false)}
        gameKey={preselected}
        onCreated={(session) => navigate(`/spiele/${session.id}`)}
      />
    </Screen>
  );
}
