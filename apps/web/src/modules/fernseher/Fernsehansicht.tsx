import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AttachmentDto } from '@initiative/shared';
import { useDialogAnmeldung } from '../../lib/dialogAnmeldung.js';
import { imKreis } from '../../tv/ablauf.js';
import { reihenfolge } from '../../tv/mischen.js';
import { mediaSrc } from '../media/helpers.js';
import { startStelle, vollbildVerlassen, wischSchritt } from './fernsehansicht.js';

/**
 * Die Fernsehansicht – das, was ein gespiegeltes Telefon zeigen soll.
 *
 * # Wofür sie da ist
 *
 * Der dritte Weg auf den Fernseher: Das TELEFON spiegelt (Smart View,
 * „Übertragen", AirPlay-Bildschirmsynchronisierung), und die App zeigt dafür
 * eine Ansicht, die auf einem Fernseher gut aussieht – schwarz, randlos, quer,
 * gross, ohne Kopfzeile, Leiste und Hinweise der App. Warum es diesen Weg
 * neben Chromecast und dem Code gibt, steht in `spiegeln.ts`.
 *
 * Die Medien lädt das Telefon wie überall in der App: über die eigene Adresse
 * mit dem eigenen Keks. Der Fernseher bekommt keine Adresse und keine
 * Eintrittskarte – er sieht nur Bildpunkte. Damit spielt auch das Format keine
 * Rolle mehr: Was das Telefon abspielt, erscheint auch dort.
 *
 * # Die iPhone-Falle, um die hier alles gebaut ist
 *
 * Bei laufender AirPlay-Synchronisierung übergibt iOS ein Video an den
 * Fernseher, sobald es im VOLLBILD der Videosteuerung läuft: Der Fernseher
 * holt dann die Adresse selbst – ohne Keks, oft in einem Format, das AirPlay
 * nicht kann – und bleibt schwarz. WebKit tut das nur im Standard-Vollbild,
 * nie für ein Video im Bild. Deshalb laufen Videos hier:
 *
 *   * **im Bild** (`playsInline`), ohne die eingebaute Steuerung – es gibt
 *     also keinen Vollbildknopf, den man drücken könnte;
 *   * mit **`x-webkit-wirelessvideoplaybackdisabled`**, dem einzigen Schalter,
 *     der in WebKit die Übergabe wirklich abstellt (`disableRemotePlayback`
 *     allein nimmt nur den Knopf weg, siehe `MediaPlayerPrivateAVFoundation`);
 *   * und das Vollbild der ganzen SEITE wird auf iOS gar nicht erst versucht
 *     (`vollbildVersuchen`).
 *
 * # Warum ein einziges Videoelement für alle Videos
 *
 * Safari erlaubt Ton ohne Fingertipp nur einem Element, das schon einmal auf
 * einen Fingertipp hin gespielt hat. Wer beim ersten Video auf „Tippen für
 * Ton" drückt, soll das beim zweiten nicht noch einmal müssen – also bleibt
 * es dasselbe Element, und nur seine Adresse wechselt.
 */
