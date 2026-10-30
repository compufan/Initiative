import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Push einschalten – mit nachgebauten Browser-Schnittstellen.
 *
 * Auf echten Geräten hiess es nach erteilter Erlaubnis „Benachrichtigungen
 * wurden nicht erlaubt“ oder „Dieser Server verschickt gerade keine
 * Benachrichtigungen“. Die Ursachen, die sich hier festhalten lassen:
 *
 * - Die Erlaubnis wurde erst NACH einem Netzweg angefragt; Safari verlangt sie
 *   unmittelbar aus der Geste.
 * - Ein vorhandenes Abo, das an einen ANDEREN Server-Schlüssel gebunden war,
 *   wurde weiterbenutzt – angemeldet, aber stumm.
 * - Jeder Fehler hiess dasselbe, weil die Oberfläche raten musste.
 *
 * Und: Ein Abo, dessen Adresse schon einem anderen Konto gehört (409), wird
 * einmal neu angelegt statt still als angemeldet zu gelten.
 */

const subscribe = vi.fn();
const publicKey = vi.fn();

vi.mock('./api.js', () => {
  class ApiError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
    get isOffline() {
      return this.status === 0;
    }
  }
  return {
    ApiError,
    api: {
      push: {
        subscribe: (body: unknown) => subscribe(body),
        publicKey: () => publicKey(),
      },
    },
  };
});

const { aboMelden, enablePush, pushMeldung, pushStatus, aboAuffrischen } =
  await import('./push.js');
const { ApiError } = await import('./api.js');

/** Ein gültiger P-256-Punkt ist für die Logik hier egal – Bytes genügen. */
const SCHLUESSEL = 'BAEC';
const ANDERER = 'BAkI';

function bytes(base64url: string): ArrayBuffer {
  return Uint8Array.from(Buffer.from(base64url, 'base64url')).buffer;
}

function abo(endpoint: string, schluessel: string | null = SCHLUESSEL) {
  return {
    endpoint,
    options: { applicationServerKey: schluessel ? bytes(schluessel) : null },
    toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: vi.fn(async () => true),
  };
}

function browser(vorhanden: ReturnType<typeof abo> | null) {
  let aktuell = vorhanden;
  let zaehler = 0;
  const pm = {
    getSubscription: vi.fn(async () => aktuell),
    subscribe: vi.fn(async (optionen: { applicationServerKey: Uint8Array }) => {
      zaehler += 1;
      aktuell = abo(
        `https://push.example/neu-${zaehler}`,
        Buffer.from(optionen.applicationServerKey).toString('base64url'),
      );
      return aktuell;
    }),
    abmelden: () => {
      aktuell = null;
    },
  };
  if (vorhanden) {
    vorhanden.unsubscribe.mockImplementation(async () => {
      pm.abmelden();
      return true;
    });
  }
  return pm;
}

/** Nachgebautes Browserfenster: Notification, Service Worker, iOS oder nicht. */
function umgebung(optionen: {
  erlaubnis?: NotificationPermission;
  antwort?: NotificationPermission;
  ios?: boolean;
  standalone?: boolean;
  pm?: ReturnType<typeof browser>;
  ohneServiceWorker?: boolean;
}) {
  const reihenfolge: string[] = [];
  const Notification = {
    permission: optionen.erlaubnis ?? 'default',
    requestPermission: vi.fn((rueckruf?: (p: NotificationPermission) => void) => {
      reihenfolge.push('erlaubnis');
      const antwort = optionen.antwort ?? 'granted';
      Notification.permission = antwort;
      rueckruf?.(antwort);
      return Promise.resolve(antwort);
    }),
  };
  publicKey.mockImplementation(() => {
    reihenfolge.push('schluessel');
    return Promise.resolve({ publicKey: SCHLUESSEL, enabled: true });
  });
  const pm = optionen.pm ?? browser(null);
  vi.stubGlobal('Notification', Notification);
  vi.stubGlobal('window', {
    atob: (text: string) => Buffer.from(text, 'base64').toString('binary'),
    matchMedia: () => ({ matches: Boolean(optionen.standalone) }),
    PushManager: function PushManager() {},
    Notification,
    navigator: { standalone: optionen.standalone },
  });
  vi.stubGlobal('navigator', {
    userAgent: optionen.ios
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15'
      : 'Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile',
    platform: optionen.ios ? 'iPhone' : 'Linux armv8l',
    maxTouchPoints: 5,
    standalone: optionen.standalone,
    serviceWorker: {
      ready: optionen.ohneServiceWorker
        ? new Promise(() => {})
        : Promise.resolve({ pushManager: pm }),
    },
  });
  return { Notification, pm, reihenfolge };
}

