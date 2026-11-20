import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ComposerActionProps } from '../types.js';
import { useChat } from '../../state/chat.js';
import { toast } from '../../state/ui.js';
import {
  VIDEO_MIME_CANDIDATES,
  baseMime,
  buildAttachment,
  deviceErrorMessage,
  errorMessage,
  formatClock,
  pickRecorderMime,
  supportsCapture,
  supportsRecorder,
  timestampName,
  useObjectUrl,
  withinUploadLimit,
} from './helpers.js';
import {
  VIDEONACHRICHT_KANTE,
  VIDEONACHRICHT_MAX_MS,
  mittigesQuadrat,
  ringStrich,
  videonachrichtMetadaten,
} from './videonachricht.js';

type Seite = 'user' | 'environment';

interface Ergebnis {
  blob: Blob;
  mime: string;
  dauerMs: number;
  vorschau: string;
}

const RING_R = 46;

/**
 * Videonachricht im Kreis aufnehmen: Frontkamera, quadratisch, höchstens 60 s.
 *
 * Gefilmt wird über eine Leinwand: Jedes Kamerabild wird mittig quadratisch
 * ausgeschnitten und gezeichnet, aufgenommen wird der Strom der Leinwand plus
 * Mikrofon (`MediaRecorder`, dieselben Formate wie die Kamera der App). Das hat
 * einen zweiten Vorteil: Beim Wechsel der Kamera läuft die Aufnahme einfach
 * weiter – gezeichnet wird ab dann das andere Bild.
 */
