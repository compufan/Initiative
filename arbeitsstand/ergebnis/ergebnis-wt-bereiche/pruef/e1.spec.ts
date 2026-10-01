import { test } from '@playwright/test';
import { blattMitZweiGegenstaenden, editorOeffnen, einstellungen, foto, notiere, reiterBereiche, antippen, warteAufFertig } from './gemeinsam';

for (const breite of [375, 412]) {
  test(`E1 @${breite}: Einstellungsleiste der Maske`, async ({ page }) => {
    test.setTimeout(200_000);
    page.setDefaultTimeout(40_000);
    await page.setViewportSize({ width: breite, height: breite === 375 ? 667 : 880 });
    if (!(await blattMitZweiGegenstaenden(page))) { test.skip(true, 'kein Kodierer'); return; }
    const editor = await editorOeffnen(page);
    await reiterBereiche(editor);
    await editor.getByRole('button', { name: /Antippen aus/ }).click();
    await antippen(page, editor, 30, 80);
    await warteAufFertig(editor);
    const leiste = einstellungen(editor);
    const alle = await leiste.locator('button').evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        return { name: (e.getAttribute('aria-label') ?? e.textContent ?? '').trim().slice(0, 40), links: Math.round(r.left), rechts: Math.round(r.right) };
      }),
    );
    const w = await leiste.evaluate((e) => ({ sw: e.scrollWidth, cw: e.clientWidth }));
    const sichtbar = alle.filter((k) => k.links >= 0 && k.rechts <= breite).map((k) => k.name);
    const weg = alle.filter((k) => !(k.links >= 0 && k.rechts <= breite)).map((k) => k.name);
    notiere(`E1 @${breite}: Leiste ${w.sw} breit in ${w.cw}; ganz sichtbar: ${JSON.stringify(sichtbar)}; erst nach Wischen: ${JSON.stringify(weg)}`);
    await foto(page, `e1-${breite}-leiste`);
  });
}
