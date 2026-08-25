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
const setTokensMock = vi.fn();
const metaStore = new Map<string, unknown>();

/** Ersatz fuer `ApiError` – der Status entscheidet ueber Abmelden oder Halten. */
class MockApiError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    readonly code = 'offline',
  ) {
    super(message);
  }
  get isOffline() {
    return this.status === 0;
  }
}

/** Server nicht erreichbar. */
const offline = () => new MockApiError('Der Server antwortet nicht');

vi.mock('../lib/api.js', () => ({
  ApiError: MockApiError,
  api: { auth: { me: () => meMock() } },
  getTokens: () => ({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 60_000 }),
  setTokens: (value: unknown) => setTokensMock(value),
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
  setTokensMock.mockReset();
  metaStore.clear();
  ({ useSession } = await import('./session.js'));
});

describe('Start ohne erreichbaren Server', () => {
  it('behaelt das zwischengespeicherte Profil, statt es zu verwerfen', async () => {
    metaStore.set('session.user', profile);
    meMock.mockRejectedValue(offline());

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
    meMock.mockRejectedValue(offline());

    await useSession.getState().bootstrap();

    const state = useSession.getState();
    expect(state.status).toBe('authenticated');
    expect(state.error).toMatch(/nicht erreichbar/i);
  });

  it('meldet sich bei abgelehntem Token wirklich ab', async () => {
    // Der Gegentest: 401 ist keine Stoerung, sondern eine Abweisung. Wer hier
    // angemeldet bliebe, saehe eine App, die auf nichts mehr Antwort bekommt.
    metaStore.set('session.user', profile);
    meMock.mockRejectedValue(new MockApiError('Nicht angemeldet', 401, 'unauthorized'));

    await useSession.getState().bootstrap();

    const state = useSession.getState();
    expect(state.status).toBe('anonymous');
    expect(state.user).toBeNull();
    expect(setTokensMock).toHaveBeenCalledWith(null);
    expect(metaStore.get('session.user')).toBeNull();
  });

  it('haelt die Sitzung bei einem Serverfehler', async () => {
    // 500 heisst: der Server hat ein Problem, nicht der Anwender.
    metaStore.set('session.user', profile);
    meMock.mockRejectedValue(new MockApiError('Serverfehler', 500, 'internal'));

    await useSession.getState().bootstrap();

    expect(useSession.getState().status).toBe('authenticated');
    expect(useSession.getState().user).toEqual(profile);
    expect(setTokensMock).not.toHaveBeenCalledWith(null);
  });
});
