import { useEffect, useState, type FormEvent } from 'react';
import { ApiError } from '../lib/api.js';
import { loginWithPasskey, passkeysUsable } from '../lib/passkeys.js';
import { useSession } from '../state/session.js';

type Mode = 'login' | 'register';

/** Sign-in / sign-up. Deliberately minimal: username + password, no e-mail. */
export function AuthScreen() {
  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [biometricsReady, setBiometricsReady] = useState(false);

  const login = useSession((state) => state.login);
  const register = useSession((state) => state.register);
  const applySession = useSession((state) => state.applySession);

  useEffect(() => {
    let cancelled = false;
    void passkeysUsable().then((value) => {
      if (!cancelled) setBiometricsReady(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Anmelden mit Face ID, Fingerabdruck oder Geräte-PIN. */
  async function signInWithDevice() {
    if (!username.trim()) {
      setError('Bitte zuerst den Benutzernamen eintragen.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      applySession(await loginWithPasskey(username.trim()));
    } catch (caught) {
      const name = caught instanceof DOMException ? caught.name : '';
      if (name === 'NotAllowedError' || name === 'AbortError') {
        setError(null);
      } else if (caught instanceof ApiError) {
        setError(caught.message);
      } else {
        setError('Anmeldung mit diesem Gerät hat nicht geklappt.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'login') {
        await login(username, password);
      } else {
        await register({
          username,
          password,
          displayName: displayName.trim() || username,
          inviteCode: inviteCode.trim() || undefined,
        });
      }
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : 'Etwas ist schiefgelaufen. Bitte erneut versuchen.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app-shell" style={{ justifyContent: 'center' }}>
      <div className="page-body" style={{ maxWidth: 420, width: '100%', margin: '0 auto' }}>
        <div style={{ textAlign: 'center', marginBottom: 'var(--space-4)' }}>
          <div
            aria-hidden="true"
            style={{
              width: 72,
              height: 72,
              borderRadius: 22,
              margin: '0 auto var(--space-3)',
              background: 'linear-gradient(140deg, var(--accent), var(--accent-2))',
              display: 'grid',
              placeItems: 'center',
              fontSize: 36,
              boxShadow: 'var(--shadow)',
            }}
          >
            ⚡
          </div>
          <h1 style={{ margin: 0, fontSize: '1.5rem' }}>Initiative</h1>
          <p className="muted" style={{ marginTop: 6 }}>
            Chatten, planen, spielen – alles an einem Ort.
          </p>
        </div>

        <form className="card stack" onSubmit={submit}>
          <div className="field">
            <label htmlFor="username">Benutzername</label>
            <input
              id="username"
              className="input"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              required
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </div>

          {mode === 'register' && (
            <div className="field">
              <label htmlFor="displayName">Anzeigename</label>
              <input
                id="displayName"
                className="input"
                autoComplete="nickname"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="Wie sollen dich andere sehen?"
              />
            </div>
          )}

          <div className="field">
            <label htmlFor="password">Passwort</label>
            <input
              id="password"
              className="input"
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              required
              minLength={mode === 'register' ? 8 : undefined}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>

          {mode === 'register' && (
            <div className="field">
              <label htmlFor="invite">Einladungscode (falls nötig)</label>
              <input
                id="invite"
                className="input"
                value={inviteCode}
                onChange={(event) => setInviteCode(event.target.value)}
              />
            </div>
          )}

          {error && (
            <p style={{ color: 'var(--danger)', margin: 0, fontSize: '0.9rem' }} role="alert">
              {error}
            </p>
          )}

          <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
            {busy ? '…' : mode === 'login' ? 'Anmelden' : 'Konto erstellen'}
          </button>
        </form>

        {mode === 'login' && biometricsReady && (
          <button
            type="button"
            className="btn btn-block"
            disabled={busy}
            onClick={() => void signInWithDevice()}
          >
            🔐 Mit diesem Gerät anmelden
          </button>
        )}

        <button
          type="button"
          className="btn btn-ghost btn-block"
          onClick={() => {
            setMode(mode === 'login' ? 'register' : 'login');
            setError(null);
          }}
        >
          {mode === 'login' ? 'Noch kein Konto? Registrieren' : 'Schon registriert? Anmelden'}
        </button>
      </div>
    </div>
  );
}
