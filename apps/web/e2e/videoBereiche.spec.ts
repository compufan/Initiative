import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Mehrere Bereiche im Video – im echten Browser, über die Oberfläche.
 *
 * Die Bitte war: „Es sollten bei Videos auch wie beim Foto mehrere Bereiche
 * geben, für die separate Masken separat getrackt werden."
 *
 * Der Mechanismus war da; geprüft wird deshalb, was ein Anwender mit ZWEI
 * verschieden bewegten Gegenständen erlebt: Jeder bekommt seinen Bereich, im
 * fertigen Film trägt jeder seine eigene Bearbeitung und keiner die des
 * anderen – und die Oberfläche hält Editor und Zeitleiste zusammen (eine
 * Auswahl, nicht zwei), sagt, wenn ein Bereich an diesem Bild nicht gilt,
 * und lässt auf einem Telefon den Weg zurück nicht hinter einer Kante.
 *
 * Die Bühne ist ein Film aus der Prüfung selbst (`buehne.ts`), 320 × 240,
 * zehn Bilder je Sekunde, fünf Sekunden, blauer Grund. Zwei Quadrate (40 × 40):
 *
 *  - A wandert nach rechts: Bild n bei x = 10 + 8n, y = 60. Ab 3,9 s ist es
 *    draussen.
 *  - B wandert nach unten: Bild n bei x = bx, y = 10 + 4n.
 *
 * Mit bx = 230 (`GETRENNT`) berühren sich ihre Wege nie. Gerechnet wird ohne
 * Netz (Farbflutung): Es soll der Weg „Bereich → Maske → Spur → Film" geprüft
 * werden, nicht ein Modell.
 */

interface Szene {
  /** Farbe von A und B. „Hell": deutlich verschieden hell, damit beides messbar bleibt. */
  readonly a: string;
  readonly b: string;
  /** Wo B steht (x der linken Kante). */
  readonly bx: number;
}

const GETRENNT: Szene = { a: '#107030', b: '#f0b040', bx: 230 };

async function blattMitZweiGegenstaenden(page: Page, szene: Szene = GETRENNT): Promise<boolean> {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  return page.evaluate(async ({ a, b, bx }) => {
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
      50,
      (nummer) => {
        ctx.fillStyle = '#24405c';
        ctx.fillRect(0, 0, 320, 240);
        ctx.fillStyle = a;
        ctx.fillRect(10 + 8 * nummer, 60, 40, 40);
        ctx.fillStyle = b;
        ctx.fillRect(bx, 10 + 4 * nummer, 40, 40);
        return leinwand;
      },
      { breite: 320, hoehe: 240, bildrate: 10 },
    );
    const buehne = (await import(/* @vite-ignore */ buehnePfad)) as typeof import('./buehne.js');
    const blatt = buehne.videoBlattZeigen(datei);
    (window as unknown as { fertigerFilm: Promise<Blob> }).fertigerFilm = blatt.fertig;
    return true;
  }, szene);
}

const OHNE_KODIERER = 'Kein Videokodierer in diesem Browser';

async function editorOeffnen(page: Page): Promise<Locator> {
  const bearbeiten = page.getByRole('button', { name: /Bearbeiten und schneiden/ });
  await expect(bearbeiten).toBeEnabled({ timeout: 60_000 });
  await bearbeiten.click();
  const editor = page.locator('.bild-editor');
  await expect(editor.locator('.bild-wiedergabe')).toBeHidden({ timeout: 40_000 });
  return editor;
}

async function reiterBereiche(editor: Locator) {
  await editor
    .locator('.bild-reiter')
    .getByRole('button', { name: /Bereiche/ })
    .click();
}

/** Antippen einschalten – ohne Netz, nach Farbe. */
async function antippenAn(editor: Locator) {
  await editor.getByRole('button', { name: /Antippen aus/ }).click();
}

/** Ein Punkt der Leinwand in Filmkoordinaten (320 × 240) – als Tipp. */
async function tippen(page: Page, editor: Locator, x: number, y: number) {
  const kasten = await editor.locator('.bild-leinwand').boundingBox();
  if (!kasten) throw new Error('keine Leinwand');
  await page.mouse.click(kasten.x + (x / 320) * kasten.width, kasten.y + (y / 240) * kasten.height);
}

function bereichsKnoepfe(editor: Locator): Locator {
  return editor.getByRole('group', { name: 'Bereiche' }).getByRole('button');
}

function einstellungen(editor: Locator): Locator {
  return editor.getByRole('toolbar', { name: /^Bereich / });
}

function teileChips(editor: Locator): Locator {
  return editor.getByRole('group', { name: 'Masken des Bereichs' }).getByRole('button');
}

/**
 * Warten, bis jede Bahn fertig verfolgt ist: Alle zeigen, wo sie zu sehen sind,
 * und keine meldet „wird noch verfolgt".
 */
