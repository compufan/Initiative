import { useId } from 'react';
import {
  FELD_BREITE,
  GLAS_ML,
  MUND_HALB,
  MUND_KAPAZITAET_ML,
  MUND_X,
  type SimZustand,
} from '@initiative/shared';

/**
 * Was die Zeichnung vom Lauf braucht – ein Ausschnitt von `SimZustand`, damit
 * auch ein fremder Lauf (nur Ergebnis bekannt) gezeichnet werden kann.
 */
export type FigurAnsicht = Pick<
  SimZustand,
  'x' | 'neigung' | 'fuellung' | 'mund' | 'getrunken' | 'verschuettet' | 'fluss' | 'trifft'
> & {
  /** Glas steht auf dem Tisch. */
  abgestellt: boolean;
};

export function ansichtAus(z: SimZustand): FigurAnsicht {
  return {
    x: z.x,
    neigung: z.neigung,
    fuellung: z.fuellung,
    mund: z.mund,
    getrunken: z.getrunken,
    verschuettet: z.verschuettet,
    fluss: z.fluss,
    trifft: z.trifft,
    abgestellt: z.abgestelltTick != null,
  };
}

/** Ein wartendes Männchen: Glas am Startplatz, voll. */
export const BEREIT: FigurAnsicht = {
  x: 120,
  neigung: 0,
  fuellung: GLAS_ML,
  mund: 0,
  getrunken: 0,
  verschuettet: 0,
  fluss: 0,
  trifft: false,
  abgestellt: false,
};

/** Ein Männchen, dessen Lauf gerade woanders stattfindet. */
export const TRINKT: FigurAnsicht = {
  ...BEREIT,
  x: MUND_X,
  neigung: 55,
  fuellung: 150,
  fluss: 26,
  trifft: true,
  mund: 10,
};

/** Ein Männchen mit bekanntem Ergebnis: Glas leer abgestellt, Pfütze nach Menge. */
export function fertigAnsicht(verschuettetDezi: number): FigurAnsicht {
  const verschuettet = verschuettetDezi / 10;
  return {
    ...BEREIT,
    x: 780,
    fuellung: 0,
    getrunken: GLAS_ML - verschuettet,
    verschuettet,
    abgestellt: true,
  };
}

const BIER = '#e8a317';
const SCHAUM = '#fff3c4';
const STRICH = 'var(--text, #222)';
const BODEN_Y = 470;
const MUND_Y = 214;
const GLAS_Y = 130;
const GLAS_H = 150;

interface FigurProps {
  ansicht: FigurAnsicht;
  /** Spiegelbildlich zeichnen (das Männchen auf der anderen Seite). */
  gespiegelt?: boolean;
  /** Wackeln und Schlucken zeigen – bei reduzierter Bewegung aus. */
  bewegt: boolean;
  farbe: string;
  titel: string;
  /** Schmale Darstellung für fremde Bahnen. */
  klein?: boolean;
}

/**
 * Das Strichmännchen mit Glas und Strahl.
 *
 * Alles ist eigene Zeichnung. Das Glas dreht sich um seinen Rand – dort, wo
 * auch die Simulation den Strahl entspringen lässt –, der Pegel bleibt in der
 * Welt waagerecht (das Bier schwappt nicht mit).
 */
