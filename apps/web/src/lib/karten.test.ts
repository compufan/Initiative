import { describe, expect, it } from 'vitest';
import {
  KARTEN_APPS,
  MAX_ZIELTEXT,
  appsFuer,
  bereinige,
  karteUrl,
  kodiere,
  plattformErkennen,
  punktGueltig,
  routeUrl,
  urlFuer,
  zielText,
  type KartenAppKey,
  type Plattform,
  type Ziel,
} from './karten.js';

const ADRESSE: Ziel = { art: 'text', text: 'Hauptstr. 5, 12345 Berlin' };
const PUNKT: Ziel = { art: 'punkt', breite: 48.13743, laenge: 11.57549 };

const ALLE: KartenAppKey[] = ['system', 'apple', 'google', 'osm', 'waze', 'bing'];

describe('Karten-Links: Adresse als Text', () => {
  // Die Werte stammen 1:1 aus dem Entwurf (Abschnitt 2.1). Ändert ein
  // Anbieter seine Form, ist hier genau EINE Zeile rot.
  it.each<[KartenAppKey, string, string | null]>([
    [
      'system',
      'geo:0,0?q=Hauptstr.%205%2C%2012345%20Berlin',
      // `geo:` kennt keine Route.
      null,
    ],
    [
      'apple',
      'https://maps.apple.com/?q=Hauptstr.%205%2C%2012345%20Berlin',
      'https://maps.apple.com/?daddr=Hauptstr.%205%2C%2012345%20Berlin',
    ],
    [
      'google',
      'https://www.google.com/maps/search/?api=1&query=Hauptstr.%205%2C%2012345%20Berlin',
      'https://www.google.com/maps/dir/?api=1&destination=Hauptstr.%205%2C%2012345%20Berlin',
    ],
    [
      'osm',
      'https://www.openstreetmap.org/search?query=Hauptstr.%205%2C%2012345%20Berlin',
      // Freitext als Routenziel ist bei OpenStreetMap nicht belegt.
      null,
    ],
    [
      'waze',
      'https://waze.com/ul?q=Hauptstr.%205%2C%2012345%20Berlin',
      'https://waze.com/ul?q=Hauptstr.%205%2C%2012345%20Berlin&navigate=yes',
    ],
    [
      'bing',
      'https://bing.com/maps/default.aspx?where1=Hauptstr.%205%2C%2012345%20Berlin',
      'https://bing.com/maps/default.aspx?rtp=~adr.Hauptstr.%205%2C%2012345%20Berlin',
    ],
  ])('%s', (app, karte, route) => {
    expect(karteUrl(app, ADRESSE)).toBe(karte);
    expect(routeUrl(app, ADRESSE)).toBe(route);
  });
});

describe('Karten-Links: Punkt', () => {
  it.each<[KartenAppKey, string, string | null]>([
    ['system', 'geo:48.13743,11.57549?q=48.13743%2C11.57549', null],
    [
      'apple',
      'https://maps.apple.com/?ll=48.13743%2C11.57549&q=48.13743%2C11.57549',
      'https://maps.apple.com/?daddr=48.13743%2C11.57549',
    ],
    [
      'google',
      'https://www.google.com/maps/search/?api=1&query=48.13743%2C11.57549',
      'https://www.google.com/maps/dir/?api=1&destination=48.13743%2C11.57549',
    ],
    [
      'osm',
      'https://www.openstreetmap.org/?mlat=48.13743&mlon=11.57549#map=17/48.13743/11.57549',
      'https://www.openstreetmap.org/directions?route=%3B48.13743%2C11.57549',
    ],
    [
      'waze',
      'https://waze.com/ul?ll=48.13743%2C11.57549',
      'https://waze.com/ul?ll=48.13743%2C11.57549&navigate=yes',
    ],
    [
      'bing',
      'https://bing.com/maps/default.aspx?cp=48.13743~11.57549&lvl=17&sp=point.48.13743_11.57549_Ort',
      'https://bing.com/maps/default.aspx?rtp=~pos.48.13743_11.57549',
    ],
  ])('%s', (app, karte, route) => {
    expect(karteUrl(app, PUNKT)).toBe(karte);
    expect(routeUrl(app, PUNKT)).toBe(route);
  });

  it('schreibt Koordinaten mit Punkt und höchstens sechs Nachkommastellen', () => {
    const lang: Ziel = { art: 'punkt', breite: 48.123456789, laenge: -11.5 };
    expect(karteUrl('google', lang)).toBe(
      'https://www.google.com/maps/search/?api=1&query=48.123457%2C-11.5',
    );
    // Auch ganze Zahlen und Null bleiben schlichte Zahlen, nie „-0“ oder „1e-7“.
    const null_: Ziel = { art: 'punkt', breite: -0, laenge: 1e-9 };
    expect(karteUrl('google', null_)).toBe('https://www.google.com/maps/search/?api=1&query=0%2C0');
  });

  it('weist Koordinaten ausserhalb des Bereichs ab', () => {
    expect(() => karteUrl('google', { art: 'punkt', breite: 91, laenge: 0 })).toThrow(RangeError);
    expect(() => routeUrl('waze', { art: 'punkt', breite: 0, laenge: -181 })).toThrow(RangeError);
    expect(() => karteUrl('osm', { art: 'punkt', breite: NaN, laenge: 0 })).toThrow(RangeError);
    expect(() => karteUrl('osm', { art: 'punkt', breite: 0, laenge: Infinity })).toThrow(
      RangeError,
    );
    expect(punktGueltig(90, 180)).toBe(true);
    expect(punktGueltig(-90, -180)).toBe(true);
    expect(punktGueltig(90.0001, 0)).toBe(false);
  });
});

