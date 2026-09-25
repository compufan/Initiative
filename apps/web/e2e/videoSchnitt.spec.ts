import { expect, test, type Page } from '@playwright/test';

/**
 * Schneiden, während man bearbeitet – im echten Browser, über die
 * Oberfläche.
 *
 * Die Bitte war: „eine Zeitleiste wie bei DaVinci, sodass ich beim
 * Bearbeiten schneiden und Abschnitte entsprechend bearbeiten kann". Geprüft
 * wird deshalb der ganze Weg eines Anwenders und nicht nur die Rechnung
 * dahinter: in der Leiste teilen, im Editor NUR den zweiten Abschnitt
 * verändern, den Film bauen – und am fertigen Film nachmessen, dass die
 * Bearbeitung genau ab der Schnittstelle gilt.
 *
 * Das Blatt kommt über `e2e/buehne.ts` in die Seite, ohne Anmeldung und
 * ohne Hochladen – beides hat mit Schneiden nichts zu tun.
 */

const AUSGABE = process.env.SCHNITT_BILDER ?? '';

async function blattMitVideo(page: Page): Promise<boolean> {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  return page.evaluate(async () => {
    const schreibenPfad = '/src/modules/video/schreiben.ts';
    const buehnePfad = '/e2e/buehne.ts';
    const schreiben = (await import(
      /* @vite-ignore */ schreibenPfad
    )) as typeof import('../src/modules/video/schreiben.js');
    if (!(await schreiben.videoTauglich(320, 240)).moeglich) return false;
    // Drei Sekunden in kräftigem Rot, darüber ein wanderndes weisses Quadrat –
    // Farbe misst, ob entsättigt wurde; das Quadrat, dass das Bild läuft.
    const leinwand = document.createElement('canvas');
    leinwand.width = 320;
    leinwand.height = 240;
    const ctx = leinwand.getContext('2d') as CanvasRenderingContext2D;
    const datei = await schreiben.videoSchreiben(
      30,
      (nummer) => {
        ctx.fillStyle = '#d02020';
        ctx.fillRect(0, 0, 320, 240);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(20 + nummer * 8, 100, 40, 40);
        return leinwand;
      },
      { breite: 320, hoehe: 240, bildrate: 10 },
    );
    const buehne = (await import(/* @vite-ignore */ buehnePfad)) as typeof import('./buehne.js');
    const blatt = buehne.videoBlattZeigen(datei);
    (window as unknown as { fertigerFilm: Promise<Blob> }).fertigerFilm = blatt.fertig;
    return true;
  });
}

async function bild(page: Page, name: string) {
  if (AUSGABE) await page.screenshot({ path: `${AUSGABE}/${name}.png` });
}

test('in der Zeitleiste teilen, nur den zweiten Abschnitt bearbeiten, Film bauen', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 412, height: 880 });
  if (!(await blattMitVideo(page))) {
    test.skip(true, 'Kein Videokodierer in diesem Browser');
    return;
  }

  const bearbeiten = page.getByRole('button', { name: /Bearbeiten und schneiden/ });
  await expect(bearbeiten).toBeEnabled({ timeout: 30_000 });
  await bild(page, '1-blatt');

  // Ein Abschnitt über das ganze Video: drei Sekunden.
  await expect(page.locator('.zl-abschnitt')).toHaveCount(1);
  await expect(page.locator('.zl-zeit')).toContainText('0:03,00');

  /*
   * Die Wiedergabestelle auf 1,2 s setzen – mit den Pfeiltasten, bildgenau:
   * Bei 25 Bildern je Sekunde (die Vorgabe) sind das dreimal zehn Bilder.
   * Ein Tipp in die Leiste ginge auch, trifft aber je nach Breite ein paar
   * Millisekunden daneben.
   */
  const leiste = page.getByRole('slider', { name: 'Wiedergabestelle' });
  await leiste.focus();
  await leiste.press('Shift+ArrowRight');
  await leiste.press('Shift+ArrowRight');
  await leiste.press('Shift+ArrowRight');
  await expect(page.locator('.zl-zeit')).toContainText('0:01,20');

  await page.getByRole('button', { name: 'An der Wiedergabestelle teilen' }).click();
  await expect(page.locator('.zl-abschnitt')).toHaveCount(2);
  await bild(page, '2-geteilt');

  /* ---------- Im Editor: nur Abschnitt 2 ---------- */

  await bearbeiten.click();
  const editor = page.locator('.bild-editor');
  await expect(editor).toBeVisible();
  await expect(editor.locator('.bild-kopf strong')).toHaveText('Abschnitt 2 von 2');
  // Die Zeitleiste steht auch im Editor.
  await expect(editor.locator('.bild-zeitleiste .zl-abschnitt')).toHaveCount(2);
  // Das Standbild ist da und nicht von der Wiedergabe verdeckt.
  await expect(editor.locator('.bild-wiedergabe')).toBeHidden({ timeout: 20_000 });
  await bild(page, '3-editor');

  await editor.getByRole('button', { name: /Ton/ }).first().click();
  await editor.getByRole('button', { name: 'Schwarz-Weiss', exact: true }).click();
  await bild(page, '4-schwarzweiss');
  // Abschnitt 2 trägt jetzt eine Bearbeitung, Abschnitt 1 nicht.
  await expect(editor.locator('.zl-abschnitt').nth(1).locator('.zl-nummer')).toContainText('✎');
  await expect(editor.locator('.zl-abschnitt').nth(0).locator('.zl-nummer')).not.toContainText('✎');

  await editor.getByRole('button', { name: 'Fertig', exact: true }).click();
  await expect(editor).toBeHidden();

  /* ---------- Bauen und nachmessen ---------- */

  await page.getByRole('button', { name: 'Film bauen' }).click();
  await expect(page.getByRole('button', { name: 'Übernehmen' })).toBeVisible({ timeout: 120_000 });
  await bild(page, '5-fertig');
  await page.getByRole('button', { name: 'Übernehmen' }).click();

  const farben = await page.evaluate(async () => {
    const blob = await (window as unknown as { fertigerFilm: Promise<Blob> }).fertigerFilm;
    const video = document.createElement('video');
    video.muted = true;
    video.src = URL.createObjectURL(blob);
    await new Promise((auf) => {
      video.onloadedmetadata = auf;
    });
    const probe = document.createElement('canvas');
    probe.width = video.videoWidth;
    probe.height = video.videoHeight;
    const pctx = probe.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
    const bei = async (sekunden: number) => {
      await new Promise<void>((auf) => {
        video.onseeked = () => auf();
        video.currentTime = sekunden;
      });
      pctx.drawImage(video, 0, 0);
      // Unten links: dort ist nie das Quadrat.
      const d = pctx.getImageData(8, probe.height - 12, 1, 1).data;
      return [d[0], d[1], d[2]];
    };
    return {
      dauer: video.duration,
      vorn: await bei(0.35),
      kurzVorher: await bei(1.05),
      kurzNachher: await bei(1.35),
      hinten: await bei(2.8),
    };
  });

  const bunt = ([r, g]: number[]) => r - g > 80;
  const grau = ([r, g, b]: number[]) => Math.abs(r - g) < 25 && Math.abs(g - b) < 25;
  expect(bunt(farben.vorn), `vorn ${farben.vorn}`).toBe(true);
  expect(bunt(farben.kurzVorher), `kurz vor dem Schnitt ${farben.kurzVorher}`).toBe(true);
  expect(grau(farben.kurzNachher), `kurz nach dem Schnitt ${farben.kurzNachher}`).toBe(true);
  expect(grau(farben.hinten), `hinten ${farben.hinten}`).toBe(true);
});

