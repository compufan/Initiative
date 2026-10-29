import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Masken als Spuren über den Film – im echten Browser, über die Oberfläche.
 *
 * Die Bitte war: „Man sollte die Möglichkeit haben, die Maske für das ganze
 * Video zu haben (wobei die Maske verschwindet, wenn das Objekt aus dem
 * Bildausschnitt verschwindet) oder nur für einen Bereich. Beides sollte
 * jederzeit in der Zeitleiste angezeigt werden."
 *
 * Geprüft wird deshalb, was ein Anwender sieht: die Bahn unter den
 * Abschnitten und was sie über die Maske sagt (ihre Beschreibung für
 * Bildschirmleser nennt die Zeiten, an denen sie zu sehen ist), die Zeile
 * der Einstellungen, der Editor an einem anderen Bild – und der fertige
 * Film, in dem die Maske an jedem Bild auf dem Gegenstand sitzt.
 */

interface Filmwahl {
  /** Wie viele Punkte das Quadrat je Bild wandert. */
  readonly schritt?: number;
  /** Seine Farbe – Grün lässt sich entsättigen, Weiss nicht. */
  readonly farbe?: string;
}

/**
 * Drei Sekunden bei zehn Bildern je Sekunde, 320 × 240: ein Quadrat (40 ×
 * 40) wandert über Rot. Bild n: Quadrat bei x = 20 + schritt · n, y = 100.
 */
async function blattMitVideo(page: Page, wahl: Filmwahl = {}): Promise<boolean> {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  return page.evaluate(
    async ({ schritt, farbe }) => {
      const schreibenPfad = '/src/modules/video/schreiben.ts';
      const buehnePfad = '/e2e/buehne.ts';
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
          ctx.fillStyle = farbe;
          ctx.fillRect(20 + nummer * schritt, 100, 40, 40);
          return leinwand;
        },
        { breite: 320, hoehe: 240, bildrate: 10 },
      );
      const buehne = (await import(/* @vite-ignore */ buehnePfad)) as typeof import('./buehne.js');
      const blatt = buehne.videoBlattZeigen(datei);
      (window as unknown as { fertigerFilm: Promise<Blob> }).fertigerFilm = blatt.fertig;
      return true;
    },
    { schritt: wahl.schritt ?? 8, farbe: wahl.farbe ?? '#ffffff' },
  );
}

async function editorOeffnen(page: Page): Promise<Locator> {
  const bearbeiten = page.getByRole('button', { name: /Bearbeiten und schneiden/ });
  await expect(bearbeiten).toBeEnabled({ timeout: 30_000 });
  await bearbeiten.click();
  const editor = page.locator('.bild-editor');
  await expect(editor.locator('.bild-wiedergabe')).toBeHidden({ timeout: 20_000 });
  return editor;
}

async function reiterBereiche(editor: Locator) {
  await editor
    .locator('.bild-reiter')
    .getByRole('button', { name: /Bereiche/ })
    .click();
}

/** Auf das Quadrat tippen – an Bild 0 liegt seine Mitte bei (40, 120). */
async function quadratAntippen(page: Page, editor: Locator) {
  await editor.getByRole('button', { name: /Antippen aus/ }).click();
  const kasten = await editor.locator('.bild-leinwand').boundingBox();
  if (!kasten) throw new Error('keine Leinwand');
  await page.mouse.click(
    kasten.x + (40 / 320) * kasten.width,
    kasten.y + (120 / 240) * kasten.height,
  );
}

function bereichsKnoepfe(editor: Locator): Locator {
  return editor.getByRole('group', { name: 'Bereiche' }).getByRole('button');
}

function einstellungen(editor: Locator): Locator {
  return editor.getByRole('toolbar', { name: /^Bereich / });
}

const OHNE_KODIERER = 'Kein Videokodierer in diesem Browser';

