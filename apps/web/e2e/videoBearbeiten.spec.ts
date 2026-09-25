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
      stuecke: [{ vonMs: 0, bisMs: 1000 }],
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

  /*
   * Ohne inhaltsabhängige Teile läuft der STRÖMENDE Weg: lesen, zeichnen und
   * kodieren passieren in derselben Schleife, und kein einziges Bild wird
   * aufgehoben. Deshalb steht hier ein Abschnitt und nicht zwei – vorher
   * waren es „lesen" und „rechnen", und zwischen beiden lagen alle Bilder
   * des Films im Speicher. Genau das war die Grenze, an der bei 60 Bildern
   * je Sekunde nach zweieinhalb Sekunden Schluss war.
   */
  expect(ergebnis.abschnitte).toEqual(['strom']);
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
      stuecke: [{ vonMs: 0, bisMs: 600 }],
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

test('die Tiefenkarte läuft über den Film – mit EINER Sitzung', async ({ page }) => {
  /*
   * Die teuerste Prüfung dieses Projektes, und die einzige, die zeigt, dass
   * die Tiefe im Film wirklich ankommt: ein Modell von 20,6 MB, gemessen
   * 0,8 s zum Öffnen der Sitzung und rund 2,5 s je Lauf.
   *
   * Sie ist die Antwort auf eine Frage, die sich ohne Browser nicht stellen
   * lässt: `folgeTeile.test.ts` prüft mit einem Ersatz, dass die Sitzung
   * EINMAL geöffnet wird. Ob dieselbe Sitzung danach ein zweites und drittes
   * Bild rechnet, ohne dass ONNX die Tensoren durcheinanderbringt, kann nur
   * ONNX beantworten.
   */
  test.setTimeout(300_000);
  await page.goto('/');
  await page.evaluate(() => {
    // „Tiefenschärfe" ist in der App absichtlich aus, bis jemand sie
    // einschaltet – 20,6 MB Modell holt man nicht ungefragt.
    localStorage.setItem('initiative.cutout-engines', JSON.stringify({ tiefe: true }));
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

    const leer = docModul.neuesDoc(192, 144);
    const doc = {
      ...leer,
      bereiche: [
        {
          id: 'b1',
          name: 'Tiefe',
          aktiv: true,
          teile: [
            {
              id: 'd1',
              modus: 'dazu' as const,
              umkehren: false,
              art: 'tiefe' as const,
              breite: 4,
              hoehe: 4,
              karte: new Uint8Array(16),
              fokus: 1,
              spanne: 0.5,
              marke: 1,
            },
          ],
          anpassung: { ...docModul.BEREICH_NEUTRAL, unschaerfe: 0.8 },
        },
      ],
    };

    const t0 = performance.now();
    const fertig = await bauen.videoAusVideo({
      datei,
      doc,
      stuecke: [{ vonMs: 0, bisMs: 500 }],
      bildrate: 10,
      kante: 192,
      schluesselAbstand: 4,
      maxBilder: 30,
    });
    const gebraucht = performance.now() - t0;

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
      geladen,
      videoBreite: video.videoWidth,
      videoHoehe: video.videoHeight,
      msGesamt: Math.round(gebraucht),
    };
  }, AUFNEHMEN);

  if (ergebnis.uebersprungen) {
    test.skip(true, 'Kein Videokodierer in diesem Browser');
    return;
  }

  // eslint-disable-next-line no-console
  console.log(
    `gemessen: ${ergebnis.bilder} Bilder mit Tiefe, ${ergebnis.laeufe} Modelläufe, ${ergebnis.msGesamt} ms gesamt`,
  );

  // Fünf Bilder bei Abstand vier: 0 und das letzte (4).
  expect(ergebnis.bilder).toBe(5);
  expect(ergebnis.laeufe).toBe(2);
  expect(ergebnis.geladen, 'der Film mit Tiefenschärfe lässt sich nicht laden').toBe(true);
  expect([ergebnis.videoBreite, ergebnis.videoHoehe]).toEqual([192, 144]);
});

/** Eine Aufnahme, die erst rot und dann grün ist – damit sich Stücke unterscheiden lassen. */
const AUFNEHMEN_ZWEI = `
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
    const strom = leinwand.captureStream(30);
    const art = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((t) =>
      MediaRecorder.isTypeSupported(t),
    );
    const rekorder = new MediaRecorder(strom, art ? { mimeType: art } : undefined);
    const teile = [];
    rekorder.ondataavailable = (e) => { if (e.data.size > 0) teile.push(e.data); };
    const gestoppt = new Promise((auf) => { rekorder.onstop = () => auf(); });
    rekorder.start();
    await malen('#d02020', 600);
    await malen('#20a020', 700);
    rekorder.stop();
    await gestoppt;
    strom.getTracks().forEach((spur) => spur.stop());
    return new Blob(teile, { type: art || 'video/webm' });
  }
`;