/* ---------- Die Rechnung hinter den Abschnitten ---------- */

/**
 * Ein Film von drei Sekunden bei zehn Bildern je Sekunde: ein weisses
 * Quadrat (40 × 40) wandert je Bild acht Punkte nach rechts über Rot.
 * Bild n: Quadrat bei x = 20 + 8n.
 */
const QUADRAT_FILM = `
  async (schreiben) => {
    const leinwand = document.createElement('canvas');
    leinwand.width = 320;
    leinwand.height = 240;
    const ctx = leinwand.getContext('2d');
    return schreiben.videoSchreiben(
      30,
      (nummer) => {
        ctx.fillStyle = '#d02020';
        ctx.fillRect(0, 0, 320, 240);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(20 + nummer * 8, 100, 40, 40);
        return leinwand;
      },
      { breite: 320, hoehe: 240, bildrate: 10 },
    );
  }
`;

test('eine Tipp-Maske wandert mit dem Gegenstand an ein anderes Stellbild', async ({ page }) => {
  /*
   * So entsteht es beim Teilen: Die Maske gehört zum Stellbild der einen
   * Hälfte, die andere braucht sie an IHREM Bild. Angetippt wird das
   * Quadrat in Bild 0 (x = 20 … 60); mitgenommen an Bild 12 muss der Punkt
   * auf dem Quadrat dort liegen (x = 116 … 156) und die Maske mit ihm.
   */
  test.setTimeout(120_000);
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  const ergebnis = await page.evaluate(async (film) => {
    const pfade = {
      schreiben: '/src/modules/video/schreiben.ts',
      lesen: '/src/modules/video/bilderLesen.ts',
      tipp: '/src/modules/bild/tippMaske.ts',
      verlegen: '/src/modules/video/verlegen.ts',
      doc: '/src/modules/bild/doc.ts',
    };
    const schreiben = (await import(
      /* @vite-ignore */ pfade.schreiben
    )) as typeof import('../src/modules/video/schreiben.js');
    if (!(await schreiben.videoTauglich(320, 240)).moeglich) return null;
    const lesen = (await import(
      /* @vite-ignore */ pfade.lesen
    )) as typeof import('../src/modules/video/bilderLesen.js');
    const tipp = (await import(
      /* @vite-ignore */ pfade.tipp
    )) as typeof import('../src/modules/bild/tippMaske.js');
    const verlegen = (await import(
      /* @vite-ignore */ pfade.verlegen
    )) as typeof import('../src/modules/video/verlegen.js');
    const docModul = (await import(
      /* @vite-ignore */ pfade.doc
    )) as typeof import('../src/modules/bild/doc.js');

    const datei = (await (eval(film) as (s: unknown) => Promise<Blob>)(schreiben)) as Blob;
    const vonMs = 50;
    const nachMs = 1250;
    const erstes = await lesen.videoBilderLesen(datei, { zeitpunkte: [vonMs], kante: 320 });
    const teil = await tipp.tippTeilRechnen(erstes.bilder[0].daten, [{ x: 40, y: 120 }], {
      modus: 'dazu',
      mitNetz: false,
      toleranz: 32,
      id: 't1',
    });
    if (!teil) return { fehler: 'kein Tipp' };
    const doc = {
      ...docModul.neuesDoc(320, 240),
      bereiche: [
        {
          id: 'b1',
          name: 'Quadrat',
          aktiv: true,
          teile: [teil],
          anpassung: { ...docModul.BEREICH_NEUTRAL, belichtung: -1 },
        },
      ],
    };
    const neu = await verlegen.teileVerlegen(datei, doc, {
      vonMs,
      nachMs,
      kante: 320,
      schrittMs: 100,
    });
    const neuTeil = neu.bereiche[0].teile[0];
    if (neuTeil.art !== 'tipp') return { fehler: 'kein Tipp mehr' };
    let summe = 0;
    let sx = 0;
    for (let i = 0; i < neuTeil.alpha.length; i += 1) {
      if (neuTeil.alpha[i] >= 128) {
        summe += 1;
        sx += i % neuTeil.breite;
      }
    }
    return {
      punkte: neuTeil.punkte,
      mitte: summe > 0 ? sx / summe : -1,
      flaeche: summe,
      marke: [teil.art === 'tipp' ? teil.marke : -1, neuTeil.marke],
    };
  }, QUADRAT_FILM);

  if (ergebnis === null) {
    test.skip(true, 'Kein Videokodierer in diesem Browser');
    return;
  }
  expect(ergebnis).not.toHaveProperty('fehler');
  const { punkte, mitte, flaeche, marke } = ergebnis as {
    punkte: { x: number; y: number }[];
    mitte: number;
    flaeche: number;
    marke: number[];
  };
  // Bild 12: das Quadrat liegt bei x = 116 … 156, Mitte 136.
  expect(punkte[0].x).toBeGreaterThanOrEqual(116);
  expect(punkte[0].x).toBeLessThanOrEqual(156);
  expect(Math.abs(mitte - 136), `Mitte ${mitte}`).toBeLessThan(4);
  expect(flaeche).toBeGreaterThan(1200);
  expect(flaeche).toBeLessThan(2000);
  // Eine neue Marke – sonst hielte der Zwischenspeicher des Editors die alte Maske.
  expect(marke[1]).not.toBe(marke[0]);
});

