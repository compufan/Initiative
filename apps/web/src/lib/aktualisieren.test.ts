import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `neueFassungAnwenden` muss auch dann neu laden, wenn der Browser das
 * Steuerer-Ereignis nie schickt (iOS) – sonst tut „Aktualisieren“ nichts.
 */
describe('neueFassungAnwenden', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function aufbau() {
    vi.useFakeTimers();
    const horcher: Record<string, () => void> = {};
    const wartend = {
      state: 'installed',
      postMessage: vi.fn(),
      addEventListener: (art: string, f: () => void) => (horcher[`w:${art}`] = f),
    };
    vi.stubGlobal('navigator', {
      serviceWorker: {
        addEventListener: (art: string, f: () => void) => (horcher[`n:${art}`] = f),
      },
    });
    vi.stubGlobal('window', { setTimeout: (f: () => void, ms: number) => setTimeout(f, ms) });
    const modul = await import('./aktualisieren.js');
    modul.anmeldungMerken({ waiting: wartend } as unknown as ServiceWorkerRegistration);
    const neuLaden = vi.fn();
    return { modul, wartend, horcher, neuLaden };
  }

  it('lädt nach der Frist neu, auch ohne controllerchange (iOS)', async () => {
    const { modul, wartend, neuLaden } = await aufbau();
    modul.neueFassungAnwenden(2500, neuLaden);
    expect(wartend.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(neuLaden).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2500);
    expect(neuLaden).toHaveBeenCalledTimes(1);
  });

  it('lädt sofort beim Steuererwechsel – und nur einmal', async () => {
    const { modul, horcher, neuLaden } = await aufbau();
    modul.neueFassungAnwenden(2500, neuLaden);
    horcher['n:controllerchange']!();
    vi.advanceTimersByTime(5000);
    expect(neuLaden).toHaveBeenCalledTimes(1);
  });

  it('lädt ohne wartenden Arbeiter sofort neu', async () => {
    const { modul, neuLaden } = await aufbau();
    modul.anmeldungMerken({ waiting: null } as unknown as ServiceWorkerRegistration);
    modul.neueFassungAnwenden(2500, neuLaden);
    expect(neuLaden).toHaveBeenCalledTimes(1);
  });
});
