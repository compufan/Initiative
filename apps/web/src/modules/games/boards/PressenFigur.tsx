import { useId } from 'react';
import {
  FELD_BREITE,
  FELD_TIEFE,
  GLAS_ML,
  GLAS_START_X,
  GLAS_START_Y,
  MUND_HALB_X,
  MUND_HALB_Y,
  MUND_KAPAZITAET_ML,
  MUND_X,
  MUND_Y,
  type PressenFigurDaten,
  type SimZustand,
} from '@initiative/shared';

/**
 * Was die Zeichnung vom Lauf braucht – ein Ausschnitt von `SimZustand`, damit
 * auch ein fremder Lauf (nur „fertig“ bekannt) gezeichnet werden kann.
 */
export type FigurAnsicht = Pick<
  SimZustand,
  | 'x'
  | 'y'
  | 'neigung'
  | 'fuellung'
  | 'mund'
  | 'getrunken'
  | 'verschuettet'
  | 'fluss'
  | 'trifft'
  | 'landeX'
  | 'landeY'
> & {
  /** Glas steht auf dem Tisch. */
  abgestellt: boolean;
};

export function ansichtAus(z: SimZustand): FigurAnsicht {
  return {
    x: z.x,
    y: z.y,
    neigung: z.neigung,
    fuellung: z.fuellung,
    mund: z.mund,
    getrunken: z.getrunken,
    verschuettet: z.verschuettet,
    fluss: z.fluss,
    trifft: z.trifft,
    landeX: z.landeX,
    landeY: z.landeY,
    abgestellt: z.abgestelltTick != null,
  };
}

/** Ein wartendes Männchen: Glas am Startplatz, voll. */
export const BEREIT: FigurAnsicht = {
  x: GLAS_START_X,
  y: GLAS_START_Y,
  neigung: 0,
  fuellung: GLAS_ML,
  mund: 0,
  getrunken: 0,
  verschuettet: 0,
  fluss: 0,
  trifft: false,
  landeX: GLAS_START_X,
  landeY: GLAS_START_Y,
  abgestellt: false,
};

/** Ein Männchen, dessen Lauf gerade woanders stattfindet: Glas am Mund. */
export const TRINKT: FigurAnsicht = {
  ...BEREIT,
  x: MUND_X,
  y: MUND_Y + 95,
  neigung: 55,
  fuellung: 150,
  fluss: 26,
  trifft: true,
  mund: 10,
  landeX: MUND_X,
  landeY: MUND_Y,
};

/** Ein Männchen, dessen Lauf fertig ist: Glas leer abgestellt. Mehr verrät die Sicht nicht. */
export function fertigAnsicht(verschuettetDezi: number | null): FigurAnsicht {
  const verschuettet = verschuettetDezi == null ? 0 : verschuettetDezi / 10;
  return {
    ...BEREIT,
    fuellung: 0,
    getrunken: GLAS_ML - verschuettet,
    verschuettet,
    abgestellt: true,
  };
}

export type Stimmung = 'normal' | 'schreck' | 'freude' | 'sieg' | 'verloren';

/* ---------- Farben und Auswahl (Nummern aus pressen-figur.ts) ---------- */

export const HAUT_FARBEN = [
  '#ffe0c7',
  '#f5cba7',
  '#e8b48a',
  '#d19a6e',
  '#a9744f',
  '#7a4b2c',
  '#5a3520',
] as const;
export const HAAR_FARBEN = [
  '#2b1d12',
  '#4a2f1a',
  '#7a4a24',
  '#b0763a',
  '#d9a441',
  '#e8d08a',
  '#8c8c8c',
  '#e6e6e6',
  '#b3341f',
  '#3a6fb0',
] as const;
export const SHIRT_FARBEN = [
  '#e04b4b',
  '#e8833a',
  '#e8c63a',
  '#6cc04a',
  '#2fa36b',
  '#35a7c9',
  '#3a6fd8',
  '#6a4bd8',
  '#b04bd8',
  '#e04b9a',
  '#555b66',
  '#f2f2f2',
] as const;
export const FRISUR_NAMEN = [
  'Glatze',
  'Kurz',
  'Seitenscheitel',
  'Irokese',
  'Pferdeschwanz',
  'Dutt',
  'Locken',
  'Pilz',
  'Lang',
  'Afro',
  'Stoppeln',
  'Zöpfe',
] as const;
export const BART_NAMEN = ['Kein Bart', 'Stoppeln', 'Schnurrbart', 'Vollbart', 'Kinnbart'] as const;
export const BRILLE_NAMEN = ['Keine Brille', 'Rund', 'Eckig', 'Sonnenbrille'] as const;
export const HUT_NAMEN = ['Kein Hut', 'Mütze', 'Kappe', 'Zylinder', 'Partyhut'] as const;