async function alleVerfolgt(editor: Locator, anzahl: number) {
  await expect
    .poll(
      async () => {
        const werte = await editor
          .locator('.mb-leinwand')
          .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
        if (
          werte.length !== anzahl ||
          !werte.every((w) => /^sichtbar/.test(w) && !/noch/.test(w))
        ) {
          return false;
        }
        // Die Zeile der gewählten Maske sagt es noch einmal, mit dem Anteil: erst bei 100 % ist
        // wirklich jedes Teil gerechnet (eine Bahn zeigt schon, was ein früheres Teil weiss).
        const stand = einstellungen(editor).locator('.mb-name');
        return (
          (await stand.count()) === 0 || /fertig verfolgt/.test((await stand.textContent()) ?? '')
        );
      },
      { timeout: 150_000, intervals: [500] },
    )
    .toBe(true);
}

/** Die Wiedergabestelle um Sprünge zu je zehn Bildern (0,4 s) bewegen – und das neue Stellbild abwarten. */
async function springe(editor: Locator, schritte: number) {
  const leiste = editor.getByRole('slider', { name: 'Wiedergabestelle' });
  await leiste.focus();
  const taste = schritte >= 0 ? 'Shift+ArrowRight' : 'Shift+ArrowLeft';
  for (let i = 0; i < Math.abs(schritte); i += 1) await leiste.press(taste);
  await expect(editor.locator('.bild-wiedergabe')).toBeHidden({ timeout: 30_000 });
}

/** Eine Bahn antippen (nicht wischen): sie wählt ihre Maske. */
async function bahnAntippen(page: Page, editor: Locator, nummer: number) {
  const kasten = await editor.locator('.mb-zeile').nth(nummer).boundingBox();
  if (!kasten) throw new Error(`keine Bahn ${nummer}`);
  await page.mouse.click(kasten.x + kasten.width / 2, kasten.y + kasten.height / 2);
}

/** Der Name in der Zeile der Einstellungen – ohne Stand der Verfolgung. */
async function leistenName(editor: Locator): Promise<string> {
  const name = editor.getByRole('toolbar', { name: /^Bereich / }).locator('.mb-name');
  const text = (await name.textContent()) ?? '';
  return text.replace(/\s·\s.*$/, '').trim();
}

/** Beide Gegenstände angetippt, je in einem eigenen Bereich – A in „Bereich 1", B in „Bereich 2". */
async function zweiBereicheAnlegen(page: Page, editor: Locator, szene: Szene = GETRENNT) {
  await reiterBereiche(editor);
  await antippenAn(editor);
  await tippen(page, editor, 30, 80);
  await expect(editor.locator('.mb-zeile')).toHaveCount(1, { timeout: 30_000 });
  await alleVerfolgt(editor, 1);
  await editor.getByRole('button', { name: '＋ Bereich' }).click();
  await expect(editor.locator('.mb-zeile')).toHaveCount(2, { timeout: 20_000 });
  await tippen(page, editor, szene.bx + 20, 30);
  await expect(teileChips(editor)).toHaveCount(1, { timeout: 30_000 });
  await alleVerfolgt(editor, 2);
}

/** „Fertig", „Film bauen", „Übernehmen" – danach steht der Film unter `window.fertigerFilm`. */
async function filmBauen(page: Page, editor: Locator) {
  await editor.getByRole('button', { name: 'Fertig', exact: true }).click();
  await expect(editor).toBeHidden();
  await page.getByRole('button', { name: 'Film bauen' }).click();
  await expect(page.getByRole('button', { name: 'Übernehmen' })).toBeVisible({ timeout: 300_000 });
  await page.getByRole('button', { name: 'Übernehmen' }).click();
}

interface Probe {
  readonly t: number;
  /** Kern von A: dort steht A in Quellbild n, wenn die Maske sitzt. */
  readonly a: number[];
  /** Kern von B. */
  readonly b: number[];
  /** Zwei Stellen des Grunds, die nie ein Quadrat berühren. */
  readonly grund: number[][];
}

/**
 * Den gebauten Film an `zeiten` abtasten.
 *
 * Das erste Bild nach dem Springen ist unter Last manchmal noch schwarz;
 * gewartet wird deshalb, bis der Grund da ist (höchstens 6 × 50 ms), statt
 * einen leeren Wert zu messen und dem Produkt die Schuld zu geben.
 */
async function filmAbtasten(page: Page, zeiten: number[], bx: number): Promise<Probe[]> {
  return page.evaluate(
    async ({ zeiten, bx }) => {
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
      const punkt = (x: number, y: number) => {
        const d = pctx.getImageData(Math.round(x * faktor), Math.round(y * faktor), 1, 1).data;
        return [d[0], d[1], d[2]];
      };
      const raus: unknown[] = [];
      for (const t of zeiten) {
        for (let versuch = 0; versuch < 6; versuch += 1) {
          await new Promise<void>((auf) => {
            video.onseeked = () => auf();
            video.currentTime = t;
          });
          pctx.drawImage(video, 0, 0);
          const g = punkt(10, 230);
          if (g[0] + g[1] + g[2] > 30) break;
          await new Promise((auf) => setTimeout(auf, 50));
        }
        const n = Math.floor(t * 10 + 1e-6);
        raus.push({
          t,
          // Die Mitte des SICHTBAREN Teils: Läuft A hinaus, liegt seine Mitte schon draussen.
          a: punkt(Math.floor((10 + 8 * n + Math.min(50 + 8 * n, 319)) / 2), 80),
          b: punkt(bx + 20, 30 + 4 * n),
          grund: [punkt(10, 230), punkt(150, 235)],
        });
      }
      return raus;
    },
    { zeiten, bx },
  ) as Promise<Probe[]>;
}

