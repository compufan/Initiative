import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Die Karte kommt sonst vom Server. Hier genügt eine feste Adresse – geprüft
 * wird, WANN und WIE sie ins Element kommt, nicht wie sie aussieht.
 */
const ticket = vi.fn();
vi.mock('../../lib/api.js', () => ({
  api: { media: { fernsehticket: (id: string) => ticket(id) } },
}));

const {
  STILLER_ABBRUCH_MS,
  geraeteWaehlen,
  istVorbereitet,
  karteEinsetzen,
  karteEntfernen,
  kurzFuerChrome,
  streamFehler,
} = await import('./streamen.js');

/** Ein Videoelement, so weit es hier gebraucht wird – ohne Browser. */
class FalschesVideo {
  src = 'http://app.test/api/v1/media/abc';
  currentSrc = this.src;
  currentTime = 0;
  paused = true;
  ended = false;
  readyState = 1;
  dataset: Record<string, string> = {};
  private hoerer: Record<string, Array<() => void>> = {};
  remote?: { prompt: ReturnType<typeof vi.fn> };
  webkitShowPlaybackTargetPicker?: ReturnType<typeof vi.fn>;
  play = vi.fn(() => Promise.resolve());

  addEventListener(art: string, hoerer: () => void) {
    (this.hoerer[art] ??= []).push(hoerer);
  }
  removeEventListener(art: string, hoerer: () => void) {
    this.hoerer[art] = (this.hoerer[art] ?? []).filter((h) => h !== hoerer);
  }
  ausloesen(art: string) {
    const liste = this.hoerer[art] ?? [];
    this.hoerer[art] = [];
    liste.forEach((h) => h());
  }
}

function chromeVideo(): FalschesVideo {
  const video = new FalschesVideo();
  video.remote = { prompt: vi.fn(() => Promise.resolve()) };
  return video;
}

function safariVideo(): FalschesVideo {
  const video = chromeVideo();
  video.webkitShowPlaybackTargetPicker = vi.fn();
  return video;
}

const alsVideo = (v: FalschesVideo) => v as unknown as HTMLVideoElement;

beforeEach(() => {
  ticket.mockReset();
  ticket.mockResolvedValue({ url: 'http://api.test/api/v1/media/abc?tv=KARTE' });
});

describe('geraeteWaehlen – synchron im Klick', () => {
  /*
   * Der Kern des Fehlers auf dem iPhone: `prompt()` lief erst nach einem
   * Netzabruf und bis zu 2,5 s Warten – die Geste war dann verbraucht, und
   * WebKit lehnte mit InvalidAccessError ab. Jetzt MUSS der Aufruf im selben
   * Takt geschehen, also bevor irgendein Versprechen aufgelöst ist.
   */
  it('ruft prompt() im selben Takt auf, ohne vorher etwas abzuwarten', () => {
    const video = chromeVideo();
    void geraeteWaehlen(alsVideo(video));
    expect(video.remote!.prompt).toHaveBeenCalledTimes(1);
    expect(ticket).not.toHaveBeenCalled();
  });

  it('nimmt in Safari ohne Kopfdaten den AirPlay-Wähler statt prompt()', () => {
    // WebKits prompt() lehnte dann mit NotSupportedError ab – und die App
    // sagte „Dieser Browser kann nicht streamen". Der Wähler braucht keine.
    const video = safariVideo();
    video.readyState = 0;
    void geraeteWaehlen(alsVideo(video));
    expect(video.webkitShowPlaybackTargetPicker).toHaveBeenCalledTimes(1);
    expect(video.remote!.prompt).not.toHaveBeenCalled();
  });

  it('nimmt in Safari mit Kopfdaten prompt() – das meldet Verbinden und Trennen', () => {
    const video = safariVideo();
    void geraeteWaehlen(alsVideo(video));
    expect(video.remote!.prompt).toHaveBeenCalledTimes(1);
  });

  it('sagt in Chrome ohne Kopfdaten ehrlich „lädt noch" statt still abzubrechen', async () => {
    const video = chromeVideo();
    video.readyState = 0;
    await expect(geraeteWaehlen(alsVideo(video))).rejects.toMatchObject({
      name: 'NochNichtBereit',
    });
    expect(video.remote!.prompt).not.toHaveBeenCalled();
  });
});