const BIER = '#e8a317';
const SCHAUM = '#fff3c4';
const STRICH = '#2a2230';
const MUND_INNEN = '#7a2330';

const KOPF_X = 500;
const KOPF_Y = 168;
const KOPF_R = 104;

function pick<T>(liste: readonly T[], i: number): T {
  return liste[Math.max(0, Math.min(liste.length - 1, i))]!;
}

/* ---------- Haare, Bart, Brille, Hut ---------- */

/** Haare hinter dem Kopf (lange Frisuren, Dutt, Afro) – vor dem Kopf kommt der Ansatz. */
function HaareHinten({ frisur, farbe }: { frisur: number; farbe: string }) {
  switch (frisur) {
    case 8: // lang
      return <path d="M 392 150 Q 380 300 420 330 L 580 330 Q 620 300 608 150 Z" fill={farbe} />;
    case 9: // Afro
      return <circle cx={KOPF_X} cy={KOPF_Y - 22} r={KOPF_R + 36} fill={farbe} />;
    case 4: // Pferdeschwanz: hängt nach hinten, im Bild nach oben
      return (
        <path
          d="M 500 66 Q 560 10 610 40 Q 640 90 590 98 Q 600 60 560 50 Q 530 60 520 90 Z"
          fill={farbe}
        />
      );
    case 5: // Dutt
      return <circle cx={KOPF_X} cy={46} r={34} fill={farbe} />;
    case 11: // Zöpfe
      return (
        <g fill={farbe}>
          <ellipse cx="392" cy="205" rx="17" ry="46" />
          <ellipse cx="608" cy="205" rx="17" ry="46" />
        </g>
      );
    default:
      return null;
  }
}

function HaareVorn({ frisur, farbe }: { frisur: number; farbe: string }) {
  const kappe = (d: string) => <path d={d} fill={farbe} />;
  switch (frisur) {
    case 1: // kurz
      return kappe(
        'M 398 138 Q 400 70 500 62 Q 600 70 602 138 Q 560 104 500 108 Q 440 104 398 138 Z',
      );
    case 2: // Seitenscheitel
      return kappe(
        'M 396 142 Q 396 66 500 60 Q 606 68 604 142 Q 590 100 540 96 Q 470 90 430 132 Z',
      );
    case 3: // Irokese
      return kappe('M 478 66 L 482 22 L 500 40 L 518 18 L 522 66 Q 500 84 478 66 Z');
    case 4: // Pferdeschwanz-Ansatz
    case 5:
      return kappe(
        'M 400 136 Q 404 72 500 64 Q 596 72 600 136 Q 560 106 500 110 Q 440 106 400 136 Z',
      );
    case 6: // Locken
      return (
        <g fill={farbe}>
          {[404, 436, 468, 500, 532, 564, 596].map((cx, i) => (
            <circle key={cx} cx={cx} cy={i % 2 ? 96 : 88} r="26" />
          ))}
        </g>
      );
    case 7: // Pilz
      return kappe(
        'M 396 150 Q 392 64 500 60 Q 608 64 604 150 Q 590 112 500 108 Q 410 112 396 150 Z',
      );
    case 8: // lang: Ansatz vorn
      return kappe(
        'M 396 150 Q 398 66 500 62 Q 602 66 604 150 Q 580 100 500 100 Q 420 100 396 150 Z',
      );
    case 9: // Afro: Ansatz
      return kappe(
        'M 402 128 Q 420 84 500 80 Q 580 84 598 128 Q 560 104 500 104 Q 440 104 402 128 Z',
      );
    case 10: // Stoppeln: dünner Schatten
      return (
        <path
          d="M 400 134 Q 404 72 500 66 Q 596 72 600 134 Q 560 100 500 104 Q 440 100 400 134 Z"
          fill={farbe}
          opacity="0.55"
        />
      );
    case 11:
      return kappe(
        'M 398 138 Q 400 70 500 62 Q 600 70 602 138 Q 560 104 500 108 Q 440 104 398 138 Z',
      );
    default:
      return null;
  }
}