const grau = ([r, g, b]: number[]) => Math.abs(r - g) < 30 && Math.abs(g - b) < 30;
/** Der Grund (#24405c) bleibt bläulich. */
const blau = ([r, , b]: number[]) => b - r > 30;
/** B mit +1,5 EV: weit heller als sein Ausgangsgelb (#f0b040), die Grünstufe nahe Weiss. */
const aufgehellt = ([, g]: number[]) => g > 225;
/** B unbearbeitet (#f0b040) – kräftig gelb-orange, nicht grau, nicht aufgehellt. */
const unveraendert = ([r, g, b]: number[]) => r > 200 && g > 150 && g < 205 && b < 110;

/** Bis 3,65 s: Dann ist A (bei 3,9 s ganz draussen) noch zu mehr als der Hälfte im Bild. */
const ZEITEN = [0.05, 0.45, 0.85, 1.25, 1.65, 2.05, 2.45, 2.85, 3.25, 3.65];

test('zwei Bereiche, zwei Gegenstände: im fertigen Film trägt jeder seine eigene Bearbeitung', async ({
  page,
}) => {
  test.setTimeout(600_000);
  page.setDefaultTimeout(60_000);
  await page.setViewportSize({ width: 412, height: 880 });
  if (!(await blattMitZweiGegenstaenden(page))) {
    test.skip(true, OHNE_KODIERER);
    return;
  }
  const editor = await editorOeffnen(page);
  await zweiBereicheAnlegen(page, editor);

  // Je Bereich eigene Regler: A wird grau (Sättigung ganz nach links), B heller.
  await expect(bereichsKnoepfe(editor).nth(1)).toHaveAttribute('aria-pressed', 'true');
  await editor.getByLabel('Belichtung').first().fill('1.5');
  await bereichsKnoepfe(editor).nth(0).click();
  await editor.getByLabel('Sättigung').first().fill('-1');
  // Der Regler des ersten Bereichs steht auf −100, der des zweiten unberührt auf 0.
  await expect(editor.getByLabel('Sättigung').first()).toHaveValue('-1');
  await bereichsKnoepfe(editor).nth(1).click();
  await expect(editor.getByLabel('Sättigung').first()).toHaveValue('0');
  await expect(editor.getByLabel('Belichtung').first()).toHaveValue('1.5');

  await filmBauen(page, editor);
  const proben = await filmAbtasten(page, ZEITEN, GETRENNT.bx);
  expect(proben).toHaveLength(ZEITEN.length);
  for (const p of proben) {
    const wo = `bei ${p.t} s`;
    expect(grau(p.a), `A grau ${wo}: ${p.a}`).toBe(true);
    // B trägt NICHT die Bearbeitung von A: Er ist aufgehellt und behält seine Farbe.
    expect(aufgehellt(p.b), `B aufgehellt ${wo}: ${p.b}`).toBe(true);
    expect(grau(p.b), `B nicht grau ${wo}: ${p.b}`).toBe(false);
    for (const g of p.grund) expect(blau(g), `Grund ${wo}: ${g}`).toBe(true);
  }
});

test('ein Bereich mit Zeitraum: Satz statt Leerzustand, kein stiller neuer Bereich – und im Film wirkt er nur dort', async ({
  page,
}) => {
  test.setTimeout(600_000);
  page.setDefaultTimeout(60_000);
  await page.setViewportSize({ width: 412, height: 880 });
  if (!(await blattMitZweiGegenstaenden(page))) {
    test.skip(true, OHNE_KODIERER);
    return;
  }
  const editor = await editorOeffnen(page);
  await zweiBereicheAnlegen(page, editor);
  await editor.getByLabel('Belichtung').first().fill('1.5');
  await bereichsKnoepfe(editor).nth(0).click();
  await editor.getByLabel('Sättigung').first().fill('-1');
  await bereichsKnoepfe(editor).nth(1).click();

  // Bereich 2 gilt nur von 1,6 s bis 3,6 s.
  await springe(editor, 4);
  await einstellungen(editor).getByRole('button', { name: 'Ab hier' }).click();
  await springe(editor, 5);
  await einstellungen(editor).getByRole('button', { name: 'Bis hier' }).click();
  await expect(einstellungen(editor).getByRole('radio', { name: 'Zeitraum' })).toHaveAttribute(
    'aria-checked',
    'true',
  );

  // Davor, bei 0,4 s: Bereich 2 ist in der Zeitleiste gewählt, gilt hier aber nicht.
  await springe(editor, -8);
  await expect(bereichsKnoepfe(editor)).toHaveCount(2, { timeout: 30_000 });
  const satz = editor.getByText(/„Bereich 2“ gilt an diesem Bild nicht/);
  await expect(satz).toBeVisible();
  await expect(satz).toContainText(/von 1,[56] s bis 3,[56] s/);
  // Nicht der Leerzustand, der zum Anlegen auffordert – und keine Regler eines fremden Bereichs.
  await expect(editor.getByText(/Leg oben eine Form an/)).toHaveCount(0);
  await expect(editor.getByLabel('Sättigung')).toHaveCount(0);

  // Ein Tipp ins Bild legt NICHTS an: weder eine Bahn noch einen Bereich.
  await tippen(page, editor, 62, 80);
  await expect(editor.getByText(/„Bereich 2“ gilt an diesem Bild nicht/).first()).toBeVisible();
  await expect(editor.locator('.mb-zeile')).toHaveCount(2);
  await expect(bereichsKnoepfe(editor)).toHaveCount(2);

  // „Zur Maske" bringt die Wiedergabestelle in den Zeitraum: Der Chip erscheint und ist gewählt.
  await einstellungen(editor).getByRole('button', { name: 'Zum Bereich' }).click();
  await expect(editor.locator('.bild-wiedergabe')).toBeHidden({ timeout: 30_000 });
  await expect(bereichsKnoepfe(editor)).toHaveCount(3, { timeout: 30_000 });
  await expect(bereichsKnoepfe(editor).nth(1)).toHaveAttribute('aria-pressed', 'true');
  await expect(editor.getByText(/gilt an diesem Bild nicht/)).toHaveCount(0);

  await filmBauen(page, editor);
  const proben = await filmAbtasten(page, [0.45, 1.25, 1.85, 2.45, 3.25, 4.05], GETRENNT.bx);
  for (const p of proben) {
    const wo = `bei ${p.t} s`;
    if (p.t <= 3.25) expect(grau(p.a), `A grau ${wo}: ${p.a}`).toBe(true);
    if (p.t > 1.6 && p.t < 3.6) {
      expect(aufgehellt(p.b), `B im Zeitraum aufgehellt ${wo}: ${p.b}`).toBe(true);
    } else {
      expect(unveraendert(p.b), `B ausserhalb des Zeitraums unberührt ${wo}: ${p.b}`).toBe(true);
    }
  }
});