test('ein Abschnitt mit Stellbild in der Mitte: die Maske gilt davor und danach', async ({
  page,
}) => {
  /*
   * Eingestellt an Bild 15 (x = 140 … 180), abgedunkelt wird das Quadrat.
   * Die Verfolgung läuft von dort RÜCKWÄRTS zum Anfang und vorwärts zum
   * Ende; gemessen wird die Helligkeit des Quadrats in beiden Richtungen.
   */
  test.setTimeout(180_000);
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  const ergebnis = await page.evaluate(async (film) => {
    const pfade = {
      schreiben: '/src/modules/video/schreiben.ts',
      lesen: '/src/modules/video/bilderLesen.ts',
      tipp: '/src/modules/bild/tippMaske.ts',
      bauen: '/src/modules/video/videoBauen.ts',
      doc: '/src/modules/bild/doc.ts',
    };
    const schreiben = (await import(
      /* @vite-ignore */ pfade.schreiben
    )) as typeof import('../src/modules/video/schreiben.js');
    if (!(await schreiben.videoTauglich(320, 240)).moeglich) return null;
    const lesen = (await import(
      /* @vite-ignore */ pfade.lesen
    )) as typeof import('../src/modules/video/bilderLesen.js');
    const tipp = (await import(
      /* @vite-ignore */ pfade.tipp
    )) as typeof import('../src/modules/bild/tippMaske.js');
    const bauen = (await import(
      /* @vite-ignore */ pfade.bauen
    )) as typeof import('../src/modules/video/videoBauen.js');
    const docModul = (await import(
      /* @vite-ignore */ pfade.doc
    )) as typeof import('../src/modules/bild/doc.js');

    const datei = (await (eval(film) as (s: unknown) => Promise<Blob>)(schreiben)) as Blob;
    const standMs = 1550;
    const stand = await lesen.videoBilderLesen(datei, { zeitpunkte: [standMs], kante: 320 });
    const teil = await tipp.tippTeilRechnen(stand.bilder[0].daten, [{ x: 160, y: 120 }], {
      modus: 'dazu',
      mitNetz: false,
      toleranz: 32,
      id: 't1',
    });
    if (!teil) return { fehler: 'kein Tipp' };
    const doc = {
      ...docModul.neuesDoc(320, 240),
      bereiche: [
        {
          id: 'b1',
          name: 'Quadrat',
          aktiv: true,
          teile: [teil],
          anpassung: { ...docModul.BEREICH_NEUTRAL, belichtung: -2 },
        },
      ],
    };
    const fertig = await bauen.videoAusVideo({
      datei,
      stuecke: [{ vonMs: 0, bisMs: 3000, doc, standMs }],
      bildrate: 10,
      kante: 320,
      schluesselAbstand: 4,
      maxBilder: 100,
    });

    const video = document.createElement('video');
    video.muted = true;
    video.src = URL.createObjectURL(fertig.blob);
    await new Promise((auf) => {
      video.onloadedmetadata = auf;
    });
    const probe = document.createElement('canvas');
    probe.width = video.videoWidth;
    probe.height = video.videoHeight;
    const pctx = probe.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
    /** Die Helligkeit in der Mitte des Quadrats von Bild `n`. */
    const quadrat = async (n: number) => {
      await new Promise<void>((auf) => {
        video.onseeked = () => auf();
        video.currentTime = (n + 0.5) / 10;
      });
      pctx.drawImage(video, 0, 0);
      const d = pctx.getImageData(40 + n * 8, 120, 1, 1).data;
      return (d[0] + d[1] + d[2]) / 3;
    };
    return {
      anfang: await quadrat(1),
      stand: await quadrat(15),
      ende: await quadrat(28),
    };
  }, QUADRAT_FILM);

  if (ergebnis === null) {
    test.skip(true, 'Kein Videokodierer in diesem Browser');
    return;
  }
  expect(ergebnis).not.toHaveProperty('fehler');
  const { anfang, stand, ende } = ergebnis as { anfang: number; stand: number; ende: number };
  // Unbearbeitet wäre das Quadrat weiss (255); abgedunkelt deutlich darunter.
  expect(stand, 'am Stellbild').toBeLessThan(140);
  expect(anfang, 'rückwärts bis zum Anfang').toBeLessThan(140);
  expect(ende, 'vorwärts bis zum Ende').toBeLessThan(140);
});

