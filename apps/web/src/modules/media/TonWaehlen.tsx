import { useEffect, useRef, useState } from 'react';

import { toast } from '../../state/ui.js';
import {
  AUDIO_MIME_CANDIDATES,
  deviceErrorMessage,
  errorMessage,
  formatClock,
  pickRecorderMime,
  supportsCapture,
  supportsRecorder,
} from './helpers.js';
import { TonWerkstatt, type TonErgebnis } from './TonWerkstatt.js';

/**
 * Einen Ton besorgen: selbst aufnehmen oder eine Datei aussuchen.
 *
 * Danach geht es in die Werkstatt, und am Ende kommt ein fertiger Blob heraus.
 * Steht getrennt von `TonWerkstatt`, weil beide Hälften einzeln gebraucht
 * werden – die Sprachnachricht hat ihre Aufnahme schon und braucht nur die
 * Werkstatt.
 *
 * # Warum das Aufnehmen hier noch einmal steht und nicht aus `VoiceSheet` kommt
 *
 * Weil `VoiceSheet` ein ganzes Blatt ist, mit Pegelanzeige, Fünf-Minuten-Uhr
 * und einem Sendeknopf, der eine Nachricht verschickt. Was hier gebraucht
 * wird, sind zwanzig Zeilen `MediaRecorder` ohne all das. Sie
 * herauszuoperieren hiesse, das Blatt für einen Sonderfall umzubauen, den es
 * nicht kennt.
 */
export function TonWaehlen({
  maxSekunden,
  onFertig,
  onAbbruch,
}: {
  maxSekunden: number;
  onFertig: (ergebnis: TonErgebnis) => void;
  onAbbruch: () => void;
}) {
  const [roh, setRoh] = useState<Blob | null>(null);
  const [nimmtAuf, setNimmtAuf] = useState(false);
  const [sekunden, setSekunden] = useState(0);
  const aufnehmer = useRef<MediaRecorder | null>(null);
  const strom = useRef<MediaStream | null>(null);
  const stuecke = useRef<Blob[]>([]);
  const uhr = useRef<number | null>(null);
  const datei = useRef<HTMLInputElement | null>(null);

  const kannAufnehmen = supportsRecorder() && supportsCapture();

  const aufraeumen = () => {
    if (uhr.current !== null) window.clearInterval(uhr.current);
    uhr.current = null;
    strom.current?.getTracks().forEach((spur) => spur.stop());
    strom.current = null;
    aufnehmer.current = null;
  };

  useEffect(() => aufraeumen, []);

  const beenden = () => {
    const laeuft = aufnehmer.current;
    if (laeuft && laeuft.state !== 'inactive') laeuft.stop();
    setNimmtAuf(false);
  };

  const starten = async () => {
    if (nimmtAuf) {
      beenden();
      return;
    }
    const typ = pickRecorderMime(AUDIO_MIME_CANDIDATES);
    if (!typ) {
      toast('Dieser Browser kann nicht aufnehmen. Nimm eine Datei.', 'error');
      return;
    }
    try {
      const gerät = await navigator.mediaDevices.getUserMedia({ audio: true });
      strom.current = gerät;
      const recorder = new MediaRecorder(gerät, { mimeType: typ });
      stuecke.current = [];
      recorder.ondataavailable = (ereignis) => {
        if (ereignis.data.size > 0) stuecke.current.push(ereignis.data);
      };
      recorder.onstop = () => {
        const fertig = new Blob(stuecke.current, { type: typ });
        aufraeumen();
        setSekunden(0);
        if (fertig.size > 0) setRoh(fertig);
      };
      aufnehmer.current = recorder;
      recorder.start();
      setNimmtAuf(true);
      setSekunden(0);
      /*
       * Die Uhr läuft bis zur Grenze plus zwei Sekunden – nicht exakt bis
       * zur Grenze.
       *
       * Ein Sticker darf acht Sekunden klingen, und wer genau acht Sekunden
       * aufnimmt, schneidet sich am Ende selbst ab. Der Puffer gibt Raum zum
       * Zuschneiden; die harte Grenze zieht die Werkstatt.
       */
      const grenze = maxSekunden + 2;
      uhr.current = window.setInterval(() => {
        setSekunden((vorher) => {
          const jetzt = vorher + 0.1;
          if (jetzt >= grenze) beenden();
          return jetzt;
        });
      }, 100);
    } catch (ausfall) {
      aufraeumen();
      setNimmtAuf(false);
      toast(deviceErrorMessage(ausfall, 'Mikrofon'), 'error');
    }
  };

  if (roh) {
    return (
      <TonWerkstatt
        blob={roh}
        maxSekunden={maxSekunden}
        uebernehmenText="Ton übernehmen"
        onAbbruch={() => setRoh(null)}
        onFertig={onFertig}
      />
    );
  }

  return (
    <div className="stack">
      <p className="ton-hinweis">
        Höchstens {maxSekunden} Sekunden. Danach lässt sich der Ausschnitt wählen und der Klang
        verbiegen.
      </p>
      <div className="row" style={{ gap: 'var(--space-2)' }}>
        <button
          type="button"
          className={`btn ${nimmtAuf ? 'btn-danger' : 'btn-primary'}`}
          style={{ flex: 1 }}
          onClick={() => void starten()}
          disabled={!kannAufnehmen}
        >
          {nimmtAuf ? `⏹ Stopp ${formatClock(Math.round(sekunden * 1000))}` : '🎤 Aufnehmen'}
        </button>
        <button
          type="button"
          className="btn"
          style={{ flex: 1 }}
          onClick={() => datei.current?.click()}
          disabled={nimmtAuf}
        >
          📁 Datei
        </button>
      </div>
      {!kannAufnehmen && (
        <p className="ton-hinweis">
          Dieser Browser kann nicht aufnehmen – über „Datei“ geht es trotzdem.
        </p>
      )}
      <input
        ref={datei}
        type="file"
        accept="audio/*"
        hidden
        onChange={(ereignis) => {
          const gewaehlt = ereignis.target.files?.[0];
          // Das Feld wird geleert, damit DIESELBE Datei ein zweites Mal
          // gewählt werden kann – ohne das feuert `change` nicht noch einmal.
          ereignis.target.value = '';
          if (!gewaehlt) return;
          try {
            setRoh(gewaehlt);
          } catch (ausfall) {
            toast(errorMessage(ausfall, 'Diese Datei ging nicht'), 'error');
          }
        }}
      />
      <button type="button" className="btn btn-ghost" onClick={onAbbruch} disabled={nimmtAuf}>
        Abbrechen
      </button>
    </div>
  );
}
