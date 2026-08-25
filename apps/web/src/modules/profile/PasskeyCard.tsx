import { useEffect, useState } from 'react';
import { api, type PasskeyDto } from '../../lib/api.js';
import { passkeysUsable, registerPasskey } from '../../lib/passkeys.js';
import { toast } from '../../state/ui.js';
import { errorMessage } from './helpers.js';

/**
 * Face ID, Fingerabdruck oder Geräte-PIN statt Passwort.
 *
 * Der Schlüssel entsteht im Gerät und verlässt es nie – hinterlegt wird nur
 * der öffentliche Teil. Deshalb hängt das an genau diesem Gerät: Für Handy und
 * Rechner richtet man es je einmal ein.
 */
export function PasskeyCard() {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [keys, setKeys] = useState<PasskeyDto[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void passkeysUsable().then((value) => {
      if (!cancelled) setAvailable(value);
    });
    void api.passkeys
      .list()
      .then((value) => {
        if (!cancelled) setKeys(value);
      })
      .catch(() => {
        // Ältere Server kennen den Endpunkt nicht.
        if (!cancelled) setKeys([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function add() {
    setBusy(true);
    try {
      const created = await registerPasskey();
      setKeys((current) => [created, ...(current ?? [])]);
      toast('Gerät eingerichtet', 'success');
    } catch (error) {
      // Abbruch durch den Nutzer ist kein Fehler, den man anschreien muss.
      const name = error instanceof DOMException ? error.name : '';
      if (name === 'NotAllowedError' || name === 'AbortError') {
        toast('Abgebrochen', 'error');
      } else {
        toast(errorMessage(error, 'Einrichten fehlgeschlagen'), 'error');
      }
    } finally {
      setBusy(false);
    }
  }

  async function drop(key: PasskeyDto) {
    setBusy(true);
    try {
      await api.passkeys.remove(key.id);
      setKeys((current) => current?.filter((item) => item.id !== key.id) ?? null);
      toast('Gerät entfernt', 'success');
    } catch (error) {
      toast(errorMessage(error, 'Entfernen fehlgeschlagen'), 'error');
    } finally {
      setBusy(false);
    }
  }

  if (available === false && (keys?.length ?? 0) === 0) return null;

  return (
    <section className="card stack" aria-labelledby="prf-passkey-title">
      <h2 className="prf-block-title" id="prf-passkey-title">
        Ohne Passwort anmelden
      </h2>
      <p className="prf-hint">
        Richte dieses Gerät einmal ein, dann genügt beim Anmelden Face ID, dein Fingerabdruck oder
        die Geräte-PIN. Der Schlüssel bleibt im Gerät.
      </p>

      {keys && keys.length > 0 && (
        <ul className="stack" style={{ margin: 0, padding: 0, listStyle: 'none' }}>
          {keys.map((key) => (
            <li key={key.id} className="row" style={{ gap: 10, alignItems: 'center' }}>
              <span className="stack" style={{ gap: 0, flex: 1 }}>
                <strong>{key.label}</strong>
                <span className="prf-hint">
                  {key.lastUsedAt
                    ? `zuletzt benutzt am ${new Date(key.lastUsedAt).toLocaleDateString('de-DE')}`
                    : 'noch nicht benutzt'}
                </span>
              </span>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busy}
                onClick={() => void drop(key)}
              >
                Entfernen
              </button>
            </li>
          ))}
        </ul>
      )}

      {available ? (
        <button type="button" className="btn" disabled={busy} onClick={() => void add()}>
          {keys && keys.length > 0 ? 'Weiteres Gerät einrichten' : 'Dieses Gerät einrichten'}
        </button>
      ) : (
        <p className="prf-hint">
          Dieses Gerät bietet keinen eingebauten Sensor an. Auf dem iPhone geht es nur in der zum
          Home-Bildschirm hinzugefügten App, in Safari.
        </p>
      )}
    </section>
  );
}