export function Fernsehansicht({
  stuecke,
  start = 0,
  modus = 'linear',
  sekunden = 6,
  onClose,
}: {
  stuecke: AttachmentDto[];
  /** Welches Stück zuerst – in der Reihenfolge von `stuecke`. */
  start?: number;
  modus?: 'linear' | 'zufall';
  /** Wie lange ein Foto steht. Videos laufen immer ganz durch. */
  sekunden?: number;
  onClose: () => void;
}) {
  const anzahl = stuecke.length;
  /*
   * Gemischt mit derselben Rechnung wie auf dem Fernsehblatt und bei Cast
   * (`tv/mischen.ts`) – eine Saat, eine Liste. Die Saat ist hier zufällig:
   * Es gibt kein zweites Gerät, das dieselbe Reihenfolge kennen müsste.
   */
  const folge = useMemo(
    () => reihenfolge(anzahl, modus, (Math.random() * 4294967296) >>> 0),
    [anzahl, modus],
  );
  const [stelle, setStelle] = useState(() => startStelle(start, anzahl, modus));
  const [pausiert, setPausiert] = useState(false);
  const [leiste, setLeiste] = useState(true);
  const [stumm, setStumm] = useState(false);
  const [meldung, setMeldung] = useState('');
  const [bildBereit, setBildBereit] = useState(false);
  const filmRef = useRef<HTMLVideoElement | null>(null);
  const druck = useRef<{ x: number; y: number } | null>(null);
  const gewischt = useRef(false);

  const stueck = anzahl > 0 ? stuecke[folge[imKreis(stelle, anzahl)]] : undefined;
  const istVideo = Boolean(stueck && (stueck.kind === 'video' || stueck.mime.startsWith('video/')));

  // Zurück-Taste und Esc schliessen die Ansicht – über den gemeinsamen Stapel.
  useDialogAnmeldung(true, onClose);

  const gehe = useCallback(
    (richtung: number) => {
      if (anzahl < 2) return;
      setStelle((jetzt) => imKreis(jetzt + richtung, anzahl));
      setBildBereit(false);
      setMeldung('');
    },
    [anzahl],
  );

  const spielen = useCallback(() => {
    const film = filmRef.current;
    if (!film) return;
    film.play().catch((grund: unknown) => {
      if (grund instanceof Error && grund.name === 'AbortError') return;
      if (!film.muted) {
        /*
         * Mit Ton ging es nicht – das Telefon verlangt dafür einen Fingertipp,
         * und die Diashow schaltet ohne einen weiter. Dann stumm weiter, mit
         * einem grossen „Tippen für Ton", statt stehenzubleiben.
         */
        film.muted = true;
        setStumm(true);
        film.play().catch(() => setMeldung('Dieses Video lässt sich hier nicht abspielen.'));
        return;
      }
      setMeldung('Dieses Video lässt sich hier nicht abspielen.');
    });
  }, []);

  /*
   * Die App tritt zurück, solange die Ansicht offen ist.
   *
   * `fernsehansicht-offen` am Körper blendet die Hinweise der App aus
   * (Meldungen, Tipps, den Fernsehbalken) – alles, was sonst mitten auf dem
   * Fernseher auftauchte. Die Mitteilungen des TELEFONS kann eine Seite nicht
   * abstellen; das sagt die Anleitung vorher (`mitteilungenAbschalten`).
   *
   * Der Bildschirm bleibt wach: Eine Diashow ohne Fingertipp gilt dem Telefon
   * als Untätigkeit, und nach einer halben Minute wäre der Fernseher schwarz.
   * Nach dem Zurückkommen in die App wird die Sperre neu geholt – der Browser
   * gibt sie beim Wechsel in den Hintergrund von selbst frei.
   */
  useEffect(() => {
    document.body.classList.add('fernsehansicht-offen');
    const vorher = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    let sperre: { release: () => Promise<void> } | null = null;
    let offen = true;
    const wach = (
      navigator as Navigator & {
        wakeLock?: { request: (art: 'screen') => Promise<{ release: () => Promise<void> }> };
      }
    ).wakeLock;
    const wachhalten = () => {
      if (!wach || document.visibilityState !== 'visible') return;
      wach
        .request('screen')
        .then((neu) => {
          if (offen) sperre = neu;
          else void neu.release().catch(() => undefined);
        })
        .catch(() => undefined);
    };
    wachhalten();
    document.addEventListener('visibilitychange', wachhalten);
    return () => {
      offen = false;
      document.removeEventListener('visibilitychange', wachhalten);
      void sperre?.release().catch(() => undefined);
      document.body.classList.remove('fernsehansicht-offen');
      document.body.style.overflow = vorher;
      vollbildVerlassen();
    };
  }, []);

  // Die Schalter gegen die iPhone-Falle – einmal, am einen Element.
  useEffect(() => {
    const film = filmRef.current;
    if (!film) return;
    film.setAttribute('x-webkit-wirelessvideoplaybackdisabled', '');
    film.setAttribute('x-webkit-airplay', 'deny');
    film.disableRemotePlayback = true;
    film.disablePictureInPicture = true;
  }, []);

  // Pfeile und Leertaste – für den Rechner am Fernseher und für Tastaturen.
  useEffect(() => {
    const taste = (ereignis: KeyboardEvent) => {
      if (ereignis.key === 'ArrowRight') gehe(1);
      else if (ereignis.key === 'ArrowLeft') gehe(-1);
      else if (ereignis.key === ' ') setPausiert((jetzt) => !jetzt);
      else return;
      ereignis.preventDefault();
      setLeiste(true);
    };
    window.addEventListener('keydown', taste);
    return () => window.removeEventListener('keydown', taste);
  }, [gehe]);

  // Ein Stück wechselt: das Video laden oder leeren.
  useEffect(() => {
    const film = filmRef.current;
    if (!film) return;
    if (!istVideo || !stueck) {
      film.pause();
      film.removeAttribute('src');
      film.load();
      return;
    }
    film.src = mediaSrc(stueck);
    film.muted = stumm;
    if (!pausiert) spielen();
    // Nur beim Wechsel des Stücks – Pause und Ton haben eigene Wege.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stueck?.id, istVideo]);

  // Pause am selben Element – nie neu laden (siehe das Fernsehblatt).
  useEffect(() => {
    const film = filmRef.current;
    if (!film || !istVideo || !film.src) return;
    if (pausiert) film.pause();
    else if (film.paused && !film.ended) spielen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pausiert]);

  // Die Standzeit eines Fotos – erst ab dem Moment, in dem es zu sehen ist.
  useEffect(() => {
    if (istVideo || pausiert || anzahl < 2 || !bildBereit) return undefined;
    const uhr = window.setTimeout(() => gehe(1), sekunden * 1000);
    return () => window.clearTimeout(uhr);
  }, [stelle, istVideo, pausiert, anzahl, bildBereit, sekunden, gehe]);

  // Was nicht lädt, hält die Schau nicht an – nach drei Sekunden geht es weiter.
  useEffect(() => {
    if (!meldung || pausiert || anzahl < 2) return undefined;
    const uhr = window.setTimeout(() => gehe(1), 3000);
    return () => window.clearTimeout(uhr);
  }, [meldung, pausiert, anzahl, gehe]);

  // Das nächste Foto vorladen, damit es beim Wechsel schon da ist.
  useEffect(() => {
    if (anzahl < 2) return;
    const naechstes = stuecke[folge[imKreis(stelle + 1, anzahl)]];
    if (naechstes && naechstes.kind === 'image') new Image().src = mediaSrc(naechstes);
  }, [stelle, anzahl, folge, stuecke]);

  // Die Leiste verschwindet nach ein paar Sekunden – ausser in der Pause.
  useEffect(() => {
    if (!leiste || pausiert) return undefined;
    const uhr = window.setTimeout(() => setLeiste(false), 3500);
    return () => window.clearTimeout(uhr);
  }, [leiste, pausiert, stelle]);

  const tonAn = (ereignis: { stopPropagation: () => void }) => {
    ereignis.stopPropagation();
    const film = filmRef.current;
    if (!film) return;
    // Im Fingertipp selbst – nur so gibt das Telefon den Ton frei.
    film.muted = false;
    setStumm(false);
    if (!pausiert) spielen();
  };

  return createPortal(
    <div
      className="fa-ansicht"
      role="dialog"
      aria-modal="true"
      aria-label="Fernsehansicht"
      onPointerDown={(ereignis) => {
        druck.current = { x: ereignis.clientX, y: ereignis.clientY };
        gewischt.current = false;
      }}
      onPointerUp={(ereignis) => {
        const anfang = druck.current;
        druck.current = null;
        if (!anfang) return;
        const schritt = wischSchritt(ereignis.clientX - anfang.x, ereignis.clientY - anfang.y);
        if (schritt !== 0) {
          gewischt.current = true;
          gehe(schritt);
        }
      }}
      onClick={() => {
        // Ein Wischen ist kein Tipp – sonst ginge nach jedem Blättern die Leiste auf.
        if (gewischt.current) {
          gewischt.current = false;
          return;
        }
        setLeiste((jetzt) => !jetzt);
      }}
    >
      {stueck && !istVideo && (
        <img
          key={stueck.id}
          className="fa-bild"
          src={mediaSrc(stueck)}
          alt={stueck.fileName ?? 'Foto'}
          draggable={false}
          onLoad={() => setBildBereit(true)}
          onError={() => setMeldung('Dieses Bild liess sich nicht laden.')}
        />
      )}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        ref={filmRef}
        className="fa-film"
        hidden={!istVideo}
        playsInline
        preload="auto"
        onEnded={() => {
          if (!pausiert) gehe(1);
        }}
        onError={() => {
          if (istVideo) setMeldung('Dieses Video lässt sich hier nicht abspielen.');
        }}
      />
      {stumm && istVideo && (
        <button type="button" className="fa-ton" onClick={tonAn}>
          🔇 Tippen für Ton
        </button>
      )}
      {meldung && (
        <p className="fa-meldung" role="status">
          {meldung}
        </p>
      )}
      <div
        className={leiste ? 'fa-leiste ist-sichtbar' : 'fa-leiste'}
        onClick={(ereignis) => ereignis.stopPropagation()}
        onPointerDown={(ereignis) => ereignis.stopPropagation()}
        onPointerUp={(ereignis) => ereignis.stopPropagation()}
      >
        <button
          type="button"
          className="fa-knopf"
          onClick={() => gehe(-1)}
          disabled={anzahl < 2}
          aria-label="Zurück"
        >
          ‹
        </button>
        <button
          type="button"
          className="fa-knopf"
          onClick={() => setPausiert((jetzt) => !jetzt)}
          aria-label={pausiert ? 'Weiter abspielen' : 'Anhalten'}
        >
          {pausiert ? '▶' : '⏸'}
        </button>
        <button
          type="button"
          className="fa-knopf"
          onClick={() => gehe(1)}
          disabled={anzahl < 2}
          aria-label="Weiter"
        >
          ›
        </button>
        <span className="fa-zaehler">
          {anzahl > 0 ? imKreis(stelle, anzahl) + 1 : 0} / {anzahl}
        </span>
        {/* Nur im Hochformat sichtbar – siehe `.fa-quer` in styles.css. */}
        <span className="fa-quer">Telefon quer halten</span>
        <button
          type="button"
          className="fa-knopf fa-schliessen"
          onClick={onClose}
          aria-label="Fernsehansicht beenden"
        >
          ✕
        </button>
      </div>
    </div>,
    document.body,
  );
}
