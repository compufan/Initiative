import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

interface ScreenProps {
  title: ReactNode;
  subtitle?: ReactNode;
  back?: boolean | string;
  actions?: ReactNode;
  children: ReactNode;
  /** Disable the default padded body (chat view brings its own layout). */
  bare?: boolean;
}

/** Standard page frame: sticky header + scrollable body. */
export function Screen({ title, subtitle, back, actions, children, bare }: ScreenProps) {
  const navigate = useNavigate();
  return (
    <div className="app-main">
      <header className="app-header">
        {back && (
          <button
            type="button"
            className="icon-btn"
            aria-label="Zurück"
            onClick={() => (typeof back === 'string' ? navigate(back) : navigate(-1))}
          >
            ‹
          </button>
        )}
        <div style={{ minWidth: 0, flex: 1 }}>
          <h1 className="truncate">{title}</h1>
          {subtitle && <div className="subtitle truncate">{subtitle}</div>}
        </div>
        {actions}
      </header>
      {bare ? children : <div className="page"><div className="page-body">{children}</div></div>}
    </div>
  );
}
