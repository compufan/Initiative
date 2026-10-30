import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regressionstests: Erneuern der Sitzung.
 *
 * 1. Zwei Tabs, die gleichzeitig erneuern, sollen nur EINE Erneuerung
 *    auslösen – die anderen übernehmen das Ergebnis aus dem Speicher.
 * 2. Eine 429 der Drossel oder ein 5xx beim Neustart der API meldete ab, als
 *    wäre die Sitzung ungültig.
 * 3. Der Erneuerungs-Token steht nicht mehr in `localStorage`: Erneuert wird
 *    über den `HttpOnly`-Keks (`credentials: 'include'` + Sitzungskopf). Ein
 *    alter Eintrag wird ein letztes Mal im Rumpf vorgelegt und danach ohne
 *    Token neu geschrieben.
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

interface Vorlage {
  url: string;
  methode: string;
  rumpfToken: string | undefined;
  keks: string | undefined;
  credentials: RequestCredentials | undefined;
  kopf: string | undefined;
}

/**
 * Ein Server mit Keksdose: Er setzt den Erneuerungs-Keks und liest ihn nur,
 * wenn der Client `credentials: 'include'` und den Sitzungskopf schickt.
 */
function fakeServer() {
  let dose: string | undefined;
  let zaehler = 1;
  const vorlagen: Vorlage[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    const kopf = (init.headers ?? {}) as Record<string, string>;
    const rumpf = init.body ? (JSON.parse(String(init.body)) as { refreshToken?: string }) : {};
    vorlagen.push({
      url,
      methode: init.method ?? 'GET',
      rumpfToken: rumpf.refreshToken,
      keks: init.credentials === 'include' ? dose : undefined,
      credentials: init.credentials,
      kopf: kopf['x-initiative-sitzung'],
    });
    // Ein wenig Laufzeit, damit sich zwei Tabs wirklich überschneiden.
    await new Promise((fertig) => setTimeout(fertig, 5));
    if (init.method === 'DELETE') {
      dose = undefined;
      return new Response(null, { status: 204 });
    }
    const vorgelegt = rumpf.refreshToken ?? (init.credentials === 'include' ? dose : undefined);
    if (!vorgelegt) {
      return new Response(JSON.stringify({ error: { code: 'unauthorized' } }), { status: 401 });
    }
    zaehler += 1;
    dose = `r${zaehler}`;
    return new Response(JSON.stringify({ accessToken: `a${zaehler}`, expiresIn: 900 }), {
      status: 200,
    });
  });
  return {
    fetchMock,
    vorlagen,
    keksSetzen: (wert: string) => {
      dose = wert;
    },
  };
}

async function neuerTab(): Promise<Tab> {
  vi.resetModules();
  return import('./api.js');
}

