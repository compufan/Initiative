import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * „Weichzeichnen“ und „Bokeh“ als Regler – im Foto- wie im Videoeditor.
 *
 * Die Bitte war: Weichzeichnen gewöhnlich und sauber an der Maske begrenzt,
 * dazu Bokeh als zweiter Regler. Die Rechnung dahinter hält `bereich.spec.ts`
 * fest; hier wird geprüft, was ein Anwender sieht und bedient:
 *
 * - beide Regler stehen im Bereichspanel, mit einem Tooltip, der sagt, was sie
 *   tun und dass die Wirkung an der Maske endet;
 * - ein Zug ändert das Bild, ein Doppelklick setzt auf 0 und das Bild kehrt
 *   zurück, Byte für Byte;
 * - Rückgängig nimmt die Regler eines Bereichs einzeln zurück – zwei Bereiche,
 *   zwei Regler, vier Schritte;
 * - im Film gehört der Regler zur MASKE, nicht zu einem Anker: Er gilt an
 *   jedem Bild, es entsteht keine neue Bahn, und jede Maske hält ihren Wert.
 *
 * Ohne Anmeldung: Die Editoren stehen über `buehne.ts` direkt in der Seite.
 */

const BUEHNE = '/e2e/buehne.ts';

/** Ein Bild mit Streifen und Lichtern – etwas, woran sich Unschärfe zeigt. */
async function fotoZeigen(page: Page): Promise<Locator> {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.evaluate(async (pfad) => {
    const buehne = (await import(/* @vite-ignore */ pfad)) as typeof import('./buehne.js');
    const leinwand = document.createElement('canvas');
    leinwand.width = 480;
    leinwand.height = 360;
    const ctx = leinwand.getContext('2d') as CanvasRenderingContext2D;
    ctx.fillStyle = '#101018';
    ctx.fillRect(0, 0, 480, 360);
    // Senkrechte Streifen der Breite 3: Unschärfe macht sie unsichtbar.
    for (let x = 0; x < 480; x += 6) {
      ctx.fillStyle = '#d8d0c0';
      ctx.fillRect(x, 0, 3, 360);
    }
    // Ein paar Lichter, wie sie ein Bokeh zu Scheiben macht.
    ctx.fillStyle = '#ffffff';
    for (const [x, y] of [
      [200, 150],
      [280, 210],
      [240, 180],
    ]) {
      ctx.fillRect(x - 1, y - 1, 3, 3);
    }
    const blob = await new Promise<Blob>((auf) =>
      leinwand.toBlob((b) => auf(b as Blob), 'image/png'),
    );
    buehne.bildEditorZeigen(blob);
  }, BUEHNE);
  const editor = page.locator('.bild-editor');
  await expect(editor.locator('.bild-leinwand')).toBeVisible({ timeout: 30_000 });
  return editor;
}

async function reiterBereiche(editor: Locator) {
  await editor
    .locator('.bild-reiter')
    .getByRole('button', { name: /Bereiche/ })
    .click();
}

function weichRegler(editor: Locator): Locator {
  return editor.getByRole('slider', { name: /^Weichzeichnen/ });
}

function bokehRegler(editor: Locator): Locator {
  return editor.getByRole('slider', { name: /^Bokeh/ });
}

function bereichsKnoepfe(editor: Locator): Locator {
  return editor.getByRole('group', { name: 'Bereiche' }).getByRole('button');
}

/** Einen Bereichsregler auf einen Wert setzen, wie ein Zug es täte. */
async function ziehen(regler: Locator, wert: number) {
  await regler.fill(String(wert));
}

/** Die Leinwand des Editors als Bytes. */
async function leinwandBytes(editor: Locator): Promise<number[]> {
  return editor.locator('.bild-leinwand').evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const d = c.getContext('2d')?.getImageData(0, 0, c.width, c.height).data;
    return d ? Array.from(d) : [];
  });
}