export function VideoNachrichtSheet({ conversationId, onClose }: ComposerActionProps) {
  const unterstuetzt = supportsCapture() && supportsRecorder();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const leinwand = useRef<HTMLCanvasElement | null>(null);
  const kamera = useRef<MediaStream | null>(null);
  const mikro = useRef<MediaStreamTrack | null>(null);
  const rekorder = useRef<MediaRecorder | null>(null);
  const stuecke = useRef<Blob[]>([]);
  const bild = useRef<number | null>(null);
  const beginn = useRef(0);
  const vorschau = useRef('');
  const lebt = useRef(true);

  const [seite, setSeite] = useState<Seite>('user');
  const [bereit, setBereit] = useState(false);
  const [nimmtAuf, setNimmtAuf] = useState(false);
  const [dauer, setDauer] = useState(0);
  const [ergebnis, setErgebnis] = useState<Ergebnis | null>(null);
  const [sendet, setSendet] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const ergebnisUrl = useObjectUrl(ergebnis?.blob ?? null);

  function kameraAus() {
    kamera.current?.getTracks().forEach((spur) => spur.stop());
    kamera.current = null;
  }

  function allesAus() {
    if (bild.current !== null) cancelAnimationFrame(bild.current);
    bild.current = null;
    try {
      if (rekorder.current && rekorder.current.state !== 'inactive') rekorder.current.stop();
    } catch {
      /* schon aus */
    }
    kameraAus();
    mikro.current?.stop();
    mikro.current = null;
  }

  useEffect(() => {
    lebt.current = true;
    return () => {
      lebt.current = false;
      allesAus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Kamera (an- oder umschalten). Das Mikrofon bleibt dabei an.
  useEffect(() => {
    if (!unterstuetzt || ergebnis) return undefined;
    let abgebrochen = false;
    setBereit(false);
    void (async () => {
      try {
        const strom = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: seite,
            width: { ideal: 720 },
            height: { ideal: 720 },
            aspectRatio: { ideal: 1 },
          },
          audio: mikro.current ? false : { echoCancellation: true, noiseSuppression: true },
        });
        if (abgebrochen || !lebt.current) {
          strom.getTracks().forEach((spur) => spur.stop());
          return;
        }
        const ton = strom.getAudioTracks()[0];
        if (ton) {
          mikro.current = ton;
          strom.removeTrack(ton);
        }
        kameraAus();
        kamera.current = strom;
        const video = videoRef.current;
        if (video) {
          video.srcObject = strom;
          await video.play().catch(() => {});
        }
        setBereit(true);
        zeichnen();
      } catch (grund) {
        if (!abgebrochen) setFehler(deviceErrorMessage(grund, 'Kamera'));
      }
    })();
    return () => {
      abgebrochen = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seite, ergebnis, unterstuetzt]);

  // Uhr und Höchstdauer.
  useEffect(() => {
    if (!nimmtAuf) return undefined;
    const uhr = window.setInterval(() => {
      const ms = Date.now() - beginn.current;
      setDauer(ms);
      if (ms >= VIDEONACHRICHT_MAX_MS) stoppen();
    }, 100);
    return () => window.clearInterval(uhr);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nimmtAuf]);

  /** Jedes Kamerabild mittig quadratisch auf die Leinwand. */
  function zeichnen() {
    if (bild.current !== null) return;
    const schritt = () => {
      bild.current = requestAnimationFrame(schritt);
      const video = videoRef.current;
      const flaeche = leinwand.current?.getContext('2d');
      if (!video || !flaeche || video.videoWidth === 0) return;
      const [sx, sy, kante] = mittigesQuadrat(video.videoWidth, video.videoHeight);
      flaeche.drawImage(
        video,
        sx,
        sy,
        kante,
        kante,
        0,
        0,
        VIDEONACHRICHT_KANTE,
        VIDEONACHRICHT_KANTE,
      );
    };
    bild.current = requestAnimationFrame(schritt);
  }

  function starten() {
    const flaeche = leinwand.current;
    if (!flaeche || !bereit) return;
    const bildStrom = flaeche.captureStream(30);
    if (mikro.current) bildStrom.addTrack(mikro.current);
    const wunsch = pickRecorderMime(VIDEO_MIME_CANDIDATES);
    let neu: MediaRecorder;
    try {
      neu = new MediaRecorder(bildStrom, {
        ...(wunsch ? { mimeType: wunsch } : {}),
        videoBitsPerSecond: 1_000_000,
        audioBitsPerSecond: 64_000,
      });
    } catch (grund) {
      toast(errorMessage(grund, 'Aufnahme nicht möglich'), 'error');
      return;
    }
    // Ein kleines Standbild als Vorschau (Chat lädt sofort, auch offline).
    try {
      const klein = document.createElement('canvas');
      klein.width = 96;
      klein.height = 96;
      klein.getContext('2d')?.drawImage(flaeche, 0, 0, 96, 96);
      vorschau.current = klein.toDataURL('image/jpeg', 0.6);
    } catch {
      vorschau.current = '';
    }
    stuecke.current = [];
    neu.ondataavailable = (ereignis) => {
      if (ereignis.data.size > 0) stuecke.current.push(ereignis.data);
    };
    neu.onstop = () => {
      const dauerMs = Math.min(VIDEONACHRICHT_MAX_MS, Date.now() - beginn.current);
      const mime = baseMime(neu.mimeType || wunsch || 'video/webm') || 'video/webm';
      const blob = new Blob(stuecke.current, { type: mime });
      stuecke.current = [];
      if (!lebt.current) return;
      setNimmtAuf(false);
      if (blob.size === 0) {
        toast('Die Aufnahme ist leer geblieben', 'error');
        return;
      }
      if (!withinUploadLimit('video', blob.size)) return;
      if (bild.current !== null) cancelAnimationFrame(bild.current);
      bild.current = null;
      kameraAus();
      setErgebnis({ blob, mime, dauerMs, vorschau: vorschau.current });
    };
    beginn.current = Date.now();
    setDauer(0);
    neu.start(500);
    rekorder.current = neu;
    setNimmtAuf(true);
  }

  function stoppen() {
    const laufend = rekorder.current;
    if (laufend && laufend.state !== 'inactive') laufend.stop();
  }

  function verwerfen() {
    setErgebnis(null);
    setDauer(0);
  }

  async function senden() {
    if (!ergebnis || sendet) return;
    setSendet(true);
    try {
      await useChat.getState().sendMessage(conversationId, {
        type: 'video',
        body: null,
        metadata: videonachrichtMetadaten(ergebnis.dauerMs),
        attachments: [
          buildAttachment({
            kind: 'video',
            mime: ergebnis.mime,
            fileName: timestampName('videonachricht', ergebnis.mime),
            blob: ergebnis.blob,
            width: VIDEONACHRICHT_KANTE,
            height: VIDEONACHRICHT_KANTE,
            durationMs: ergebnis.dauerMs,
            previewDataUrl: ergebnis.vorschau || undefined,
          }),
        ],
      });
      allesAus();
      onClose();
    } catch (grund) {
      toast(errorMessage(grund, 'Videonachricht konnte nicht gesendet werden'), 'error');
    } finally {
      if (lebt.current) setSendet(false);
    }
  }

  function schliessen() {
    allesAus();
    onClose();
  }

  const { umfang, versatz } = ringStrich(dauer / VIDEONACHRICHT_MAX_MS, RING_R);

  return createPortal(
    <div
      className="vn-blatt"
      role="dialog"
      aria-modal="true"
      aria-label="Videonachricht aufnehmen"
      onKeyDown={(ereignis) => {
        if (ereignis.key === 'Escape') schliessen();
      }}
    >
      <div className="vn-kreis">
        {ergebnis && ergebnisUrl ? (
          <video
            className="vn-video"
            src={ergebnisUrl}
            autoPlay
            loop
            playsInline
            controls={false}
            aria-label="Vorschau der Videonachricht"
          />
        ) : (
          <video
            ref={videoRef}
            className={`vn-video${seite === 'user' ? ' vn-spiegel' : ''}`}
            autoPlay
            muted
            playsInline
            aria-label="Kamerabild"
          />
        )}
        <svg className="vn-ring" viewBox="0 0 100 100" aria-hidden="true">
          <circle cx="50" cy="50" r={RING_R} className="vn-ring-grund" />
          {nimmtAuf && (
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
        <canvas
          ref={leinwand}
          width={VIDEONACHRICHT_KANTE}
          height={VIDEONACHRICHT_KANTE}
          className="vn-leinwand"
          aria-hidden="true"
        />
      </div>

      <p className="vn-zeit" aria-live="polite">
        {fehler ??
          (!unterstuetzt
            ? 'Dieser Browser kann keine Videos aufnehmen.'
            : ergebnis
              ? `Videonachricht · ${formatClock(ergebnis.dauerMs)}`
              : nimmtAuf
                ? `${formatClock(dauer)} / 1:00`
                : bereit
                  ? 'Bereit · höchstens eine Minute'
                  : 'Kamera wird gestartet …')}
      </p>

      <div className="vn-knoepfe">
        {ergebnis ? (
          <>
            <button type="button" className="btn btn-ghost" onClick={verwerfen} disabled={sendet}>
              Neu aufnehmen
            </button>
            <button type="button" className="btn" onClick={schliessen} disabled={sendet}>
              Verwerfen
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void senden()}
              disabled={sendet}
              autoFocus
            >
              {sendet ? 'Wird gesendet …' : 'Senden'}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn btn-ghost" onClick={schliessen}>
              Abbrechen
            </button>
            <button
              type="button"
              className={`vn-ausloeser${nimmtAuf ? ' is-recording' : ''}`}
              onClick={() => (nimmtAuf ? stoppen() : starten())}
              disabled={!bereit || !unterstuetzt}
              aria-label={nimmtAuf ? 'Aufnahme beenden' : 'Aufnahme starten'}
            />
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setSeite((alt) => (alt === 'user' ? 'environment' : 'user'))}
              disabled={!bereit}
              aria-label="Kamera wechseln"
            >
              🔄
            </button>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
