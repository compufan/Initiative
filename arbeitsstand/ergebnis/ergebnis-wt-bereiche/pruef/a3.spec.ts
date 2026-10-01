import { test } from '@playwright/test';
import { antippen, blattMitZweiGegenstaenden, bereichsKnoepfe, editorOeffnen, einstellungen, foto, notiere, reiterBereiche, zustand, warteAufFertig, filmAbtasten, grau } from './gemeinsam';

test('A3: Regler je Bereich, Zeitraum, Film bauen, nachmessen', async ({ page }) => {
  test.setTimeout(1_200_000);
  page.on('pageerror', (e) => notiere(`SEITENFEHLER ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') notiere(`KONSOLE ${m.text()}`); });
  await page.setViewportSize({ width: 412, height: 880 });
  if (!(await blattMitZweiGegenstaenden(page))) { test.skip(true, 'kein Kodierer'); return; }
  const editor = await editorOeffnen(page);
  await reiterBereiche(editor);
  await editor.getByRole('button', { name: /Antippen aus/ }).click();
  await antippen(page, editor, 30, 80);
  await warteAufFertig(editor);
  await editor.getByRole('button', { name: '＋ Bereich' }).click();
  await page.waitForTimeout(1200);
  await antippen(page, editor, 170, 30);
  await page.waitForTimeout(2000);
  await warteAufFertig(editor);
  notiere(`beide angelegt: ${JSON.stringify(await zustand(editor))}`);

  // Bereich 1 wählen, Sättigung -1
  await bereichsKnoepfe(editor).first().click();
  const saett = editor.getByLabel('Sättigung');
  notiere(`Sättigungsregler: ${await saett.count()}`);
  await saett.first().scrollIntoViewIfNeeded();
  await saett.first().fill('-1');
  await page.waitForTimeout(1200);
  await foto(page, 'a3-01-bereich1-saettigung');
  notiere(`nach Sättigung an Bereich 1: ${JSON.stringify(await zustand(editor))}`);

  // Bereich 2 wählen, Belichtung +1,5
  await bereichsKnoepfe(editor).nth(1).click();
  const bel = editor.getByLabel('Belichtung');
  await bel.first().scrollIntoViewIfNeeded();
  await bel.first().fill('1.5');
  await page.waitForTimeout(1200);
  await foto(page, 'a3-02-bereich2-belichtung');
  notiere(`nach Belichtung an Bereich 2: ${JSON.stringify(await zustand(editor))}`);

  // Zeitraum für Bereich 2: 1,6 s bis 3,6 s — die Leiste der Zeitleiste gehört Bereich 2 (zuletzt angelegt)
  const leiste = editor.getByRole('slider', { name: 'Wiedergabestelle' });
  await leiste.focus();
  for (let i = 0; i < 4; i += 1) await leiste.press('Shift+ArrowRight');
  await page.waitForTimeout(2500);
  const zeile = einstellungen(editor);
  notiere(`Leiste vor Ab hier: ${await zeile.locator('.mb-name').textContent()}`);
  await zeile.getByRole('button', { name: 'Ab hier' }).click();
  await page.waitForTimeout(800);
  for (let i = 0; i < 5; i += 1) await leiste.press('Shift+ArrowRight');
  await page.waitForTimeout(2500);
  await zeile.getByRole('button', { name: 'Bis hier' }).click();
  await page.waitForTimeout(1500);
  await foto(page, 'a3-03-zeitraum-bereich2');
  notiere(`nach Zeitraum: ${JSON.stringify(await zustand(editor))}`);
  await page.waitForTimeout(8000);
  notiere(`Bahnen-Labels: ${JSON.stringify(await editor.locator('.mb-leinwand').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label'))))}`);
  await foto(page, 'a3-04-vor-fertig');

  await editor.getByRole('button', { name: 'Fertig', exact: true }).click();
  await page.getByRole('button', { name: 'Film bauen' }).click();
  await page.getByRole('button', { name: 'Übernehmen' }).waitFor({ timeout: 400_000 });
  await foto(page, 'a3-05-gebaut');
  await page.getByRole('button', { name: 'Übernehmen' }).click();

  const zeiten = [0.05, 0.35, 0.65, 0.95, 1.25, 1.45, 1.65, 1.85, 2.05, 2.25, 2.65, 3.05, 3.45, 3.65, 3.85, 4.15];
  const erg = await filmAbtasten(page, zeiten, [
    { zeit: 0.35, datei: 'a3-film-0350' },
    { zeit: 1.75, datei: 'a3-film-1750' },
    { zeit: 2.25, datei: 'a3-film-2250' },
    { zeit: 3.05, datei: 'a3-film-3050' },
    { zeit: 3.85, datei: 'a3-film-3850' },
  ]);
  for (const r of erg.reihe as any[]) {
    notiere(`t=${r.t} n=${r.n} A:${r.aKern} ${r.aSichtbar ? '' : '(draussen)'} Aecke:${r.aEcke} | B:${r.bKern} Becke:${r.bEcke} | grund ${r.grund1} ${r.grund2}`);
  }
});
