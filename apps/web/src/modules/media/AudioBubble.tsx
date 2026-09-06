import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { formatDuration } from '@initiative/shared';
import type { MessageRendererProps } from '../types.js';
import { MediaCaption, PendingMedia, surfaceClass } from './MediaFrame.js';
import { claimPlayback, fallbackPeaks, mediaSrc, releasePlayback } from './helpers.js';
import { toast } from '../../state/ui.js';

const SPEEDS = [1, 1.5, 2];

/** Voice message bubble – waveform, scrubbing, playback speed. */
export function AudioBubble({ message, isMine }: MessageRendererProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const notified = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [speedIndex, setSpeedIndex] = useState(0);
  const attachment = message.attachments.find((item) => item.kind === 'audio');
  const [duration, setDuration] = useState(
    attachment?.durationMs != null ? attachment.durationMs / 1000 : 0,
  );

  const peaks = useMemo(() => {
    if (attachment?.waveform && attachment.waveform.length > 0) return attachment.waveform;
    return fallbackPeaks(attachment?.id ?? message.id);
  }, [attachment?.id, attachment?.waveform, message.id]);

  useEffect(() => {
    const audio = audioRef.current;
    return () => {
      if (audio) releasePlayback(audio);
    };
  }, []);

  if (!attachment) {
    return (
      <PendingMedia
        emoji="🎤"
        label="Sprachnachricht wird gesendet …"
        message={message}
        isMine={isMine}
      />
    );
  }

  const progress = duration > 0 ? Math.min(1, position / duration) : 0;

  const toggle = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    try {
      if (audio.paused) {
        claimPlayback(audio);
        audio.playbackRate = SPEEDS[speedIndex];
        await audio.play();
      } else {
        audio.pause();
      }
    } catch (error) {
      toast('Sprachnachricht kann nicht abgespielt werden', 'error');
      console.warn('audio playback failed', error);
    }
  };

  const springen = (sekunden: number) => {
    const audio = audioRef.current;
    if (!audio || duration <= 0) return;
    const ziel = Math.min(duration, Math.max(0, sekunden));
    audio.currentTime = ziel;
    setPosition(ziel);
  };

  /*
   * Nur ein echter Zeigerklick trägt eine Position.
   *
   * Wird die Leiste mit der Tastatur ausgelöst (Eingabe oder Leertaste auf dem
   * fokussierten Knopf), meldet der Browser `clientX = 0` und `detail = 0`.
   * Das ergab einen negativen Anteil, geklemmt auf 0 – die Sprachnachricht
   * sprang also an den Anfang, obwohl niemand das wollte. Mit der Tastatur
   * geht es jetzt in Schritten von fünf Sekunden über die Pfeiltasten, und die
   * Beschriftung sagt das auch.
   */
  const seekFromEvent = (event: MouseEvent<HTMLButtonElement>) => {
    if (event.detail === 0) return;
    const audio = audioRef.current;
    if (!audio || duration <= 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    springen(ratio * duration);
  };

  const tasten = (event: KeyboardEvent<HTMLButtonElement>) => {
    const schritt = event.key === 'ArrowRight' ? 5 : event.key === 'ArrowLeft' ? -5 : null;
    if (schritt == null) return;
    event.preventDefault();
    springen(position + schritt);
  };

  const cycleSpeed = () => {
    const next = (speedIndex + 1) % SPEEDS.length;
    setSpeedIndex(next);
    if (audioRef.current) audioRef.current.playbackRate = SPEEDS[next];
  };

  const remaining = playing || position > 0 ? Math.max(0, duration - position) : duration;

  return (
    <div className="media-bubble media-bubble-audio">
      <div className={surfaceClass('media-audio', isMine)}>
        <button
          type="button"
          className="media-play"
          onClick={() => void toggle()}
          aria-label={playing ? 'Pause' : 'Abspielen'}
        >
          {playing ? '⏸' : '▶'}
        </button>

        <button
          type="button"
          className="media-wave"
          /*
              Ein Schieberegler, kein Knopf.

              Als `button` versprach die Leiste eine Auslösung, die es nicht
              gibt: Eingabe und Leertaste laufen in `seekFromEvent` sofort in
              `event.detail === 0` und tun nichts. Vorgelesen wurde „Knopf,
              Position ändern" – ohne die aktuelle Position, ohne den Bereich
              und ohne Rückmeldung nach dem Springen. `slider` sagt beides:
              was er ist und wo er gerade steht.
          */
          role="slider"
          aria-valuemin={0}
          aria-valuemax={Math.max(1, Math.round(duration))}
          aria-valuenow={Math.round(position)}
          aria-valuetext={formatDuration(position * 1000)}
          onClick={seekFromEvent}
          onKeyDown={tasten}
          /*
              Kein `data-tipp` hier – er könnte nie erscheinen.

              Die Blase liegt in `.msg-col`, und dort greift `useLongPress` mit
              450 ms; die Tippblase braucht 500 ms. Der lange Druck öffnet also
              immer zuerst das Aktionsblatt, und die Tippblase legte sich 50 ms
              später über einen Schleier, hinter dem der Knopf gar nicht mehr
              liegt. Was zu sagen ist, steht deshalb in der Beschriftung, die
              Vorlesehilfen ohnehin lesen.
          */
          aria-label="Position ändern – mit den Pfeiltasten in Fünf-Sekunden-Schritten"
        >
          {peaks.map((peak, index) => (
            <span
              key={index}
              className={index / peaks.length <= progress ? 'is-played' : undefined}
              style={{ height: `${Math.max(12, Math.round(peak * 100))}%` }}
            />
          ))}
        </button>

        <div className="media-audio-meta">
          <span className="media-audio-time">{formatDuration(remaining * 1000)}</span>
          <button
            type="button"
            className="media-speed"
            onClick={cycleSpeed}
            aria-label={`Geschwindigkeit ${SPEEDS[speedIndex]}x`}
          >
            {SPEEDS[speedIndex]}x
          </button>
        </div>

        <audio
          ref={audioRef}
          src={mediaSrc(attachment)}
          preload="metadata"
          onLoadedMetadata={(event) => {
            const value = event.currentTarget.duration;
            if (Number.isFinite(value) && value > 0) setDuration(value);
          }}
          onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={(event) => {
            setPlaying(false);
            setPosition(0);
            event.currentTarget.currentTime = 0;
          }}
          onError={() => {
            if (notified.current) return;
            notified.current = true;
            toast('Sprachnachricht konnte nicht geladen werden', 'error');
          }}
        />
      </div>
      <MediaCaption body={message.body} isMine={isMine} />
    </div>
  );
}
