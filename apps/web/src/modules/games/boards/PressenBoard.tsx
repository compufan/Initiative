import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import {
  GLAS_ML,
  MALUS_MAX_MS,
  MUND_KAPAZITAET_ML,
  dranSitze,
  pressen,
  verzoegerungBei,
  wartetAuf,
  type GameSessionDto,
  type LaufErgebnis,
  type PressenErgebnis,
  type PressenState,
  type Taste,
} from '@initiative/shared';
import { useMyId } from '../../../state/session.js';
import { toast } from '../../../state/ui.js';
import { nameFrom, seatClass, useUserLookup } from '../helpers.js';
import type { GameBoardProps } from './registry.js';
import { BoardStatus } from './BoardStatus.js';
import {
  BEREIT,
  PressenFigur,
  TRINKT,
  ansichtAus,
  fertigAnsicht,
  type FigurAnsicht,
} from './PressenFigur.js';
import { getruemmertMerken, getruemmertZaehler, usePressenLauf } from './pressenLauf.js';

/** Liest den Spielstand vorsichtig – ein unbekannter Stand wird zu einer leeren Runde. */
function lesen(session: GameSessionDto): PressenState {
  const roh = session.state as Partial<PressenState> | null;
  if (
    roh &&
    Array.isArray(roh.ergebnisse) &&
    Array.isArray(roh.teams) &&
    Array.isArray(roh.malus)
  ) {
    return roh as PressenState;
  }
  return pressen.createInitialState(
    session.players.map((player) => ({ seat: player.seat, userId: player.userId })),
  );
}

const sek = (ms: number) => `${(ms / 1000).toFixed(1).replace('.', ',')} s`;
const ml = (dezi: number) => `${(dezi / 10).toFixed(1).replace('.', ',')} ml`;

function useReduzierteBewegung(): boolean {
  const [reduziert, setReduziert] = useState(() =>
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const abfrage = window.matchMedia('(prefers-reduced-motion: reduce)');
    const hoeren = () => setReduziert(abfrage.matches);
    abfrage.addEventListener('change', hoeren);
    return () => abfrage.removeEventListener('change', hoeren);
  }, []);
  return reduziert;
}

/** Wo der Abstellen-Knopf diesmal erscheint: wechselt je Runde und Sitz, ist aber nachvollziehbar. */
function knopfOrt(runde: number, sitz: number): { links: number; oben: number } {
  const h = (runde * 7919 + sitz * 104729 + 13) % 997;
  return { links: 8 + (h % 70), oben: 6 + ((h * 31) % 42) };
}

function rolle(state: PressenState, sitz: number): string | null {
  if (state.ampel === sitz) return 'Ampel';
  if (state.modus === 'staffette') {
    const team = state.teams.findIndex((t) => t.includes(sitz));
    return team >= 0 ? `Team ${'AB'[team]}` : null;
  }
  return null;
}

/**
 * Pressen: das Bier so schnell wie möglich trinken, ohne etwas zu verschütten.
 *
 * Der eigene Lauf rechnet dieser Client (Physik im gemeinsamen Paket) und
 * meldet nur das Ergebnis als Zug; der Server wertet. Die Bahnen der anderen
 * zeigen, ob sie dran sind, und ihr Ergebnis, sobald es gemeldet ist.
 */
