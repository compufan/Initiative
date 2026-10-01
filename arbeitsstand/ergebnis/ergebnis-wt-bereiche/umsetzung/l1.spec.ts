import { test } from '@playwright/test';
import { antippen, blattMitZweiGegenstaenden, bereichsKnoepfe, editorOeffnen, einstellungen, foto, notiere, reiterBereiche, warteAufFertig, zustand } from './gemeinsam';

for (const breite of [375, 412]) {
  test(`U1 @${breite}: Gleichklang und Leiste`, async ({ page }) => {
    test.setTimeout(400_000);
    page.setDefaultTimeout(60_000);
    page.on('pageerror', (e) => notiere(`SEITENFEHLER ${e.message}`));
    await page.setViewportSize({ width: breite, height: breite === 375 ? 667 : 880 });
    if (!(await blattMitZweiGegenstaenden(page, { a: '#107030', b: '#f0b040', bx: 230 } as never))) { test.skip(true, 'kein Kodierer'); return; }
    const editor = await editorOeffnen(page);
    await reiterBereiche(editor);
    await editor.getByRole('button', { name: /Antippen aus/ }).click();
    await antippen(page, editor, 30, 80);
    await warteAufFertig(editor);
    const leiste = einstellungen(editor);
    const alle = await leiste.locator('button').evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        return { name: (e.getAttribute('aria-label') ?? e.textContent ?? '').trim().slice(0, 30), links: Math.round(r.left), rechts: Math.round(r.right) };
      }),
    );
    const nameBox = await leiste.locator('.mb-name').evaluate((e) => { const r = e.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right) }; });
    notiere(`U1 @${breite}: Name ${JSON.stringify(nameBox)}; Knöpfe ${JSON.stringify(alle)}`);
    await foto(page, `u1-${breite}-leiste`);
    notiere(`U1 @${breite}: ${JSON.stringify(await zustand(editor))}`);

    await editor.getByRole('button', { name: '＋ Bereich' }).click();
    await page.waitForTimeout(1200);
    await antippen(page, editor, 250, 30);
    await warteAufFertig(editor);
    notiere(`U1 @${breite} nach Bereich 2: ${JSON.stringify(await zustand(editor))}`);
    // Bahn 1 antippen
    const bahnen = editor.locator('.mb-zeile');
    const k = await bahnen.first().boundingBox();
    if (k) await page.mouse.click(k.x + k.width / 2, k.y + k.height / 2);
    await page.waitForTimeout(800);
    notiere(`U1 @${breite} nach Tipp auf Bahn 1: ${JSON.stringify(await zustand(editor))}`);
    await foto(page, `u1-${breite}-bahn1`);
    // Chip 2 anklicken
    await bereichsKnoepfe(editor).nth(1).click();
    await page.waitForTimeout(800);
    notiere(`U1 @${breite} nach Chip 2: ${JSON.stringify(await zustand(editor))}`);
    await foto(page, `u1-${breite}-chip2`);
  });
}