test('eine angetippte Maske gilt im ganzen Film – die Zeitleiste zeigt, wo sie zu sehen ist', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 412, height: 880 });
  if (!(await blattMitVideo(page))) {
    test.skip(true, OHNE_KODIERER);
    return;
  }
  const editor = await editorOeffnen(page);
  await reiterBereiche(editor);
  await quadratAntippen(page, editor);

  // Eine Maske im Film: eine Bahn unter den Abschnitten, und statt der
  // Knöpfe die Zeile ihrer Einstellungen – sie ist gleich gewählt.
  await expect(editor.locator('.mb-zeile')).toHaveCount(1, { timeout: 20_000 });
  await expect(einstellungen(editor)).toBeVisible();
  await expect(einstellungen(editor).getByRole('radio', { name: 'Ganzer Film' })).toHaveAttribute(
    'aria-checked',
    'true',
  );

  // Im Hintergrund verfolgt: Das Quadrat ist die ganzen drei Sekunden zu sehen.
  const bahn = editor.locator('.mb-leinwand').first();
  await expect(bahn).toHaveAttribute('aria-label', /^sichtbar 0,0 s bis (2,9|3,0) s$/, {
    timeout: 120_000,
  });

  // An einem anderen Bild ist sie wieder da – ohne Frage, ohne Mitnehmen.
  const leiste = editor.getByRole('slider', { name: 'Wiedergabestelle' });
  await leiste.focus();
  for (let i = 0; i < 3; i += 1) await leiste.press('Shift+ArrowRight');
  await expect(editor.locator('.bild-wiedergabe')).toBeHidden({ timeout: 20_000 });
  await expect(bereichsKnoepfe(editor)).toHaveCount(2, { timeout: 30_000 });

  // „Fertig" bringt die Knöpfe der Zeitleiste zurück.
  await einstellungen(editor).getByRole('button', { name: 'Fertig' }).click();
  await expect(
    editor.getByRole('button', { name: 'An der Wiedergabestelle teilen' }),
  ).toBeVisible();

  // Auch das Blatt zeigt die Bahn – nur zum Ansehen.
  await editor.getByRole('button', { name: 'Fertig', exact: true }).click();
  await expect(editor).toBeHidden();
  await expect(page.locator('.mb.ist-lesend .mb-zeile')).toHaveCount(1);
  await expect(page.getByText(/Ein Bereich gilt im Film/)).toBeVisible();
});

test('eine Maske verschwindet in der Bahn, sobald ihr Gegenstand das Bild verlässt', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 412, height: 880 });
  // Sechzehn Punkte je Bild: Ab Bild 19 (1,9 s) ist das Quadrat draussen.
  if (!(await blattMitVideo(page, { schritt: 16 }))) {
    test.skip(true, OHNE_KODIERER);
    return;
  }
  const editor = await editorOeffnen(page);
  await reiterBereiche(editor);
  await quadratAntippen(page, editor);
  await expect(editor.locator('.mb-zeile')).toHaveCount(1, { timeout: 20_000 });
  const bahn = editor.locator('.mb-leinwand').first();
  await expect(bahn).toHaveAttribute('aria-label', /^sichtbar 0,0 s bis (1,[5-9]|2,[0-2]) s$/, {
    timeout: 120_000,
  });
});

