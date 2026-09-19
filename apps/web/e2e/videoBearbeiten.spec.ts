import { expect, test } from '@playwright/test';

/**
 * Videobearbeitung von Anfang bis Ende – im echten Browser.
 *
 * Geprüft wird die Kette, die sich sonst nirgends prüfen lässt: Video lesen,
 * jedes Bild durch `zeichneAusgabe` schicken, kodieren, in den eigenen
 * Behälter legen – und die fertige Datei danach wieder abspielen.
 *
 * Die Bearbeitung ist mit Absicht eine, deren Wirkung sich MESSEN lässt und
 * nicht eine, die „gut aussieht": eine Vierteldrehung (die Kanten tauschen),
 * ein Zuschnitt (die Masse schrumpfen) und Sättigung auf null (aus Rot wird
 * Grau). An jedem der drei Punkte ist eine falsche Reihenfolge sofort
 * sichtbar, und zwar als Zahl.
 */

const AUFNEHMEN = `
  async () => {
    const leinwand = document.createElement('canvas');
    leinwand.width = 320;
    leinwand.height = 240;
    const ctx = leinwand.getContext('2d');
    const malen = (farbe, ms) =>
      new Promise((auf) => {
        const ende = performance.now() + ms;
        const schritt = () => {
          ctx.fillStyle = farbe;
          ctx.fillRect(0, 0, leinwand.width, leinwand.height);
          if (performance.now() < ende) requestAnimationFrame(schritt);
          else auf();
        };
        schritt();
      });
    ctx.fillStyle = '#d02020';
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
    await malen('#d02020', 1200);
    rekorder.stop();
    await gestoppt;
    strom.getTracks().forEach((spur) => spur.stop());
    return new Blob(teile, { type: art || 'video/webm' });
  }
`;

