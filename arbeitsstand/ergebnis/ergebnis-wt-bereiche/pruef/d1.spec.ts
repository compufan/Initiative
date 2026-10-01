import { test } from '@playwright/test';
import { antippen, blattMitZweiGegenstaenden, bereichsKnoepfe, editorOeffnen, einstellungen, foto, notiere, reiterBereiche, warteAufFertig, filmAbtasten, filmBogen, zustand } from './gemeinsam';

const bx = Number(process.env.BX ?? 230);
const ein = Boolean(process.env.EIN);
const tag = `D1-${bx}${ein ? '-ein' : ''}`;
test(`D1: zwei Bereiche mit Netz (Antippen mit Netz) bx=${bx} ein=${ein}`, async ({ page }) => {
  test.setTimeout(900_000);
  page.setDefaultTimeout(120_000);
  page.on('pageerror', (e) => notiere(`SEITENFEHLER ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') notiere(`${tag} KONSOLE ${m.text().slice(0, 200)}`); });
  await page.setViewportSize({ width: 412, height: 880 });
  const farben = { a: '#107030', b: '#f0b040', bx };
  if (!(await blattMitZweiGegenstaenden(page, farben))) { test.skip(true, 'kein Kodierer'); return; }
  const editor = await editorOeffnen(page);
  await reiterBereiche(editor);
  await editor.getByRole('button', { name: /Antippen aus/ }).click();
  await editor.getByRole('button', { name: /mit Netz/ }).click();
  await page.waitForTimeout(500);
  notiere(`${tag} Netz-Schalter: ${await editor.getByRole('button', { name: /mit Netz/ }).getAttribute('aria-pressed')} ${(await editor.getByRole('button', { name: /mit Netz/ }).textContent())?.trim()}`);
  const t0 = Date.now();
  await antippen(page, editor, 30, 80);
  await page.waitForTimeout(4000);
  await foto(page, 'd1-01-a-netz');
  notiere(`${tag} nach A-Tipp mit Netz (${Math.round((Date.now() - t0) / 1000)} s): ${JSON.stringify(await zustand(editor))}`);
  await warteAufFertig(editor, 400_000);
  notiere(`${tag} A fertig verfolgt nach ${Math.round((Date.now() - t0) / 1000)} s`);
  if (!ein) {
    await editor.getByRole('button', { name: '＋ Bereich' }).click();
    await page.waitForTimeout(1000);
  }
  await antippen(page, editor, bx + 20, 30);
  await page.waitForTimeout(4000);
  await foto(page, 'd1-02-b-netz');
  await warteAufFertig(editor, 400_000);
  notiere(`${tag} B fertig verfolgt nach ${Math.round((Date.now() - t0) / 1000)} s`);
  await bereichsKnoepfe(editor).first().click();
  await editor.getByLabel('Sättigung').first().fill('-1');
  if (!ein) {
    await bereichsKnoepfe(editor).nth(1).click();
    await editor.getByLabel('Belichtung').first().fill('1.5');
  }
  await page.waitForTimeout(4000);
  notiere(`${tag} Bahnen: ${JSON.stringify(await editor.locator('.mb-leinwand').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label'))))}`);
  await foto(page, 'd1-03-vor-fertig');
  await editor.getByRole('button', { name: 'Fertig', exact: true }).click();
  await page.getByRole('button', { name: 'Film bauen' }).click();
  await page.getByRole('button', { name: 'Übernehmen' }).waitFor({ timeout: 600_000 });
  await page.getByRole('button', { name: 'Übernehmen' }).click();
  const zeiten: number[] = [];
  for (let t = 0.05; t < 4.95; t += 0.2) zeiten.push(Math.round(t * 100) / 100);
  const erg = await filmAbtasten(page, zeiten, [], bx);
  for (const r of erg.reihe as any[]) {
    notiere(`${tag} t=${r.t} n=${r.n} A:${r.aKern}${r.aSichtbar ? '' : '(aus)'} Ae:${r.aEcke} | B:${r.bKern} Be:${r.bEcke}`);
  }
  await filmBogen(page, [0.05, 0.85, 1.65, 2.45, 3.25, 4.05], `d1-${bx}${ein ? '-ein' : ''}-bogen`, 3);
});
