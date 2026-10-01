import { test } from '@playwright/test';
import { antippen, blattMitZweiGegenstaenden, bereichsKnoepfe, editorOeffnen, einstellungen, foto, notiere, reiterBereiche } from './gemeinsam';

test('A1: Blatt, Editor, Reiter Bereiche, erstes Antippen', async ({ page }) => {
  test.setTimeout(600_000);
  page.on('pageerror', (e) => notiere(`SEITENFEHLER ${e.message}`));
  await page.setViewportSize({ width: 412, height: 880 });
  if (!(await blattMitZweiGegenstaenden(page))) { test.skip(true, 'kein Kodierer'); return; }
  await foto(page, 'a1-00-blatt');
  const editor = await editorOeffnen(page);
  await foto(page, 'a1-01-editor-start');
  await reiterBereiche(editor);
  await foto(page, 'a1-02-reiter-bereiche');
  notiere(`Bereichsknöpfe: ${await bereichsKnoepfe(editor).allTextContents()}`);
  await editor.getByRole('button', { name: /Antippen aus/ }).click();
  await foto(page, 'a1-03-antippen-an');
  await antippen(page, editor, 30, 80);
  await page.waitForTimeout(3000);
  await foto(page, 'a1-04-a-angetippt');
  notiere(`Bahnzeilen: ${await editor.locator('.mb-zeile').count()}`);
  notiere(`Einstellungsleiste sichtbar: ${await einstellungen(editor).isVisible()}`);
  notiere(`Bereichsknöpfe: ${await bereichsKnoepfe(editor).allTextContents()}`);
});