test('Ab hier grenzt die Maske ein – ihr Griff steht an der Wiedergabestelle', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 412, height: 880 });
  if (!(await blattMitVideo(page))) {
    test.skip(true, OHNE_KODIERER);
    return;
  }
  const editor = await editorOeffnen(page);
  await reiterBereiche(editor);
  await editor
    .getByRole('button', { name: /Verlauf/ })
    .first()
    .click();
  const zeile = einstellungen(editor);
  await expect(zeile).toBeVisible({ timeout: 20_000 });

  const leiste = editor.getByRole('slider', { name: 'Wiedergabestelle' });
  await leiste.focus();
  await leiste.press('Shift+ArrowRight');
  await leiste.press('Shift+ArrowRight');
  await expect(editor.locator('.bild-wiedergabe')).toBeHidden({ timeout: 20_000 });

  await zeile.getByRole('button', { name: 'Ab hier' }).click();
  await expect(zeile.getByRole('radio', { name: 'Zeitraum' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  const anfang = editor.getByRole('slider', { name: /Anfang des Zeitraums/ });
  await expect(anfang).toBeVisible();
  const wert = Number(await anfang.getAttribute('aria-valuenow'));
  // Zweimal zehn Bilder bei 25 je Sekunde: 0,8 s – auf ein Bild genau.
  expect(Math.abs(wert - 800), `Anfang bei ${wert} ms`).toBeLessThanOrEqual(40);

  // Die Pfeiltaste am Griff: genau ein Bild (40 ms bei 25 je Sekunde).
  await anfang.focus();
  await anfang.press('ArrowRight');
  await expect(anfang).toHaveAttribute('aria-valuenow', String(wert + 40));
  await anfang.press('ArrowLeft');
  await expect(anfang).toHaveAttribute('aria-valuenow', String(wert));

  // Ganzer Film und zurück: Der Zeitraum ist nicht vergessen.
  await zeile.getByRole('radio', { name: 'Ganzer Film' }).click();
  await expect(anfang).toHaveCount(0);
  await zeile.getByRole('radio', { name: 'Zeitraum' }).click();
  await expect(anfang).toHaveAttribute('aria-valuenow', String(wert));

  // Vor dem Zeitraum wirkt sie nicht – der Editor zeigt sie dort nicht.
  await leiste.focus();
  await leiste.press('Shift+ArrowLeft');
  await leiste.press('Shift+ArrowLeft');
  await expect(editor.locator('.bild-wiedergabe')).toBeHidden({ timeout: 20_000 });
  await expect(bereichsKnoepfe(editor)).toHaveCount(1, { timeout: 20_000 });
  // Die Bahn bleibt: Die Maske gibt es weiter, nur nicht hier.
  await expect(editor.locator('.mb-zeile')).not.toHaveCount(0);
});

test('Löschen in der Zeitleiste nimmt die Maske auch aus dem Editor – ↺ holt sie zurück', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 412, height: 880 });
  if (!(await blattMitVideo(page))) {
    test.skip(true, OHNE_KODIERER);
    return;
  }
  const editor = await editorOeffnen(page);
  await reiterBereiche(editor);
  await editor
    .getByRole('button', { name: /Verlauf/ })
    .first()
    .click();
  const zeile = einstellungen(editor);
  await expect(zeile).toBeVisible({ timeout: 20_000 });
  await expect(bereichsKnoepfe(editor)).toHaveCount(2);

  await zeile.getByRole('button', { name: /löschen/ }).click();
  await expect(editor.locator('.mb-zeile')).toHaveCount(0);
  await expect(bereichsKnoepfe(editor)).toHaveCount(1, { timeout: 20_000 });

  await editor
    .getByRole('button', { name: 'Letzte Änderung an den Bereichen zurücknehmen' })
    .click();
  await expect(editor.locator('.mb-zeile')).toHaveCount(1);
  await expect(bereichsKnoepfe(editor)).toHaveCount(2, { timeout: 20_000 });
});

test('auf einem kleinen Telefon bleibt die Bühne gross genug – auch mit vier Masken', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 375, height: 667 });
  if (!(await blattMitVideo(page))) {
    test.skip(true, OHNE_KODIERER);
    return;
  }
  const editor = await editorOeffnen(page);
  await reiterBereiche(editor);
  const dazu = editor.getByRole('button', { name: '＋ Bereich' });
  for (let i = 1; i <= 4; i += 1) {
    await dazu.click();
    await expect(bereichsKnoepfe(editor)).toHaveCount(i + (i < 4 ? 1 : 0), { timeout: 20_000 });
  }
  // Vier Masken: eine Sammelbahn und die gewählte aufgeklappt – nicht vier.
  await expect(editor.locator('.mb-zeile')).toHaveCount(2);
  await expect(einstellungen(editor)).toBeVisible();
  const buehne = await editor.locator('.bild-buehne').boundingBox();
  expect(buehne?.height ?? 0, 'Höhe der Bühne').toBeGreaterThanOrEqual(180);
});

