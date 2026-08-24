import { useState } from 'react';
import { clearOfflineData } from '../../lib/db.js';
import { toast } from '../../state/ui.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { APP_NAME, APP_VERSION, REPO_URL, errorMessage } from './helpers.js';

/** Version, source code and the emergency button for the offline cache. */
export function AboutCard() {
  const [confirmClear, setConfirmClear] = useState(false);
  const [busy, setBusy] = useState(false);

  async function clearCache() {
    setBusy(true);
    try {
      await clearOfflineData();
      setConfirmClear(false);
      toast('Offline-Daten gelöscht', 'success');
    } catch (error) {
      toast(errorMessage(error, 'Offline-Daten konnten nicht gelöscht werden'), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card stack" aria-labelledby="prf-about-title">
      <h2 className="prf-block-title" id="prf-about-title">
        Über
      </h2>
      <div className="row row-between">
        <span>
          <strong>{APP_NAME}</strong>
          <span className="prf-hint"> · Messenger, Kalender, Umfragen und Mini-Spiele</span>
        </span>
        <span className="badge">Version {APP_VERSION}</span>
      </div>

      <a className="btn btn-block" href={REPO_URL} target="_blank" rel="noreferrer noopener">
        ⌨️ Quellcode auf GitHub
      </a>

      <button
        type="button"
        className="btn btn-ghost btn-block"
        disabled={busy}
        onClick={() => setConfirmClear(true)}
      >
        🧹 Offline-Daten löschen
      </button>
      <p className="prf-hint">
        Löscht die zwischengespeicherten Chats auf diesem Gerät. Angemeldet bleibst du; alles Nötige
        wird beim nächsten Öffnen wieder geladen.
      </p>

      <ConfirmDialog
        open={confirmClear}
        title="Offline-Daten löschen?"
        description="Noch nicht gesendete Nachrichten in der Warteschlange gehen dabei verloren."
        confirmLabel="Löschen"
        danger
        busy={busy}
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => void clearCache()}
      />
    </section>
  );
}
