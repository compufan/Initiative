import { useState, type FormEvent } from 'react';
import { api } from '../../lib/api.js';
import { useSession } from '../../state/session.js';
import { toast } from '../../state/ui.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { errorMessage } from './helpers.js';

const MIN_PASSWORD = 8;

/** Password change and the way out of the app. */
export function AccountCard() {
  const username = useSession((state) => state.user?.username ?? '');
  const [open, setOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);

  function reset() {
    setCurrentPassword('');
    setNewPassword('');
    setRepeat('');
    setError(null);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (currentPassword.length === 0) {
      setError('Bitte gib dein aktuelles Passwort ein.');
      return;
    }
    if (newPassword.length < MIN_PASSWORD) {
      setError(`Das neue Passwort braucht mindestens ${MIN_PASSWORD} Zeichen.`);
      return;
    }
    if (newPassword !== repeat) {
      setError('Die beiden neuen Passwörter sind nicht gleich.');
      return;
    }
    if (newPassword === currentPassword) {
      setError('Das neue Passwort muss sich vom alten unterscheiden.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await api.auth.changePassword({ currentPassword, newPassword });
      reset();
      setOpen(false);
      setChanged(true);
      toast('Passwort geändert', 'success');
    } catch (caught) {
      setError(errorMessage(caught, 'Passwort konnte nicht geändert werden'));
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    setBusy(true);
    try {
      await useSession.getState().logout();
    } catch (caught) {
      toast(errorMessage(caught, 'Abmelden fehlgeschlagen'), 'error');
      setBusy(false);
      setConfirmLogout(false);
    }
  }

  return (
    <section className="card stack" aria-labelledby="prf-account-title">
      <h2 className="prf-block-title" id="prf-account-title">
        Konto
      </h2>
      <p className="prf-hint">Angemeldet als @{username}</p>

      {changed && (
        <div className="prf-note is-ok">
          <strong>Passwort geändert</strong>
          <p className="prf-hint">
            Alle anderen Geräte wurden abgemeldet. Dort musst du dich einmal neu anmelden.
          </p>
        </div>
      )}

      {open ? (
        <form className="stack" onSubmit={(event) => void submit(event)}>
          <div className="field">
            <label htmlFor="prf-current-password">Aktuelles Passwort</label>
            <input
              id="prf-current-password"
              className="input"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="prf-new-password">Neues Passwort</label>
            <input
              id="prf-new-password"
              className="input"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
            <span className="prf-hint">Mindestens {MIN_PASSWORD} Zeichen.</span>
          </div>
          <div className="field">
            <label htmlFor="prf-repeat-password">Neues Passwort wiederholen</label>
            <input
              id="prf-repeat-password"
              className="input"
              type="password"
              autoComplete="new-password"
              value={repeat}
              onChange={(event) => setRepeat(event.target.value)}
            />
          </div>
          {error && <p className="prf-error">{error}</p>}
          <div className="prf-edit-actions">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => {
                reset();
                setOpen(false);
              }}
            >
              Abbrechen
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              Passwort speichern
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          className="btn btn-block"
          onClick={() => {
            setChanged(false);
            setOpen(true);
          }}
        >
          🔑 Passwort ändern
        </button>
      )}

      <button
        type="button"
        className="btn btn-danger btn-block"
        disabled={busy}
        onClick={() => setConfirmLogout(true)}
      >
        Abmelden
      </button>

      <ConfirmDialog
        open={confirmLogout}
        title="Abmelden?"
        description="Die auf diesem Gerät gespeicherten Chats werden gelöscht. Deine Nachrichten bleiben auf dem Server."
        confirmLabel="Abmelden"
        danger
        busy={busy}
        onCancel={() => setConfirmLogout(false)}
        onConfirm={() => void logout()}
      />
    </section>
  );
}
