import { test } from '@playwright/test';
import { blattMitZweiGegenstaenden, bereichsKnoepfe, editorOeffnen, einstellungen, foto, notiere, zustand, zweiBereiche, springe } from './gemeinsam';

test('C2: Zeitraum, Bereich fehlt am Bild, trennen, löschen, ↺', async ({ page }) => {
  test.setTimeout(400_000);
  page.setDefaultTimeout(40_000);
  page.on('pageerror', (e) => notiere(`SEITENFEHLER ${e.message}`));
  await page.setViewportSize({ width: 412, height: 880 });
  if (!(await blattMitZweiGegenstaenden(page))) { test.skip(true, 'kein Kodierer'); return; }
  const editor = await editorOeffnen(page);
  await zweiBereiche(page, editor);
  const leiste = einstellungen(editor);
  // Bereich 2 (gewählt in der Zeitleiste) auf 1,6 s … 3,6 s
  await springe(page, editor, 4);
  await leiste.getByRole('button', { name: 'Ab hier' }).click();
  await springe(page, editor, 5);
  await leiste.getByRole('button', { name: 'Bis hier' }).click();
  await page.waitForTimeout(2000);
  notiere(`C2 nach Zeitraum: ${JSON.stringify(await zustand(editor))}`);

  // Wiedergabestelle vor den Zeitraum
  await springe(page, editor, -8);
  await foto(page, 'c2-01-ausserhalb-zeitraum');
  notiere(`C2 ausserhalb: ${JSON.stringify(await zustand(editor))}`);
  const hinweis = await editor.locator('.bild-hinweis, .mb-lage, .mb-hinweis').allTextContents();
  notiere(`C2 ausserhalb Hinweise: ${JSON.stringify(hinweis.map((h) => h.trim().slice(0, 160)))}`);
  notiere(`C2 ausserhalb Regler sichtbar: ${await editor.getByLabel('Sättigung').count()}`);

  // Zurück in den Zeitraum, dann trennen
  await springe(page, editor, 6);
  notiere(`C2 im Zeitraum: ${JSON.stringify(await zustand(editor))}`);
  await leiste.getByRole('button', { name: 'Hier trennen' }).click();
  await page.waitForTimeout(2500);
  await foto(page, 'c2-02-getrennt');
  notiere(`C2 nach Trennen: ${JSON.stringify(await zustand(editor))}`);
  const namen = await editor.locator('.mb-leinwand').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  notiere(`C2 nach Trennen Bahnen: ${JSON.stringify(namen)}`);

  // Löschen in der Zeitleiste
  await leiste.getByRole('button', { name: /löschen/ }).click();
  await page.waitForTimeout(2500);
  await foto(page, 'c2-03-geloescht');
  notiere(`C2 nach Löschen: ${JSON.stringify(await zustand(editor))}`);
  await editor.getByRole('button', { name: 'Letzte Änderung an den Masken zurücknehmen' }).first().click();
  await page.waitForTimeout(2500);
  notiere(`C2 nach ↺: ${JSON.stringify(await zustand(editor))}`);
});
