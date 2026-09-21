import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GUETE_VORGABE,
  MAX_BILDER,
  MAX_BILDER_FILM,
  filmDauerSchaetzenMs,
  VIDEO_GUETEN,
  dauerSchaetzenMs,
  dauerText,
  gueteFinden,
  gueteMoeglich,
  gueteWaehlen,
  maxBilderFuer,
  PUNKTE_DECKEL,
  readVideoGuete,
  writeVideoGuete,
} from './einstellungen.js';

/** Welche Verfahren hier gerade als abgeschaltet gelten sollen. */
const abgeschaltet = new Set<string>();

/*
 * `vi.mock` wird nach oben gezogen, noch vor die Importe – deshalb darf die
 * Fabrik `abgeschaltet` nur BENUTZEN und nicht beim Anlegen auslesen. Genau
 * das tut sie: Sie fragt erst beim Aufruf nach.
 */
vi.mock('../stickers/engines/settings.js', () => ({
  isEngineEnabled: (key: string) => !abgeschaltet.has(key),
}));

/** Kleiner Ersatz für `localStorage`, den es in der Testumgebung nicht gibt. */
function ablage() {
  const karte = new Map<string, string>();
  return {
    getItem: (schluessel: string) => karte.get(schluessel) ?? null,
    setItem: (schluessel: string, wert: string) => void karte.set(schluessel, wert),
    removeItem: (schluessel: string) => void karte.delete(schluessel),
    clear: () => karte.clear(),
  };
}

/*
 * Statisch eingebunden und nicht je Prüfung neu geladen: `einstellungen.ts`
 * liest den Speicher erst IN den Funktionen. Ein Ersatz im `beforeEach` greift
 * damit rechtzeitig, und die Prüfungen lesen sich wie gewöhnlicher Code.
 */
beforeEach(() => {
  abgeschaltet.clear();
  vi.stubGlobal('localStorage', ablage());
});

describe('Die Liste der Güten', () => {
  it('steht in der Reihenfolge, in der sie anspruchsvoller wird', () => {
    /*
     * Daran hängt `gueteWaehlen`: Der Rückfall läuft die Liste RÜCKWÄRTS und
     * soll bei der nächstSCHLECHTEREN Güte landen.
     *
     * Geprüft wird darum der Anspruch und nicht der Preis – der wäre die
     * naheliegende und die falsche Regel: BiRefNet auf einer Grafikeinheit
     * rechnet schneller als u2netp auf dem Prozessor und ist trotzdem das
     * bessere Netz. Anspruch heisst hier: Die Rechengrösse wird nie kleiner,
     * und was einmal eine Grafikeinheit braucht, kommt danach nicht mehr ohne
     * aus.
     */
    for (let i = 1; i < VIDEO_GUETEN.length; i += 1) {
      const vorher = VIDEO_GUETEN[i - 1];
      const jetzt = VIDEO_GUETEN[i];
      expect(jetzt.kante, `${vorher.key} → ${jetzt.key}`).toBeGreaterThanOrEqual(vorher.kante);
      if (vorher.brauchtGrafik) {
        expect(jetzt.brauchtGrafik, `${vorher.key} → ${jetzt.key}`).toBe(true);
      }
    }
  });

  it('gibt jeder Güte einen Titel und einen ganzen Satz', () => {
    for (const guete of VIDEO_GUETEN) {
      expect(guete.titel.length, guete.key).toBeGreaterThan(2);
      expect(guete.beschreibung.length, guete.key).toBeGreaterThan(40);
    }
  });

  it('lässt nur „Person“ jedes Bild rechnen', () => {
    // Der Grund steht im Kopf der Datei: Ein Netzlauf kostet dort 36 ms und
    // ist damit kaum teurer als das Schieben. Bei 1,6 s wäre er es sehr wohl.
    for (const guete of VIDEO_GUETEN) {
      if (guete.schluesselAbstand === 1) expect(guete.jeNetzlaufMs).toBeLessThan(100);
      else expect(guete.jeNetzlaufMs, guete.key).toBeGreaterThan(500);
    }
  });

  it('gibt BiRefNet die 512, auf denen es rechnet', () => {
    // Kleiner hineinzugeben heisst verkleinern und wieder hochrechnen lassen –
    // die feine Kante, für die es gewählt wurde, wäre dahin.
    expect(VIDEO_GUETEN.find((guete) => guete.netz === 'birefnet')?.kante).toBe(512);
  });

  it('fängt mit einer Güte an, die überall läuft', () => {
    const vorgabe = gueteFinden(GUETE_VORGABE);
    expect(vorgabe.brauchtGrafik).toBe(false);
    expect(gueteMoeglich(vorgabe, false).moeglich).toBe(true);
  });
});

describe('gueteFinden', () => {
  it('fällt bei einem unbekannten Namen auf die erste zurück', () => {
    // Ein alter Eintrag im Speicher darf die Oberfläche nicht leer lassen.
    expect(gueteFinden('gibt-es-nicht').key).toBe(VIDEO_GUETEN[0].key);
  });
});

