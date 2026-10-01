import { afterEach, describe, expect, it, vi } from 'vitest';

import { Ruhetor, WEITER_MS, ZUG_RUHE_MS } from './ruhetor.js';

/**
 * Das Tor der Hintergrundarbeit: zu, solange ein Grund besteht, danach noch
 * `WEITER_MS`, nach einem Zug mindestens `ZUG_RUHE_MS`. Verfolger und
 * Wischspeicher benutzen dieselbe Klasse mit verschiedenen Gründen.
 */

afterEach(() => {
  vi.useRealTimers();
});

type Grund = 'zug' | 'wiedergabe' | 'speicher';

describe('Ruhetor', () => {
  it('ist offen, solange kein Grund besteht', async () => {
    const tor = new Ruhetor<Grund>(WEITER_MS);
    expect(tor.zu).toBe(false);
    await tor.offen();
  });

  it('wartet, solange auch nur ein Grund besteht, und noch WEITER_MS danach', async () => {
    vi.useFakeTimers();
    const tor = new Ruhetor<Grund>(WEITER_MS);
    tor.setzen('wiedergabe', true);
    tor.setzen('speicher', true);
    expect(tor.zu).toBe(true);
    let offen = false;
    void tor.offen().then(() => {
      offen = true;
    });
    tor.setzen('wiedergabe', false);
    await vi.advanceTimersByTimeAsync(5000);
    // Der zweite Grund hält das Tor zu.
    expect(offen).toBe(false);
    tor.setzen('speicher', false);
    await vi.advanceTimersByTimeAsync(WEITER_MS - 10);
    expect(offen).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    expect(offen).toBe(true);
  });

  it('wartet nach einem Zug mindestens ZUG_RUHE_MS', async () => {
    vi.useFakeTimers();
    const tor = new Ruhetor<Grund>(WEITER_MS);
    tor.setzen('zug', true);
    tor.setzen('zug', false);
    let offen = false;
    void tor.offen().then(() => {
      offen = true;
    });
    await vi.advanceTimersByTimeAsync(ZUG_RUHE_MS - 10);
    expect(offen).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    expect(offen).toBe(true);
  });

  it('wartet nach einem Zug so lange, wie der Aufrufer verlangt', async () => {
    vi.useFakeTimers();
    const tor = new Ruhetor<Grund>(WEITER_MS);
    tor.setzen('zug', true);
    tor.setzen('zug', false);
    let offen = false;
    void tor.offen(1000).then(() => {
      offen = true;
    });
    await vi.advanceTimersByTimeAsync(ZUG_RUHE_MS + 100);
    expect(offen).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(offen).toBe(true);
  });

  it('zählt die Zeit am Tor mit – damit die Schätzung nur Gerechnetes lernt', async () => {
    vi.useFakeTimers();
    const tor = new Ruhetor<Grund>(WEITER_MS);
    tor.setzen('wiedergabe', true);
    const warten = tor.offen();
    await vi.advanceTimersByTimeAsync(1000);
    tor.setzen('wiedergabe', false);
    await vi.advanceTimersByTimeAsync(WEITER_MS + 10);
    await warten;
    expect(tor.gewartet).toBeGreaterThanOrEqual(1000 + WEITER_MS);
  });

  it('weckt Wartende auf, wenn es gerufen wird – sie prüfen neu', async () => {
    vi.useFakeTimers();
    const tor = new Ruhetor<Grund>(WEITER_MS);
    tor.setzen('speicher', true);
    let offen = false;
    void tor.offen().then(() => {
      offen = true;
    });
    await vi.advanceTimersByTimeAsync(10);
    tor.wecken();
    await vi.advanceTimersByTimeAsync(10);
    // Geweckt, aber der Grund besteht noch: weiter warten.
    expect(offen).toBe(false);
  });
});
