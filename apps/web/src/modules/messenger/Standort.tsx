import { useEffect, useRef, useState } from 'react';
import { liveLaeuft, liveRestText, uuidv7, type Standort } from '@initiative/shared';
import { Sheet } from '../../components/Sheet.js';
import { KartenBlatt } from '../../components/KartenBlatt.js';
import { api } from '../../lib/api.js';
import { useChat } from '../../state/chat.js';
import { toast } from '../../state/ui.js';
import type { ComposerActionProps, MessageRendererProps } from '../types.js';
import { liveFreigabe, useLiveAktiv } from './liveStandort.js';

function koordinaten(lat: number, lon: number): string {
  const f = (wert: number, plus: string, minus: string) =>
    `${Math.abs(wert).toFixed(5)}° ${wert >= 0 ? plus : minus}`;
  return `${f(lat, 'N', 'S')}, ${f(lon, 'O', 'W')}`;
}

function uhrzeit(iso?: string): string {
  return iso ? new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '';
}

/**
 * Die Karte ohne Karte: kein Kachelserver, keine Bilder von Dritten. Ein
 * stilisiertes Feld mit Nadel, die Koordinaten, die Genauigkeit und – wenn
 * die Rückwärtssuche etwas fand – die Adresse. „In Karten-App öffnen“ gibt
 * den Punkt erst auf Tipp an die App des Empfängers.
 */
function Punktkarte({ standort }: { standort: Standort }) {
  const knopf = useRef<HTMLButtonElement>(null);
  const [offen, setOffen] = useState(false);
  return (
    <div className="msg-standort-karte">
      <div className="msg-standort-feld" aria-hidden="true">
        <span className="msg-standort-nadel">📍</span>
        {standort.genauigkeit != null && <span className="msg-standort-kreis" />}
      </div>
      <div className="msg-standort-angaben">
        {standort.adresse && <strong>{standort.adresse}</strong>}
        <span>{koordinaten(standort.lat, standort.lon)}</span>
        {standort.genauigkeit != null && <small>Genauigkeit ± {Math.round(standort.genauigkeit)} m</small>}
      </div>
      <button ref={knopf} type="button" className="btn btn-sm" onClick={() => setOffen(true)}>
        In Karten-App öffnen
      </button>
      <KartenBlatt
        open={offen}
        onClose={() => setOffen(false)}
        ziel={{ art: 'punkt', breite: standort.lat, laenge: standort.lon }}
        offen={false}
        ausloeser={knopf}
      />
    </div>
  );
}

export function StandortBubble({ message, isMine }: MessageRendererProps) {
  const standort = message.metadata?.standort;
  const aktivHier = useLiveAktiv((state) => state.ids.includes(message.id));
  const [, setTakt] = useState(0);
  const live = standort?.live;
  const laeuft = liveLaeuft(live);
  useEffect(() => {
    if (!laeuft) return undefined;
    const id = window.setInterval(() => setTakt((t) => t + 1), 30_000);
    return () => window.clearInterval(id);
  }, [laeuft]);
  const tone = isMine ? 'msg-bubble-mine' : 'msg-bubble-theirs';
  if (message.deletedAt || !standort) {
    return (
      <div className={`msg-bubble ${tone} msg-bubble-deleted`}>
        <em>{message.deletedAt ? 'Diese Nachricht wurde gelöscht' : 'Standort nicht verfügbar'}</em>
      </div>
    );
  }
  return (
    <div className={`msg-bubble ${tone} msg-standort`}>
      {live && (
        <p className={`msg-standort-live${laeuft ? ' is-live' : ''}`} role="status">
          {laeuft ? (
            <>
              <span aria-hidden="true">🔴</span> Live · aktualisiert {uhrzeit(live.aktualisiert)} ·{' '}
              {liveRestText(live)}
            </>
          ) : (
            <>Live beendet · zuletzt {uhrzeit(live.aktualisiert)}</>
          )}
        </p>
      )}
      <Punktkarte standort={standort} />
      {isMine && laeuft && (
        <button
          type="button"
          className="btn btn-sm btn-danger"
          onClick={() => {
            if (aktivHier) liveFreigabe().beenden(message.id);
            else void api.messages.standortBeenden(message.id).catch(() => {});
          }}
        >
          Live-Standort beenden
        </button>
      )}
    </div>
  );
}

