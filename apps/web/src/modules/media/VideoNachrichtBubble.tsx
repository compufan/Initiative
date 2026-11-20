import { useEffect, useRef, useState } from 'react';
import { formatDuration } from '@initiative/shared';
import type { MessageRendererProps } from '../types.js';
import { PendingMedia } from './MediaFrame.js';
import { claimPlayback, mediaSrc, releasePlayback } from './helpers.js';
import { ringStrich } from './videonachricht.js';

const RING_R = 48;

/**
 * Videonachricht im Kreis: läuft stumm in Schleife, sobald sie zu sehen ist;
 * ein Tipp spielt sie mit Ton von vorn, mit Fortschrittsring; noch ein Tipp
 * hält an. Ohne Rahmen und Unterschrift – wie bei Telegram.
 */
export function VideoNachrichtBubble({ message, isMine }: MessageRendererProps) {
  const anhang = message.attachments.find((item) => item.kind === 'video');
  const video = useRef<HTMLVideoElement | null>(null);
  const [mitTon, setMitTon] = useState(false);
  const [anteil, setAnteil] = useState(0);
  const [dauer, setDauer] = useState((anhang?.durationMs ?? 0) / 1000);

  // Stumm vorspielen, solange sichtbar – und nur dann (Akku, Datenvolumen).
  useEffect(() => {
    const element = video.current;
    if (!element || typeof IntersectionObserver === 'undefined') return undefined;
    const reduziert = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const beobachter = new IntersectionObserver(
      ([eintrag]) => {
        if (!eintrag || element.muted === false) return;
        if (eintrag.isIntersecting && !reduziert) void element.play().catch(() => {});
        else element.pause();
      },
      { threshold: 0.6 },
    );
    beobachter.observe(element);
    return () => beobachter.disconnect();
  }, [anhang?.id]);

  if (!anhang) {
    return (
      <PendingMedia
        emoji="⭕"
        label="Videonachricht wird gesendet …"
        message={message}
        isMine={isMine}
      />
    );
  }

  const umschalten = () => {
    const element = video.current;
    if (!element) return;
    if (!mitTon) {
      element.muted = false;
      element.loop = false;
      element.currentTime = 0;
      claimPlayback(element);
      setMitTon(true);
      void element.play().catch(() => setMitTon(false));
    } else if (element.paused) {
      claimPlayback(element);
      void element.play().catch(() => {});
    } else {
      element.pause();
    }
  };

  const { umfang, versatz } = ringStrich(anteil, RING_R);

  return (
    <div className={`vn-blase${isMine ? ' vn-blase-mein' : ''}`}>
      <button
        type="button"
        className="vn-blase-knopf"
        onClick={umschalten}
        aria-label={`Videonachricht, ${formatDuration(dauer * 1000)} – ${mitTon ? 'anhalten oder weiter' : 'mit Ton abspielen'}`}
        aria-pressed={mitTon}
      >
        {anhang.previewDataUrl && (
          <img
            className="vn-blase-vorschau"
            src={anhang.previewDataUrl}
            alt=""
            aria-hidden="true"
          />
        )}
        <video
          ref={video}
          className="vn-blase-video"
          src={mediaSrc(anhang)}
          muted
          loop
          playsInline
          preload="metadata"
          onLoadedMetadata={(ereignis) => {
            const wert = ereignis.currentTarget.duration;
            if (Number.isFinite(wert) && wert > 0) setDauer(wert);
          }}
          onTimeUpdate={(ereignis) => {
            const element = ereignis.currentTarget;
            if (!element.muted && dauer > 0) setAnteil(element.currentTime / dauer);
          }}
          onPause={(ereignis) => releasePlayback(ereignis.currentTarget)}
          onEnded={(ereignis) => {
            // Zurück in den stummen Kreislauf.
            const element = ereignis.currentTarget;
            element.muted = true;
            element.loop = true;
            setMitTon(false);
            setAnteil(0);
            void element.play().catch(() => {});
          }}
        />
        <svg className="vn-ring" viewBox="0 0 100 100" aria-hidden="true">
          {mitTon && (
            <circle
              cx="50"
              cy="50"
              r={RING_R}
              className="vn-ring-lauf"
              strokeDasharray={umfang}
              strokeDashoffset={versatz}
            />
          )}
        </svg>
        {!mitTon && (
          <span className="vn-blase-ton" aria-hidden="true">
            🔇 {formatDuration(dauer * 1000)}
          </span>
        )}
      </button>
    </div>
  );
}
