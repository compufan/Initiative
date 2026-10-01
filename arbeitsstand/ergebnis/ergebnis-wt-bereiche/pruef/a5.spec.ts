import { test } from '@playwright/test';
import { blattMitZweiGegenstaenden, bereichsKnoepfe, editorOeffnen, einstellungen, foto, notiere, zustand, zweiBereiche, filmAbtasten } from './gemeinsam';

test('A5: zwei Bereiche über den ganzen Film, Ende von A', async ({ page }) => {
  test.setTimeout(400_000);
  page.setDefaultTimeout(60_000);
  page.on('pageerror', (e) => notiere(`SEITENFEHLER ${e.message}`));
  await page.setViewportSize({ width: 412, height: 880 });
  if (!(await blattMitZweiGegenstaenden(page))) { test.skip(true, 'kein Kodierer'); return; }
  const editor = await editorOeffnen(page);
  await zweiBereiche(page, editor);
  await bereichsKnoepfe(editor).first().click();
  await editor.getByLabel('Sättigung').first().fill('-1');
  await bereichsKnoepfe(editor).nth(1).click();
  await editor.getByLabel('Belichtung').first().fill('1.5');
  await page.waitForTimeout(6000);
  notiere(`A5 Bahnen: ${JSON.stringify(await editor.locator('.mb-leinwand').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label'))))}`);
  await foto(page, 'a5-01-vor-fertig');
  await editor.getByRole('button', { name: 'Fertig', exact: true }).click();
  await page.getByRole('button', { name: 'Film bauen' }).click();
  await page.getByRole('button', { name: 'Übernehmen' }).waitFor({ timeout: 300_000 });
  await page.getByRole('button', { name: 'Übernehmen' }).click();
  const zeiten: number[] = [];
  for (let t = 0.05; t < 4.95; t += 0.2) zeiten.push(Math.round(t * 100) / 100);
  const erg = await filmAbtasten(page, zeiten, [
    { zeit: 1.85, datei: 'a5-film-1850' },
    { zeit: 3.65, datei: 'a5-film-3650' },
    { zeit: 4.45, datei: 'a5-film-4450' },
  ]);
  for (const r of erg.reihe as any[]) {
    notiere(`A5 t=${r.t} n=${r.n} A:${r.aKern}${r.aSichtbar ? '' : ' (draussen)'} Aecke:${r.aEcke} | B:${r.bKern} Becke:${r.bEcke} | grund ${r.grund1} ${r.grund2}`);
  }
});
