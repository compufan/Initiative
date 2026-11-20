import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Sheet } from '../../components/Sheet.js';
import { api } from '../../lib/api.js';
import { toast } from '../../state/ui.js';
import { useChat } from '../../state/chat.js';

/** Heute als `JJJJ-MM-TT` in Ortszeit – für `max` des Datumsfelds. */
function heute(): string {
  const jetzt = new Date();
  const zwei = (n: number) => String(n).padStart(2, '0');
  return `${jetzt.getFullYear()}-${zwei(jetzt.getMonth() + 1)}-${zwei(jetzt.getDate())}`;
}

/**
 * Das Menü im Chat-Kopf: Info, Suche, Springen zum Datum, gespeicherte
 * Nachrichten.
 *
 * Springen zum Datum: Der Server liefert die erste Nachricht ab Mitternacht
 * des Tages (Ortszeit, `?ab=`; Index 0029), der Chat holt den Verlauf bis
 * dorthin in einem Zug und springt. Das Datumsfeld ist das des Geräts – ein
 * Kalender, den Tastatur und Vorlesehilfe kennen.
 */
export function ChatMenue({
  open,
  conversationId,
  onClose,
  onInfo,
  onSuche,
  onSprung,
  onUnten,
  onSelbstloeschen,
  onGeplant,
}: {
  open: boolean;
  conversationId: string;
  onClose: () => void;
  onInfo: () => void;
  onSuche: () => void;
  onSprung: (messageId: string) => Promise<void> | void;
  onUnten: () => void;
  /** Selbstlöschende Nachrichten einstellen. */
  onSelbstloeschen?: () => void;
  /** Die Liste „Geplant“ dieses Chats. */
  onGeplant?: () => void;
}) {
  const [datumOffen, setDatumOffen] = useState(false);
  const [datum, setDatum] = useState(heute());
  const [laeuft, setLaeuft] = useState(false);

  function schliessen() {
    setDatumOffen(false);
    onClose();
  }

  async function springen() {
    if (!datum) return;
    const [jahr, monat, tag] = datum.split('-').map(Number);
    const ab = new Date(jahr, monat - 1, tag, 0, 0, 0);
    setLaeuft(true);
    try {
      const { items } = await api.messages.ab(conversationId, ab.toISOString());
      schliessen();
      const ziel = items[0];
      if (!ziel) {
        toast('Ab diesem Tag gibt es keine Nachrichten', 'info');
        onUnten();
        return;
      }
      // Schon geladen und ganz unten? Dann genügt der Sprung.
      await useChat.getState().ladenBis(conversationId, ziel.id);
      await onSprung(ziel.id);
    } catch {
      toast('Springen hat nicht geklappt', 'error');
    } finally {
      setLaeuft(false);
    }
  }

  return (
    <Sheet open={open} onClose={schliessen} title={datumOffen ? 'Zu Datum springen' : 'Chat'}>
      {datumOffen ? (
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            void springen();
          }}
        >
          <div className="field">
            <label htmlFor="chat-datum">Tag</label>
            <input
              id="chat-datum"
              type="date"
              className="input"
              value={datum}
              max={heute()}
              required
              autoFocus
              onChange={(event) => setDatum(event.target.value)}
            />
          </div>
          <div className="row" style={{ gap: 'var(--space-2)' }}>
            <button type="button" className="btn btn-ghost" onClick={() => setDatumOffen(false)}>
              Zurück
            </button>
            <button type="submit" className="btn btn-primary" style={{ flex: 1 }} disabled={laeuft}>
              {laeuft ? 'Springe …' : 'Springen'}
            </button>
          </div>
        </form>
      ) : (
        <div className="list msg-action-list">
          <button
            type="button"
            className="list-row"
            onClick={() => {
              schliessen();
              onInfo();
            }}
          >
            <span aria-hidden="true">ℹ️</span>
            <span>Chat-Info</span>
          </button>
          <button
            type="button"
            className="list-row"
            onClick={() => {
              schliessen();
              onSuche();
            }}
          >
            <span aria-hidden="true">🔍</span>
            <span>Im Chat suchen</span>
          </button>
          <button type="button" className="list-row" onClick={() => setDatumOffen(true)}>
            <span aria-hidden="true">📅</span>
            <span>Zu Datum springen</span>
          </button>
          {onGeplant && (
            <button
              type="button"
              className="list-row"
              onClick={() => {
                schliessen();
                onGeplant();
              }}
            >
              <span aria-hidden="true">🕒</span>
              <span>Geplante Nachrichten</span>
            </button>
          )}
          {onSelbstloeschen && (
            <button
              type="button"
              className="list-row"
              onClick={() => {
                schliessen();
                onSelbstloeschen();
              }}
            >
              <span aria-hidden="true">⏱</span>
              <span>Selbstlöschende Nachrichten</span>
            </button>
          )}
          <Link className="list-row" to="/gespeichert" onClick={schliessen}>
            <span aria-hidden="true">⭐</span>
            <span>Gespeicherte Nachrichten</span>
          </Link>
        </div>
      )}
    </Sheet>
  );
}
