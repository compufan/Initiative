import { expect, test, type Page } from '@playwright/test';
import { bisLeerSpielen, credentials, spiegelStarten } from './pressenHilfen.js';

/**
 * Pressen: Das Bier lebt – und bleibt ruhig, wenn der Nutzer „Bewegung reduzieren“
 * eingestellt hat. Gemessen wird, was in der SVG steht: Tropfen (Kreise mit Radius
 * größer null) und der Pegel im Glas.
 */

async function anmelden(page: Page) {
  const user = credentials('bier');
  await page.goto('/');
  await page.getByRole('button', { name: /Noch kein Konto/ }).click();
  await page.getByLabel('Benutzername').fill(user.username);
  await page.getByLabel('Anzeigename').fill(user.displayName);
  await page.getByLabel('Passwort', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Konto erstellen' }).click();
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible();
}

/** Spielt einen Lauf bis „leer“ und zählt dabei jedes Bild, in dem Tropfen zu sehen sind. */
async function lauf(page: Page) {
  await spiegelStarten(page);
  await page.getByTestId('pressen-anstossen').click();
  await expect(page.getByTestId('pressen-feld')).toHaveAttribute('data-phase', 'laeuft', {
    timeout: 2000,
  });
  const beobachter = page.evaluate(
    () =>
      new Promise<{ tropfenBilder: number; hoechste: number; pegelBilder: number; bilder: number }>(
        (fertig) => {
          const feld = document.querySelector<HTMLElement>('[data-testid="pressen-feld"]')!;
          const gruppe = feld.querySelector('[data-testid="pressen-tropfen"]')!;
          let tropfenBilder = 0;
          let hoechste = 0;
          let pegelBilder = 0;
          let bilder = 0;
          const takt = () => {
            bilder += 1;
            const sichtbar = [...gruppe.querySelectorAll('circle')].filter(
              (c) => c.r.baseVal.value > 0,
            ).length;
            if (sichtbar > 0) tropfenBilder += 1;
            hoechste = Math.max(hoechste, sichtbar);
            // Der Pegel: ein Rechteck im Glas hat Höhe, solange Bier drin ist.
            const bier = feld.querySelector(
              '.pf-glas rect[fill="#e8a317"]',
            ) as SVGRectElement | null;
            if (bier && bier.height.baseVal.value > 0) pegelBilder += 1;
            if (feld.dataset.leer === '1') {
              fertig({ tropfenBilder, hoechste, pegelBilder, bilder });
              return;
            }
            requestAnimationFrame(takt);
          };
          requestAnimationFrame(takt);
        },
      ),
  );
  await bisLeerSpielen(page);
  return beobachter;
}

test('Das Bier lebt: Tropfen fliegen, der Pegel steht im Glas, nach dem Leeren hängen Schaumreste', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ reducedMotion: 'no-preference' });
  const page = await context.newPage();
  await anmelden(page);
  const m = await lauf(page);
  expect(m.hoechste).toBeGreaterThanOrEqual(3);
  expect(m.tropfenBilder).toBeGreaterThan(20);
  expect(m.pegelBilder).toBeGreaterThan(100);
  // Leeres Glas: Schaumreste an der Wand, kein Bier mehr im Pegel.
  const feld = page.getByTestId('pressen-feld');
  await expect(feld).toHaveAttribute('data-leer', '1');
  await page.waitForTimeout(500);
  const rest = await page.evaluate(() => {
    const f = document.querySelector('[data-testid="pressen-feld"]')!;
    const kreise = [
      ...f.querySelectorAll('.pf-glas g[opacity="0.9"] circle'),
    ] as SVGCircleElement[];
    const bier = f.querySelector('.pf-glas rect[fill="#e8a317"]') as SVGRectElement;
    return {
      reste: kreise.filter((c) => c.r.baseVal.value > 0).length,
      pegel: bier.height.baseVal.value,
    };
  });
  expect(rest.reste).toBeGreaterThanOrEqual(2);
  expect(rest.pegel).toBeLessThan(1);
  await context.close();
});

test('Bewegung reduzieren: dieselbe Darstellung, aber keine Tropfen und kein Schwappen', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  await anmelden(page);
  const m = await lauf(page);
  // Der Pegel ist da (ruhig und lesbar), Tropfen gibt es nicht.
  expect(m.pegelBilder).toBeGreaterThan(100);
  expect(m.hoechste).toBe(0);
  await context.close();
});
