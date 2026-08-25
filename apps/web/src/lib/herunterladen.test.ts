import { describe, expect, it } from 'vitest';
import { istInstalliertesApple, type Umgebung } from './herunterladen.js';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1';
const IPAD_ALS_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15';
const ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

function umgebung(teil: Partial<Umgebung>): Umgebung {
  return {
    userAgent: ANDROID,
    platform: 'Linux armv8l',
    maxTouchPoints: 5,
    standalone: false,
    alsApp: false,
    ...teil,
  };
}

describe('Speichern aufs Gerät: Sonderweg für Apple', () => {
  it('nimmt den Sonderweg auf einem iPhone in der installierten App', () => {
    expect(
      istInstalliertesApple(umgebung({ userAgent: IPHONE, platform: 'iPhone', standalone: true })),
    ).toBe(true);
  });

  it('nimmt ihn NICHT im gewöhnlichen Safari auf demselben iPhone', () => {
    // Dort funktioniert der Download-Verweis – und ein Teilen-Blatt wäre ein
    // Umweg, den niemand verlangt hat.
    expect(istInstalliertesApple(umgebung({ userAgent: IPHONE, platform: 'iPhone' }))).toBe(false);
  });

  it('erkennt ein iPad, das sich als Macintosh ausgibt', () => {
    expect(
      istInstalliertesApple(
        umgebung({
          userAgent: IPAD_ALS_MAC,
          platform: 'MacIntel',
          maxTouchPoints: 5,
          alsApp: true,
        }),
      ),
    ).toBe(true);
  });

  it('hält einen echten Mac nicht für ein iPad', () => {
    // Derselbe Kennstring, aber keine Berührungspunkte. Ohne diese
    // Unterscheidung bekäme jeder Mac im App-Modus ein Teilen-Blatt statt
    // eines Downloads.
    expect(
      istInstalliertesApple(
        umgebung({
          userAgent: IPAD_ALS_MAC,
          platform: 'MacIntel',
          maxTouchPoints: 0,
          alsApp: true,
        }),
      ),
    ).toBe(false);
  });

  it('lässt Android in Ruhe, auch als installierte App', () => {
    expect(istInstalliertesApple(umgebung({ alsApp: true, standalone: true }))).toBe(false);
  });
});
