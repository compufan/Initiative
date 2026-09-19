import { useCallback, useEffect, useRef, useState } from 'react';
import { formatBytes } from '@initiative/shared';
import { Sheet } from '../../components/Sheet.js';
import { EmptyState } from '../../components/Feedback.js';
import { waveformFromBlob } from '../../lib/upload.js';
import type { ComposerActionProps } from '../types.js';
import { toast } from '../../state/ui.js';
import { TonWerkstatt } from './TonWerkstatt.js';
import {
  AUDIO_MIME_CANDIDATES,
  baseMime,
  buildAttachment,
  deviceErrorMessage,
  errorMessage,
  formatClock,
  pickRecorderMime,
  sendMedia,
  supportsCapture,
  supportsRecorder,
  timestampName,
  useObjectUrl,
  withinUploadLimit,
} from './helpers.js';

interface Recording {
  blob: Blob;
  mime: string;
  durationMs: number;
}

const MAX_VOICE_MS = 5 * 60 * 1000;

/**
 * Bis zu welcher Länge die Werkstatt angeboten wird.
 *
 * # Warum es diese Grenze gibt
 *
 * Eine bearbeitete Aufnahme muss neu geschrieben werden, und der einzige
 * Kodierer, den ein Browser überall mitbringt, ist keiner: WAV packt nicht.
 * Mono bei 24 kHz sind 48 kB je Sekunde – fünf Minuten wären rund 14 MB statt
 * der 400 kB, die derselbe Ton als Opus wiegt. Das liegt unter der Grenze von
 * 50 MB und ist trotzdem eine Frechheit gegenüber jedem Mobilfunkvertrag.
 *
 * Neunzig Sekunden sind rund 4 MB. Das ist die Zahl, bei der es noch
 * vertretbar ist.
 *
 * # Was oberhalb passiert
 *
 * Nichts Schlimmes: Die Vorschau und der Sendeknopf bleiben, wie sie immer
 * waren. Es fehlt nur der Knopf zur Werkstatt – niemand verliert etwas, das
 * er vorher hatte.
 *
 * # Wie die Grenze wieder wegkommt
 *
 * Mit einem Kodierer, der packt. `AudioEncoder` aus WebCodecs liefert rohe
 * Opus-Pakete; der Ogg-Behälter drumherum wäre von Hand zu schreiben, so wie
 * hier auch GIF und PNG von Hand geschrieben werden. Dann wären aus 14 MB
 * rund 1 MB. Solange das nicht steht, steht diese Zahl.
 */
const WERKSTATT_MAX_MS = 90 * 1000;

