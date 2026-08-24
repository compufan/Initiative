interface ToggleProps {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  busy?: boolean;
  onChange: (next: boolean) => void;
}

/** Row with a label, a short explanation and an accessible on/off switch. */
export function Toggle({ label, description, checked, disabled, busy, onChange }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className="prf-toggle"
      disabled={disabled || busy}
      onClick={() => onChange(!checked)}
    >
      <span className="prf-toggle-text">
        <span className="prf-toggle-label">{label}</span>
        {description && <span className="prf-toggle-desc">{description}</span>}
      </span>
      {busy ? (
        <span className="spinner" aria-hidden="true" />
      ) : (
        <span className={`prf-switch${checked ? ' is-on' : ''}`} aria-hidden="true">
          <span className="prf-switch-knob" />
        </span>
      )}
    </button>
  );
}