test('verschieden zugeschnittene Abschnitte werden in EINE Filmgrösse eingepasst', async ({
  page,
}) => {
  /*
   * Abschnitt 1 hochkant zugeschnitten (160 × 240), Abschnitt 2 nicht
   * (320 × 240). Der Film nimmt die Grösse des ersten; der zweite wird ganz
   * eingepasst, mit schwarzem Rand oben und unten – abgeschnitten wäre ein
   * Teil dessen, was jemand mit Absicht im Bild gelassen hat.
   */
  test.setTimeout(120_000);
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  const ergebnis = await page.evaluate(async (film) => {
    const pfade = {
      schreiben: '/src/modules/video/schreiben.ts',
      bauen: '/src/modules/video/videoBauen.ts',
      doc: '/src/modules/bild/doc.ts',
    };
    const schreiben = (await import(
      /* @vite-ignore */ pfade.schreiben
    )) as typeof import('../src/modules/video/schreiben.js');
    if (!(await schreiben.videoTauglich(320, 240)).moeglich) return null;
    const bauen = (await import(
      /* @vite-ignore */ pfade.bauen
    )) as typeof import('../src/modules/video/videoBauen.js');
    const docModul = (await import(
      /* @vite-ignore */ pfade.doc
    )) as typeof import('../src/modules/bild/doc.js');
    const datei = (await (eval(film) as (s: unknown) => Promise<Blob>)(schreiben)) as Blob;
    const hochkant = { ...docModul.neuesDoc(320, 240), zuschnitt: { x: 0, y: 0, w: 160, h: 240 } };
    const fertig = await bauen.videoAusVideo({
      datei,
      stuecke: [
        { vonMs: 0, bisMs: 1000, doc: hochkant, standMs: 50 },
        { vonMs: 1000, bisMs: 2000, doc: null, standMs: 1050 },
      ],
      bildrate: 10,
      kante: 320,
      schluesselAbstand: 4,
      maxBilder: 100,
    });
    const video = document.createElement('video');
    video.muted = true;
    video.src = URL.createObjectURL(fertig.blob);
    await new Promise((auf) => {
      video.onloadedmetadata = auf;
    });
    const probe = document.createElement('canvas');
    probe.width = video.videoWidth;
    probe.height = video.videoHeight;
    const pctx = probe.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
    const punkt = async (sekunden: number, x: number, y: number) => {
      await new Promise<void>((auf) => {
        video.onseeked = () => auf();
        video.currentTime = sekunden;
      });
      pctx.drawImage(video, 0, 0);
      return Array.from(pctx.getImageData(x, y, 1, 1).data.slice(0, 3));
    };
    return {
      breite: fertig.breite,
      hoehe: fertig.hoehe,
      vornOben: await punkt(0.35, 80, 20),
      hintenOben: await punkt(1.55, 80, 20),
      hintenMitte: await punkt(1.55, 5, 120),
    };
  }, QUADRAT_FILM);

  if (ergebnis === null) {
    test.skip(true, 'Kein Videokodierer in diesem Browser');
    return;
  }
  const e = ergebnis as {
    breite: number;
    hoehe: number;
    vornOben: number[];
    hintenOben: number[];
    hintenMitte: number[];
  };
  expect([e.breite, e.hoehe]).toEqual([160, 240]);
  const rot = ([r, g]: number[]) => r > 150 && g < 90;
  const schwarz = (farbe: number[]) => farbe.every((wert) => wert < 30);
  expect(rot(e.vornOben), `vorn oben ${e.vornOben}`).toBe(true);
  expect(schwarz(e.hintenOben), `hinten oben ${e.hintenOben}`).toBe(true);
  expect(rot(e.hintenMitte), `hinten Mitte ${e.hintenMitte}`).toBe(true);
});

/* ---------- Die Zeitleiste im Editor ---------- */

test('im Editor schneiden: Abschnitt wählen, Stellbild verschieben, abspielen, kürzen', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 412, height: 880 });
  if (!(await blattMitVideo(page))) {
    test.skip(true, 'Kein Videokodierer in diesem Browser');
    return;
  }
  const bearbeiten = page.getByRole('button', { name: /Bearbeiten und schneiden/ });
  await expect(bearbeiten).toBeEnabled({ timeout: 30_000 });
  await bearbeiten.click();

  const editor = page.locator('.bild-editor');
  const leiste = editor.getByRole('slider', { name: 'Wiedergabestelle' });
  const zeit = editor.locator('.zl-zeit');
  const titel = editor.locator('.bild-kopf strong');
  const wiedergabe = editor.locator('.bild-wiedergabe');
  await expect(titel).toHaveText('Video bearbeiten');
  await expect(wiedergabe).toBeHidden({ timeout: 20_000 });

  /*
   * Ohne Masken wandert das Stellbild mit der Wiedergabestelle: Der Keil in
   * der Leiste steht danach dort, wo man losgelassen hat.
   */
  const keil = editor.locator('.zl-stellbild');
  const keilVorher = await keil.evaluate((el) => (el as HTMLElement).style.left);
  await leiste.focus();
  await leiste.press('Shift+ArrowRight');
  await leiste.press('Shift+ArrowRight');
  await expect(zeit).toContainText('0:00,82');
  await expect(async () => {
    const jetzt = await keil.evaluate((el) => (el as HTMLElement).style.left);
    expect(jetzt).not.toBe(keilVorher);
  }).toPass({ timeout: 10_000 });
  await expect(wiedergabe).toBeHidden({ timeout: 20_000 });

  // Teilen im Editor: Die Hälfte hinter der Stelle ist danach gewählt.
  await leiste.press('Shift+ArrowRight');
  await editor.getByRole('button', { name: 'An der Wiedergabestelle teilen' }).click();
  await expect(editor.locator('.zl-abschnitt')).toHaveCount(2);
  await expect(titel).toHaveText('Abschnitt 2 von 2');
  await expect(wiedergabe).toBeHidden({ timeout: 20_000 });

  // Ein Tipp in den ersten Abschnitt wählt ihn.
  const bahn = editor.locator('.zl-bahn');
  const kasten = await bahn.boundingBox();
  if (!kasten) throw new Error('keine Leiste');
  await page.mouse.click(kasten.x + 12, kasten.y + kasten.height / 2);
  await expect(titel).toHaveText('Abschnitt 1 von 2');
  await expect(wiedergabe).toBeHidden({ timeout: 20_000 });

  // Abspielen: Das Video liegt über dem Standbild, mit dem Hinweis dazu.
  await editor.getByRole('button', { name: 'Abspielen' }).click();
  await expect(wiedergabe).toBeVisible();
  await expect(wiedergabe).toContainText('Wiedergabe ohne Bearbeitung');
  await page.waitForTimeout(700);
  await editor.getByRole('button', { name: 'Anhalten' }).click();
  await expect(wiedergabe).toBeHidden({ timeout: 20_000 });
  await bild(page, '6-nach-wiedergabe');

  // Kürzen mit der Tastatur: das Ende des gewählten Abschnitts fünf Bilder früher.
  const gesamtVorher = await zeit.textContent();
  expect(gesamtVorher).toContain('/ 0:03,00');
  const ende = editor.getByRole('button', { name: 'Ende des Abschnitts' });
  await ende.focus();
  for (let i = 0; i < 5; i += 1) await ende.press('ArrowLeft');
  await expect(zeit).toContainText('/ 0:02,80');

  // Verschieben, Entfernen, Hinzufügen.
  const nummer = titel;
  await editor.getByRole('button', { name: /nach hinten/ }).click();
  await expect(nummer).toHaveText('Abschnitt 2 von 2');
  await editor.getByRole('button', { name: /entfernen/ }).click();
  await expect(editor.locator('.zl-abschnitt')).toHaveCount(1);
  await editor.getByRole('button', { name: 'Abschnitt hinzufügen' }).click();
  await expect(editor.locator('.zl-abschnitt')).toHaveCount(2);
  await expect(wiedergabe).toBeHidden({ timeout: 20_000 });
  await bild(page, '7-hinzugefuegt');
});