function BartZeichnung({ bart, farbe }: { bart: number; farbe: string }) {
  switch (bart) {
    case 1: // Stoppeln
      return (
        <path
          d="M 410 196 Q 414 290 500 296 Q 586 290 590 196 Q 560 250 500 252 Q 440 250 410 196 Z"
          fill={farbe}
          opacity="0.4"
        />
      );
    case 2: // Schnurrbart
      return (
        <path
          d="M 440 176 Q 470 160 500 172 Q 530 160 560 176 Q 540 192 500 184 Q 460 192 440 176 Z"
          fill={farbe}
        />
      );
    case 3: // Vollbart
      return (
        <path
          d="M 402 180 Q 400 300 500 312 Q 600 300 598 180 Q 590 240 500 254 Q 410 240 402 180 Z"
          fill={farbe}
        />
      );
    case 4: // Kinnbart
      return (
        <path d="M 462 262 Q 500 252 538 262 Q 530 300 500 306 Q 470 300 462 262 Z" fill={farbe} />
      );
    default:
      return null;
  }
}

function BrilleZeichnung({ brille }: { brille: number }) {
  const rahmen = { fill: 'none', stroke: STRICH, strokeWidth: 5 } as const;
  switch (brille) {
    case 1:
      return (
        <g {...rahmen}>
          <circle cx="455" cy="130" r="23" />
          <circle cx="545" cy="130" r="23" />
          <path d="M 478 130 Q 500 118 522 130" />
        </g>
      );
    case 2:
      return (
        <g {...rahmen}>
          <rect x="430" y="112" width="52" height="36" rx="5" />
          <rect x="518" y="112" width="52" height="36" rx="5" />
          <path d="M 482 124 L 518 124" />
        </g>
      );
    case 3:
      return (
        <g>
          <rect x="426" y="110" width="58" height="34" rx="12" fill="#14121a" />
          <rect x="516" y="110" width="58" height="34" rx="12" fill="#14121a" />
          <path d="M 484 120 L 516 120" stroke="#14121a" strokeWidth="5" />
          <path d="M 436 118 L 452 114" stroke="#fff" strokeWidth="3" opacity="0.5" />
        </g>
      );
    default:
      return null;
  }
}

function HutZeichnung({ hut }: { hut: number }) {
  switch (hut) {
    case 1: // Mütze
      return (
        <g>
          <path d="M 398 112 Q 400 30 500 26 Q 600 30 602 112 Q 500 92 398 112 Z" fill="#3b5bdb" />
          <path d="M 398 112 Q 500 92 602 112 L 602 126 Q 500 106 398 126 Z" fill="#2c44a8" />
          <circle cx="500" cy="24" r="14" fill="#e8e8e8" />
        </g>
      );
    case 2: // Kappe
      return (
        <g>
          <path d="M 400 108 Q 404 40 500 36 Q 596 40 600 108 Q 500 90 400 108 Z" fill="#d6453b" />
          <path d="M 420 104 Q 500 150 640 108 Q 600 88 520 96 Z" fill="#a8322a" />
        </g>
      );
    case 3: // Zylinder
      return (
        <g>
          <rect x="430" y="-14" width="140" height="104" rx="8" fill="#1d1b24" />
          <rect x="430" y="58" width="140" height="18" fill="#b3341f" />
          <ellipse cx="500" cy="92" rx="118" ry="16" fill="#1d1b24" />
        </g>
      );
    case 4: // Partyhut
      return (
        <g>
          <path d="M 440 100 L 500 -30 L 560 100 Q 500 116 440 100 Z" fill="#e04b9a" />
          <path d="M 470 40 L 530 52 M 458 72 L 542 86" stroke="#ffd43b" strokeWidth="9" />
          <circle cx="500" cy="-32" r="12" fill="#ffd43b" />
        </g>
      );
    default:
      return null;
  }
}

