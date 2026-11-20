import { useEffect, useRef, useState } from 'react';
import type { MessageRendererProps } from '../types.js';
import { api, ApiError } from '../../lib/api.js';
import { toast } from '../../state/ui.js';

/**
 * Ein einmal ansehbares Foto oder Video.
 *
 * Die Blase zeigt nie das Bild selbst – keine Vorschau, keine Miniatur. Erst
 * „Öffnen“ holt die Bytes (genau einmal je Person, danach sagt der Server 410)
 * und zeigt sie bildschirmfüllend; beim Schliessen wird die Kopie im Speicher
 * verworfen. Der Absender sieht nur, ob geöffnet wurde.
 *
 * Ehrlich: Ein Bildschirmfoto lässt sich im Web nicht verhindern. Das sagt die
 * App beim Senden und hier beim Ansehen.
 */
export function EinmalBubble({ message, isMine }: MessageRendererProps) {
  const anhang = message.attachments[0];
  const istVideo = message.type === 'video' || anhang?.kind === 'video';
  const status = message.metadata?.einmalStatus;
  const [lokalGeoeffnet, setLokalGeoeffnet] = useState(false);
  const [ansicht, setAnsicht] = useState<string | null>(null);
  const [laedt, setLaedt] = useState(false);
  const schliessenRef = useRef<HTMLButtonElement>(null);
  const art = istVideo ? 'Video' : 'Foto';
  const geoeffnet = status?.ichGeoeffnet || lokalGeoeffnet;

  useEffect(() => {
    if (!ansicht) return undefined;
    schliessenRef.current?.focus();
    const beiTaste = (event: KeyboardEvent) => {
      if (event.key === 'Escape') schliessen();
    };
    window.addEventListener('keydown', beiTaste);
    return () => window.removeEventListener('keydown', beiTaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ansicht]);

  function schliessen() {
    if (ansicht) URL.revokeObjectURL(ansicht);
    setAnsicht(null);
  }

  async function oeffnen() {
    if (!anhang || laedt) return;
    setLaedt(true);
    try {
      const blob = await api.messages.einmalOeffnen(message.id, anhang.id);
      setLokalGeoeffnet(true);
      setAnsicht(URL.createObjectURL(blob));
    } catch (fehler) {
      if (fehler instanceof ApiError && fehler.status === 410) {
        setLokalGeoeffnet(true);
        toast('Schon geöffnet – einmal ansehbar heisst einmal', 'info');
      } else {
        toast('Konnte nicht geöffnet werden', 'error');
      }
    } finally {
      setLaedt(false);
    }
  }

  const tone = isMine ? 'msg-bubble-mine' : 'msg-bubble-theirs';
  let zeile: string;
  if (isMine) {
    zeile = status && status.geoeffnet > 0 ? `Geöffnet${status.geoeffnet > 1 ? ` (${status.geoeffnet})` : ''}` : 'Noch nicht geöffnet';
  } else {
    zeile = geoeffnet ? 'Geöffnet' : `${art} – einmal ansehbar`;
  }

  return (
    <div className={`msg-bubble ${tone} msg-einmal`}>
      {isMine || geoeffnet ? (
        <span className="msg-einmal-zeile">
          <span className="msg-einmal-symbol" aria-hidden="true">
            1
          </span>
          <span>
            {isMine ? `${art} – einmal ansehbar` : zeile}
            {isMine && <small className="msg-einmal-status">{zeile}</small>}
          </span>
        </span>
      ) : (
        <button
          type="button"
          className="msg-einmal-zeile msg-einmal-oeffnen"
          disabled={laedt || message.pending}
          onClick={() => void oeffnen()}
          aria-label={`${art} einmal ansehen – danach ist es fort`}
        >
          <span className="msg-einmal-symbol" aria-hidden="true">
            1
          </span>
          <span>
            {zeile}
            <small className="msg-einmal-status">Antippen zum Öffnen</small>
          </span>
        </button>
      )}

      {ansicht && (
        <div
          className="msg-einmal-ansicht"
          role="dialog"
          aria-modal="true"
          aria-label={`Einmal ansehbares ${art}`}
          onContextMenu={(event) => event.preventDefault()}
        >
          {istVideo ? (
            // eslint-disable-next-line jsx-a11y/media-has-caption
            <video src={ansicht} autoPlay controls controlsList="nodownload" playsInline />
          ) : (
            <img src={ansicht} alt={`Einmal ansehbares ${art}`} draggable={false} />
          )}
          <p className="msg-einmal-hinweis">
            Nach dem Schliessen ist es fort. Bildschirmfotos lassen sich im Web nicht verhindern.
          </p>
          <button ref={schliessenRef} type="button" className="btn btn-primary" onClick={schliessen}>
            Schliessen
          </button>
        </div>
      )}
    </div>
  );
}