describe('readVideoGuete / writeVideoGuete', () => {
  it('merkt sich die Wahl', () => {
    writeVideoGuete('genau');
    expect(readVideoGuete()).toBe('genau');
  });

  it('nimmt einen fremden Eintrag nicht als bare Münze', () => {
    localStorage.setItem('initiative.video-qualitaet', 'ultra');
    expect(readVideoGuete()).toBe(VIDEO_GUETEN[0].key);
  });
});

describe('gueteMoeglich', () => {
  it('verweigert das grosse Netz ohne Grafikeinheit – mit Begründung', () => {
    /*
     * Die Zahl dahinter: nachgemessen 295 Sekunden je Bild auf dem Prozessor.
     * Ein abgeblendeter Knopf liesse jeden rätseln, ob das Gerät zu alt ist
     * oder die App kaputt.
     */
    const gross = VIDEO_GUETEN.find((guete) => guete.brauchtGrafik);
    expect(gross).toBeDefined();
    if (!gross) return;
    const befund = gueteMoeglich(gross, false);
    expect(befund.moeglich).toBe(false);
    expect(befund.grund?.length ?? 0).toBeGreaterThan(40);
    expect(befund.grund).toContain('Genau');
  });

  it('lässt es mit Grafikeinheit zu', () => {
    const gross = VIDEO_GUETEN.find((guete) => guete.brauchtGrafik);
    if (!gross) return;
    expect(gueteMoeglich(gross, true).moeglich).toBe(true);
  });

  it('beachtet den Geräteschalter und sagt, wo er steht', () => {
    // „Niedrige Qualität" lässt sich in den Einstellungen abschalten. Dann
    // fehlt das Modell, und der Grund muss den Weg zurück nennen.
    abgeschaltet.add('object');
    const genau = gueteFinden('genau');
    const befund = gueteMoeglich(genau, true);
    expect(befund.moeglich).toBe(false);
    expect(befund.grund).toContain('Einstellungen');
  });
});

describe('gueteWaehlen', () => {
  it('fällt nach UNTEN zurück und nie nach oben', () => {
    /*
     * Wer „Sehr genau" gewählt hat und keine Grafikeinheit hat, bekommt
     * „Genau". Wer „Schnell" gewählt hat, bekommt niemals „Genau" – das wären
     * ungefragte vier Megabyte für jemanden, der ausdrücklich das Schnelle
     * wollte.
     */
    expect(gueteWaehlen('sehr-genau', false)?.key).toBe('genau');
    expect(gueteWaehlen('schnell', true)?.key).toBe('schnell');
  });

  it('nimmt die gewählte, wenn sie läuft', () => {
    expect(gueteWaehlen('sehr-genau', true)?.key).toBe('sehr-genau');
  });

  it('überspringt eine abgeschaltete Stufe auf dem Weg nach unten', () => {
    abgeschaltet.add('object');
    expect(gueteWaehlen('sehr-genau', false)?.key).toBe('schnell');
  });

  it('gibt null zurück, wenn gar nichts läuft', () => {
    // Lieber ehrlich nichts als ein Knopf, der ins Leere führt.
    abgeschaltet.add('person');
    abgeschaltet.add('object');
    abgeschaltet.add('birefnet');
    expect(gueteWaehlen('sehr-genau', true)).toBeNull();
  });
});

describe('dauerSchaetzenMs', () => {
  it('trifft die Messung, aus der die Zahlen stammen', () => {
    /*
     * Fünfzig Bilder ohne Freistellen: 50 × 75 ms Lesen plus 50 × 57 ms
     * Schreiben bei 512 – das sind gemessene 3,76 s und 2,87 s, zusammen gut
     * sechseinhalb Sekunden.
     */
    const gross = gueteFinden('sehr-genau');
    expect(dauerSchaetzenMs(50, gross, false)).toBeCloseTo(6600, -3);
  });

  it('rechnet das Netz nur für die Schlüsselbilder', () => {
    /*
     * Der ganze Sinn des Schlüsselabstands. Bei „Genau" gehen von 40 Bildern
     * zehn durch das Netz – 16 s statt 64 s.
     */
    const genau = gueteFinden('genau');
    const mit = dauerSchaetzenMs(40, genau, true);
    const ohne = dauerSchaetzenMs(40, genau, false);
    expect(mit - ohne).toBeLessThan(40 * genau.jeNetzlaufMs * 0.4);
    expect(mit - ohne).toBeGreaterThan(10 * genau.jeNetzlaufMs * 0.9);
  });

  it('macht Freistellen nie schneller als gar nichts', () => {
    for (const guete of VIDEO_GUETEN) {
      expect(dauerSchaetzenMs(30, guete, true), guete.key).toBeGreaterThan(
        dauerSchaetzenMs(30, guete, false),
      );
    }
  });

  it('bleibt bei „Schnell“ im Bereich von Sekunden', () => {
    // Das ist das Versprechen der Stufe: 50 × 36 ms Netz sind 1,8 s, und der
    // Rest kommt vom Lesen. Über einer halben Minute wäre der Name gelogen.
    expect(dauerSchaetzenMs(50, gueteFinden('schnell'), true)).toBeLessThan(30_000);
  });
});

