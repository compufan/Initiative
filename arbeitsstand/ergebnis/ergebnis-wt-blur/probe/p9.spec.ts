import { test } from '@playwright/test';
test('probe 9: Tooltip', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  const status = await page.evaluate(() => document.body.innerText.slice(0, 200));
  console.log('BODY:', status.replace(/\n/g, ' | '));
  await page.evaluate(async () => {
    const pfad = '/e2e/buehne.ts';
    const buehne: any = await import(/* @vite-ignore */ pfad);
    const c = document.createElement('canvas'); c.width = 480; c.height = 360;
    const ctx = c.getContext('2d')!; ctx.fillStyle = '#888'; ctx.fillRect(0, 0, 480, 360);
    const blob: Blob = await new Promise((a) => c.toBlob((b) => a(b!), 'image/png'));
    buehne.bildEditorZeigen(blob);
  });
  const editor = page.locator('.bild-editor');
  await editor.locator('.bild-leinwand').waitFor();
  await editor.locator('.bild-reiter').getByRole('button', { name: /Bereiche/ }).click();
  await editor.getByRole('button', { name: '◎ Radial' }).click();
  const weich = editor.getByRole('slider', { name: /^Weichzeichnen/ });
  console.log('tipp attr:', await weich.evaluate((e) => e.closest('[data-tipp]')?.getAttribute('data-tipp')));
  await page.evaluate(() => {
    (window as any).__log = [];
    document.addEventListener('pointerover', (e) => (window as any).__log.push('over:' + e.pointerType + ':' + (e.target as Element).tagName), true);
    window.addEventListener('scroll', (e) => (window as any).__log.push('scroll:' + ((e.target as Element).className || (e.target as any).nodeName)), true);
  });
  await page.mouse.move(1, 1);
  await weich.hover();
  await page.waitForTimeout(1200);
  console.log('tooltips:', await page.locator('.tipp').count(), await page.evaluate(() => document.querySelectorAll('[role=tooltip]').length));
  console.log('LOG', JSON.stringify(await page.evaluate(() => (window as any).__log)));
  const box = await weich.boundingBox();
  console.log('box', JSON.stringify(box));
  const el = await page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e ? e.tagName + '.' + e.className : null; }, [box!.x + box!.width / 2, box!.y + box!.height / 2]);
  console.log('element am Punkt:', el);
});