test('sechzig Bilder je Sekunde sind wirklich sechzig – und nicht fünfzig', async ({ page }) => {
  /*
   * Die Bitte lautete „bis zu 60 Bilder pro sekunde beim Video bearbeiten".
   * 60 einfach in die Liste einzutragen hätte sie NICHT erfüllt, und zwar
   * lautlos: `dauerJeBildMs` ist die GIF-Regel und rastert auf ganze
   * Zehntelhundertstel, mit einem Riegel bei 20 ms. Abgetastet worden wären
   * also 50 Bilder je Sekunde, beschriftet als 60 – eine Sekunde Original
   * wäre zu 0,83 Sekunden Film geworden, 20 Prozent zu schnell.
   *
   * Der Test misst deshalb beides: die Zahl der Bilder UND die Länge der
   * fertigen Datei. Nur eines von beiden wäre grün geblieben.
   */
  test.setTimeout(180_000);
  await page.goto('/');

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

    const datei = await (eval(code) as () => Promise<Blob>)();
    const fertig = await bauen.videoAusVideo({
      datei,
      doc: docModul.neuesDoc(320, 240),
      stuecke: [{ vonMs: 0, bisMs: 1000 }],
      bildrate: 60,
      kante: 320,
      schluesselAbstand: 4,
      maxBilder: 600,
    });

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
      geladen,
      bilder: fertig.bilder,
      laufzeitMs: fertig.laufzeitMs,
      dauer: video.duration,
    };
  }, AUFNEHMEN);

  if (ergebnis.uebersprungen) {
    test.skip(true, 'Kein Videokodierer in diesem Browser');
    return;
  }
  expect(ergebnis.geladen, 'die geschriebene Datei lässt sich nicht laden').toBe(true);
  // Eine Sekunde bei 60 Bildern je Sekunde sind 60 Bilder. Mit dem GIF-Raster
  // wären es 50 gewesen.
  expect(ergebnis.bilder).toBe(60);
  expect(ergebnis.laufzeitMs).toBe(1000);
  expect(ergebnis.dauer, `gemeldete Länge ${ergebnis.dauer} s`).toBeGreaterThan(0.93);
  expect(ergebnis.dauer).toBeLessThan(1.07);
});

test('zwei Stücke laufen in der gewählten Reihenfolge', async ({ page }) => {
  /*
   * Die zweite Hälfte der Bitte: „Gib mir Schnittoptionen". Der Film besteht
   * hier aus zwei Stücken, und das SPÄTERE steht vorn. Gemessen wird die
   * Farbe – die Aufnahme ist erst rot, dann grün, also muss der fertige Film
   * erst grün und dann rot sein. Eine Prüfung auf die blosse Bilderzahl wäre
   * auch dann grün geblieben, wenn die Reihenfolge stillschweigend wieder
   * nach der Zeit sortiert würde.
   */
  test.setTimeout(180_000);
  await page.goto('/');

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

    const datei = await (eval(code) as () => Promise<Blob>)();
    const fertig = await bauen.videoAusVideo({
      datei,
      doc: docModul.neuesDoc(320, 240),
      // Das spätere Stück zuerst – genau das kann man in der Oberfläche mit
      // den beiden Pfeilen einstellen.
      stuecke: [
        { vonMs: 800, bisMs: 1100 },
        { vonMs: 0, bisMs: 300 },
      ],
      bildrate: 10,
      kante: 320,
      schluesselAbstand: 4,
      maxBilder: 600,
    });

    const video = document.createElement('video');
    video.muted = true;
    video.src = URL.createObjectURL(fertig.blob);
    const geladen = await new Promise<boolean>((auf) => {
      video.onloadedmetadata = () => auf(true);
      video.onerror = () => auf(false);
      setTimeout(() => auf(false), 8000);
    });
    if (!geladen) return { uebersprungen: false, geladen: false };

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
      bilder: fertig.bilder,
      laufzeitMs: fertig.laufzeitMs,
      vorn: await farbeBei(0.05),
      hinten: await farbeBei(0.45),
    };
  }, AUFNEHMEN_ZWEI);

  if (ergebnis.uebersprungen) {
    test.skip(true, 'Kein Videokodierer in diesem Browser');
    return;
  }
  expect(ergebnis.geladen, 'die geschriebene Datei lässt sich nicht laden').toBe(true);
  // Dreihundert Millisekunden je Stück bei zehn Bildern je Sekunde: drei und
  // drei.
  expect(ergebnis.bilder).toBe(6);
  expect(ergebnis.laufzeitMs).toBe(600);

  const [vr, vg] = ergebnis.vorn ?? [0, 0, 0];
  const [hr, hg] = ergebnis.hinten ?? [0, 0, 0];
  expect(vg, `vorn müsste grün sein, ist aber ${(ergebnis.vorn ?? []).join(',')}`).toBeGreaterThan(
    vr,
  );
  expect(
    hr,
    `hinten müsste rot sein, ist aber ${(ergebnis.hinten ?? []).join(',')}`,
  ).toBeGreaterThan(hg);
});

