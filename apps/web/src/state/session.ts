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

    // Das Push-Abo ZUERST loesen, solange der Token noch gilt. Danach kaeme
    // der Server nicht mehr an die Anfrage – und das Geraet bekaeme weiter
    // Benachrichtigungen fuer ein Konto, von dem es sich abgemeldet hat.
    await pushAbmelden().catch(() => {});

    if (tokens) await api.auth.logout(tokens.refreshToken).catch(() => {});
    setTokens(null);
    await clearOfflineData();
    await medienSpeicherLeeren();
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

/** Der eigene Anzeigename – etwa fuer einen Verwendungszweck. */
export function useMyName(): string {
  return useSession((state) => state.user?.displayName ?? '');
}

/**
 * Das Push-Abo dieses Geräts lösen.
 *
 * Ohne das läuft es weiter: Der Browser behält die Anmeldung beim Push-Dienst,
 * der Server behält die Adresse – und das Gerät bekäme Benachrichtigungen für
 * ein Konto, von dem es sich gerade abgemeldet hat.
 */
async function pushAbmelden(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration();
  const abo = await registration?.pushManager.getSubscription();
  if (!abo) return;
  // Erst beim Server abmelden (dafür braucht es den noch gültigen Token),
  // dann beim Browser.
  await api.push.unsubscribe(abo.endpoint).catch(() => {});
  await abo.unsubscribe().catch(() => {});
}

/**
 * Den Medien-Zwischenspeicher des Service Workers leeren.
 *
 * `clearOfflineData` räumt die eigene Datenbank – die Bilder und Videos liegen
 * aber woanders: in einem Cache, den der Service Worker führt. Der überlebte
 * das Abmelden bisher. Wer sein Gerät weitergibt oder sich auf einem fremden
 * abmeldet, ließ Fotos zurück, die auf dem Server längst nicht mehr für ihn
 * bestimmt sind.
 */
async function medienSpeicherLeeren(): Promise<void> {
  if (!('caches' in window)) return;
  const namen = await caches.keys();
  await Promise.all(
    namen.filter((name) => name.includes('media')).map((name) => caches.delete(name)),
  );
}
