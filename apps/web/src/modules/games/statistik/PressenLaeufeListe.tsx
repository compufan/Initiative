import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  PRESSEN_AUSGAENGE,
  type PressenFilter,
  type PressenLaufDto,
  type PressenSortierung,
} from '@initiative/shared';
import { EmptyState, Spinner } from '../../../components/Feedback.js';
import { Screen } from '../../../components/Screen.js';
import { ApiError, api } from '../../../lib/api.js';
import { errorMessage } from '../helpers.js';
import {
  ART_TEXT,
  AUSGANG_TEXT,
  MODUS_TEXT,
  datumZeit,
  milliliter,
  prozent,
  sekunden,
  zahl,
} from './pressenStatistik.js';

const SORTIERUNGEN: { wert: PressenSortierung; text: string }[] = [
  { wert: 'neu', text: 'Neueste zuerst' },
  { wert: 'alt', text: 'Älteste zuerst' },
  { wert: 'zeit', text: 'Schnellste Zeit' },
  { wert: 'wertung', text: 'Beste Wertung' },
  { wert: 'verschuettet', text: 'Am wenigsten verschüttet' },
];

const SEITE = 20;

function AusgangMarke({ ausgang }: { ausgang: string }) {
  return <span className={`stat-marke is-${ausgang}`}>{AUSGANG_TEXT[ausgang] ?? ausgang}</span>;
}

interface ListeProps {
  /** Zeitraum und Modus der Seite darüber gelten auch hier. */
  filter: PressenFilter;
}

/**
 * Alle vergangenen Läufe: filtern nach Ausgang, sortieren, seitenweise
 * nachladen (Cursor des Servers). Ein Lauf öffnet seine Einzelansicht.
 */