describe('karteEinsetzen – vor dem Tipp', () => {
  it('setzt die Adresse mit Karte ein und nimmt sie wieder heraus', async () => {
    const video = chromeVideo();
    await karteEinsetzen(alsVideo(video), 'abc');
    expect(video.src).toContain('tv=KARTE');
    expect(istVorbereitet(alsVideo(video))).toBe(true);

    karteEntfernen(alsVideo(video));
    expect(video.src).toBe('http://app.test/api/v1/media/abc');
    expect(istVorbereitet(alsVideo(video))).toBe(false);
  });

  /*
   * Wer bei Minute zwölf zuschaut, während ein Fernseher auftaucht, soll bei
   * Minute zwölf weiterschauen – der Tausch setzt das Element sonst zurück.
   */
  it('behält Stelle und Abspielen beim Tausch', async () => {
    const video = chromeVideo();
    video.currentTime = 720;
    video.paused = false;
    await karteEinsetzen(alsVideo(video), 'abc');
    video.currentTime = 0; // So steht es nach dem Tausch im Browser.
    video.ausloesen('loadedmetadata');
    expect(video.currentTime).toBe(720);
    expect(video.play).toHaveBeenCalled();
  });

  it('holt für dasselbe Element nur EINE Karte, wer auch immer fragt', async () => {
    const video = chromeVideo();
    await Promise.all([
      karteEinsetzen(alsVideo(video), 'abc'),
      karteEinsetzen(alsVideo(video), 'abc'),
    ]);
    expect(ticket).toHaveBeenCalledTimes(1);
  });

  it('lässt das Element in Ruhe, wenn die Karte nicht kommt', async () => {
    const video = chromeVideo();
    ticket.mockRejectedValueOnce(new Error('offline'));
    await expect(karteEinsetzen(alsVideo(video), 'abc')).rejects.toThrow('offline');
    expect(video.src).toBe('http://app.test/api/v1/media/abc');
    expect(istVorbereitet(alsVideo(video))).toBe(false);
  });
});

describe('streamFehler', () => {
  const fehler = (name: string) => Object.assign(new Error('roh'), { name });

  it('nennt die abgelehnte Geste nicht mit dem rohen Fehlertext', () => {
    const auskunft = streamFehler(fehler('InvalidAccessError'));
    expect(auskunft.text).not.toBe('roh');
    expect(auskunft.text).toMatch(/noch einmal/);
  });

  /*
   * Chrome meldet „Liste geschlossen" und „gar keine Liste gezeigt" gleich.
   * Wer die Liste schliesst, will keine Meldung. Wer gar keine sah, sah
   * vorher: nichts – und genau das soll nicht mehr passieren.
   */
  it('schweigt, wenn jemand die Liste geschlossen hat', () => {
    expect(streamFehler(fehler('NotAllowedError'), 4000)).toEqual({ text: '', andereWege: false });
  });

  it('spricht, wenn der Browser sofort abgebrochen hat', () => {
    const auskunft = streamFehler(fehler('NotAllowedError'), STILLER_ABBRUCH_MS - 1);
    expect(auskunft.text).not.toBe('');
    expect(auskunft.andereWege).toBe(true);
  });

  it('zeigt bei „kein Gerät" die anderen Wege', () => {
    expect(streamFehler(fehler('NotFoundError')).andereWege).toBe(true);
  });
});

describe('kurzFuerChrome', () => {
  it('kennt die 15-Sekunden-Grenze von Chrome – und nur von Chrome', () => {
    expect(kurzFuerChrome(9, false)).toBe(true);
    expect(kurzFuerChrome(15, false)).toBe(true);
    expect(kurzFuerChrome(16, false)).toBe(false);
    expect(kurzFuerChrome(9, true)).toBe(false);
    // Ohne bekannte Dauer (MediaRecorder-WebM: Infinity) wird nichts behauptet.
    expect(kurzFuerChrome(Number.POSITIVE_INFINITY, false)).toBe(false);
    expect(kurzFuerChrome(Number.NaN, false)).toBe(false);
  });
});
