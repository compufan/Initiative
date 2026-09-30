import { describe, expect, it } from 'vitest';
import {
  DOPPELT_MS,
  KARTEN_ERNEUERN_MS,
  doppelteEingabe,
  handlungFuer,
  imKreis,
  kartenAlt,
  listeNeuHolen,
  tasteDeuten,
  tippDeuten,
  type ProgrammKopf,
} from './ablauf.js';

const KOPF: ProgrammKopf = { saat: 4711, modus: 'linear', stueckzahl: 5 };
const JETZT = 1_000_000_000;

describe('listeNeuHolen', () => {
  /*
   * Der Fall, an dem „Pause startet das Video von vorn" hing: Die Fernbedienung
   * hat nur die Pause umgeschaltet. Die Liste ist dieselbe – holte das Blatt
   * sie trotzdem, bekäme das laufende Video eine neue Adresse und finge bei
   * null an.
   */
  it('holt NICHT neu, wenn nur Stelle oder Pause sich bewegt haben', () => {
    const stand = { art: 'diashow', saat: 4711, modus: 'linear', stueckzahl: 5 };
    expect(listeNeuHolen(stand, KOPF, JETZT - 1000, JETZT)).toBe(false);
  });

  it('holt neu, wenn eingestellt oder gemischt wurde', () => {
    // Jedes Einstellen würfelt eine neue Saat – auch mit denselben Stücken.
    expect(
      listeNeuHolen(
        { art: 'diashow', saat: 1, modus: 'linear', stueckzahl: 5 },
        KOPF,
        JETZT,
        JETZT,
      ),
    ).toBe(true);
    expect(
      listeNeuHolen(
        { art: 'diashow', saat: 4711, modus: 'zufall', stueckzahl: 5 },
        KOPF,
        JETZT,
        JETZT,
      ),
    ).toBe(true);
    expect(
      listeNeuHolen(
        { art: 'diashow', saat: 4711, modus: 'linear', stueckzahl: 6 },
        KOPF,
        JETZT,
        JETZT,
      ),
    ).toBe(true);
  });

  it('holt neu, wenn ein Chat an die Stelle der Diashow tritt', () => {
    expect(listeNeuHolen({ art: 'chat', saat: 4711 }, KOPF, JETZT, JETZT)).toBe(true);
  });

  it('holt wie früher neu, wenn der Server noch keine Saat meldet', () => {
    expect(
      listeNeuHolen({ art: 'diashow', modus: 'linear', stueckzahl: 5 }, KOPF, JETZT, JETZT),
    ).toBe(true);
  });

  it('holt ohne laufendes Programm immer', () => {
    expect(listeNeuHolen({ saat: 1 }, null, JETZT, JETZT)).toBe(true);
  });

  /*
   * Eine Karte gilt sechs Stunden. Eine Diashow, die niemand anfasst, lief
   * danach in lauter 401 – das Blatt holte nie neu, weil sich nie etwas
   * änderte.
   */
  it('holt vor dem Ablauf der Karten neu, auch wenn sich nichts geändert hat', () => {
    const stand = { art: 'diashow', saat: 4711, modus: 'linear', stueckzahl: 5 };
    expect(kartenAlt(JETZT - KARTEN_ERNEUERN_MS + 1, JETZT)).toBe(false);
    expect(kartenAlt(JETZT - KARTEN_ERNEUERN_MS, JETZT)).toBe(true);
    expect(listeNeuHolen(stand, KOPF, JETZT - KARTEN_ERNEUERN_MS, JETZT)).toBe(true);
    // Und mit einer Stunde Luft vor den sechs Stunden der Karte.
    expect(KARTEN_ERNEUERN_MS).toBeLessThanOrEqual(5 * 60 * 60 * 1000);
  });
});

describe('imKreis', () => {
  it('läuft vorwärts über das Ende und rückwärts über den Anfang', () => {
    expect(imKreis(5, 5)).toBe(0);
    expect(imKreis(-1, 5)).toBe(4);
    expect(imKreis(12, 5)).toBe(2);
    expect(imKreis(3, 0)).toBe(0);
  });
});