/**
 * Die mittlere Schwankung zwischen Nachbarn in der Zeile durch die Mitte, von
 * `von` bis `bis` (Anteile der Breite): Streifen haben eine hohe, verwischte
 * Streifen eine niedrige.
 */
async function schwankung(editor: Locator, von: number, bis: number): Promise<number> {
  return editor.locator('.bild-leinwand').evaluate(
    (el, [a, b]) => {
      const c = el as HTMLCanvasElement;
      const y = Math.floor(c.height / 2);
      const d = c.getContext('2d')?.getImageData(0, y, c.width, 1).data;
      if (!d) return -1;
      let summe = 0;
      let n = 0;
      for (let x = Math.floor(c.width * a); x < Math.floor(c.width * b) - 1; x += 1) {
        summe += Math.abs(d[x * 4] - d[(x + 1) * 4]);
        n += 1;
      }
      return summe / n;
    },
    [von, bis],
  );
}

test('Weichzeichnen und Bokeh im Fotoeditor: zwei Regler, Tooltip, Doppelklick, Zug', async ({
  page,
}) => {
  const editor = await fotoZeigen(page);
  await reiterBereiche(editor);
  await editor.getByRole('button', { name: '◎ Radial' }).click();

  const weich = weichRegler(editor);
  const bokeh = bokehRegler(editor);
  await expect(weich).toBeVisible();
  await expect(bokeh).toBeVisible();
  await expect(weich).toHaveValue('0');
  await expect(bokeh).toHaveValue('0');
  // Zwei Regler von 0 bis 1 – und die Anzeige daneben ohne Vorzeichen.
  await expect(weich).toHaveAttribute('min', '0');
  await expect(weich).toHaveAttribute('max', '1');
  await expect(bokeh).toHaveAttribute('min', '0');
  await expect(bokeh).toHaveAttribute('max', '1');

  // Jeder Regler hat einen Tooltip, der nennt, was er tut – und dass die
  // Wirkung an der Maske endet. Er erscheint beim Zeigen mit der Maus.
  // Erst ins Bild scrollen und warten: Das Scrollen, das `hover` sonst selbst
  // auslöste, kommt als Ereignis erst nach dem Zeigen und schlösse die Blase.
  await bokeh.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await weich.hover();
  const blase = page.getByRole('tooltip');
  await expect(blase).toBeVisible({ timeout: 4000 });
  await expect(blase).toContainText('Mattscheibe');
  await expect(blase).toContainText('innerhalb der Maske');
  await expect(blase).toContainText('nichts von draussen');
  await bokeh.hover();
  await expect(blase).toContainText('Linse', { timeout: 4000 });
  await expect(blase).toContainText('Scheiben');
  await expect(blase).toContainText('holt keine Farbe von draussen herein');
  await page.mouse.move(2, 2);

  // Zuerst sind die Streifen da: in der Mitte wie am Rand.
  const mitteVorher = await schwankung(editor, 0.4, 0.6);
  const randVorher = await schwankung(editor, 0.02, 0.1);
  expect(mitteVorher).toBeGreaterThan(20);
  expect(randVorher).toBeGreaterThan(20);
  const vorher = await leinwandBytes(editor);

  // Ein Zug an „Bokeh“: In der Mitte (der Bereich) verschwinden die Streifen,
  // am Rand bleiben sie.
  await ziehen(bokeh, 0.8);
  await expect(bokeh).toHaveValue('0.8');
  await expect
    .poll(() => schwankung(editor, 0.4, 0.6), { timeout: 15_000 })
    .toBeLessThan(mitteVorher / 3);
  expect(await schwankung(editor, 0.02, 0.1)).toBeCloseTo(randVorher, 5);
  const mitBokeh = await leinwandBytes(editor);
  expect(mitBokeh).not.toEqual(vorher);

  // Dasselbe mit „Weichzeichnen“, wenn Bokeh wieder aus ist.
  await bokeh.dblclick();
  await expect(bokeh).toHaveValue('0');
  await expect
    .poll(() => schwankung(editor, 0.4, 0.6), { timeout: 15_000 })
    .toBeCloseTo(mitteVorher, 5);
  // Doppelklick setzt auf 0, und das Bild kehrt zurück – Byte für Byte.
  expect(await leinwandBytes(editor)).toEqual(vorher);

  await ziehen(weich, 0.7);
  await expect
    .poll(() => schwankung(editor, 0.4, 0.6), { timeout: 15_000 })
    .toBeLessThan(mitteVorher / 3);
  expect(await schwankung(editor, 0.02, 0.1)).toBeCloseTo(randVorher, 5);
  await weich.dblclick();
  await expect(weich).toHaveValue('0');
  await expect.poll(async () => (await leinwandBytes(editor)).join() === vorher.join()).toBe(true);

  // Beide zugleich dürfen wirken.
  await ziehen(bokeh, 0.5);
  await ziehen(weich, 0.5);
  await expect
    .poll(() => schwankung(editor, 0.4, 0.6), { timeout: 15_000 })
    .toBeLessThan(mitteVorher / 3);
});

