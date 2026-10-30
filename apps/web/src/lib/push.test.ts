import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Ein Push-Abo, dessen Adresse schon einem anderen Konto gehört.
 *
 * Der Server hängte so ein Abo früher still um – jeder, der die Adresse
 * kannte, konnte damit die Mitteilungen eines anderen umleiten. Jetzt
 * antwortet er mit 409, und der Client legt ein frisches Abo mit neuer
 * Adresse an, statt zu glauben, er sei angemeldet.
 */

const subscribe = vi.fn();

vi.mock('./api.js', () => {
  class ApiError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return { ApiError, api: { push: { subscribe: (body: unknown) => subscribe(body) } } };
});

const { aboMelden } = await import('./push.js');
const { ApiError } = await import('./api.js');

function abo(endpoint: string) {
  return {
    endpoint,
    toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: vi.fn(async () => true),
  };
}

function browser(vorhanden: ReturnType<typeof abo> | null) {
  let aktuell = vorhanden;
  let zaehler = 0;
  return {
    getSubscription: vi.fn(async () => aktuell),
    subscribe: vi.fn(async () => {
      zaehler += 1;
      aktuell = abo(`https://push.example/neu-${zaehler}`);
      return aktuell;
    }),
    abmelden: () => {
      aktuell = null;
    },
  };
}

beforeEach(() => {
  subscribe.mockReset();
  vi.stubGlobal('window', {
    atob: (text: string) => Buffer.from(text, 'base64').toString('binary'),
  });
});

describe('aboMelden', () => {
  it('legt bei 409 ein neues Abo an und meldet das an', async () => {
    const alt = abo('https://push.example/vergeben');
    const pm = browser(alt);
    alt.unsubscribe.mockImplementation(async () => {
      pm.abmelden();
      return true;
    });
    subscribe
      .mockRejectedValueOnce(new ApiError(409, 'conflict', 'vergeben'))
      .mockResolvedValueOnce({ ok: true });

    await expect(aboMelden(pm as unknown as PushManager, 'AAAA')).resolves.toBe(true);

    expect(alt.unsubscribe).toHaveBeenCalledOnce();
    expect(pm.subscribe).toHaveBeenCalledOnce();
    expect(subscribe.mock.calls.map(([body]) => (body as { endpoint: string }).endpoint)).toEqual([
      'https://push.example/vergeben',
      'https://push.example/neu-1',
    ]);
  });

  it('versucht es nur einmal neu', async () => {
    const pm = browser(null);
    subscribe.mockRejectedValue(new ApiError(409, 'conflict', 'vergeben'));
    await expect(aboMelden(pm as unknown as PushManager, 'AAAA')).rejects.toBeInstanceOf(ApiError);
    expect(subscribe).toHaveBeenCalledTimes(2);
  });

  it('lässt andere Fehler durch, ohne das Abo anzufassen', async () => {
    const alt = abo('https://push.example/meins');
    const pm = browser(alt);
    subscribe.mockRejectedValue(new ApiError(500, 'internal', 'kaputt'));
    await expect(aboMelden(pm as unknown as PushManager, 'AAAA')).rejects.toBeInstanceOf(ApiError);
    expect(alt.unsubscribe).not.toHaveBeenCalled();
  });
});
