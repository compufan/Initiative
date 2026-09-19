import { expect, test } from '@playwright/test';

/**
 * Freistellen über ein Video hinweg – mit dem echten Netz.
 *
 * # Warum mit dem echten Netz, obwohl `folgeMaske.test.ts` es ersetzt
 *
 * Weil die Prüfung ohne Netz eine andere Frage beantwortet. Sie sagt: „Das
 * Netz läuft auf jedem vierten Bild, nie zweimal zugleich, und dazwischen
 * wird geschoben." Sie kann nicht sagen, ob u2netp mit den Bildern, die aus
 * `videoBilderLesen` fallen, überhaupt etwas anfängt – und genau dort sassen
 * die bisherigen Überraschungen: falsche Normierung, vertauschte Kanäle, eine
 * Maske, die spiegelverkehrt herauskommt.
 *
 * Das Modell liegt unter `public/models` und wird NICHT über das Netz geholt.
 *
 * # Wogegen geprüft wird
 *
 * Gegen ein Video, dessen richtige Antwort feststeht: ein helles Quadrat, das
 * über einen dunklen Grund wandert. Ein Freistellnetz sucht das auffälligste
 * Ding im Bild, und das IST hier das Quadrat. Der Schwerpunkt der Maske muss
 * ihm folgen – und zwar auch auf den Bildern, die gar nicht durchs Netz
 * gegangen sind. Genau das ist die Behauptung, die `verfolgung.ts` aufstellt.
 */

const WANDERND = `
  async () => {
    const leinwand = document.createElement('canvas');
    leinwand.width = 240;
    leinwand.height = 180;
    const ctx = leinwand.getContext('2d');
    const malen = (schritt, ms) =>
      new Promise((auf) => {
        const ende = performance.now() + ms;
        const zeichnen = () => {
          ctx.fillStyle = '#1a1a1a';
          ctx.fillRect(0, 0, leinwand.width, leinwand.height);
          ctx.fillStyle = '#f5f0e0';
          ctx.fillRect(20 + schritt * 22, 60, 60, 60);
          if (performance.now() < ende) requestAnimationFrame(zeichnen);
          else auf();
        };
        zeichnen();
      });
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, leinwand.width, leinwand.height);
    const strom = leinwand.captureStream(25);
    const art = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((t) =>
      MediaRecorder.isTypeSupported(t),
    );
    const rekorder = new MediaRecorder(strom, art ? { mimeType: art } : undefined);
    const teile = [];
    rekorder.ondataavailable = (e) => { if (e.data.size > 0) teile.push(e.data); };
    const gestoppt = new Promise((auf) => { rekorder.onstop = () => auf(); });
    rekorder.start();
    for (let i = 0; i < 6; i += 1) await malen(i, 200);
    rekorder.stop();
    await gestoppt;
    strom.getTracks().forEach((spur) => spur.stop());
    return new Blob(teile, { type: art || 'video/webm' });
  }
`;

/*
 * Dasselbe Quadrat, aber vor einem KÖRNIGEN Grund.
 *
 * Der Unterschied ist nicht kosmetisch: Ein gleichmässig dunkler Hintergrund
 * ist für LZW fast umsonst – er packt eine lange Reihe desselben Tafelplatzes
 * in ein paar Byte. An einem solchen Video liesse sich die Ersparnis durch das
 * Freistellen gar nicht zeigen, weil es nichts zu sparen gibt (nachgemessen:
 * 3478 B gegen 3270 B, also nichts). Echte Videos sind körnig, und dort
 * kostet jedes Bild volle Arbeit.
 *
 * Das Korn ist GERECHNET und nicht gewürfelt, damit die Prüfung nicht selbst
 * zufällig ist.
 */