test('Bereich im Editor und Maske in der Zeitleiste sind EINE Auswahl – in beide Richtungen', async ({
  page,
}) => {
  test.setTimeout(600_000);
  page.setDefaultTimeout(60_000);
  await page.setViewportSize({ width: 412, height: 880 });
  if (!(await blattMitZweiGegenstaenden(page))) {
    test.skip(true, OHNE_KODIERER);
    return;
  }
  const editor = await editorOeffnen(page);
  await zweiBereicheAnlegen(page, editor);
  const saettigung = editor.getByLabel('Sättigung').first();

  // Nach dem Anlegen ist der zweite Bereich gewählt – im Editor UND in der Zeitleiste.
  await expect(bereichsKnoepfe(editor).nth(1)).toHaveAttribute('aria-pressed', 'true');
  expect(await leistenName(editor)).toBe('Bereich 2');
  await expect(editor.locator('.mb-zeile.ist-gewaehlt')).toHaveCount(1);

  // Editor → Zeitleiste: Ein Chip wählt auch die Bahn, und die Regler gehören ihm.
  await bereichsKnoepfe(editor).nth(0).click();
  expect(await leistenName(editor)).toBe('Bereich 1');
  await expect(editor.locator('.mb-zeile').nth(0)).toHaveClass(/ist-gewaehlt/);
  await saettigung.fill('-1');
  await bereichsKnoepfe(editor).nth(1).click();
  expect(await leistenName(editor)).toBe('Bereich 2');
  await expect(editor.locator('.mb-zeile').nth(1)).toHaveClass(/ist-gewaehlt/);
  await expect(saettigung).toHaveValue('0');

  // Zeitleiste → Editor: Ein Tipp auf die Bahn wählt auch den Chip, und die Regler wechseln mit.
  await bahnAntippen(page, editor, 0);
  await expect(bereichsKnoepfe(editor).nth(0)).toHaveAttribute('aria-pressed', 'true');
  await expect(bereichsKnoepfe(editor).nth(1)).toHaveAttribute('aria-pressed', 'false');
  expect(await leistenName(editor)).toBe('Bereich 1');
  await expect(saettigung).toHaveValue('-1');
  await bahnAntippen(page, editor, 1);
  await expect(bereichsKnoepfe(editor).nth(1)).toHaveAttribute('aria-pressed', 'true');
  await expect(saettigung).toHaveValue('0');

  // „Hier trennen" macht aus Bereich 2 zwei – der neue ist danach gewählt, auch im Editor.
  await springe(editor, 4);
  await einstellungen(editor).getByRole('button', { name: 'Hier trennen' }).click();
  // Am Stellbild gilt nur noch die zweite Hälfte: Bereich 1, der neue Bereich und „＋ Bereich".
  await expect(bereichsKnoepfe(editor)).toHaveCount(3, { timeout: 30_000 });
  const neu = bereichsKnoepfe(editor).nth(1);
  await expect(neu).toHaveAttribute('aria-pressed', 'true');
  // Ein Name, der weiterzählt – nicht „Bereich 2 2".
  await expect(neu).toHaveText('Bereich 3');
  expect(await leistenName(editor)).toBe('Bereich 3');

  // „Fertig" in der Zeitleiste bringt die Schnittknöpfe zurück und lässt die Wahl im Editor stehen.
  await einstellungen(editor)
    .getByRole('button', { name: /Bereich fertig/ })
    .click();
  await expect(
    editor.getByRole('button', { name: 'An der Wiedergabestelle teilen' }),
  ).toBeVisible();
  await expect(bereichsKnoepfe(editor).nth(1)).toHaveAttribute('aria-pressed', 'true');
});

