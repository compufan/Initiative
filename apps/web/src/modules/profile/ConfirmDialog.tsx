import { Sheet } from '../../components/Sheet.js';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/** Centered yes/no dialog for the steps that cannot be undone. */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Abbrechen',
  danger,
  busy,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <Sheet open={open} onClose={onCancel} variant="modal" title={title}>
      <div className="stack">
        {description && <p className="prf-hint">{description}</p>}
        <div className="prf-dialog-actions">
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
            disabled={busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </Sheet>
  );
}