test('eine Bearbeitung am ersten Bild gilt für den ganzen Film', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');

  const ergebnis = await page.evaluate(async (code) => {
    const bauenPfad = '/src/modules/video/videoBauen.ts';
    const docPfad = '/src/modules/bild/doc.ts';
    const tonPfad = '/src/modules/bild/ton.ts';
    const schreibenPfad = '/src/modules/video/schreiben.ts';
    const bauen = (await import(
      /* @vite-ignore */ bauenPfad
    )) as typeof import('../src/modules/video/videoBauen.js');
    const docModul = (await import(
      /* @vite-ignore */ docPfad
    )) as typeof import('../src/modules/bild/doc.js');
    const ton = (await import(
      /* @vite-ignore */ tonPfad
    )) as typeof import('../src/modules/bild/ton.js');
    const schreiben = (await import(
      /* @vite-ignore */ schreibenPfad
    )) as typeof import('../src/modules/video/schreiben.js');
    if (!(await schreiben.videoTauglich(320, 240)).moeglich) return { uebersprungen: true };

    const aufnehmen = eval(code) as () => Promise<Blob>;
    const datei = await aufnehmen();

    /*
     * Das Dokument steht in Punkten des Quellbildes – hier also der
     * Rechengrösse 320 × 240. Der Zuschnitt nimmt die linke obere Hälfte,
     * danach dreht die Vierteldrehung sie hochkant.
     */
    const doc = {
      ...docModul.neuesDoc(320, 240),
      drehung: 90 as const,
      zuschnitt: { x: 0, y: 0, w: 160, h: 120 },
      anpassung: { ...ton.NEUTRAL, saettigung: -1 },
    };

    const abschnitte: string[] = [];
    const anteile: number[] = [];
    const fertig = await bauen.videoAusVideo({
      datei,
      doc,
      vonMs: 0,
      bisMs: 1000,
      bildrate: 10,
      kante: 320,
      schluesselAbstand: 4,
      maxBilder: 60,
      fortschritt: (anteil, abschnitt) => {
        anteile.push(anteil);
        if (abschnitte.at(-1) !== abschnitt) abschnitte.push(abschnitt);
      },
    });

    /* ---- Und wieder hinein ---- */
    const video = document.createElement('video');
    video.muted = true;
    video.src = URL.createObjectURL(fertig.blob);
    const geladen = await new Promise<boolean>((auf) => {
      video.onloadedmetadata = () => auf(true);
      video.onerror = () => auf(false);
      setTimeout(() => auf(false), 8000);
    });
    if (!geladen) return { uebersprungen: false, geladen: false, groesse: fertig.blob.size };

    const probe = document.createElement('canvas');
    probe.width = video.videoWidth;
    probe.height = video.videoHeight;
    const pctx = probe.getContext('2d', { willReadFrequently: true })!;
    const farbeBei = async (sekunden: number) => {
      await new Promise<void>((auf) => {
        video.onseeked = () => auf();
        video.currentTime = sekunden;
      });
      pctx.drawImage(video, 0, 0);
      const d = pctx.getImageData(probe.width >> 1, probe.height >> 1, 1, 1).data;
      return [d[0], d[1], d[2]];
    };

    return {
      uebersprungen: false,
      geladen: true,
      typ: fertig.blob.type,
      bilder: fertig.bilder,
      breite: fertig.breite,
      hoehe: fertig.hoehe,
      videoBreite: video.videoWidth,
      videoHoehe: video.videoHeight,
      dauer: video.duration,
      laufzeitMs: fertig.laufzeitMs,
      laeufe: fertig.laeufe,
      farben: [await farbeBei(0.15), await farbeBei(0.85)],
      abschnitte,
      steigend: anteile.every((wert, i) => i === 0 || wert >= anteile[i - 1]),
      zuletzt: anteile.at(-1) ?? 0,
    };
  }, AUFNEHMEN);

  if (ergebnis.uebersprungen) {
    test.skip(true, 'Kein Videokodierer in diesem Browser');
    return;
  }

  expect(ergebnis.geladen, 'die geschriebene Datei lässt sich nicht laden').toBe(true);
  expect(ergebnis.typ).toBe('video/webm');
  expect(ergebnis.bilder).toBe(10);
  expect(ergebnis.laufzeitMs).toBe(1000);
  expect(ergebnis.dauer).toBeGreaterThan(0.85);

  /*
   * Zuschnitt und Drehung zusammen: 320 × 240 wird auf 160 × 120
   * beschnitten und dann hochkant gedreht – also 120 × 160. Stünde die
   * Drehung VOR dem Zuschnitt, käme 160 × 120 heraus, und der Ausschnitt
   * sässe an einer ganz anderen Stelle.
   */
  expect([ergebnis.breite, ergebnis.hoehe]).toEqual([120, 160]);
  expect([ergebnis.videoBreite, ergebnis.videoHoehe]).toEqual([120, 160]);

  /*
   * Sättigung auf −1 heisst Grau. Aus einem kräftigen Rot muss ein Ton
   * werden, in dem die drei Kanäle beieinanderliegen – und das auf JEDEM
   * Bild, nicht nur auf dem ersten.
   */
  for (const [i, farbe] of (ergebnis.farben ?? []).entries()) {
    const spanne = Math.max(...farbe) - Math.min(...farbe);
    expect(spanne, `Bild bei Probe ${i} ist nicht grau: ${farbe.join(',')}`).toBeLessThan(40);
  }

  // Ohne inhaltsabhängige Teile bleibt der mittlere Abschnitt aus.
  expect(ergebnis.abschnitte).toEqual(['lesen', 'rechnen']);
  expect(ergebnis.laeufe).toBe(0);
  expect(ergebnis.steigend, 'der Balken springt zurück').toBe(true);
  expect(ergebnis.zuletzt).toBeCloseTo(1, 5);
});

