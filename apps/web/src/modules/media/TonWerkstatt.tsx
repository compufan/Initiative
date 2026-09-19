import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  KLANGPROFILE,
  REGLER_NEUTRAL,
  profilFinden,
  profilKette,
  reglerKette,
} from '../../lib/ton/profile.js';
import type { ProfilName, Regler } from '../../lib/ton/profile.js';
import { fassungBeruehrt, tonLesen, tonRendern } from '../../lib/ton/rendern.js';
import type { Fassung, Tonquelle } from '../../lib/ton/rendern.js';
import { stilleGrenzen } from '../../lib/ton/stille.js';
import { toast } from '../../state/ui.js';
import { errorMessage, formatClock } from './helpers.js';

/**
 * Die Tonwerkstatt: zuschneiden, Stille wegnehmen, verzerren.
 *
 * Steht an zwei Stellen – bei der Sprachnachricht und beim Sticker mit Ton –
 * und weiss von keiner der beiden etwas. Sie bekommt einen Blob und gibt einen
 * zurück.
 *
 * # Warum die Wellenform aus `<span>`-Balken besteht und nicht aus einer Leinwand
 *
 * Damit Hell und Dunkel aus dem CSS kommen. Eine Leinwand müsste die Farben
 * selbst kennen, bei jedem Themenwechsel neu zeichnen und bei jeder
 * Auflösungsänderung ihre Grösse nachführen – für hundertachtundzwanzig
 * Rechtecke. Dieselbe Entscheidung wie bei der Sprachblase im Chat.
 *
 * # Warum der Ton erst beim Übernehmen gerechnet wird
 *
 * Vorhören läuft live durch dieselbe Knotenkette, aber in einem gewöhnlichen
 * `AudioContext`. Erst „Übernehmen" legt einen `OfflineAudioContext` an und
 * schreibt eine Datei. So kostet das Drehen an einem Regler nichts, und die
 * teure Rechnung passiert genau einmal.
 */

const EIMER = 128;

export interface TonErgebnis {
  blob: Blob;
  mime: string;
  dauerMs: number;
  /** Ob überhaupt etwas geändert wurde – siehe `fassungBeruehrt`. */
  bearbeitet: boolean;
}