/* ---------- Arme ---------- */

/** Ein „Gummiarm“: von der Schulter zur Hand, der Ellbogen biegt nach außen aus. */
function armPfad(sx: number, sy: number, hx: number, hy: number, aussen: number): string {
  const mx = (sx + hx) / 2 + aussen;
  const my = (sy + hy) / 2 + 24;
  return `M ${sx} ${sy} Q ${mx} ${my} ${hx} ${hy}`;
}

interface FigurProps {
  ansicht: FigurAnsicht;
  figur: PressenFigurDaten;
  /** Spiegelbildlich zeichnen (das Männchen auf der anderen Seite). */
  gespiegelt?: boolean;
  /** Atmen, Blinzeln, Schlucken – bei reduzierter Bewegung aus. */
  bewegt: boolean;
  titel: string;
  /** Schmale Darstellung für fremde Bahnen und Vorschau. */
  klein?: boolean;
  stimmung?: Stimmung;
  /** Namenszug-Farbe des Sitzes (nur als Rahmen im Spiegelmodus). */
  farbe?: string;
}

/**
 * Das Strichmännchen mit Glas und Strahl – von oben, leicht geneigt gesehen.
 *
 * Alles ist eigene Zeichnung. Die Bühne hat dieselben Maße wie die Simulation
 * (1000 × 600): Glas bei `(x, y)`, Mund bei `(MUND_X, MUND_Y)`, der Strahl
 * fliegt in einer Parabel zu `(landeX, landeY)`. Was im Oval landet, ist
 * getrunken, der Rest ist eine Pfütze auf dem Tisch.
 */
