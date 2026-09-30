import { describe, expect, it } from 'vitest';
import {
  ANLEITUNGEN,
  mitteilungenAbschalten,
  plattformAus,
  spiegelAnleitungen,
  type Plattform,
} from './spiegeln.js';
import { ohneElementVollbild, startStelle, wischSchritt } from './fernsehansicht.js';

const UA = {
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
  samsungInternet:
    'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36',
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  ipadAlsMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
  windows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
};

describe('plattformAus', () => {
  it('erkennt ein Galaxy an Samsung Internet oder am Modell', () => {
    expect(plattformAus(UA.samsungInternet)).toBe('samsung');
    // Chrome kürzt die Kennung auf „K" – das Modell kommt nur über userAgentData.
    expect(plattformAus(UA.chromeAndroid)).toBe('android');
    expect(plattformAus(UA.chromeAndroid, 5, 'SM-A546B')).toBe('samsung');
    expect(plattformAus(UA.chromeAndroid, 5, 'Pixel 8')).toBe('pixel');
  });

  it('hält ein iPad, das sich als Mac ausgibt, für ein iPad', () => {
    expect(plattformAus(UA.ipadAlsMac, 5)).toBe('ipad');
    expect(plattformAus(UA.ipadAlsMac, 0)).toBe('mac');
    expect(plattformAus(UA.iphone)).toBe('iphone');
  });

  it('kennt Windows und bleibt sonst ehrlich unbestimmt', () => {
    expect(plattformAus(UA.windows)).toBe('windows');
    expect(plattformAus('Mozilla/5.0 (X11; Linux x86_64) Firefox/131.0')).toBe('andere');
  });
});

describe('spiegelAnleitungen', () => {
  const ALLE: Plattform[] = [
    'samsung',
    'pixel',
    'android',
    'iphone',
    'ipad',
    'mac',
    'windows',
    'andere',
  ];

  /*
   * Die Erkennung kann irren. Ein Irrtum darf die Reihenfolge ändern, aber
   * nie eine Anleitung verschwinden lassen.
   */
  it('zeigt immer alle Anleitungen – die eigene zuerst', () => {
    for (const plattform of ALLE) {
      const { eigene, andere } = spiegelAnleitungen(plattform);
      const zusammen = [...(eigene ? [eigene] : []), ...andere];
      expect(zusammen.map((a) => a.id).sort(), plattform).toEqual(
        ANLEITUNGEN.map((a) => a.id).sort(),
      );
    }
    expect(spiegelAnleitungen('ipad').eigene?.id).toBe('iphone');
    expect(spiegelAnleitungen('andere').eigene).toBeNull();
  });

  it('sagt beim Pixel, dass Miracast fehlt', () => {
    const pixel = ANLEITUNGEN.find((a) => a.id === 'pixel');
    expect(pixel?.hinweis).toMatch(/Miracast/);
  });
});

describe('mitteilungenAbschalten', () => {
  /*
   * Pflicht, nicht Tipp: Beim iPhone sind Mitteilungen während der
   * Synchronisierung standardmässig erlaubt. Der Weg dorthin muss dastehen.
   */
  it('nennt auf dem iPhone den Schalter unter Bildschirmfreigabe', () => {
    expect(mitteilungenAbschalten('iphone')).toMatch(/Bildschirmfreigabe/);
    expect(mitteilungenAbschalten('ipad')).toMatch(/Bildschirmfreigabe/);
  });

  it('hat für jede Plattform einen Satz', () => {
    for (const plattform of ['samsung', 'pixel', 'android', 'mac', 'windows', 'andere'] as const) {
      expect(mitteilungenAbschalten(plattform).length).toBeGreaterThan(10);
    }
  });
});

describe('Fernsehansicht – Rechnungen', () => {
  it('liest ein Wischen nach links als „weiter"', () => {
    expect(wischSchritt(-120, 10)).toBe(1);
    expect(wischSchritt(120, 10)).toBe(-1);
    // Zu kurz oder zu senkrecht ist kein Wischen.
    expect(wischSchritt(-30, 0)).toBe(0);
    expect(wischSchritt(-80, 90)).toBe(0);
  });

  it('beginnt der Reihe nach beim gewählten Stück, gemischt am Anfang', () => {
    expect(startStelle(3, 10, 'linear')).toBe(3);
    expect(startStelle(30, 10, 'linear')).toBe(9);
    expect(startStelle(3, 10, 'zufall')).toBe(0);
    expect(startStelle(0, 0, 'linear')).toBe(0);
  });

  it('versucht auf iPhone und iPad kein Seiten-Vollbild', () => {
    expect(ohneElementVollbild(UA.iphone, 5)).toBe(true);
    expect(ohneElementVollbild(UA.ipadAlsMac, 5)).toBe(true);
    expect(ohneElementVollbild(UA.chromeAndroid, 5)).toBe(false);
    expect(ohneElementVollbild(UA.ipadAlsMac, 0)).toBe(false);
  });
});
