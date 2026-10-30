import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  GLAS_ML,
  MALUS_MAX_MS,
  MALUS_HALBWERTSZEIT_MS,
  MUND_KAPAZITAET_ML,
  START_FRIST_MS,
  dranSitze,
  driftSeedFuer,
  figurLesen,
  istVerborgen,
  pressen,
  PRESSEN_FIGUR_SCHLUESSEL,
  standardFigur,
  startPhase,
  verzoegerungBei,
  wartetAuf,
  type GameSessionDto,
  type LaufErgebnis,
  type PressenAnsicht,
  type PressenErgebnis,
  type PressenFigurDaten,
  type StartPhase,
  type Taste,
} from '@initiative/shared';
import { useMyId, useSession } from '../../../state/session.js';
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
  type Stimmung,
} from './PressenFigur.js';
import { ergebnisAnzeige } from './pressenErgebnis.js';
import { usePressenVollbild, vollbildWunschLesen } from './pressenVollbild.js';
import { getruemmertMerken, getruemmertZaehler, usePressenLauf } from './pressenLauf.js';

/** Liest den Spielstand vorsichtig – ein unbekannter Stand wird zu einer leeren Runde. */
function lesen(session: GameSessionDto): PressenAnsicht {
  const roh = session.state as Partial<PressenAnsicht> | null;
  if (
    roh &&
    Array.isArray(roh.ergebnisse) &&
    Array.isArray(roh.teams) &&
    Array.isArray(roh.malus)
  ) {
    return roh as PressenAnsicht;
  }
  return pressen.createInitialState(
    session.players.map((player) => ({ seat: player.seat, userId: player.userId })),
  ) as PressenAnsicht;
}

const sek = (ms: number) => `${(ms / 1000).toFixed(1).replace('.', ',')} s`;
const ml = (dezi: number) => `${(dezi / 10).toFixed(1).replace('.', ',')} ml`;

/** Zeigt ein Ergebnis nur, wenn es offen vorliegt (nicht „verborgen“). */
function offen(
  e: PressenErgebnis | { verborgen: true } | null | undefined,
): PressenErgebnis | null {
  return e && !istVerborgen(e) ? e : null;
}

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
  return { links: 8 + (h % 70), oben: 22 + ((h * 31) % 40) };
}

function rolle(state: PressenAnsicht, sitz: number): string | null {
  if (state.ampel === sitz) return 'Ampel';
  if (state.modus === 'staffette') {
    const team = state.teams.findIndex((t) => t.includes(sitz));
    return team >= 0 ? `Team ${'AB'[team]}` : null;
  }
  return null;
}

const ALLE_AUS: Record<Taste, boolean> = {
  links: false,
  rechts: false,
  hoch: false,
  runter: false,
  neigen: false,
};

/**
 * Pressen: das Bier so schnell wie möglich trinken, ohne etwas zu verschütten.
 *
 * Der eigene Lauf rechnet dieser Client (Physik im gemeinsamen Paket) und
 * meldet nur das Ergebnis als Zug; der Server wertet. Fremde Läufe sind bis
 * zum Rundenende nur als „fertig“ zu sehen (der Server schickt nicht mehr).
 */