test('eine angetippte Maske im Editor an ein anderes Bild mitnehmen', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 412, height: 880 });
  if (!(await blattMitVideo(page))) {
    test.skip(true, 'Kein Videokodierer in diesem Browser');
    return;
  }
  const bearbeiten = page.getByRole('button', { name: /Bearbeiten und schneiden/ });
  await expect(bearbeiten).toBeEnabled({ timeout: 30_000 });
  await bearbeiten.click();
  const editor = page.locator('.bild-editor');
  const wiedergabe = editor.locator('.bild-wiedergabe');
  await expect(wiedergabe).toBeHidden({ timeout: 20_000 });

  // Bild 0 bei 25 je Sekunde, Quelle 10 je Sekunde: das Quadrat bei x = 20 … 60.
  await editor
    .locator('.bild-reiter')
    .getByRole('button', { name: /Bereiche/ })
    .click();
  await editor.getByRole('button', { name: /Antippen aus/ }).click();
  const leinwand = editor.locator('.bild-leinwand');
  const kasten = await leinwand.boundingBox();
  if (!kasten) throw new Error('keine Leinwand');
  await page.mouse.click(
    kasten.x + (40 / 320) * kasten.width,
    kasten.y + (120 / 240) * kasten.height,
  );
  await expect(editor.getByRole('group', { name: 'Bereiche' }).getByRole('button')).not.toHaveCount(
    1,
    { timeout: 20_000 },
  );
  await bild(page, '8-angetippt');

  // Die Wiedergabestelle weiter – das Stellbild bleibt, und die Frage kommt.
  const leiste = editor.getByRole('slider', { name: 'Wiedergabestelle' });
  await leiste.focus();
  for (let i = 0; i < 3; i += 1) await leiste.press('Shift+ArrowRight');
  await expect(wiedergabe).toBeVisible();
  const mitnehmen = editor.getByRole('button', { name: 'Masken hierher mitnehmen' });
  await expect(mitnehmen).toBeVisible();
  await bild(page, '9-frage');
  await mitnehmen.click();
  // Rechnen, neues Standbild, und der Editor steht wieder – mit dem Bereich.
  await expect(wiedergabe).toBeHidden({ timeout: 60_000 });
  await editor
    .locator('.bild-reiter')
    .getByRole('button', { name: /Bereiche/ })
    .click();
  await expect(editor.getByRole('group', { name: 'Bereiche' }).getByRole('button')).not.toHaveCount(
    1,
  );
  await bild(page, '10-mitgenommen');
});

/* ---------- Nach der Gegenlesung ---------- */

test('Rückgängig holt keine Maske eines anderen Stellbildes zurück', async ({ page }) => {
  /*
   * Nachgestellt: Tipp auf das Quadrat, ↺, Stellbild verschieben, ↻ – und
   * die Maske des alten Bildes galt für das neue. Nach dem Wechsel des
   * Bildes darf ↻ nichts mehr wiederherstellen, das zu einem Bild gehört.
   */
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 412, height: 880 });
  if (!(await blattMitVideo(page))) {
    test.skip(true, 'Kein Videokodierer in diesem Browser');
    return;
  }
  await page.getByRole('button', { name: /Bearbeiten und schneiden/ }).click();
  const editor = page.locator('.bild-editor');
  const wiedergabe = editor.locator('.bild-wiedergabe');
  await expect(wiedergabe).toBeHidden({ timeout: 20_000 });
  await editor
    .locator('.bild-reiter')
    .getByRole('button', { name: /Bereiche/ })
    .click();
  await editor.getByRole('button', { name: /Antippen aus/ }).click();
  const kasten = await editor.locator('.bild-leinwand').boundingBox();
  if (!kasten) throw new Error('keine Leinwand');
  await page.mouse.click(kasten.x + (40 / 320) * kasten.width, kasten.y + kasten.height / 2);
  const zurueck = editor.getByRole('button', { name: 'Rückgängig' });
  await expect(zurueck).toBeEnabled({ timeout: 20_000 });
  await zurueck.click();
  const wieder = editor.getByRole('button', { name: 'Wiederherstellen' });
  await expect(wieder).toBeEnabled();

  // Ohne Maske wandert das Stellbild mit der Wiedergabestelle.
  const leiste = editor.getByRole('slider', { name: 'Wiedergabestelle' });
  await leiste.focus();
  for (let i = 0; i < 3; i += 1) await leiste.press('Shift+ArrowRight');
  await expect(wiedergabe).toBeHidden({ timeout: 20_000 });
  await expect(wieder).toBeDisabled();
});

