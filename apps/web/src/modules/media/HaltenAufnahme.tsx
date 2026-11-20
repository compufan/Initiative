import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type { ComposerKnopfProps } from '../types.js';
import { waveformFromBlob } from '../../lib/upload.js';
import { useChat } from '../../state/chat.js';
import { toast } from '../../state/ui.js';
import {
  buildAttachment,
  deviceErrorMessage,
  formatClock,
  sendMedia,
  supportsCapture,
  supportsRecorder,
  timestampName,
  withinUploadLimit,
} from './helpers.js';
import { abbruchFortschritt, beimLoslassen, haltenLage } from './haltenGeste.js';
import { TonAufnahme } from './tonAufnahme.js';

const MAX_MS = 5 * 60 * 1000;

type Zustand = 'ruhe' | 'startet' | 'haelt' | 'gesperrt' | 'sendet';

/**
 * Das Mikrofon in der Eingabezeile: gedrückt halten nimmt auf.
 *
 * * Loslassen sendet.
 * * Nach links wischen bricht ab.
 * * Nach oben wischen sperrt – die Aufnahme läuft ohne Finger weiter, mit
 *   „Senden“ und „Verwerfen“.
 * * Ein kurzer Tipp, die Eingabetaste oder die Leertaste öffnen das
 *   Aufnahmeblatt (`VoiceSheet`) – der Weg ohne Halten für Tastatur, Maus und
 *   alle, denen das Halten schwerfällt.
 */
