import { test } from '@playwright/test';
import { blattMitZweiGegenstaenden, bereichsKnoepfe, editorOeffnen, foto, notiere, reiterBereiche, filmAbtasten, filmBogen, zustand } from './gemeinsam';

test('F1: Formbereich (Radial) im Video – folgt er den Gegenständen?', async ({ page }) => {
  test.setTimeout(400_000);
  page.setDefaultTimeout(60_000);
  await page.setViewportSize({ width: 412, height: 880 });
  const bx = 230;
  if (!(await blattMitZweiGegenstaenden(page, { a: '#107030', b: '#f0b040', bx, muster: true }))) { test.skip(true, 'kein Kodierer'); return; }
  const editor = await editorOeffnen(page);
  await reiterBereiche(editor);
  await editor.getByRole('button', { name: '◎ Radial' }).click();
  await page.waitForTimeout(2500);
  await editor.getByLabel('Sättigung').first().fill('-1');
  await page.waitForTimeout(1500);
  await foto(page, 'f1-01-radial-muster');
  notiere(`F1m Zustand: ${JSON.stringify(await zustand(editor))}`);
  notiere(`F1m Hinweise: ${JSON.stringify((await editor.locator('.bild-hinweis, .mb-lage').allTextContents()).map((t) => t.trim().slice(0, 110)))}`);
  await editor.getByRole('button', { name: 'Fertig', exact: true }).click();
  await page.getByRole('button', { name: 'Film bauen' }).click();
  await page.getByRole('button', { name: 'Übernehmen' }).waitFor({ timeout: 300_000 });
  await page.getByRole('button', { name: 'Übernehmen' }).click();
  const zeiten: number[] = [];
  for (let t = 0.05; t < 4.95; t += 0.4) zeiten.push(Math.round(t * 100) / 100);
  const erg = await filmAbtasten(page, zeiten, [], bx);
  for (const r of erg.reihe as any[]) notiere(`F1m t=${r.t} n=${r.n} A:${r.aKern}${r.aSichtbar ? '' : '(aus)'} | B:${r.bKern}`);
  await filmBogen(page, [0.05, 0.85, 1.65, 2.45, 3.25, 4.05], 'f1-muster-bogen', 3);
});
