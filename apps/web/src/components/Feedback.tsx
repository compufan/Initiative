import type { ReactNode } from 'react';
import { toastFesthalten, toastLoslassen, useUi } from '../state/ui.js';

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="row" style={{ gap: 10, color: 'var(--text-muted)' }}>
      <span className="spinner" role="status" aria-label={label ?? 'Lädt'} />
      {label && <span>{label}</span>}
    </div>
  );
}

export function EmptyState({
  emoji,
  title,
  description,
  action,
}: {
  emoji: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="emoji" aria-hidden="true">
        {emoji}
      </span>
      <strong style={{ color: 'var(--text)' }}>{title}</strong>
      {description && <p style={{ margin: 0, maxWidth: 380 }}>{description}</p>}
      {action}
    </div>
  );
}

export function ToastHost() {
  const toasts = useUi((state) => state.toasts);
  const dismiss = useUi((state) => state.dismissToast);
  if (toasts.length === 0) return null;
  return (
    <div className="toast-host" role="status" aria-live="polite">
      {/*
          Die Meldung ist wegtippbar – und sagt das jetzt auch.

          Sie trug einen Klick-Behandler, aber weder `role` noch `tabIndex`
          noch `cursor: pointer`: Dass ein Tipp sie sofort wegnimmt, erfuhr
          niemand, und mit der Tastatur war sie überhaupt nicht zu erreichen.
          Ein `button` erledigt beides von selbst.
      */}
      {toasts.map((toast) => (
        <button
          key={toast.id}
          type="button"
          className={`toast ${toast.kind === 'error' ? 'toast-error' : toast.kind === 'success' ? 'toast-success' : ''}`}
          data-tipp="Blendet die Meldung sofort aus – sonst verschwindet sie von selbst"
          aria-label={`${toast.message} – wegtippen`}
          // Solange jemand mit der Tastatur auf der Meldung steht, läuft sie
          // nicht ab: Ein fokussiertes Element, das verschwindet, wirft den
          // Fokus auf den Rumpf zurück.
          onFocus={() => toastFesthalten(toast.id)}
          onBlur={() => toastLoslassen(toast.id)}
          onClick={() => dismiss(toast.id)}
        >
          {toast.message}
        </button>
      ))}
    </div>
  );
}