test('mehrere Gegenstände in EINEM Bereich: jeder wird für sich verfolgt', async ({ page }) => {
  test.setTimeout(600_000);
  page.setDefaultTimeout(60_000);
  await page.setViewportSize({ width: 412, height: 880 });
  if (!(await blattMitZweiGegenstaenden(page))) {
    test.skip(true, OHNE_KODIERER);
    return;
  }
  const editor = await editorOeffnen(page);
  await reiterBereiche(editor);
  await antippenAn(editor);
  // Der Satz sagt es dem, der es nicht ausprobiert.
  await expect(
    editor.getByText(/Jeder Gegenstand, den du antippst, wird für sich verfolgt/),
  ).toBeVisible();

  // Der natürliche Handgriff: nacheinander beide antippen – ohne „＋ Bereich" dazwischen.
  await tippen(page, editor, 30, 80);
  await expect(teileChips(editor)).toHaveCount(1, { timeout: 30_000 });
  await alleVerfolgt(editor, 1);
  await tippen(page, editor, GETRENNT.bx + 20, 30);
  await expect(teileChips(editor)).toHaveCount(2, { timeout: 30_000 });
  // Ein Bereich, eine Bahn, ein Satz Regler.
  await expect(bereichsKnoepfe(editor)).toHaveCount(2);
  await expect(editor.locator('.mb-zeile')).toHaveCount(1);
  await alleVerfolgt(editor, 1);

  // Ein weiterer Tipp auf einen Gegenstand, der schon in der Maske liegt, ergänzt sein Teil.
  await tippen(page, editor, GETRENNT.bx + 20, 30);
  await page.waitForTimeout(500);
  await expect(teileChips(editor)).toHaveCount(2);

  await editor.getByLabel('Sättigung').first().fill('-1');
  await filmBauen(page, editor);
  const proben = await filmAbtasten(page, ZEITEN, GETRENNT.bx);
  for (const p of proben) {
    const wo = `bei ${p.t} s`;
    // Beide Gegenstände tragen die Bearbeitung des einen Bereichs – A bis über 3 s, B durchgehend.
    expect(grau(p.a), `A grau ${wo}: ${p.a}`).toBe(true);
    expect(grau(p.b), `B grau ${wo}: ${p.b}`).toBe(true);
    for (const g of p.grund) expect(blau(g), `Grund ${wo}: ${g}`).toBe(true);
  }
});

test('derselbe Gegenstand in zwei Bereichen: beide Bearbeitungen wirken, nicht nur eine', async ({
  page,
}) => {
  test.setTimeout(600_000);
  page.setDefaultTimeout(60_000);
  await page.setViewportSize({ width: 412, height: 880 });
  if (!(await blattMitZweiGegenstaenden(page))) {
    test.skip(true, OHNE_KODIERER);
    return;
  }
  const editor = await editorOeffnen(page);
  await reiterBereiche(editor);
  await antippenAn(editor);
  await tippen(page, editor, 30, 80);
  await expect(editor.locator('.mb-zeile')).toHaveCount(1, { timeout: 30_000 });
  await alleVerfolgt(editor, 1);
  await editor.getByLabel('Sättigung').first().fill('-1');
  await editor.getByRole('button', { name: '＋ Bereich' }).click();
  await expect(editor.locator('.mb-zeile')).toHaveCount(2, { timeout: 20_000 });
  await tippen(page, editor, 30, 80);
  await expect(teileChips(editor)).toHaveCount(1, { timeout: 30_000 });
  await alleVerfolgt(editor, 2);
  await editor.getByLabel('Belichtung').first().fill('1.5');

  await filmBauen(page, editor);
  const proben = await filmAbtasten(page, [0.05, 0.85, 1.65, 2.45, 3.25], GETRENNT.bx);
  for (const p of proben) {
    const wo = `bei ${p.t} s`;
    // Grau UND heller: Nur grau wäre 93, nur heller bliebe grün.
    expect(grau(p.a), `A grau ${wo}: ${p.a}`).toBe(true);
    expect(p.a[0], `A heller als nur grau ${wo}: ${p.a}`).toBeGreaterThan(125);
    // B gehört keinem Bereich.
    expect(unveraendert(p.b), `B unberührt ${wo}: ${p.b}`).toBe(true);
  }
});