export function PressenFigur({ ansicht: a, gespiegelt, bewegt, farbe, titel, klein }: FigurProps) {
  const { x, neigung, fuellung, fluss, trifft, verschuettet, getrunken, mund } = a;
  const pegel = GLAS_H * (1 - fuellung / GLAS_ML);
  const strahlBreite = Math.min(14, 2 + fluss / 8);
  const strahlEnde = trifft ? MUND_Y : BODEN_Y;
  const pfuetze = Math.min(380, verschuettet * 1.6);
  const bauch = Math.min(1, getrunken / GLAS_ML);
  const mundVoll = mund / MUND_KAPAZITAET_ML;
  // Abgestellt steht das Glas aufrecht auf dem Boden rechts neben dem Männchen.
  const glasX = a.abgestellt ? 780 : x;
  const glasY = a.abgestellt ? BODEN_Y - GLAS_H : GLAS_Y;
  const klammer = `pf-glas-${useId().replace(/:/g, '')}`;

  return (
    <svg
      className={`pressen-figur${klein ? ' is-klein' : ''}${bewegt ? ' is-bewegt' : ''}`}
      viewBox={`0 0 ${FELD_BREITE} 500`}
      role="img"
      aria-label={titel}
      style={{ ['--seat' as string]: farbe }}
    >
      <g transform={gespiegelt ? `translate(${FELD_BREITE} 0) scale(-1 1)` : undefined}>
        <line x1="0" y1={BODEN_Y} x2={FELD_BREITE} y2={BODEN_Y} className="pf-boden" />
        {pfuetze > 1 && (
          <ellipse cx={MUND_X} cy={BODEN_Y + 2} rx={pfuetze} ry="9" fill={BIER} opacity="0.55" />
        )}

        {/* Strichmännchen: Kopf in den Nacken, Mund nach oben. */}
        <g stroke={STRICH} strokeWidth="9" strokeLinecap="round" fill="none">
          <line x1={MUND_X} y1="300" x2={MUND_X} y2="395" />
          <line x1={MUND_X} y1="395" x2={MUND_X - 45} y2={BODEN_Y - 6} />
          <line x1={MUND_X} y1="395" x2={MUND_X + 45} y2={BODEN_Y - 6} />
          <line x1={MUND_X} y1="320" x2={MUND_X - 60} y2="365" />
          <line x1={MUND_X} y1="320" x2={MUND_X + 60} y2="365" />
          <circle cx={MUND_X} cy="262" r="34" fill="var(--surface, #fff)" />
        </g>
        {/* Bauch füllt sich mit dem, was getrunken wurde. */}
        <circle
          cx={MUND_X}
          cy="350"
          r={8 + 22 * bauch}
          fill={BIER}
          opacity={0.25 + 0.6 * bauch}
          className="pf-bauch"
        />
        {/* Der offene Mund: so groß wie das, was gerade drinsteckt. */}
        <ellipse
          cx={MUND_X}
          cy={MUND_Y + 14}
          rx={MUND_HALB * 0.55}
          ry="9"
          fill="#7a2330"
          className={bewegt && mund > 0.5 ? 'pf-schluck' : undefined}
        />
        <ellipse
          cx={MUND_X}
          cy={MUND_Y + 14}
          rx={MUND_HALB * 0.55 * Math.min(1, mundVoll)}
          ry={9 * Math.min(1, mundVoll)}
          fill={BIER}
        />
        <circle cx={MUND_X - 12} cy="257" r="4" fill={STRICH} />
        <circle cx={MUND_X + 12} cy="257" r="4" fill={STRICH} />

        {/* Strahl */}
        {fluss > 0 && (
          <line
            x1={x}
            y1={GLAS_Y + 4}
            x2={x}
            y2={strahlEnde}
            stroke={BIER}
            strokeWidth={strahlBreite}
            strokeLinecap="round"
            opacity="0.9"
          />
        )}

        {/* Glas: dreht sich um den Rand (rechts oben). */}
        <g
          transform={`translate(${glasX} ${glasY}) rotate(${a.abgestellt ? 0 : neigung})`}
          className={a.abgestellt ? 'pf-glas is-abgestellt' : 'pf-glas'}
        >
          <defs>
            <clipPath id={klammer}>
              <path d={`M -70 0 L 0 0 L -8 ${GLAS_H} L -62 ${GLAS_H} Z`} />
            </clipPath>
          </defs>
          <g clipPath={`url(#${klammer})`}>
            {fuellung > 0 && (
              <>
                <rect
                  x="-300"
                  y={pegel}
                  width="600"
                  height="600"
                  fill={BIER}
                  transform={`rotate(${-(a.abgestellt ? 0 : neigung)} -35 ${pegel})`}
                />
                <rect
                  x="-300"
                  y={pegel - 12}
                  width="600"
                  height="12"
                  fill={SCHAUM}
                  transform={`rotate(${-(a.abgestellt ? 0 : neigung)} -35 ${pegel})`}
                />
              </>
            )}
          </g>
          <path
            d={`M -70 0 L 0 0 L -8 ${GLAS_H} L -62 ${GLAS_H} Z`}
            fill="none"
            stroke={STRICH}
            strokeWidth="6"
            strokeLinejoin="round"
          />
          <path
            d="M 0 40 q 36 10 30 40 q -4 22 -14 24"
            fill="none"
            stroke={STRICH}
            strokeWidth="6"
          />
        </g>
      </g>
    </svg>
  );
}
