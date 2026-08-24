import type { ReactNode } from 'react';
import { useUi } from '../state/ui.js';

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
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast ${toast.kind === 'error' ? 'toast-error' : toast.kind === 'success' ? 'toast-success' : ''}`}
          onClick={() => dismiss(toast.id)}
        >
          {toast.message}
        </div>
      ))}
    </div>
  );
}