test('zwei Gegenstände kreuzen sich: Hier trennen, nach der Kreuzung neu antippen, die falsche Maske wegnehmen', async ({
  page,
}) => {
  /*
   * Die Verfolgung hält zwei Gegenstände, die einander verdecken, nicht sicher
   * auseinander: Läuft B vor A vorbei, kann die Maske von A an B hängen
   * bleiben (gemessen: ab 1,6 s trägt A seine Bearbeitung nicht mehr, die graue
   * Fläche läuft als Geist neben B her). Das ist eine bekannte Grenze – dieser
   * Test hält den Weg heraus fest, der heute geht, und prüft ihn am fertigen Film:
   * Den Bereich dort trennen, wo sich die Wege treffen, den Gegenstand dahinter
   * noch einmal antippen und die alte Maske im hinteren Teil wegnehmen.
   */
  test.setTimeout(600_000);
  page.setDefaultTimeout(60_000);
  await page.setViewportSize({ width: 412, height: 880 });
  const kreuzend: Szene = { a: GETRENNT.a, b: GETRENNT.b, bx: 150 };
  if (!(await blattMitZweiGegenstaenden(page, kreuzend))) {
    test.skip(true, OHNE_KODIERER);
    return;
  }
  const editor = await editorOeffnen(page);
  await zweiBereicheAnlegen(page, editor, kreuzend);
  await editor.getByLabel('Belichtung').first().fill('1.5');
  await bereichsKnoepfe(editor).nth(0).click();
  await editor.getByLabel('Sättigung').first().fill('-1');

  // Bei 1,6 s trennen: Davor bleibt die Verfolgung von A gut, danach beginnt der Geist.
  await springe(editor, 4);
  await einstellungen(editor).getByRole('button', { name: 'Hier trennen' }).click();
  // Am Stellbild gilt nur noch die hintere Hälfte – sie heisst weitergezählt, „Bereich 3".
  await expect(bereichsKnoepfe(editor).nth(0)).toHaveText('Bereich 3', { timeout: 30_000 });

  // Nach der Kreuzung (2,8 s) steht A frei: dort neu antippen, die alte Maske wegnehmen.
  await springe(editor, 3);
  await tippen(page, editor, 254, 80);
  await expect(teileChips(editor)).toHaveCount(2, { timeout: 30_000 });
  await teileChips(editor).first().click();
  await editor.getByRole('button', { name: '🗑 Maske' }).click();
  await expect(teileChips(editor)).toHaveCount(1);
  await expect(einstellungen(editor).locator('.mb-name')).toContainText('fertig verfolgt', {
    timeout: 150_000,
  });

  await filmBauen(page, editor);
  const proben = await filmAbtasten(page, [0.05, 0.85, 1.25, 2.05, 2.45, 3.05, 3.45], kreuzend.bx);
  for (const p of proben) {
    const wo = `bei ${p.t} s`;
    // A trägt seine Bearbeitung vor UND hinter der Kreuzung, B durchgehend die seine.
    expect(grau(p.a), `A grau ${wo}: ${p.a}`).toBe(true);
    expect(aufgehellt(p.b), `B aufgehellt ${wo}: ${p.b}`).toBe(true);
  }
});

/**
 * Der Fotoeditor auf derselben Bühne – dasselbe Reiter-Gerüst ohne Zeitleiste.
 * Für die Stellen, an denen Foto und Video gleich sein sollen (oder ausdrücklich nicht).
 */
async function fotoEditorOeffnen(page: Page): Promise<Locator> {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.evaluate(async () => {
    const leinwand = document.createElement('canvas');
    leinwand.width = 320;
    leinwand.height = 240;
    const ctx = leinwand.getContext('2d') as CanvasRenderingContext2D;
    ctx.fillStyle = '#24405c';
    ctx.fillRect(0, 0, 320, 240);
    ctx.fillStyle = '#f0b040';
    ctx.fillRect(100, 80, 60, 60);
    const bild = await new Promise<Blob>((fertig, fehler) =>
      leinwand.toBlob(
        (blob) => (blob ? fertig(blob) : fehler(new Error('kein Bild'))),
        'image/png',
      ),
    );
    const buehnePfad = '/e2e/buehne.ts';
    const buehne = (await import(/* @vite-ignore */ buehnePfad)) as typeof import('./buehne.js');
    buehne.fotoEditorZeigen(bild);
  });
  const editor = page.locator('.bild-editor');
  await expect(editor.locator('.bild-leinwand')).toBeVisible({ timeout: 30_000 });
  return editor;
}

/** „＋ Bereich" so oft drücken – `schon` Bereiche gibt es dann bereits. Bei vier verschwindet der Knopf. */
async function neuerBereich(editor: Locator, wieviele: number, schon = 0) {
  for (let i = schon + 1; i <= schon + wieviele; i += 1) {
    await editor.getByRole('button', { name: '＋ Bereich' }).click();
    await expect(bereichsKnoepfe(editor)).toHaveCount(i + (i < 4 ? 1 : 0), { timeout: 20_000 });
  }
}

