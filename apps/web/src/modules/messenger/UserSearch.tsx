import { useEffect, useRef, useState } from 'react';
import type { UserDto } from '@initiative/shared';
import { Avatar } from '../../components/Avatar.js';
import { EmptyState, Spinner } from '../../components/Feedback.js';
import { api } from '../../lib/api.js';
import { toast } from '../../state/ui.js';

interface UserSearchProps {
  /** Users that must not show up (already a member, yourself …). */
  excludeIds?: string[];
  selectedIds?: string[];
  placeholder?: string;
  autoFocus?: boolean;
  onPick: (user: UserDto) => void;
}

/** Debounced people search used by the new-chat and add-member flows. */
export function UserSearch({
  excludeIds = [],
  selectedIds = [],
  placeholder = 'Nach Namen suchen',
  autoFocus,
  onPick,
}: UserSearchProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<UserDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [touched, setTouched] = useState(false);
  const requestId = useRef(0);

  useEffect(() => {
    const term = query.trim();
    if (term.length === 0) {
      setResults([]);
      setLoading(false);
      setTouched(false);
      return undefined;
    }
    setLoading(true);
    const current = ++requestId.current;
    const timer = window.setTimeout(async () => {
      try {
        const { items } = await api.users.search(term);
        if (current !== requestId.current) return;
        setResults(items);
      } catch {
        if (current !== requestId.current) return;
        setResults([]);
        toast('Suche fehlgeschlagen', 'error');
      } finally {
        if (current === requestId.current) {
          setLoading(false);
          setTouched(true);
        }
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  const visible = results.filter((user) => !excludeIds.includes(user.id));

  return (
    <div className="stack">
      <input
        className="input"
        type="search"
        inputMode="search"
        autoCapitalize="none"
        autoCorrect="off"
        autoFocus={autoFocus}
        placeholder={placeholder}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />

      {loading && <Spinner label="Suche läuft" />}

      {!loading && query.trim().length === 0 && (
        <p className="muted" style={{ margin: 0, fontSize: '0.88rem' }}>
          Tippe einen Namen oder Benutzernamen ein.
        </p>
      )}

      {!loading && touched && query.trim().length > 0 && visible.length === 0 && (
        <EmptyState emoji="🔍" title="Niemanden gefunden" description="Versuch es mit einem anderen Namen." />
      )}

      {visible.length > 0 && (
        <div className="list msg-picker-list">
          {visible.map((user) => {
            const selected = selectedIds.includes(user.id);
            return (
              <button
                key={user.id}
                type="button"
                className="list-row"
                aria-pressed={selected}
                onClick={() => onPick(user)}
              >
                <Avatar name={user.displayName} id={user.id} url={user.avatarUrl} size={40} />
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span className="truncate" style={{ display: 'block', fontWeight: 600 }}>
                    {user.displayName}
                  </span>
                  <span className="muted truncate" style={{ display: 'block', fontSize: '0.82rem' }}>
                    @{user.username}
                  </span>
                </span>
                {selected && <span aria-hidden="true">✓</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