test('ein Bereich mit Netz wird über die Bilder hinweg neu gerechnet', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto('/');
  await page.evaluate(() => {
    // „Niedrige Qualität" ist in der App absichtlich aus, bis jemand sie
    // einschaltet – sie kostet vier Megabyte Modell.
    localStorage.setItem('initiative.cutout-engines', JSON.stringify({ object: true }));
  });

  const ergebnis = await page.evaluate(async (code) => {
    const bauenPfad = '/src/modules/video/videoBauen.ts';
    const docPfad = '/src/modules/bild/doc.ts';
    const schreibenPfad = '/src/modules/video/schreiben.ts';
    const bauen = (await import(
      /* @vite-ignore */ bauenPfad
    )) as typeof import('../src/modules/video/videoBauen.js');
    const docModul = (await import(
      /* @vite-ignore */ docPfad
    )) as typeof import('../src/modules/bild/doc.js');
    const schreiben = (await import(
      /* @vite-ignore */ schreibenPfad
    )) as typeof import('../src/modules/video/schreiben.js');
    if (!(await schreiben.videoTauglich(320, 240)).moeglich) return { uebersprungen: true };

    const aufnehmen = eval(code) as () => Promise<Blob>;
    const datei = await aufnehmen();

    /*
     * Das Dokument steht in Punkten des Bildes, auf dem gerechnet wird – hier
     * also 192 × 144, weil `kante: 192` das Video von 320 × 240 dorthin
     * bringt. Mit 320 × 240 ist der Zuschnitt grösser als das Bild, und
     * `videoAusVideo` sagt das inzwischen auch, statt still einen Film in
     * einer Grösse zu liefern, die niemand gewählt hat.
     */
    const leer = docModul.neuesDoc(192, 144);
    const doc = {
      ...leer,
      bereiche: [
        {
          id: 'b1',
          name: 'Motiv',
          aktiv: true,
          teile: [
            {
              id: 'n1',
              modus: 'dazu' as const,
              umkehren: false,
              art: 'netz' as const,
              netz: 'object' as const,
              breite: 4,
              hoehe: 4,
              alpha: new Uint8Array(16),
              marke: 1,
            },
          ],
          anpassung: { ...docModul.BEREICH_NEUTRAL, belichtung: -2 },
        },
      ],
    };

    const abschnitte: string[] = [];
    const fertig = await bauen.videoAusVideo({
      datei,
      doc,
      vonMs: 0,
      bisMs: 600,
      bildrate: 10,
      kante: 192,
      schluesselAbstand: 4,
      maxBilder: 30,
      fortschritt: (_anteil, abschnitt) => {
        if (abschnitte.at(-1) !== abschnitt) abschnitte.push(abschnitt);
      },
    });
    /*
     * Die Datei wirklich laden, statt ihre Grösse zu prüfen.
     *
     * Sechs Bilder einer fast einfarbigen Fläche packt VP9 auf ein paar
     * hundert Byte – nachgemessen 469. Eine Schranke „grösser als N" wäre
     * hier also entweder nutzlos oder falsch. Was zählt, ist, dass ein
     * Abspieler die Datei nimmt und die Masse darin stehen.
     */
    const video = document.createElement('video');
    video.muted = true;
    video.src = URL.createObjectURL(fertig.blob);
    const geladen = await new Promise<boolean>((auf) => {
      video.onloadedmetadata = () => auf(true);
      video.onerror = () => auf(false);
      setTimeout(() => auf(false), 8000);
    });

    return {
      uebersprungen: false,
      bilder: fertig.bilder,
      laeufe: fertig.laeufe,
      groesse: fertig.blob.size,
      abschnitte,
      geladen,
      videoBreite: video.videoWidth,
      videoHoehe: video.videoHeight,
      dauer: video.duration,
    };
  }, AUFNEHMEN);

  if (ergebnis.uebersprungen) {
    test.skip(true, 'Kein Videokodierer in diesem Browser');
    return;
  }

  /*
   * Sechs Bilder bei Abstand vier: 0, 4 und das letzte (5). Die Zahl ist der
   * Beweis, dass die Maske NICHT einmal gerechnet und dann festgehalten
   * wird – und ebenso wenig sechsmal.
   */
  expect(ergebnis.bilder).toBe(6);
  expect(ergebnis.laeufe).toBe(3);
  expect(ergebnis.abschnitte).toEqual(['lesen', 'masken', 'rechnen']);

  expect(ergebnis.geladen, 'die geschriebene Datei lässt sich nicht laden').toBe(true);
  // 320 × 240 auf die längere Kante 192 gebracht: 192 × 144.
  expect([ergebnis.videoBreite, ergebnis.videoHoehe]).toEqual([192, 144]);
  expect(ergebnis.dauer).toBeGreaterThan(0.45);
});