test('Kürzen während der Wiedergabe hält sie an, statt hängenzubleiben', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 412, height: 880 });
  if (!(await blattMitVideo(page))) {
    test.skip(true, 'Kein Videokodierer in diesem Browser');
    return;
  }
  await page.getByRole('button', { name: /Bearbeiten und schneiden/ }).click();
  const editor = page.locator('.bild-editor');
  const wiedergabe = editor.locator('.bild-wiedergabe');
  await expect(wiedergabe).toBeHidden({ timeout: 20_000 });
  await editor.getByRole('button', { name: 'Abspielen' }).click();
  await expect(editor.getByRole('button', { name: 'Anhalten' })).toBeVisible();
  // Das Ende des Abschnitts mit dem Finger nach rechts ziehen – vorher hielt
  // die Wiedergabe die gezogene Kante für das Ende und blieb stecken.
  const griff = await editor.getByRole('button', { name: 'Ende des Abschnitts' }).boundingBox();
  if (!griff) throw new Error('kein Griff');
  await page.mouse.move(griff.x + griff.width / 2, griff.y + griff.height / 2);
  await page.mouse.down();
  await page.mouse.move(griff.x + griff.width / 2 + 40, griff.y + griff.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(editor.getByRole('button', { name: 'Abspielen' })).toBeVisible();
  await expect(wiedergabe).toBeHidden({ timeout: 20_000 });
});

test('Pfeiltasten tragen über eine Abschnittsgrenze – der Fokus bleibt', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 412, height: 880 });
  if (!(await blattMitVideo(page))) {
    test.skip(true, 'Kein Videokodierer in diesem Browser');
    return;
  }
  const blattLeiste = page.getByRole('slider', { name: 'Wiedergabestelle' });
  await expect(page.getByRole('button', { name: /Bearbeiten und schneiden/ })).toBeEnabled({
    timeout: 30_000,
  });
  await blattLeiste.focus();
  for (let i = 0; i < 3; i += 1) await blattLeiste.press('Shift+ArrowRight');
  await page.getByRole('button', { name: 'An der Wiedergabestelle teilen' }).click();
  await page.getByRole('button', { name: /Bearbeiten und schneiden/ }).click();
  const editor = page.locator('.bild-editor');
  await expect(editor.locator('.bild-wiedergabe')).toBeHidden({ timeout: 20_000 });
  const titel = editor.locator('.bild-kopf strong');
  await expect(titel).toHaveText('Abschnitt 2 von 2');
  const leiste = editor.getByRole('slider', { name: 'Wiedergabestelle' });
  await leiste.focus();
  // Zurück über die Grenze bei 1,2 s in den ersten Abschnitt …
  for (let i = 0; i < 3; i += 1) await leiste.press('ArrowLeft');
  await expect(titel).toHaveText('Abschnitt 1 von 2');
  // … und der Regler hat den Fokus noch: Weitere Pfeile wirken.
  await expect(leiste).toBeFocused();
  for (let i = 0; i < 3; i += 1) await leiste.press('ArrowRight');
  await expect(titel).toHaveText('Abschnitt 2 von 2');
});

test('ein Verlauf bleibt beim Verschieben der Wiedergabe an seinem Bild', async ({ page }) => {
  /*
   * Ein Verlauf steht in Punkten des Stellbildes. Vorher rückte das
   * Stellbild einfach mit, und der Verlauf galt danach als an einem anderen
   * Bild gezeichnet. Jetzt kommt dieselbe Frage wie bei einer Maske.
   */
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 412, height: 880 });
  if (!(await blattMitVideo(page))) {
    test.skip(true, 'Kein Videokodierer in diesem Browser');
    return;
  }
  await page.getByRole('button', { name: /Bearbeiten und schneiden/ }).click();
  const editor = page.locator('.bild-editor');
  const wiedergabe = editor.locator('.bild-wiedergabe');
  await expect(wiedergabe).toBeHidden({ timeout: 20_000 });
  await editor
    .locator('.bild-reiter')
    .getByRole('button', { name: /Bereiche/ })
    .click();
  await editor
    .getByRole('button', { name: /Verlauf/ })
    .first()
    .click();
  const leiste = editor.getByRole('slider', { name: 'Wiedergabestelle' });
  await leiste.focus();
  for (let i = 0; i < 3; i += 1) await leiste.press('Shift+ArrowRight');
  const mitnehmen = editor.getByRole('button', { name: 'Masken hierher mitnehmen' });
  await expect(mitnehmen).toBeVisible();
  await mitnehmen.click();
  await expect(wiedergabe).toBeHidden({ timeout: 60_000 });
});

