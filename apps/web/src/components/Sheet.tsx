import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  /** Centered dialog instead of a bottom sheet (better on wide screens). */
  variant?: 'sheet' | 'modal';
}

/** Bottom sheet / modal with backdrop, escape handling and scroll locking. */
export function Sheet({ open, onClose, title, children, actions, variant = 'sheet' }: SheetProps) {
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  const content =
    variant === 'modal' ? (
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-card">
          {(title || actions) && (
            <div className="row row-between" style={{ marginBottom: 'var(--space-3)' }}>
              <strong>{title}</strong>
              {actions}
            </div>
          )}
          {children}
        </div>
      </div>
    ) : (
      <div className="sheet" role="dialog" aria-modal="true">
        <div className="sheet-handle" />
        {(title || actions) && (
          <div className="sheet-header">
            <span>{title}</span>
            {actions ?? (
              <button type="button" className="icon-btn" onClick={onClose} aria-label="Schließen">
                ✕
              </button>
            )}
          </div>
        )}
        <div className="sheet-body">{children}</div>
      </div>
    );

  return createPortal(
    <>
      <div className="backdrop" onClick={onClose} />
      {content}
    </>,
    document.body,
  );
}
