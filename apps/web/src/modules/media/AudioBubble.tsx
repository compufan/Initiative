import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
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

  const seekFromEvent = (event: MouseEvent<HTMLButtonElement>) => {
    const audio = audioRef.current;
    if (!audio || duration <= 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    audio.currentTime = ratio * duration;
    setPosition(ratio * duration);
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
          onClick={seekFromEvent}
          aria-label="Position ändern"
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
