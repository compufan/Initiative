import { afterEach, describe, expect, it } from 'vitest';
import { withTimeout } from './api.js';

/**
 * Das Abbruchsignal des Aufrufers muss auch dort gelten, wo es
 * `AbortSignal.any` noch nicht gibt (Safari vor 17.4).
 *
 * Sonst liefe bei der Ortssuche eine überholte, langsame Antwort nach der
 * neueren ein und überschriebe deren Vorschläge – der Abbruch im Ort-Feld
 * bliebe wirkungslos.
 */
describe('withTimeout ohne AbortSignal.any', () => {
  const original = (AbortSignal as { any?: unknown }).any;
  afterEach(() => {
    (AbortSignal as { any?: unknown }).any = original;
  });

  it('bricht ab, wenn der Aufrufer abbricht', () => {
    (AbortSignal as { any?: unknown }).any = undefined;
    const aufrufer = new AbortController();
    const signal = withTimeout(aufrufer.signal, 60_000);
    expect(signal.aborted).toBe(false);
    aufrufer.abort();
    expect(signal.aborted).toBe(true);
  });

  it('gilt sofort, wenn der Aufrufer schon abgebrochen hat', () => {
    (AbortSignal as { any?: unknown }).any = undefined;
    const aufrufer = new AbortController();
    aufrufer.abort();
    expect(withTimeout(aufrufer.signal, 60_000).aborted).toBe(true);
  });

  it('meldet das Zeitlimit weiterhin als TimeoutError', async () => {
    (AbortSignal as { any?: unknown }).any = undefined;
    const signal = withTimeout(new AbortController().signal, 5);
    await new Promise((fertig) => setTimeout(fertig, 40));
    expect(signal.aborted).toBe(true);
    expect((signal.reason as DOMException).name).toBe('TimeoutError');
  });
});
