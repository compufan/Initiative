import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, type AdminStatus } from '../../lib/api.js';
import { toast } from '../../state/ui.js';
import { errorMessage } from './helpers.js';

/**
 * Admin-Modus ein- und ausschalten.
 *
 * Das Passwort wird ausschließlich auf dem Server geprüft (`ADMIN_PASSWORD`);
 * hier läuft nur die Eingabe. Freigeschaltet wird `users.is_admin` in der
 * Datenbank – wer den Schalter im Browser manipuliert, gewinnt dadurch nichts,
 * weil jede Admin-Route den Status serverseitig nachschlägt.
 */
export function AdminCard() {
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api.admin
      .status()
      .then((result) => {
        if (!cancelled) setStatus(result);
      })
      .catch(() => {
        // Ältere Server kennen den Endpunkt nicht – dann bleibt die Karte weg.
        if (!cancelled) setStatus({ available: false, isAdmin: false });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Nichts hinterlegt und keine Rechte: die Karte wäre nur Rauschen.
  if (!status || (!status.available && !status.isAdmin)) return null;

  async function unlock(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      setStatus(await api.admin.unlock(password));
      setPassword('');
      setOpen(false);
      toast('Admin-Modus ist an', 'success');
    } catch (error) {
      toast(errorMessage(error, 'Freischalten fehlgeschlagen'), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function lock() {
    setBusy(true);
    try {
      setStatus(await api.admin.lock());
      toast('Admin-Modus ist aus', 'success');
    } catch (error) {
      toast(errorMessage(error, 'Abschalten fehlgeschlagen'), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card stack" aria-labelledby="prf-admin-title" id="admin">
      <h2 className="prf-block-title" id="prf-admin-title">
        Verwaltung
      </h2>

      {status.isAdmin ? (
        <>
          <div className="prf-note is-ok">
            <strong>Admin-Modus ist an</strong>
            <p className="prf-hint">
              Du kannst Einladungscodes erstellen und Mitglieder entfernen.
            </p>
          </div>
          <Link className="btn btn-primary" to="/verwaltung">
            Verwaltung öffnen
          </Link>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void lock()}>
            Admin-Modus abschalten
          </button>
        </>
      ) : open ? (
        <form className="stack" onSubmit={(event) => void unlock(event)}>
          <div className="field">
            <label htmlFor="prf-admin-password">Admin-Passwort</label>
            <input
              id="prf-admin-password"
              className="input"
              type="password"
              autoComplete="off"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          <div className="prf-dialog-actions">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                setPassword('');
              }}
            >
              Abbrechen
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy || !password}>
              Freischalten
            </button>
          </div>
        </form>
      ) : (
        <>
          <p className="prf-hint">
            Mit dem Admin-Passwort schaltest du die Verwaltung frei: Einladungscodes erstellen und
            zurückziehen, Mitglieder sehen und entfernen.
          </p>
          <button type="button" className="btn" onClick={() => setOpen(true)}>
            Admin-Modus freischalten
          </button>
        </>
      )}
    </section>
  );
}
