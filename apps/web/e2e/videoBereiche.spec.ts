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
  return editor.getByRole('toolbar', { name: /^Maske / });
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
  const name = editor.getByRole('toolbar', { name: /^Maske / }).locator('.mb-name');
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
  /** Ob A zu dieser Zeit noch mit seinem Kern im Bild ist. */
  readonly aImBild: boolean;
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
          a: punkt(30 + 8 * n, 80),
          b: punkt(bx + 20, 30 + 4 * n),
          grund: [punkt(10, 230), punkt(150, 235)],
          aImBild: 30 + 8 * n < 316,
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

const ZEITEN = [0.05, 0.45, 0.85, 1.25, 1.65, 2.05, 2.45, 2.85, 3.25];

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
  await einstellungen(editor).getByRole('button', { name: 'Zur Maske' }).click();
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
    .getByRole('button', { name: /Maske fertig/ })
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
