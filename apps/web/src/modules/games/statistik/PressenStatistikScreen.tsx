import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  PRESSEN_MODI,
  type PressenFilter,
  type PressenLaufModus,
  type PressenStatistikDto,
} from '@initiative/shared';
import { EmptyState, Spinner } from '../../../components/Feedback.js';
import { Screen } from '../../../components/Screen.js';
import { api } from '../../../lib/api.js';
import { errorMessage } from '../helpers.js';
import { GruppenTabelle, HistogrammDiagramm, LinienDiagramm } from './PressenDiagramme.js';
import { PressenLaeufeListe } from './PressenLaeufeListe.js';
import {
  METRIKEN,
  MODUS_TEXT,
  ZEITRAEUME,
  datum,
  dauerLang,
  liter,
  milliliter,
  mitVorzeichen,
  nachTageszeit,
  nachWochentag,
  prozent,
  reihe,
  sekunden,
  zahl,
  zeitraumVon,
  type Metrik,
  type Zeitraum,
} from './pressenStatistik.js';

/** Gleitendes Mittel: so viele Läufe zählen mit. */
const FENSTER = 5;

type Laden = { art: 'laedt' } | { art: 'fehler'; text: string } | { art: 'bereit' };

/**
 * Die Statistik über alle gewerteten Pressen-Läufe des Kontos – auch die, deren
 * Partie längst aufgeräumt ist. Der Server schreibt die Läufe beim Rundenende;
 * hier steht nur, was dort bereits offen war (fremde Zeiten erst nach Rundenende).
 */