test('Rückgängig nimmt die Regler zweier Bereiche einzeln zurück', async ({ page }) => {
  /*
   * Zwei Bereiche, zwei Regler, vier Schritte. Der Rückgängig-Verlauf bündelt
   * Züge am selben Regler (eine Sekunde, gleiche Art); die Art enthält den
   * Bereich und den Regler. Wäre eine davon nicht dabei, fielen zwei Regler –
   * kurz nacheinander verstellt – in einen Schritt.
   */
  const editor = await fotoZeigen(page);
  await reiterBereiche(editor);

  await editor.getByRole('button', { name: '◎ Radial' }).click();
  await ziehen(bokehRegler(editor), 0.5);
  await ziehen(weichRegler(editor), 0.4);

  await editor.getByRole('button', { name: '＋ Bereich' }).click();
  await editor.getByRole('button', { name: '↗ Verlauf' }).click();
  await expect(bereichsKnoepfe(editor)).toHaveCount(3); // zwei Bereiche und „＋ Bereich“
  await ziehen(bokehRegler(editor), 0.9);
  await ziehen(weichRegler(editor), 0.7);
  await expect(bokehRegler(editor)).toHaveValue('0.9');
  await expect(weichRegler(editor)).toHaveValue('0.7');

  const zurueck = editor.getByRole('button', { name: 'Rückgängig' });
  const erster = bereichsKnoepfe(editor).nth(0);

  // Die letzten beiden Schritte gehören dem zweiten Bereich – einzeln.
  await zurueck.click();
  await expect(weichRegler(editor)).toHaveValue('0');
  await expect(bokehRegler(editor)).toHaveValue('0.9');
  await zurueck.click();
  await expect(bokehRegler(editor)).toHaveValue('0');

  // Dazwischen liegen das Anlegen des zweiten Bereichs und seiner Maske:
  // zwei Schritte, die keine Regler sind.
  await zurueck.click();
  await zurueck.click();
  await expect(bereichsKnoepfe(editor)).toHaveCount(2); // ein Bereich und „＋ Bereich“

  // Davor stehen die Regler des ersten, ebenfalls einzeln.
  await erster.click();
  await expect(bokehRegler(editor)).toHaveValue('0.5');
  await expect(weichRegler(editor)).toHaveValue('0.4');
  await zurueck.click();
  await expect(weichRegler(editor)).toHaveValue('0');
  await expect(bokehRegler(editor)).toHaveValue('0.5');
  await zurueck.click();
  await expect(bokehRegler(editor)).toHaveValue('0');
});