test('im fertigen Film sitzt die Maske an jedem Bild auf dem Gegenstand', async ({ page }) => {
  test.setTimeout(360_000);
  await page.setViewportSize({ width: 412, height: 880 });
  // Ein grünes Quadrat – entsättigt wird es grau, das Rot daneben bleibt.
  if (!(await blattMitVideo(page, { farbe: '#20c040' }))) {
    test.skip(true, OHNE_KODIERER);
    return;
  }
  const editor = await editorOeffnen(page);
  await reiterBereiche(editor);
  await quadratAntippen(page, editor);
  await expect(editor.locator('.mb-zeile')).toHaveCount(1, { timeout: 20_000 });
  await editor.getByLabel('Sättigung').last().fill('-1');
  await expect(editor.locator('.mb-leinwand').first()).toHaveAttribute(
    'aria-label',
    /^sichtbar 0,0 s bis (2,9|3,0) s$/,
    { timeout: 120_000 },
  );
  await editor.getByRole('button', { name: 'Fertig', exact: true }).click();
  await expect(editor).toBeHidden();

  await page.getByRole('button', { name: 'Film bauen' }).click();
  await expect(page.getByRole('button', { name: 'Übernehmen' })).toBeVisible({ timeout: 180_000 });
  await page.getByRole('button', { name: 'Übernehmen' }).click();

  const proben = await page.evaluate(async () => {
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
    const faktor = probe.width / 320;
    const bei = async (sekunden: number) => {
      await new Promise<void>((auf) => {
        video.onseeked = () => auf();
        video.currentTime = sekunden;
      });
      pctx.drawImage(video, 0, 0);
      // Die Mitte des Quadrats an Quellbild n: (40 + 8n, 120).
      const n = Math.floor(sekunden * 10 + 1e-6);
      const q = pctx.getImageData(
        Math.round((40 + 8 * n) * faktor),
        Math.round(120 * faktor),
        1,
        1,
      ).data;
      const grund = pctx.getImageData(8, probe.height - 12, 1, 1).data;
      return { quadrat: [q[0], q[1], q[2]], grund: [grund[0], grund[1], grund[2]] };
    };
    return [await bei(0.35), await bei(1.45), await bei(2.55)];
  });

  const grau = ([r, g, b]: number[]) => Math.abs(r - g) < 30 && Math.abs(g - b) < 30;
  const rot = ([r, g]: number[]) => r - g > 80;
  for (const [i, probe] of proben.entries()) {
    expect(grau(probe.quadrat), `Quadrat, Probe ${i}: ${probe.quadrat}`).toBe(true);
    expect(rot(probe.grund), `Grund, Probe ${i}: ${probe.grund}`).toBe(true);
  }
});

test('Nur Abschnitt 2, Hier trennen, ausschalten – jede Maske behält ihre Bahn', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 412, height: 880 });
  if (!(await blattMitVideo(page))) {
    test.skip(true, OHNE_KODIERER);
    return;
  }
  // Im Blatt bei 1,2 s teilen – zwei Abschnitte.
  await expect(page.getByRole('button', { name: /Bearbeiten und schneiden/ })).toBeEnabled({
    timeout: 30_000,
  });
  const blattLeiste = page.getByRole('slider', { name: 'Wiedergabestelle' });
  await blattLeiste.focus();
  for (let i = 0; i < 3; i += 1) await blattLeiste.press('Shift+ArrowRight');
  await page.getByRole('button', { name: 'An der Wiedergabestelle teilen' }).click();
  await expect(page.locator('.zl-abschnitt')).toHaveCount(2);

  const editor = await editorOeffnen(page);
  await expect(editor.locator('.bild-kopf strong')).toHaveText('Abschnitt 2 von 2');
  await reiterBereiche(editor);
  await editor
    .getByRole('button', { name: /Verlauf/ })
    .first()
    .click();
  const zeile = einstellungen(editor);
  await expect(zeile).toBeVisible({ timeout: 20_000 });

  // Nur im zweiten Abschnitt: Die Bahn zeigt sie erst ab 1,2 s.
  await zeile.getByRole('button', { name: 'Nur Abschnitt 2' }).click();
  await expect(zeile.getByRole('button', { name: 'Nur Abschnitt 2' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const bahn = editor.locator('.mb-leinwand').first();
  await expect(bahn).toHaveAttribute('aria-label', /^sichtbar 1,[12] s bis (2,9|3,0) s$/, {
    timeout: 120_000,
  });

  // Bei 2,0 s trennen: zwei Masken, zwei Bahnen, die neue ist gewählt.
  const leiste = editor.getByRole('slider', { name: 'Wiedergabestelle' });
  await leiste.focus();
  for (let i = 0; i < 2; i += 1) await leiste.press('Shift+ArrowRight');
  await expect(editor.locator('.bild-wiedergabe')).toBeHidden({ timeout: 20_000 });
  const nameVorher = await zeile.locator('.mb-name').textContent();
  await zeile.getByRole('button', { name: 'Hier trennen' }).click();
  await expect(editor.locator('.mb-zeile')).toHaveCount(2);
  await expect(zeile.locator('.mb-name')).not.toHaveText(nameVorher ?? '');
  const bahnen = editor.locator('.mb-leinwand');
  await expect(bahnen.nth(0)).toHaveAttribute('aria-label', /^sichtbar 1,[12] s bis 2,0 s$/, {
    timeout: 60_000,
  });
  await expect(bahnen.nth(1)).toHaveAttribute('aria-label', /^sichtbar 2,0 s bis (2,9|3,0) s$/, {
    timeout: 60_000,
  });

  // Ausschalten: Der Editor zeigt sie abgehakt, die Bahn bleibt.
  const wirkt = zeile.getByRole('button', { name: /wirkt/ });
  await expect(wirkt).toHaveAttribute('aria-pressed', 'true');
  await wirkt.click();
  await expect(wirkt).toHaveAttribute('aria-pressed', 'false');
  await expect(bereichsKnoepfe(editor).filter({ hasText: '✗' })).toHaveCount(1, {
    timeout: 20_000,
  });
  await expect(editor.locator('.mb-zeile')).toHaveCount(2);
});

test('nur ansehen bearbeitet nichts – kein ✎, die Grösse bleibt wählbar', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 412, height: 880 });
  if (!(await blattMitVideo(page))) {
    test.skip(true, OHNE_KODIERER);
    return;
  }
  const editor = await editorOeffnen(page);
  // Das Stellbild einmal wechseln – auch das ist nur Ansehen.
  const leiste = editor.getByRole('slider', { name: 'Wiedergabestelle' });
  await leiste.focus();
  await leiste.press('Shift+ArrowRight');
  await expect(editor.locator('.bild-wiedergabe')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(500);
  await expect(editor.locator('.zl-nummer').first()).not.toContainText('✎');
  await editor.getByRole('button', { name: 'Fertig', exact: true }).click();
  await expect(editor).toBeHidden();
  await expect(page.getByText(/Noch nichts eingestellt/)).toBeVisible();
  await expect(page.getByRole('button', { name: '640' })).toBeEnabled();
});