export function HaltenAufnahme({ conversationId, oeffnen }: ComposerKnopfProps) {
  const [zustand, setZustand] = useState<Zustand>('ruhe');
  const [dauer, setDauer] = useState(0);
  const [versatz, setVersatz] = useState(0);
  const aufnahme = useRef<TonAufnahme | null>(null);
  const start = useRef<{ x: number; y: number; zeit: number } | null>(null);
  const klickSchlucken = useRef(false);
  const zustandRef = useRef<Zustand>('ruhe');
  const lebt = useRef(true);

  const setzen = (neu: Zustand) => {
    zustandRef.current = neu;
    setZustand(neu);
  };

  useEffect(() => {
    lebt.current = true;
    return () => {
      lebt.current = false;
      aufnahme.current?.verwerfen();
      aufnahme.current = null;
    };
  }, []);

  const laeuft = zustand === 'haelt' || zustand === 'gesperrt';

  // Uhr, Höchstdauer und „nimmt Sprachnachricht auf …“ bei den anderen.
  useEffect(() => {
    if (!laeuft) return undefined;
    const melden = () => useChat.getState().setTyping(conversationId, true, 'audio');
    melden();
    const tipp = window.setInterval(melden, 2500);
    const uhr = window.setInterval(() => {
      const ms = aufnahme.current?.dauerMs ?? 0;
      setDauer(ms);
      if (ms >= MAX_MS) {
        toast('Maximale Länge von 5 Minuten erreicht', 'info');
        void senden();
      }
    }, 200);
    return () => {
      window.clearInterval(tipp);
      window.clearInterval(uhr);
      useChat.getState().setTyping(conversationId, false, 'audio');
    };
    // `senden` liest nur Refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [laeuft, conversationId]);

  // Escape bricht ab – auch gesperrt.
  useEffect(() => {
    if (!laeuft) return undefined;
    const taste = (ereignis: KeyboardEvent) => {
      if (ereignis.key === 'Escape') verwerfen();
    };
    window.addEventListener('keydown', taste);
    return () => window.removeEventListener('keydown', taste);
  });

  function verwerfen() {
    aufnahme.current?.verwerfen();
    aufnahme.current = null;
    start.current = null;
    setVersatz(0);
    setDauer(0);
    setzen('ruhe');
  }

  async function senden() {
    const laufend = aufnahme.current;
    if (!laufend || zustandRef.current === 'sendet') return;
    setzen('sendet');
    aufnahme.current = null;
    try {
      const ergebnis = await laufend.beenden();
      if (ergebnis.blob.size === 0) {
        toast('Die Aufnahme ist leer geblieben', 'error');
        return;
      }
      if (!withinUploadLimit('audio', ergebnis.blob.size)) return;
      let waveform: number[] = [];
      try {
        waveform = await waveformFromBlob(ergebnis.blob);
      } catch {
        /* ohne Wellenform zeigt die Blase eine erfundene */
      }
      await sendMedia(conversationId, 'audio', null, [
        buildAttachment({
          kind: 'audio',
          mime: ergebnis.mime,
          fileName: timestampName('sprachnachricht', ergebnis.mime),
          blob: ergebnis.blob,
          durationMs: ergebnis.durationMs,
          waveform,
        }),
      ]);
    } catch (fehler) {
      toast(fehler instanceof Error ? fehler.message : 'Senden fehlgeschlagen', 'error');
    } finally {
      if (lebt.current) {
        start.current = null;
        setVersatz(0);
        setDauer(0);
        setzen('ruhe');
      }
    }
  }

  async function beginnen(ereignis: ReactPointerEvent<HTMLButtonElement>) {
    if (ereignis.button !== 0 || zustandRef.current !== 'ruhe') return;
    if (!supportsRecorder() || !supportsCapture()) return;
    ereignis.currentTarget.setPointerCapture?.(ereignis.pointerId);
    start.current = { x: ereignis.clientX, y: ereignis.clientY, zeit: Date.now() };
    setzen('startet');
    try {
      const neu = await TonAufnahme.starten();
      // Schon losgelassen, während das Mikrofon noch anlief: ein Tipp.
      if (!lebt.current || (zustandRef.current as Zustand) !== 'startet') {
        neu.verwerfen();
        return;
      }
      aufnahme.current = neu;
      setzen('haelt');
    } catch (fehler) {
      setzen('ruhe');
      start.current = null;
      toast(deviceErrorMessage(fehler, 'Mikrofon'), 'error');
    }
  }

  function bewegen(ereignis: ReactPointerEvent<HTMLButtonElement>) {
    if (zustandRef.current !== 'haelt' || !start.current) return;
    const dx = ereignis.clientX - start.current.x;
    const dy = ereignis.clientY - start.current.y;
    setVersatz(Math.min(0, dx));
    const lage = haltenLage(dx, dy);
    if (lage === 'abbrechen') {
      klickSchlucken.current = true;
      verwerfen();
      toast('Aufnahme verworfen', 'info');
    } else if (lage === 'sperren') {
      klickSchlucken.current = true;
      setVersatz(0);
      setzen('gesperrt');
    }
  }

  function loslassen() {
    const jetzt = zustandRef.current;
    if (jetzt === 'startet') {
      // Noch keine Aufnahme – ein Tipp. Der Klick öffnet gleich das Blatt.
      setzen('ruhe');
      start.current = null;
      return;
    }
    if (jetzt !== 'haelt') return;
    const gehalten = Date.now() - (start.current?.zeit ?? Date.now());
    const was = beimLoslassen(gehalten, false);
    if (was === 'verwerfen') {
      verwerfen();
      return;
    }
    klickSchlucken.current = true;
    void senden();
  }

  const anteil = abbruchFortschritt(versatz);

  return (
    <>
      <button
        type="button"
        className={`icon-btn msg-composer-pinned media-halten${laeuft ? ' is-recording' : ''}`}
        aria-label="Sprachnachricht – gedrückt halten zum Aufnehmen, tippen für das Aufnahmeblatt"
        title="Gedrückt halten: aufnehmen · Tippen: Aufnahmeblatt"
        onPointerDown={(ereignis) => void beginnen(ereignis)}
        onPointerMove={bewegen}
        onPointerUp={loslassen}
        onPointerCancel={() => {
          if (zustandRef.current === 'haelt' || zustandRef.current === 'startet') verwerfen();
        }}
        onContextMenu={(ereignis) => ereignis.preventDefault()}
        onClick={() => {
          if (klickSchlucken.current) {
            klickSchlucken.current = false;
            return;
          }
          if (zustandRef.current === 'ruhe') oeffnen();
        }}
      >
        <span aria-hidden="true">🎤</span>
      </button>
      {(laeuft || zustand === 'sendet') &&
        createPortal(
          <div
            className={`media-halten-leiste${zustand === 'gesperrt' ? ' is-gesperrt' : ''}`}
            role="status"
            aria-live="polite"
          >
            <span className="media-halten-punkt" aria-hidden="true" />
            <span className="media-halten-zeit">{formatClock(dauer)}</span>
            {zustand === 'haelt' && (
              <>
                <span
                  className="media-halten-hinweis"
                  style={{ transform: `translateX(${versatz}px)`, opacity: 1 - anteil * 0.7 }}
                >
                  ‹ Zum Abbrechen wischen
                </span>
                <span className="media-halten-schloss" aria-hidden="true">
                  🔒
                  <br />↑
                </span>
              </>
            )}
            {zustand === 'gesperrt' && (
              <>
                <span className="media-halten-hinweis">Aufnahme läuft</span>
                <button type="button" className="btn btn-ghost btn-sm" onClick={verwerfen}>
                  Verwerfen
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => void senden()}
                  autoFocus
                >
                  Senden
                </button>
              </>
            )}
            {zustand === 'sendet' && <span className="media-halten-hinweis">Wird gesendet …</span>}
          </div>,
          document.body,
        )}
    </>
  );
}