export function PressenStatistikScreen() {
  const [zeitraum, setZeitraum] = useState<Zeitraum>('alles');
  const [modus, setModus] = useState<PressenLaufModus | ''>('');
  const [metrik, setMetrik] = useState<Metrik>('wertung');
  const [daten, setDaten] = useState<PressenStatistikDto | null>(null);
  const [laden, setLaden] = useState<Laden>({ art: 'laedt' });
  const [versuch, setVersuch] = useState(0);

  const filter = useMemo<PressenFilter>(
    () => ({ von: zeitraumVon(zeitraum), modus: modus || undefined }),
    // `zeitraumVon` nimmt „jetzt“: neu rechnen, wenn der Zeitraum oder ein neuer Versuch gewählt wird.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [zeitraum, modus, versuch],
  );

  useEffect(() => {
    const abbruch = new AbortController();
    setLaden({ art: 'laedt' });
    api.games
      .pressenStatistik(filter, abbruch.signal)
      .then((antwort) => {
        setDaten(antwort);
        setLaden({ art: 'bereit' });
      })
      .catch((fehler: unknown) => {
        if (abbruch.signal.aborted) return;
        setLaden({ art: 'fehler', text: errorMessage(fehler, 'Die Statistik kam nicht an.') });
      });
    return () => abbruch.abort();
  }, [filter]);

  const nochmal = useCallback(() => setVersuch((n) => n + 1), []);
  const verlauf = daten?.verlauf ?? [];
  const linie = useMemo(() => reihe(verlauf, metrik, FENSTER), [verlauf, metrik]);
  const zeiten = useMemo(
    () => verlauf.filter((p) => !p.vorzeitig).map((p) => p.dauerMs / 1000),
    [verlauf],
  );
  const wochentage = useMemo(() => nachWochentag(verlauf), [verlauf]);
  const tageszeiten = useMemo(() => nachTageszeit(verlauf), [verlauf]);
  const metrikInfo = METRIKEN.find((m) => m.wert === metrik)!;
  const leer = laden.art === 'bereit' && daten != null && daten.kopf.laeufe === 0;
  const gefiltert = zeitraum !== 'alles' || modus !== '';

  return (
    <Screen title="Pressen-Statistik" back="/spiele">
      <div className="stat-seite" data-testid="pressen-statistik">
        <div className="stat-filter" role="group" aria-label="Auswahl">
          <div role="group" aria-label="Zeitraum" className="stat-chips">
            {ZEITRAEUME.map((z) => (
              <button
                key={z.wert}
                type="button"
                className={`btn btn-sm${zeitraum === z.wert ? ' btn-primary' : ''}`}
                aria-pressed={zeitraum === z.wert}
                onClick={() => setZeitraum(z.wert)}
                data-testid={`stat-zeitraum-${z.wert}`}
              >
                {z.text}
              </button>
            ))}
          </div>
          <label className="stat-auswahl">
            <span>Modus</span>
            <select
              className="select"
              value={modus}
              onChange={(e) => setModus(e.target.value as PressenLaufModus | '')}
              data-testid="stat-modus"
            >
              <option value="">Alle Modi</option>
              {PRESSEN_MODI.map((m) => (
                <option key={m} value={m}>
                  {MODUS_TEXT[m]}
                </option>
              ))}
            </select>
          </label>
        </div>

        {laden.art === 'laedt' && !daten && <Spinner label="Statistik wird geladen …" />}
        {laden.art === 'fehler' && (
          <div className="card stat-fehler" role="alert" data-testid="stat-fehler">
            <p>{laden.text}</p>
            <button type="button" className="btn btn-primary" onClick={nochmal}>
              Noch einmal versuchen
            </button>
          </div>
        )}

        {leer && (
          <EmptyState
            emoji="📊"
            title={gefiltert ? 'Keine Läufe in dieser Auswahl' : 'Noch keine Läufe'}
            description={
              gefiltert
                ? 'Wähle einen längeren Zeitraum oder alle Modi.'
                : 'Sobald eine Runde zu Ende ist, steht dein Lauf hier – gegen den Spiegel schon nach dem ersten Abstellen.'
            }
            action={
              <Link className="btn btn-primary" to="/spiele">
                Zu den Spielen
              </Link>
            }
          />
        )}

        {daten && !leer && (
          <div
            className="stat-inhalt"
            aria-busy={laden.art === 'laedt'}
            data-geladen={laden.art === 'bereit' ? '1' : '0'}
          >
            <section aria-labelledby="stat-kopf-titel" className="stack">
              <h2 id="stat-kopf-titel" className="game-section-title">
                Auf einen Blick
              </h2>
              <dl className="stat-kacheln" data-testid="stat-kopf">
                <Kachel name="Läufe" wert={zahl(daten.kopf.laeufe)} testid="laeufe" />
                <Kachel
                  name="Siege"
                  wert={zahl(daten.kopf.siege)}
                  testid="siege"
                  hinweis={`${daten.kopf.niederlagen} Niederlagen · ${daten.kopf.atempo} Atempo`}
                />
                <Kachel
                  name="Siegquote"
                  wert={daten.kopf.siegquote == null ? '–' : prozent(daten.kopf.siegquote)}
                  testid="siegquote"
                  hinweis="Siege zu entschiedenen Partien"
                />
                <Kachel
                  name="Beste Zeit"
                  wert={daten.rekorde.besteZeit ? sekunden(daten.rekorde.besteZeit.wert) : '–'}
                  testid="beste-zeit"
                />
                <Kachel
                  name="Beste Wertung"
                  wert={
                    daten.rekorde.besteWertung ? sekunden(daten.rekorde.besteWertung.wert) : '–'
                  }
                  testid="beste-wertung"
                  hinweis="Zeit plus Strafe"
                />
                <Kachel
                  name="Ø Zeit"
                  wert={
                    daten.kopf.durchschnittZeitMs == null
                      ? '–'
                      : sekunden(daten.kopf.durchschnittZeitMs)
                  }
                  testid="durchschnitt-zeit"
                />
                <Kachel
                  name="Ø verschüttet"
                  wert={
                    daten.kopf.durchschnittVerschuettetDezi == null
                      ? '–'
                      : milliliter(daten.kopf.durchschnittVerschuettetDezi)
                  }
                  testid="durchschnitt-verschuettet"
                />
                <Kachel
                  name="Getrunken"
                  wert={liter(daten.kopf.gesamtGetrunkenDezi)}
                  testid="getrunken"
                  hinweis={`Trefferquote ${daten.kopf.trefferquote == null ? '–' : prozent(daten.kopf.trefferquote, 1)}`}
                />
                <Kachel
                  name="Verschüttet"
                  wert={liter(daten.kopf.gesamtVerschuettetDezi)}
                  testid="verschuettet"
                />
                <Kachel
                  name="Getrümmert"
                  wert={zahl(daten.kopf.getruemmert)}
                  testid="getruemmert"
                  hinweis="Glas leer, in 0,45 s abgestellt"
                />
                <Kachel
                  name="Längste Siegesserie"
                  wert={zahl(daten.kopf.laengsteSiegesserie)}
                  testid="serie"
                  hinweis={`aktuell ${daten.kopf.aktuelleSiegesserie}`}
                />
                <Kachel
                  name="Gespielt"
                  wert={dauerLang(daten.kopf.gesamtDauerMs)}
                  testid="spielzeit"
                  hinweis="reine Trinkzeit"
                />
              </dl>
            </section>

            <section aria-labelledby="stat-verlauf-titel" className="stack">
              <h2 id="stat-verlauf-titel" className="game-section-title">
                Verlauf
              </h2>
              <div role="group" aria-label="Was das Diagramm zeigt" className="stat-chips">
                {METRIKEN.map((m) => (
                  <button
                    key={m.wert}
                    type="button"
                    className={`btn btn-sm${metrik === m.wert ? ' btn-primary' : ''}`}
                    aria-pressed={metrik === m.wert}
                    onClick={() => setMetrik(m.wert)}
                    data-testid={`stat-metrik-${m.wert}`}
                  >
                    {m.text}
                  </button>
                ))}
              </div>
              {linie.length > 0 ? (
                <LinienDiagramm
                  titel={`${metrikInfo.text} je Lauf`}
                  einheit={metrikInfo.einheit}
                  reihe={linie}
                  fenster={FENSTER}
                />
              ) : (
                <p className="game-note">Noch kein Lauf, der ins Ziel kam.</p>
              )}
              {daten.verlaufGekuerzt && (
                <p className="game-note">
                  Das Diagramm zeigt die jüngsten {verlauf.length} Läufe; die Zahlen oben zählen
                  alle.
                </p>
              )}
              {verlauf.some((p) => p.vorzeitig) && (
                <p className="game-note">
                  Vorzeitig abgestellte Läufe stehen nicht im Diagramm (ihre Werte sagen nichts über
                  dein Können).
                </p>
              )}
            </section>

            {zeiten.length > 0 && (
              <section aria-labelledby="stat-verteilung-titel" className="stack">
                <h2 id="stat-verteilung-titel" className="game-section-title">
                  Verteilung der Zeiten
                </h2>
                <HistogrammDiagramm titel="Verteilung der Zeiten" werte={zeiten} />
              </section>
            )}

            <section aria-labelledby="stat-rekorde-titel" className="stack">
              <h2 id="stat-rekorde-titel" className="game-section-title">
                Rekorde
              </h2>
              <ul className="card stat-rekorde" data-testid="stat-rekorde">
                <Rekordzeile
                  name="Schnellste Zeit"
                  rekord={daten.rekorde.besteZeit}
                  format={sekunden}
                />
                <Rekordzeile
                  name="Beste Wertung"
                  rekord={daten.rekorde.besteWertung}
                  format={sekunden}
                />
                <Rekordzeile
                  name="Am wenigsten verschüttet"
                  rekord={daten.rekorde.saubersterLauf}
                  format={milliliter}
                />
                <Rekordzeile
                  name="Schnellste Reaktion nach „leer“"
                  rekord={daten.rekorde.schnellsteReaktion}
                  format={(ms) => `${zahl(ms)} ms`}
                />
                <Rekordzeile
                  name="Längste Siegesserie"
                  rekord={daten.rekorde.laengsteSiegesserie}
                  format={(n) => `${zahl(n)} in Folge`}
                />
              </ul>
            </section>

            <section aria-labelledby="stat-modus-titel" className="stack">
              <h2 id="stat-modus-titel" className="game-section-title">
                Nach Modus
              </h2>
              <div className="stat-tabelle-rahmen">
                <table data-testid="stat-nach-modus">
                  <caption className="visually-hidden">Läufe und Bilanz je Modus</caption>
                  <thead>
                    <tr>
                      <th scope="col">Modus</th>
                      <th scope="col">Läufe</th>
                      <th scope="col">Bilanz</th>
                      <th scope="col">Beste Wertung</th>
                      <th scope="col">Ø Zeit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {daten.nachModus.map((m) => (
                      <tr key={m.modus}>
                        <th scope="row">{MODUS_TEXT[m.modus]}</th>
                        <td>{m.laeufe}</td>
                        <td>
                          {m.siege} S · {m.niederlagen} N · {m.atempo} A
                        </td>
                        <td>{m.besteWertungMs == null ? '–' : sekunden(m.besteWertungMs)}</td>
                        <td>
                          {m.durchschnittZeitMs == null ? '–' : sekunden(m.durchschnittZeitMs)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="game-note">S = Sieg, N = Niederlage, A = Atempo.</p>
            </section>

            <section aria-labelledby="stat-gegner-titel" className="stack">
              <h2 id="stat-gegner-titel" className="game-section-title">
                Gegner
              </h2>
              {daten.nachGegner.length === 0 ? (
                <p className="game-note">
                  Noch keine gemeinsame Runde mit jemandem – gegen den Spiegel gibt es keinen
                  Gegner.
                </p>
              ) : (
                <div className="stat-tabelle-rahmen">
                  <table data-testid="stat-nach-gegner">
                    <caption className="visually-hidden">
                      Bilanz gegen jeden Gegner, nur abgeschlossene gemeinsame Runden
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Gegner</th>
                        <th scope="col">Runden</th>
                        <th scope="col">Bilanz (du : er)</th>
                        <th scope="col">Ø Vorsprung</th>
                        <th scope="col">Zuletzt</th>
                      </tr>
                    </thead>
                    <tbody>
                      {daten.nachGegner.map((g) => (
                        <tr key={g.userId}>
                          <th scope="row">{g.name ?? 'Gelöschtes Konto'}</th>
                          <td>{g.runden}</td>
                          <td>
                            {g.siege} : {g.niederlagen}
                            {g.atempo > 0 ? ` (${g.atempo} Atempo)` : ''}
                          </td>
                          <td>
                            {g.durchschnittVorsprungMs == null
                              ? '–'
                              : mitVorzeichen(g.durchschnittVorsprungMs)}
                          </td>
                          <td>{datum(g.letzteRunde)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="game-note">
                Gezählt werden nur Runden, die für beide zu Ende sind – der Vergleich steht nur dir
                und deinem Gegner zur Verfügung, jedem mit seinen eigenen Zahlen.
              </p>
            </section>

            <section aria-labelledby="stat-malus-titel" className="stack">
              <h2 id="stat-malus-titel" className="game-section-title">
                Wertung und Ermüdung
              </h2>
              {daten.nachMalus.length === 0 ? (
                <p className="game-note">
                  Der Zusammenhang erscheint, sobald du mit anderen gespielt hast – gegen den
                  Spiegel wächst der Malus nicht.
                </p>
              ) : (
                <div className="stat-tabelle-rahmen">
                  <table data-testid="stat-nach-malus">
                    <caption className="visually-hidden">
                      Durchschnittliche Wertung nach Stufe des Malus (Ermüdung)
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Malus</th>
                        <th scope="col">Läufe</th>
                        <th scope="col">Ø Wertung</th>
                        <th scope="col">Ø verschüttet</th>
                      </tr>
                    </thead>
                    <tbody>
                      {daten.nachMalus.map((m) => (
                        <tr key={m.vonMs}>
                          <th scope="row">
                            {m.vonMs}–{m.bisMs} ms
                          </th>
                          <td>{m.laeufe}</td>
                          <td>
                            {m.durchschnittWertungMs == null
                              ? '–'
                              : sekunden(m.durchschnittWertungMs)}
                          </td>
                          <td>
                            {m.durchschnittVerschuettetDezi == null
                              ? '–'
                              : milliliter(m.durchschnittVerschuettetDezi)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section aria-labelledby="stat-zeiten-titel" className="stack">
              <h2 id="stat-zeiten-titel" className="game-section-title">
                Wann du am besten trinkst
              </h2>
              <GruppenTabelle titel="Tageszeit" gruppen={tageszeiten} />
              <GruppenTabelle titel="Wochentag" gruppen={wochentage} />
            </section>
          </div>
        )}

        <PressenLaeufeListe filter={filter} />
      </div>
    </Screen>
  );
}

function Kachel({
  name,
  wert,
  hinweis,
  testid,
}: {
  name: string;
  wert: string;
  hinweis?: string;
  testid: string;
}) {
  return (
    <div className="stat-kachel" data-testid={`stat-${testid}`}>
      <dt>{name}</dt>
      <dd>
        <strong>{wert}</strong>
        {hinweis && <span className="stat-hinweis">{hinweis}</span>}
      </dd>
    </div>
  );
}

function Rekordzeile({
  name,
  rekord,
  format,
}: {
  name: string;
  rekord: { wert: number; gespieltAm: string; laufId: string } | null;
  format: (wert: number) => string;
}) {
  return (
    <li>
      <span>{name}</span>
      {rekord ? (
        <Link to={`/spiele/pressen/statistik/${rekord.laufId}`}>
          <strong>{format(rekord.wert)}</strong>
          <span className="muted"> am {datum(rekord.gespieltAm)}</span>
        </Link>
      ) : (
        <span className="muted">–</span>
      )}
    </li>
  );
}