for (const [breite, hoehe] of [
  [375, 667],
  [412, 880],
] as const) {
  test(`die Einstellungen der Maske sind auf dem Telefon bedienbar, ohne zu wischen (${breite} Punkte)`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: breite, height: hoehe });
    if (!(await blattMitZweiGegenstaenden(page))) {
      test.skip(true, OHNE_KODIERER);
      return;
    }
    const editor = await editorOeffnen(page);
    await reiterBereiche(editor);
    await neuerBereich(editor, 1);
    const leiste = einstellungen(editor);
    await expect(leiste).toBeVisible();
    const schieber = leiste.locator('.mb-schieber');

    /** Liegt der Knopf ganz im Fenster UND ganz im sichtbaren Teil des Schiebers? */
    const ganzSichtbar = async (knopf: Locator, imSchieber: boolean) => {
      const k = await knopf.boundingBox();
      const rahmen = await schieber.boundingBox();
      if (!k || !rahmen) throw new Error('keine Box');
      const wo = `${k.x}…${k.x + k.width} im Fenster ${breite}, Schieber ${rahmen.x}…${rahmen.x + rahmen.width}`;
      expect(k.x, `links ${wo}`).toBeGreaterThanOrEqual(0);
      expect(k.x + k.width, `rechts ${wo}`).toBeLessThanOrEqual(breite);
      if (imSchieber) {
        expect(k.x, `Schieber links ${wo}`).toBeGreaterThanOrEqual(rahmen.x - 0.5);
        expect(k.x + k.width, `Schieber rechts ${wo}`).toBeLessThanOrEqual(
          rahmen.x + rahmen.width + 0.5,
        );
      }
    };

    // Ohne Wischen: Abspielen, Name, „Ganzer Film", „Zeitraum", Ein/Aus und „Fertig".
    await ganzSichtbar(leiste.getByRole('button', { name: 'Abspielen' }), false);
    await ganzSichtbar(leiste.locator('.mb-name'), true);
    await ganzSichtbar(leiste.getByRole('radio', { name: 'Ganzer Film' }), true);
    await ganzSichtbar(leiste.getByRole('radio', { name: 'Zeitraum' }), true);
    await ganzSichtbar(leiste.getByRole('button', { name: /wirkt/ }), true);
    await ganzSichtbar(leiste.getByRole('button', { name: /Bereich fertig/ }), false);
    // Auf dem breiteren Telefon passt auch „Löschen" noch dazu.
    if (breite >= 412) await ganzSichtbar(leiste.getByRole('button', { name: /löschen/ }), true);

    // Der Rest liegt im Schieber – und ist erreichbar, mit „Fertig" fest daneben.
    await schieber.evaluate((e) => {
      e.scrollLeft = e.scrollWidth;
    });
    await ganzSichtbar(leiste.getByRole('button', { name: 'Hier trennen' }), true);
    const fertig = leiste.getByRole('button', { name: /Bereich fertig/ });
    await ganzSichtbar(fertig, false);
    // Nichts schiebt sich darüber: An seiner Mitte liegt „Fertig" selbst.
    const mitte = await fertig.boundingBox();
    if (!mitte) throw new Error('kein Fertig');
    const oben = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x, y)?.closest('button')?.getAttribute('aria-label'),
      [mitte.x + mitte.width / 2, mitte.y + mitte.height / 2],
    );
    expect(oben).toMatch(/Bereich fertig/);

    // Ein Satz in der Zeile: Die Bühne bleibt gross genug.
    const buehne = await editor.locator('.bild-buehne').boundingBox();
    expect(buehne?.height ?? 0, 'Höhe der Bühne').toBeGreaterThanOrEqual(
      breite === 375 ? 150 : 200,
    );
  });
}

test('jeder Bereich trägt seine Farbe als Punkt – und lässt sich umbenennen', async ({ page }) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(60_000);
  await page.setViewportSize({ width: 412, height: 880 });
  if (!(await blattMitZweiGegenstaenden(page))) {
    test.skip(true, OHNE_KODIERER);
    return;
  }
  const editor = await editorOeffnen(page);
  await reiterBereiche(editor);
  await neuerBereich(editor, 2);

  // Die Farbe im Chip ist die der Bahn und der Zeile der Einstellungen – für jeden Bereich.
  const punktFarbe = (stelle: Locator) =>
    stelle.locator('.mb-punkt').evaluate((e) => getComputedStyle(e).backgroundColor);
  const farben: string[] = [];
  for (const nummer of [0, 1]) {
    await bereichsKnoepfe(editor).nth(nummer).click();
    const imChip = await punktFarbe(bereichsKnoepfe(editor).nth(nummer));
    const inDerLeiste = await punktFarbe(einstellungen(editor).locator('.mb-name'));
    expect(imChip, `Chip ${nummer + 1} und Zeile`).toBe(inDerLeiste);
    const inDerBahn = await editor
      .locator('.mb-zeile')
      .nth(nummer)
      .evaluate(
        (e) => getComputedStyle(e.querySelector('.mb-streifen') as Element).backgroundColor,
      );
    expect(imChip, `Chip ${nummer + 1} und Bahn`).toBe(inDerBahn);
    farben.push(imChip);
  }
  expect(farben[0]).not.toBe(farben[1]);

  // Umbenennen: Chip, Zeile und Bahn tragen den neuen Namen.
  await bereichsKnoepfe(editor).nth(0).click();
  const name = editor.getByRole('textbox', { name: 'Name' });
  await name.fill('Läufer');
  await expect(bereichsKnoepfe(editor).nth(0)).toContainText('Läufer');
  expect(await leistenName(editor)).toBe('Läufer');
  await expect(editor.locator('.mb-zeile').nth(0)).toHaveAttribute(
    'aria-label',
    /^Bereich Läufer,/,
  );
  // Der Zweite bleibt, wie er heisst.
  await expect(bereichsKnoepfe(editor).nth(1)).toHaveText('Bereich 2');

  // ↺ stellt den Namen wieder her – in einem Schritt, nicht Buchstabe für Buchstabe.
  await editor.getByRole('button', { name: 'Rückgängig' }).click();
  await expect(bereichsKnoepfe(editor).nth(0)).toHaveText('Bereich 1');
  await expect(editor.locator('.mb-zeile').nth(0)).toHaveAttribute(
    'aria-label',
    /^Bereich Bereich 1,/,
  );

  // Ein leerer Name bleibt nicht leer: Nach dem Verlassen des Feldes steht wieder der Standardname da.
  await name.fill('');
  await name.blur();
  await expect(bereichsKnoepfe(editor).nth(0)).toHaveText('Bereich 1');
});

