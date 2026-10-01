import { test } from '@playwright/test';
import { blattMitZweiGegenstaenden, bereichsKnoepfe, editorOeffnen, einstellungen, foto, notiere, zustand, zweiBereiche } from './gemeinsam';

test('C1: 375 x 667, drei und vier Bereiche, Grenze', async ({ page }) => {
  test.setTimeout(400_000);
  page.setDefaultTimeout(40_000);
  page.on('pageerror', (e) => notiere(`SEITENFEHLER ${e.message}`));
  await page.setViewportSize({ width: 375, height: 667 });
  if (!(await blattMitZweiGegenstaenden(page))) { test.skip(true, 'kein Kodierer'); return; }
  const editor = await editorOeffnen(page);
  await zweiBereiche(page, editor);
  await foto(page, 'c1-01-zwei-375');
  const stage = async (t: string) => {
    const b = await editor.locator('.bild-buehne').boundingBox();
    notiere(`C1 ${t}: Bühne ${Math.round(b?.width ?? 0)} x ${Math.round(b?.height ?? 0)}`);
  };
  await stage('zwei');
  await editor.getByRole('button', { name: '＋ Bereich' }).click();
  await page.waitForTimeout(1500);
  await foto(page, 'c1-02-drei-375');
  await stage('drei');
  notiere(`C1 drei: ${JSON.stringify(await zustand(editor))}`);
  await editor.getByRole('button', { name: '＋ Bereich' }).click();
  await page.waitForTimeout(1500);
  await foto(page, 'c1-03-vier-375');
  await stage('vier');
  notiere(`C1 vier: ${JSON.stringify(await zustand(editor))}`);
  notiere(`C1 vier: Knopf ＋ Bereich vorhanden: ${await editor.getByRole('button', { name: '＋ Bereich' }).count()}`);
  const hinweise = await editor.locator('.bild-hinweis').allTextContents();
  notiere(`C1 vier: Hinweise: ${JSON.stringify(hinweise.map((h) => h.slice(0, 120)))}`);
  // Verlauf anlegen bei vier Bereichen und gewähltem Bereich: geht in den gewählten
  // Bereich wählen, der keinen hat? Alle vier sind angelegt – ein fünfter ginge nur über „Verlauf" ohne Auswahl
  await editor.getByRole('button', { name: '↗ Verlauf' }).click();
  await page.waitForTimeout(800);
  notiere(`C1 vier nach Verlauf: ${JSON.stringify(await zustand(editor))}`);
  await foto(page, 'c1-04-vier-verlauf-375');
});