type Ortung =
  | { art: 'sucht' }
  | { art: 'fehler'; text: string }
  | { art: 'da'; lat: number; lon: number; genauigkeit: number };

/** Standort teilen: einmalig oder live (15/60 min, solange die App offen ist). */
export function StandortTeilenAktion({ conversationId, onClose }: ComposerActionProps) {
  const [ortung, setOrtung] = useState<Ortung>({ art: 'sucht' });
  const [adresse, setAdresse] = useState<string | null>(null);
  const [quelle, setQuelle] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!('geolocation' in navigator)) {
      setOrtung({ art: 'fehler', text: 'Dieses Gerät kann keinen Standort bestimmen.' });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const punkt = {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          genauigkeit: Math.round(pos.coords.accuracy),
        };
        setOrtung({ art: 'da', ...punkt });
        api.orte
          .rueckwaerts(punkt.lat, punkt.lon)
          .then((antwort) => {
            if (antwort.item) {
              setAdresse(antwort.item.text);
              setQuelle(antwort.quelle);
            }
          })
          .catch(() => {});
      },
      (fehler) =>
        setOrtung({
          art: 'fehler',
          text:
            fehler.code === fehler.PERMISSION_DENIED
              ? 'Der Zugriff auf den Standort ist nicht erlaubt. Du kannst ihn in den Einstellungen des Browsers freigeben.'
              : 'Der Standort liess sich nicht bestimmen.',
        }),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 10_000 },
    );
  }, []);

  async function senden(minuten: 15 | 60 | null) {
    if (ortung.art !== 'da') return;
    const standort: Standort = {
      lat: ortung.lat,
      lon: ortung.lon,
      genauigkeit: ortung.genauigkeit,
      ...(adresse ? { adresse } : {}),
    };
    if (minuten == null) {
      onClose();
      await useChat
        .getState()
        .sendMessage(conversationId, { type: 'location', metadata: { standort } })
        .catch(() => toast('Standort konnte nicht gesendet werden', 'error'));
      return;
    }
    // Live braucht die Kennung der Nachricht – also direkt und nicht über die
    // Outbox; ohne Netz gibt es ohnehin keinen Live-Standort.
    setBusy(true);
    try {
      const nachricht = await api.messages.send(conversationId, {
        type: 'location',
        clientId: uuidv7(),
        metadata: { standort: { ...standort, live: { minuten } } },
      });
      useChat.getState().applyMessage(nachricht);
      const bis = nachricht.metadata.standort?.live?.bis;
      if (bis) liveFreigabe().starten(nachricht.id, bis);
      onClose();
    } catch (fehler) {
      toast(fehler instanceof Error ? fehler.message : 'Live-Standort ging nicht', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open onClose={onClose} title="Standort teilen">
      <div className="stack">
        {ortung.art === 'sucht' && <p role="status">Standort wird bestimmt …</p>}
        {ortung.art === 'fehler' && (
          <p className="msg-geplant-fehler" role="alert">
            {ortung.text}
          </p>
        )}
        {ortung.art === 'da' && (
          <>
            <Punktkarte
              standort={{
                lat: ortung.lat,
                lon: ortung.lon,
                genauigkeit: ortung.genauigkeit,
                ...(adresse ? { adresse } : {}),
              }}
            />
            {quelle && <small className="msg-action-hint">Adresse: {quelle}</small>}
            <button
              type="button"
              className="btn btn-primary btn-block"
              disabled={busy}
              onClick={() => void senden(null)}
            >
              📍 Diesen Standort senden
            </button>
            <fieldset className="msg-live-wahl">
              <legend>Live-Standort – nur solange die App offen ist</legend>
              <div className="row" style={{ gap: 'var(--space-2)' }}>
                <button type="button" className="btn" disabled={busy} onClick={() => void senden(15)}>
                  Live 15 min
                </button>
                <button type="button" className="btn" disabled={busy} onClick={() => void senden(60)}>
                  Live 60 min
                </button>
              </div>
              <small className="msg-action-hint">
                Die Freigabe endet, sobald du die App schliesst oder sie in den Hintergrund geht –
                spätestens nach der gewählten Zeit. Die anderen sehen deine letzte Position mit Uhrzeit.
              </small>
            </fieldset>
          </>
        )}
      </div>
    </Sheet>
  );
}
