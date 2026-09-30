import { afterEach, describe, expect, it, vi } from 'vitest';
import { abspielen, castFehlerAus, castFehlertext, castMime } from './cast.js';

describe('castFehlerAus', () => {
  /*
   * Der Fehler, den es zu beheben galt: `loadMedia` lehnt mit einer KENNUNG
   * als Zeichenkette ab. `(fehler as Error)?.message` war dann `undefined`,
   * und es erschien gar keine Meldung – der Fernseher blieb leer, das Telefon
   * stumm.
   */
  it('liest eine nackte Kennung als Satz', () => {
    expect(castFehlerAus('LOAD_MEDIA_FAILED')).toMatch(/Videoformat/);
    expect(castFehlerAus('TIMEOUT')).toMatch(/nicht geantwortet/);
  });

  it('liest auch ein Fehlerobjekt des SDK mit `code`', () => {
    expect(castFehlerAus({ code: 'session_error', description: 'x' })).toMatch(/abgebrochen/);
  });

  it('lässt einen fertigen Satz stehen', () => {
    expect(castFehlerAus(new Error('Schon ein Satz.'))).toBe('Schon ein Satz.');
  });

  it('sagt bei einem Bild nicht „Videoformat"', () => {
    expect(castFehlerAus('LOAD_MEDIA_FAILED', 'bild')).not.toMatch(/Videoformat/);
  });

  it('bleibt still, wenn jemand abbricht', () => {
    expect(castFehlertext('CANCEL')).toBe('');
  });
});

describe('castMime', () => {
  it('schickt ein iPhone-Video als MP4 – derselbe Behälter', () => {
    expect(castMime('video/quicktime')).toBe('video/mp4');
    expect(castMime('video/webm')).toBe('video/webm');
    expect(castMime('image/jpeg')).toBe('image/jpeg');
  });
});

describe('abspielen', () => {
  const welt = globalThis as typeof globalThis & { chrome?: unknown };
  afterEach(() => {
    delete welt.chrome;
  });

  function sdkVortaeuschen() {
    welt.chrome = {
      cast: {
        media: {
          MediaInfo: class {
            constructor(
              public contentId: string,
              public contentType: string,
            ) {}
          },
          LoadRequest: class {
            constructor(public info: unknown) {}
          },
          StreamType: { BUFFERED: 'BUFFERED' },
          GenericMediaMetadata: class {},
          PhotoMediaMetadata: class {},
        },
      },
    };
  }

  it('macht aus einer Ablehnung als Zeichenkette eine lesbare Meldung', async () => {
    sdkVortaeuschen();
    const sitzung = {
      loadMedia: vi.fn(() => Promise.reject('LOAD_MEDIA_FAILED')),
      endSession: vi.fn(),
    };
    await expect(
      abspielen(sitzung, { url: 'u', mime: 'video/webm', titel: 't', bild: false }),
    ).rejects.toThrow(/Videoformat kann der Fernseher nicht abspielen/);
  });

  it('meldet auch eine Kennung, die als Erfüllung zurückkommt', async () => {
    sdkVortaeuschen();
    const sitzung = { loadMedia: vi.fn(() => Promise.resolve('TIMEOUT')), endSession: vi.fn() };
    await expect(
      abspielen(sitzung, { url: 'u', mime: 'image/jpeg', titel: 't', bild: true }),
    ).rejects.toThrow(/nicht geantwortet/);
  });

  it('geht still durch, wenn es geklappt hat', async () => {
    sdkVortaeuschen();
    const sitzung = { loadMedia: vi.fn(() => Promise.resolve(undefined)), endSession: vi.fn() };
    await expect(
      abspielen(sitzung, { url: 'u', mime: 'video/mp4', titel: 't', bild: false }),
    ).resolves.toBeUndefined();
  });
});