export function PressenFigur({
  ansicht: a,
  figur,
  gespiegelt,
  bewegt,
  titel,
  klein,
  stimmung = 'normal',
  farbe,
}: FigurProps) {
  const haut = pick(HAUT_FARBEN, figur.haut);
  const haar = pick(HAAR_FARBEN, figur.haarfarbe);
  const shirt = pick(SHIRT_FARBEN, figur.shirt);
  const id = useId().replace(/:/g, '');
  const klammer = `pf-glas-${id}`;

  const bauch = Math.min(1, a.getrunken / GLAS_ML);
  const mundVoll = Math.min(1, a.mund / MUND_KAPAZITAET_ML);
  const schluckt = a.mund > 0.5;
  const sieger = stimmung === 'sieg';
  const schreck = stimmung === 'schreck';
  const freude = stimmung === 'freude' || sieger;
  const traurig = stimmung === 'verloren';

  // Glas: aufrecht steht es mit dem Boden auf dem Tisch; mit Neigung hebt sich
  // der Boden zum Betrachter hin (der Rand bleibt der Drehpunkt).
  const grad = Math.min(100, Math.max(0, a.neigung));
  const sinus = Math.sin((grad * Math.PI) / 180);
  const abgestellt = a.abgestellt;
  const siegHoch = sieger && abgestellt;
  const glasX = siegHoch ? 740 : abgestellt ? 800 : a.x;
  const glasY = siegHoch ? 120 : abgestellt ? 470 : a.y;
  const randRy = 13 + 14 * sinus;
  const bodenY = abgestellt ? 74 : 56 + 44 * sinus;
  const pegel = 1 - a.fuellung / GLAS_ML;

  // Strahl: Parabel vom vorderen Rand zum Landepunkt.
  const startX = glasX;
  const startY = glasY - randRy;
  const strahlBreite = Math.min(15, 2.5 + a.fluss / 7);
  const weite = Math.hypot(a.landeX - startX, a.landeY - startY);
  const bogen = 36 + weite * 0.28;
  const ctrlX = (startX + a.landeX) / 2;
  const ctrlY = Math.min(startY, a.landeY) - bogen;
  const pfuetze = Math.min(150, 8 + Math.sqrt(a.verschuettet) * 8);

  // Arme: rechte Hand am Glas, die linke hilft, wenn getrunken wird.
  const griffX = glasX + 36;
  const griffY = glasY + 14;
  const rechterArm = siegHoch
    ? armPfad(690, 56, 770, -4, 40)
    : abgestellt
      ? armPfad(690, 56, 700, 250, 50)
      : armPfad(690, 56, griffX, griffY, 40);
  const linkerArm = sieger
    ? armPfad(310, 56, 230, -4, -40)
    : abgestellt
      ? armPfad(310, 56, 300, 250, -50)
      : armPfad(310, 56, glasX - 36, glasY + 30, -40);
  const hand = (x: number, y: number) => (
    <circle cx={x} cy={y} r="13" fill={haut} stroke={STRICH} strokeWidth="5" />
  );
  const rechteHand = siegHoch ? [770, -4] : abgestellt ? [700, 250] : [griffX, griffY];
  const linkeHand = sieger ? [230, -4] : abgestellt ? [300, 250] : [glasX - 36, glasY + 30];

  const klassen = [
    'pressen-figur',
    klein ? 'is-klein' : '',
    bewegt ? 'is-bewegt' : '',
    schluckt ? 'is-schluckt' : '',
    freude ? 'is-freude' : '',
    schreck ? 'is-schreck' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <svg
      className={klassen}
      viewBox={`0 0 ${FELD_BREITE} ${FELD_TIEFE}`}
      role="img"
      aria-label={titel}
      style={farbe ? { ['--seat' as string]: farbe } : undefined}
    >
      <defs>
        <radialGradient id={`pf-tisch-${id}`} cx="50%" cy="22%" r="85%">
          <stop offset="0%" stopColor="var(--pf-tisch-hell, #f1e3cb)" />
          <stop offset="100%" stopColor="var(--pf-tisch-dunkel, #d8c19c)" />
        </radialGradient>
        <clipPath id={klammer}>
          <path d={`M -36 0 L 36 0 L ${26} ${bodenY} L -26 ${bodenY} Z`} />
        </clipPath>
      </defs>
      <g transform={gespiegelt ? `translate(${FELD_BREITE} 0) scale(-1 1)` : undefined}>
        {/* Tischplatte mit Planken, nach hinten (oben) enger gesehen */}
        <rect width={FELD_BREITE} height={FELD_TIEFE} fill={`url(#pf-tisch-${id})`} />
        <g className="pf-planken" stroke="var(--pf-planke, rgba(90,60,30,0.18))" strokeWidth="3">
          <path d="M 0 150 L 1000 150 M 0 300 L 1000 300 M 0 450 L 1000 450" />
          <path d="M 200 0 L 120 600 M 400 0 L 360 600 M 600 0 L 640 600 M 800 0 L 880 600" />
        </g>

        {/* Pfütze, wo das Bier danebenging */}
        {a.verschuettet > 0.2 && (
          <ellipse
            cx={a.landeX}
            cy={Math.min(FELD_TIEFE - 10, Math.max(10, a.landeY))}
            rx={pfuetze}
            ry={pfuetze * 0.55}
            fill={BIER}
            opacity="0.45"
          />
        )}

        {/* Oberkörper, von oben: Schultern und Hemd */}
        <g className={bewegt ? 'pf-atmen' : undefined}>
          <ellipse
            cx={KOPF_X}
            cy="10"
            rx={210 + 26 * bauch}
            ry="92"
            fill={shirt}
            stroke={STRICH}
            strokeWidth="6"
          />
          <path
            d="M 440 92 Q 500 130 560 92"
            fill="none"
            stroke={STRICH}
            strokeWidth="5"
            opacity="0.5"
          />

          {/* Haare hinter dem Kopf */}
          <HaareHinten frisur={figur.frisur} farbe={haar} />

          {/* Kopf */}
          <circle cx={KOPF_X} cy={KOPF_Y} r={KOPF_R} fill={haut} stroke={STRICH} strokeWidth="6" />
          {/* Wangen: blähen sich, wenn der Mund voll ist */}
          <ellipse
            cx="424"
            cy="198"
            rx={14 + 12 * mundVoll}
            ry={11 + 9 * mundVoll}
            fill="#e8736b"
            opacity={0.25 + 0.4 * mundVoll}
            className={schluckt && bewegt ? 'pf-wange' : undefined}
          />
          <ellipse
            cx="576"
            cy="198"
            rx={14 + 12 * mundVoll}
            ry={11 + 9 * mundVoll}
            fill="#e8736b"
            opacity={0.25 + 0.4 * mundVoll}
            className={schluckt && bewegt ? 'pf-wange' : undefined}
          />
          <HaareVorn frisur={figur.frisur} farbe={haar} />
          {figur.frisur === 0 && (
            <path
              d="M 450 86 Q 480 70 520 80"
              fill="none"
              stroke="#fff"
              strokeWidth="6"
              opacity="0.5"
              strokeLinecap="round"
            />
          )}
          <BartZeichnung bart={figur.bart} farbe={haar} />

          {/* Augen und Brauen: blinzeln, erschrecken, freuen */}
          <g className={bewegt ? 'pf-blinzeln' : undefined}>
            {traurig ? (
              <g stroke={STRICH} strokeWidth="6" strokeLinecap="round" fill="none">
                <path d="M 436 132 Q 455 142 474 132" />
                <path d="M 526 132 Q 545 142 564 132" />
              </g>
            ) : freude ? (
              <g stroke={STRICH} strokeWidth="6" strokeLinecap="round" fill="none">
                <path d="M 436 136 Q 455 118 474 136" />
                <path d="M 526 136 Q 545 118 564 136" />
              </g>
            ) : (
              <g>
                <ellipse
                  cx="455"
                  cy="130"
                  rx="14"
                  ry={schreck ? 19 : 14}
                  fill="#fff"
                  stroke={STRICH}
                  strokeWidth="4"
                />
                <ellipse
                  cx="545"
                  cy="130"
                  rx="14"
                  ry={schreck ? 19 : 14}
                  fill="#fff"
                  stroke={STRICH}
                  strokeWidth="4"
                />
                <circle cx="455" cy={schreck ? 134 : 132} r="6" fill={STRICH} />
                <circle cx="545" cy={schreck ? 134 : 132} r="6" fill={STRICH} />
              </g>
            )}
          </g>
          <g stroke={STRICH} strokeWidth="6" strokeLinecap="round" fill="none">
            {schreck ? (
              <>
                <path d="M 434 100 Q 455 88 476 98" />
                <path d="M 524 98 Q 545 88 566 100" />
              </>
            ) : traurig ? (
              <>
                <path d="M 434 106 L 476 96" />
                <path d="M 524 96 L 566 106" />
              </>
            ) : (
              <>
                <path d="M 436 106 Q 455 98 474 106" />
                <path d="M 526 106 Q 545 98 564 106" />
              </>
            )}
          </g>
          {/* Nase */}
          <path
            d="M 494 150 Q 500 160 508 152"
            fill="none"
            stroke={STRICH}
            strokeWidth="5"
            strokeLinecap="round"
            opacity="0.7"
          />
          <BrilleZeichnung brille={figur.brille} />

          {/* Der Mund – das Ziel. Maße wie in der Simulation. */}
          <ellipse
            cx={MUND_X}
            cy={MUND_Y}
            rx={MUND_HALB_X + 5}
            ry={MUND_HALB_Y + 5}
            fill="#c0584f"
            stroke={STRICH}
            strokeWidth="5"
          />
          <ellipse
            cx={MUND_X}
            cy={MUND_Y}
            rx={MUND_HALB_X}
            ry={MUND_HALB_Y}
            fill={MUND_INNEN}
            className="pf-mundziel"
          />
          <ellipse
            cx={MUND_X}
            cy={MUND_Y + 14}
            rx={MUND_HALB_X * 0.55}
            ry={MUND_HALB_Y * 0.4}
            fill="#d9726a"
          />
          <ellipse
            cx={MUND_X}
            cy={MUND_Y}
            rx={MUND_HALB_X * mundVoll}
            ry={MUND_HALB_Y * mundVoll}
            fill={BIER}
            className={schluckt && bewegt ? 'pf-schluck' : undefined}
          />
          {figur.bart === 2 && <BartZeichnung bart={2} farbe={haar} />}
          {/* Kehlkopf: wandert beim Schlucken */}
          <g className={schluckt && bewegt ? 'pf-kehle' : undefined}>
            <ellipse
              cx={KOPF_X}
              cy="290"
              rx="16"
              ry="9"
              fill={haut}
              stroke={STRICH}
              strokeWidth="4"
              opacity="0.9"
            />
          </g>
          <HutZeichnung hut={figur.hut} />
        </g>

        {/* Schatten des Glases auf dem Tisch */}
        {!abgestellt && (
          <ellipse
            cx={glasX + 18}
            cy={glasY + 34 + 20 * sinus}
            rx="44"
            ry="16"
            fill="#000"
            opacity="0.14"
          />
        )}

        {/* Arme (Gummiarme) und Hände */}
        <g fill="none" stroke={STRICH} strokeWidth="14" strokeLinecap="round">
          <path d={linkerArm} className={bewegt ? 'pf-arm' : undefined} />
          <path d={rechterArm} className={bewegt ? 'pf-arm' : undefined} />
        </g>
        <g fill="none" stroke={shirt} strokeWidth="8" strokeLinecap="round">
          <path d={linkerArm} />
          <path d={rechterArm} />
        </g>

        {/* Strahl */}
        {a.fluss > 0 && !abgestellt && (
          <g>
            <path
              d={`M ${startX} ${startY} Q ${ctrlX} ${ctrlY} ${a.landeX} ${a.landeY}`}
              fill="none"
              stroke={BIER}
              strokeWidth={strahlBreite}
              strokeLinecap="round"
              opacity="0.92"
            />
            <ellipse
              cx={a.landeX}
              cy={a.landeY}
              rx={strahlBreite + 6}
              ry={(strahlBreite + 6) * 0.55}
              fill={a.trifft ? SCHAUM : BIER}
              opacity={a.trifft ? 0.8 : 0.6}
            />
          </g>
        )}

        {/* Glas: Rand oben, Boden zum Betrachter hin */}
        <g transform={`translate(${glasX} ${glasY})`}>
          {/* Das Wackeln liegt auf einer eigenen Gruppe: CSS-`transform` ersetzte sonst das Verschieben. */}
          <g
            className={`pf-glas${abgestellt ? ' is-abgestellt' : ''}${bewegt && !abgestellt ? ' is-gehalten' : ''}`}
          >
            <g clipPath={`url(#${klammer})`}>
              <rect x="-40" y="0" width="80" height={bodenY} fill="rgba(255,255,255,0.35)" />
              {a.fuellung > 0 && (
                <>
                  <rect x="-40" y={bodenY * pegel} width="80" height={bodenY} fill={BIER} />
                  <rect x="-40" y={bodenY * pegel - 6} width="80" height="8" fill={SCHAUM} />
                </>
              )}
            </g>
            <path
              d={`M -36 0 L -26 ${bodenY} Q 0 ${bodenY + 14} 26 ${bodenY} L 36 0`}
              fill="none"
              stroke={STRICH}
              strokeWidth="6"
              strokeLinejoin="round"
            />
            <ellipse
              cx="0"
              cy="0"
              rx="36"
              ry={randRy}
              fill={a.fuellung > 0 && grad > 40 ? BIER : 'rgba(255,255,255,0.3)'}
              stroke={STRICH}
              strokeWidth="6"
            />
            {a.fuellung > 0 && grad <= 40 && (
              <ellipse cx="0" cy="0" rx="30" ry={Math.max(4, randRy - 6)} fill={SCHAUM} />
            )}
            {/* Henkel */}
            <path
              d={`M 34 10 q 28 8 22 ${Math.round(bodenY * 0.5)} q -4 10 -24 8`}
              fill="none"
              stroke={STRICH}
              strokeWidth="6"
              strokeLinecap="round"
            />
          </g>
        </g>
        {hand(rechteHand[0]!, rechteHand[1]!)}
        {hand(linkeHand[0]!, linkeHand[1]!)}

        {sieger && (
          <text x="500" y="560" textAnchor="middle" fontSize="64" aria-hidden="true">
            🏆
          </text>
        )}
        {schreck && (
          <text x="640" y="150" fontSize="56" aria-hidden="true">
            💦
          </text>
        )}
      </g>
    </svg>
  );
}