test('Formen wandern beim Mitnehmen mit der Kamera', async ({ page }) => {
  /*
   * Ein Schwenk: Der Grund wandert je Bild vier Punkte nach links. Eine
   * Ellipse, gezeichnet an Bild 0 bei x = 160, gehört an Bild 12 dorthin,
   * wohin der Grund unter ihr gewandert ist: x = 112.
   */
  test.setTimeout(120_000);
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  const ergebnis = await page.evaluate(async () => {
    const pfade = {
      schreiben: '/src/modules/video/schreiben.ts',
      verlegen: '/src/modules/video/verlegen.ts',
      doc: '/src/modules/bild/doc.ts',
    };
    const schreiben = (await import(
      /* @vite-ignore */ pfade.schreiben
    )) as typeof import('../src/modules/video/schreiben.js');
    if (!(await schreiben.videoTauglich(320, 240)).moeglich) return null;
    const verlegen = (await import(
      /* @vite-ignore */ pfade.verlegen
    )) as typeof import('../src/modules/video/verlegen.js');
    const docModul = (await import(
      /* @vite-ignore */ pfade.doc
    )) as typeof import('../src/modules/bild/doc.js');
    // Ein gemusterter Grund, doppelt so breit wie das Bild, festgelegt gewürfelt.
    const grund = document.createElement('canvas');
    grund.width = 640;
    grund.height = 240;
    const g = grund.getContext('2d') as CanvasRenderingContext2D;
    let saat = 7;
    const zufall = () => {
      saat = (saat * 16807) % 2147483647;
      return saat / 2147483647;
    };
    g.fillStyle = '#806040';
    g.fillRect(0, 0, 640, 240);
    for (let i = 0; i < 900; i += 1) {
      const hell = Math.round(40 + zufall() * 200);
      g.fillStyle = `rgb(${hell},${Math.round(hell * 0.8)},${Math.round(255 - hell * 0.7)})`;
      g.fillRect(zufall() * 640, zufall() * 240, 4 + zufall() * 18, 4 + zufall() * 18);
    }
    const leinwand = document.createElement('canvas');
    leinwand.width = 320;
    leinwand.height = 240;
    const ctx = leinwand.getContext('2d') as CanvasRenderingContext2D;
    const datei = await schreiben.videoSchreiben(
      30,
      (nummer) => {
        ctx.drawImage(grund, -4 * nummer, 0);
        return leinwand;
      },
      { breite: 320, hoehe: 240, bildrate: 10 },
    );
    const doc = {
      ...docModul.neuesDoc(320, 240),
      bereiche: [
        {
          id: 'b1',
          name: 'Ellipse',
          aktiv: true,
          teile: [
            {
              id: 'r1',
              modus: 'dazu' as const,
              umkehren: false,
              art: 'radial' as const,
              mitte: { x: 160, y: 120 },
              rx: 40,
              ry: 30,
              winkel: 0,
              weichheit: 0.3,
            },
          ],
          anpassung: { ...docModul.BEREICH_NEUTRAL, belichtung: -1 },
        },
      ],
    };
    const neu = await verlegen.teileVerlegen(datei, doc, {
      vonMs: 50,
      nachMs: 1250,
      kante: 320,
      schrittMs: 100,
    });
    const teil = neu.bereiche[0].teile[0];
    return teil.art === 'radial' ? teil.mitte : null;
  });
  if (ergebnis === null) {
    test.skip(true, 'Kein Videokodierer in diesem Browser');
    return;
  }
  expect(Math.abs(ergebnis.x - 112), `x ${ergebnis.x}`).toBeLessThan(3);
  expect(Math.abs(ergebnis.y - 120), `y ${ergebnis.y}`).toBeLessThan(3);
});

test('ein abgeschnittenes Stellbild: die Maske wird vorher an den Film geholt', async ({
  page,
}) => {
  /*
   * Die Obergrenze lässt nur die erste Sekunde übrig, das Stellbild liegt
   * bei 2,55 s. Vorher galt die Maske dann einfach am letzten Bild – mit
   * Punkten, die anderthalb Sekunden später gesetzt wurden, also auf dem
   * Hintergrund. Jetzt wird sie vorher dorthin mitgenommen.
   */
  test.setTimeout(180_000);
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  const ergebnis = await page.evaluate(async (film) => {
    const pfade = {
      schreiben: '/src/modules/video/schreiben.ts',
      lesen: '/src/modules/video/bilderLesen.ts',
      tipp: '/src/modules/bild/tippMaske.ts',
      bauen: '/src/modules/video/videoBauen.ts',
      doc: '/src/modules/bild/doc.ts',
    };
    const schreiben = (await import(
      /* @vite-ignore */ pfade.schreiben
    )) as typeof import('../src/modules/video/schreiben.js');
    if (!(await schreiben.videoTauglich(320, 240)).moeglich) return null;
    const lesen = (await import(
      /* @vite-ignore */ pfade.lesen
    )) as typeof import('../src/modules/video/bilderLesen.js');
    const tipp = (await import(
      /* @vite-ignore */ pfade.tipp
    )) as typeof import('../src/modules/bild/tippMaske.js');
    const bauen = (await import(
      /* @vite-ignore */ pfade.bauen
    )) as typeof import('../src/modules/video/videoBauen.js');
    const docModul = (await import(
      /* @vite-ignore */ pfade.doc
    )) as typeof import('../src/modules/bild/doc.js');
    const datei = (await (eval(film) as (s: unknown) => Promise<Blob>)(schreiben)) as Blob;
    const standMs = 2550;
    const stand = await lesen.videoBilderLesen(datei, { zeitpunkte: [standMs], kante: 320 });
    // Bild 25: das Quadrat bei x = 220 … 260.
    const teil = await tipp.tippTeilRechnen(stand.bilder[0].daten, [{ x: 240, y: 120 }], {
      modus: 'dazu',
      mitNetz: false,
      toleranz: 32,
      id: 't1',
    });
    if (!teil) return { fehler: 'kein Tipp' };
    const doc = {
      ...docModul.neuesDoc(320, 240),
      bereiche: [
        {
          id: 'b1',
          name: 'Quadrat',
          aktiv: true,
          teile: [teil],
          anpassung: { ...docModul.BEREICH_NEUTRAL, belichtung: -2 },
        },
      ],
    };
    const fertig = await bauen.videoAusVideo({
      datei,
      stuecke: [{ vonMs: 0, bisMs: 3000, doc, standMs }],
      bildrate: 10,
      kante: 320,
      schluesselAbstand: 4,
      maxBilder: 10,
    });
    const video = document.createElement('video');
    video.muted = true;
    video.src = URL.createObjectURL(fertig.blob);
    await new Promise((auf) => {
      video.onloadedmetadata = auf;
    });
    const probe = document.createElement('canvas');
    probe.width = video.videoWidth;
    probe.height = video.videoHeight;
    const pctx = probe.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
    const quadrat = async (n: number) => {
      await new Promise<void>((auf) => {
        video.onseeked = () => auf();
        video.currentTime = (n + 0.5) / 10;
      });
      pctx.drawImage(video, 0, 0);
      const mitte = pctx.getImageData(40 + n * 8, 120, 1, 1).data;
      const grund = pctx.getImageData(300, 20, 1, 1).data;
      return { quadrat: (mitte[0] + mitte[1] + mitte[2]) / 3, grundRot: grund[0] };
    };
    return { bilder: fertig.bilder, zwei: await quadrat(2), acht: await quadrat(8) };
  }, QUADRAT_FILM);
  if (ergebnis === null) {
    test.skip(true, 'Kein Videokodierer in diesem Browser');
    return;
  }
  expect(ergebnis).not.toHaveProperty('fehler');
  const e = ergebnis as {
    bilder: number;
    zwei: { quadrat: number; grundRot: number };
    acht: { quadrat: number; grundRot: number };
  };
  expect(e.bilder).toBe(10);
  expect(e.zwei.quadrat, 'Quadrat in Bild 2 abgedunkelt').toBeLessThan(140);
  expect(e.acht.quadrat, 'Quadrat in Bild 8 abgedunkelt').toBeLessThan(140);
  // Und der rote Grund bleibt, wie er ist – kein Fluten des Hintergrunds.
  expect(e.zwei.grundRot).toBeGreaterThan(150);
});

