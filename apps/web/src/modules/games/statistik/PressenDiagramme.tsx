import { useId } from 'react';
import {
  datum,
  histogramm,
  schoeneTicks,
  skala,
  zahl,
  type Gruppe,
  type Reihenpunkt,
} from './pressenStatistik.js';

/**
 * Die Diagramme der Pressen-Statistik – eigenes SVG, keine Bibliothek.
 *
 * Jedes Diagramm ist ein Bild mit Namen und Beschreibung (`role="img"`,
 * `<title>`, `<desc>`) und hat eine Tabelle als Alternative („Als Tabelle“):
 * Wer das Bild nicht sehen oder lesen kann, bekommt dieselben Zahlen. Farben
 * kommen aus den Tokens des Themas (hell und dunkel); Information steckt nie
 * allein in der Farbe – die Linie des Mittels ist dicker, die Läufe sind Punkte.
 */

const W = 360;
const H = 210;
const RAND = { l: 42, r: 10, t: 10, b: 26 };

interface LinienProps {
  titel: string;
  einheit: string;
  reihe: readonly Reihenpunkt[];
  fenster: number;
}

export function LinienDiagramm({ titel, einheit, reihe, fenster }: LinienProps) {
  const id = useId();
  const n = reihe.length;
  if (n === 0) return null;

  const werte = reihe.flatMap((p) => [p.wert, p.mittel]);
  const lo = Math.min(...werte);
  const hi = Math.max(...werte);
  const ticks = schoeneTicks(lo, hi, 4);
  const yMin = Math.min(lo, ticks[0] ?? lo);
  const yMax = Math.max(hi, ticks[ticks.length - 1] ?? hi);
  const y = skala(yMin, yMax, H - RAND.b, RAND.t);
  const x = skala(1, Math.max(n, 2), RAND.l, W - RAND.r);
  const xAt = (nr: number) => (n === 1 ? (RAND.l + W - RAND.r) / 2 : x(nr));
  const xTicks = schoeneTicks(1, n, 4).filter((t) => Number.isInteger(t));

  const linie = (feld: 'wert' | 'mittel') =>
    reihe
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${xAt(p.nr).toFixed(1)} ${y(p[feld]).toFixed(1)}`)
      .join(' ');
  const erster = reihe[0]!;
  const letzter = reihe[n - 1]!;
  const beste = Math.min(...reihe.map((p) => p.wert));
  const beschreibung =
    `${n} ${n === 1 ? 'Lauf' : 'Läufe'}, kleiner ist besser. ` +
    `Erster Wert ${zahl(erster.wert, 1)} ${einheit}, letzter ${zahl(letzter.wert, 1)} ${einheit}, ` +
    `bester ${zahl(beste, 1)} ${einheit}. ` +
    `Gleitendes Mittel über ${fenster} Läufe: von ${zahl(erster.mittel, 1)} auf ${zahl(letzter.mittel, 1)} ${einheit}.`;

  return (
    <figure className="stat-bild">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="stat-svg"
        role="img"
        aria-labelledby={`${id}-t ${id}-d`}
        data-testid="stat-linien"
      >
        <title id={`${id}-t`}>{titel}</title>
        <desc id={`${id}-d`}>{beschreibung}</desc>
        {ticks.map((t) => (
          <g key={t}>
            <line className="stat-gitter" x1={RAND.l} x2={W - RAND.r} y1={y(t)} y2={y(t)} />
            <text className="stat-achse" x={RAND.l - 6} y={y(t) + 4} textAnchor="end">
              {zahl(t, t % 1 === 0 ? 0 : 1)}
            </text>
          </g>
        ))}
        {xTicks.map((t) => (
          <text key={t} className="stat-achse" x={xAt(t)} y={H - 8} textAnchor="middle">
            {t}
          </text>
        ))}
        <path className="stat-roh" d={linie('wert')} fill="none" />
        {reihe.map((p) => (
          <circle key={p.nr} className="stat-punkt" cx={xAt(p.nr)} cy={y(p.wert)} r={3.2}>
            <title>{`Lauf ${p.nr}: ${zahl(p.wert, 1)} ${einheit}`}</title>
          </circle>
        ))}
        <path className="stat-mittel" d={linie('mittel')} fill="none" />
      </svg>
      <figcaption className="stat-legende">
        <span className="stat-legende-punkt" aria-hidden="true" /> Lauf
        <span className="stat-legende-linie" aria-hidden="true" /> Gleitendes Mittel ({fenster}{' '}
        Läufe) · Einheit {einheit} · kleiner ist besser
        <br />
        <span className="muted">
          Lauf 1 am {datum(erster.gespieltAm)}
          {n > 1 ? `, Lauf ${n} am ${datum(letzter.gespieltAm)}` : ''}
        </span>
      </figcaption>
      <details className="stat-tabelle">
        <summary>Als Tabelle anzeigen</summary>
        <div className="stat-tabelle-rahmen">
          <table>
            <caption className="visually-hidden">{titel}</caption>
            <thead>
              <tr>
                <th scope="col">Lauf</th>
                <th scope="col">Datum</th>
                <th scope="col">Wert ({einheit})</th>
                <th scope="col">Mittel ({einheit})</th>
              </tr>
            </thead>
            <tbody>
              {reihe.map((p) => (
                <tr key={p.nr}>
                  <th scope="row">{p.nr}</th>
                  <td>{datum(p.gespieltAm)}</td>
                  <td>{zahl(p.wert, 1)}</td>
                  <td>{zahl(p.mittel, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

interface HistoProps {
  titel: string;
  /** Zeiten in Sekunden. */
  werte: readonly number[];
}

export function HistogrammDiagramm({ titel, werte }: HistoProps) {
  const id = useId();
  const klassen = histogramm(werte);
  if (klassen.length === 0) return null;
  const hoechste = Math.max(...klassen.map((k) => k.anzahl));
  const ticks = schoeneTicks(0, hoechste, 3).filter((t) => Number.isInteger(t));
  const yMax = Math.max(hoechste, ticks[ticks.length - 1] ?? hoechste);
  const y = skala(0, yMax, H - RAND.b, RAND.t);
  const breite = (W - RAND.l - RAND.r) / klassen.length;
  const haeufigste = klassen.reduce((a, k) => (k.anzahl > a.anzahl ? k : a), klassen[0]!);
  const beschreibung =
    `${werte.length} Läufe in ${klassen.length} Zeitklassen. ` +
    `Am häufigsten: ${zahl(haeufigste.von, 1)} bis ${zahl(haeufigste.bis, 1)} Sekunden mit ${haeufigste.anzahl} Läufen.`;
  // Beschriftung nur an jeder n-ten Klasse, damit sie auf 375 px nicht überlappt.
  const jede = Math.ceil(klassen.length / 6);

  return (
    <figure className="stat-bild">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="stat-svg"
        role="img"
        aria-labelledby={`${id}-t ${id}-d`}
        data-testid="stat-histogramm"
      >
        <title id={`${id}-t`}>{titel}</title>
        <desc id={`${id}-d`}>{beschreibung}</desc>
        {ticks.map((t) => (
          <g key={t}>
            <line className="stat-gitter" x1={RAND.l} x2={W - RAND.r} y1={y(t)} y2={y(t)} />
            <text className="stat-achse" x={RAND.l - 6} y={y(t) + 4} textAnchor="end">
              {t}
            </text>
          </g>
        ))}
        {klassen.map((k, i) => {
          const hoehe = H - RAND.b - y(k.anzahl);
          return (
            <g key={k.von}>
              <rect
                className="stat-saeule"
                x={RAND.l + i * breite + 1.5}
                y={y(k.anzahl)}
                width={Math.max(1, breite - 3)}
                height={Math.max(0, hoehe)}
                rx={2}
              >
                <title>{`${zahl(k.von, 1)} bis ${zahl(k.bis, 1)} s: ${k.anzahl} ${k.anzahl === 1 ? 'Lauf' : 'Läufe'}`}</title>
              </rect>
              {i % jede === 0 && (
                <text className="stat-achse" x={RAND.l + i * breite} y={H - 8} textAnchor="middle">
                  {zahl(k.von, k.von % 1 === 0 ? 0 : 1)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <figcaption className="stat-legende">
        Zeit in Sekunden (Klassenbeginn) · Läufe je Klasse
      </figcaption>
      <details className="stat-tabelle">
        <summary>Als Tabelle anzeigen</summary>
        <div className="stat-tabelle-rahmen">
          <table>
            <caption className="visually-hidden">{titel}</caption>
            <thead>
              <tr>
                <th scope="col">Zeit (s)</th>
                <th scope="col">Läufe</th>
              </tr>
            </thead>
            <tbody>
              {klassen.map((k) => (
                <tr key={k.von}>
                  <th scope="row">
                    {zahl(k.von, 1)} bis {zahl(k.bis, 1)}
                  </th>
                  <td>{k.anzahl}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

interface GruppenProps {
  titel: string;
  gruppen: readonly Gruppe[];
}

/**
 * Läufe und durchschnittliche Wertung je Gruppe (Wochentag, Tageszeit): eine
 * echte Tabelle, deren Balken nur die Läufe-Spalte unterstreichen. So braucht
 * es keine zweite Fassung für Vorlesehilfen.
 */
export function GruppenTabelle({ titel, gruppen }: GruppenProps) {
  const meiste = Math.max(1, ...gruppen.map((g) => g.laeufe));
  return (
    <div className="stat-tabelle-rahmen">
      <table className="stat-balken-tabelle">
        <caption className="visually-hidden">{titel}</caption>
        <thead>
          <tr>
            <th scope="col">{titel}</th>
            <th scope="col">Läufe</th>
            <th scope="col">Ø Wertung</th>
          </tr>
        </thead>
        <tbody>
          {gruppen.map((g) => (
            <tr key={g.schluessel}>
              <th scope="row">{g.text}</th>
              <td>
                <span className="stat-balken" aria-hidden="true">
                  <span style={{ width: `${(g.laeufe / meiste) * 100}%` }} />
                </span>
                {g.laeufe}
              </td>
              <td>{g.wertungMs == null ? '–' : `${zahl(g.wertungMs / 1000, 1)} s`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
