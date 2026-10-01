import { test } from '@playwright/test';
import { antippen, blattMitZweiGegenstaenden, bereichsKnoepfe, editorOeffnen, foto, notiere, reiterBereiche, warteAufFertig, filmAbtasten, filmBogen } from './gemeinsam';

/** SZENARIO: zwei | nurA | nurB | einBereich | gleich */
const szenario = process.env.SZENARIO ?? 'zwei';
const bx = process.env.GETRENNT ? 230 : 150;
const farben = { ...(process.env.PALETTE === 'hell' ? { a: '#107030', b: '#f0b040' } : { a: '#20c040', b: '#e08020' }), bx };
const tag = `${szenario}${process.env.PALETTE ? '-' + process.env.PALETTE : ''}${process.env.GETRENNT ? '-getrennt' : ''}`;

test(`B1 ${tag}`, async ({ page }) => {
  test.setTimeout(400_000);
  page.setDefaultTimeout(60_000);
  page.on('pageerror', (e) => notiere(`SEITENFEHLER ${e.message}`));
  await page.setViewportSize({ width: 412, height: 880 });
  if (!(await blattMitZweiGegenstaenden(page, farben))) { test.skip(true, 'kein Kodierer'); return; }
  const editor = await editorOeffnen(page);
  await reiterBereiche(editor);
  await editor.getByRole('button', { name: /Antippen aus/ }).click();
  const fertig = async () => { await page.waitForTimeout(1500); await warteAufFertig(editor); };
  const saett = async () => { await editor.getByLabel('Sättigung').first().fill('-1'); };
  const belicht = async () => { await editor.getByLabel('Belichtung').first().fill('1.5'); };

  if (szenario === 'zwei') {
    await antippen(page, editor, 30, 80); await fertig();
    await saett();
    await editor.getByRole('button', { name: '＋ Bereich' }).click(); await page.waitForTimeout(1000);
    await antippen(page, editor, bx + 20, 30); await fertig();
    await belicht();
  } else if (szenario === 'nurA') {
    await antippen(page, editor, 30, 80); await fertig(); await saett();
  } else if (szenario === 'nurB') {
    await antippen(page, editor, bx + 20, 30); await fertig(); await belicht();
  } else if (szenario === 'einBereich') {
    await antippen(page, editor, 30, 80); await fertig();
    await antippen(page, editor, bx + 20, 30); await fertig();
    await saett();
  } else if (szenario === 'gleich') {
    await antippen(page, editor, 30, 80); await fertig();
    await saett();
    await editor.getByRole('button', { name: '＋ Bereich' }).click(); await page.waitForTimeout(1000);
    await antippen(page, editor, 30, 80); await fertig();
    await belicht();
  }
  await page.waitForTimeout(5000);
  notiere(`B1 ${tag} Bahnen: ${JSON.stringify(await editor.locator('.mb-leinwand').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label'))))}`);
  notiere(`B1 ${tag} Knöpfe: ${JSON.stringify(await bereichsKnoepfe(editor).allTextContents())}`);
  await foto(page, `b1-${tag}-editor`);
  await editor.getByRole('button', { name: 'Fertig', exact: true }).click();
  await page.getByRole('button', { name: 'Film bauen' }).click();
  await page.getByRole('button', { name: 'Übernehmen' }).waitFor({ timeout: 300_000 });
  await page.getByRole('button', { name: 'Übernehmen' }).click();
  const zeiten: number[] = [];
  for (let t = 0.05; t < 4.95; t += 0.2) zeiten.push(Math.round(t * 100) / 100);
  const erg = await filmAbtasten(page, zeiten, [], bx);
  for (const r of erg.reihe as any[]) {
    notiere(`B1 ${tag} t=${r.t} n=${r.n} A:${r.aKern}${r.aSichtbar ? '' : '(aus)'} Ae:${r.aEcke} | B:${r.bKern} Be:${r.bEcke}`);
  }
  await filmBogen(page, [1.05, 1.25, 1.45, 1.55, 1.65, 1.75, 1.85, 1.95, 2.05, 2.25, 2.65, 3.05, 3.45, 3.85, 4.45], `b1-${tag}-bogen`);
});