test('ab drei Masken: ein Tipp auf die Sammelbahn zeigt die Namen, jede ist wählbar', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 412, height: 880 });
  if (!(await blattMitVideo(page))) {
    test.skip(true, OHNE_KODIERER);
    return;
  }
  const editor = await editorOeffnen(page);
  await reiterBereiche(editor);
  const dazu = editor.getByRole('button', { name: '＋ Bereich' });
  for (let i = 1; i <= 3; i += 1) {
    await dazu.click();
    await expect(bereichsKnoepfe(editor)).toHaveCount(i + 1, { timeout: 20_000 });
  }
  await expect(einstellungen(editor)).toBeVisible();
  await einstellungen(editor)
    .getByRole('button', { name: /Bereich fertig/ })
    .click();
  await expect(editor.locator('.mb-zeile')).toHaveCount(1);

  // Ein Tipp auf die Sammelbahn: die drei Namen zur Wahl.
  const sammel = await editor.locator('.mb-zeile').first().boundingBox();
  if (!sammel) throw new Error('keine Sammelbahn');
  await page.mouse.click(sammel.x + sammel.width / 3, sammel.y + sammel.height / 2);
  const wahl = editor.getByRole('toolbar', { name: 'Bereich wählen' });
  await expect(wahl).toBeVisible();
  const namen = wahl.locator('.mb-namenwahl');
  await expect(namen).toHaveCount(3);
  const zweiter = ((await namen.nth(1).textContent()) ?? '').trim();
  await namen.nth(1).click();
  await expect(einstellungen(editor).locator('.mb-name')).toContainText(zweiter);

  // Und mit der Tastatur: „Bereich wählen" in der Knopfzeile, dann die dritte.
  await einstellungen(editor)
    .getByRole('button', { name: /Bereich fertig/ })
    .click();
  const knopf = editor.getByRole('button', { name: 'Bereich wählen' });
  await expect(knopf).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(wahl.locator('.mb-namenwahl').first()).toBeFocused();
  const dritter = ((await wahl.locator('.mb-namenwahl').nth(2).textContent()) ?? '').trim();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(einstellungen(editor).locator('.mb-name')).toContainText(dritter);
});