const VERRAUSCHT = `
  async () => {
    const leinwand = document.createElement('canvas');
    leinwand.width = 240;
    leinwand.height = 180;
    const ctx = leinwand.getContext('2d');
    const korn = (versatz) => {
      const bild = ctx.createImageData(leinwand.width, leinwand.height);
      const d = bild.data;
      let zustand = 1234 + versatz * 7919;
      for (let i = 0; i < d.length; i += 4) {
        zustand = (zustand * 1103515245 + 12345) & 0x7fffffff;
        const wert = 30 + ((zustand >> 16) & 0x7f);
        d[i] = wert;
        d[i + 1] = wert;
        d[i + 2] = (wert * 3) & 0xff;
        d[i + 3] = 255;
      }
      ctx.putImageData(bild, 0, 0);
    };
    const malen = (schritt, ms) =>
      new Promise((auf) => {
        const ende = performance.now() + ms;
        let n = 0;
        const zeichnen = () => {
          korn(schritt * 10 + (n += 1));
          ctx.fillStyle = '#f5f0e0';
          ctx.fillRect(20 + schritt * 22, 60, 60, 60);
          if (performance.now() < ende) requestAnimationFrame(zeichnen);
          else auf();
        };
        zeichnen();
      });
    korn(0);
    const strom = leinwand.captureStream(25);
    const art = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((t) =>
      MediaRecorder.isTypeSupported(t),
    );
    const rekorder = new MediaRecorder(strom, art ? { mimeType: art } : undefined);
    const teile = [];
    rekorder.ondataavailable = (e) => { if (e.data.size > 0) teile.push(e.data); };
    const gestoppt = new Promise((auf) => { rekorder.onstop = () => auf(); });
    rekorder.start();
    for (let i = 0; i < 6; i += 1) await malen(i, 200);
    rekorder.stop();
    await gestoppt;
    strom.getTracks().forEach((spur) => spur.stop());
    return new Blob(teile, { type: art || 'video/webm' });
  }
`;

/*
 * „Niedrige Qualität“ ist in der App absichtlich AUSGESCHALTET, bis jemand sie
 * einschaltet – sie kostet vier Megabyte Modell. Die Prüfung tut deshalb, was
 * ein Anwender täte: Sie legt den Schalter um. Ohne das scheitert sie mit
 * genau dem Satz, den `gueteMoeglich` auch in der Oberfläche zeigt.
 */
async function netzEinschalten(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    localStorage.setItem('initiative.cutout-engines', JSON.stringify({ object: true }));
  });
}

test('die Maske folgt dem Motiv – auch zwischen zwei Netzläufen', async ({ page }) => {
  // Sechs Netzläufe à gut anderthalb Sekunden plus das Modell laden.
  test.setTimeout(240_000);
  await page.goto('/');
  await netzEinschalten(page);

  const ergebnis = await page.evaluate(async (code) => {
    const lesenPfad = '/src/modules/video/bilderLesen.ts';
    const folgePfad = '/src/modules/video/folgeMaske.ts';
    const lesen = (await import(
      /* @vite-ignore */ lesenPfad
    )) as typeof import('../src/modules/video/bilderLesen.js');
    const folge = (await import(
      /* @vite-ignore */ folgePfad
    )) as typeof import('../src/modules/video/folgeMaske.js');
    const aufnehmen = eval(code) as () => Promise<Blob>;
    const datei = await aufnehmen();

    const t0 = performance.now();
    const gelesen = await lesen.videoBilderLesen(datei, {
      zeitpunkte: [100, 300, 500, 700, 900, 1100, 1300, 1500],
      kante: 192,
    });
    const tLesen = performance.now() - t0;

    const t1 = performance.now();
    const masken = await folge.folgeMasken(gelesen.bilder, {
      guete: {
        key: 'genau',
        titel: 'Genau',
        beschreibung: 'Prüfung',
        netz: 'object',
        schluesselAbstand: 4,
        kante: 192,
        jeNetzlaufMs: 1600,
        brauchtGrafik: false,
      },
    });
    const tNetz = performance.now() - t1;

    /** Schwerpunkt und Fläche einer Maske – das macht sie vergleichbar. */
    const schwerpunkt = (alpha: Uint8Array) => {
      let sx = 0;
      let sy = 0;
      let summe = 0;
      for (let i = 0; i < alpha.length; i += 1) {
        const wert = alpha[i];
        if (wert < 96) continue;
        sx += (i % gelesen.breite) * wert;
        sy += Math.floor(i / gelesen.breite) * wert;
        summe += wert;
      }
      return summe === 0 ? null : { x: sx / summe, y: sy / summe, deckung: summe / 255 };
    };

    return {
      breite: gelesen.breite,
      hoehe: gelesen.hoehe,
      netzlaeufe: masken.netzlaeufe,
      punkte: masken.masken.map(schwerpunkt),
      msJeBildLesen: tLesen / gelesen.bilder.length,
      msJeNetzlauf: tNetz / masken.netzlaeufe,
    };
  }, WANDERND);

  // Damit die Zahlen in den Quelltexten nicht Behauptungen bleiben.
  // eslint-disable-next-line no-console
  console.log(
    `gemessen: Lesen ${ergebnis.msJeBildLesen.toFixed(0)} ms je Bild bei ${ergebnis.breite}×${ergebnis.hoehe}, ` +
      `u2netp ${ergebnis.msJeNetzlauf.toFixed(0)} ms je Lauf`,
  );

  // Acht Bilder bei Abstand vier: 0, 4 und das letzte (7).
  expect(ergebnis.netzlaeufe).toBe(3);

  const punkte = ergebnis.punkte;
  expect(punkte).toHaveLength(8);
  for (const [i, punkt] of punkte.entries()) {
    expect(punkt, `Bild ${i} hat gar keine Maske`).not.toBeNull();
  }

  /*
   * Das Quadrat wandert nach rechts. Der Schwerpunkt der Maske muss das tun –
   * und zwar über den ganzen Verlauf, nicht nur an den Schlüsselbildern.
   */
  const ersteX = punkte[0]?.x ?? 0;
  const letzteX = punkte[7]?.x ?? 0;
  expect(letzteX - ersteX, 'die Maske wandert nicht mit').toBeGreaterThan(ergebnis.breite * 0.15);

  /*
   * Die Bilder 1 bis 3 sind GESCHOBEN, nicht gerechnet. Blieben sie stehen,
   * stünde dort dreimal derselbe Wert – das ist der eigentliche Prüfstein für
   * `verfolgung.ts`.
   */
  const zwischen = [punkte[1]?.x ?? 0, punkte[2]?.x ?? 0, punkte[3]?.x ?? 0];
  expect(zwischen[1], 'zwischen zwei Netzläufen bewegt sich nichts').toBeGreaterThan(zwischen[0]);
  expect(zwischen[2], 'zwischen zwei Netzläufen bewegt sich nichts').toBeGreaterThan(zwischen[1]);

  /*
   * Und die Fläche bleibt in derselben Grössenordnung. Eine Maske, die beim
   * Schieben zerfliesst oder zusammenschrumpft, wanderte zwar, wäre aber
   * unbrauchbar.
   */
  const deckungen = punkte.map((punkt) => punkt?.deckung ?? 0);
  const kleinste = Math.min(...deckungen);
  const groesste = Math.max(...deckungen);
  expect(kleinste).toBeGreaterThan(groesste * 0.5);
});