/**
 * Drei Sekunden bei zehn Bildern je Sekunde, 320 × 240: ein weisses Quadrat
 * (40 × 40) wandert über Rot – wie in `maskenSpuren.spec.ts`.
 */
async function filmZeigen(page: Page): Promise<boolean> {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  return page.evaluate(async (pfad) => {
    const schreibenPfad = '/src/modules/video/schreiben.ts';
    const schreiben = (await import(
      /* @vite-ignore */ schreibenPfad
    )) as typeof import('../src/modules/video/schreiben.js');
    if (!(await schreiben.videoTauglich(320, 240)).moeglich) return false;
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
    const buehne = (await import(/* @vite-ignore */ pfad)) as typeof import('./buehne.js');
    buehne.videoBlattZeigen(datei);
    return true;
  }, BUEHNE);
}

test('im Videoeditor gehören Weichzeichnen und Bokeh zur Maske – ein Wert für den ganzen Lauf', async ({
  page,
}) => {
  /*
   * Im Film hängt ein Regler an der MASKE, nicht an einem Anker: Er ändert,
   * WIE stark die Bahn wirkt, nicht, WO sie liegt. Darum gilt er an jedem Bild
   * (kein neuer Wert je Stellbild), es entsteht keine zweite Bahn, und jede
   * Maske hält ihren eigenen Wert – auch beim Wechsel zwischen den Masken.
   * Dasselbe Bereichspanel wie beim Foto, derselbe Tooltip.
   */
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 412, height: 880 });
  if (!(await filmZeigen(page))) {
    test.skip(true, 'Kein Videokodierer in diesem Browser');
    return;
  }
  const bearbeiten = page.getByRole('button', { name: /Bearbeiten und schneiden/ });
  await expect(bearbeiten).toBeEnabled({ timeout: 30_000 });
  await bearbeiten.click();
  const editor = page.locator('.bild-editor');
  await expect(editor.locator('.bild-wiedergabe')).toBeHidden({ timeout: 20_000 });
  await reiterBereiche(editor);

  // Eine Maske auf dem Quadrat: an Bild 0 liegt seine Mitte bei (40, 120).
  await editor.getByRole('button', { name: /Antippen aus/ }).click();
  const kasten = await editor.locator('.bild-leinwand').boundingBox();
  if (!kasten) throw new Error('keine Leinwand');
  await page.mouse.click(
    kasten.x + (40 / 320) * kasten.width,
    kasten.y + (120 / 240) * kasten.height,
  );
  await expect(editor.locator('.mb-zeile')).toHaveCount(1, { timeout: 20_000 });

  // Dieselben zwei Regler wie beim Foto, mit Tooltip.
  await expect(weichRegler(editor)).toBeVisible();
  await expect(bokehRegler(editor)).toBeVisible();
  await expect(bokehRegler(editor)).toHaveValue('0');
  await bokehRegler(editor).scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await bokehRegler(editor).hover();
  await expect(page.getByRole('tooltip')).toContainText('Linse', { timeout: 4000 });
  await page.mouse.move(2, 2);

  // Ein Zug an „Bokeh“: kein neuer Anker, keine neue Bahn.
  await ziehen(bokehRegler(editor), 0.6);
  await expect(bokehRegler(editor)).toHaveValue('0.6');
  await expect(editor.locator('.mb-zeile')).toHaveCount(1);

  // An einem anderen Bild gilt derselbe Wert.
  const leiste = editor.getByRole('slider', { name: 'Wiedergabestelle' });
  await leiste.focus();
  for (let i = 0; i < 3; i += 1) await leiste.press('Shift+ArrowRight');
  await expect(editor.locator('.bild-wiedergabe')).toBeHidden({ timeout: 20_000 });
  await expect(bokehRegler(editor)).toHaveValue('0.6', { timeout: 30_000 });
  await expect(weichRegler(editor)).toHaveValue('0');
  await expect(editor.locator('.mb-zeile')).toHaveCount(1);

  // Eine zweite Maske hat ihre eigenen Werte – und die erste behält ihre.
  await editor.getByRole('button', { name: '＋ Bereich' }).click();
  await expect(bokehRegler(editor)).toHaveValue('0', { timeout: 20_000 });
  await expect(weichRegler(editor)).toHaveValue('0');
  await ziehen(weichRegler(editor), 0.3);
  await expect(weichRegler(editor)).toHaveValue('0.3');
  await bereichsKnoepfe(editor).nth(0).click();
  await expect(bokehRegler(editor)).toHaveValue('0.6');
  await expect(weichRegler(editor)).toHaveValue('0');
  await bereichsKnoepfe(editor).nth(1).click();
  await expect(bokehRegler(editor)).toHaveValue('0');
  await expect(weichRegler(editor)).toHaveValue('0.3');

  // Doppelklick setzt auf 0, wie beim Foto.
  await weichRegler(editor).dblclick();
  await expect(weichRegler(editor)).toHaveValue('0');
});