test('das Bild läuft weiter, wenn eine Bearbeitung darauf liegt', async ({ page }) => {
  /*
   * Gemeldet als „Jetzt bleibt das Video stehen, während sich die Maske
   * bewegt". Die Ursache sass in den Merkzetteln von `tonGpu.ts` und
   * `zeichnen.ts`: Sie erkannten „dasselbe Bild" an der Objektidentität, und
   * `videoBauen` schreibt jedes Filmbild mit `putImageData` in DIESELBE
   * Leinwand. Heraus kam Bild 0 in jedem Bild – mit einer Farbanpassung
   * ebenso wie mit einem Bereich, Masken darüber je Bild richtig.
   *
   * Die übrigen Prüfungen hier merkten das nicht, weil ihre Aufnahme einfarbig
   * ist: Ein eingefrorenes rotes Bild ist von einem laufenden roten Bild nicht
   * zu unterscheiden. Hier wandert deshalb ein weisses Quadrat, und gemessen
   * wird, wo es steht.
   */
  test.setTimeout(180_000);
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  const ergebnis = await page.evaluate(async () => {
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

    // Die Aufnahme: ein weisses Quadrat wandert über einen Verlauf, 8 Punkte
    // je Bild, dreissig Bilder bei zehn je Sekunde.
    const leinwand = document.createElement('canvas');
    leinwand.width = 320;
    leinwand.height = 240;
    const ctx = leinwand.getContext('2d')!;
    const datei = await schreiben.videoSchreiben(
      30,
      (nummer) => {
        const verlauf = ctx.createLinearGradient(0, 0, 320, 0);
        verlauf.addColorStop(0, '#203060');
        verlauf.addColorStop(1, '#604020');
        ctx.fillStyle = verlauf;
        ctx.fillRect(0, 0, 320, 240);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(20 + nummer * 8, 100, 40, 40);
        return leinwand;
      },
      { breite: 320, hoehe: 240, bildrate: 10 },
    );

    const quadratBei = async (blob: Blob, sekunden: number) => {
      const video = document.createElement('video');
      video.muted = true;
      video.src = URL.createObjectURL(blob);
      await new Promise((auf) => {
        video.onloadedmetadata = auf;
      });
      await new Promise<void>((auf) => {
        video.onseeked = () => auf();
        video.currentTime = sekunden;
      });
      const probe = document.createElement('canvas');
      probe.width = video.videoWidth;
      probe.height = video.videoHeight;
      const pctx = probe.getContext('2d', { willReadFrequently: true })!;
      pctx.drawImage(video, 0, 0);
      const d = pctx.getImageData(0, 0, probe.width, probe.height).data;
      let summe = 0;
      let anzahl = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) {
          summe += (i / 4) % probe.width;
          anzahl += 1;
        }
      }
      return anzahl > 0 ? summe / anzahl : -1;
    };

    const leer = docModul.neuesDoc(320, 240);
    const docs = {
      // Nur eine Farbanpassung – der Stromweg, ohne Masken.
      farbe: { ...leer, anpassung: { ...leer.anpassung, belichtung: 0.4 } },
      // Ein Verlauf oben – der Weg, der alle Bilder sammelt.
      bereich: {
        ...leer,
        bereiche: [
          {
            id: 'b1',
            name: 'Himmel',
            aktiv: true,
            anpassung: { ...docModul.BEREICH_NEUTRAL, belichtung: -1 },
            teile: [
              {
                id: 'v1',
                modus: 'dazu' as const,
                umkehren: false,
                art: 'verlauf' as const,
                von: { x: 0, y: 60 },
                bis: { x: 0, y: 0 },
              },
            ],
          },
        ],
      },
    };
    const lagen: Record<string, [number, number]> = {};
    for (const [name, doc] of Object.entries(docs)) {
      const fertig = await bauen.videoAusVideo({
        datei,
        doc,
        stuecke: [{ vonMs: 0, bisMs: 3000 }],
        bildrate: 10,
        kante: 320,
        schluesselAbstand: 4,
        maxBilder: 100,
      });
      lagen[name] = [await quadratBei(fertig.blob, 0.25), await quadratBei(fertig.blob, 2.45)];
    }
    return { uebersprungen: false, quelle: [await quadratBei(datei, 0.25), await quadratBei(datei, 2.45)], lagen };
  });

  if (ergebnis.uebersprungen) {
    test.skip(true, 'Kein Videokodierer in diesem Browser');
    return;
  }
  const [quelleVorn, quelleHinten] = ergebnis.quelle ?? [0, 0];
  // Die Aufnahme selbst: Das Quadrat wandert um gut 170 Punkte.
  expect(quelleHinten - quelleVorn).toBeGreaterThan(150);
  for (const [name, [vorn, hinten]] of Object.entries(ergebnis.lagen ?? {})) {
    expect(vorn, `${name}: vorn nicht gefunden`).toBeGreaterThan(0);
    expect(
      Math.abs(hinten - quelleHinten),
      `${name}: das Quadrat steht bei ${hinten} statt bei ${quelleHinten} – der Film ist eingefroren`,
    ).toBeLessThan(6);
    expect(Math.abs(vorn - quelleVorn), `${name}: vorn verschoben`).toBeLessThan(6);
  }
});