beforeEach(() => {
  subscribe.mockReset().mockResolvedValue({ ok: true });
  publicKey.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('enablePush', () => {
  it('fragt die Erlaubnis im selben Takt wie den Klick – vor jedem Netzweg', async () => {
    const { Notification, reihenfolge } = umgebung({});
    const laeuft = enablePush();
    // Noch kein einziges await vergangen: Die Erlaubnis ist schon angefragt.
    expect(Notification.requestPermission).toHaveBeenCalledOnce();
    expect(reihenfolge[0]).toBe('erlaubnis');
    await expect(laeuft).resolves.toEqual({ ok: true });
    expect(subscribe).toHaveBeenCalledOnce();
  });

  it('legt das Abo mit userVisibleOnly und dem Server-Schlüssel an', async () => {
    const { pm } = umgebung({});
    await enablePush();
    const [optionen] = pm.subscribe.mock.calls[0]!;
    expect(optionen).toMatchObject({ userVisibleOnly: true });
    expect(Buffer.from(optionen.applicationServerKey).toString('base64url')).toBe(SCHLUESSEL);
  });

  it('bei bereits erteilter Erlaubnis wird nicht noch einmal gefragt', async () => {
    const { Notification } = umgebung({ erlaubnis: 'granted' });
    await expect(enablePush()).resolves.toEqual({ ok: true });
    expect(Notification.requestPermission).not.toHaveBeenCalled();
  });

  it('nennt jede Ursache beim Namen', async () => {
    umgebung({ antwort: 'denied' });
    await expect(enablePush()).resolves.toMatchObject({ ok: false, grund: 'blockiert' });

    umgebung({ antwort: 'default' });
    await expect(enablePush()).resolves.toMatchObject({ ok: false, grund: 'nicht-erlaubt' });

    umgebung({ erlaubnis: 'denied' });
    await expect(enablePush()).resolves.toMatchObject({ ok: false, grund: 'blockiert' });

    umgebung({});
    publicKey.mockResolvedValue({ publicKey: null, enabled: false });
    await expect(enablePush()).resolves.toMatchObject({
      ok: false,
      grund: 'server-ohne-schluessel',
    });

    umgebung({});
    publicKey.mockRejectedValue(new ApiError(0, 'offline', 'Netz weg'));
    await expect(enablePush()).resolves.toMatchObject({
      ok: false,
      grund: 'server-nicht-erreichbar',
    });

    const pm = browser(null);
    pm.subscribe.mockRejectedValue(
      Object.assign(new Error('Registration failed - push service error'), {
        name: 'AbortError',
      }),
    );
    umgebung({ pm });
    await expect(enablePush()).resolves.toEqual({
      ok: false,
      grund: 'abo-fehlgeschlagen',
      detail: 'AbortError',
    });

    umgebung({});
    subscribe.mockRejectedValue(
      new ApiError(400, 'bad_request', 'p256dh ist kein P-256-Schlüssel'),
    );
    const abgelehnt = await enablePush();
    expect(abgelehnt).toMatchObject({ ok: false, grund: 'server-lehnt-ab' });
    if (!abgelehnt.ok) expect(pushMeldung(abgelehnt)).toContain('p256dh');
  });

  it('auf dem iPhone ausserhalb der installierten App: erst installieren', async () => {
    const { Notification } = umgebung({ ios: true, standalone: false });
    expect(pushStatus()).toBe('needs-install');
    await expect(enablePush()).resolves.toMatchObject({ ok: false, grund: 'ios-installieren' });
    expect(Notification.requestPermission).not.toHaveBeenCalled();
  });

  it('auf dem iPhone in der installierten App geht es', async () => {
    umgebung({ ios: true, standalone: true });
    expect(pushStatus()).toBe('default');
    await expect(enablePush()).resolves.toEqual({ ok: true });
    expect(pushStatus()).toBe('granted');
  });

  it('wartet nicht ewig auf einen Service Worker, den es nicht gibt', async () => {
    vi.useFakeTimers();
    umgebung({ ohneServiceWorker: true });
    const laeuft = enablePush();
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(laeuft).resolves.toMatchObject({ ok: false, grund: 'kein-service-worker' });
  });
});

describe('aboMelden', () => {
  beforeEach(() => {
    umgebung({});
  });

  it('ersetzt ein Abo, das an einen anderen Server-Schlüssel gebunden ist', async () => {
    const alt = abo('https://push.example/alt', ANDERER);
    const pm = browser(alt);
    await expect(aboMelden(pm as unknown as PushManager, SCHLUESSEL)).resolves.toEqual({
      ok: true,
    });
    expect(alt.unsubscribe).toHaveBeenCalledOnce();
    expect(subscribe.mock.calls.map(([body]) => (body as { endpoint: string }).endpoint)).toEqual([
      'https://push.example/neu-1',
    ]);
  });

  it('behält ein passendes Abo', async () => {
    const alt = abo('https://push.example/meins');
    const pm = browser(alt);
    await aboMelden(pm as unknown as PushManager, SCHLUESSEL);
    expect(alt.unsubscribe).not.toHaveBeenCalled();
    expect(pm.subscribe).not.toHaveBeenCalled();
  });

  it('legt bei 409 ein neues Abo an und meldet das an', async () => {
    const alt = abo('https://push.example/vergeben');
    const pm = browser(alt);
    subscribe
      .mockRejectedValueOnce(new ApiError(409, 'conflict', 'vergeben'))
      .mockResolvedValueOnce({ ok: true });

    await expect(aboMelden(pm as unknown as PushManager, SCHLUESSEL)).resolves.toEqual({
      ok: true,
    });

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
    await expect(aboMelden(pm as unknown as PushManager, SCHLUESSEL)).resolves.toMatchObject({
      ok: false,
      grund: 'server-lehnt-ab',
    });
    expect(subscribe).toHaveBeenCalledTimes(2);
  });

  it('lässt das Abo bei anderen Fehlern in Ruhe', async () => {
    const alt = abo('https://push.example/meins');
    const pm = browser(alt);
    subscribe.mockRejectedValue(new ApiError(500, 'internal', 'kaputt'));
    await expect(aboMelden(pm as unknown as PushManager, SCHLUESSEL)).resolves.toMatchObject({
      ok: false,
      grund: 'server-lehnt-ab',
      detail: 'kaputt',
    });
    expect(alt.unsubscribe).not.toHaveBeenCalled();
  });
});

describe('aboAuffrischen', () => {
  it('legt ohne vorhandenes Abo keines an – wer Push aus hat, bleibt aus', async () => {
    const { pm } = umgebung({ erlaubnis: 'granted' });
    await expect(aboAuffrischen()).resolves.toBeNull();
    expect(pm.subscribe).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('meldet ein vorhandenes Abo neu an und tauscht ein veraltetes', async () => {
    const alt = abo('https://push.example/alt', ANDERER);
    umgebung({ erlaubnis: 'granted', pm: browser(alt) });
    await expect(aboAuffrischen()).resolves.toEqual({ ok: true });
    expect(alt.unsubscribe).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledOnce();
  });
});