beforeEach(() => {
  speicher.clear();
  // Abgelaufen: Die nächste Anfrage muss erneuern. Neues Format – ohne Token.
  speicher.set(
    'initiative.tokens',
    JSON.stringify({ accessToken: 'a1', expiresAt: Date.now() - 1000 }),
  );
  vi.stubGlobal('localStorage', fakeStorage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Erneuern über den Keks', () => {
  it('schickt Keks und Sitzungskopf, keinen Token im Rumpf', async () => {
    const server = fakeServer();
    server.keksSetzen('r1');
    vi.stubGlobal('fetch', server.fetchMock);
    vi.stubGlobal('navigator', { locks: fakeLocks() });
    const tab = await neuerTab();

    expect(await tab.validAccessToken()).toBe('a2');
    expect(server.vorlagen).toHaveLength(1);
    expect(server.vorlagen[0]).toMatchObject({
      credentials: 'include',
      kopf: 'keks',
      rumpfToken: undefined,
      keks: 'r1',
    });
    expect(speicher.get('initiative.tokens')).not.toContain('refreshToken');
  });

  it('zieht einen alten Eintrag einmal um und löscht den Token daraus', async () => {
    speicher.set(
      'initiative.tokens',
      JSON.stringify({ accessToken: 'a1', refreshToken: 'r1', expiresAt: Date.now() + 600_000 }),
    );
    const server = fakeServer();
    vi.stubGlobal('fetch', server.fetchMock);
    vi.stubGlobal('navigator', { locks: fakeLocks() });
    const tab = await neuerTab();

    // Obwohl das Zugriffstoken noch gilt: Der alte Token soll sofort weg.
    expect(await tab.validAccessToken()).toBe('a2');
    expect(server.vorlagen[0]?.rumpfToken).toBe('r1');
    expect(speicher.get('initiative.tokens')).not.toContain('refreshToken');

    // Danach nur noch über den Keks.
    speicher.set(
      'initiative.tokens',
      JSON.stringify({ accessToken: 'a2', expiresAt: Date.now() - 1 }),
    );
    expect(await tab.forceRefresh()).toMatchObject({ accessToken: 'a3' });
    expect(server.vorlagen[1]).toMatchObject({ rumpfToken: undefined, keks: 'r2' });
  });
});

describe('Erneuern über mehrere Tabs', () => {
  it('erneuert nur einmal; der zweite Tab übernimmt', async () => {
    const server = fakeServer();
    server.keksSetzen('r1');
    vi.stubGlobal('fetch', server.fetchMock);
    vi.stubGlobal('navigator', { locks: fakeLocks() });

    const tabA = await neuerTab();
    const tabB = await neuerTab();

    const [a, b] = await Promise.all([tabA.validAccessToken(), tabB.validAccessToken()]);

    expect(server.vorlagen).toHaveLength(1);
    // Beide arbeiten mit dem einen frischen Token weiter.
    expect(a).toBe('a2');
    expect(b).toBe('a2');
    expect(tabB.getTokens()?.accessToken).toBe('a2');
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

      expect(tab.getTokens()?.accessToken).toBe('a1');
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
    server.keksSetzen('r1');
    vi.stubGlobal('fetch', server.fetchMock);
    vi.stubGlobal('navigator', {});
    const tab = await neuerTab();

    expect(await tab.validAccessToken()).toBe('a2');
  });
});

describe('Abmelden', () => {
  it('widerruft den Keks über DELETE /auth/refresh und vergisst die Sitzung', async () => {
    const server = fakeServer();
    server.keksSetzen('r1');
    vi.stubGlobal('fetch', server.fetchMock);
    vi.stubGlobal('navigator', { locks: fakeLocks() });
    const tab = await neuerTab();

    await tab.abmelden();

    expect(server.vorlagen).toHaveLength(1);
    expect(server.vorlagen[0]).toMatchObject({
      methode: 'DELETE',
      credentials: 'include',
      kopf: 'keks',
    });
    expect(server.vorlagen[0]?.url).toMatch(/\/auth\/refresh$/);
    expect(tab.getTokens()).toBeNull();
    expect(speicher.has('initiative.tokens')).toBe(false);
  });
});

describe('Echtzeit-Ticket', () => {
  it('liefert ein Ticket statt des Zugriffstokens', async () => {
    speicher.set(
      'initiative.tokens',
      JSON.stringify({ accessToken: 'a1', expiresAt: Date.now() + 600_000 }),
    );
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith('/realtime/ticket')
        ? new Response(JSON.stringify({ ticket: 'einmal', expiresIn: 30 }), { status: 200 })
        : new Response('{}', { status: 500 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('navigator', { locks: fakeLocks() });
    const tab = await neuerTab();

    expect(await tab.echtzeitZugang()).toBe('einmal');
  });

  it('fällt ohne Netz auf das Zugriffstoken zurück, damit die Leitung es später erneut versucht', async () => {
    speicher.set(
      'initiative.tokens',
      JSON.stringify({ accessToken: 'a1', expiresAt: Date.now() + 600_000 }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('offline');
      }),
    );
    vi.stubGlobal('navigator', { locks: fakeLocks() });
    const tab = await neuerTab();

    expect(await tab.echtzeitZugang()).toBe('a1');
  });
});
