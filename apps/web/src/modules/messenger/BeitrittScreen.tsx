import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { BeitrittVorschauDto } from '@initiative/shared';
import { Avatar } from '../../components/Avatar.js';
import { EmptyState, Spinner } from '../../components/Feedback.js';
import { Screen } from '../../components/Screen.js';
import { api, ApiError } from '../../lib/api.js';
import { verwaltung } from '../../lib/verwaltungApi.js';
import { useChat } from '../../state/chat.js';
import { toast } from '../../state/ui.js';
import './verwaltung.css';

/**
 * `/join/:token` – die Vorschau eines Einladungslinks.
 *
 * Gezeigt wird, was der Server für die Vorschau hergibt: Name, Bild,
 * Beschreibung und Mitgliederzahl, keine Nachricht und keine Mitgliederliste.
 * Wer nicht angemeldet ist, meldet sich zuerst an; die Adresse bleibt stehen,
 * und danach geht es hier weiter.
 */
export function BeitrittScreen() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const [vorschau, setVorschau] = useState<BeitrittVorschauDto | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [angefragt, setAngefragt] = useState(false);

  useEffect(() => {
    let weg = false;
    verwaltung.links
      .vorschau(token)
      .then((daten) => {
        if (weg) return;
        setVorschau(daten);
        setAngefragt(daten.anfrageOffen);
      })
      .catch((error) => {
        if (weg) return;
        setFehler(
          error instanceof ApiError && error.status === 429
            ? 'Zu viele Versuche mit Einladungslinks. Warte einen Moment.'
            : 'Dieser Einladungslink ist ungültig oder abgelaufen.',
        );
      });
    return () => {
      weg = true;
    };
  }, [token]);

  async function beitreten() {
    setBusy(true);
    try {
      const ergebnis = await verwaltung.links.beitreten(token);
      if (ergebnis.status === 'angefragt') {
        setAngefragt(true);
        toast('Anfrage gestellt – ein Admin entscheidet', 'success');
        return;
      }
      if (ergebnis.conversationId) {
        const chat = await api.conversations.byId(ergebnis.conversationId);
        useChat.getState().upsertConversation(chat);
        toast(ergebnis.status === 'mitglied' ? 'Du bist schon dabei' : 'Willkommen!', 'success');
        navigate(`/chats/${ergebnis.conversationId}`, { replace: true });
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Beitreten fehlgeschlagen', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen title="Einladung" back="/chats">
      {!vorschau && !fehler && (
        <div style={{ padding: 'var(--space-5)' }}>
          <Spinner label="Einladung wird geladen" />
        </div>
      )}
      {fehler && <EmptyState emoji="🔗" title="Link geht nicht" description={fehler} />}
      {vorschau && (
        <section
          className="card stack"
          aria-labelledby="beitritt-titel"
          style={{ textAlign: 'center' }}
        >
          <div style={{ display: 'grid', placeItems: 'center' }}>
            <Avatar
              name={vorschau.title ?? 'Gruppe'}
              id={token}
              url={vorschau.avatarUrl}
              size={88}
            />
          </div>
          <h2 id="beitritt-titel" className="card-title" style={{ margin: 0 }}>
            {vorschau.title ?? 'Gruppe'}
          </h2>
          <span className="muted">
            {vorschau.memberCount === 1 ? '1 Mitglied' : `${vorschau.memberCount} Mitglieder`}
          </span>
          {vorschau.description && <p className="gv-beschreibung">{vorschau.description}</p>}
          {vorschau.schonMitglied && vorschau.conversationId ? (
            <button
              type="button"
              className="btn btn-primary btn-block"
              onClick={() => navigate(`/chats/${vorschau.conversationId}`, { replace: true })}
            >
              Zum Chat – du bist schon dabei
            </button>
          ) : angefragt ? (
            <p role="status" style={{ margin: 0 }}>
              Deine Anfrage liegt bei den Admins. Sobald jemand zustimmt, erscheint die Gruppe in
              deinen Chats.
            </p>
          ) : (
            <>
              <button
                type="button"
                className="btn btn-primary btn-block"
                disabled={busy}
                onClick={() => void beitreten()}
              >
                {vorschau.freigabe ? 'Beitritt anfragen' : 'Gruppe beitreten'}
              </button>
              <span className="faint" style={{ fontSize: '0.78rem' }}>
                {vorschau.freigabe ? 'Ein Admin muss deine Anfrage annehmen. ' : ''}
                Du siehst Nachrichten ab deinem Beitritt.
              </span>
            </>
          )}
        </section>
      )}
    </Screen>
  );
}
