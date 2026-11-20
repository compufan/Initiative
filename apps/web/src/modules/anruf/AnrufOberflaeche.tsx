import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { anrufDauer } from '@initiative/shared';
import { Avatar } from '../../components/Avatar.js';
import { useChat } from '../../state/chat.js';
import { memberName } from '../messenger/helpers.js';
import {
  ablehnen,
  annehmen,
  auflegen,
  kameraSchalten,
  kameraWechseln,
  lautsprecherUmschalten,
  lautsprecherWaehlbar,
  nachholen,
  stummSchalten,
  useAnruf,
} from './anruf.js';
import { endeText } from './klingelZustand.js';

/**
 * Ein Medienstrom an einem `<video>`/`<audio>` – React kennt `srcObject` nicht.
 * Ein Rückruf-Ref, damit auch ein Element, das erst später erscheint (Phase
 * wechselt, Strom bleibt), den Strom bekommt.
 */
function useStrom<T extends HTMLMediaElement>(strom: MediaStream | null) {
  const ref = useRef<T | null>(null);
  const setzen = useCallback(
    (element: T | null) => {
      ref.current = element;
      if (!element) return;
      if (element.srcObject !== strom) element.srcObject = strom;
      if (strom) void element.play().catch(() => {});
    },
    [strom],
  );
  return [ref, setzen] as const;
}

const QUALITAET_TEXT = {
  gut: 'Verbindung gut',
  mittel: 'Verbindung mittel',
  schlecht: 'Verbindung schlecht',
};

/**
 * Die Anruf-Oberfläche: eingehend (Annehmen/Ablehnen), ausgehend (klingelt),
 * im Gespräch (Stumm, Kamera, Kamera wechseln, Lautsprecher, Auflegen, Dauer,
 * Qualität). Liegt als Überlagerung über der ganzen App – auch ein Anruf,
 * der kommt, während man in den Einstellungen ist, wird gesehen.
 */
