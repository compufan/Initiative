import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { useSession } from '../../state/session.js';
import { toast } from '../../state/ui.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { absoluteUrl, copyText, errorMessage } from './helpers.js';

/**
 * The personal ICS feed.
 *
 * The address contains an unguessable token instead of a password, so it can be
 * pasted into any calendar app – and revoked here when it got into the wrong
 * hands.
 */
export function CalendarCard() {
  const navigate = useNavigate();
  const user = useSession((state) => state.user);
  const [busy, setBusy] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);

  const url = user?.calendarToken ? absoluteUrl(api.calendar.icsUrl(user.calendarToken)) : null;

  async function copy() {
    if (!url) return;
    if (await copyText(url)) toast('Link kopiert', 'success');
    else toast('Link konnte nicht kopiert werden', 'error');
  }

  async function rotate() {
    setBusy(true);
    try {
      const { calendarToken } = await api.auth.rotateCalendarToken();
      const current = useSession.getState().user;
      if (current) useSession.getState().setUser({ ...current, calendarToken });
      setConfirmRotate(false);
      toast('Neue Adresse erzeugt – alte Abos zeigen nichts mehr an', 'success');
    } catch (error) {
      toast(errorMessage(error, 'Adresse konnte nicht neu erzeugt werden'), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card stack" id="kalender" aria-labelledby="prf-calendar-title">
      <h2 className="prf-block-title" id="prf-calendar-title">
        Kalender
      </h2>
      <p className="prf-hint">
        Diese Adresse trägst du einmal in deiner Kalender-App ein – danach stehen alle Termine aus
        Initiative automatisch dort drin.
      </p>

      {url ? (
        <>
          <p className="prf-url">{url}</p>
          <button type="button" className="btn btn-primary btn-block" onClick={() => void copy()}>
            🔗 Link kopieren
          </button>
          <button type="button" className="btn btn-block" onClick={() => navigate('/kalender')}>
            📆 Anleitung im Kalender ansehen
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-block"
            disabled={busy}
            onClick={() => setConfirmRotate(true)}
          >
            Adresse neu erzeugen
          </button>
          <p className="prf-hint">
            Wer den Link hat, sieht deine Termine. Neu erzeugen macht ihn ungültig – bestehende Abos
            musst du danach neu einrichten.
          </p>
        </>
      ) : (
        <p className="prf-hint">
          Die Abo-Adresse ist noch nicht geladen. Sobald du wieder online bist, erscheint sie hier.
        </p>
      )}

      <ConfirmDialog
        open={confirmRotate}
        title="Adresse neu erzeugen?"
        description="Alle Kalender, die den bisherigen Link abonniert haben, zeigen danach keine Termine mehr an."
        confirmLabel="Neu erzeugen"
        danger
        busy={busy}
        onCancel={() => setConfirmRotate(false)}
        onConfirm={() => void rotate()}
      />
    </section>
  );
}