export function TonWerkstatt({
  blob,
  maxSekunden,
  onFertig,
  onAbbruch,
  uebernehmenText = 'Übernehmen',
}: {
  blob: Blob;
  /**
   * Obergrenze für den Ausschnitt.
   *
   * Beim Sticker acht Sekunden – er ist eine Geste, keine Sprachnachricht.
   * Fehlt der Wert, gilt die Länge der Aufnahme.
   */
  maxSekunden?: number;
  onFertig: (ergebnis: TonErgebnis) => void;
  onAbbruch?: () => void;
  uebernehmenText?: string;
}) {
  const [quelle, setQuelle] = useState<Tonquelle | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [spitzen, setSpitzen] = useState<number[]>([]);
  const [beginn, setBeginn] = useState(0);
  const [ende, setEnde] = useState(0);
  const [profil, setProfil] = useState<ProfilName>('ohne');
  const [regler, setRegler] = useState<Regler>({ ...REGLER_NEUTRAL });
  const [laeuft, setLaeuft] = useState(false);
  const [rechnet, setRechnet] = useState(false);
  const [zeiger, setZeiger] = useState<number | null>(null);

  const leiste = useRef<HTMLDivElement | null>(null);
  const hoeren = useRef<{ ctx: AudioContext; knoten: AudioBufferSourceNode } | null>(null);
  const lebt = useRef(true);
  useEffect(() => () => void (lebt.current = false), []);

  /* ---------------------------------------------------------------- Laden */

  useEffect(() => {
    let verworfen = false;
    setQuelle(null);
    setFehler(null);
    void (async () => {
      try {
        const gelesen = await tonLesen(blob);
        if (verworfen) return;
        setQuelle(gelesen);
        setBeginn(0);
        setEnde(maxSekunden ? Math.min(gelesen.dauer, maxSekunden) : gelesen.dauer);
        /*
         * Die Spitzen für die Anzeige aus DENSELBEN Zahlen, die auch
         * geschnitten werden.
         *
         * `waveformFromBlob` aus `lib/upload.ts` täte dasselbe – und läse die
         * Datei ein zweites Mal. Bei fünf Minuten sind das ein paar Sekunden
         * umsonst, und schlimmer: Die Anzeige könnte von dem abweichen, was
         * der Schnitt sieht.
         */
        const werte = gelesen.werte;
        const breite = Math.max(1, Math.floor(werte.length / EIMER));
        const roh: number[] = [];
        for (let i = 0; i < EIMER; i += 1) {
          let spitze = 0;
          for (let j = 0; j < breite; j += 1) {
            const wert = Math.abs(werte[i * breite + j] ?? 0);
            if (wert > spitze) spitze = wert;
          }
          roh.push(spitze);
        }
        const hoechste = Math.max(...roh, 0.001);
        setSpitzen(roh.map((wert) => Math.min(1, wert / hoechste)));
      } catch (ausfall) {
        if (!verworfen) setFehler(errorMessage(ausfall, 'Diese Tondatei liess sich nicht öffnen.'));
      }
    })();
    return () => {
      verworfen = true;
    };
  }, [blob, maxSekunden]);

  /*
   * Wie schnell die Quelle abgespielt wird – aus Profil UND Tonhöhenregler.
   *
   * Die Spezifikation bildet aus beiden EINEN Faktor
   * (`playbackRate * 2^(detune/1200)`). Er wird deshalb hier einmal gebildet
   * und überall verwendet: beim Vorhören, beim Begrenzen des Ausschnitts und
   * in der Anzeige der Länge.
   */
  const tempo = profilFinden(profil).tempo * Math.pow(2, regler.tonhoehe / 12);

  /*
   * Wie lang der Ausschnitt sein darf, damit das ERGEBNIS in die Grenze passt.
   *
   * Bei „Tief" mit −12 Halbtönen zieht das Tempo die Datei auf das
   * Zweikommaachtfache auseinander; der Ausschnitt darf also nur
   * `maxSekunden * tempo` lang sein. Wer stattdessen den Ausschnitt
   * begrenzte, bekäme einen Sticker, dessen Abzeichen acht Sekunden behauptet
   * und der dreimal so lang klingt.
   */
  const ausschnittMax = maxSekunden ? maxSekunden * tempo : Number.POSITIVE_INFINITY;

  /* ------------------------------------------------------------- Vorhören */

  const anhalten = useCallback(() => {
    const lauf = hoeren.current;
    hoeren.current = null;
    if (lauf) {
      try {
        lauf.knoten.stop();
      } catch {
        /* schon vorbei */
      }
      void lauf.ctx.close();
    }
    setLaeuft(false);
    setZeiger(null);
  }, []);

  useEffect(() => anhalten, [anhalten]);

  /*
   * Beim Wechsel von Profil oder Reglern hört das Vorhören auf.
   *
   * Eine Kette lässt sich nicht im Lauf umbauen; wer es versucht, hört den
   * alten Klang weiter und hält den neuen Knopf für wirkungslos.
   */
  useEffect(() => {
    anhalten();
  }, [profil, regler, beginn, ende, anhalten]);

  const vorhoeren = () => {
    if (!quelle) return;
    if (laeuft) {
      anhalten();
      return;
    }
    const Ctor =
      window.AudioContext ??
      (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) {
      toast('Dieser Browser kann keinen Ton abspielen.', 'error');
      return;
    }
    const ctx = new Ctor();
    /*
     * `resume()` IN der Klickbehandlung, nicht in einem Effekt.
     *
     * Auf iOS startet ein `AudioContext` nur aus einer Nutzergeste heraus.
     * Wer ihn in einem Effekt anlegt und dort fortsetzt, bekommt einen
     * Kontext im Zustand „suspended" – und einen Knopf, der auf dem iPhone
     * nichts tut und sonst überall funktioniert.
     */
    void ctx.resume();

    const puffer = ctx.createBuffer(1, quelle.werte.length, quelle.rate);
    puffer.getChannelData(0).set(quelle.werte);
    const knoten = ctx.createBufferSource();
    knoten.buffer = puffer;
    knoten.playbackRate.value = tempo;
    reglerKette(ctx, profilKette(ctx, knoten, profil), regler).connect(ctx.destination);

    const laenge = Math.max(0.05, ende - beginn);
    knoten.start(0, beginn, laenge);
    hoeren.current = { ctx, knoten };
    setLaeuft(true);

    const start = ctx.currentTime;
    const takt = window.setInterval(() => {
      if (!hoeren.current) {
        window.clearInterval(takt);
        return;
      }
      const gelaufen = (ctx.currentTime - start) * tempo;
      if (gelaufen >= laenge) {
        window.clearInterval(takt);
        anhalten();
        return;
      }
      setZeiger(beginn + gelaufen);
    }, 60);
    knoten.onended = () => {
      window.clearInterval(takt);
      if (lebt.current) anhalten();
    };
  };

  /* ------------------------------------------------------------- Bedienen */

  /*
   * Zieht das Tempo den Ausschnitt über die Grenze, wandert das Ende mit.
   *
   * Ohne das könnte jemand acht Sekunden wählen, danach auf „Tief" tippen und
   * eine Datei von zweiundzwanzig Sekunden bekommen – ohne dass sich an der
   * Anzeige etwas rührt.
   */
  useEffect(() => {
    if (!maxSekunden) return;
    setEnde((jetzt) => Math.min(jetzt, beginn + maxSekunden * tempo));
  }, [maxSekunden, tempo, beginn]);

  const stilleWeg = () => {
    if (!quelle) return;
    const grenzen = stilleGrenzen(quelle.werte, quelle.rate);
    if (!grenzen.gefunden) {
      toast('Hier ist vorn und hinten keine Stille.', 'info');
      return;
    }
    setBeginn(grenzen.beginn);
    setEnde(maxSekunden ? Math.min(grenzen.ende, grenzen.beginn + maxSekunden) : grenzen.ende);
  };

  /** Einen Griff auf die Stelle unter dem Finger ziehen. */
  const ziehen = (art: 'beginn' | 'ende') => (ereignis: React.PointerEvent) => {
    if (!quelle || !leiste.current) return;
    ereignis.preventDefault();
    const feld = leiste.current;
    const kasten = feld.getBoundingClientRect();
    feld.setPointerCapture?.(ereignis.pointerId);

    const bewegen = (x: number) => {
      const anteil = Math.min(1, Math.max(0, (x - kasten.left) / Math.max(1, kasten.width)));
      const zeit = anteil * quelle.dauer;
      if (art === 'beginn') {
        // Mindestens ein Zehntel Abstand: Zwei Griffe übereinander lassen sich
        // nicht mehr auseinanderziehen, und der Ausschnitt wäre leer.
        setBeginn(Math.min(zeit, ende - 0.1));
      } else {
        const hoechstens = Math.min(quelle.dauer, beginn + ausschnittMax);
        setEnde(Math.max(beginn + 0.1, Math.min(zeit, hoechstens)));
      }
    };
    bewegen(ereignis.clientX);

    const weiter = (e: PointerEvent) => bewegen(e.clientX);
    const schluss = () => {
      window.removeEventListener('pointermove', weiter);
      window.removeEventListener('pointerup', schluss);
      window.removeEventListener('pointercancel', schluss);
    };
    window.addEventListener('pointermove', weiter);
    window.addEventListener('pointerup', schluss);
    window.addEventListener('pointercancel', schluss);
  };

  const fassung: Fassung = useMemo(
    () => ({ profil, regler, beginn, ende }),
    [profil, regler, beginn, ende],
  );

  const uebernehmen = async () => {
    if (!quelle || rechnet) return;
    anhalten();
    /*
     * Wurde nichts angefasst, geht der ORIGINALBLOB durch.
     *
     * Das ist keine Feinheit, sondern der Unterschied zwischen 400 kB und
     * 14 MB: WAV packt nicht, und eine Sprachnachricht, die nur aufgenommen
     * und gleich gesendet wird, hat keinen Grund, durch diese Mühle zu gehen.
     */
    if (!fassungBeruehrt(fassung, quelle)) {
      onFertig({
        blob,
        mime: blob.type || 'audio/webm',
        dauerMs: Math.round(quelle.dauer * 1000),
        bearbeitet: false,
      });
      return;
    }
    setRechnet(true);
    try {
      const fertig = await tonRendern(quelle, fassung);
      if (!lebt.current) return;
      onFertig({ ...fertig, bearbeitet: true });
    } catch (ausfall) {
      toast(errorMessage(ausfall, 'Der Ton liess sich nicht bearbeiten.'), 'error');
    } finally {
      if (lebt.current) setRechnet(false);
    }
  };

  /* -------------------------------------------------------------- Anzeige */

  if (fehler) {
    return (
      <div className="stack">
        <p className="ton-fehler">{fehler}</p>
        {onAbbruch && (
          <button type="button" className="btn" onClick={onAbbruch}>
            Zurück
          </button>
        )}
      </div>
    );
  }
  if (!quelle) return <p className="muted">Ton wird gelesen …</p>;

  const anteil = (zeit: number) => `${Math.min(100, Math.max(0, (zeit / quelle.dauer) * 100))}%`;
  const gewaehlt = ende - beginn;
  const netz = profilFinden(profil);

  return (
    <div className="ton-werkstatt stack">
      {/* ---- Welle mit zwei Griffen ---- */}
      <div className="ton-wave" ref={leiste}>
        {spitzen.map((wert, i) => (
          <span
            // Die Balken haben keine eigene Kennung und wechseln nie ihre
            // Reihenfolge – der Index ist hier der richtige Schlüssel.
            key={i}
            className={`ton-balken${
              (i / EIMER) * quelle.dauer >= beginn && (i / EIMER) * quelle.dauer <= ende
                ? ' ist-drin'
                : ''
            }`}
            style={{ height: `${Math.max(6, wert * 100)}%` }}
          />
        ))}
        <span className="ton-schleier ton-schleier-links" style={{ width: anteil(beginn) }} />
        <span
          className="ton-schleier ton-schleier-rechts"
          style={{ width: anteil(quelle.dauer - ende) }}
        />
        {zeiger !== null && <span className="ton-zeiger" style={{ left: anteil(zeiger) }} />}
        <button
          type="button"
          className="ton-griff ton-griff-links"
          style={{ left: anteil(beginn) }}
          onPointerDown={ziehen('beginn')}
          aria-label="Anfang verschieben"
        />
        <button
          type="button"
          className="ton-griff ton-griff-rechts"
          style={{ left: anteil(ende) }}
          onPointerDown={ziehen('ende')}
          aria-label="Ende verschieben"
        />
      </div>

      <div className="row row-between ton-zeile">
        {/*
            Die Länge des ERGEBNISSES, nicht die des Ausschnitts.

            Bei „Tief" oder „Hoch" sind das zwei verschiedene Zahlen, und die
            erste ist die, die der Empfänger hört. Die zweite steht nur
            daneben, wenn sie abweicht – sonst wäre es dieselbe Zahl zweimal.
        */}
        <span className="muted">
          {formatClock(Math.round((gewaehlt / tempo) * 1000))} Ton
          {Math.abs(tempo - 1) > 0.01 && ` · ${formatClock(Math.round(gewaehlt * 1000))} gewählt`}
        </span>
        <div className="row" style={{ gap: 'var(--space-2)' }}>
          <button type="button" className="btn btn-sm" onClick={stilleWeg}>
            ✂ Stille weg
          </button>
          <button type="button" className="btn btn-sm" onClick={vorhoeren}>
            {laeuft ? '⏹ Stopp' : '▶ Vorhören'}
          </button>
        </div>
      </div>

      {/* ---- Klangprofile ---- */}
      <div className="ton-profile" role="group" aria-label="Klangprofil">
        {KLANGPROFILE.map((eintrag) => (
          <button
            key={eintrag.name}
            type="button"
            className={`ton-profil${profil === eintrag.name ? ' ist-aktiv' : ''}`}
            aria-pressed={profil === eintrag.name}
            onClick={() => setProfil(eintrag.name)}
          >
            <span className="ton-profil-zeichen" aria-hidden="true">
              {eintrag.zeichen}
            </span>
            <span className="ton-profil-titel">{eintrag.titel}</span>
          </button>
        ))}
      </div>
      <p className="ton-hinweis">{netz.beschreibung}</p>

      {/* ---- Regler ---- */}
      <div className="ton-regler">
        <Schieber
          titel={`Tonhöhe ${regler.tonhoehe > 0 ? '+' : ''}${regler.tonhoehe}`}
          /*
           * Der Zusatz ist keine Entschuldigung, sondern die Wahrheit: Die
           * Spezifikation bildet aus Tonhöhe und Tempo EINEN Faktor. Eine
           * echte Trennung bräuchte einen selbst geschriebenen Dehner.
           */
          zusatz="ändert auch das Tempo"
          min={-12}
          max={12}
          wert={regler.tonhoehe}
          setzen={(wert) => setRegler((alt) => ({ ...alt, tonhoehe: wert }))}
        />
        <Schieber
          titel={`Verzerrung ${regler.verzerrung}`}
          min={0}
          max={40}
          wert={regler.verzerrung}
          setzen={(wert) => setRegler((alt) => ({ ...alt, verzerrung: wert }))}
        />
        <Schieber
          titel={`Tiefen ${regler.tiefen > 0 ? '+' : ''}${regler.tiefen} dB`}
          min={-12}
          max={12}
          wert={regler.tiefen}
          setzen={(wert) => setRegler((alt) => ({ ...alt, tiefen: wert }))}
        />
        <Schieber
          titel={`Höhen ${regler.hoehen > 0 ? '+' : ''}${regler.hoehen} dB`}
          min={-12}
          max={12}
          wert={regler.hoehen}
          setzen={(wert) => setRegler((alt) => ({ ...alt, hoehen: wert }))}
        />
        <Schieber
          titel={`Hall ${Math.round(regler.hall * 100)} %`}
          min={0}
          max={100}
          wert={Math.round(regler.hall * 100)}
          setzen={(wert) => setRegler((alt) => ({ ...alt, hall: wert / 100 }))}
        />
      </div>

      <div className="row row-between">
        {onAbbruch ? (
          <button type="button" className="btn" onClick={onAbbruch} disabled={rechnet}>
            Zurück
          </button>
        ) : (
          <span />
        )}
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void uebernehmen()}
          disabled={rechnet}
        >
          {rechnet ? 'Wird gerechnet …' : uebernehmenText}
        </button>
      </div>
    </div>
  );
}

function Schieber({
  titel,
  zusatz,
  min,
  max,
  wert,
  setzen,
}: {
  titel: string;
  zusatz?: string;
  min: number;
  max: number;
  wert: number;
  setzen: (wert: number) => void;
}) {
  return (
    <label className="feld ton-schieber">
      <span>
        {titel}
        {zusatz && <span className="ton-zusatz"> · {zusatz}</span>}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={wert}
        onChange={(ereignis) => setzen(Number(ereignis.target.value))}
      />
    </label>
  );
}
