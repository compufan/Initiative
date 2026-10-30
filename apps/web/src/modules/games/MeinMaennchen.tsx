import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  PRESSEN_FIGUR_SCHLUESSEL,
  figurLesen,
  standardFigur,
  type PressenFigurDaten,
} from '@initiative/shared';
import { useMyId, useSession } from '../../state/session.js';
import { BEREIT, PressenFigur } from './boards/PressenFigur.js';
import { PressenFigurEditor } from './boards/PressenFigurEditor.js';

/** Die gespeicherte Figur des eigenen Kontos – oder die Standardfigur. */
export function useMeineFigur(): PressenFigurDaten {
  const myId = useMyId();
  const gespeichert = useSession((s) => s.user?.settings?.modules?.[PRESSEN_FIGUR_SCHLUESSEL]);
  return figurLesen(gespeichert) ?? standardFigur(myId);
}

/**
 * „Mein Strichmännchen“ – unabhängig von jeder Partie.
 *
 * Die Figur gehört zum Konto (`settings.modules.pressenFigur`) und gilt für alle
 * Pressen-Läufe, gegen wen auch immer. Darum lässt sie sich hier ändern, in
 * der Spiele-Übersicht und in den Einstellungen – nicht erst im Brett einer
 * laufenden Partie. Das Blatt zeigt eine Vorschau, die sich beim Wählen
 * sofort ändert.
 *
 * `?figur=1` öffnet das Blatt gleich (der Verweis aus dem Brett).
 */
export function MeinMaennchen({ eingebettet = false }: { eingebettet?: boolean }) {
  const myId = useMyId();
  const figur = useMeineFigur();
  const [suche, setSuche] = useSearchParams();
  const [offen, setOffen] = useState(() => suche.get('figur') === '1');

  function schliessen() {
    setOffen(false);
    if (suche.has('figur')) {
      const rest = new URLSearchParams(suche);
      rest.delete('figur');
      setSuche(rest, { replace: true });
    }
  }

  return (
    <article
      className={eingebettet ? 'stack' : 'card game-card'}
      data-testid="mein-maennchen"
      aria-label="Mein Strichmännchen"
    >
      <span className="game-card-vorschau" aria-hidden="true">
        <PressenFigur
          ansicht={{ ...BEREIT, x: 500, y: 330 }}
          figur={figur}
          bewegt={false}
          titel="Vorschau deines Strichmännchens"
        />
      </span>
      <div className="game-card-facts">
        <h3 className="game-card-title">Mein Strichmännchen</h3>
        <p className="game-card-text">
          Frisur, Farben, Bart, Brille und Hut – so trittst du in jeder Pressen-Partie an, gegen wen
          auch immer.
        </p>
      </div>
      <button
        type="button"
        className="btn"
        onClick={() => setOffen(true)}
        data-testid="maennchen-anpassen"
      >
        🎨 Anpassen
      </button>
      <PressenFigurEditor open={offen} onClose={schliessen} start={figur} kennung={myId} />
    </article>
  );
}
