import { expect, test } from '@playwright/test';

/**
 * Der selbstgeschriebene WebM-Behälter – gegen einen echten Abspieler.
 *
 * # Warum das die einzige Prüfung ist, die hier zählt
 *
 * `webm.test.ts` rechnet jede Längenangabe nach und prüft, dass der Baum
 * aufgeht. Das ist nötig und reicht nicht: Ein Behälter kann formal tadellos
 * sein und trotzdem von keinem Abspieler genommen werden – eine vergessene
 * `CodecID`, eine Zeit in der falschen Einheit, ein Haufen ohne
 * Schlüsselbild. Solche Fehler zeigen sich nicht als Fehlermeldung, sondern
 * als schwarzes Bild.
 *
 * Deshalb steht hier der ganze Weg: Bilder malen, kodieren, in den Behälter
 * legen – und die Datei danach von Chromium laden, ihre Länge lesen, an drei
 * Stellen hineinspringen und die Farbe messen, die dort steht.
 */

test('das geschriebene Video lässt sich abspielen und springt richtig', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');

  const ergebnis = await page.evaluate(async () => {
    const pfad = '/src/modules/video/schreiben.ts';
    const modul = (await import(
      /* @vite-ignore */ pfad
    )) as typeof import('../src/modules/video/schreiben.js');

    const tauglich = await modul.videoTauglich(320, 240);
    if (!tauglich.moeglich) return { uebersprungen: true, grund: tauglich.grund };

    /*
     * Dreissig Bilder, drei Farben zu je zehn. Bei zehn Bildern je Sekunde
     * sind das drei Sekunden – und an jeder Sekunde eine andere Farbe.
     */
    const farben = ['#e02020', '#20c020', '#2040e0'];
    const leinwand = document.createElement('canvas');
    leinwand.width = 320;
    leinwand.height = 240;
    const ctx = leinwand.getContext('2d')!;

    const anteile: number[] = [];
    const datei = await modul.videoSchreiben(
      30,
      (nummer) => {
        ctx.fillStyle = farben[Math.floor(nummer / 10)];
        ctx.fillRect(0, 0, 320, 240);
        return leinwand;
      },
      {
        breite: 320,
        hoehe: 240,
        bildrate: 10,
        fortschritt: (anteil) => anteile.push(anteil),
      },
    );

    /* ---- Und jetzt wieder hinein ---- */
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.src = URL.createObjectURL(datei);
    const geladen = await new Promise<boolean>((auf) => {
      video.onloadedmetadata = () => auf(true);
      video.onerror = () => auf(false);
      setTimeout(() => auf(false), 8000);
    });
    if (!geladen) {
      return { uebersprungen: false, geladen: false, groesse: datei.size, typ: datei.type };
    }

    const probe = document.createElement('canvas');
    probe.width = 320;
    probe.height = 240;
    const pctx = probe.getContext('2d', { willReadFrequently: true })!;
    const farbeBei = async (sekunden: number) => {
      await new Promise<void>((auf) => {
        video.onseeked = () => auf();
        video.currentTime = sekunden;
      });
      pctx.drawImage(video, 0, 0, 320, 240);
      const d = pctx.getImageData(160, 120, 1, 1).data;
      return [d[0], d[1], d[2]];
    };

    return {
      uebersprungen: false,
      geladen: true,
      typ: datei.type,
      groesse: datei.size,
      dauer: video.duration,
      breite: video.videoWidth,
      hoehe: video.videoHeight,
      bei: [await farbeBei(0.25), await farbeBei(1.25), await farbeBei(2.25)],
      anteilZuletzt: anteile.at(-1) ?? 0,
      anteilAnzahl: anteile.length,
    };
  });

  if (ergebnis.uebersprungen) {
    test.skip(true, `Kein Videokodierer: ${ergebnis.grund}`);
    return;
  }

  expect(ergebnis.geladen, 'Chromium nimmt die selbstgeschriebene Datei nicht').toBe(true);
  expect(ergebnis.typ).toBe('video/webm');
  expect(ergebnis.groesse).toBeGreaterThan(500);

  // Die Masse stehen im Kopf – ohne sie wüsste ein Abspieler sie erst beim
  // ersten Bild, und eine Zeitleiste hätte er gar nicht.
  expect(ergebnis.breite).toBe(320);
  expect(ergebnis.hoehe).toBe(240);

  /*
   * Drei Sekunden, nicht die Rechenzeit. Genau dafür steht der eigene
   * Behälter da: `MediaRecorder` hätte hier die Wanduhr genommen.
   */
  expect(ergebnis.dauer).toBeGreaterThan(2.7);
  expect(ergebnis.dauer).toBeLessThan(3.3);

  /*
   * Und an jeder Sekunde die Farbe, die dort hingehört. Das prüft die
   * Zeitangaben an den Blöcken – sie sind die Stelle, an der sich bei
   * Matroska am ehesten ein Fehler versteckt.
   */
  const [rot, gruen, blau] = ergebnis.bei ?? [[], [], []];
  expect(rot[0], 'bei 0,25 s steht kein Rot').toBeGreaterThan(140);
  expect(gruen[1], 'bei 1,25 s steht kein Grün').toBeGreaterThan(140);
  expect(blau[2], 'bei 2,25 s steht kein Blau').toBeGreaterThan(140);

  expect(ergebnis.anteilAnzahl).toBe(30);
  expect(ergebnis.anteilZuletzt).toBeCloseTo(1, 5);
});

test('ein ungerades Mass wird gerade gemacht, statt den Kodierer zu verlieren', async ({
  page,
}) => {
  await page.goto('/');

  const ergebnis = await page.evaluate(async () => {
    const pfad = '/src/modules/video/schreiben.ts';
    const modul = (await import(
      /* @vite-ignore */ pfad
    )) as typeof import('../src/modules/video/schreiben.js');
    if (!(await modul.videoTauglich(64, 64)).moeglich) return { uebersprungen: true };

    const leinwand = document.createElement('canvas');
    leinwand.width = 101;
    leinwand.height = 57;
    const ctx = leinwand.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 101, 57);

    const datei = await modul.videoSchreiben(4, () => leinwand, {
      breite: 101,
      hoehe: 57,
      bildrate: 10,
    });
    const video = document.createElement('video');
    video.src = URL.createObjectURL(datei);
    const geladen = await new Promise<boolean>((auf) => {
      video.onloadedmetadata = () => auf(true);
      video.onerror = () => auf(false);
      setTimeout(() => auf(false), 8000);
    });
    return {
      uebersprungen: false,
      geladen,
      breite: video.videoWidth,
      hoehe: video.videoHeight,
    };
  });

  if (ergebnis.uebersprungen) {
    test.skip(true, 'Kein Videokodierer');
    return;
  }

  /*
   * VP8 und VP9 rechnen die Farbe in halber Auflösung. Eine ungerade Kante
   * hat dort einen halben Bildpunkt – der Kodierer lehnt sie ab, in manchen
   * Fassungen mit einem Fehler, in anderen mit einem grünen Streifen am Rand.
   */
  expect(ergebnis.geladen).toBe(true);
  expect(ergebnis.breite).toBe(102);
  expect(ergebnis.hoehe).toBe(58);
});
