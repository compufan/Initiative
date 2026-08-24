import { useUi } from '../state/ui.js';

/** Shown when a new service worker is waiting; the user decides when to reload. */
export function UpdateBanner() {
  const apply = useUi((state) => state.swUpdateReady);
  if (!apply) return null;
  return (
    <div
      className="row row-between"
      style={{
        padding: 'calc(var(--safe-top) + 8px) 16px 8px',
        background: 'var(--accent-soft)',
        color: 'var(--accent)',
        fontSize: '0.88rem',
        fontWeight: 600,
      }}
    >
      <span>Neue Version verfügbar</span>
      <button type="button" className="btn btn-sm btn-primary" onClick={apply}>
        Aktualisieren
      </button>
    </div>
  );
}
