import { test } from '@playwright/test';
import { antippen, blattMitZweiGegenstaenden, bereichsKnoepfe, editorOeffnen, foto, notiere, reiterBereiche, warteAufFertig, filmAbtasten, filmBogen, zustand } from './gemeinsam';

/** Ein Bereich, zwei TEILE: A ohne Netz, B mit Netz – jedes Teil hat eigene Anker und eigene Ketten. */
test('D2: ein Bereich, zwei Tippteile (A ohne Netz, B mit Netz)', async ({ page }) => {
  test.setTimeout(900_000);
  page.setDefaultTimeout(120_000);
  page.on('pageerror', (e) => notiere(`SEITENFEHLER ${e.message}`));
  await page.setViewportSize({ width: 412, height: 880 });
  const bx = 230;
  if (!(await blattMitZweiGegenstaenden(page, { a: '#107030', b: '#f0b040', bx }))) { test.skip(true, 'kein Kodierer'); return; }
  const editor = await editorOeffnen(page);
  await reiterBereiche(editor);
  await editor.getByRole('button', { name: /Antippen aus/ }).click();
  await antippen(page, editor, 30, 80);
  await page.waitForTimeout(1500);
  await warteAufFertig(editor, 200_000);
  await editor.getByRole('button', { name: /mit Netz/ }).click();
  await page.waitForTimeout(500);
  await antippen(page, editor, bx + 20, 30);
  await page.waitForTimeout(3000);
  await warteAufFertig(editor, 400_000);
  notiere(`D2 Teile: ${JSON.stringify((await zustand(editor)).teile)}`);
  await editor.getByLabel('Sättigung').first().fill('-1');
  await page.waitForTimeout(4000);
  notiere(`D2 Bahnen: ${JSON.stringify(await editor.locator('.mb-leinwand').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label'))))}`);
  await foto(page, 'd2-01-ein-bereich-zwei-teile');
  await editor.getByRole('button', { name: 'Fertig', exact: true }).click();
  await page.getByRole('button', { name: 'Film bauen' }).click();
  await page.getByRole('button', { name: 'Übernehmen' }).waitFor({ timeout: 600_000 });
  await page.getByRole('button', { name: 'Übernehmen' }).click();
  const zeiten: number[] = [];
  for (let t = 0.05; t < 4.95; t += 0.4) zeiten.push(Math.round(t * 100) / 100);
  const erg = await filmAbtasten(page, zeiten, [], bx);
  for (const r of erg.reihe as any[]) {
    notiere(`D2 t=${r.t} n=${r.n} A:${r.aKern}${r.aSichtbar ? '' : '(aus)'} Ae:${r.aEcke} | B:${r.bKern} Be:${r.bEcke}`);
  }
  await filmBogen(page, [0.05, 0.85, 1.65, 2.45, 3.25, 4.05], 'd2-bogen', 3);
});
