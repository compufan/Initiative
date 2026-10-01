/*
 * Referenzrechnung fuer den Entwurf (Gleitkomma, Prozessor, brute force – nur zum Messen).
 * Rechnet im linearen Licht. Liefert ein 8-Bit-RGBA wie der echte Renderer, damit dieselben Masse gelten.
 */
(() => {
  const M = window.M;
  const P = (M.P = {});

  const ZU_LIN = new Float32Array(256);
  for (let i = 0; i < 256; i += 1) {
    const c = i / 255;
    ZU_LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  const zuSrgb = (v) => {
    if (!(v > 0)) return 0;
    if (v >= 1) return 255;
    const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    return Math.round(c * 255);
  };
  P.ZU_LIN = ZU_LIN;
  P.zuSrgb = zuSrgb;

  P.ramp = (x, a, b) => {
    const t = (x - a) / (b - a);
    return t < 0 ? 0 : t > 1 ? 1 : t;
  };
  const sm = (a, b, x) => {
    const t = P.ramp(x, a, b);
    return t * t * (3 - 2 * t);
  };
  P.sm = sm;

  P.standard = {
    // Maske
    LOW: 0.06, // darunter: nichts (Staub der Netze)
    HIGH: 0.92, // darueber: voll (Zuversichtsrauschen)
    KERN_LO: 0.5, // Gueltigkeit der Abtastung: ab hier
    KERN_HI: 0.9, // voll gueltig ab hier
    DECKUNG_LO: 0.02, // Rueckfall: Deckung der Scheibe unter diesem Anteil -> Original
    DECKUNG_HI: 0.2,
    T1: 0.5, // Bokeh: Einblendung des Ergebnisses bis zu dieser Maske voll
    // Weichzeichnen
    SIGMA_MAX: 0.012, // Anteil der langen Kante bei Regler 1
    // Bokeh
    R_MAX: 0.02, // dito, Radius der Scheibe
    K: 40, // Verstaerkung heller Stellen
    L0: 0.55,
    L1: 1.0,
    form: 'hex',
    stufen: 0, // 0 = exakt je Bildpunkt, sonst Anzahl Radiusstufen (GPU-Naeherung)
    kernMax: false,
  };

  /** Bild 8 Bit -> lineares Licht, 3 Kanaele nebeneinander (Float32Array(3N)). */
  P.linear = (rgba, n) => {
    const l = new Float32Array(n * 3);
    for (let i = 0; i < n; i += 1) {
      l[i * 3] = ZU_LIN[rgba[i * 4]];
      l[i * 3 + 1] = ZU_LIN[rgba[i * 4 + 1]];
      l[i * 3 + 2] = ZU_LIN[rgba[i * 4 + 2]];
    }
    return l;
  };

  /** Gauss, getrennt, ueber vorbelegte 4-Kanal-Felder (premultipliziert: rgb*gewicht, gewicht). */
  P.gauss4 = (src, W, H, sigma) => {
    if (!(sigma > 0.2)) return src;
    const r = Math.ceil(sigma * 3);
    const k = new Float32Array(2 * r + 1);
    let s = 0;
    for (let i = -r; i <= r; i += 1) {
      k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
      s += k[i + r];
    }
    for (let i = 0; i < k.length; i += 1) k[i] /= s;
    const tmp = new Float32Array(W * H * 4);
    const out = new Float32Array(W * H * 4);
    for (let y = 0; y < H; y += 1)
      for (let x = 0; x < W; x += 1) {
        let a = 0, b = 0, c = 0, d = 0;
        for (let i = -r; i <= r; i += 1) {
          const xx = Math.min(W - 1, Math.max(0, x + i));
          const q = (y * W + xx) * 4;
          const w = k[i + r];
          a += src[q] * w; b += src[q + 1] * w; c += src[q + 2] * w; d += src[q + 3] * w;
        }
        const o = (y * W + x) * 4;
        tmp[o] = a; tmp[o + 1] = b; tmp[o + 2] = c; tmp[o + 3] = d;
      }
    for (let y = 0; y < H; y += 1)
      for (let x = 0; x < W; x += 1) {
        let a = 0, b = 0, c = 0, d = 0;
        for (let i = -r; i <= r; i += 1) {
          const yy = Math.min(H - 1, Math.max(0, y + i));
          const q = (yy * W + x) * 4;
          const w = k[i + r];
          a += tmp[q] * w; b += tmp[q + 1] * w; c += tmp[q + 2] * w; d += tmp[q + 3] * w;
        }
        const o = (y * W + x) * 4;
        out[o] = a; out[o + 1] = b; out[o + 2] = c; out[o + 3] = d;
      }
    return out;
  };

  /** Liegt (dx,dy) in der Blende mit Radius r? Sechseck: Ecken links und rechts. Scheibe: Kreis. */
  const innen = (form, dx, dy, r) => {
    if (form === 'disc') return dx * dx + dy * dy <= r * r + 0.25;
    const ax = Math.abs(dx), ay = Math.abs(dy);
    return ay <= r * 0.8660254 + 0.01 && ax + ay / 1.7320508 <= r + 0.01;
  };

  /**
   * Gewichtete Scheibe/Sechseck mit Radius je Bildpunkt (rMap) ueber premultiplizierte 5 Kanaele:
   * rgb*gew, gew(=mit Verstaerkung), g (Gueltigkeit ohne Verstaerkung).
   * Liefert Summen je Bildpunkt sowie die Anzahl der Stellen (Flaeche).
   */
  P.scheibe5 = (src, W, H, rMap, form, rQuelle) => {
    const out = new Float32Array(W * H * 5);
    const cnt = new Float32Array(W * H);
    for (let y = 0; y < H; y += 1)
      for (let x = 0; x < W; x += 1) {
        const r = rMap[y * W + x];
        const o = (y * W + x) * 5;
        if (!(r >= 0.5)) {
          cnt[y * W + x] = 0;
          continue;
        }
        const ri = Math.ceil(r);
        let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, n = 0;
        for (let dy = -ri; dy <= ri; dy += 1) {
          const yy = Math.min(H - 1, Math.max(0, y + dy));
          for (let dx = -ri; dx <= ri; dx += 1) {
            const xx = Math.min(W - 1, Math.max(0, x + dx));
            if (!innen(form, dx, dy, r)) continue;
            // Reichweite: Die Quelle zaehlt nur, wenn ihre eigene Scheibe bis hierher reicht.
            if (rQuelle && rQuelle[yy * W + xx] < Math.hypot(dx, dy) - 0.5) {
              n += 1;
              continue;
            }
            const q = (yy * W + xx) * 5;
            s0 += src[q]; s1 += src[q + 1]; s2 += src[q + 2]; s3 += src[q + 3]; s4 += src[q + 4];
            n += 1;
          }
        }
        out[o] = s0; out[o + 1] = s1; out[o + 2] = s2; out[o + 3] = s3; out[o + 4] = s4;
        cnt[y * W + x] = n;
      }
    return { sum: out, cnt };
  };

  /**
   * Der Vorschlag.
   * orig: Uint8ClampedArray RGBA; maske: Uint8Array (0..255) in Bildgroesse; opt: { weich, bokeh, ... }.
   * Liefert RGBA 8 Bit.
   */
  P.rendern = (orig, W, H, maske, opt) => {
    const o = { ...P.standard, ...opt };
    const n = W * H;
    const L = P.linear(orig, n);
    const kante = Math.max(W, H);
    const wEff = new Float32Array(n);
    const g = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      const m = maske[i] / 255;
      wEff[i] = P.ramp(m, o.LOW, o.HIGH);
      const mr = o.reinheitFeld ? o.reinheitFeld[i] / 255 : m;
      g[i] = o.kernMax ? (mr >= 0.5 ? 1 : 0) : P.ramp(mr, o.KERN_LO, o.KERN_HI);
    }
    let X = L;

    /* ---------- Bokeh ---------- */
    if (o.bokeh > 0) {
      const R = o.bokeh * o.R_MAX * kante;
      const rMap = new Float32Array(n);
      const t = new Float32Array(n);
      for (let i = 0; i < n; i += 1) {
        const m = maske[i] / 255;
        rMap[i] = o.radiusKonst ? (wEff[i] > 0 ? R : 0) : R * wEff[i];
        t[i] = o.mischKonst === 'eins' ? (wEff[i] > 0 ? 1 : 0) : P.ramp(m, o.LOW, o.T1);
      }
      const gB = o.reinheit === 'eins' ? new Float32Array(n).fill(1) : g;
      const Y = new Float32Array(n * 3);
      const quelleBauen = (minRadius) => {
        const src = new Float32Array(n * 5);
        for (let i = 0; i < n; i += 1) {
          const r = L[i * 3], gg = L[i * 3 + 1], b = L[i * 3 + 2];
          const hell = Math.max(r, gg, b);
          const boost = 1 + o.K * sm(o.L0, o.L1 ?? 1.0, hell);
          let gi = gB[i];
          if (minRadius !== undefined && rMap[i] < minRadius) gi = 0;
          const w = boost * gi;
          src[i * 5] = r * w; src[i * 5 + 1] = gg * w; src[i * 5 + 2] = b * w; src[i * 5 + 3] = w; src[i * 5 + 4] = gi;
        }
        return src;
      };
      const mischen = (S3, sum, cnt, i, dst, off) => {
        // Ergebnis der Scheibe an Stelle i, mit Rueckfall auf das Original nach Deckung
        const c = cnt[i];
        if (c === 0) {
          dst[off] = S3[i * 3]; dst[off + 1] = S3[i * 3 + 1]; dst[off + 2] = S3[i * 3 + 2];
          return;
        }
        const s3 = sum[i * 5 + 3];
        const deck = o.deckungAlt ? sum[i * 5 + 4] / c : s3 / c;
        const a = sm(o.DECKUNG_LO, o.DECKUNG_HI, deck);
        for (let k = 0; k < 3; k += 1) {
          const bl = s3 > 1e-9 ? sum[i * 5 + k] / s3 : S3[i * 3 + k];
          dst[off + k] = S3[i * 3 + k] + (bl - S3[i * 3 + k]) * a;
        }
      };
      if (!(o.ebenen > 0)) {
        const src = quelleBauen();
        const { sum, cnt } = P.scheibe5(src, W, H, rMap, o.form, o.reichweite ? rMap : null);
        const tmp = new Float32Array(3);
        for (let i = 0; i < n; i += 1) {
          if (cnt[i] === 0 || t[i] === 0) {
            Y[i * 3] = L[i * 3]; Y[i * 3 + 1] = L[i * 3 + 1]; Y[i * 3 + 2] = L[i * 3 + 2];
            continue;
          }
          mischen(L, sum, cnt, i, tmp, 0);
          for (let k = 0; k < 3; k += 1) Y[i * 3 + k] = L[i * 3 + k] + (tmp[k] - L[i * 3 + k]) * t[i];
        }
      } else {
        // Stufen: Radius k/K * R, jede Stufe mit festem Radius fuer ALLE Bildpunkte; dazwischen linear.
        const K = o.ebenen;
        const stufen = [];
        for (let k = 1; k <= K; k += 1) {
          const rk = (R * k) / K;
          const rFest = new Float32Array(n).fill(rk);
          const src = quelleBauen(o.reichweite ? rk - (0.5 * R) / K : undefined);
          const { sum, cnt } = P.scheibe5(src, W, H, rFest, o.form, null);
          const lk = new Float32Array(n * 3);
          for (let i = 0; i < n; i += 1) mischen(L, sum, cnt, i, lk, i * 3);
          stufen.push(lk);
        }
        for (let i = 0; i < n; i += 1) {
          if (t[i] === 0 || rMap[i] < 0.25) {
            Y[i * 3] = L[i * 3]; Y[i * 3 + 1] = L[i * 3 + 1]; Y[i * 3 + 2] = L[i * 3 + 2];
            continue;
          }
          let u = Math.min(K, (rMap[i] / R) * K);
          if (o.ebenenModus === 'naechste') u = Math.round(u);
          const lo = Math.min(K - 1, Math.floor(u));
          const fr = o.ebenenModus === 'naechste' ? (u >= lo + 1 ? 1 : 0) : u - lo;
          for (let k = 0; k < 3; k += 1) {
            const a = lo === 0 ? L[i * 3 + k] : stufen[lo - 1][i * 3 + k];
            const b = stufen[lo][i * 3 + k];
            const v = a + (b - a) * fr;
            Y[i * 3 + k] = L[i * 3 + k] + (v - L[i * 3 + k]) * t[i];
          }
        }
      }
      X = Y;
    }

    /* ---------- Weichzeichnen ---------- */
    if (o.weich > 0) {
      const sigma = o.weich * o.SIGMA_MAX * kante;
      const src = new Float32Array(n * 4);
      for (let i = 0; i < n; i += 1) {
        src[i * 4] = X[i * 3] * g[i]; src[i * 4 + 1] = X[i * 3 + 1] * g[i]; src[i * 4 + 2] = X[i * 3 + 2] * g[i]; src[i * 4 + 3] = g[i];
      }
      const bl = P.gauss4(src, W, H, sigma);
      const Y = new Float32Array(n * 3);
      for (let i = 0; i < n; i += 1) {
        const w = wEff[i];
        if (w === 0) {
          Y[i * 3] = X[i * 3]; Y[i * 3 + 1] = X[i * 3 + 1]; Y[i * 3 + 2] = X[i * 3 + 2];
          continue;
        }
        const cov = bl[i * 4 + 3];
        const a = sm(o.DECKUNG_LO, o.DECKUNG_HI, cov) * w;
        for (let k = 0; k < 3; k += 1) {
          const b = cov > 1e-6 ? bl[i * 4 + k] / cov : X[i * 3 + k];
          Y[i * 3 + k] = X[i * 3 + k] + (b - X[i * 3 + k]) * a;
        }
      }
      X = Y;
    }

    // zurueck nach 8 Bit; wo nichts verarbeitet wurde, das Original unveraendert lassen
    const out = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i += 1) {
      const gleich = X[i * 3] === L[i * 3] && X[i * 3 + 1] === L[i * 3 + 1] && X[i * 3 + 2] === L[i * 3 + 2];
      if (gleich) {
        out[i * 4] = orig[i * 4]; out[i * 4 + 1] = orig[i * 4 + 1]; out[i * 4 + 2] = orig[i * 4 + 2];
      } else {
        out[i * 4] = zuSrgb(X[i * 3]); out[i * 4 + 1] = zuSrgb(X[i * 3 + 1]); out[i * 4 + 2] = zuSrgb(X[i * 3 + 2]);
      }
      out[i * 4 + 3] = 255;
    }
    return out;
  };

  /** Ein Fall mit dem Vorschlag: wie M.fall, aber Rendern ueber P.rendern. */
  P.fall = (opt, par) => {
    const sz = M.szeneHolen(opt.art, opt.W);
    const { W, H } = sz;
    const alpha = M.alphaFuer(sz, opt.maske);
    const teil = M.netzTeil(alpha, W, H, opt.ziel === 'grund');
    const { raster, feld } = M.rasterFeld([teil], W, H);
    const maskImg = M.maskeAufBild(feld, raster, W, H);
    const aus = { opt: { ...opt }, par };
    const t0 = performance.now();
    const res = P.rendern(sz.orig, W, H, maskImg, par);
    aus.ms = Math.round(performance.now() - t0);
    const fremd = opt.ziel === 'motiv' ? 'grund' : 'motiv';
    const ab = M.messenAB(sz.orig, res, maskImg, W, H, sz.rBg, sz.rMo, fremd === 'motiv' ? 'motiv' : 'grund');
    delete ab.sdM;
    aus.massnahmen = { proto: ab };
    const prof = M.kantenProfile(sz, { orig: sz.orig, proto: res }, maskImg, sz.rBg, sz.rMo);
    aus.kante = { maske: M.profilKennzahlen(prof.maske, prof.ts), orig: M.profilKennzahlen(prof.orig, prof.ts), proto: M.profilKennzahlen(prof.proto, prof.ts) };
    if (opt.art === 'B') {
      const R = (par.bokeh || 0) * (par.R_MAX || P.standard.R_MAX) * Math.max(W, H);
      const l = M.lichterMessen(sz, res, (par.form === 'disc' ? R : 0.87 * R) || 1);
      delete l.radial;
      aus.lichter = { proto: l };
    }
    aus.ergebnisse = { proto: res };
    aus.sz = sz;
    aus.maskImg = maskImg;
    aus.feld = feld;
    aus.raster = raster;
    return aus;
  };
})();
