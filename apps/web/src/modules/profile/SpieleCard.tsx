import { MeinMaennchen } from '../games/MeinMaennchen.js';

/**
 * Spiele in den Einstellungen: das eigene Strichmännchen für Pressen.
 *
 * Es gehört zum Konto, nicht zu einer Partie – darum auch hier erreichbar, ohne
 * dass man einen Gegner oder eine laufende Runde braucht.
 */
export function SpieleCard() {
  return (
    <section className="card stack" aria-labelledby="prf-spiele-title">
      <h2 className="prf-block-title" id="prf-spiele-title">
        Spiele
      </h2>
      <MeinMaennchen eingebettet />
    </section>
  );
}