describe('tasteDeuten', () => {
  it('versteht die Namen neuerer Browser', () => {
    expect(tasteDeuten('ArrowRight', 39)).toBe('weiter');
    expect(tasteDeuten('ArrowLeft', 37)).toBe('zurueck');
    expect(tasteDeuten('Enter', 13)).toBe('ok');
    expect(tasteDeuten(' ', 32)).toBe('ok');
    expect(tasteDeuten('MediaPlayPause', 179)).toBe('ok');
  });

  /*
   * Ältere Fernseher melden bei manchen Tasten nur „Unidentified". Dann
   * zählt der alte Zahlencode – sonst tut die OK-Taste nichts, und der Ton
   * bleibt für immer aus.
   */
  it('fällt auf den Zahlencode zurück, wo der Name fehlt', () => {
    expect(tasteDeuten('Unidentified', 13)).toBe('ok');
    expect(tasteDeuten(undefined, 39)).toBe('weiter');
    expect(tasteDeuten('Unidentified', 10252)).toBe('ok');
    expect(tasteDeuten('Unidentified', 10232)).toBe('zurueck');
  });

  it('lässt fremde Tasten in Ruhe', () => {
    expect(tasteDeuten('a', 65)).toBeNull();
    expect(tasteDeuten('Escape', 27)).toBeNull();
  });

  /*
   * 415 und 19 wurden als Umschalter gedeutet: „Abspielen" bei laufender
   * Schau hielt sie an, „Pause" bei angehaltener setzte sie fort.
   */
  it('deutet Abspielen und Pause einzeln – nicht als Umschalter', () => {
    expect(tasteDeuten('MediaPlay', 415)).toBe('abspielen');
    expect(tasteDeuten('Unidentified', 415)).toBe('abspielen');
    expect(tasteDeuten('MediaPause', 19)).toBe('anhalten');
    expect(tasteDeuten('Pause', 19)).toBe('anhalten');
    expect(tasteDeuten('Unidentified', 19)).toBe('anhalten');
    // Die kombinierte Taste bleibt ein Umschalter.
    expect(tasteDeuten('Unidentified', 10252)).toBe('ok');
  });
});

describe('handlungFuer', () => {
  const laeuft = { videoStumm: false, pausiert: false };
  const steht = { videoStumm: false, pausiert: true };
  const stumm = { videoStumm: true, pausiert: false };

  it('Abspielen spielt nur ab, Pause hält nur an', () => {
    expect(handlungFuer('abspielen', laeuft)).toBeNull();
    expect(handlungFuer('abspielen', steht)).toBe('fortsetzen');
    expect(handlungFuer('anhalten', laeuft)).toBe('anhalten');
    expect(handlungFuer('anhalten', steht)).toBeNull();
  });

  /*
   * Bei einem stummen Video schaltete „Pause" den Ton ein und das Video lief
   * weiter. Nur OK gehört dem Ton.
   */
  it('bei einem stummen Video gehört OK dem Ton – Abspielen und Pause nicht', () => {
    expect(handlungFuer('ok', stumm)).toBe('ton');
    expect(handlungFuer('anhalten', stumm)).toBe('anhalten');
    expect(handlungFuer('abspielen', { videoStumm: true, pausiert: true })).toBe('fortsetzen');
  });

  it('OK schaltet sonst um, die Pfeile blättern', () => {
    expect(handlungFuer('ok', laeuft)).toBe('anhalten');
    expect(handlungFuer('ok', steht)).toBe('fortsetzen');
    expect(handlungFuer('weiter', stumm)).toBe('weiter');
    expect(handlungFuer('zurueck', steht)).toBe('zurueck');
    expect(handlungFuer(null, laeuft)).toBeNull();
  });
});

describe('tippDeuten', () => {
  /*
   * Ohne Tastatur – Tablet, zweites Telefon, Maus, Zeigermodus der
   * Fernbedienung – gab es weder Ton noch Blättern. Ein Tipp in die Mitte ist
   * OK, an den Rändern wird geblättert.
   */
  it('Mitte ist OK, die Ränder blättern', () => {
    expect(tippDeuten(960, 1920)).toBe('ok');
    expect(tippDeuten(600, 1920)).toBe('ok');
    expect(tippDeuten(100, 1920)).toBe('zurueck');
    expect(tippDeuten(1850, 1920)).toBe('weiter');
    // Ohne bekannte Breite lieber OK als ein Sprung.
    expect(tippDeuten(10, 0)).toBe('ok');
  });
});

describe('doppelteEingabe', () => {
  it('nimmt Klick und Enter derselben Betätigung nur einmal', () => {
    expect(doppelteEingabe(1000, 1000 + DOPPELT_MS - 1)).toBe(true);
    expect(doppelteEingabe(1000, 1000 + DOPPELT_MS)).toBe(false);
    expect(doppelteEingabe(0, 5000)).toBe(false);
  });
});