test('freigestellt wiegt ein GIF ein Vielfaches weniger', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/');
  await netzEinschalten(page);

  const ergebnis = await page.evaluate(async (code) => {
    const bauenPfad = '/src/modules/video/gifBauen.ts';
    const bauen = (await import(
      /* @vite-ignore */ bauenPfad
    )) as typeof import('../src/modules/video/gifBauen.js');
    const aufnehmen = eval(code) as () => Promise<Blob>;
    const datei = await aufnehmen();

    const guete = {
      key: 'genau' as const,
      titel: 'Genau',
      beschreibung: 'Prüfung',
      netz: 'object' as const,
      schluesselAbstand: 4,
      kante: 192,
      jeNetzlaufMs: 1600,
      brauchtGrafik: false,
    };
    const gemeinsam = { datei, vonMs: 0, bisMs: 800, bildrate: 10, guete };

    const voll = await bauen.gifAusVideo({ ...gemeinsam, freistellen: false });
    const frei = await bauen.gifAusVideo({ ...gemeinsam, freistellen: true });
    return { voll: voll.blob.size, frei: frei.blob.size, bilder: voll.bilder };
  }, VERRAUSCHT);

  // eslint-disable-next-line no-console
  console.log(
    `gemessen: ${ergebnis.bilder} Bilder – Vollbild ${ergebnis.voll} B, freigestellt ${ergebnis.frei} B`,
  );

  /*
   * Der Grund, warum Freistellen überhaupt angeboten wird: Die durchsichtige
   * Fläche ist EIN Tafelplatz, und eine lange Reihe desselben Platzes packt
   * LZW fast umsonst. Gemessen an einem echten Video lag der Unterschied bei
   * gut dem Siebenfachen; hier wird nur das Doppelte verlangt, damit die
   * Prüfung nicht am Inhalt des Prüfvideos hängt.
   */
  expect(ergebnis.frei).toBeLessThan(ergebnis.voll / 2);
});