describe('kodiere und bereinige', () => {
  it("kodiert wie encodeURIComponent und dazu ! ' ( ) * ~", () => {
    expect(kodiere("a b!'()*~")).toBe('a%20b%21%27%28%29%2A%7E');
    expect(kodiere('Straße, Zürich')).toBe('Stra%C3%9Fe%2C%20Z%C3%BCrich');
  });

  it('entfernt Steuer- und Richtungszeichen, fasst Leerraum zusammen', () => {
    expect(bereinige('a\u0000b\u0007c')).toBe('abc');
    expect(bereinige('Haupt​str.‍ 5')).toBe('Hauptstr. 5');
    // Rechts-nach-links-Überschreibung und Isolierungen würden die
    // Reihenfolge im Blatt vorspiegeln.
    expect(bereinige('a‮b⁦c⁩d')).toBe('abcd');
    expect(bereinige('﻿  a \t\n  b  ')).toBe('a b');
  });

  it('ersetzt verwaiste Surrogate, statt zu werfen', () => {
    expect(() => kodiere('a\uD800b')).not.toThrow();
    expect(bereinige('a\uD800b')).toBe('a�b');
    expect(bereinige('a\uDC00b')).toBe('a�b');
    // Ein vollständiges Paar bleibt.
    expect(bereinige('a😀b')).toBe('a😀b');
    expect(kodiere('😀')).toBe('%F0%9F%98%80');
  });

  it('kappt auf 300 Zeichen und teilt kein Emoji', () => {
    expect(bereinige('a'.repeat(500))).toHaveLength(MAX_ZIELTEXT);
    const emojis = bereinige('😀'.repeat(400));
    expect(Array.from(emojis)).toHaveLength(MAX_ZIELTEXT);
    expect(() => kodiere('😀'.repeat(400))).not.toThrow();
  });

  it('verträgt Leeres', () => {
    expect(bereinige('')).toBe('');
    expect(kodiere('   ')).toBe('');
  });
});

