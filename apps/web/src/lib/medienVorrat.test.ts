import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MEDIEN_AUFRAEUMEN_ABSTAND_MS,
  MEDIEN_HOECHSTBYTES,
  MEDIEN_EINZEL_HOECHSTBYTES,
  MEDIEN_HOECHSTZAHL,
  ablegbar,
  gedrosselt,
  verdraengen,
  type VorratEintrag,
} from './medienVorrat.js';

const MB = 1024 * 1024;

function eintraege(anzahl: number, bytes = 1000): VorratEintrag[] {
  return Array.from({ length: anzahl }, (_, i) => ({ url: `/m/${i}`, bytes, zuletzt: 1000 + i }));
}

describe('verdraengen', () => {
  it('lässt einen Speicher innerhalb der Grenzen unangetastet', () => {
    expect(verdraengen(eintraege(MEDIEN_HOECHSTZAHL))).toEqual([]);
    expect(verdraengen([])).toEqual([]);
  });

  it('nimmt bei zu vielen Einträgen die am längsten ungenutzten', () => {
    const liste = eintraege(MEDIEN_HOECHSTZAHL + 3);
    // Durcheinander, damit die Reihenfolge der Eingabe nichts entscheidet.
    liste.reverse();
    expect(verdraengen(liste)).toEqual(['/m/0', '/m/1', '/m/2']);
  });

  it('räumt nach Bytes, bis die Summe wieder passt', () => {
    const liste: VorratEintrag[] = [
      { url: '/alt', bytes: 200 * MB, zuletzt: 1 },
      { url: '/mittel', bytes: 90 * MB, zuletzt: 2 },
      { url: '/neu', bytes: 50 * MB, zuletzt: 3 },
    ];
    // 340 MB > 300 MB – das älteste allein reicht.
    expect(verdraengen(liste)).toEqual(['/alt']);
  });

  it('ein Zugriff schützt: Was zuletzt gebraucht wurde, bleibt', () => {
    const liste: VorratEintrag[] = [
      { url: '/alt-aber-eben-angesehen', bytes: 200 * MB, zuletzt: 99 },
      { url: '/mittel', bytes: 90 * MB, zuletzt: 2 },
      { url: '/neu', bytes: 50 * MB, zuletzt: 3 },
    ];
    expect(verdraengen(liste)).toEqual(['/mittel']);
  });

  it('nimmt bei gleicher Zeit (Altbestand) die grossen zuerst', () => {
    const liste: VorratEintrag[] = [
      { url: '/klein', bytes: 1 * MB, zuletzt: 0 },
      { url: '/gross', bytes: MEDIEN_HOECHSTBYTES, zuletzt: 0 },
      { url: '/frisch', bytes: 10 * MB, zuletzt: 5 },
    ];
    expect(verdraengen(liste)).toEqual(['/gross']);
  });

  it('hält beide Grenzen zugleich ein', () => {
    const liste = eintraege(10, 40 * MB);
    const weg = verdraengen(liste, { hoechstzahl: 8, hoechstbytes: 200 * MB });
    // 10 × 40 MB: die Anzahl verlangt 2 weg, die Bytes 5.
    expect(weg).toEqual(['/m/0', '/m/1', '/m/2', '/m/3', '/m/4']);
  });

  it('ein einzelner Eintrag über der Bytegrenze geht selbst', () => {
    expect(verdraengen([{ url: '/riesig', bytes: MEDIEN_HOECHSTBYTES + 1, zuletzt: 9 }])).toEqual([
      '/riesig',
    ]);
  });
});

describe('gedrosselt', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fasst viele Schreibvorgänge in einen späteren Lauf zusammen', async () => {
    vi.useFakeTimers();
    const aufgabe = vi.fn(async () => {});
    const aufraeumen = gedrosselt(aufgabe, MEDIEN_AUFRAEUMEN_ABSTAND_MS);

    const versprechen = Array.from({ length: 50 }, () => aufraeumen());
    // Alle bekommen denselben Lauf – den, den `waitUntil` abwartet.
    expect(new Set(versprechen).size).toBe(1);
    expect(aufgabe).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(MEDIEN_AUFRAEUMEN_ABSTAND_MS);
    await versprechen[0];
    expect(aufgabe).toHaveBeenCalledTimes(1);

    // Danach plant ein neuer Schreibvorgang einen neuen Lauf.
    const naechster = aufraeumen();
    await vi.advanceTimersByTimeAsync(MEDIEN_AUFRAEUMEN_ABSTAND_MS);
    await naechster;
    expect(aufgabe).toHaveBeenCalledTimes(2);
  });

  it('lässt zwei Läufe nie gleichzeitig laufen', async () => {
    vi.useFakeTimers();
    let gleichzeitig = 0;
    let hoechstens = 0;
    const aufgabe = async () => {
      gleichzeitig += 1;
      hoechstens = Math.max(hoechstens, gleichzeitig);
      await new Promise((weiter) => setTimeout(weiter, 3 * MEDIEN_AUFRAEUMEN_ABSTAND_MS));
      gleichzeitig -= 1;
    };
    const aufraeumen = gedrosselt(aufgabe, MEDIEN_AUFRAEUMEN_ABSTAND_MS);
    const erster = aufraeumen();
    await vi.advanceTimersByTimeAsync(MEDIEN_AUFRAEUMEN_ABSTAND_MS);
    // Der erste läuft noch (er braucht dreimal so lang) – ein zweiter wird geplant.
    const zweiter = aufraeumen();
    expect(zweiter).not.toBe(erster);
    await vi.advanceTimersByTimeAsync(10 * MEDIEN_AUFRAEUMEN_ABSTAND_MS);
    await Promise.all([erster, zweiter]);
    expect(hoechstens).toBe(1);
  });

  it('ein Fehler im Lauf hält die nächsten nicht auf', async () => {
    vi.useFakeTimers();
    const aufgabe = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('Kontingent'))
      .mockResolvedValue(undefined);
    const aufraeumen = gedrosselt(aufgabe, 10);
    const a = aufraeumen();
    await vi.advanceTimersByTimeAsync(10);
    await expect(a).resolves.toBeUndefined();
    const b = aufraeumen();
    await vi.advanceTimersByTimeAsync(10);
    await b;
    expect(aufgabe).toHaveBeenCalledTimes(2);
  });
});

describe('ablegbar', () => {
  it('lässt kleine Antworten in den Speicher und grosse draussen', () => {
    expect(ablegbar('1000')).toBe(true);
    expect(ablegbar(String(MEDIEN_EINZEL_HOECHSTBYTES))).toBe(true);
    expect(ablegbar(String(MEDIEN_EINZEL_HOECHSTBYTES + 1))).toBe(false);
    expect(ablegbar(String(2 * 1024 * 1024 * 1024))).toBe(false);
  });

  it('ohne bekannte Grösse lieber nicht', () => {
    expect(ablegbar(null)).toBe(false);
    expect(ablegbar('')).toBe(false);
    expect(ablegbar('quatsch')).toBe(false);
  });
});