export function AnrufOberflaeche() {
  const anruf = useAnruf();
  const location = useLocation();
  const chat = useChat((state) =>
    anruf.conversationId ? state.conversations.find((c) => c.id === anruf.conversationId) : null,
  );
  const mitglied = chat?.members.find((m) => m.userId === anruf.gegenueber) ?? null;
  const name = mitglied ? memberName(mitglied) : 'Unbekannt';
  const [jetzt, setJetzt] = useState(Date.now());
  const annehmenRef = useRef<HTMLButtonElement | null>(null);
  const auflegenRef = useRef<HTMLButtonElement | null>(null);
  const [entferntVideo, entferntVideoSetzen] = useStrom<HTMLVideoElement>(
    anruf.video ? anruf.entfernt : null,
  );
  const [entferntTon, entferntTonSetzen] = useStrom<HTMLAudioElement>(
    anruf.video ? null : anruf.entfernt,
  );
  const [, lokalVideoSetzen] = useStrom<HTMLVideoElement>(anruf.video ? anruf.lokal : null);

  // Aus einer Mitteilung geöffnet: `/chats/…?anruf=<id>`.
  useEffect(() => {
    const id = new URLSearchParams(location.search).get('anruf');
    if (id) void nachholen(id);
  }, [location.search]);

  useEffect(() => {
    if (anruf.phase !== 'verbunden') return undefined;
    const takt = window.setInterval(() => setJetzt(Date.now()), 1000);
    return () => window.clearInterval(takt);
  }, [anruf.phase]);

  // Fokus dorthin, wo die nächste Handlung liegt.
  useEffect(() => {
    if (anruf.phase === 'klingelt_ein') annehmenRef.current?.focus();
    else if (anruf.phase === 'klingelt_aus' || anruf.phase === 'verbindet')
      auflegenRef.current?.focus();
  }, [anruf.phase]);

  // Lautsprecher: zwischen Standard und einem anderen Ausgabegerät wechseln.
  useEffect(() => {
    const element = (anruf.video ? entferntVideo.current : entferntTon.current) as
      (HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (!element?.setSinkId || !navigator.mediaDevices?.enumerateDevices) return;
    void navigator.mediaDevices.enumerateDevices().then((geraete) => {
      const ausgaenge = geraete.filter((g) => g.kind === 'audiooutput');
      const ziel = anruf.lautsprecher
        ? (ausgaenge.find((g) => /speaker|lautsprecher/i.test(g.label)) ??
          ausgaenge.find((g) => g.deviceId !== 'default'))
        : ausgaenge.find((g) => g.deviceId === 'default');
      if (ziel) void element.setSinkId?.(ziel.deviceId).catch(() => {});
    });
  }, [anruf.lautsprecher, anruf.video, entferntTon, entferntVideo]);

  if (anruf.phase === 'ruhe') return null;

  const art = anruf.video ? 'Videoanruf' : 'Sprachanruf';
  const status =
    anruf.phase === 'klingelt_ein'
      ? `${art} – eingehend`
      : anruf.phase === 'waehlt'
        ? 'Ruft an …'
        : anruf.phase === 'klingelt_aus'
          ? 'Klingelt …'
          : anruf.phase === 'verbindet'
            ? 'Verbinde …'
            : anruf.phase === 'verbunden'
              ? anruf.wackelt
                ? 'Verbindung wird gesucht …'
                : 'Verbunden'
              : (anruf.hinweis ?? endeText(anruf.grund, anruf.richtung));
  const dauer =
    anruf.phase === 'verbunden' && anruf.verbundenSeit
      ? anrufDauer((jetzt - anruf.verbundenSeit) / 1000)
      : null;
  const imGespraech = anruf.phase === 'verbunden' || anruf.phase === 'verbindet';
  const zeigeVideo = anruf.video && imGespraech;

  return (
    <div
      className={`anruf${zeigeVideo ? ' anruf-video' : ''}${anruf.phase === 'klingelt_ein' ? ' anruf-klingelt' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="anruf-titel"
      aria-describedby="anruf-status"
      onKeyDown={(ereignis) => {
        if (ereignis.key === 'Escape' && anruf.phase === 'klingelt_ein') ablehnen();
      }}
    >
      {zeigeVideo && (
        <>
          <video
            ref={entferntVideoSetzen}
            className="anruf-fern"
            autoPlay
            playsInline
            aria-label={`Video von ${name}`}
          />
          <video
            ref={lokalVideoSetzen}
            className={`anruf-eigen${anruf.frontKamera ? ' anruf-spiegel' : ''}`}
            autoPlay
            playsInline
            muted
            aria-label="Eigenes Kamerabild"
          />
        </>
      )}
      {!anruf.video && <audio ref={entferntTonSetzen} autoPlay />}

      <div className="anruf-kopf">
        {!zeigeVideo && (
          <Avatar
            name={name}
            id={anruf.gegenueber ?? 'anruf'}
            url={mitglied?.user.avatarUrl ?? null}
            size={96}
          />
        )}
        <h2 id="anruf-titel" className="anruf-name">
          {name}
        </h2>
        <p id="anruf-status" className="anruf-status" aria-live="polite" data-phase={anruf.phase}>
          {status}
          {dauer && (
            <>
              {' · '}
              <span className="anruf-dauer" aria-label={`Dauer ${dauer}`}>
                {dauer}
              </span>
            </>
          )}
        </p>
        {anruf.phase === 'verbunden' && anruf.qualitaet && (
          <p className={`anruf-qualitaet anruf-qualitaet-${anruf.qualitaet}`}>
            <span aria-hidden="true">●</span> {QUALITAET_TEXT[anruf.qualitaet]}
          </p>
        )}
      </div>

      {anruf.phase === 'klingelt_ein' && (
        <div className="anruf-knoepfe">
          <button
            type="button"
            className="anruf-rund anruf-rot"
            onClick={ablehnen}
            aria-label="Ablehnen"
          >
            <span aria-hidden="true">✕</span>
            <span className="anruf-beschriftung">Ablehnen</span>
          </button>
          <button
            ref={annehmenRef}
            type="button"
            className="anruf-rund anruf-gruen"
            onClick={() => void annehmen()}
            aria-label="Annehmen"
          >
            <span aria-hidden="true">{anruf.video ? '🎥' : '📞'}</span>
            <span className="anruf-beschriftung">Annehmen</span>
          </button>
        </div>
      )}

      {(anruf.phase === 'waehlt' || anruf.phase === 'klingelt_aus' || imGespraech) && (
        <div className="anruf-knoepfe">
          {imGespraech && (
            <button
              type="button"
              className={`anruf-rund${anruf.stumm ? ' anruf-an' : ''}`}
              onClick={stummSchalten}
              aria-pressed={anruf.stumm}
              aria-label="Stumm"
            >
              <span aria-hidden="true">{anruf.stumm ? '🔇' : '🎙️'}</span>
              <span className="anruf-beschriftung">Stumm</span>
            </button>
          )}
          {imGespraech && anruf.video && (
            <button
              type="button"
              className={`anruf-rund${anruf.kameraAus ? ' anruf-an' : ''}`}
              onClick={kameraSchalten}
              aria-pressed={anruf.kameraAus}
              aria-label="Kamera aus"
            >
              <span aria-hidden="true">{anruf.kameraAus ? '🚫' : '📷'}</span>
              <span className="anruf-beschriftung">Kamera aus</span>
            </button>
          )}
          {imGespraech && anruf.video && (
            <button
              type="button"
              className="anruf-rund"
              onClick={() => void kameraWechseln()}
              aria-label="Kamera wechseln"
            >
              <span aria-hidden="true">🔄</span>
              <span className="anruf-beschriftung">Wechseln</span>
            </button>
          )}
          {imGespraech && lautsprecherWaehlbar() && (
            <button
              type="button"
              className={`anruf-rund${anruf.lautsprecher ? ' anruf-an' : ''}`}
              onClick={lautsprecherUmschalten}
              aria-pressed={anruf.lautsprecher}
              aria-label="Lautsprecher"
            >
              <span aria-hidden="true">🔊</span>
              <span className="anruf-beschriftung">Lautsprecher</span>
            </button>
          )}
          <button
            ref={auflegenRef}
            type="button"
            className="anruf-rund anruf-rot"
            onClick={auflegen}
            aria-label="Auflegen"
          >
            <span aria-hidden="true">✆</span>
            <span className="anruf-beschriftung">Auflegen</span>
          </button>
        </div>
      )}
    </div>
  );
}
