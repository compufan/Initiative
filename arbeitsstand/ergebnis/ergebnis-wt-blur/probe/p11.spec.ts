import { test } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const OUT = '/tmp/claude-0/-home-user-Initiative/b3e47b8f-e30a-5e75-8af6-6e58f2fcbe7c/scratchpad/ergebnis-wt-blur/bilder-impl';

test('probe 11: Bilder', async ({ page }) => {
  test.setTimeout(300000);
  await page.goto('/');
  const r = await page.evaluate(async () => {
    const pfad = '/e2e/hilfen/unscharfMessen.ts';
    const m: any = await import(/* @vite-ignore */ pfad);
    const W = 1200;
    const montage = (liste: { titel: string; daten: Uint8ClampedArray; H: number }[], x0: number, y0: number, w: number, h: number, zoom: number) => {
      const c = document.createElement('canvas');
      c.width = w * zoom * liste.length + 4 * (liste.length - 1);
      c.height = h * zoom + 18;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#222'; ctx.fillRect(0, 0, c.width, c.height);
      liste.forEach((b, i) => {
        const tmp = document.createElement('canvas'); tmp.width = W; tmp.height = b.H;
        const t = tmp.getContext('2d')!; const id = t.createImageData(W, b.H); id.data.set(b.daten); t.putImageData(id, 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(tmp, x0, y0, w, h, i * (w * zoom + 4), 18, w * zoom, h * zoom);
        ctx.fillStyle = '#fff'; ctx.font = '13px sans-serif'; ctx.fillText(b.titel, i * (w * zoom + 4) + 4, 13);
      });
      return c.toDataURL('image/png');
    };
    const out: Record<string, string> = {};
    const sz = m.szeneHolen('A', W);
    // Kante am Kopf, Grund unscharf
    {
      const f = (par: any) => m.fall({ art: 'A', W, maske: 'netz', ziel: 'grund', par, wege: ['gpu'], bilder: true });
      const a = f({ bokeh: 1 }), b = f({ unschaerfe: 1 }), c = f({ unschaerfe: 0.6, bokeh: 0.6 });
      out.kopfGrund = montage([
        { titel: 'Original', daten: sz.orig, H: sz.H },
        { titel: 'Weichzeichnen 100', daten: b.bilder.gpu, H: sz.H },
        { titel: 'Bokeh 100', daten: a.bilder.gpu, H: sz.H },
        { titel: 'beide 60/60', daten: c.bilder.gpu, H: sz.H },
      ], 480, 170, 240, 170, 2);
    }
    // Lichter
    {
      const szB = m.szeneHolen('B', W);
      const f = (par: any, guete: any) => m.fall({ art: 'B', W, maske: 'netz', ziel: 'grund', par, wege: ['gpu'], bilder: true, guete });
      const a = f({ bokeh: 1 }, 'hoch'), b = f({ bokeh: 0.5 }, 'mittel'), c = f({ unschaerfe: 1 }, 'hoch');
      out.lichter = montage([
        { titel: 'Original', daten: szB.orig, H: szB.H },
        { titel: 'Bokeh 100 hoch', daten: a.bilder.gpu, H: szB.H },
        { titel: 'Bokeh 50 mittel', daten: b.bilder.gpu, H: szB.H },
        { titel: 'Weichzeichnen 100', daten: c.bilder.gpu, H: szB.H },
      ], 0, 0, 600, 420, 0.5);
    }
    // Motiv unscharf
    {
      const f = (par: any) => m.fall({ art: 'A', W, maske: 'netz', ziel: 'motiv', par, wege: ['gpu'], bilder: true });
      const a = f({ bokeh: 1 }), b = f({ unschaerfe: 1 });
      out.motiv = montage([
        { titel: 'Original', daten: sz.orig, H: sz.H },
        { titel: 'Motiv: Weichzeichnen 100', daten: b.bilder.gpu, H: sz.H },
        { titel: 'Motiv: Bokeh 100', daten: a.bilder.gpu, H: sz.H },
      ], 340, 100, 320, 330, 1.5);
    }
    // Verlauf C
    {
      const szC = m.szeneHolen('C', W);
      const feld = m.maskeAlpha(szC, 'hverlauf');
      const s = m.handSzene(feld, W, szC.H, { bokeh: 1 });
      const g = m.rendern(szC.orig, W, szC.H, s, 'gpu', 'hoch');
      out.verlauf = montage([{ titel: 'Original', daten: szC.orig, H: szC.H }, { titel: 'Bokeh 100, Verlauf links 0 bis rechts 255', daten: g.daten, H: szC.H }], 0, 150, 1200, 330, 0.6);
    }
    return out;
  });
  for (const [k, v] of Object.entries(r)) writeFileSync(`${OUT}/${k}.png`, Buffer.from((v as string).replace(/^data:image\/png;base64,/, ''), 'base64'));
});