test('eine Maske in EINEM Abschnitt kürzt nicht den ganzen Film', async ({ page }) => {
  /*
   * Drei Abschnitte, nur der mittlere trägt einen Tipp auf dem Quadrat. Die
   * Speichergrenze (hier 10 Bilder) gilt nur für ihn: Früher sammelte ein
   * einziger Abschnitt mit Maske ALLE Bilder, die Grenze galt für den
   * ganzen Film, und der dritte Abschnitt fiel weg.
   */
  test.setTimeout(180_000);
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  const ergebnis = await page.evaluate(async (film) => {
    const pfade = {
      schreiben: '/src/modules/video/schreiben.ts',
      lesen: '/src/modules/video/bilderLesen.ts',
      tipp: '/src/modules/bild/tippMaske.ts',
      bauen: '/src/modules/video/videoBauen.ts',
      doc: '/src/modules/bild/doc.ts',
    };
    const schreiben = (await import(
      /* @vite-ignore */ pfade.schreiben
    )) as typeof import('../src/modules/video/schreiben.js');
    if (!(await schreiben.videoTauglich(320, 240)).moeglich) return null;
    const lesen = (await import(
      /* @vite-ignore */ pfade.lesen
    )) as typeof import('../src/modules/video/bilderLesen.js');
    const tipp = (await import(
      /* @vite-ignore */ pfade.tipp
    )) as typeof import('../src/modules/bild/tippMaske.js');
    const bauen = (await import(
      /* @vite-ignore */ pfade.bauen
    )) as typeof import('../src/modules/video/videoBauen.js');
    const docModul = (await import(
      /* @vite-ignore */ pfade.doc
    )) as typeof import('../src/modules/bild/doc.js');

    const datei = (await (eval(film) as (s: unknown) => Promise<Blob>)(schreiben)) as Blob;
    // Bild 15 (x = 140 … 180) ist das Stellbild des mittleren Abschnitts.
    const standMs = 1550;
    const stand = await lesen.videoBilderLesen(datei, { zeitpunkte: [standMs], kante: 320 });
    const teil = await tipp.tippTeilRechnen(stand.bilder[0].daten, [{ x: 160, y: 120 }], {
      modus: 'dazu',
      mitNetz: false,
      toleranz: 32,
      id: 't1',
    });
    if (!teil) return { fehler: 'kein Tipp' };
    const doc = {
      ...docModul.neuesDoc(320, 240),
      bereiche: [
        {
          id: 'b1',
          name: 'Quadrat',
          aktiv: true,
          teile: [teil],
          anpassung: { ...docModul.BEREICH_NEUTRAL, belichtung: -2 },
        },
      ],
    };
    const auftrag = {
      datei,
      stuecke: [
        { vonMs: 0, bisMs: 1000, doc: null, standMs: 50 },
        { vonMs: 1000, bisMs: 2000, doc, standMs },
        { vonMs: 2000, bisMs: 3000, doc: null, standMs: 2050 },
      ],
      bildrate: 10,
      kante: 320,
      schluesselAbstand: 4,
      maxBilder: 600,
    };
    const ganz = await bauen.videoAusVideo({ ...auftrag, maxGepuffert: 10 });
    const knapp = await bauen.videoAusVideo({ ...auftrag, maxGepuffert: 6 });

    const video = document.createElement('video');
    video.muted = true;
    video.src = URL.createObjectURL(ganz.blob);
    await new Promise((auf) => {
      video.onloadedmetadata = auf;
    });
    const probe = document.createElement('canvas');
    probe.width = video.videoWidth;
    probe.height = video.videoHeight;
    const pctx = probe.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
    /** Die Helligkeit in der Mitte des Quadrats von Bild `n`. */
    const quadrat = async (n: number) => {
      await new Promise<void>((auf) => {
        video.onseeked = () => auf();
        video.currentTime = (n + 0.5) / 10;
      });
      pctx.drawImage(video, 0, 0);
      const d = pctx.getImageData(40 + n * 8, 120, 1, 1).data;
      return (d[0] + d[1] + d[2]) / 3;
    };
    return {
      ganz: ganz.bilder,
      knapp: knapp.bilder,
      vorn: await quadrat(5),
      mitte: await quadrat(12),
      stand: await quadrat(15),
      hinten: await quadrat(25),
    };
  }, QUADRAT_FILM);

  if (ergebnis === null) {
    test.skip(true, 'Kein Videokodierer in diesem Browser');
    return;
  }
  expect(ergebnis).not.toHaveProperty('fehler');
  const e = ergebnis as Record<'ganz' | 'knapp' | 'vorn' | 'mitte' | 'stand' | 'hinten', number>;
  // Alle dreissig Bilder – der dritte Abschnitt ist dabei.
  expect(e.ganz).toBe(30);
  // Ist die Gruppe zu lang, endet der Film an ihrer Grenze: 10 + 6 Bilder.
  expect(e.knapp).toBe(16);
  // Die Maske gilt im mittleren Abschnitt – und nur dort.
  expect(e.mitte, 'mittlerer Abschnitt, vor dem Stellbild').toBeLessThan(140);
  expect(e.stand, 'am Stellbild').toBeLessThan(140);
  expect(e.vorn, 'erster Abschnitt').toBeGreaterThan(200);
  expect(e.hinten, 'dritter Abschnitt').toBeGreaterThan(200);
});
