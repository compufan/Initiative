import { useEffect, useState } from 'react';
import { clearOfflineData } from '../../lib/db.js';
import { toast } from '../../state/ui.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { api } from '../../lib/api.js';
import { APP_COMMIT, APP_NAME, APP_VERSION, REPO_URL, errorMessage } from './helpers.js';

/** Version, source code and the emergency button for the offline cache. */
export function AboutCard() {
  const [confirmClear, setConfirmClear] = useState(false);
  const [busy, setBusy] = useState(false);
  const [apiCommit, setApiCommit] = useState<string | null>(null);

  // Zeigt, welcher Stand wirklich laeuft – Frontend und API getrennt, weil sie
  // von verschiedenen Diensten gebaut werden und kurz auseinanderlaufen koennen.
  useEffect(() => {
    let cancelled = false;
    void api.health()
      .then((value) => {
        if (!cancelled) setApiCommit(value.version ?? 'unbekannt');
      })
      .catch(() => {
        if (!cancelled) setApiCommit('nicht erreichbar');
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

      <div className="stack" style={{ gap: 2 }}>
        <span className="prf-hint">
          App-Stand: <code>{APP_COMMIT}</code>
        </span>
        <span className="prf-hint">
          API-Stand: <code>{apiCommit ?? '…'}</code>
        </span>
        <span className="prf-hint">
          Das sind die kurzen Commit-Kennungen. Nach einem Push müssen sie zu dem passen, was
          hier im Chat steht.
        </span>
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
