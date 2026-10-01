import { test } from '@playwright/test';

test('probe 7: Kontextverlust', async ({ page }) => {
  await page.addInitScript(() => {
    const echt = HTMLCanvasElement.prototype.getContext;
    (window as any).__ctx = [];
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, art: string, ...rest: unknown[]) {
      const c = (echt as any).call(this, art, ...rest);
      if (art === 'webgl2' && c) (window as any).__ctx.push(c);
      return c;
    } as any;
  });
  await page.goto('/');
  const r = await page.evaluate(async () => {
    const out: string[] = [];
    const pfad = '/e2e/hilfen/unscharfMessen.ts';
    const m: any = await import(/* @vite-ignore */ pfad);
    const ladeGpu = '/src/modules/bild/tonGpu.ts';
    const gpu: any = await import(/* @vite-ignore */ ladeGpu);
    out.push('kontexte vor: ' + (window as any).__ctx.length);
    const W = 240;
    const sz = m.szeneHolen('A', W);
    const szene = m.bereichSzene(W, sz.H, [m.netzTeil(m.maskeAlpha(sz, 'netz'), W, sz.H, true)], { bokeh: 1, unschaerfe: 0.5 });
    const a = m.rendern(sz.orig, W, sz.H, szene, 'gpu', 'mittel');
    out.push('erste: ' + a.weg + ' kontexte ' + (window as any).__ctx.length + ' lebend ' + gpu.zaehler.texturenLebend);
    const ctxs = (window as any).__ctx as WebGL2RenderingContext[];
    ctxs.forEach((c, i) => out.push(`ctx ${i}: lost=${c.isContextLost()}`));
    ctxs[1].getExtension('WEBGL_lose_context')!.loseContext();
    out.push('ctx1 lost: ' + ctxs[1].isContextLost());
    const b = m.rendern(sz.orig, W, sz.H, szene, 'gpu', 'mittel');
    out.push('nach Verlust: ' + b.weg + ' lebend ' + gpu.zaehler.texturenLebend + ' kontexte ' + ctxs.length);
    const c = m.rendern(sz.orig, W, sz.H, szene, 'gpu', 'mittel');
    out.push('danach: ' + c.weg + ' lebend ' + gpu.zaehler.texturenLebend + ' kontexte ' + ctxs.length);
    return out;
  });
  console.log(r.join('\n'));
});
