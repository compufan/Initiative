import { describe, expect, it, vi } from 'vitest';

/**
 * Regressionstest: Nach dem Abmelden stand die Chatliste des alten Kontos
 * weiter im Arbeitsspeicher – sichtbar für den Nächsten, der sich im selben
 * Tab anmeldet.
 */

vi.mock('../lib/api.js', () => ({
  ApiError: class ApiError extends Error {},
  api: {},
}));
vi.mock('../lib/realtime.js', () => ({
  realtime: { on: () => () => {}, send: () => true, onStateChange: () => () => {} },
}));
vi.mock('../lib/db.js', () => ({}));
vi.mock('../lib/upload.js', () => ({ uploadBlob: vi.fn() }));

describe('sitzungsZustandLeeren', () => {
  it('lässt nichts vom alten Konto zurück, die Aktionen aber stehen', async () => {
    const { sitzungsZustandLeeren } = await import('./abmelden.js');
    const { useChat } = await import('./chat.js');
    const { useFiles } = await import('../modules/files/state.js');

    useChat.setState({
      conversations: [{ id: 'c-alt' } as never],
      messages: { 'c-alt': [{ id: 'm1' } as never] },
      loaded: { 'c-alt': true },
      initialised: true,
    });
    useFiles.setState({ collections: [{ id: 's-alt' } as never] });

    sitzungsZustandLeeren();

    expect(useChat.getState().conversations).toEqual([]);
    expect(useChat.getState().messages).toEqual({});
    expect(useChat.getState().loaded).toEqual({});
    expect(useChat.getState().initialised).toBe(false);
    expect(useFiles.getState().collections).toEqual([]);
    expect(typeof useChat.getState().hydrate).toBe('function');
  });
});