test('derselbe Name im Foto: Namensfeld, Farbe gibt es dort nicht', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 412, height: 880 });
  const editor = await fotoEditorOeffnen(page);
  await reiterBereiche(editor);
  await neuerBereich(editor, 1);
  const name = editor.getByRole('textbox', { name: 'Name' });
  await name.fill('Himmel');
  await expect(bereichsKnoepfe(editor).nth(0)).toHaveText('Himmel');
  // Der Farbpunkt gehört zur Bahn in der Zeitleiste – ohne Zeitleiste kein Punkt.
  await expect(editor.locator('.mb-punkt')).toHaveCount(0);
});

test('„＋ Bereich" gibt es auch an der Zeitleiste – von jedem Reiter aus', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 412, height: 880 });
  if (!(await blattMitZweiGegenstaenden(page))) {
    test.skip(true, OHNE_KODIERER);
    return;
  }
  const editor = await editorOeffnen(page);
  await reiterBereiche(editor);
  await neuerBereich(editor, 1);
  await einstellungen(editor)
    .getByRole('button', { name: /Bereich fertig/ })
    .click();

  // Auf einem anderen Reiter: ◐ → Namenswahl → „＋ Bereich".
  await editor.locator('.bild-reiter').getByRole('button', { name: /Ton/ }).click();
  await expect(editor.getByRole('group', { name: 'Bereiche' })).toHaveCount(0);
  await editor.getByRole('button', { name: 'Bereich wählen' }).click();
  const wahl = editor.getByRole('toolbar', { name: 'Bereich wählen' });
  await wahl.getByRole('button', { name: '＋ Bereich' }).click();

  // Der Reiter „Bereiche" ist aufgegangen, der neue Bereich da und überall gewählt.
  await expect(editor.locator('.bild-reiter-knopf.is-active')).toContainText('Bereiche');
  await expect(bereichsKnoepfe(editor)).toHaveCount(3, { timeout: 20_000 });
  await expect(bereichsKnoepfe(editor).nth(1)).toHaveAttribute('aria-pressed', 'true');
  await expect(editor.locator('.mb-zeile')).toHaveCount(2);
  expect(await leistenName(editor)).toBe('Bereich 2');

  // Bei vier Bereichen fehlt der Knopf – er brächte nur eine Absage.
  await neuerBereich(editor, 2, 2);
  await einstellungen(editor)
    .getByRole('button', { name: /Bereich fertig/ })
    .click();
  await editor.getByRole('button', { name: 'Bereich wählen' }).click();
  await expect(
    editor
      .getByRole('toolbar', { name: 'Bereich wählen' })
      .getByRole('button', { name: '＋ Bereich' }),
  ).toHaveCount(0);
});

test('bei vier Bereichen sagt der Editor, warum kein fünfter geht – im Video wie im Foto', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 412, height: 880 });
  if (!(await blattMitZweiGegenstaenden(page))) {
    test.skip(true, OHNE_KODIERER);
    return;
  }
  const video = await editorOeffnen(page);
  await reiterBereiche(video);
  await expect(video.getByText(/Mehr als 4 Bereiche gehen nicht/)).toHaveCount(0);
  await neuerBereich(video, 4);
  await expect(video.getByRole('button', { name: '＋ Bereich' })).toHaveCount(0);
  await expect(
    video.getByText(/Mehr als 4 Bereiche gehen nicht – lösch einen, oder tipp weitere Gegenstände/),
  ).toBeVisible();

  const foto = await fotoEditorOeffnen(page);
  await reiterBereiche(foto);
  await neuerBereich(foto, 4);
  await expect(foto.getByRole('button', { name: '＋ Bereich' })).toHaveCount(0);
  await expect(foto.getByText(/Mehr als 4 Bereiche gehen nicht – lösch einen\./)).toBeVisible();
});

test('im Video bleibt eine Form an der Szene – das steht da; im Foto nicht', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 412, height: 880 });
  if (!(await blattMitZweiGegenstaenden(page))) {
    test.skip(true, OHNE_KODIERER);
    return;
  }
  const hinweis = /Diese Form bleibt an der Szene/;
  const video = await editorOeffnen(page);
  await reiterBereiche(video);
  await expect(video.getByText(hinweis)).toHaveCount(0);
  await video
    .getByRole('button', { name: /Verlauf/ })
    .first()
    .click();
  await expect(video.getByRole('group', { name: 'Masken des Bereichs' })).toBeVisible();
  await expect(video.getByText(hinweis)).toBeVisible();
  // Mit eingeschaltetem Antippen geht es um einen Gegenstand, nicht um die Form – der Satz tritt zurück.
  await antippenAn(video);
  await expect(video.getByText(hinweis)).toHaveCount(0);

  const foto = await fotoEditorOeffnen(page);
  await reiterBereiche(foto);
  await foto
    .getByRole('button', { name: /Verlauf/ })
    .first()
    .click();
  await expect(foto.getByRole('group', { name: 'Masken des Bereichs' })).toBeVisible();
  await expect(foto.getByText(hinweis)).toHaveCount(0);
});
