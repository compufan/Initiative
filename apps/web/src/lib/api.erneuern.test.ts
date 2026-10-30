import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regressionstests: Erneuern der Token.
 *
 * 1. Zwei Tabs, die gleichzeitig erneuern, schickten denselben Refresh-Token
 *    zweimal. Der Server wertet das als Diebstahl und beendet ALLE Sitzungen
 *    des Kontos – auf jedem Gerät.
 * 2. Eine 429 der Drossel oder ein 5xx beim Neustart der API meldete ab, als
 *    wäre die Sitzung ungültig.
 */

type Tab = typeof import('./api.js');

const speicher = new Map<string, string>();
const fakeStorage = {
  getItem: (key: string) => speicher.get(key) ?? null,
  setItem: (key: string, value: string) => void speicher.set(key, value),
  removeItem: (key: string) => void speicher.delete(key),
};

/** Eine Sperre wie `navigator.locks`: wer zuerst fragt, ist zuerst dran. */
function fakeLocks() {
  let kette: Promise<unknown> = Promise.resolve();
  return {
    request: (_name: string, arbeit: () => Promise<unknown>) => {
      const lauf = kette.then(() => arbeit());
      kette = lauf.catch(() => undefined);
      return lauf;
    },
  };
}

/** Ein Server, der rotiert und jede Wiederverwendung mitschreibt. */
function fakeServer() {
  let gueltig = 'r1';
  let zaehler = 1;
  const verbrannt = new Set<string>();
  const vorgelegt: string[] = [];
  const wiederverwendet: string[] = [];
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const { refreshToken } = JSON.parse(String(init.body)) as { refreshToken: string };
    vorgelegt.push(refreshToken);
    if (verbrannt.has(refreshToken)) wiederverwendet.push(refreshToken);
    // Ein wenig Laufzeit, damit sich zwei Tabs wirklich überschneiden.
    await new Promise((fertig) => setTimeout(fertig, 5));
    if (refreshToken !== gueltig) {
      return new Response(JSON.stringify({ error: { code: 'unauthorized' } }), { status: 401 });
    }
    verbrannt.add(refreshToken);
    zaehler += 1;
    gueltig = `r${zaehler}`;
    return new Response(
      JSON.stringify({ accessToken: `a${zaehler}`, refreshToken: gueltig, expiresIn: 900 }),
      { status: 200 },
    );
  });
  return { fetchMock, vorgelegt, wiederverwendet };
}

async function neuerTab(): Promise<Tab> {
  vi.resetModules();
  return import('./api.js');
}

beforeEach(() => {
  speicher.clear();
  // Abgelaufen: Die nächste Anfrage muss erneuern.
  speicher.set(
    'initiative.tokens',
    JSON.stringify({ accessToken: 'a1', refreshToken: 'r1', expiresAt: Date.now() - 1000 }),
  );
  vi.stubGlobal('localStorage', fakeStorage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Erneuern über mehrere Tabs', () => {
  it('legt denselben Refresh-Token nie zweimal vor', async () => {
    const server = fakeServer();
    vi.stubGlobal('fetch', server.fetchMock);
    vi.stubGlobal('navigator', { locks: fakeLocks() });

    const tabA = await neuerTab();
    const tabB = await neuerTab();

    const [a, b] = await Promise.all([tabA.validAccessToken(), tabB.validAccessToken()]);

    expect(server.wiederverwendet).toEqual([]);
    expect(server.vorgelegt).toEqual(['r1']);
    // Beide arbeiten mit dem einen frischen Token weiter.
    expect(a).toBe('a2');
    expect(b).toBe('a2');
    expect(tabB.getTokens()?.refreshToken).toBe('r2');
  });
});

describe('Vorübergehende Ablehnung', () => {
  for (const status of [429, 500, 503]) {
    it(`meldet bei ${status} nicht ab`, async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('{}', { status })),
      );
      vi.stubGlobal('navigator', { locks: fakeLocks() });
      const tab = await neuerTab();

      await tab.validAccessToken();

      expect(tab.getTokens()?.refreshToken).toBe('r1');
      expect(speicher.has('initiative.tokens')).toBe(true);
    });
  }

  it('meldet bei 401 weiterhin ab', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 401 })),
    );
    vi.stubGlobal('navigator', { locks: fakeLocks() });
    const tab = await neuerTab();

    expect(await tab.validAccessToken()).toBeNull();
    expect(tab.getTokens()).toBeNull();
    expect(speicher.has('initiative.tokens')).toBe(false);
  });

  it('erneuert auch ohne Web Locks', async () => {
    const server = fakeServer();
    vi.stubGlobal('fetch', server.fetchMock);
    vi.stubGlobal('navigator', {});
    const tab = await neuerTab();

    expect(await tab.validAccessToken()).toBe('a2');
  });
});
