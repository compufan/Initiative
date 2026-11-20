import { formatDuration } from '@initiative/shared';
import { useNavigate } from 'react-router-dom';
import { schliessen, springen, tempoWechseln, umschalten, useSpieler } from './spieler.js';

/**
 * Die Mini-Leiste des globalen Spielers – oben im App-Rahmen, über jedem
 * Bildschirm, solange eine Sprachnachricht geladen ist.
 *
 * Gerendert wird sie als Überlagerung des Moduls (`overlay`), steht aber per
 * `order: -1` als erstes Kind im Rahmen: oben, im Fluss, ohne etwas zu
 * verdecken – im Chat bliebe unten sonst kein Platz neben der Eingabe.
 */
export function MiniSpieler() {
  const navigate = useNavigate();
  const titel = useSpieler((zustand) => zustand.titel);
  const spielt = useSpieler((zustand) => zustand.spielt);
  const position = useSpieler((zustand) => zustand.position);
  const dauer = useSpieler((zustand) => zustand.dauer);
  const tempo = useSpieler((zustand) => zustand.tempo);
  if (!titel) return null;
  const anteil = dauer > 0 ? Math.min(1, position / dauer) : 0;

  return (
    <section className="mini-spieler" aria-label="Sprachnachricht">
      <button
        type="button"
        className="mini-spieler-knopf"
        aria-label={spielt ? 'Pause' : 'Weiter abspielen'}
        onClick={umschalten}
      >
        {spielt ? '⏸' : '▶'}
      </button>
      <button
        type="button"
        className="mini-spieler-text"
        aria-label={`Zur Sprachnachricht von ${titel.absender} in ${titel.chat}`}
        onClick={() => navigate(`/chats/${titel.conversationId}?m=${titel.messageId}`)}
      >
        <strong className="truncate">{titel.absender}</strong>
        <span className="truncate muted">
          {titel.chat} · {formatDuration(position * 1000)}
          {dauer > 0 ? ` / ${formatDuration(dauer * 1000)}` : ''}
        </span>
      </button>
      <button
        type="button"
        className="mini-spieler-knopf"
        aria-label="10 Sekunden zurück"
        onClick={() => springen(-10, true)}
      >
        ↺
      </button>
      <button
        type="button"
        className="mini-spieler-tempo"
        aria-label={`Geschwindigkeit ${tempo}-fach – wechseln`}
        onClick={tempoWechseln}
      >
        {tempo}×
      </button>
      <button
        type="button"
        className="mini-spieler-knopf"
        aria-label="Spieler schliessen"
        onClick={schliessen}
      >
        ✕
      </button>
      <span className="mini-spieler-fortschritt" aria-hidden="true">
        <span style={{ width: `${Math.round(anteil * 100)}%` }} />
      </span>
    </section>
  );
}
