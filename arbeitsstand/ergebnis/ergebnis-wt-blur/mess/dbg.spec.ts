import { test } from '@playwright/test';
const BASIS = '/tmp/claude-0/-home-user-Initiative/b3e47b8f-e30a-5e75-8af6-6e58f2fcbe7c/scratchpad/ergebnis-wt-blur';
test('dbg', async ({ page }) => {
  await page.goto('/');
  for (const f of ['lib', 'fall', 'proto', 'gpu']) await page.addScriptTag({ path: `${BASIS}/mess/${f}.js` });
  const r = await page.evaluate(async () => {
    const M = (window as any).M;
    await M.laden();
    const W = 300;
    const sz = M.szeneHolen('A', W);
    const { H } = sz;
    const G = M.G.init();
    const gl = G.gl;
    const alpha = M.alphaFuer(sz, 'netz');
    const teil = M.netzTeil(alpha, W, H, true);
    const { raster, feld } = M.rasterFeld([teil], W, H);
    const maskImg = M.maskeAufBild(feld, raster, W, H);
    const quelle = { tex: G.textur8(sz.orig, W, H, false), linear: false, b: W, h: H };
    const maske = G.maskeTextur(maskImg, W, H);
    // nur prep
    const P = G.ziel(W, H);
    gl.useProgram(G.prog.prep.p);
    const u = G.prog.prep.orte;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, quelle.tex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, maske);
    gl.uniform1i(u.uQuelle, 0); gl.uniform1i(u.uMaske, 1); gl.uniform1i(u.uQuelleLinear, 0);
    gl.uniform2i(u.uQuelleGroesse, W, H); gl.uniform1i(u.uFaktor, 1);
    gl.uniform1f(u.uLow, 0.06); gl.uniform1f(u.uHigh, 0.92); gl.uniform1f(u.uKernLo, 0.5); gl.uniform1f(u.uKernHi, 0.9); gl.uniform1f(u.uTheta, 0);
    gl.uniform1i(u.uReinheit, 0); gl.uniform1f(u.uK, 100); gl.uniform1f(u.uL0, 0.6); gl.uniform1f(u.uL1, 0.98);
    gl.bindFramebuffer(gl.FRAMEBUFFER, P.f); gl.viewport(0, 0, W, H); gl.drawArrays(gl.TRIANGLES, 0, 3);
    const d = new Float32Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.FLOAT, d);
    let a = 0, nz = 0, r0 = 0;
    for (let i = 0; i < W * H; i += 1) { a += d[i * 4 + 3]; if (d[i * 4 + 3] > 0) nz += 1; r0 += d[i*4]; }
    // Maske Mittelwert
    let mm = 0; for (let i = 0; i < W * H; i += 1) mm += maskImg[i];
    G.debug = true; gl.getError();
    const erg = G.bokeh(quelle, maske, { R: 6, K_stufen: 3, reinheit: 0, ausgabe: false, K: 100 });
    gl.bindFramebuffer(gl.FRAMEBUFFER, erg.f);
    const e = new Float32Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.FLOAT, e);
    let diff = 0;
    const lin = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    for (let i = 0; i < W * H; i += 1) diff += Math.abs(e[i * 4] - lin(sz.orig[i * 4]));
    const err2 = gl.getError();
    return { fehler: G.fehler, diff: diff / (W * H), err2, e0: Array.from(e.slice(0, 4)), meanA: a / (W * H), nz, r0: r0 / (W*H), maskMean: mm / (W * H), err: gl.getError(), d0: Array.from(d.slice(0, 8)), mitte: Array.from(d.slice((150 * W + 150) * 4, (150 * W + 150) * 4 + 4)) };
  });
  console.log(JSON.stringify(r));
});
