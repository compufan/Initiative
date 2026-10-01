import { test } from '@playwright/test';
import { antippen, blattMitZweiGegenstaenden, bereichsKnoepfe, editorOeffnen, foto, notiere, reiterBereiche, warteAufFertig, filmAbtasten, filmBogen, springe, zustand } from './gemeinsam';

test('U3: Kreuzen, trennen und zweiter Tipp', async ({ page }) => {
  test.setTimeout(900_000);
  page.setDefaultTimeout(80_000);
  page.on('pageerror', (e) => notiere(`SEITENFEHLER ${e.message}`));
  await page.setViewportSize({ width: 412, height: 880 });
  if (!(await blattMitZweiGegenstaenden(page, { a: '#107030', b: '#f0b040', bx: 150 } as never))) { test.skip(true, 'kein Kodierer'); return; }
  const editor = await editorOeffnen(page);
  await reiterBereiche(editor);
  await editor.getByRole('button', { name: /Antippen aus/ }).click();
  await antippen(page, editor, 30, 80);
  await warteAufFertig(editor);
  await editor.getByLabel('Sättigung').first().fill('-1');
  await editor.getByRole('button', { name: '＋ Bereich' }).click();
  await page.waitForTimeout(1200);
  await antippen(page, editor, 170, 30);
  await page.waitForTimeout(2000);
  await warteAufFertig(editor);
  await editor.getByLabel('Belichtung').first().fill('1.5');
  notiere(`U3 angelegt: ${JSON.stringify(await zustand(editor))}`);
  // Bereich 1 wählen, bei 1,6 s trennen
  await bereichsKnoepfe(editor).first().click();
  await springe(page, editor, 4);
  await editor.getByRole('toolbar', { name: /^Bereich / }).getByRole('button', { name: 'Hier trennen' }).click();
  await page.waitForTimeout(3000);
  notiere(`U3 nach Trennen: ${JSON.stringify(await zustand(editor))}`);
  await springe(page, editor, 3);
  await foto(page, 'u3-01-bei-2-8');
  await page.waitForTimeout(1000);
  notiere(`U3 bei 2,8: ${JSON.stringify(await zustand(editor))}`);
  notiere(`U3 vor Tipp 2: ${JSON.stringify(await zustand(editor))}`);
  await antippen(page, editor, 254, 80);
  await page.waitForTimeout(2500);
  await warteAufFertig(editor);
  await foto(page, 'u3-02-nach-tipp');
  notiere(`U3 nach Tipp 2: ${JSON.stringify(await zustand(editor))}`);
  // Falsche (erste) Maske des Bereichs 1 wegnehmen
  const teile = editor.getByRole('group', { name: 'Masken des Bereichs' }).getByRole('button');
  const anzahl = await teile.count();
  notiere(`U3 Teile: ${anzahl}`);
  if (anzahl >= 2) {
    await teile.first().click();
    await editor.getByRole('button', { name: '🗑 Maske' }).click();
    await page.waitForTimeout(2500);
    await warteAufFertig(editor);
    notiere(`U3 nach Löschen: ${JSON.stringify(await zustand(editor))}`);
  }
  await foto(page, 'u3-03-fertig');
  await editor.getByRole('button', { name: 'Fertig', exact: true }).click();
  await page.getByRole('button', { name: 'Film bauen' }).click();
  await page.getByRole('button', { name: 'Übernehmen' }).waitFor({ timeout: 300_000 });
  await page.getByRole('button', { name: 'Übernehmen' }).click();
  const zeiten: number[] = [];
  for (let t = 0.05; t < 4.0; t += 0.2) zeiten.push(Math.round(t * 100) / 100);
  const erg = await filmAbtasten(page, zeiten, [], 150);
  for (const r of erg.reihe as any[]) notiere(`U3 t=${r.t} n=${r.n} A:${r.aKern}${r.aSichtbar ? '' : '(aus)'} | B:${r.bKern}`);
  await filmBogen(page, [0.45, 1.05, 1.45, 1.65, 1.85, 2.05, 2.25, 2.45, 2.65, 3.05, 3.45, 3.85], 'u3-bogen', 6);
});
