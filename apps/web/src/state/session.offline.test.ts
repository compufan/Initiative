import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regressionstest: App bei nicht erreichbarem Server.
 *
 * Als die API stillstand, lud die App endlos und meldete danach „Profil noch
 * nicht geladen“ – Anfragen hatten kein Zeitlimit, und das Profil lag nirgends
 * zwischengespeichert. Ohne eigene Kennung wirkt zudem keine Nachricht als
 * eigene, weil `isMine` daran hängt.
 */

const meMock = vi.fn();
const metaStore = new Map<string, unknown>();

class OfflineError extends Error {
  status = 0;
  code = 'offline';
  get isOffline() {
    return true;
  }
}

vi.mock('../lib/api.js', () => ({
  ApiError: OfflineError,
  api: { auth: { me: () => meMock() } },
  getTokens: () => ({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 60_000 }),
  setTokens: vi.fn(),
}));

vi.mock('../lib/realtime.js', () => ({
  realtime: { connect: vi.fn(), reconnect: vi.fn(), disconnect: vi.fn(), onStateChange: () => () => {} },
}));

vi.mock('../lib/db.js', () => ({
  clearOfflineData: vi.fn(),
  readMeta: async (key: string) => metaStore.get(key) ?? null,
  writeMeta: async (key: string, value: unknown) => {
    metaStore.set(key, value);
  },
}));

const profile = { id: 'u1', username: 'anna', displayName: 'Anna' };

let useSession: typeof import('./session.js').useSession;

beforeEach(async () => {
  vi.resetModules();
  meMock.mockReset();
  metaStore.clear();
  ({ useSession } = await import('./session.js'));
});

describe('Start ohne erreichbaren Server', () => {
  it('behaelt das zwischengespeicherte Profil, statt es zu verwerfen', async () => {
    metaStore.set('session.user', profile);
    meMock.mockRejectedValue(new OfflineError('Der Server antwortet nicht'));

    await useSession.getState().bootstrap();

    const state = useSession.getState();
    expect(state.status).toBe('authenticated');
    // Genau das fehlte: ohne Profil ist die eigene Kennung leer.
    expect(state.user).toEqual(profile);
  });

  it('legt das Profil nach erfolgreichem Laden ab', async () => {
    meMock.mockResolvedValue(profile);

    await useSession.getState().bootstrap();

    expect(useSession.getState().user).toEqual(profile);
    expect(metaStore.get('session.user')).toEqual(profile);
  });

  it('meldet ohne Zwischenspeicher einen verstaendlichen Hinweis', async () => {
    meMock.mockRejectedValue(new OfflineError('Der Server antwortet nicht'));

    await useSession.getState().bootstrap();

    const state = useSession.getState();
    expect(state.status).toBe('authenticated');
    expect(state.error).toMatch(/nicht erreichbar/i);
  });
});
