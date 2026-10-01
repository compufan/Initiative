/*
 * Messgeruest fuer Weichzeichnen und Bokeh – wird in die Seite der App eingespielt
 * (page.addScriptTag) und rechnet dort mit den echten Modulen des Arbeitsbaums.
 *
 * Alles in Bildpunkten eines Bildes W x H (Seitenverhaeltnis 4:3); die Geometrie
 * skaliert mit W/1200, damit dieselbe Szene bei 1200x900, 1920x1440 und 2560x1920
 * dasselbe zeigt.
 */
(() => {
  const M = (window.M = {});

  /* ---------- Hilfen ---------- */

  M.klemm = (v, a, b) => (v < a ? a : v > b ? b : v);
  const smooth = (a, b, x) => {
    const t = M.klemm((x - a) / (b - a || 1e-9), 0, 1);
    return t * t * (3 - 2 * t);
  };
  M.smooth = smooth;

  function hash(x, y, s) {
    let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 2147483647);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  M.hash = hash;

  /** Squared euclidean distance transform, Felzenszwalb. f: 0 fuer Merkmal, sonst INF. */
  function edt(merkmal, W, H) {
    const INF = 1e20;
    const d = new Float32Array(W * H);
    for (let i = 0; i < W * H; i += 1) d[i] = merkmal[i] ? 0 : INF;
    const n = Math.max(W, H);
    const f = new Float32Array(n);
    const v = new Int32Array(n);
    const z = new Float32Array(n + 1);
    const eins = (len) => {
      let k = 0;
      v[0] = 0;
      z[0] = -INF;
      z[1] = INF;
      for (let q = 1; q < len; q += 1) {
        let s;
        for (;;) {
          const p = v[k];
          s = (f[q] + q * q - (f[p] + p * p)) / (2 * q - 2 * p);
          if (s <= z[k] && k > 0) k -= 1;
          else break;
        }
        if (s <= z[k]) {
          // k == 0 und s <= z[0]
          v[0] = q;
          z[0] = -INF;
          z[1] = INF;
        } else {
          k += 1;
          v[k] = q;
          z[k] = s;
          z[k + 1] = INF;
        }
      }
      k = 0;
      for (let q = 0; q < len; q += 1) {
        while (z[k + 1] < q) k += 1;
        const p = v[k];
        f[q] = (q - p) * (q - p) + f[p];
      }
    };
    for (let x = 0; x < W; x += 1) {
      for (let y = 0; y < H; y += 1) f[y] = d[y * W + x];
      eins(H);
      for (let y = 0; y < H; y += 1) d[y * W + x] = f[y];
    }
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) f[x] = d[y * W + x];
      eins(W);
      for (let x = 0; x < W; x += 1) d[y * W + x] = Math.sqrt(f[x]);
    }
    return d;
  }
  M.edt = edt;

  /** Vorzeichenbehaftete Distanz zum Rand: aussen positiv, innen negativ. */
  M.vorzeichenAbstand = (drin, W, H) => {
    const raus = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i += 1) raus[i] = drin[i] ? 0 : 1;
    const dAussen = edt(drin, W, H); // Abstand zum naechsten "drin"-Punkt
    const dInnen = edt(raus, W, H); // Abstand zum naechsten "draussen"-Punkt
    const s = new Float32Array(W * H);
    for (let i = 0; i < W * H; i += 1) s[i] = drin[i] ? -(dInnen[i] - 0.5) : dAussen[i] - 0.5;
    return s;
  };

  /* ---------- Szene ---------- */

  /** Die Silhouette als Funktion (x, y in Bildpunkten) – eine Figur mit Kopf, Rumpf, Arm und duenner Stange. */
  function formFn(W) {
    const u = W / 1200;
    const cx = 600 * u;
    return (x, y) => {
      // Kopf
      if ((x - cx) ** 2 + (y - 290 * u) ** 2 < (115 * u) ** 2) return true;
      // Hals
      if (x > cx - 32 * u && x < cx + 32 * u && y > 380 * u && y < 450 * u) return true;
      // Rumpf
      const ex = (x - cx) / (230 * u);
      const ey = (y - 650 * u) / (280 * u);
      if (ex * ex + ey * ey < 1) return true;
      // Arm (Kapsel)
      {
        const ax = 420 * u, ay = 520 * u, bx = 250 * u, by = 300 * u, r = 30 * u;
        const dx = bx - ax, dy = by - ay;
        const t = M.klemm(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy), 0, 1);
        if ((x - ax - dx * t) ** 2 + (y - ay - dy * t) ** 2 < r * r) return true;
      }
      // duenne Stange, 9 Punkte breit (Haar, Zaun)
      if (x >= 1000 * u && x <= 1009 * u && y >= 110 * u && y <= 650 * u) return true;
      return false;
    };
  }

  const motivFarbe = (x, y) => {
    const k = (Math.floor(x / 14) + Math.floor(y / 14)) & 1;
    const n = (hash(x, y, 1) - 0.5) * 16;
    return k ? [205 + n, 45 + n * 0.3, 40 + n * 0.3] : [160 + n, 25 + n * 0.3, 25 + n * 0.3];
  };
  const grundFarbe = (x, y) => {
    const k = Math.floor((x + y) / 12) & 1;
    const n = (hash(x, y, 2) - 0.5) * 16;
    return k ? [45 + n * 0.3, 165 + n, 60 + n * 0.3] : [25 + n * 0.3, 115 + n, 45 + n * 0.3];
  };
  const dunkelFarbe = (x, y) => {
    const n = (hash(x, y, 3) - 0.5) * 6;
    return [12 + n, 12 + n, 18 + n];
  };
  const motivDunkel = (x, y) => {
    const k = (Math.floor(x / 14) + Math.floor(y / 14)) & 1;
    const n = (hash(x, y, 4) - 0.5) * 10;
    return k ? [78 + n, 66 + n, 60 + n] : [52 + n, 44 + n, 40 + n];
  };

  /**
   * Baut eine Szene.
   * art 'A': rotes Motiv auf gruenem Grund.
   * art 'B': dunkler Grund mit Lichtpunkten, dunkles Motiv davor.
   * Liefert: orig, nurGrund (Grundmuster ueberall), nurMotiv (Motivmuster ueberall), drin (Silhouette hart),
   *          sd (Abstand vorzeichenbehaftet), cov (Abdeckung 0..255, kantenglatt), punkte (Lichter).
   */
  M.szene = (art, W, H) => {
    const inside = art === 'C' ? () => false : formFn(W);
    const n = W * H;
    const orig = new Uint8ClampedArray(n * 4);
    const nurGrund = new Uint8ClampedArray(n * 4);
    const nurMotiv = new Uint8ClampedArray(n * 4);
    const drin = new Uint8Array(n);
    const cov = new Uint8Array(n);
    const u = W / 1200;
    const grund = art === 'A' ? grundFarbe : dunkelFarbe;
    const motiv = art === 'A' ? motivFarbe : motivDunkel;

    // Lichter: zwei Reihen. Die erste isoliert (Messung), die zweite als Kette hinter der Figur.
    const punkte = [];
    if (art === 'B') {
      const r = 2.6 * u;
      // isoliert, weit auseinander und weit vom Motiv (ab Bildmitte rechts/links aussen)
      [
        [110, 150],
        [330, 90],
        [900, 120],
        [1110, 330],
        [130, 560],
        [120, 790],
        [1100, 780],
        [930, 600],
      ].forEach(([x, y], i) => punkte.push({ x: x * u, y: y * u, r, farbe: i % 2 ? [255, 222, 170] : [255, 255, 255], iso: true }));
      // Kette hinter dem Kopf, teils vom Motiv verdeckt
      for (let i = 0; i < 7; i += 1) {
        const x = (350 + i * 75) * u;
        const y = (180 + 40 * Math.sin((i / 6) * Math.PI)) * u;
        punkte.push({ x, y, r, farbe: [255, 240, 200], iso: false });
      }
    }
    if (art === 'C') {
      // Eine Reihe Lichter quer durchs Bild – fuer Masken, die von links nach rechts ansteigen.
      const r = 2.6 * u;
      for (let i = 0; i < 9; i += 1) punkte.push({ x: (90 + i * 127) * u, y: 450 * u, r, farbe: [255, 255, 255], iso: true });
      for (let i = 0; i < 9; i += 1) punkte.push({ x: (90 + i * 127) * u, y: 200 * u, r, farbe: [255, 230, 170], iso: true });
      for (let i = 0; i < 9; i += 1) punkte.push({ x: (90 + i * 127) * u, y: 700 * u, r, farbe: [200, 230, 255], iso: true });
    }
    const lichtAn = (x, y) => {
      for (const p of punkte) {
        const d = Math.hypot(x - p.x, y - p.y);
        if (d <= p.r + 0.7) return { p, a: M.klemm(p.r + 0.5 - d, 0, 1) };
      }
      return null;
    };

    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const i = y * W + x;
        let c = 0;
        for (let sy = 0; sy < 3; sy += 1)
          for (let sx = 0; sx < 3; sx += 1) if (inside(x + (sx + 0.5) / 3, y + (sy + 0.5) / 3)) c += 1;
        c /= 9;
        cov[i] = Math.round(c * 255);
        drin[i] = inside(x + 0.5, y + 0.5) ? 1 : 0;
        const g = grund(x, y);
        const m = motiv(x, y);
        let gl = g;
        const l = lichtAn(x, y);
        if (l) gl = [g[0] + (l.p.farbe[0] - g[0]) * l.a, g[1] + (l.p.farbe[1] - g[1]) * l.a, g[2] + (l.p.farbe[2] - g[2]) * l.a];
        for (let k = 0; k < 3; k += 1) {
          orig[i * 4 + k] = gl[k] * (1 - c) + m[k] * c;
          nurGrund[i * 4 + k] = g[k];
          nurMotiv[i * 4 + k] = m[k];
        }
        orig[i * 4 + 3] = 255;
        nurGrund[i * 4 + 3] = 255;
        nurMotiv[i * 4 + 3] = 255;
      }
    }
    const sd = art === 'C' ? new Float32Array(W * H).fill(1e6) : M.vorzeichenAbstand(drin, W, H);
    return { art, W, H, orig, nurGrund, nurMotiv, drin, cov, sd, punkte };
  };

  /* ---------- Masken ---------- */

  /**
   * Die Silhouettenmaske, wie sie als Netzteil (Vorlagengroesse = Bildgroesse) vorliegt.
   * art: 'hart' | 'weich' (saum = Halbbreite) | 'netz' (Saum, Rauschen, kanteWeichzeichnen 1) | 'video'
   */
  M.motivAlpha = (sz, art, saum, saat) => {
    const { W, H, sd } = sz;
    const a = new Uint8Array(W * H);
    const zufall = (x, y, k) => hash(x, y, (saat || 7) * 31 + k);
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const i = y * W + x;
        const s = sd[i];
        if (art === 'hart') {
          a[i] = s < 0 ? 255 : 0;
        } else if (art === 'weich') {
          a[i] = Math.round(255 * (1 - smooth(-saum, saum, s)));
        } else {
          // Freistellnetz: weicher Saum, Dunst aussen 0..12, Zuversichtsrauschen innen 235..255
          const w = 1 - smooth(-saum, saum, s);
          // Das Rauschen ist grossflaechig verteilt (Modelle liefern gekoernte Zuversicht), nicht pro Punkt.
          const gx = Math.floor(x / 3), gy = Math.floor(y / 3);
          const r = zufall(gx, gy, 1);
          const v = w * (235 + 20 * r) + (1 - w) * (12 * zufall(gx, gy, 2));
          a[i] = Math.round(v);
        }
      }
    }
    if (art === 'netz' || art === 'video') return M.kanteWeich(a, W, H, 1);
    return a;
  };

  // Dieselbe Rechnung wie kanteWeichzeichnen (stickers/engines/prepare.ts) – der Kasten, Radius 1.
  M.kanteWeich = (alpha, W, H, r) => {
    const f = r * 2 + 1;
    const wg = new Uint8Array(alpha.length);
    for (let y = 0; y < H; y += 1) {
      const z = y * W;
      let s = 0;
      for (let x = -r; x <= r; x += 1) s += alpha[z + Math.min(W - 1, Math.max(0, x))];
      for (let x = 0; x < W; x += 1) {
        wg[z + x] = s / f;
        s -= alpha[z + Math.max(0, x - r)];
        s += alpha[z + Math.min(W - 1, x + r + 1)];
      }
    }
    const e = new Uint8Array(alpha.length);
    for (let x = 0; x < W; x += 1) {
      let s = 0;
      for (let y = -r; y <= r; y += 1) s += wg[Math.min(H - 1, Math.max(0, y)) * W + x];
      for (let y = 0; y < H; y += 1) {
        e[y * W + x] = s / f;
        s -= wg[Math.max(0, y - r) * W + x];
        s += wg[Math.min(H - 1, y + r + 1) * W + x];
      }
    }
    return e;
  };

  /** Bilinear abtasten wie objektFolge.abtasten. */
  function abtasten(m, px, py, W, H) {
    if (px < 0 || py < 0 || px > W - 1 || py > H - 1) return 0;
    const x0 = Math.floor(px), y0 = Math.floor(py);
    const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
    const ax = px - x0, ay = py - y0;
    const o = m[y0 * W + x0] * (1 - ax) + m[y0 * W + x1] * ax;
    const un = m[y1 * W + x0] * (1 - ax) + m[y1 * W + x1] * ax;
    return o * (1 - ay) + un * ay;
  }

  /**
   * Eine verfolgte Videomaske: zwei Schluesselmasken (um einen halben Bildpunkt gegeneinander versetzt, zweite
   * leicht gewachsen), ueberblendet bei t = 0,5, danach RLE-quantisiert – wie in objektFolge.ueberblenden und rle.ts.
   */
  M.videoAlpha = (netzAlpha, W, H, rle) => {
    const out = new Uint8Array(W * H);
    const cx = W / 2, cy = H / 2;
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const va = abtasten(netzAlpha, x - 1.3, y + 0.7, W, H);
        const s = 1.004;
        const vb = abtasten(netzAlpha, cx + (x - 0.4 - cx) / s, cy + (y + 0.2 - cy) / s, W, H);
        out[y * W + x] = Math.round(0.5 * va + 0.5 * vb);
      }
    }
    if (!rle) return out;
    return M.rle.rleDekodieren(M.rle.rleKodieren(out), W * H);
  };

  /* ---------- Module ---------- */

  M.laden = async () => {
    const imp = (p) => import(/* @vite-ignore */ p);
    M.ton = await imp('/src/modules/bild/ton.ts');
    M.gpu = await imp('/src/modules/bild/tonGpu.ts');
    M.maske = await imp('/src/modules/bild/maske.ts');
    M.rle = await imp('/src/modules/video/rle.ts');
    M.raum = await imp('/src/modules/bild/farbraum.ts');
    M.weichMod = await imp('/src/modules/bild/weich.ts');
    M.tiefeMod = await imp('/src/modules/bild/tiefe.ts');
  };

  /* ---------- Rendern ---------- */

  let zaehlerMarke = 1000;
  /** Bereich: { feld, raster, unschaerfe, extra } */
  M.leinwandAus = (daten, W, H) => {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = M.raum.flaeche2d(c, { willReadFrequently: true });
    // Im Arbeitsraum der Leinwand anlegen, sonst rechnet der Browser beim Einsetzen um.
    const id = ctx.createImageData(W, H);
    id.data.set(daten);
    ctx.putImageData(id, 0, 0);
    return c;
  };
  M.lesen = (flaeche, W, H) => {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = M.raum.flaeche2d(c, { willReadFrequently: true });
    ctx.drawImage(flaeche, 0, 0);
    return ctx.getImageData(0, 0, W, H).data;
  };

  /**
   * Rechnet die Szene durch den ECHTEN Renderer.
   * weg: 'gpu' | 'cpu'
   * bereiche: Liste { feld, raster, anpassung (Bereichston) }
   */
  M.rendern = (orig, W, H, bereiche, weg, global) => {
    zaehlerMarke += 1;
    const quelle = M.leinwandAus(orig, W, H);
    const szene = {
      bereiche: bereiche.map((b, i) => ({
        id: `b${i}`,
        maske: { raster: b.raster, feld: b.feld, stand: zaehlerMarke * 10 + i },
        anpassung: { ...M.ton.FARB_NEUTRAL, unschaerfe: 0, ...b.anpassung },
      })),
      schluessel: `mess${zaehlerMarke}`,
    };
    M.gpu.gpuAbschalten(weg === 'cpu');
    const t0 = performance.now();
    const fl = M.gpu.bildRechnen(quelle, W, H, global || M.ton.NEUTRAL, szene);
    const tRechnen = performance.now() - t0;
    const gel = M.gpu.letzterWeg;
    const daten = M.lesen(fl, W, H);
    M.gpu.gpuAbschalten(false);
    return { daten, weg: gel, ms: tRechnen };
  };

  /** Zeit eines Durchgangs inklusive Synchronisation (kleines Lesen), Median aus n. */
  M.zeit = (orig, W, H, bereiche, weg, n) => {
    const ts = [];
    const quelle = M.leinwandAus(orig, W, H);
    for (let k = 0; k < n + 1; k += 1) {
      zaehlerMarke += 1;
      const szene = {
        bereiche: bereiche.map((b, i) => ({
          id: `b${i}`,
          maske: { raster: b.raster, feld: b.feld, stand: zaehlerMarke * 10 + i },
          anpassung: { ...M.ton.FARB_NEUTRAL, unschaerfe: 0, ...b.anpassung },
        })),
        schluessel: `zeit${zaehlerMarke}`,
      };
      M.gpu.gpuAbschalten(weg === 'cpu');
      const t0 = performance.now();
      const fl = M.gpu.bildRechnen(quelle, W, H, M.ton.NEUTRAL, szene, { fluechtig: true });
      const c = document.createElement('canvas');
      c.width = 1;
      c.height = 1;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(fl, 0, 0, 1, 1);
      ctx.getImageData(0, 0, 1, 1);
      ts.push(performance.now() - t0);
      M.gpu.gpuAbschalten(false);
    }
    ts.shift(); // Aufwaermlauf
    ts.sort((a, b) => a - b);
    return ts[Math.floor(ts.length / 2)];
  };

  /** Ein Netzteil aus Alpha (Vorlagengroesse = Bildgroesse). */
  M.netzTeil = (alpha, W, H, umkehren, modus) => ({
    id: `n${++zaehlerMarke}`,
    modus: modus || 'dazu',
    umkehren: !!umkehren,
    art: 'netz',
    netz: 'object',
    breite: W,
    hoehe: H,
    alpha,
    marke: ++zaehlerMarke,
  });

  /** Raster und Rasterfeld aus Teilen – wie maskenSpeicher. */
  M.rasterFeld = (teile, W, H) => {
    const raster = M.maske.rasterFuer(W, H);
    const feld = M.maske.teileFalten(teile, raster);
    return { raster, feld };
  };

  /** Das Maskenfeld auf Bildgroesse – so wie es der Renderer (bilinear) sieht. */
  M.maskeAufBild = (feld, raster, W, H) => M.maske.maskeUmrastern(feld, raster.breite, raster.hoehe, W, H);

  /* ---------- Messen ---------- */

  M.chroma = (d, i) => {
    const s = d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2] + 1e-3;
    return d[i * 4] / s;
  };
  /** Mittlere Rotanteil-Chromazitaet eines reinen Bildes. */
  M.rotAnteil = (d, W, H) => {
    let s = 0;
    for (let i = 0; i < W * H; i += 1) s += M.chroma(d, i);
    return s / (W * H);
  };

  /** Motivanteil (0 = Grund, 1 = Motiv) eines Bildpunktes, aus der Chromazitaet. */
  M.alphaDach = (d, i, rBg, rMo) => M.klemm((M.chroma(d, i) - rBg) / (rMo - rBg), -0.5, 1.5);

  const GRUPPEN = [0, 2, 4, 8, 16, 32, 64, 1e9];
  const gruppe = (x) => {
    for (let g = 0; g < GRUPPEN.length - 1; g += 1) if (x >= GRUPPEN[g] && x < GRUPPEN[g + 1]) return g;
    return GRUPPEN.length - 2;
  };
  M.GRUPPEN = GRUPPEN;

  /**
   * Die Masse A und B.
   * maskImg: Maske auf Bildgroesse (0..255), Bereich = wo Maske hoch.
   * Abstand zur 0,5-Isolinie der Maske (aussen positiv).
   */
  M.messenAB = (orig, res, maskImg, W, H, rBg, rMo, fremd) => {
    const n = W * H;
    const drinM = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) drinM[i] = maskImg[i] >= 128 ? 1 : 0;
    const sdM = M.vorzeichenAbstand(drinM, W, H);

    const G = GRUPPEN.length - 1;
    const aus = { n: new Array(G).fill(0), dsum: new Array(G).fill(0), max: new Array(G).fill(0), ueber2: new Array(G).fill(0), m: new Array(G).fill(0) };
    const innen = { n: new Array(G).fill(0), fremd: new Array(G).fill(0), err: new Array(G).fill(0) };
    let nullAnz = 0, nullGeaendert = 0, nullMax = 0, nullGeaendert2 = 0;
    let klein = 0, kleinGeaendert = 0, klein15 = 0, klein15Geaendert = 0, klein15Max = 0;
    for (let i = 0; i < n; i += 1) {
      let dmax = 0;
      for (let k = 0; k < 3; k += 1) dmax = Math.max(dmax, Math.abs(res[i * 4 + k] - orig[i * 4 + k]));
      const m = maskImg[i];
      if (m === 0) {
        nullAnz += 1;
        if (dmax > 0) nullGeaendert += 1;
        if (dmax > 2) nullGeaendert2 += 1;
        if (dmax > nullMax) nullMax = dmax;
      }
      if (m <= 3) {
        klein += 1;
        if (dmax > 2) kleinGeaendert += 1;
      }
      if (m <= 15) {
        klein15 += 1;
        if (dmax > 0) klein15Geaendert += 1;
        if (dmax > klein15Max) klein15Max = dmax;
      }
      const s = sdM[i];
      if (s > 0) {
        const g = gruppe(s);
        aus.n[g] += 1;
        aus.dsum[g] += dmax;
        aus.m[g] += m;
        if (dmax > 2) aus.ueber2[g] += 1;
        if (dmax > aus.max[g]) aus.max[g] = dmax;
      } else {
        const g = gruppe(-s);
        innen.n[g] += 1;
        // fremdanteil: Anteil der Farbe aus dem Gegenstueck. fremd = 'motiv' -> Anteil Motivfarbe im Bereich.
        const a = M.alphaDach(res, i, rBg, rMo);
        innen.fremd[g] += fremd === 'motiv' ? a : 1 - a;
        let e = 0;
        for (let k = 0; k < 3; k += 1) e += Math.abs(res[i * 4 + k] - orig[i * 4 + k]);
        innen.err[g] += e / 3;
      }
    }
    const reichweite = (() => {
      // Weitester Abstand (aussen), in dem mehr als 1 % der Bildpunkte um mehr als 2 Stufen abweichen.
      let w = 0;
      for (let g = 0; g < G; g += 1) if (aus.n[g] > 0 && aus.ueber2[g] / aus.n[g] > 0.01) w = GRUPPEN[g + 1] === 1e9 ? GRUPPEN[g] : GRUPPEN[g + 1];
      return w;
    })();
    return {
      gruppen: GRUPPEN,
      aussen: aus.n.map((c, g) => ({
        bis: GRUPPEN[g + 1],
        n: c,
        mitteMaske: c ? +(aus.m[g] / c).toFixed(1) : null,
        mittelAbw: c ? +(aus.dsum[g] / c).toFixed(2) : null,
        anteilUeber2: c ? +(aus.ueber2[g] / c).toFixed(4) : null,
        max: aus.max[g],
      })),
      innen: innen.n.map((c, g) => ({
        bis: GRUPPEN[g + 1],
        n: c,
        fremdAnteil: c ? +(innen.fremd[g] / c).toFixed(4) : null,
        abweichOrig: c ? +(innen.err[g] / c).toFixed(2) : null,
      })),
      maskeNull: { n: nullAnz, geaendert: nullGeaendert, ueber2: nullGeaendert2, max: nullMax },
      kleinerGleich3: { n: klein, ueber2: kleinGeaendert },
      kleinerGleich15: { n: klein15, geaendert: klein15Geaendert, max: klein15Max },
      reichweiteAussen: reichweite,
      sdM,
    };
  };

  /** Breite des 10–90-%-Uebergangs eines gemittelten Profils (t = -T..T). */
  function breite1090(profil, ts, vom, zum) {
    const lo = Math.min(vom, zum), hi = Math.max(vom, zum);
    if (hi - lo < 1e-6) return NaN;
    const norm = profil.map((p) => (p - vom) / (zum - vom));
    const finde = (level) => {
      for (let i = 0; i + 1 < norm.length; i += 1) {
        if ((norm[i] - level) * (norm[i + 1] - level) <= 0 && norm[i] !== norm[i + 1]) {
          const t = (level - norm[i]) / (norm[i + 1] - norm[i]);
          return ts[i] + t * (ts[i + 1] - ts[i]);
        }
      }
      return NaN;
    };
    return Math.abs(finde(0.9) - finde(0.1));
  }
  function lage50(profil, ts, vom, zum) {
    if (Math.abs(zum - vom) < 1e-6) return NaN;
    const norm = profil.map((p) => (p - vom) / (zum - vom));
    for (let i = 0; i + 1 < norm.length; i += 1) {
      if ((norm[i] - 0.5) * (norm[i + 1] - 0.5) <= 0 && norm[i] !== norm[i + 1]) {
        const t = (0.5 - norm[i]) / (norm[i + 1] - norm[i]);
        return ts[i] + t * (ts[i + 1] - ts[i]);
      }
    }
    return NaN;
  }

  /**
   * Profile quer zur Motivkante (Kopf, Kreisbogen) – Mittel ueber viele Randpunkte.
   * liefert die Profile von 'alphaDach' fuer Ergebnisbilder und das der Maske.
   */
  M.kantenProfile = (sz, bilder, maskImg, rBg, rMo) => {
    const { W, H } = sz;
    const u = W / 1200;
    const cx = 600 * u, cy = 290 * u, r = 115 * u;
    const T = Math.round(40 * u);
    const ts = [];
    for (let t = -T; t <= T; t += 0.5) ts.push(t);
    const bil = (d, x, y, f) => {
      const x0 = Math.floor(x), y0 = Math.floor(y);
      const ax = x - x0, ay = y - y0;
      const v = (xx, yy) => f(d, M.klemm(yy, 0, H - 1) * W + M.klemm(xx, 0, W - 1));
      return (v(x0, y0) * (1 - ax) + v(x0 + 1, y0) * ax) * (1 - ay) + (v(x0, y0 + 1) * (1 - ax) + v(x0 + 1, y0 + 1) * ax) * ay;
    };
    const aus = { ts };
    const punkte = [];
    // Randpunkte des Kopfes von -75 bis +75 Grad um die Senkrechte nach oben (kein Hals, kein Arm).
    for (let w = -75; w <= 75; w += 3) {
      const a = (w * Math.PI) / 180;
      punkte.push({ x: cx + Math.sin(a) * r, y: cy - Math.cos(a) * r, nx: Math.sin(a), ny: -Math.cos(a) });
    }
    const mitteln = (d, f) => {
      const p = new Array(ts.length).fill(0);
      for (const q of punkte) for (let i = 0; i < ts.length; i += 1) p[i] += bil(d, q.x + q.nx * ts[i], q.y + q.ny * ts[i], f);
      return p.map((v) => v / punkte.length);
    };
    const fA = (d, i) => M.alphaDach(d, i, rBg, rMo);
    const fM = (d, i) => d[i] / 255;
    for (const k of Object.keys(bilder)) aus[k] = mitteln(bilder[k], fA);
    aus.maske = mitteln(maskImg, fM);
    return aus;
  };

  /** Kennzahlen aus einem Profil (t von innen (-) nach aussen (+)). */
  M.profilKennzahlen = (prof, ts) => {
    const mitteBis = (a, b) => {
      let s = 0, n = 0;
      for (let i = 0; i < ts.length; i += 1) if (ts[i] >= a && ts[i] <= b) { s += prof[i]; n += 1; }
      return s / n;
    };
    const innen = mitteBis(-30, -12);
    const aussen = mitteBis(12, 30);
    // Steilheit: groesste Steigung je Punkt
    let steil = 0;
    for (let i = 1; i < ts.length; i += 1) steil = Math.max(steil, Math.abs(prof[i] - prof[i - 1]) / (ts[i] - ts[i - 1]));
    let ueberAussen = -9, unterInnen = 9;
    for (let i = 0; i < ts.length; i += 1) {
      if (ts[i] >= 3 && ts[i] <= 20) ueberAussen = Math.max(ueberAussen, prof[i]);
      if (ts[i] <= -3 && ts[i] >= -20) unterInnen = Math.min(unterInnen, prof[i]);
    }
    return { innen, aussen, breite1090: breite1090(prof, ts, innen, aussen), lage50: lage50(prof, ts, innen, aussen), steilheit: steil, maxAussen: ueberAussen, minInnen: unterInnen, rand4: mitteBis(-5, -3) - mitteBis(3, 5) };
  };

  /* ---------- Lichter ---------- */

  /**
   * Die isolierten Lichtpunkte: radiales Mittel um jedes (r/R in 0,05-Schritten bis 1,6) und Streuung am Ring.
   */
  M.lichterMessen = (sz, res, R) => {
    const { W, H } = sz;
    const iso = sz.punkte.filter((p) => p.iso);
    const schritt = 0.05;
    const n = Math.round(1.7 / schritt);
    const summe = new Array(n).fill(0);
    const anz = new Array(n).fill(0);
    const ringStreu = new Array(n).fill(0);
    const ringWerte = Array.from({ length: n }, () => []);
    let spitze = 0;
    const gtGrund = [];
    for (const p of iso) {
      const x0 = Math.floor(p.x - R * 1.8), x1 = Math.ceil(p.x + R * 1.8);
      const y0 = Math.floor(p.y - R * 1.8), y1 = Math.ceil(p.y + R * 1.8);
      for (let y = Math.max(0, y0); y <= Math.min(H - 1, y1); y += 1)
        for (let x = Math.max(0, x0); x <= Math.min(W - 1, x1); x += 1) {
          const d = Math.hypot(x + 0.5 - p.x - 0.0, y + 0.5 - p.y) / R;
          const b = Math.floor(d / schritt);
          if (b >= n) continue;
          const i = y * W + x;
          const v = (res[i * 4] + res[i * 4 + 1] + res[i * 4 + 2]) / 3;
          summe[b] += v;
          anz[b] += 1;
          ringWerte[b].push(v);
          if (d < 1.0 && v > spitze) spitze = v;
        }
    }
    const radial = summe.map((s, i) => (anz[i] ? s / anz[i] : 0));
    for (let i = 0; i < n; i += 1) {
      const w = ringWerte[i];
      if (w.length < 4) continue;
      const m = radial[i];
      let q = 0;
      for (const v of w) q += (v - m) * (v - m);
      ringStreu[i] = Math.sqrt(q / w.length);
    }
    const mitte = (a, b) => {
      let s = 0, c = 0;
      for (let i = 0; i < n; i += 1) {
        const d = (i + 0.5) * schritt;
        if (d >= a && d <= b) { s += radial[i]; c += 1; }
      }
      return c ? s / c : 0;
    };
    const streu = (a, b) => {
      let s = 0, c = 0;
      for (let i = 0; i < n; i += 1) {
        const d = (i + 0.5) * schritt;
        if (d >= a && d <= b) { s += ringStreu[i]; c += 1; }
      }
      return c ? s / c : 0;
    };
    const innen = mitte(0.15, 0.75);
    const rand = mitte(0.85, 0.97);
    const aussen = mitte(1.15, 1.45);
    return {
      spitze,
      innen,
      rand,
      aussen,
      randZuInnen: innen > 0 ? rand / innen : 0,
      aussenZuInnen: innen > 0 ? aussen / innen : 0,
      streuungInnen: innen > 0 ? streu(0.15, 0.75) / innen : 0,
      radial,
    };
  };

  /* ---------- Bilder ---------- */

  M.bildUrl = (daten, W, H) => {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d');
    ctx.putImageData(new ImageData(new Uint8ClampedArray(daten), W, H), 0, 0);
    return c.toDataURL('image/png');
  };

  /**
   * Nebeneinander: Ausschnitte (x0,y0,w,h), jeweils zoom-fach vergroessert, optional Differenzbild (verstaerkt).
   * bilder: [{titel, daten}], letzte Spalte optional Differenz zum ersten.
   */
  M.montage = (bilder, W, H, x0, y0, w, h, zoom, diffFaktor) => {
    const spalten = bilder.length + (diffFaktor ? bilder.length - 1 : 0);
    const c = document.createElement('canvas');
    c.width = spalten * (w * zoom + 4);
    c.height = h * zoom + 16;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#222';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.imageSmoothingEnabled = false;
    let s = 0;
    const zeichne = (daten, titel) => {
      const t = document.createElement('canvas');
      t.width = w;
      t.height = h;
      const tc = t.getContext('2d');
      const id = tc.createImageData(w, h);
      for (let y = 0; y < h; y += 1)
        for (let x = 0; x < w; x += 1) {
          const q = ((y0 + y) * W + (x0 + x)) * 4;
          const p = (y * w + x) * 4;
          id.data[p] = daten[q];
          id.data[p + 1] = daten[q + 1];
          id.data[p + 2] = daten[q + 2];
          id.data[p + 3] = 255;
        }
      tc.putImageData(id, 0, 0);
      ctx.drawImage(t, s * (w * zoom + 4), 16, w * zoom, h * zoom);
      ctx.fillStyle = '#fff';
      ctx.font = '12px sans-serif';
      ctx.fillText(titel, s * (w * zoom + 4) + 4, 12);
      s += 1;
    };
    bilder.forEach((b) => zeichne(b.daten, b.titel));
    if (diffFaktor) {
      const ref = bilder[0].daten;
      for (let k = 1; k < bilder.length; k += 1) {
        const d = new Uint8ClampedArray(W * H * 4);
        for (let i = 0; i < W * H; i += 1) {
          for (let c2 = 0; c2 < 3; c2 += 1) d[i * 4 + c2] = Math.min(255, Math.abs(bilder[k].daten[i * 4 + c2] - ref[i * 4 + c2]) * diffFaktor);
          d[i * 4 + 3] = 255;
        }
        zeichne(d, `Diff ${bilder[k].titel} x${diffFaktor}`);
      }
    }
    return c.toDataURL('image/png');
  };

  /** Untereinander: Ausschnitt (x0,y0,w,h) je Bild, vergroessert. */
  M.montageV = (bilder, W, H, x0, y0, w, h, zoom) => {
    const c = document.createElement('canvas');
    c.width = w * zoom;
    c.height = bilder.length * (h * zoom + 14);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#222';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.imageSmoothingEnabled = false;
    bilder.forEach((b, s) => {
      const t = document.createElement('canvas');
      t.width = w;
      t.height = h;
      const tc = t.getContext('2d');
      const id = tc.createImageData(w, h);
      for (let y = 0; y < h; y += 1)
        for (let x = 0; x < w; x += 1) {
          const q = ((y0 + y) * W + (x0 + x)) * 4;
          const p = (y * w + x) * 4;
          id.data[p] = b.daten[q];
          id.data[p + 1] = b.daten[q + 1];
          id.data[p + 2] = b.daten[q + 2];
          id.data[p + 3] = 255;
        }
      tc.putImageData(id, 0, 0);
      ctx.drawImage(t, 0, s * (h * zoom + 14) + 14, w * zoom, h * zoom);
      ctx.fillStyle = '#fff';
      ctx.font = '12px sans-serif';
      ctx.fillText(b.titel, 4, s * (h * zoom + 14) + 11);
    });
    return c.toDataURL('image/png');
  };
})();
