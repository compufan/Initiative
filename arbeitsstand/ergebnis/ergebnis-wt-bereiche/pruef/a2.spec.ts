import { test } from '@playwright/test';
import { antippen, blattMitZweiGegenstaenden, bereichsKnoepfe, editorOeffnen, einstellungen, foto, notiere, reiterBereiche, zustand, warteAufFertig } from './gemeinsam';

test('A2: zwei Bereiche, zwei Gegenstände', async ({ page }) => {
  test.setTimeout(900_000);
  page.on('pageerror', (e) => notiere(`SEITENFEHLER ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') notiere(`KONSOLE ${m.text()}`); });
  await page.setViewportSize({ width: 412, height: 880 });
  if (!(await blattMitZweiGegenstaenden(page))) { test.skip(true, 'kein Kodierer'); return; }
  const editor = await editorOeffnen(page);
  await reiterBereiche(editor);
  await editor.getByRole('button', { name: /Antippen aus/ }).click();
  await antippen(page, editor, 30, 80);
  await warteAufFertig(editor);
  notiere(`nach A-Tipp: ${JSON.stringify(await zustand(editor))}`);

  await editor.getByRole('button', { name: '＋ Bereich' }).click();
  await page.waitForTimeout(1500);
  await foto(page, 'a2-01-plus-bereich');
  notiere(`nach ＋ Bereich: ${JSON.stringify(await zustand(editor))}`);

  // B liegt an Bild 0 bei (170, 30)
  await antippen(page, editor, 170, 30);
  await page.waitForTimeout(2500);
  await foto(page, 'a2-02-b-angetippt');
  notiere(`nach B-Tipp: ${JSON.stringify(await zustand(editor))}`);
  await warteAufFertig(editor);
  await foto(page, 'a2-03-b-fertig');
  notiere(`nach B fertig: ${JSON.stringify(await zustand(editor))}`);

  // Jetzt im Editor Bereich 1 wählen
  const knoepfe = bereichsKnoepfe(editor);
  notiere(`Knöpfe: ${await knoepfe.allTextContents()}`);
  await knoepfe.first().click();
  await page.waitForTimeout(800);
  await foto(page, 'a2-04-bereich1-im-editor-gewaehlt');
  notiere(`nach Klick auf ersten Bereichsknopf: ${JSON.stringify(await zustand(editor))}`);
});