export function PressenBoard({ session, mySeat, onMove, busy }: GameBoardProps) {
  const myId = useMyId();
  const state = lesen(session);
  const reduziert = useReduzierteBewegung();
  const spielende = useMemo(() => session.players.map((p) => p.userId), [session.players]);
  const users = useUserLookup(spielende);
  const nameVon = (sitz: number) => {
    const userId = session.players.find((p) => p.seat === sitz)?.userId;
    if (!userId) return `Spieler ${sitz + 1}`;
    return userId === myId ? 'Du' : nameFrom(users, userId);
  };

  const aktiv = session.status === 'active' && !state.fertig;
  const dran = dranSitze(state);
  const ichDran = aktiv && mySeat != null && dran.includes(mySeat);
  const spiegel = state.modus === 'spiegel';

  const laufRunde = useRef(state.runde);
  const laufVerz = useRef(0);
  /** Runden, in denen DIESES Gerät gelaufen ist – nur dafür gibt es eine Auszeichnung. */
  const eigeneRunden = useRef(new Set<number>());
  const senden = useCallback(
    (erg: LaufErgebnis) => {
      onMove({
        typ: 'ergebnis',
        runde: laufRunde.current,
        dauerMs: erg.dauerMs,
        verschuettetDezi: erg.verschuettetDezi,
        reaktionMs: erg.reaktionMs,
        vorzeitig: erg.vorzeitig,
        verzoegerungMs: laufVerz.current,
      });
    },
    [onMove],
  );
  const lauf = usePressenLauf((erg) => {
    eigeneRunden.current.add(laufRunde.current);
    senden(erg);
  });
  const laufRef = useRef(lauf);
  laufRef.current = lauf;

  /* ---- Serveruhr: aus dem Zeitstempel des Stands + eigener Laufzeit ---- */
  const empfangen = useRef({ stempel: Date.parse(session.updatedAt), perf: performance.now() });
  useEffect(() => {
    empfangen.current = { stempel: Date.parse(session.updatedAt), perf: performance.now() };
  }, [session.updatedAt]);
  const serverJetzt = useCallback(() => {
    const { stempel, perf } = empfangen.current;
    return (Number.isFinite(stempel) ? stempel : Date.now()) + (performance.now() - perf);
  }, []);

  /* ---- Malus-Anzeige (klingt sichtbar ab) ---- */
  const meinMalus = mySeat != null ? state.malus[mySeat] : undefined;
  const [, uhr] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => uhr((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  const malusJetzt = meinMalus && !spiegel ? verzoegerungBei(meinMalus, serverJetzt()) : 0;

  /* ---- neue Runde (Atempo) oder fremder Stand: lokalen Lauf zurücksetzen ---- */
  useEffect(() => {
    if (laufRunde.current !== state.runde && laufRef.current.phase !== 'bereit') {
      laufRef.current.zuruecksetzen();
    }
  }, [state.runde]);

  const meinErgebnis: PressenErgebnis | null =
    mySeat != null ? (state.ergebnisse[mySeat] ?? null) : null;

  /* ---- Tastatur ---- */
  const [gedrueckt, setGedrueckt] = useState<Record<Taste, boolean>>({
    links: false,
    rechts: false,
    neigen: false,
  });
  const druecke = useCallback((taste: Taste, runter: boolean) => {
    setGedrueckt((alt) => (alt[taste] === runter ? alt : { ...alt, [taste]: runter }));
    if (runter) laufRef.current.druecken(taste);
    else laufRef.current.loslassen(taste);
  }, []);

  const laeuft = lauf.phase === 'laeuft';
  useEffect(() => {
    if (!laeuft) {
      setGedrueckt({ links: false, rechts: false, neigen: false });
      return undefined;
    }
    const taste = (e: KeyboardEvent): Taste | 'esc' | null => {
      if (e.key === 'ArrowLeft') return 'links';
      if (e.key === 'ArrowRight') return 'rechts';
      if (e.key === ' ' || e.key === 'Spacebar') return 'neigen';
      if (e.key === 'Escape') return 'esc';
      return null;
    };
    const auf = (e: KeyboardEvent, runter: boolean) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = taste(e);
      if (!t) return;
      // Der Abstellen-Knopf gehört sich selbst (Leertaste/Enter lösen ihn aus).
      if ((e.target as HTMLElement | null)?.closest?.('[data-abstellen]')) return;
      e.preventDefault();
      if (t === 'esc') {
        if (runter && !e.repeat) laufRef.current.vorzeitigAbstellen();
        return;
      }
      if (e.repeat) return;
      druecke(t, runter);
    };
    const runter = (e: KeyboardEvent) => auf(e, true);
    const hoch = (e: KeyboardEvent) => auf(e, false);
    window.addEventListener('keydown', runter);
    window.addEventListener('keyup', hoch);
    return () => {
      window.removeEventListener('keydown', runter);
      window.removeEventListener('keyup', hoch);
    };
  }, [laeuft, druecke]);

  const halten = (taste: Taste) => ({
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture?.(e.pointerId);
      druecke(taste, true);
    },
    onPointerUp: () => druecke(taste, false),
    onPointerCancel: () => druecke(taste, false),
    onLostPointerCapture: () => druecke(taste, false),
    onContextMenu: (e: { preventDefault: () => void }) => e.preventDefault(),
  });

  /* ---- Abstellen-Knopf ---- */
  const leer = laeuft && lauf.zustand.leerTick != null && lauf.zustand.abgestelltTick == null;
  const abstellKnopf = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (leer) abstellKnopf.current?.focus({ preventScroll: true });
  }, [leer]);
  const ort = knopfOrt(state.runde, mySeat ?? 0);

  /* ---- Auszeichnung "getrümmert" ---- */
  const [zaehlerAuszeichnung, setZaehlerAuszeichnung] = useState(getruemmertZaehler);
  const vergeben = useRef(new Set<number>());
  useEffect(() => {
    if (mySeat == null) return;
    // Der Stand liefert den Lauf entweder noch in der Runde oder schon als
    // Vorrunde (nach Atempo). Beide Wege führen zur selben Auszeichnung.
    const kandidaten: [number, PressenErgebnis | null | undefined][] = [
      [state.runde, state.ergebnisse[mySeat]],
      [state.runde - 1, state.vorrunde?.[mySeat]],
    ];
    for (const [runde, ergebnis] of kandidaten) {
      if (
        !ergebnis?.getruemmert ||
        !eigeneRunden.current.has(runde) ||
        vergeben.current.has(runde)
      ) {
        continue;
      }
      vergeben.current.add(runde);
      setZaehlerAuszeichnung(getruemmertMerken());
      toast('🏅 Auszeichnung: getrümmert!', 'success');
    }
  }, [state, mySeat]);

  /* ---- Ansagen für Vorlesehilfen ---- */
  const [ansage, setAnsage] = useState('');
  const leerGemeldet = useRef(false);
  useEffect(() => {
    if (lauf.phase === 'zaehlt' && lauf.zaehler > 0) setAnsage(`Los in ${lauf.zaehler}`);
    if (lauf.phase === 'laeuft') {
      if (!leerGemeldet.current && lauf.zustand.tick < 3) {
        setAnsage('Los! Pfeiltasten links und rechts bewegen das Glas, die Leertaste neigt es.');
      }
      if (lauf.zustand.leerTick != null && !leerGemeldet.current) {
        leerGemeldet.current = true;
        setAnsage('Glas leer. Der Abstellen-Knopf ist erschienen – schnell drücken.');
      }
    }
    if (lauf.phase === 'bereit') leerGemeldet.current = false;
    if (lauf.phase === 'fertig' && lauf.ergebnis) {
      setAnsage(
        `Abgestellt nach ${sek(lauf.ergebnis.dauerMs)}, ${ml(lauf.ergebnis.verschuettetDezi)} verschüttet.`,
      );
    }
  }, [lauf.phase, lauf.zaehler, lauf.zustand.tick, lauf.zustand.leerTick, lauf.ergebnis]);
  const angesagt = useRef('');
  useEffect(() => {
    const schluessel = `${state.runde}-${state.fertig}`;
    if (angesagt.current === schluessel) return;
    if (state.fertig) {
      setAnsage(`Entschieden. ${pressen.describe(state, [])}.`);
    } else if (state.atempo > 0 && state.letzterAbstandMs != null) {
      setAnsage(`Atempo! Nur ${state.letzterAbstandMs} Millisekunden Unterschied – nochmal.`);
    }
    angesagt.current = schluessel;
  }, [state]);

  /* ---- Anzeige ---- */
  const start = () => {
    if (!ichDran || mySeat == null) return;
    laufRunde.current = state.runde;
    const verz = spiegel ? 0 : verzoegerungBei(state.malus[mySeat]!, serverJetzt());
    laufVerz.current = verz;
    lauf.starten(verz);
  };

  const wartet = mySeat != null ? wartetAuf(state, mySeat) : null;
  const meinSitzFertig = meinErgebnis != null || lauf.phase === 'fertig';
  const ansichtFuer = (sitz: number): FigurAnsicht => {
    const e = state.ergebnisse[sitz];
    if (e) return fertigAnsicht(e.verschuettetDezi);
    return aktiv && dran.includes(sitz) ? TRINKT : BEREIT;
  };

  const meineAnsicht: FigurAnsicht =
    lauf.phase === 'laeuft' || (lauf.phase === 'fertig' && lauf.ergebnis)
      ? ansichtAus(lauf.zustand)
      : meinErgebnis
        ? fertigAnsicht(meinErgebnis.verschuettetDezi)
        : BEREIT;

  const andere = session.players
    .map((p) => p.seat)
    .filter((sitz) => sitz !== mySeat)
    .sort((a, b) => a - b);

  const z = lauf.zustand;
  const verschuettetMl = z.verschuettet.toFixed(1).replace('.', ',');
  const ergebnisListe = (state.fertig ? state.ergebnisse : state.vorrunde) ?? [];
  const zeigeListe = state.fertig || (state.atempo > 0 && state.ergebnisse.every((e) => e == null));

  return (
    <div className="game-board-wrap pressen">
      <p className="visually-hidden" role="status" aria-live="polite" data-testid="pressen-ansage">
        {ansage}
      </p>

      {mySeat != null && (
        <div
          className="pressen-feld"
          data-testid="pressen-feld"
          data-phase={lauf.phase}
          data-glas-x={Math.round(z.x)}
          data-neigung={Math.round(z.neigung)}
          data-fuellung={Math.round(z.fuellung)}
          data-mund={Math.round(z.mund)}
          data-leer={z.leerTick != null ? '1' : '0'}
          data-verzoegerung={lauf.verzoegerungMs}
        >
          <div className="pressen-buehne">
            <PressenFigur
              ansicht={meineAnsicht}
              bewegt={!reduziert}
              farbe="var(--accent)"
              titel={`Dein Strichmännchen, ${Math.round(meineAnsicht.fuellung)} Milliliter im Glas`}
            />
            {spiegel && (
              <PressenFigur
                ansicht={meineAnsicht}
                gespiegelt
                klein
                bewegt={!reduziert}
                farbe="var(--warning)"
                titel="Spiegelbild: trinkt synchron zu dir"
              />
            )}
          </div>

          {lauf.phase === 'zaehlt' && lauf.zaehler > 0 && (
            <div className="pressen-zaehler" aria-hidden="true">
              {lauf.zaehler}
            </div>
          )}

          {leer && (
            <button
              ref={abstellKnopf}
              type="button"
              className="btn btn-primary pressen-abstellen"
              data-abstellen
              style={{ left: `${ort.links}%`, top: `${ort.oben}%` }}
              onPointerDown={(e) => {
                e.preventDefault();
                lauf.abstellen();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  e.stopPropagation();
                  lauf.abstellen();
                }
              }}
              onClick={(e) => {
                // Hilfsmittel lösen nur ein Klick-Ereignis aus (detail 0).
                if (e.detail === 0) lauf.abstellen();
              }}
            >
              🍺 Abstellen!
            </button>
          )}

          {(lauf.phase === 'laeuft' || lauf.phase === 'zaehlt') && (
            <div className="pressen-hud" aria-hidden="true">
              <span>
                Glas <strong>{Math.round(z.fuellung)}</strong>/{GLAS_ML} ml
              </span>
              <span className={z.mund > MUND_KAPAZITAET_ML * 0.8 ? 'is-warn' : undefined}>
                Mund <strong>{Math.round((z.mund / MUND_KAPAZITAET_ML) * 100)}</strong> %
              </span>
              <span>
                Verschüttet <strong>{verschuettetMl}</strong> ml
              </span>
              <span>
                Zeit <strong>{sek(z.tick * 20)}</strong>
              </span>
            </div>
          )}
        </div>
      )}

      {mySeat != null && (lauf.phase === 'laeuft' || lauf.phase === 'zaehlt') && (
        <div className="pressen-steuerung">
          <div className="pressen-pfeile" role="group" aria-label="Glas bewegen">
            <button
              type="button"
              className={`pressen-taste${gedrueckt.links ? ' is-gedrueckt' : ''}`}
              aria-label="Glas nach links (Pfeiltaste links)"
              aria-pressed={gedrueckt.links}
              {...halten('links')}
            >
              ◀
            </button>
            <button
              type="button"
              className={`pressen-taste${gedrueckt.rechts ? ' is-gedrueckt' : ''}`}
              aria-label="Glas nach rechts (Pfeiltaste rechts)"
              aria-pressed={gedrueckt.rechts}
              {...halten('rechts')}
            >
              ▶
            </button>
          </div>
          <button
            type="button"
            className={`pressen-taste pressen-neigen${gedrueckt.neigen ? ' is-gedrueckt' : ''}`}
            aria-label="Glas neigen – gedrückt halten (Leertaste)"
            aria-pressed={gedrueckt.neigen}
            {...halten('neigen')}
          >
            Neigen
          </button>
        </div>
      )}

      {mySeat != null && lauf.phase === 'laeuft' && (
        <button
          type="button"
          className="btn pressen-vorzeitig"
          onClick={() => lauf.vorzeitigAbstellen()}
          data-tipp="Stellt das Glas sofort ab – was noch drin ist, zählt als verschüttet (Esc)"
        >
          Vorzeitig abstellen (Esc)
        </button>
      )}

      {ichDran && lauf.phase === 'bereit' && !meinErgebnis && (
        <div className="stack pressen-start">
          <button
            type="button"
            className="btn btn-primary btn-block"
            onClick={start}
            disabled={busy}
          >
            🍺 Los! Lauf starten
          </button>
          <p className="game-hint">
            Pfeiltasten links/rechts: Glas bewegen · Leertaste (oder Knopf rechts) halten: neigen ·
            Esc: vorzeitig abstellen.
          </p>
        </div>
      )}

      {lauf.phase === 'fertig' && !meinErgebnis && aktiv && (
        <div className="stack">
          <p className="game-hint" role="status">
            {busy ? 'Ergebnis wird gesendet …' : 'Dein Ergebnis ist noch nicht beim Server.'}
          </p>
          {!busy && lauf.ergebnis && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => senden(lauf.ergebnis!)}
            >
              Ergebnis erneut senden
            </button>
          )}
        </div>
      )}

      {aktiv && mySeat != null && !ichDran && !meinSitzFertig && wartet && (
        <p className="game-hint" role="status">
          {wartet === 'ampel'
            ? `${nameVon(state.ampel ?? 0)} macht die Ampel – du startest, sobald das Glas abgestellt ist.`
            : 'Dein Teamkollege ist noch dran – du startest, sobald er abgestellt hat.'}
        </p>
      )}

      {aktiv && meinErgebnis && (
        <p className="game-hint" role="status">
          Dein Lauf: {sek(meinErgebnis.dauerMs)}, {ml(meinErgebnis.verschuettetDezi)} verschüttet →
          Wertung {sek(meinErgebnis.wertungMs)}
          {meinErgebnis.getruemmert ? ' · 🏅 getrümmert!' : ''}. Warten auf die anderen …
        </p>
      )}

      {!state.fertig && state.atempo > 0 && state.ergebnisse.every((e) => e == null) && (
        <p className="pressen-atempo" role="status">
          Atempo! Nur {state.letzterAbstandMs ?? 0} ms Unterschied – ihr tretet noch einmal an
          (Runde {state.runde}).
        </p>
      )}

      {andere.length > 0 && (
        <ul
          className={`pressen-bahnen${mySeat == null ? ' ist-zuschauer' : ''}`}
          aria-label="Bahnen der Mitspielenden"
        >
          {andere.map((sitz) => {
            const e = state.ergebnisse[sitz];
            const r = rolle(state, sitz);
            return (
              <li key={sitz} className={`pressen-bahn ${seatClass(sitz)}`}>
                <PressenFigur
                  klein
                  gespiegelt
                  ansicht={ansichtFuer(sitz)}
                  bewegt={!reduziert}
                  farbe="var(--seat)"
                  titel={`${nameVon(sitz)}: ${e ? 'fertig' : aktiv && dran.includes(sitz) ? 'trinkt gerade' : 'wartet'}`}
                />
                <span className="pressen-bahn-name truncate">
                  {nameVon(sitz)}
                  {r ? ` · ${r}` : ''}
                </span>
                <span className="pressen-bahn-stand">
                  {e
                    ? `${sek(e.dauerMs)} · ${ml(e.verschuettetDezi)}`
                    : aktiv && dran.includes(sitz)
                      ? 'trinkt …'
                      : 'wartet'}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {mySeat != null && (
        <div className="pressen-malus" data-testid="pressen-malus">
          <span id="pressen-malus-label">Reaktions-Malus</span>
          <div
            className="pressen-malus-balken"
            role="meter"
            aria-labelledby="pressen-malus-label"
            aria-valuemin={0}
            aria-valuemax={MALUS_MAX_MS}
            aria-valuenow={malusJetzt}
            aria-valuetext={
              spiegel
                ? 'aus, solange du gegen den Spiegel übst'
                : `${malusJetzt} Millisekunden Verzögerung`
            }
          >
            <span style={{ width: `${(malusJetzt / MALUS_MAX_MS) * 100}%` }} />
          </div>
          <span className="pressen-malus-wert">
            {spiegel ? 'aus (Spiegel)' : `${malusJetzt} ms`}
          </span>
        </div>
      )}

      {zeigeListe && ergebnisListe.some((e) => e != null) && (
        <section className="pressen-wertung" aria-label="Wertung">
          <h3>{state.fertig ? 'Endwertung' : `Runde ${state.runde - 1}`}</h3>
          <ol>
            {ergebnisListe.map((e, sitz) =>
              e ? (
                <li key={sitz} className={state.sieger.includes(sitz) ? 'ist-sieger' : undefined}>
                  <span className="truncate">
                    {state.sieger.includes(sitz) ? '👑 ' : ''}
                    {nameVon(sitz)}
                    {rolle(state, sitz) ? ` · ${rolle(state, sitz)}` : ''}
                    {state.ampel === sitz ? ' (nicht gewertet)' : ''}
                  </span>
                  <span>
                    {sek(e.dauerMs)} + {ml(e.verschuettetDezi)} →{' '}
                    <strong>{sek(e.wertungMs)}</strong>
                    {e.getruemmert ? ' 🏅' : ''}
                  </span>
                </li>
              ) : null,
            )}
          </ol>
          {state.fertig && state.teamWertung && state.modus === 'staffette' && (
            <p className="game-hint">
              Team A {sek(state.teamWertung[0]!)} : Team B {sek(state.teamWertung[1]!)}
            </p>
          )}
        </section>
      )}

      {zaehlerAuszeichnung > 0 && (
        <p className="game-hint" data-testid="pressen-auszeichnung">
          🏅 getrümmert × {zaehlerAuszeichnung}
        </p>
      )}

      {mySeat != null && spiegel && (
        <p className="game-hint">
          Gegen den Spiegel trinkt das zweite Männchen genau wie du – es bleibt bei Atempo, bis du
          oben „Aufgeben“ wählst.
        </p>
      )}

      <BoardStatus session={session} />
    </div>
  );
}