export function PressenBoard({ session, mySeat, onMove, busy, onRematch }: GameBoardProps) {
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

  /* ---- Figuren: eigene aus dem Konto, fremde aus der Partie ---- */
  const eigeneGespeichert = useSession(
    (s) => s.user?.settings?.modules?.[PRESSEN_FIGUR_SCHLUESSEL],
  );
  const figurVon = (sitz: number): PressenFigurDaten => {
    const userId = session.players.find((p) => p.seat === sitz)?.userId ?? `sitz${sitz}`;
    const roh =
      userId === myId
        ? (eigeneGespeichert ?? session.figuren?.[userId])
        : session.figuren?.[userId];
    return figurLesen(roh) ?? standardFigur(userId);
  };

  const aktiv = session.status === 'active' && !state.fertig;
  const dran = dranSitze(state);
  const meinErgebnis: PressenErgebnis | null =
    mySeat != null ? offen(state.ergebnisse[mySeat]) : null;
  const ichDran = aktiv && mySeat != null && dran.includes(mySeat);
  const spiegel = state.modus === 'spiegel';

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const vollbild = usePressenVollbild(wrapRef);
  const vollbildRef = useRef(vollbild.aktiv);
  vollbildRef.current = vollbild.aktiv;

  const laufRunde = useRef(state.runde);
  const laufVerz = useRef(0);
  const laufVersatz = useRef<number | null>(null);
  /** Runden, in denen DIESES Gerät gelaufen ist – nur dafür gibt es eine Auszeichnung. */
  const eigeneRunden = useRef(new Set<number>());
  const senden = useCallback(
    (erg: LaufErgebnis) => {
      const versatz = laufVersatz.current;
      onMove({
        typ: 'ergebnis',
        runde: laufRunde.current,
        // Wer später „Anstoßen“ drückt, ist langsamer: Das Warten steckt in der Dauer.
        dauerMs: erg.dauerMs + (versatz ?? 0),
        verschuettetDezi: erg.verschuettetDezi,
        reaktionMs: erg.reaktionMs,
        vorzeitig: erg.vorzeitig,
        verzoegerungMs: laufVerz.current,
        versatzMs: versatz,
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

  /* ---- Serveruhr: `serverTime` der Partie + eigene Laufzeit seither ---- */
  const empfangen = useRef({
    stempel: Date.parse(session.serverTime ?? session.updatedAt),
    perf: performance.now(),
  });
  useEffect(() => {
    empfangen.current = {
      stempel: Date.parse(session.serverTime ?? session.updatedAt),
      perf: performance.now(),
    };
  }, [session]);
  const serverJetzt = useCallback(() => {
    const { stempel, perf } = empfangen.current;
    return (Number.isFinite(stempel) ? stempel : Date.now()) + (performance.now() - perf);
  }, []);

  /* ---- Uhr für Malus-Anzeige und Countdown (schneller, solange einer läuft) ---- */
  const [, uhr] = useState(0);
  const jetzt = serverJetzt();
  const startP: StartPhase | null =
    mySeat != null && ichDran ? startPhase(state, mySeat, jetzt) : null;
  const schnell =
    startP != null &&
    (startP.phase === 'wartet' || startP.phase === 'zaehlt' || startP.phase === 'gestartet');
  useEffect(() => {
    const id = window.setInterval(() => uhr((n) => n + 1), schnell ? 100 : 1000);
    return () => window.clearInterval(id);
  }, [schnell]);

  const meinMalus = mySeat != null ? state.malus[mySeat] : undefined;
  const malusJetzt = meinMalus && !spiegel ? verzoegerungBei(meinMalus, jetzt) : 0;

  /* ---- neue Runde (Atempo) oder fremder Stand: lokalen Lauf zurücksetzen ---- */
  useEffect(() => {
    if (laufRunde.current !== state.runde && laufRef.current.phase !== 'bereit') {
      laufRef.current.zuruecksetzen();
    }
  }, [state.runde]);

  /* ---- Tastatur und Knöpfe ---- */
  const [gedrueckt, setGedrueckt] = useState<Record<Taste, boolean>>(ALLE_AUS);
  const druecke = useCallback((taste: Taste, runter: boolean) => {
    setGedrueckt((alt) => (alt[taste] === runter ? alt : { ...alt, [taste]: runter }));
    if (runter) laufRef.current.druecken(taste);
    else laufRef.current.loslassen(taste);
  }, []);

  const laeuft = lauf.phase === 'laeuft';
  useEffect(() => {
    if (!laeuft) {
      setGedrueckt(ALLE_AUS);
      return undefined;
    }
    const taste = (e: KeyboardEvent): Taste | 'esc' | null => {
      if (e.key === 'ArrowLeft') return 'links';
      if (e.key === 'ArrowRight') return 'rechts';
      if (e.key === 'ArrowUp') return 'hoch';
      if (e.key === 'ArrowDown') return 'runter';
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
      if (t === 'esc') {
        // Ein Esc, das nur das Vollbild schließt, bricht keinen Lauf ab: Der
        // Dialogstapel (lib/dialogVerlauf) hat es dann schon vergeben.
        if (e.defaultPrevented || vollbildRef.current) return;
        e.preventDefault();
        if (runter && !e.repeat) laufRef.current.vorzeitigAbstellen();
        return;
      }
      e.preventDefault();
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
      [state.runde, offen(state.ergebnisse[mySeat])],
      [state.runde - 1, offen(state.vorrunde?.[mySeat])],
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

  /* ---- Anstoßen ---- */
  const anstossen = useCallback(() => {
    if (!ichDran || mySeat == null || laufRef.current.phase !== 'bereit') return;
    const sicht = lesen(session);
    const wann = serverJetzt();
    const phase = startPhase(sicht, mySeat, wann);
    // Vor dem gemeinsamen Beginn gibt es kein „Anstoßen“; danach zählt der
    // Abstand zum Beginn in die eigene Zeit.
    if (phase.phase === 'zaehlt' || phase.phase === 'wahl' || phase.phase === 'wartet') return;
    laufRunde.current = sicht.runde;
    laufVersatz.current =
      phase.phase === 'gestartet' ? Math.max(0, Math.round(wann - phase.beginn)) : null;
    const verz = sicht.modus === 'spiegel' ? 0 : verzoegerungBei(sicht.malus[mySeat]!, wann);
    laufVerz.current = verz;
    laufRef.current.anstossen(verz, driftSeedFuer(sicht.runde));
  }, [ichDran, mySeat, session, serverJetzt]);

  const waehle = (art: 'echtzeit' | 'asynchron') => {
    if (busy) return;
    onMove({ typ: 'start', art });
  };

  /* ---- Stimmung: Schreck beim Verschütten, Freude am Ende ---- */
  const [schreckBis, setSchreckBis] = useState(0);
  const letzteMenge = useRef(0);
  const verschuettetMl = lauf.zustand.verschuettet;
  useEffect(() => {
    if (lauf.phase !== 'laeuft') {
      letzteMenge.current = 0;
      return;
    }
    if (verschuettetMl > letzteMenge.current + 1.5) {
      letzteMenge.current = verschuettetMl;
      setSchreckBis(performance.now() + 900);
    }
  }, [lauf.phase, verschuettetMl]);
  const schreckt = laeuft && performance.now() < schreckBis;
  useEffect(() => {
    if (!schreckt) return undefined;
    const id = window.setTimeout(() => uhr((n) => n + 1), 950);
    return () => window.clearTimeout(id);
  }, [schreckt, schreckBis]);

  /* ---- Ansagen für Vorlesehilfen ---- */
  const [ansage, setAnsage] = useState('');
  const leerGemeldet = useRef(false);
  useEffect(() => {
    if (lauf.phase === 'laeuft') {
      if (!leerGemeldet.current && lauf.zustand.tick < 3) {
        setAnsage(
          'Los! Pfeiltasten bewegen das Glas links, rechts, vor und zurück, die Leertaste neigt es.',
        );
      }
      if (lauf.zustand.leerTick != null && !leerGemeldet.current) {
        leerGemeldet.current = true;
        setAnsage('Glas leer. Der Abstellen-Knopf ist erschienen – schnell drücken.');
      }
    }
    if (lauf.phase === 'bereit') leerGemeldet.current = false;
    if (lauf.phase === 'fertig' && lauf.ergebnis) {
      setAnsage(
        `Abgestellt nach ${sek(lauf.ergebnis.dauerMs + (laufVersatz.current ?? 0))}, ${ml(lauf.ergebnis.verschuettetDezi)} verschüttet.`,
      );
    }
  }, [lauf.phase, lauf.zustand.tick, lauf.zustand.leerTick, lauf.ergebnis]);
  const startKey = startP?.phase ?? '';
  const startAngesagt = useRef('');
  useEffect(() => {
    if (startAngesagt.current === startKey) return;
    startAngesagt.current = startKey;
    if (startKey === 'wahl') setAnsage('Zusammen in Echtzeit oder jeder, wann er will?');
    if (startKey === 'wartet') setAnsage('Bereit. Warte auf die anderen, höchstens zehn Sekunden.');
    if (startKey === 'zaehlt') setAnsage('Alle bereit. Gleich geht es los.');
    if (startKey === 'gestartet') setAnsage('Los! Drücke Anstoßen – die Zeit läuft schon.');
    if (startKey === 'asynchron')
      setAnsage('Ihr spielt unabhängig. Drücke Anstoßen, wenn du bereit bist.');
  }, [startKey]);

  /* ---- Anzeige ---- */
  const wartet = mySeat != null ? wartetAuf(state, mySeat) : null;
  const meinSitzFertig = meinErgebnis != null || lauf.phase === 'fertig';
  const ansichtFuer = (sitz: number): FigurAnsicht => {
    if (state.ergebnisse[sitz])
      return fertigAnsicht(offen(state.ergebnisse[sitz])?.verschuettetDezi ?? null);
    return aktiv && dran.includes(sitz) ? TRINKT : BEREIT;
  };
  const stimmungFuer = (sitz: number): Stimmung => {
    if (state.fertig) return state.sieger.includes(sitz) ? 'sieg' : 'verloren';
    if (state.ergebnisse[sitz]) return 'freude';
    return 'normal';
  };

  const meineAnsicht: FigurAnsicht =
    lauf.phase === 'laeuft' || (lauf.phase === 'fertig' && lauf.ergebnis)
      ? ansichtAus(lauf.zustand)
      : meinErgebnis
        ? fertigAnsicht(meinErgebnis.verschuettetDezi)
        : BEREIT;
  const meineStimmung: Stimmung =
    mySeat != null && state.fertig
      ? stimmungFuer(mySeat)
      : schreckt
        ? 'schreck'
        : meinErgebnis
          ? meinErgebnis.verschuettetDezi < 50
            ? 'freude'
            : 'normal'
          : 'normal';

  const andere = session.players
    .map((p) => p.seat)
    .filter((sitz) => sitz !== mySeat)
    .sort((a, b) => a - b);

  const z = lauf.zustand;
  const verschuettetText = z.verschuettet.toFixed(1).replace('.', ',');
  const versatz = laufVersatz.current ?? 0;
  // Das große Ergebnis: bei entschiedener Partie immer, bei Atempo bis zum nächsten Anstoßen.
  const ergebnis = ergebnisAnzeige(state, mySeat, nameVon);
  const zeigeErgebnis = ergebnis != null && (state.fertig || lauf.phase === 'bereit');
  const runde1Sek = Math.max(
    0,
    Math.ceil((startP?.phase === 'zaehlt' ? startP.beginn - jetzt : 0) / 1000),
  );
  const gestartetSek =
    startP?.phase === 'gestartet' ? Math.max(0, (jetzt - startP.beginn) / 1000) : 0;
  const fristSek =
    startP?.phase === 'wartet' ? Math.max(0, Math.ceil((startP.frist - jetzt) / 1000)) : 0;
  const zeigeAnstossen =
    ichDran &&
    lauf.phase === 'bereit' &&
    !meinErgebnis &&
    startP != null &&
    ['frei', 'asynchron', 'gestartet', 'zaehlt'].includes(startP.phase);
  const kannAnstossen = zeigeAnstossen && startP?.phase !== 'zaehlt' && !busy;
  const wirdZurueckgefallen = startP?.phase === 'asynchron' && startP.grund === 'frist';
  /*
   * Der EINZIGE Weg, einen Lauf zu beginnen: Klick, Tippen, Enter oder Leertaste
   * auf dem Knopf „Anstoßen“ (Enter und Leertaste lösen beim Knopf einen Klick
   * aus – eine Taste auf der Seite sonst nicht). Weder ein Klick ins Brett noch
   * einer daneben, kein Timer und keine Rückkehr zur Seite starten etwas.
   *
   * Der Klick ist zugleich die Nutzergeste, die das Vollbild verlangt – deshalb
   * wird es HIER angefragt, synchron und vor allem anderen. Scheitert es, läuft
   * das Spiel trotzdem (siehe `pressenVollbild.ts`).
   */
  const beimAnstossen = () => {
    if (!kannAnstossen) return;
    if (vollbildWunschLesen()) vollbild.betreten();
    anstossen();
  };

  return (
    <div
      ref={wrapRef}
      className={`game-board-wrap pressen${vollbild.aktiv ? ' is-vollbild' : ''}${vollbild.nativ ? ' is-nativ' : ''}`}
      data-vollbild={vollbild.aktiv ? (vollbild.nativ ? 'nativ' : 'ueberlagerung') : 'aus'}
      data-testid="pressen-brett"
    >
      <p className="visually-hidden" role="status" aria-live="polite" data-testid="pressen-ansage">
        {ansage}
      </p>

      {mySeat != null && (
        <div className="pressen-vollbild-zeile">
          <button
            type="button"
            className="btn btn-sm pressen-vollbild-knopf"
            data-testid="pressen-vollbild"
            aria-pressed={vollbild.aktiv}
            onClick={() => (vollbild.aktiv ? vollbild.beenden(true) : vollbild.betreten(true))}
          >
            {vollbild.aktiv ? '✕ Vollbild beenden' : '⛶ Vollbild'}
          </button>
        </div>
      )}

      {mySeat != null && (
        <div
          className="pressen-feld"
          data-testid="pressen-feld"
          data-phase={lauf.phase}
          data-runde={state.runde}
          data-start-phase={startP?.phase ?? ''}
          data-glas-x={Math.round(z.x)}
          data-glas-y={Math.round(z.y)}
          data-vx={Math.round(z.vx)}
          data-vy={Math.round(z.vy)}
          data-neigung-v={Math.round(z.neigungV)}
          data-neigung={Math.round(z.neigung)}
          data-fuellung={Math.round(z.fuellung)}
          data-mund={Math.round(z.mund)}
          data-verschuettet={Math.round(z.verschuettet)}
          data-leer={z.leerTick != null ? '1' : '0'}
          data-verzoegerung={lauf.verzoegerungMs}
        >
          <div className="pressen-buehne">
            <PressenFigur
              ansicht={meineAnsicht}
              figur={figurVon(mySeat)}
              bewegt={!reduziert}
              stimmung={meineStimmung}
              titel={`Dein Strichmännchen, ${Math.round(meineAnsicht.fuellung)} Milliliter im Glas`}
            />
            {spiegel && (
              <PressenFigur
                ansicht={meineAnsicht}
                figur={figurVon(mySeat)}
                gespiegelt
                klein
                bewegt={!reduziert}
                stimmung={meineStimmung}
                farbe="var(--warning)"
                titel="Spiegelbild: trinkt synchron zu dir"
              />
            )}
          </div>

          {startP?.phase === 'zaehlt' && runde1Sek > 0 && (
            <div className="pressen-zaehler" aria-hidden="true" data-testid="pressen-zaehler">
              {runde1Sek}
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

          {(lauf.phase === 'laeuft' ||
            (startP?.phase === 'gestartet' && lauf.phase === 'bereit')) && (
            <div className="pressen-hud" aria-hidden="true">
              <span>
                Glas <strong>{Math.round(z.fuellung)}</strong>/{GLAS_ML} ml
              </span>
              <span className={z.mund > MUND_KAPAZITAET_ML * 0.8 ? 'is-warn' : undefined}>
                Mund <strong>{Math.round((z.mund / MUND_KAPAZITAET_ML) * 100)}</strong> %
              </span>
              <span>
                Verschüttet <strong>{verschuettetText}</strong> ml
              </span>
              <span>
                Zeit{' '}
                <strong>
                  {lauf.phase === 'laeuft' ? sek(z.tick * 20 + versatz) : sek(gestartetSek * 1000)}
                </strong>
              </span>
              <span className={malusJetzt > MALUS_MAX_MS * 0.5 ? 'is-warn' : undefined}>
                Malus{' '}
                <strong>{lauf.phase === 'laeuft' ? lauf.verzoegerungMs : malusJetzt} ms</strong>
              </span>
            </div>
          )}
        </div>
      )}

      {zeigeErgebnis && ergebnis && (
        <section
          className={`pressen-ergebnis is-${ergebnis.art}`}
          aria-label="Ergebnis"
          data-testid="pressen-ergebnis"
          data-art={ergebnis.art}
        >
          <div role="status" aria-live="polite" aria-atomic="true">
            <p className="pressen-ergebnis-titel" data-testid="pressen-ergebnis-titel">
              <span aria-hidden="true">
                {ergebnis.art === 'sieg'
                  ? '🏆 '
                  : ergebnis.art === 'niederlage'
                    ? '🍺 '
                    : ergebnis.art === 'atempo'
                      ? '🤝 '
                      : '👑 '}
              </span>
              {ergebnis.titel}
            </p>
            {ergebnis.untertitel && (
              <p className="pressen-ergebnis-untertitel">{ergebnis.untertitel}</p>
            )}
          </div>
          {ergebnis.zeilen.length > 0 && (
            <div className="pressen-wertung">
              <h3>{ergebnis.listenTitel}</h3>
              <ol>
                {ergebnis.zeilen.map((zeile) => (
                  <li
                    key={zeile.sitz}
                    className={`${zeile.sieger ? 'ist-sieger' : ''}${zeile.ich ? ' ist-ich' : ''}`}
                    aria-current={zeile.ich ? 'true' : undefined}
                  >
                    <span className="pressen-wertung-name truncate">
                      {zeile.sieger ? '👑 ' : ''}
                      {zeile.name}
                      {zeile.rolle ? ` · ${zeile.rolle}` : ''}
                      {zeile.nichtGewertet ? ' (nicht gewertet)' : ''}
                    </span>
                    <dl className="pressen-wertung-werte">
                      <div>
                        <dt>Zeit</dt>
                        <dd>{sek(zeile.dauerMs)}</dd>
                      </div>
                      <div>
                        <dt>Verschüttet</dt>
                        <dd>{ml(zeile.verschuettetDezi)}</dd>
                      </div>
                      <div>
                        <dt>Score</dt>
                        <dd>
                          <strong>{sek(zeile.wertungMs)}</strong>
                          {zeile.getruemmert ? ' 🏅' : ''}
                        </dd>
                      </div>
                    </dl>
                  </li>
                ))}
              </ol>
            </div>
          )}
          {mySeat != null && (
            <Link
              className="btn btn-block"
              to="/spiele/pressen/statistik"
              data-testid="pressen-ergebnis-statistik"
            >
              📊 Statistik
            </Link>
          )}
          {state.fertig && mySeat != null && onRematch && (
            <button
              type="button"
              className="btn btn-primary btn-block"
              disabled={busy}
              onClick={onRematch}
              data-testid="pressen-revanche"
            >
              🔁 Revanche
            </button>
          )}
        </section>
      )}

      {mySeat != null && lauf.phase === 'laeuft' && (
        <div className="pressen-steuerung">
          <div className="pressen-kreuz" role="group" aria-label="Glas bewegen">
            <button
              type="button"
              className={`pressen-taste pressen-hoch${gedrueckt.hoch ? ' is-gedrueckt' : ''}`}
              aria-label="Glas nach hinten, im Bild nach oben (Pfeiltaste hoch)"
              aria-pressed={gedrueckt.hoch}
              {...halten('hoch')}
            >
              ▲
            </button>
            <button
              type="button"
              className={`pressen-taste pressen-links${gedrueckt.links ? ' is-gedrueckt' : ''}`}
              aria-label="Glas nach links (Pfeiltaste links)"
              aria-pressed={gedrueckt.links}
              {...halten('links')}
            >
              ◀
            </button>
            <button
              type="button"
              className={`pressen-taste pressen-rechts${gedrueckt.rechts ? ' is-gedrueckt' : ''}`}
              aria-label="Glas nach rechts (Pfeiltaste rechts)"
              aria-pressed={gedrueckt.rechts}
              {...halten('rechts')}
            >
              ▶
            </button>
            <button
              type="button"
              className={`pressen-taste pressen-runter${gedrueckt.runter ? ' is-gedrueckt' : ''}`}
              aria-label="Glas nach vorn, im Bild nach unten (Pfeiltaste runter)"
              aria-pressed={gedrueckt.runter}
              {...halten('runter')}
            >
              ▼
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
          data-tipp={`Stellt das Glas sofort ab – was noch drin ist, zählt als verschüttet${vollbild.aktiv ? '' : ' (Esc)'}`}
        >
          Vorzeitig abstellen{vollbild.aktiv ? '' : ' (Esc)'}
        </button>
      )}

      {ichDran && lauf.phase === 'bereit' && !meinErgebnis && startP?.phase === 'wahl' && (
        <div className="stack pressen-start" data-testid="pressen-wahl">
          <p className="game-hint">
            Wie wollt ihr antreten? <strong>Zusammen</strong>: alle bestätigen innerhalb von{' '}
            {START_FRIST_MS / 1000} Sekunden, dann zählt ein gemeinsamer Countdown, und die Zeit
            läuft für alle ab dem Beginn – wer später anstößt, ist langsamer.{' '}
            <strong>Wann ich will</strong>: jeder spielt, wann er mag; die Zeit zählt ab deinem
            Anstoßen.
          </p>
          <div className="pressen-wahl-knoepfe">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => waehle('echtzeit')}
            >
              Zusammen (Echtzeit)
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => waehle('asynchron')}
            >
              Wann ich will (asynchron)
            </button>
          </div>
        </div>
      )}

      {ichDran && lauf.phase === 'bereit' && !meinErgebnis && startP?.phase === 'wartet' && (
        <div className="stack pressen-start" data-testid="pressen-wartet">
          <p className="game-hint" role="status">
            Bereit! Warte auf die anderen ({startP.bereit} von {startP.von}) – noch{' '}
            <strong>{fristSek} s</strong>, dann spielt ihr unabhängig.
          </p>
          <button type="button" className="btn" disabled={busy} onClick={() => waehle('asynchron')}>
            Doch lieber: Wann ich will
          </button>
        </div>
      )}

      {zeigeAnstossen && (
        <div className="stack pressen-start">
          {startP?.phase === 'zaehlt' && (
            <p className="game-hint" role="status">
              Gleich geht es los – alle sind bereit.
            </p>
          )}
          {startP?.phase === 'gestartet' && (
            <p className="game-hint" role="status">
              Die Zeit läuft:{' '}
              <strong data-testid="pressen-versatz">{sek(gestartetSek * 1000)}</strong>. Jede
              Sekunde bis zum Anstoßen kostet dich Zeit.
            </p>
          )}
          {startP?.phase === 'asynchron' && (
            <p className="game-hint" role="status" data-testid="pressen-async-hinweis">
              {wirdZurueckgefallen
                ? 'Nicht alle waren rechtzeitig bereit – ihr spielt unabhängig. Deine Zeit zählt ab deinem Anstoßen.'
                : 'Ihr spielt unabhängig, jeder wann er will. Deine Zeit zählt ab deinem Anstoßen.'}
            </p>
          )}
          <button
            type="button"
            className="btn btn-primary btn-block pressen-anstossen"
            onClick={beimAnstossen}
            disabled={!kannAnstossen}
            data-testid="pressen-anstossen"
          >
            🍻 Anstoßen
          </button>
          <p className="game-hint">
            Pfeiltasten: Glas bewegen (links, rechts, vor, zurück) · Leertaste (oder Knopf) halten:
            neigen · {vollbild.aktiv ? 'Esc: Vollbild verlassen' : 'Esc: vorzeitig abstellen'}. Je
            länger du hältst, desto schneller wird es.
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
            ? `${nameVon(state.ampel ?? 0)} macht die Ampel – du startest, sobald das Glas abgestellt ist. Deine Zeit zählt ab deinem Anstoßen.`
            : 'Dein Teamkollege ist noch dran – du startest, sobald er abgestellt hat. Deine Zeit zählt ab deinem Anstoßen.'}
        </p>
      )}

      {aktiv && meinErgebnis && (
        <p className="game-hint" role="status" data-testid="pressen-eigenes-ergebnis">
          Dein Lauf: {sek(meinErgebnis.dauerMs)}, {ml(meinErgebnis.verschuettetDezi)} verschüttet →
          Wertung {sek(meinErgebnis.wertungMs)}
          {meinErgebnis.versatzMs > 0
            ? ` (davon ${sek(meinErgebnis.versatzMs)} bis zum Anstoßen)`
            : ''}
          {meinErgebnis.getruemmert ? ' · 🏅 getrümmert!' : ''}. Die Ergebnisse der anderen siehst
          du, sobald alle fertig sind.
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
            const offenesE = offen(e);
            return (
              <li key={sitz} className={`pressen-bahn ${seatClass(sitz)}`}>
                <PressenFigur
                  klein
                  gespiegelt
                  ansicht={ansichtFuer(sitz)}
                  figur={figurVon(sitz)}
                  bewegt={!reduziert}
                  stimmung={stimmungFuer(sitz)}
                  farbe="var(--seat)"
                  titel={`${nameVon(sitz)}: ${e ? 'fertig' : aktiv && dran.includes(sitz) ? 'trinkt gerade' : 'wartet'}`}
                />
                <span className="pressen-bahn-name truncate">
                  {nameVon(sitz)}
                  {r ? ` · ${r}` : ''}
                </span>
                <span className="pressen-bahn-stand" data-testid="pressen-bahn-stand">
                  {offenesE
                    ? `${sek(offenesE.dauerMs)} · ${ml(offenesE.verschuettetDezi)}`
                    : e
                      ? 'fertig'
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
          <span id="pressen-malus-label">Malus (Ermüdung)</span>
          <div
            className="pressen-malus-balken"
            role="meter"
            aria-labelledby="pressen-malus-label"
            aria-describedby="pressen-malus-erklaerung"
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
          <span id="pressen-malus-erklaerung" className="visually-hidden">
            Je mehr du in kurzer Zeit spielst, desto später reagieren die Tasten, desto weiter
            gleitet das Glas nach dem Loslassen und desto stärker driftet es. Der Malus klingt in{' '}
            {Math.round(MALUS_HALBWERTSZEIT_MS / 60000)} Minuten zur Hälfte ab.
          </span>
        </div>
      )}
      {mySeat != null && !spiegel && (
        <p className="game-hint pressen-malus-text">
          Der Malus wächst mit jedem Lauf: Tasten reagieren später, das Glas gleitet weiter, die
          Bewegung wird träger. In {Math.round(MALUS_HALBWERTSZEIT_MS / 60000)} Minuten ist er zur
          Hälfte weg.
        </p>
      )}

      {mySeat != null && !vollbild.aktiv && lauf.phase === 'bereit' && !meinErgebnis && (
        <div className="pressen-figur-zeile">
          <Link className="btn" to="/spiele?figur=1" data-testid="pressen-figur-aendern">
            🎨 Mein Strichmännchen
          </Link>
        </div>
      )}

      {zaehlerAuszeichnung > 0 && (
        <p className="game-hint" data-testid="pressen-auszeichnung">
          🏅 getrümmert × {zaehlerAuszeichnung}
        </p>
      )}

      {mySeat != null && spiegel && (
        <p className="game-hint">
          Gegen den Spiegel trinkt das zweite Männchen genau wie du – es gibt immer Atempo. Jede
          weitere Runde beginnt erst, wenn du auf „Anstoßen“ drückst; „Aufgeben“ beendet die Übung.
          Der Malus wächst dabei nicht.
        </p>
      )}

      <BoardStatus session={session} />
    </div>
  );
}
