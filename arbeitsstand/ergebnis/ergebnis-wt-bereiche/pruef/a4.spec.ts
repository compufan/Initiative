import { test } from '@playwright/test';
import { blattMitZweiGegenstaenden, bereichsKnoepfe, editorOeffnen, einstellungen, foto, notiere, zustand, zweiBereiche, springe } from './gemeinsam';

for (const breite of [412, 375]) {
  test(`A4 @${breite}: Auswahl, Auffindbarkeit, Leiste`, async ({ page }) => {
    test.setTimeout(240_000);
    page.on('pageerror', (e) => notiere(`SEITENFEHLER ${e.message}`));
    const hoehe = breite === 412 ? 880 : 667;
    await page.setViewportSize({ width: breite, height: hoehe });
    if (!(await blattMitZweiGegenstaenden(page))) { test.skip(true, 'kein Kodierer'); return; }
    const editor = await editorOeffnen(page);
    await zweiBereiche(page, editor);
    await foto(page, `a4-${breite}-01-zwei-bereiche`);
    notiere(`[${breite}] nach zwei Bereichen: ${JSON.stringify(await zustand(editor))}`);

    // Wo liegen die Knöpfe der Einstellungsleiste?
    const leiste = einstellungen(editor);
    const knoepfe = await leiste.getByRole('button').evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        return { name: (e.getAttribute('aria-label') ?? e.textContent ?? '').trim(), links: Math.round(r.left), rechts: Math.round(r.right) };
      }),
    );
    const sichtbar = knoepfe.filter((k) => k.rechts <= breite && k.links >= 0).map((k) => k.name);
    const verdeckt = knoepfe.filter((k) => k.rechts > breite || k.links < 0).map((k) => k.name);
    notiere(`[${breite}] Leistenknöpfe sichtbar: ${JSON.stringify(sichtbar)}`);
    notiere(`[${breite}] Leistenknöpfe nur durch Scrollen erreichbar: ${JSON.stringify(verdeckt)}`);
    const scroll = await leiste.evaluate((e) => ({ sw: e.scrollWidth, cw: e.clientWidth, ox: getComputedStyle(e).overflowX }));
    notiere(`[${breite}] Leiste scrollWidth=${scroll.sw} clientWidth=${scroll.cw} overflowX=${scroll.ox}`);

    // Zeitleiste: erste Bahn antippen → wählt die Maske dort; folgt der Editor?
    const bahn = editor.locator('.mb-zeile').first();
    const kasten = await bahn.boundingBox();
    if (kasten) await page.mouse.click(kasten.x + kasten.width * 0.3, kasten.y + kasten.height / 2);
    await page.waitForTimeout(1000);
    await foto(page, `a4-${breite}-02-bahn1-gewaehlt`);
    notiere(`[${breite}] nach Tipp auf Bahn 1: ${JSON.stringify(await zustand(editor))}`);

  });
}
