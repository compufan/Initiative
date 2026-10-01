import { test } from '@playwright/test';
import { antippen, blattMitZweiGegenstaenden, bereichsKnoepfe, editorOeffnen, einstellungen, foto, notiere, zustand, zweiBereiche, springe } from './gemeinsam';

test('C3: Tipp, solange der gewählte Bereich am Bild fehlt', async ({ page }) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(40_000);
  await page.setViewportSize({ width: 412, height: 880 });
  if (!(await blattMitZweiGegenstaenden(page))) { test.skip(true, 'kein Kodierer'); return; }
  const editor = await editorOeffnen(page);
  await zweiBereiche(page, editor);
  const leiste = einstellungen(editor);
  await springe(page, editor, 4);
  await leiste.getByRole('button', { name: 'Ab hier' }).click();
  await springe(page, editor, 5);
  await leiste.getByRole('button', { name: 'Bis hier' }).click();
  await page.waitForTimeout(1500);
  await springe(page, editor, -8);
  notiere(`C3 vor Tipp: ${JSON.stringify(await zustand(editor))}`);
  // A steht bei 0,4 s (Quellbild 4) bei x = 10 + 32 = 42 … 82, y = 60 … 100
  await antippen(page, editor, 62, 80);
  await page.waitForTimeout(3000);
  await foto(page, 'c3-01-tipp-ausserhalb');
  notiere(`C3 nach Tipp: ${JSON.stringify(await zustand(editor))}`);
});
