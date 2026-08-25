import { create } from 'zustand';
import type { AuthSession, SelfUserDto } from '@initiative/shared';
import { ApiError, api, getTokens, setTokens } from '../lib/api.js';
import { realtime, type ConnectionState } from '../lib/realtime.js';
import { clearOfflineData, readMeta, writeMeta } from '../lib/db.js';

export type SessionStatus = 'loading' | 'anonymous' | 'authenticated';

interface SessionState {
  status: SessionStatus;
  user: SelfUserDto | null;
  connection: ConnectionState;
  error: string | null;
  bootstrap: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  register: (input: {
    username: string;
    password: string;
    displayName: string;
    inviteCode?: string;
  }) => Promise<void>;
  logout: () => Promise<void>;
  applySession: (session: AuthSession) => void;
  setUser: (user: SelfUserDto) => void;
  refreshUser: () => Promise<void>;
}

/** Schluessel des lokal hinterlegten Profils. */
const USER_CACHE_KEY = 'session.user';

export const useSession = create<SessionState>((set, get) => ({
  status: 'loading',
  user: null,
  connection: 'idle',
  error: null,

  async bootstrap() {
    if (!getTokens()) {
      set({ status: 'anonymous', user: null });
      return;
    }
    // Zuerst das zuletzt bekannte Profil einsetzen. Ohne das steht die App
    // still, bis der Server antwortet – und ohne eigene Kennung wirkt keine
    // Nachricht als eigene, weil `isMine` daran haengt.
    const cached = await readMeta<SelfUserDto>(USER_CACHE_KEY);
    if (cached) set({ status: 'authenticated', user: cached });

    try {
      const user = await api.auth.me();
      set({ status: 'authenticated', user, error: null });
      void writeMeta(USER_CACHE_KEY, user);
      realtime.connect();
    } catch (error) {
      // Nur eine echte Abweisung beendet die Sitzung. Ein Netzwerkfehler oder
      // ein Serverfehler ist voruebergehend – wer dabei ausgeloggt wird, muss
      // sich nach jeder Stoerung neu anmelden.
      const rejected = error instanceof ApiError && (error.status === 401 || error.status === 403);
      if (!rejected) {
        set({
          status: 'authenticated',
          error: cached
            ? null
            : 'Der Server ist gerade nicht erreichbar. Es werden gespeicherte Daten angezeigt.',
        });
        realtime.connect();
        return;
      }
      setTokens(null);
      void writeMeta(USER_CACHE_KEY, null);
      set({ status: 'anonymous', user: null });
    }
  },

  async login(username, password) {
    set({ error: null });
    const session = await api.auth.login({ username, password });
    get().applySession(session);
  },

  async register(input) {
    set({ error: null });
    const session = await api.auth.register(input);
    get().applySession(session);
  },

  applySession(session) {
    setTokens(session);
    set({ status: 'authenticated', user: session.user, error: null });
    void writeMeta(USER_CACHE_KEY, session.user);
    realtime.reconnect();
  },

  async logout() {
    const tokens = getTokens();
    realtime.disconnect();
    if (tokens) await api.auth.logout(tokens.refreshToken).catch(() => {});
    setTokens(null);
    await clearOfflineData();
    set({ status: 'anonymous', user: null });
  },

  setUser(user) {
    set({ user });
    void writeMeta(USER_CACHE_KEY, user);
  },

  async refreshUser() {
    try {
      set({ user: await api.auth.me() });
    } catch {
      /* keep the cached user */
    }
  },
}));

realtime.onStateChange((connection) => useSession.setState({ connection }));

/** Convenience selector – the id of the signed-in user (empty when anonymous). */
export function useMyId(): string {
  return useSession((state) => state.user?.id ?? '');
}
