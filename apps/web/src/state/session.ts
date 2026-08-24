import { create } from 'zustand';
import type { AuthSession, SelfUserDto } from '@initiative/shared';
import { ApiError, api, getTokens, setTokens } from '../lib/api.js';
import { realtime, type ConnectionState } from '../lib/realtime.js';
import { clearOfflineData } from '../lib/db.js';

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
    try {
      const user = await api.auth.me();
      set({ status: 'authenticated', user, error: null });
      realtime.connect();
    } catch (error) {
      if (error instanceof ApiError && error.isOffline) {
        // Keep the cached session so the app still opens without a network.
        set({ status: 'authenticated', error: null });
        return;
      }
      setTokens(null);
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
