import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const zugestelltMock = vi.fn();
vi.mock('../lib/api.js', () => ({
  api: { messages: { zugestellt: (...args: unknown[]) => zugestelltMock(...args) } },
}));

let z: typeof import('./zustellung.js');

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  zugestelltMock.mockReset();
  z = await import('./zustellung.js');
});
afterEach(() => vi.useRealTimers());

describe('Zustellmeldung', () => {
  it('bündelt je Chat die neueste und meldet gedrosselt in einer Anfrage', async () => {
    zugestelltMock.mockResolvedValue({ vorgerueckt: 2 });
    z.zustellungVormerken('a', '0002');
    z.zustellungVormerken('a', '0003');
    z.zustellungVormerken('a', '0001');
    z.zustellungVormerken('b', '0009');
    z.zustellungVormerken('b', 'local:x');
    expect(zugestelltMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(z.TAKT_MS + 5);
    expect(zugestelltMock).toHaveBeenCalledTimes(1);
    expect(zugestelltMock.mock.calls[0][0]).toEqual([
      { conversationId: 'a', messageId: '0003' },
      { conversationId: 'b', messageId: '0009' },
    ]);
    // Schon Gemeldetes nicht noch einmal.
    z.zustellungVormerken('a', '0003');
    await vi.advanceTimersByTimeAsync(z.TAKT_MS + 5);
    expect(zugestelltMock).toHaveBeenCalledTimes(1);
  });

  it('scheitert die Anfrage, wird es später erneut versucht', async () => {
    zugestelltMock.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ vorgerueckt: 1 });
    z.zustellungVormerken('a', '0005');
    await vi.advanceTimersByTimeAsync(z.TAKT_MS + 5);
    expect(zugestelltMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(zugestelltMock).toHaveBeenCalledTimes(2);
    expect(zugestelltMock.mock.calls[1][0]).toEqual([{ conversationId: 'a', messageId: '0005' }]);
  });
});
