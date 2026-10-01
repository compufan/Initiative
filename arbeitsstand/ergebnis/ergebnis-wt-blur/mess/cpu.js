/*
 * Der Entwurf auf dem Prozessor: dieselbe Rechnung wie gpu.js (gleiche Durchgaenge, gleiche Konstanten), nur als Schleifen
 * ueber Float32Array. Dient zum Messen von Zeit und Gleichheit mit der Grafikeinheit.
 */
(() => {
  const M = window.M;
  const C = (M.C = {});
  const P = M.P;

  const rampe = (x, a, b) => {
    const t = (x - a) / (b - a);
    return t < 0 ? 0 : t > 1 ? 1 : t;
  };
  const glatt = (a, b, x) => {
    const t = rampe(x, a, b);
    return t * t * (3 - 2 * t);
  };

  const std = { S_LO: 0.03, S_HI: 0.97, R_LO: 0.25, R_HI: 0.75, G_LO: 0.5, G_HI: 0.9, DECKUNG_LO: 0.02, DECKUNG_HI: 0.2, K: 100, L0: 0.6, L1: 0.98 };
  /** Staerke, Kerngewicht aus Maske m (0..1) und Kernwert rein (0..1); modus 1 = glatt. */
  const staerke = (o, m, rein, modus) => rampe(m, o.S_LO, o.S_HI) * (modus === 1 ? 1 : rampe(rein, o.R_LO, o.R_HI));
  const kernG = (o, rein, modus) => (modus === 1 ? 1 : rampe(rein, o.G_LO, o.G_HI));

  C.faktorFuer = (radius, grenze) => {
    let f = 1;
    while (radius / f > grenze && f < 8) f *= 2;
    return f;
  };

  /** Bilinear aus einem RGBA-Float-Feld (wb x wh), Mittelpunkt-Konvention, Klemmen am Rand. */
  function bil(feld, wb, wh, px, py, aus) {
    // px, py in Texelkoordinaten, Texelmitte bei +0.5
    let x = px - 0.5, y = py - 0.5;
    let x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    let x1 = x0 + 1, y1 = y0 + 1;
    x0 = x0 < 0 ? 0 : x0 >= wb ? wb - 1 : x0;
    x1 = x1 < 0 ? 0 : x1 >= wb ? wb - 1 : x1;
    y0 = y0 < 0 ? 0 : y0 >= wh ? wh - 1 : y0;
    y1 = y1 < 0 ? 0 : y1 >= wh ? wh - 1 : y1;
    const a = (y0 * wb + x0) * 4, b = (y0 * wb + x1) * 4, c = (y1 * wb + x0) * 4, d = (y1 * wb + x1) * 4;
    const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
    aus[0] = feld[a] * w00 + feld[b] * w10 + feld[c] * w01 + feld[d] * w11;
    aus[1] = feld[a + 1] * w00 + feld[b + 1] * w10 + feld[c + 1] * w01 + feld[d + 1] * w11;
    aus[2] = feld[a + 2] * w00 + feld[b + 2] * w10 + feld[c + 2] * w01 + feld[d + 2] * w11;
    aus[3] = feld[a + 3] * w00 + feld[b + 3] * w10 + feld[c + 3] * w01 + feld[d + 3] * w11;
  }

  /** Eine Strecke: Mittel ueber n Stellen von p bis p + (ex, ey) (in Arbeitspunkten). */
  function linie(q, wb, wh, ex, ey, n, ziel) {
    const t = new Float32Array(4);
    for (let y = 0; y < wh; y += 1)
      for (let x = 0; x < wb; x += 1) {
        let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
        for (let j = 0; j < n; j += 1) {
          const u = (j + 0.5) / n;
          bil(q, wb, wh, x + 0.5 + ex * u, y + 0.5 + ey * u, t);
          s0 += t[0]; s1 += t[1]; s2 += t[2]; s3 += t[3];
        }
        const o = (y * wb + x) * 4;
        ziel[o] = s0 / n; ziel[o + 1] = s1 / n; ziel[o + 2] = s2 / n; ziel[o + 3] = s3 / n;
      }
  }
  function verbund(t0, t1, wb, wh, e1, e2, n, ziel) {
    const t = new Float32Array(4);
    for (let y = 0; y < wh; y += 1)
      for (let x = 0; x < wb; x += 1) {
        let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
        for (let j = 0; j < n; j += 1) {
          const u = (j + 0.5) / n;
          bil(t0, wb, wh, x + 0.5 + e1[0] * u, y + 0.5 + e1[1] * u, t);
          s0 += t[0]; s1 += t[1]; s2 += t[2]; s3 += t[3];
          bil(t0, wb, wh, x + 0.5 + e2[0] * u, y + 0.5 + e2[1] * u, t);
          s0 += t[0]; s1 += t[1]; s2 += t[2]; s3 += t[3];
          bil(t1, wb, wh, x + 0.5 + e2[0] * u, y + 0.5 + e2[1] * u, t);
          s0 += t[0]; s1 += t[1]; s2 += t[2]; s3 += t[3];
        }
        const o = (y * wb + x) * 4;
        const d = 3 * n;
        ziel[o] = s0 / d; ziel[o + 1] = s1 / d; ziel[o + 2] = s2 / d; ziel[o + 3] = s3 / d;
      }
  }

  const ZU_SRGB_TAB = (() => {
    const t = new Uint8Array(4097);
    for (let i = 0; i <= 4096; i += 1) t[i] = P.zuSrgb(i / 4096);
    return t;
  })();
  const srgbByte = (v) => (v <= 0 ? 0 : v >= 1 ? 255 : P.zuSrgb(v));

  /**
   * Bokeh auf ein 8-Bit-Bild mit Maske. par: { bokeh, K_stufen, reinheit (0/1), K }
   */
  C.bokehBild = (orig, W, H, maskImg, par) => {
    const o = { ...std, ...par };
    const t0 = performance.now();
    const n = W * H;
    const R = par.bokeh * 0.02 * Math.max(W, H);
    const Kst = par.K_stufen ?? 3;
    const f = par.faktor ?? C.faktorFuer(R, 6);
    const wb = Math.ceil(W / f), wh = Math.ceil(H / f);
    // je Quellpunkt: Licht*Gewicht (3), Gewicht, Staerke
    const pr = new Float32Array(n), pg = new Float32Array(n), pb = new Float32Array(n), pw = new Float32Array(n), sh = new Float32Array(n);
    const ZL = P.ZU_LIN;
    const modus = par.reinheit ?? 0;
    for (let i = 0; i < n; i += 1) {
      const m = maskImg[i] / 255;
      const rein = modus === 2 ? par.kernImg[i] / 255 : m;
      const s = staerke(o, m, rein, modus);
      sh[i] = s;
      const g = kernG(o, rein, modus);
      if (s === 0 || g === 0) continue; // wird ohnehin nie gelesen bzw. ist 0
      const r = ZL[orig[i * 4]], gg = ZL[orig[i * 4 + 1]], b = ZL[orig[i * 4 + 2]];
      const hell = Math.max(r, gg, b);
      const bo = 1 + o.K * glatt(o.L0, o.L1, hell);
      const w = bo * g;
      pr[i] = r * w; pg[i] = gg * w; pb[i] = b * w; pw[i] = w;
    }
    const e0 = [0, -1], e1 = [-0.8660254, 0.5], e2 = [0.8660254, 0.5];
    const stufen = [];
    const P4 = new Float32Array(wb * wh * 4);
    const T0 = new Float32Array(wb * wh * 4), T1 = new Float32Array(wb * wh * 4);
    for (let k = 1; k <= Kst; k += 1) {
      const theta = (k - 0.5) / Kst;
      const rk = (R / f) * (k / Kst);
      const nn = Math.max(1, Math.min(63, Math.ceil(rk * (par.tapDichte ?? 1))));
      P4.fill(0);
      const inv = 1 / (f * f);
      for (let y = 0; y < H; y += 1) {
        const wy = Math.floor(y / f);
        for (let x = 0; x < W; x += 1) {
          const i = y * W + x;
          if (sh[i] < theta || pw[i] === 0) continue;
          if (par.summiert && k < Kst && sh[i] >= (k + 0.5) / Kst) continue;
          const o4 = (wy * wb + Math.floor(x / f)) * 4;
          P4[o4] += pr[i]; P4[o4 + 1] += pg[i]; P4[o4 + 2] += pb[i]; P4[o4 + 3] += pw[i];
        }
      }
      for (let i = 0; i < P4.length; i += 1) P4[i] *= inv;
      linie(P4, wb, wh, e0[0] * rk, e0[1] * rk, nn, T0);
      linie(P4, wb, wh, e1[0] * rk, e1[1] * rk, nn, T1);
      const S = new Float32Array(wb * wh * 4);
      verbund(T0, T1, wb, wh, [e1[0] * rk, e1[1] * rk], [e2[0] * rk, e2[1] * rk], nn, S);
      stufen.push(S);
    }
    const out = new Uint8ClampedArray(n * 4);
    const lin = par.linearAus ? new Float32Array(n * 3) : null;
    const beruehrt = par.linearAus ? new Uint8Array(n) : null;
    const tmp = new Float32Array(4);
    for (let y = 0; y < H; y += 1)
      for (let x = 0; x < W; x += 1) {
        const i = y * W + x;
        const m = maskImg[i] / 255;
        const s = staerke(o, m, modus === 2 ? par.kernImg[i] / 255 : m, modus);
        const t = rampe(s, 0, 0.5);
        let gleich = true;
        let X0 = 0, X1 = 0, X2 = 0;
        const S0 = ZL[orig[i * 4]], S1 = ZL[orig[i * 4 + 1]], S2 = ZL[orig[i * 4 + 2]];
        if (t > 0 && s > 0) {
          const k = Math.floor(s * Kst + 0.5);
          if (k > 0) {
            if (par.summiert) {
              tmp.fill(0);
              const t2 = new Float32Array(4);
              for (let q = 0; q < Kst; q += 1) { bil(stufen[q], wb, wh, ((x + 0.5) / W) * wb, ((y + 0.5) / H) * wh, t2); tmp[0] += t2[0]; tmp[1] += t2[1]; tmp[2] += t2[2]; tmp[3] += t2[3]; }
            } else bil(stufen[Math.min(k, Kst) - 1], wb, wh, ((x + 0.5) / W) * wb, ((y + 0.5) / H) * wh, tmp);
            const deck = glatt(o.DECKUNG_LO, o.DECKUNG_HI, tmp[3]);
            const a = deck * t;
            const b0 = tmp[3] > 1e-6 ? tmp[0] / tmp[3] : S0;
            const b1 = tmp[3] > 1e-6 ? tmp[1] / tmp[3] : S1;
            const b2 = tmp[3] > 1e-6 ? tmp[2] / tmp[3] : S2;
            X0 = S0 + (b0 - S0) * a; X1 = S1 + (b1 - S1) * a; X2 = S2 + (b2 - S2) * a;
            gleich = false;
          }
        }
        if (lin) {
          lin[i * 3] = gleich ? S0 : X0; lin[i * 3 + 1] = gleich ? S1 : X1; lin[i * 3 + 2] = gleich ? S2 : X2;
          beruehrt[i] = gleich ? 0 : 1;
        }
        if (gleich) {
          out[i * 4] = orig[i * 4]; out[i * 4 + 1] = orig[i * 4 + 1]; out[i * 4 + 2] = orig[i * 4 + 2];
        } else {
          out[i * 4] = srgbByte(X0); out[i * 4 + 1] = srgbByte(X1); out[i * 4 + 2] = srgbByte(X2);
        }
        out[i * 4 + 3] = 255;
      }
    return { daten: out, lin, beruehrt, ms: performance.now() - t0 };
  };

  /**
   * Weichzeichnen (Gauss, Kernfaltung): quelleLin (Float32Array 3n, linear) oder orig (8 Bit, wenn quelleLin fehlt).
   * par: { weich, reinheit }. Liefert 8 Bit.
   */
  C.weichBild = (orig, W, H, maskImg, par, quelleLin, beruehrtVorher) => {
    const o = { ...std, ...par };
    const t0 = performance.now();
    const n = W * H;
    const sigma = par.weich * 0.012 * Math.max(W, H);
    const f = par.faktor ?? C.faktorFuer(sigma * 3, 12);
    const wb = Math.ceil(W / f), wh = Math.ceil(H / f);
    const ZL = P.ZU_LIN;
    const src = (i, k) => (quelleLin ? quelleLin[i * 3 + k] : ZL[orig[i * 4 + k]]);
    const P4 = new Float32Array(wb * wh * 4);
    const inv = 1 / (f * f);
    for (let y = 0; y < H; y += 1) {
      const wy = Math.floor(y / f);
      for (let x = 0; x < W; x += 1) {
        const i = y * W + x;
        const m = maskImg[i] / 255;
        const md = par.reinheit ?? 0;
        const g = kernG(o, md === 2 ? par.kernImg[i] / 255 : m, md);
        if (g === 0) continue;
        const o4 = (wy * wb + Math.floor(x / f)) * 4;
        P4[o4] += src(i, 0) * g; P4[o4 + 1] += src(i, 1) * g; P4[o4 + 2] += src(i, 2) * g; P4[o4 + 3] += g;
      }
    }
    for (let i = 0; i < P4.length; i += 1) P4[i] *= inv;
    const sig = Math.max(0.3, sigma / f);
    const r = Math.min(64, Math.ceil((sigma / f) * 3));
    const w = new Float32Array(2 * r + 1);
    let ws = 0;
    for (let j = -r; j <= r; j += 1) { w[j + r] = Math.exp(-(j * j) / (2 * sig * sig)); ws += w[j + r]; }
    const T = new Float32Array(wb * wh * 4), B = new Float32Array(wb * wh * 4);
    const t4 = new Float32Array(4);
    for (let y = 0; y < wh; y += 1)
      for (let x = 0; x < wb; x += 1) {
        let a0 = 0, a1 = 0, a2 = 0, a3 = 0;
        for (let j = -r; j <= r; j += 1) { bil(P4, wb, wh, x + 0.5 + j, y + 0.5, t4); a0 += w[j + r] * t4[0]; a1 += w[j + r] * t4[1]; a2 += w[j + r] * t4[2]; a3 += w[j + r] * t4[3]; }
        const o4 = (y * wb + x) * 4;
        T[o4] = a0 / ws; T[o4 + 1] = a1 / ws; T[o4 + 2] = a2 / ws; T[o4 + 3] = a3 / ws;
      }
    for (let y = 0; y < wh; y += 1)
      for (let x = 0; x < wb; x += 1) {
        let a0 = 0, a1 = 0, a2 = 0, a3 = 0;
        for (let j = -r; j <= r; j += 1) { bil(T, wb, wh, x + 0.5, y + 0.5 + j, t4); a0 += w[j + r] * t4[0]; a1 += w[j + r] * t4[1]; a2 += w[j + r] * t4[2]; a3 += w[j + r] * t4[3]; }
        const o4 = (y * wb + x) * 4;
        B[o4] = a0 / ws; B[o4 + 1] = a1 / ws; B[o4 + 2] = a2 / ws; B[o4 + 3] = a3 / ws;
      }
    const out = new Uint8ClampedArray(n * 4);
    for (let y = 0; y < H; y += 1)
      for (let x = 0; x < W; x += 1) {
        const i = y * W + x;
        const m = maskImg[i] / 255;
        const md = par.reinheit ?? 0;
        const wEff = staerke(o, m, md === 2 ? par.kernImg[i] / 255 : m, md);
        let gleich = wEff === 0 && !(beruehrtVorher && beruehrtVorher[i]);
        let X0 = src(i, 0), X1 = src(i, 1), X2 = src(i, 2);
        if (wEff > 0) {
          bil(B, wb, wh, ((x + 0.5) / W) * wb, ((y + 0.5) / H) * wh, t4);
          const deck = glatt(o.DECKUNG_LO, o.DECKUNG_HI, t4[3]);
          const a = deck * wEff;
          const b0 = t4[3] > 1e-6 ? t4[0] / t4[3] : X0, b1 = t4[3] > 1e-6 ? t4[1] / t4[3] : X1, b2 = t4[3] > 1e-6 ? t4[2] / t4[3] : X2;
          X0 += (b0 - X0) * a; X1 += (b1 - X1) * a; X2 += (b2 - X2) * a;
        }
        if (gleich) { out[i * 4] = orig[i * 4]; out[i * 4 + 1] = orig[i * 4 + 1]; out[i * 4 + 2] = orig[i * 4 + 2]; }
        else { out[i * 4] = srgbByte(X0); out[i * 4 + 1] = srgbByte(X1); out[i * 4 + 2] = srgbByte(X2); }
        out[i * 4 + 3] = 255;
      }
    return { daten: out, ms: performance.now() - t0 };
  };

  /** Beide Regler: erst Bokeh, dann Weichzeichnen. */
  C.beide = (orig, W, H, maskImg, par) => {
    const a = C.bokehBild(orig, W, H, maskImg, { ...par, linearAus: true });
    const b = C.weichBild(orig, W, H, maskImg, par, a.lin, a.beruehrt);
    return { daten: b.daten, ms: a.ms + b.ms };
  };
})();