/** Voice message recorder with live level meter, preview and waveform upload. */
export function VoiceSheet({ conversationId, onClose }: ComposerActionProps) {
  const supported = supportsRecorder() && supportsCapture();

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const frameRef = useRef<number | null>(null);
  const levelRef = useRef<HTMLSpanElement | null>(null);
  const pulseRef = useRef<HTMLSpanElement | null>(null);
  const elapsedRef = useRef(0);
  const aliveRef = useRef(true);

  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<Recording | null>(null);
  /*
   * Ob die Werkstatt offen ist.
   *
   * Sie ersetzt das Blatt nicht, sondern tritt an die Stelle der Vorschau –
   * wer nur aufnehmen und senden will, sieht sie nie. Genau das ist der
   * Punkt: Der häufigste Weg bleibt zwei Fingertipps lang.
   */
  const [werkstattOffen, setWerkstattOffen] = useState(false);
  const [sending, setSending] = useState(false);
  const previewUrl = useObjectUrl(result?.blob ?? null);

  const teardown = useCallback(() => {
    if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    const context = audioContextRef.current;
    audioContextRef.current = null;
    if (context) void context.close().catch(() => {});
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== 'inactive') {
        try {
          recorder.stop();
        } catch {
          /* already stopped */
        }
      }
      recorderRef.current = null;
      teardown();
    };
  }, [teardown]);

  useEffect(() => {
    if (!recording) return undefined;
    const startedAt = Date.now();
    elapsedRef.current = 0;
    setElapsed(0);
    const id = window.setInterval(() => {
      const value = Date.now() - startedAt;
      elapsedRef.current = value;
      setElapsed(value);
      if (value >= MAX_VOICE_MS && recorderRef.current?.state === 'recording') {
        toast('Maximale Länge von 5 Minuten erreicht', 'info');
        recorderRef.current.stop();
      }
    }, 200);
    return () => window.clearInterval(id);
  }, [recording]);

  /** Live level straight from the analyser – written to the DOM, not to state. */
  const startMeter = (stream: MediaStream) => {
    const AudioCtor: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtor) return;
    try {
      const context = new AudioCtor();
      audioContextRef.current = context;
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      context.createMediaStreamSource(stream).connect(analyser);
      const buffer = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteTimeDomainData(buffer);
        let sum = 0;
        for (let i = 0; i < buffer.length; i += 1) {
          const value = (buffer[i] - 128) / 128;
          sum += value * value;
        }
        const level = Math.min(1, Math.sqrt(sum / buffer.length) * 2.6);
        if (levelRef.current) levelRef.current.style.width = `${Math.round(level * 100)}%`;
        if (pulseRef.current) pulseRef.current.style.transform = `scale(${1 + level * 0.45})`;
        frameRef.current = requestAnimationFrame(tick);
      };
      frameRef.current = requestAnimationFrame(tick);
    } catch {
      /* the meter is a nicety – recording works without it */
    }
  };

  const finish = (mimeType: string) => {
    const mime = baseMime(mimeType) || 'audio/webm';
    const blob = new Blob(chunksRef.current, { type: mime });
    chunksRef.current = [];
    teardown();
    if (!aliveRef.current) return;
    setRecording(false);
    if (blob.size === 0) {
      toast('Die Aufnahme ist leer geblieben', 'error');
      return;
    }
    if (!withinUploadLimit('audio', blob.size)) return;
    setResult({ blob, mime, durationMs: elapsedRef.current });
  };

  const start = async () => {
    if (!supported) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      if (!aliveRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const preferred = pickRecorderMime(AUDIO_MIME_CANDIDATES);
      const recorder = new MediaRecorder(stream, preferred ? { mimeType: preferred } : undefined);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        setRecording(false);
        teardown();
        toast('Die Aufnahme ist fehlgeschlagen', 'error');
      };
      recorder.onstop = () => finish(recorder.mimeType || preferred || 'audio/webm');
      recorder.start(500);
      recorderRef.current = recorder;
      startMeter(stream);
      setRecording(true);
    } catch (error) {
      teardown();
      toast(deviceErrorMessage(error, 'Mikrofon'), 'error');
    }
  };

  const stop = () => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    else setRecording(false);
  };

  const discard = () => {
    setResult(null);
    setWerkstattOffen(false);
    setElapsed(0);
    elapsedRef.current = 0;
  };

  const send = async () => {
    if (!result || sending) return;
    setSending(true);
    try {
      let waveform: number[] = [];
      try {
        waveform = await waveformFromBlob(result.blob);
      } catch (error) {
        console.warn('waveform failed', error);
      }
      const ok = await sendMedia(conversationId, 'audio', null, [
        buildAttachment({
          kind: 'audio',
          mime: result.mime,
          fileName: timestampName('sprachnachricht', result.mime),
          blob: result.blob,
          durationMs: result.durationMs,
          waveform,
        }),
      ]);
      if (ok) onClose();
    } catch (error) {
      toast(errorMessage(error, 'Sprachnachricht konnte nicht gesendet werden'), 'error');
    } finally {
      if (aliveRef.current) setSending(false);
    }
  };

  return (
    <Sheet open onClose={onClose} title="Sprachnachricht">
      {!supported ? (
        <EmptyState
          emoji="🎤"
          title="Aufnahme nicht möglich"
          description="Dieser Browser unterstützt keine Sprachaufnahmen. Auf dem iPhone brauchst du dafür Safari ab iOS 14.3 – oder du schickst eine Audiodatei über „Datei“."
          action={
            <button type="button" className="btn" onClick={onClose}>
              Verstanden
            </button>
          }
        />
      ) : result && werkstattOffen ? (
        /*
         * Die Werkstatt schreibt das Ergebnis zurück und schliesst sich.
         *
         * Wurde nichts geändert, kommt der ORIGINALBLOB heraus – sonst würde
         * aus 400 kB Opus ein WAV von mehreren Megabyte, nur weil jemand die
         * Werkstatt aufgemacht und wieder zugemacht hat. Die Entscheidung
         * trifft `fassungBeruehrt`, nicht dieser Aufrufer.
         */
        <TonWerkstatt
          blob={result.blob}
          uebernehmenText="Fertig"
          onAbbruch={() => setWerkstattOffen(false)}
          onFertig={(ergebnis) => {
            setResult({
              blob: ergebnis.blob,
              mime: ergebnis.mime,
              durationMs: ergebnis.dauerMs,
            });
            setWerkstattOffen(false);
            if (ergebnis.bearbeitet) toast('Ton übernommen.', 'success');
          }}
        />
      ) : result ? (
        <div className="stack">
          <div className="media-voice-result">
            <span className="media-voice-time">{formatClock(result.durationMs)}</span>
            <span className="muted">{formatBytes(result.blob.size)}</span>
          </div>
          {previewUrl && (
            <audio className="media-voice-player" src={previewUrl} controls preload="metadata" />
          )}
          {result.durationMs <= WERKSTATT_MAX_MS ? (
            <button
              type="button"
              className="btn btn-block"
              onClick={() => setWerkstattOffen(true)}
              disabled={sending}
            >
              🎛 Zuschneiden und verzerren
            </button>
          ) : (
            <p className="ton-hinweis">
              Zum Zuschneiden und Verzerren darf die Aufnahme höchstens{' '}
              {Math.round(WERKSTATT_MAX_MS / 1000)} Sekunden lang sein – bearbeiteter Ton wird
              unkomprimiert gespeichert und würde hier zu gross.
            </p>
          )}
          <div className="row row-between">
            <button type="button" className="btn btn-danger" onClick={discard} disabled={sending}>
              Verwerfen
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void send()}
              disabled={sending}
            >
              {sending ? 'Wird gesendet …' : 'Senden'}
            </button>
          </div>
        </div>
      ) : (
        <div className="media-voice">
          <span className="media-voice-time" aria-live="polite">
            {formatClock(elapsed)}
          </span>
          <div className="media-level" aria-hidden="true">
            <span ref={levelRef} />
          </div>
          <div className="media-record-wrap">
            <span ref={pulseRef} className="media-record-pulse" aria-hidden="true" />
            <button
              type="button"
              className={recording ? 'media-record is-recording' : 'media-record'}
              onClick={() => {
                if (recording) stop();
                else void start();
              }}
              aria-label={recording ? 'Aufnahme beenden' : 'Aufnahme starten'}
            >
              {recording ? '⏹' : '🎤'}
            </button>
          </div>
          <p className="muted" style={{ margin: 0, textAlign: 'center' }}>
            {recording
              ? 'Aufnahme läuft · maximal 5 Minuten'
              : 'Tippe auf das Mikrofon, um aufzunehmen.'}
          </p>
        </div>
      )}
    </Sheet>
  );
}