describe('Einschleusung', () => {
  const BOESE = 'x&api=2#frag?q=1~adr.Evil=%00\n<script>"\' javascript:alert(1) ‮\uD800 ä€😀';
  const ERWARTET: Record<KartenAppKey, { host: string; parameter: string[]; wert: string }> = {
    system: { host: '', parameter: [], wert: 'q' },
    apple: { host: 'maps.apple.com', parameter: ['q'], wert: 'q' },
    google: { host: 'www.google.com', parameter: ['api', 'query'], wert: 'query' },
    osm: { host: 'www.openstreetmap.org', parameter: ['query'], wert: 'query' },
    waze: { host: 'waze.com', parameter: ['q'], wert: 'q' },
    bing: { host: 'bing.com', parameter: ['where1'], wert: 'where1' },
  };

  it.each(ALLE)('%s: der Text bleibt EIN Parameterwert', (app) => {
    const ziel: Ziel = { art: 'text', text: BOESE };
    const bereinigt = bereinige(BOESE);
    const url = karteUrl(app, ziel);

    // Weder Steuerzeichen noch Anführungszeichen oder spitze Klammern.
    expect(url).not.toMatch(/[\u0000-\u001F<>"\s]/);

    const erwartet = ERWARTET[app];
    if (app === 'system') {
      // `geo:` hat keine Parameter im Sinne von `URL`; hier gilt: genau ein `?`
      // und ein `q=`, der Rest ist kodiert.
      expect(url.startsWith('geo:0,0?q=')).toBe(true);
      expect(url.split('?')).toHaveLength(2);
      expect(url.split('#')).toHaveLength(1);
      expect(decodeURIComponent(url.slice('geo:0,0?q='.length))).toBe(bereinigt);
      return;
    }
    const adresse = new URL(url);
    expect(adresse.protocol).toBe('https:');
    expect(adresse.host).toBe(erwartet.host);
    expect([...adresse.searchParams.keys()]).toEqual(erwartet.parameter);
    expect(adresse.searchParams.get(erwartet.wert)).toBe(bereinigt);
    expect(adresse.hash).toBe('');
  });

  it.each(ALLE)('%s: auch die Route bleibt EIN Parameterwert', (app) => {
    const ziel: Ziel = { art: 'text', text: BOESE };
    const url = routeUrl(app, ziel);
    if (url === null) return;
    expect(url).not.toMatch(/[\u0000-\u001F<>"\s]/);
    const adresse = new URL(url);
    expect(adresse.hash).toBe('');
    expect(adresse.protocol).toBe('https:');
    if (app === 'bing') {
      // Die Tilde trennt bei Bing Wegpunkte: Nur die beiden festen dürfen stehen.
      expect(url.match(/~/g)).toHaveLength(1);
      expect(url).not.toContain('~adr.Evil');
    } else if (app === 'google') {
      expect(adresse.searchParams.get('destination')).toBe(bereinige(BOESE));
      expect([...adresse.searchParams.keys()]).toEqual(['api', 'destination']);
    } else if (app === 'waze') {
      expect([...adresse.searchParams.keys()]).toEqual(['q', 'navigate']);
      expect(adresse.searchParams.get('q')).toBe(bereinige(BOESE));
    } else if (app === 'apple') {
      expect([...adresse.searchParams.keys()]).toEqual(['daddr']);
      expect(adresse.searchParams.get('daddr')).toBe(bereinige(BOESE));
    }
  });

  it('ein Schema im Text führt nirgends hin', () => {
    for (const app of ALLE) {
      const url = karteUrl(app, { art: 'text', text: 'javascript:alert(1)' });
      expect(url).not.toMatch(/^javascript:/i);
      expect(url).toMatch(/^(?:https:\/\/|geo:0,0\?q=)/);
    }
  });
});

describe('zielText', () => {
  it('gibt den bereinigten Text zurück', () => {
    expect(zielText({ art: 'text', text: '  Hauptstr.​   5 ' })).toBe('Hauptstr. 5');
  });

  it('schreibt einen Punkt mit Komma und Leerzeichen', () => {
    expect(zielText(PUNKT)).toBe('48.13743, 11.57549');
    expect(zielText({ art: 'punkt', breite: -33.8688, laenge: 151.2093 })).toBe(
      '-33.8688, 151.2093',
    );
  });
});

describe('Plattform', () => {
  const ANDROID =
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/125 Mobile Safari/537.36';
  const IPHONE =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
  const IPAD = 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
  const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15';
  const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125';
  const LINUX = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/125';

  it.each<[string, { userAgent: string; plattform: string; touchPunkte: number }, Plattform]>([
    ['Android', { userAgent: ANDROID, plattform: 'Linux armv81', touchPunkte: 5 }, 'android'],
    ['iPhone', { userAgent: IPHONE, plattform: 'iPhone', touchPunkte: 5 }, 'ios'],
    ['iPad (alt)', { userAgent: IPAD, plattform: 'iPad', touchPunkte: 5 }, 'ios'],
    // iPadOS meldet sich seit 13 als Mac – der Touchscreen verrät es.
    ['iPadOS als Mac', { userAgent: MAC, plattform: 'MacIntel', touchPunkte: 5 }, 'ios'],
    ['Mac', { userAgent: MAC, plattform: 'MacIntel', touchPunkte: 0 }, 'mac'],
    ['Windows', { userAgent: WINDOWS, plattform: 'Win32', touchPunkte: 0 }, 'andere'],
    ['Windows mit Touch', { userAgent: WINDOWS, plattform: 'Win32', touchPunkte: 10 }, 'andere'],
    ['Linux', { userAgent: LINUX, plattform: 'Linux x86_64', touchPunkte: 0 }, 'andere'],
    ['leer', { userAgent: '', plattform: '', touchPunkte: 0 }, 'andere'],
  ])('%s', (_name, umgebung, erwartet) => {
    expect(plattformErkennen(umgebung)).toBe(erwartet);
  });

  it('liest ohne Angabe den Browser – und fällt ohne Browser auf „andere“ zurück', () => {
    // In der Testumgebung (Node) gibt es kein `navigator.userAgent` mit
    // Mobilkennung; es genügt, dass der Aufruf nicht wirft.
    expect(['ios', 'android', 'mac', 'andere']).toContain(plattformErkennen());
  });
});

describe('Auswahl je Plattform', () => {
  const schluessel = (plattform: Plattform, modus: 'karte' | 'route', ziel: Ziel = ADRESSE) =>
    appsFuer(plattform, modus, ziel).map((app) => app.key);

  it('bietet geo: nur auf Android an', () => {
    expect(schluessel('android', 'karte')[0]).toBe('system');
    for (const plattform of ['ios', 'mac', 'andere'] as const) {
      expect(schluessel(plattform, 'karte')).not.toContain('system');
    }
  });

  it('bietet Apple Karten nur auf Apple-Geräten an', () => {
    expect(schluessel('ios', 'karte')[0]).toBe('apple');
    expect(schluessel('mac', 'karte')[0]).toBe('apple');
    expect(schluessel('android', 'karte')).not.toContain('apple');
    expect(schluessel('andere', 'karte')).not.toContain('apple');
  });

  it('ordnet je Plattform', () => {
    expect(schluessel('android', 'karte')).toEqual(['system', 'google', 'osm', 'waze', 'bing']);
    expect(schluessel('ios', 'karte')).toEqual(['apple', 'google', 'waze', 'osm', 'bing']);
    expect(schluessel('mac', 'karte')).toEqual(['apple', 'google', 'osm', 'waze', 'bing']);
    expect(schluessel('andere', 'karte')).toEqual(['google', 'osm', 'bing', 'waze']);
  });

  it('blendet im Modus Route die Apps ohne Route aus', () => {
    // Bei Text: weder die Standard-Karten-App noch OpenStreetMap.
    expect(schluessel('android', 'route')).toEqual(['google', 'waze', 'bing']);
    expect(schluessel('andere', 'route')).toEqual(['google', 'bing', 'waze']);
    // Bei Koordinaten kann OpenStreetMap die Route.
    expect(schluessel('andere', 'route', PUNKT)).toEqual(['google', 'osm', 'bing', 'waze']);
    expect(schluessel('android', 'route', PUNKT)).toEqual(['google', 'osm', 'waze', 'bing']);
  });

  it('jede angebotene App hat in ihrem Modus eine Adresse', () => {
    for (const plattform of ['ios', 'android', 'mac', 'andere'] as const) {
      for (const modus of ['karte', 'route'] as const) {
        for (const ziel of [ADRESSE, PUNKT]) {
          for (const app of appsFuer(plattform, modus, ziel)) {
            expect(urlFuer(app.key, modus, ziel), `${plattform} ${modus} ${app.key}`).toEqual(
              expect.any(String),
            );
          }
        }
      }
    }
  });
});

describe('Tabelle der Apps', () => {
  it('hat deutsche Namen und eine ehrliche Zeile je App', () => {
    expect(KARTEN_APPS.map((app) => app.name)).toEqual([
      'Standard-Karten-App',
      'Apple Karten',
      'Google Maps',
      'OpenStreetMap',
      'Waze',
      'Bing Karten',
    ]);
    for (const app of KARTEN_APPS) expect(app.hinweis.length).toBeGreaterThan(5);
  });

  it('öffnet nur geo: ohne Browserfenster', () => {
    for (const app of KARTEN_APPS) expect(app.imBrowser).toBe(app.key !== 'system');
    expect(karteUrl('system', ADRESSE).startsWith('geo:')).toBe(true);
    for (const app of KARTEN_APPS.filter((eintrag) => eintrag.imBrowser)) {
      expect(karteUrl(app.key, ADRESSE).startsWith('https://')).toBe(true);
    }
  });
});
