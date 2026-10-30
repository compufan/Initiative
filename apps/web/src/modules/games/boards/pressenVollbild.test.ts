import { describe, expect, it, vi } from 'vitest';
import {
  kannNativ,
  nativAnfordern,
  nativBeenden,
  nativesVollbild,
  vollbildGewuenscht,
} from './pressenVollbild.js';

describe('Vollbild-Hilfen', () => {
  it('erkennt das echte Vollbild mit und ohne Vorsatz', () => {
    const el = {} as Element;
    expect(nativesVollbild({})).toBeNull();
    expect(nativesVollbild({ fullscreenElement: el })).toBe(el);
    expect(nativesVollbild({ webkitFullscreenElement: el })).toBe(el);
  });

  it('kennt Elemente ohne Fullscreen-API (iPhone-Safari)', () => {
    expect(kannNativ({})).toBe(false);
    expect(kannNativ(null)).toBe(false);
    expect(kannNativ({ requestFullscreen: () => undefined })).toBe(true);
    expect(kannNativ({ webkitRequestFullscreen: () => undefined })).toBe(true);
  });

  it('fordert an, nimmt den webkit-Weg als Rückfall und meldet Ablehnung', async () => {
    const standard = vi.fn(() => Promise.resolve());
    expect(nativAnfordern({ requestFullscreen: standard }, () => undefined)).toBe(true);
    expect(standard).toHaveBeenCalledOnce();

    const webkit = vi.fn();
    expect(nativAnfordern({ webkitRequestFullscreen: webkit }, () => undefined)).toBe(true);
    expect(webkit).toHaveBeenCalledOnce();

    const abgelehnt = vi.fn();
    nativAnfordern({ requestFullscreen: () => Promise.reject(new Error('nein')) }, abgelehnt);
    await Promise.resolve();
    await Promise.resolve();
    expect(abgelehnt).toHaveBeenCalledOnce();
  });

  it('wirft nie: ohne API false, bei sofortigem Fehler false', () => {
    expect(nativAnfordern({}, () => undefined)).toBe(false);
    expect(
      nativAnfordern(
        {
          requestFullscreen: () => {
            throw new Error('nicht erlaubt');
          },
        },
        () => undefined,
      ),
    ).toBe(false);
  });

  it('beendet nur, wenn das Element selbst im Vollbild ist', () => {
    const el = {} as Element;
    const fremd = {} as Element;
    const exit = vi.fn(() => Promise.resolve());
    nativBeenden({ fullscreenElement: fremd, exitFullscreen: exit }, el);
    nativBeenden({ exitFullscreen: exit }, el);
    nativBeenden({ fullscreenElement: el, exitFullscreen: exit }, null);
    expect(exit).not.toHaveBeenCalled();
    nativBeenden({ fullscreenElement: el, exitFullscreen: exit }, el);
    expect(exit).toHaveBeenCalledOnce();
    const webkitExit = vi.fn();
    nativBeenden({ webkitFullscreenElement: el, webkitExitFullscreen: webkitExit }, el);
    expect(webkitExit).toHaveBeenCalledOnce();
  });

  it('Vollbild ist erwünscht, bis jemand es abgewählt hat', () => {
    expect(vollbildGewuenscht(null)).toBe(true);
    expect(vollbildGewuenscht({ getItem: () => null })).toBe(true);
    expect(vollbildGewuenscht({ getItem: () => 'an' })).toBe(true);
    expect(vollbildGewuenscht({ getItem: () => 'aus' })).toBe(false);
    expect(
      vollbildGewuenscht({
        getItem: () => {
          throw new Error('gesperrt');
        },
      }),
    ).toBe(true);
  });
});
