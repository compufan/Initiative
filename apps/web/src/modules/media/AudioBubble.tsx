import { useMemo, type KeyboardEvent, type MouseEvent } from 'react';
import { formatDuration } from '@initiative/shared';
import type { MessageRendererProps } from '../types.js';
import { MediaCaption, PendingMedia, surfaceClass } from './MediaFrame.js';
import { fallbackPeaks } from './helpers.js';
import { toast } from '../../state/ui.js';
import {
  abspielen,
  namenFuer,
  springen as spielerSpringen,
  tempoWechseln,
  useSpieler,
} from '../player/spieler.js';

/**
 * Voice message bubble – waveform, scrubbing, playback speed.
 *
 * Gespielt wird im globalen Spieler (`modules/player/spieler.ts`): Die Blase
 * zeigt nur, ob SIE gerade läuft, und steuert ihn. So spielt eine
 * Sprachnachricht weiter, wenn man den Chat verlässt, und die nächste kommt
 * von selbst.
 */
export function AudioBubble({ message, isMine }: MessageRendererProps) {
  const attachment = message.attachments.find((item) => item.kind === 'audio');
  const aktiv = useSpieler((zustand) =>
    attachment ? zustand.titel?.attachment.id === attachment.id : false,
  );
  const playing = useSpieler((zustand) => aktiv && zustand.spielt);
  const position = useSpieler((zustand) => (aktiv ? zustand.position : 0));
  const tempo = useSpieler((zustand) => zustand.tempo);
  const spielerDauer = useSpieler((zustand) => (aktiv ? zustand.dauer : 0));
  const duration =
    spielerDauer > 0 ? spielerDauer : attachment?.durationMs != null ? attachment.durationMs / 1000 : 0;

  const peaks = useMemo(() => {
    if (attachment?.waveform && attachment.waveform.length > 0) return attachment.waveform;
    return fallbackPeaks(attachment?.id ?? message.id);
  }, [attachment?.id, attachment?.waveform, message.id]);

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
    try {
      await abspielen({
        conversationId: message.conversationId,
        messageId: message.id,
        attachment,
        ...namenFuer(message.conversationId, message.senderId),
      });
    } catch (error) {
      toast('Sprachnachricht kann nicht abgespielt werden', 'error');
      console.warn('audio playback failed', error);
    }
  };

  const springen = (sekunden: number) => {
    if (!aktiv || duration <= 0) return;
    spielerSpringen(Math.min(duration, Math.max(0, sekunden)));
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
    if (duration <= 0) return;
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
            onClick={tempoWechseln}
            aria-label={`Geschwindigkeit ${tempo}x`}
          >
            {tempo}x
          </button>
        </div>

      </div>
      <MediaCaption body={message.body} isMine={isMine} />
    </div>
  );
}
