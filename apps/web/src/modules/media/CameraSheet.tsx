import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { createPortal } from 'react-dom';
import type { ComposerActionProps } from '../types.js';
import { prepareImage, videoPreview } from '../../lib/upload.js';
import { toast, useHideNav } from '../../state/ui.js';
import {
  VIDEO_MIME_CANDIDATES,
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

type Facing = 'user' | 'environment';
type Mode = 'photo' | 'video';

interface PhotoDraft {
  kind: 'image';
  blob: Blob;
  mime: string;
  width: number;
  height: number;
  previewDataUrl: string;
}

interface VideoDraft {
  kind: 'video';
  blob: Blob;
  mime: string;
  width: number;
  height: number;
  durationMs: number;
  previewDataUrl?: string;
}

type CaptureDraft = PhotoDraft | VideoDraft;

const MAX_VIDEO_MS = 3 * 60 * 1000;

/**
 * Full screen camera: live preview, shutter, front/back switch and video
 * recording. Every exit path stops the tracks – otherwise the camera LED of the
 * phone stays on after the sheet is gone.
 */
export function CameraSheet({ conversationId, onClose }: ComposerActionProps) {
  useHideNav(true);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const elapsedRef = useRef(0);
  const aliveRef = useRef(true);

  const [facing, setFacing] = useState<Facing>('environment');
  const [mode, setMode] = useState<Mode>('photo');
  const [ready, setReady] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [multipleCameras, setMultipleCameras] = useState(false);
  const [flash, setFlash] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [draft, setDraft] = useState<CaptureDraft | null>(null);
  const [caption, setCaption] = useState('');
  const [sending, setSending] = useState(false);

  const photoUrl = useObjectUrl(draft?.kind === 'image' ? draft.blob : null);
  const videoUrl = useObjectUrl(draft?.kind === 'video' ? draft.blob : null);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const stopStream = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {
        /* already stopped */
      }
    }
    recorderRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  // Live preview. Restarts on camera switch and when audio is needed for video.
  useEffect(() => {
    if (draft) return undefined;
    if (!supportsCapture()) {
      setStreamError('Dieser Browser gibt keine Live-Kamera frei.');
      return undefined;
    }

    let cancelled = false;
    setReady(false);

    const start = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: facing },
          audio: mode === 'video',
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          try {
            await videoRef.current.play();
          } catch {
            /* autoplay is allowed for muted streams, ignore races */
          }
        }
        setStreamError(null);
        setReady(true);
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          if (!cancelled) {
            setMultipleCameras(devices.filter((device) => device.kind === 'videoinput').length > 1);
          }
        } catch {
          setMultipleCameras(true);
        }
      } catch (error) {
        if (cancelled) return;
        setReady(false);
        setStreamError(deviceErrorMessage(error, 'Kamera'));
      }
    };

    void start();
    return () => {
      cancelled = true;
      stopStream();
    };
  }, [draft, facing, mode, stopStream]);

  // Running recording time plus the hard three minute ceiling.
  useEffect(() => {
    if (!recording) return undefined;
    const startedAt = Date.now();
    elapsedRef.current = 0;
    setElapsed(0);
    const id = window.setInterval(() => {
      const value = Date.now() - startedAt;
      elapsedRef.current = value;
      setElapsed(value);
      if (value >= MAX_VIDEO_MS && recorderRef.current?.state === 'recording') {
        toast('Maximale Länge von 3 Minuten erreicht', 'info');
        recorderRef.current.stop();
      }
    }, 200);
    return () => window.clearInterval(id);
  }, [recording]);

  const capturePhoto = async () => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) {
      toast('Die Kamera ist noch nicht bereit', 'error');
      return;
    }
    setBusy(true);
    setFlash(true);
    window.setTimeout(() => setFlash(false), 320);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas ist nicht verfügbar');
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const raw = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error('Foto konnte nicht erstellt werden'))),
          'image/jpeg',
          0.92,
        );
      });
      const prepared = await prepareImage(raw);
      if (!aliveRef.current) return;
      if (!withinUploadLimit('image', prepared.blob.size)) return;
      setDraft({
        kind: 'image',
        blob: prepared.blob,
        mime: prepared.mime,
        width: prepared.width,
        height: prepared.height,
        previewDataUrl: prepared.previewDataUrl,
      });
    } catch (error) {
      toast(errorMessage(error, 'Foto konnte nicht aufgenommen werden'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const finishRecording = async (mimeType: string) => {
    const type = baseMime(mimeType) || 'video/webm';
    const blob = new Blob(chunksRef.current, { type });
    chunksRef.current = [];
    if (!aliveRef.current) return;
    setRecording(false);
    if (blob.size === 0) {
      toast('Die Aufnahme ist leer geblieben', 'error');
      return;
    }
    if (!withinUploadLimit('video', blob.size)) return;
    const preview = await videoPreview(blob);
    if (!aliveRef.current) return;
    setDraft({
      kind: 'video',
      blob,
      mime: type,
      width: preview?.width ?? 0,
      height: preview?.height ?? 0,
      durationMs: preview?.durationMs || elapsedRef.current,
      previewDataUrl: preview?.previewDataUrl,
    });
  };

  const startRecording = () => {
    const stream = streamRef.current;
    if (!stream) {
      toast('Die Kamera ist noch nicht bereit', 'error');
      return;
    }
    if (!supportsRecorder()) {
      toast('Dieser Browser kann keine Videos aufnehmen', 'error');
      return;
    }
    const preferred = pickRecorderMime(VIDEO_MIME_CANDIDATES);
    try {
      const recorder = new MediaRecorder(stream, preferred ? { mimeType: preferred } : undefined);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        setRecording(false);
        toast('Die Videoaufnahme ist fehlgeschlagen', 'error');
      };
      recorder.onstop = () => {
        void finishRecording(recorder.mimeType || preferred || 'video/webm');
      };
      recorder.start(1000);
      recorderRef.current = recorder;
      setRecording(true);
    } catch (error) {
      toast(errorMessage(error, 'Die Videoaufnahme konnte nicht gestartet werden'), 'error');
    }
  };

  const stopRecording = () => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    else setRecording(false);
  };

  const onFallbackFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBusy(true);
    try {
      if (file.type.startsWith('video/')) {
        if (!withinUploadLimit('video', file.size, file.name)) return;
        const preview = await videoPreview(file);
        setDraft({
          kind: 'video',
          blob: file,
          mime: file.type,
          width: preview?.width ?? 0,
          height: preview?.height ?? 0,
          durationMs: preview?.durationMs ?? 0,
          previewDataUrl: preview?.previewDataUrl,
        });
        return;
      }
      const prepared = await prepareImage(file);
      if (!withinUploadLimit('image', prepared.blob.size, file.name)) return;
      setDraft({
        kind: 'image',
        blob: prepared.blob,
        mime: prepared.mime,
        width: prepared.width,
        height: prepared.height,
        previewDataUrl: prepared.previewDataUrl,
      });
    } catch (error) {
      toast(errorMessage(error, 'Die Aufnahme konnte nicht übernommen werden'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (!draft || sending) return;
    setSending(true);
    const attachment = buildAttachment({
      kind: draft.kind,
      mime: draft.mime,
      fileName: timestampName(draft.kind === 'image' ? 'foto' : 'video', draft.mime),
      blob: draft.blob,
      width: draft.width,
      height: draft.height,
      durationMs: draft.kind === 'video' ? draft.durationMs : undefined,
      previewDataUrl: draft.previewDataUrl,
    });
    const ok = await sendMedia(conversationId, draft.kind, caption, [attachment]);
    if (!aliveRef.current) return;
    setSending(false);
    if (ok) onClose();
  };

  const discard = () => {
    setDraft(null);
    setCaption('');
  };

  const shutterLabel =
    mode === 'photo' ? 'Foto aufnehmen' : recording ? 'Aufnahme beenden' : 'Videoaufnahme starten';

  return createPortal(
    <div className="media-camera" role="dialog" aria-modal="true" aria-label="Kamera">
      <div className="media-camera-bar">
        <button
          type="button"
          className="media-round-btn"
          onClick={() => {
            stopStream();
            onClose();
          }}
          aria-label="Kamera schließen"
        >
          ✕
        </button>

        {!draft && !streamError && (
          <div className="media-modes" role="group" aria-label="Aufnahmemodus">
            <button
              type="button"
              className={mode === 'photo' ? 'is-active' : undefined}
              onClick={() => setMode('photo')}
              disabled={recording}
            >
              Foto
            </button>
            <button
              type="button"
              className={mode === 'video' ? 'is-active' : undefined}
              onClick={() => setMode('video')}
              disabled={recording}
            >
              Video
            </button>
          </div>
        )}

        {!draft && !streamError && multipleCameras ? (
          <button
            type="button"
            className="media-round-btn"
            onClick={() => setFacing((value) => (value === 'user' ? 'environment' : 'user'))}
            disabled={recording}
            aria-label="Kamera wechseln"
          >
            🔄
          </button>
        ) : (
          <span className="media-round-spacer" aria-hidden="true" />
        )}
      </div>

      <div className="media-camera-stage">
        {draft ? (
          draft.kind === 'image' ? (
            photoUrl && (
              <img className="media-camera-preview" src={photoUrl} alt="Aufgenommenes Foto" />
            )
          ) : (
            videoUrl && (
              <video
                className="media-camera-preview"
                src={videoUrl}
                poster={draft.previewDataUrl}
                controls
                playsInline
                preload="metadata"
              />
            )
          )
        ) : streamError ? (
          <div className="media-fallback">
            <p className="media-fallback-title">📷 Kamera nicht verfügbar</p>
            <p>{streamError}</p>
            <p className="media-fallback-hint">
              Du kannst stattdessen direkt die Kamera-App deines Geräts benutzen.
            </p>
            <label className="btn btn-primary btn-block">
              Foto aufnehmen
              <input
                type="file"
                accept="image/*"
                capture="environment"
                className="media-visually-hidden"
                onChange={(event) => void onFallbackFile(event)}
              />
            </label>
            <label className="btn btn-block">
              Video aufnehmen
              <input
                type="file"
                accept="video/*"
                capture="environment"
                className="media-visually-hidden"
                onChange={(event) => void onFallbackFile(event)}
              />
            </label>
          </div>
        ) : (
          <>
            <video
              ref={videoRef}
              className={facing === 'user' ? 'media-camera-live is-mirrored' : 'media-camera-live'}
              autoPlay
              playsInline
              muted
            />
            {!ready && <span className="media-camera-loading">Kamera wird gestartet …</span>}
          </>
        )}
        {flash && <span className="media-flash" aria-hidden="true" />}
        {recording && (
          <span className="media-rec">
            <i aria-hidden="true" />
            {formatClock(elapsed)}
          </span>
        )}
      </div>

      <div className="media-camera-controls">
        {draft ? (
          <>
            <input
              className="input"
              value={caption}
              onChange={(event) => setCaption(event.target.value)}
              placeholder="Bildunterschrift (optional)"
              aria-label="Bildunterschrift"
            />
            <div className="row row-between">
              <button type="button" className="btn btn-ghost" onClick={discard} disabled={sending}>
                Neu aufnehmen
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
          </>
        ) : streamError ? (
          <p className="media-camera-hint">Nach der Aufnahme kannst du das Ergebnis noch prüfen.</p>
        ) : (
          <>
            <p className="media-camera-hint">
              {mode === 'photo'
                ? 'Tippe auf den Auslöser'
                : recording
                  ? 'Aufnahme läuft · maximal 3 Minuten'
                  : 'Tippe zum Starten der Videoaufnahme'}
            </p>
            <button
              type="button"
              className={recording ? 'media-shutter is-recording' : 'media-shutter'}
              onClick={() => {
                if (mode === 'photo') void capturePhoto();
                else if (recording) stopRecording();
                else startRecording();
              }}
              disabled={!ready || busy}
              aria-label={shutterLabel}
            />
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