export function PressenLaeufeListe({ filter }: ListeProps) {
  const [ausgang, setAusgang] = useState<PressenFilter['ausgang'] | ''>('');
  const [sortierung, setSortierung] = useState<PressenSortierung>('neu');
  const [laeufe, setLaeufe] = useState<PressenLaufDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [zustand, setZustand] = useState<'laedt' | 'fehler' | 'bereit'>('laedt');
  const [fehler, setFehler] = useState('');
  const [versuch, setVersuch] = useState(0);
  const abbruch = useRef<AbortController | null>(null);

  const holen = useCallback(
    async (ab: string | null) => {
      abbruch.current?.abort();
      const eigener = new AbortController();
      abbruch.current = eigener;
      setZustand('laedt');
      try {
        const seite = await api.games.pressenLaeufe(
          {
            ...filter,
            ausgang: ausgang || undefined,
            sortierung,
            limit: SEITE,
            cursor: ab ?? undefined,
          },
          eigener.signal,
        );
        if (eigener.signal.aborted) return;
        setLaeufe((alt) => (ab ? [...alt, ...seite.items] : seite.items));
        setCursor(seite.nextCursor);
        setZustand('bereit');
      } catch (e) {
        if (eigener.signal.aborted) return;
        setFehler(errorMessage(e, 'Die Läufe kamen nicht an.'));
        setZustand('fehler');
      }
    },
    [filter, ausgang, sortierung],
  );

  // Eine andere Auswahl beginnt die Liste von vorn.
  useEffect(() => {
    void holen(null);
    return () => abbruch.current?.abort();
  }, [holen, versuch]);

  return (
    <section aria-labelledby="stat-laeufe-titel" className="stack" data-testid="stat-lauf-liste">
      <h2 id="stat-laeufe-titel" className="game-section-title">
        Alle Läufe
      </h2>
      <div className="stat-filter">
        <label className="stat-auswahl">
          <span>Ergebnis</span>
          <select
            className="select"
            value={ausgang ?? ''}
            onChange={(e) => setAusgang(e.target.value as PressenFilter['ausgang'] | '')}
            data-testid="stat-ausgang"
          >
            <option value="">Alle</option>
            {PRESSEN_AUSGAENGE.map((a) => (
              <option key={a} value={a}>
                {AUSGANG_TEXT[a]}
              </option>
            ))}
          </select>
        </label>
        <label className="stat-auswahl">
          <span>Sortierung</span>
          <select
            className="select"
            value={sortierung}
            onChange={(e) => setSortierung(e.target.value as PressenSortierung)}
            data-testid="stat-sortierung"
          >
            {SORTIERUNGEN.map((s) => (
              <option key={s.wert} value={s.wert}>
                {s.text}
              </option>
            ))}
          </select>
        </label>
      </div>

      {zustand === 'fehler' && (
        <div className="card stat-fehler" role="alert">
          <p>{fehler}</p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setVersuch((n) => n + 1)}
          >
            Noch einmal versuchen
          </button>
        </div>
      )}

      {zustand === 'laedt' && laeufe.length === 0 && <Spinner label="Läufe werden geladen …" />}

      {zustand === 'bereit' && laeufe.length === 0 && (
        <p className="game-note" data-testid="stat-laeufe-leer">
          Keine Läufe mit dieser Auswahl.
        </p>
      )}

      {laeufe.length > 0 && (
        <ul className="card stat-laeufe" aria-label="Vergangene Läufe">
          {laeufe.map((l) => (
            <li key={l.id}>
              <Link
                className="stat-lauf"
                to={`/spiele/pressen/statistik/${l.id}`}
                data-testid="stat-lauf"
              >
                <span className="stat-lauf-kopf">
                  <time dateTime={l.gespieltAm}>{datumZeit(l.gespieltAm)}</time>
                  <AusgangMarke ausgang={l.ausgang} />
                </span>
                <span className="stat-lauf-fakten">
                  <span>{MODUS_TEXT[l.modus]}</span>
                  <span>
                    <span className="muted">Zeit </span>
                    {sekunden(l.dauerMs)}
                  </span>
                  <span>
                    <span className="muted">Verschüttet </span>
                    {milliliter(l.verschuettetDezi)}
                  </span>
                  <span>
                    <span className="muted">Score </span>
                    <strong>{sekunden(l.wertungMs)}</strong>
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {cursor && (
        <button
          type="button"
          className="btn btn-block"
          disabled={zustand === 'laedt'}
          onClick={() => void holen(cursor)}
          data-testid="stat-mehr"
        >
          {zustand === 'laedt' ? 'Wird geladen …' : 'Mehr laden'}
        </button>
      )}
    </section>
  );
}

/** Einzelansicht eines Laufs: alles, was der Server dazu weiß. */
export function PressenLaufScreen() {
  const { laufId } = useParams<{ laufId: string }>();
  const [lauf, setLauf] = useState<PressenLaufDto | null>(null);
  const [zustand, setZustand] = useState<'laedt' | 'fehler' | 'fehlt' | 'bereit'>('laedt');
  const [fehler, setFehler] = useState('');
  const [versuch, setVersuch] = useState(0);

  useEffect(() => {
    if (!laufId) return undefined;
    const abbruch = new AbortController();
    setZustand('laedt');
    api.games
      .pressenLauf(laufId, abbruch.signal)
      .then((antwort) => {
        setLauf(antwort);
        setZustand('bereit');
      })
      .catch((e: unknown) => {
        if (abbruch.signal.aborted) return;
        if (e instanceof ApiError && e.status === 404) {
          setZustand('fehlt');
          return;
        }
        setFehler(errorMessage(e, 'Der Lauf kam nicht an.'));
        setZustand('fehler');
      });
    return () => abbruch.abort();
  }, [laufId, versuch]);

  return (
    <Screen title="Lauf" back="/spiele/pressen/statistik">
      <div className="stat-seite" data-testid="pressen-lauf">
        {zustand === 'laedt' && <Spinner label="Lauf wird geladen …" />}
        {zustand === 'fehler' && (
          <div className="card stat-fehler" role="alert">
            <p>{fehler}</p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setVersuch((n) => n + 1)}
            >
              Noch einmal versuchen
            </button>
          </div>
        )}
        {zustand === 'fehlt' && (
          <EmptyState
            emoji="🔍"
            title="Diesen Lauf gibt es nicht"
            description="Er gehört nicht zu deinem Konto oder wurde mit ihm gelöscht."
            action={
              <Link className="btn btn-primary" to="/spiele/pressen/statistik">
                Zur Statistik
              </Link>
            }
          />
        )}
        {zustand === 'bereit' && lauf && <LaufDetail lauf={lauf} />}
      </div>
    </Screen>
  );
}

function LaufDetail({ lauf }: { lauf: PressenLaufDto }) {
  const getrunken = 3000 - lauf.verschuettetDezi;
  const name = (p: { name: string | null }) => p.name ?? 'Gelöschtes Konto';
  const zeilen: [string, string][] = [
    ['Zeit', sekunden(lauf.dauerMs)],
    ['Verschüttet', milliliter(lauf.verschuettetDezi)],
    ['Score (Zeit plus Strafe)', sekunden(lauf.wertungMs)],
    ['Treffgenauigkeit', prozent(getrunken / 3000)],
    [
      'Reaktion nach „leer“',
      lauf.reaktionMs == null ? 'vorzeitig abgestellt' : `${zahl(lauf.reaktionMs)} ms`,
    ],
    ['Malus (Ermüdung)', `${zahl(lauf.malusMs)} ms`],
    ['Start', ART_TEXT[lauf.startArt] ?? lauf.startArt],
  ];
  if (lauf.versatzMs > 0) zeilen.push(['Davon Warten bis Anstoßen', sekunden(lauf.versatzMs)]);
  if (lauf.teamWertungMs != null && lauf.gegnerWertungMs != null) {
    zeilen.push(['Wertung deines Teams', sekunden(lauf.teamWertungMs)]);
    zeilen.push(['Wertung der Gegner', sekunden(lauf.gegnerWertungMs)]);
  }
  return (
    <article className="card stat-detail" aria-labelledby="stat-detail-titel">
      <h2 id="stat-detail-titel" className="stat-detail-titel">
        <time dateTime={lauf.gespieltAm}>{datumZeit(lauf.gespieltAm)}</time>
      </h2>
      <p className="stat-detail-kopf">
        <AusgangMarke ausgang={lauf.ausgang} /> {MODUS_TEXT[lauf.modus]} · Runde {lauf.runde}
        {lauf.getruemmert ? ' · 🏅 getrümmert' : ''}
        {lauf.vorzeitig ? ' · vorzeitig abgestellt' : ''}
      </p>
      <dl className="stat-detail-liste" data-testid="stat-detail">
        {zeilen.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
        <div>
          <dt>Gegner</dt>
          <dd>{lauf.gegner.length > 0 ? lauf.gegner.map(name).join(', ') : 'keine'}</dd>
        </div>
        {lauf.team.length > 0 && (
          <div>
            <dt>Team</dt>
            <dd>{lauf.team.map(name).join(', ')}</dd>
          </div>
        )}
      </dl>
      <Link className="btn" to="/spiele/pressen/statistik">
        Zurück zur Statistik
      </Link>
    </article>
  );
}