describe('dauerText', () => {
  it('rundet grob – eine Sekunde genau wäre gelogen', () => {
    expect(dauerText(3_000)).toBe('ein paar Sekunden');
    expect(dauerText(43_000)).toBe('rund 40 Sekunden');
    expect(dauerText(150_000)).toBe('rund 3 Minuten');
  });

  it('beugt „Minute“ richtig', () => {
    expect(dauerText(95_000)).toBe('rund 2 Minuten');
    expect(dauerText(91_000)).toContain('Minut');
  });
});

describe('maxBilderFuer', () => {
  it('lässt bei kleinen Bildern die volle Zahl zu', () => {
    expect(maxBilderFuer(640, 360)).toBe(MAX_BILDER);
  });

  it('senkt die Zahl mit der FLÄCHE', () => {
    /*
     * `videoBilderLesen` hält alle Bilder unkomprimiert im Speicher.
     * Hundertfünfzig Bilder bei 1280 × 720 wären 553 MB – auf einem Telefon
     * wirft der Browser dafür den Reiter weg, und zwar ohne Fehlermeldung,
     * die irgendwo ankäme.
     */
    expect(maxBilderFuer(1280, 720)).toBeLessThan(MAX_BILDER);
    expect(maxBilderFuer(1920, 1080)).toBeLessThan(maxBilderFuer(1280, 720));
  });

  it('bleibt unter dem Deckel', () => {
    for (const [b, h] of [
      [640, 360],
      [1280, 720],
      [1920, 1080],
      [3840, 2160],
    ]) {
      expect(maxBilderFuer(b, h) * b * h, `${b}×${h}`).toBeLessThanOrEqual(PUNKTE_DECKEL);
    }
  });

  it('gibt niemals null zurück', () => {
    // Auch ein unsinnig grosses Bild muss EIN Bild zulassen – sonst stünde
    // dort „0 Bilder" und ein Knopf, der nichts tun kann.
    expect(maxBilderFuer(20_000, 20_000)).toBe(1);
  });
});

describe('MAX_BILDER', () => {
  it('bleibt bei „Genau“ unter zwei Minuten Warten', () => {
    // Darüber hinaus wird aus einer Spielerei eine Sitzung.
    expect(dauerSchaetzenMs(MAX_BILDER, gueteFinden('genau'), true)).toBeLessThan(120_000);
  });
});

describe('Die Filmgrenze', () => {
  it('liegt deutlich über der GIF-Grenze', () => {
    /*
     * Beim GIF hält `MAX_BILDER` den Speicher frei, weil alle Bilder
     * unkomprimiert nebeneinanderliegen. Beim Film ohne inhaltsabhängige
     * Bereiche liegt genau EINES im Speicher – dort ist die Wartezeit die
     * Grenze, und die erlaubt viel mehr. Bei 60 Bildern je Sekunde wären
     * 150 Bilder zweieinhalb Sekunden Film gewesen.
     */
    expect(MAX_BILDER_FILM).toBeGreaterThan(MAX_BILDER);
    expect(MAX_BILDER_FILM / 60).toBeGreaterThanOrEqual(10);
  });

  it('bleibt unter zwei Minuten Wartezeit', () => {
    // Die einzige Begründung für die Zahl. Wäre sie gerissen, wäre die Zahl
    // falsch – nicht der Test.
    expect(filmDauerSchaetzenMs(MAX_BILDER_FILM, false, 4)).toBeLessThan(120_000);
  });
});

describe('filmDauerSchaetzenMs', () => {
  it('rechnet ohne Masken nur Lesen und Schreiben', () => {
    // 75 ms holen plus 15 ms zeichnen und kodieren – beides gemessen, siehe
    // `videoBauen.ts`.
    expect(filmDauerSchaetzenMs(100, false, 4)).toBe(9000);
  });

  it('wird mit Masken deutlich teurer', () => {
    const ohne = filmDauerSchaetzenMs(100, false, 4);
    const mit = filmDauerSchaetzenMs(100, true, 4);
    expect(mit).toBeGreaterThan(ohne * 5);
  });

  it('wird billiger, je seltener ein Modell läuft', () => {
    expect(filmDauerSchaetzenMs(100, true, 8)).toBeLessThan(filmDauerSchaetzenMs(100, true, 2));
  });

  it('hängt NICHT an der Fläche', () => {
    /*
     * Anders als beim GIF: `zeichneAusgabe` rechnet auf der Grafikeinheit,
     * und dort kostet ein grösseres Bild kaum mehr – gemessen 13,5 ms bei
     * 192 × 144 gegen 14,1 ms bei 960 × 540. Eine Schätzung, die mit der
     * Fläche skaliert, wäre beim Film schlicht erfunden.
     */
    expect(filmDauerSchaetzenMs.length).toBe(3);
  });
});
