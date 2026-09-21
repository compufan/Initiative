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
        <>
          <div className="prf-note is-ok">
            <strong>✅ Initiative ist installiert</strong>
            <p className="prf-hint">
              Du hast die App vom Startbildschirm geöffnet – Vollbild, eigenes Symbol und
              Benachrichtigungen sind damit möglich.
            </p>
          </div>
          {/*
              Was das Betriebssystem selbst entscheidet, steht hier als Satz
              und nicht als Versprechen.

              Das Symbol trägt seit dem Umbau eine Inhaltskennung im Namen
              (`scripts/marke.mjs`), damit ein neues Logo überhaupt eine
              Änderung im Manifest ergibt – vorher blieben die Adressen
              gleich, und Chrome sah keinen Grund, die WebAPK zu erneuern.
              Erzwingen lässt sich der Austausch trotzdem nicht: Android holt
              die neue Kachel erst, wenn alle Fenster der App zu sind, das
              Gerät am Strom hängt und im WLAN ist, und iOS erneuert das
              Symbol einer abgelegten Web-App überhaupt nie.

              Ein Anwender, der das weiss, wartet drei Tage. Einer, der es
              nicht weiss, meldet zum dritten Mal denselben Fehler – und
              genau das ist passiert.
          */}
          <p className="prf-hint">
            Das Symbol auf dem Startbildschirm erneuert nicht die App, sondern das Gerät. Auf
            Android kann das bis zu einem Tag dauern und passiert erst, wenn die App geschlossen
            ist, das Gerät lädt und im WLAN hängt; wer nicht warten will, öffnet in Chrome{' '}
            <code>about:webapks</code> und tippt dort auf „Update“. Auf dem iPhone wird das Symbol
            einer abgelegten Web-App nie erneuert – dort hilft nur: vom Home-Bildschirm entfernen
            und neu ablegen.
          </p>
        </>
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