test('im gebauten Film wirken Weichzeichnen und Bokeh in jedem Bild – im Bereich und nirgends sonst', async ({
  page,
}) => {
  /*
   * Der Weg bis in die Datei: Der Film wird Bild für Bild durch denselben
   * Renderer gerechnet wie das Foto, mit der besten Güte. Gehalten wird, dass
   * die Unschärfe an JEDEM Bild ankommt (ein Film, der auf dem ersten Bild
   * einfriert, war schon einmal der Fehler) und dass sie an der Maske endet.
   *
   * Quelle: senkrechte Streifen, die mit jedem Bild um einen Punkt wandern –
   * ein eingefrorenes Bild verriete sich an seiner Lage. Gebaut wird zweimal,
   * mit und ohne Bereich; verglichen wird die Schwankung zwischen Nachbarn in
   * der Mitte (im Bereich) und am Rand (ausserhalb). Der Videokodierer macht
   * das Bild nie byteweise gleich, deshalb gilt am Rand: dieselbe Schwankung
   * wie im Film ohne Bereich, auf wenige Prozent.
   */
  test.setTimeout(300_000);
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  const ergebnis = await page.evaluate(async () => {
    const schreibenPfad = '/src/modules/video/schreiben.ts';
    const bauenPfad = '/src/modules/video/videoBauen.ts';
    const docPfad = '/src/modules/bild/doc.ts';
    const schreiben = (await import(
      /* @vite-ignore */ schreibenPfad
    )) as typeof import('../src/modules/video/schreiben.js');
    const bauen = (await import(
      /* @vite-ignore */ bauenPfad
    )) as typeof import('../src/modules/video/videoBauen.js');
    const docModul = (await import(
      /* @vite-ignore */ docPfad
    )) as typeof import('../src/modules/bild/doc.js');
    if (!(await schreiben.videoTauglich(320, 240)).moeglich) return { uebersprungen: true };

    const leinwand = document.createElement('canvas');
    leinwand.width = 320;
    leinwand.height = 240;
    const ctx = leinwand.getContext('2d') as CanvasRenderingContext2D;
    const quelle = await schreiben.videoSchreiben(
      30,
      (nummer) => {
        ctx.fillStyle = '#101018';
        ctx.fillRect(0, 0, 320, 240);
        ctx.fillStyle = '#d8d0c0';
        for (let x = -6 + (nummer % 6); x < 320; x += 6) ctx.fillRect(x, 0, 3, 240);
        return leinwand;
      },
      { breite: 320, hoehe: 240, bildrate: 10 },
    );

    const bereich = (par: { bokeh: number; unschaerfe: number }) => ({
      id: 'b1',
      name: 'Mitte',
      aktiv: true,
      teile: [
        {
          id: 'r1',
          modus: 'dazu' as const,
          umkehren: false,
          art: 'radial' as const,
          mitte: { x: 160, y: 120 },
          rx: 90,
          ry: 90,
          winkel: 0,
          weichheit: 0.05,
        },
      ],
      anpassung: { ...docModul.BEREICH_NEUTRAL, ...par },
    });
    const bauenMit = async (bereiche: ReturnType<typeof bereich>[]) =>
      bauen.videoAusVideo({
        datei: quelle,
        doc: { ...docModul.neuesDoc(320, 240), bereiche },
        stuecke: [{ vonMs: 0, bisMs: 500 }],
        bildrate: 10,
        kante: 320,
        schluesselAbstand: 4,
        maxBilder: 30,
      });

    /** Die Schwankung zwischen Nachbarn in zwei Bändern – Mitte und Rand – an drei Bildern. */
    const messen = async (blob: Blob) => {
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
      const aus: { mitte: number; rand: number }[] = [];
      const zeile = (x0: number, x1: number) => {
        const y = Math.floor(probe.height / 2);
        const d = pctx.getImageData(0, y, probe.width, 1).data;
        let summe = 0;
        let n = 0;
        for (let x = Math.floor(probe.width * x0); x < Math.floor(probe.width * x1) - 1; x += 1) {
          summe += Math.abs(d[x * 4] - d[(x + 1) * 4]);
          n += 1;
        }
        return summe / n;
      };
      for (const bild of [0, 2, 4]) {
        await new Promise<void>((auf) => {
          video.onseeked = () => auf();
          video.currentTime = bild / 10 + 0.001;
        });
        /*
         * Ein Bild, das der Browser noch nicht dekodiert hat, kommt als leere
         * Fläche heraus – auf einem ausgelasteten Rechner gar nicht so selten.
         * Der Rand trägt in jedem echten Bild Streifen; ist er glatt, wird
         * kurz gewartet und noch einmal gelesen.
         */
        let mass = { mitte: 0, rand: 0 };
        for (let versuch = 0; versuch < 20 && mass.rand === 0; versuch += 1) {
          if (versuch > 0) await new Promise((auf) => setTimeout(auf, 100));
          pctx.drawImage(video, 0, 0);
          mass = { mitte: zeile(0.4, 0.6), rand: zeile(0.02, 0.15) };
        }
        aus.push(mass);
      }
      return aus;
    };

    const ohne = await bauenMit([]);
    const mitBokeh = await bauenMit([bereich({ bokeh: 1, unschaerfe: 0 })]);
    const mitWeich = await bauenMit([bereich({ bokeh: 0, unschaerfe: 1 })]);
    return {
      uebersprungen: false,
      ohne: await messen(ohne.blob),
      bokeh: await messen(mitBokeh.blob),
      weich: await messen(mitWeich.blob),
      bilder: mitBokeh.bilder,
    };
  });

  if (ergebnis.uebersprungen) {
    test.skip(true, 'Kein Videokodierer in diesem Browser');
    return;
  }
  expect(ergebnis.bilder).toBe(5);
  for (const art of ['bokeh', 'weich'] as const) {
    ergebnis[art]?.forEach((m, i) => {
      const ref = ergebnis.ohne?.[i];
      if (!ref) throw new Error('keine Messung ohne Bereich');
      // Das Quellvideo trägt die Streifen – sonst bewiese nichts etwas.
      expect(ref.mitte, `Bild ${i}: Streifen in der Quelle`).toBeGreaterThan(15);
      // Im Bereich sind sie an jedem Bild fort …
      expect(m.mitte, `${art}, Bild ${i}: Streifen im Bereich`).toBeLessThan(ref.mitte / 3);
      // … am Rand stehen sie wie im Film ohne Bereich.
      expect(m.rand, `${art}, Bild ${i}: Rand`).toBeGreaterThan(ref.rand * 0.9);
      expect(m.rand, `${art}, Bild ${i}: Rand`).toBeLessThan(ref.rand * 1.1);
    });
  }
});
