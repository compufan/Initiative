import { useState } from 'react';
import { isIos, isStandalone } from '../../lib/push.js';
import { toast, useUi } from '../../state/ui.js';
import { errorMessage } from './helpers.js';

/**
 * Home-screen installation.
 *
 * Chrome and Edge hand us a `beforeinstallprompt` event we can trigger from a
 * button; Safari has no such API, so the iPhone gets the manual three steps.
 */
export function InstallCard() {
  const installPrompt = useUi((state) => state.installPrompt);
  const setInstallPrompt = useUi((state) => state.setInstallPrompt);
  const [standalone] = useState(() => isStandalone());
  const [busy, setBusy] = useState(false);
  const ios = isIos();

  async function install() {
    if (!installPrompt) return;
    setBusy(true);
    try {
      await installPrompt.prompt();
      const { outcome } = await installPrompt.userChoice;
      setInstallPrompt(null);
      if (outcome === 'accepted') toast('Initiative wird hinzugefügt', 'success');
      else toast('Du kannst die App später jederzeit hinzufügen', 'info');
    } catch (error) {
      toast(errorMessage(error, 'Installation fehlgeschlagen'), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card stack" aria-labelledby="prf-install-title">
      <h2 className="prf-block-title" id="prf-install-title">
        App installieren
      </h2>

      {standalone ? (
        <div className="prf-note is-ok">
          <strong>✅ Initiative ist installiert</strong>
          <p className="prf-hint">
            Du hast die App vom Startbildschirm geöffnet – Vollbild, eigenes Symbol und
            Benachrichtigungen sind damit möglich.
          </p>
        </div>
      ) : (
        <>
          <p className="prf-hint">
            Als installierte App startet Initiative im Vollbild, ohne Adressleiste – und nur so kann
            das iPhone Benachrichtigungen schicken.
          </p>
          {installPrompt ? (
            <button
              type="button"
              className="btn btn-primary btn-block"
              disabled={busy}
              onClick={() => void install()}
            >
              ＋ Zum Startbildschirm hinzufügen
            </button>
          ) : ios ? (
            <ol className="prf-steps">
              <li>
                Initiative in Safari öffnen (in anderen Browsern geht es auf dem iPhone nicht).
              </li>
              <li>
                Unten in der Leiste auf das Teilen-Symbol tippen – das Quadrat mit dem Pfeil nach
                oben.
              </li>
              <li>In der Liste „Zum Home-Bildschirm“ auswählen.</li>
              <li>Oben rechts „Hinzufügen“ bestätigen und die App über das neue Symbol öffnen.</li>
            </ol>
          ) : (
            <p className="prf-hint">
              Dein Browser bietet die Installation gerade nicht an. Im Menü des Browsers (die drei
              Punkte) findest du meist „App installieren“ oder „Zum Startbildschirm hinzufügen“.
            </p>
          )}
        </>
      )}
    </section>
  );
}
