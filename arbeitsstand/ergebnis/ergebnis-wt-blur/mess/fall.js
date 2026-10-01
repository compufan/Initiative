/*
 * Ein Fall durch den echten Renderer, samt allen Massen. Benutzt lib.js.
 */
(() => {
  const M = window.M;
  M.cache = {};
  M.szeneHolen = (art, W, Hopt) => {
    const H = Hopt ?? Math.round((W * 3) / 4);
    const k = `${art}${W}x${H}`;
    if (!M.cache[k]) {
      const sz = M.szene(art, W, H);
      sz.rBg = M.rotAnteil(sz.nurGrund, W, H);
      sz.rMo = M.rotAnteil(sz.nurMotiv, W, H);
      M.cache[k] = sz;
    }
    return M.cache[k];
  };

  M.alphaFuer = (sz, maske) => {
    const { W, H } = sz;
    const u = W / 1200;
    switch (maske) {
      case 'hart':
        return M.motivAlpha(sz, 'hart', 0);
      case 'weich6':
        return M.motivAlpha(sz, 'weich', 6 * u);
      case 'weich20':
        return M.motivAlpha(sz, 'weich', 20 * u);
      case 'netz':
        return M.motivAlpha(sz, 'netz', 8 * u);
      case 'netzbreit':
        return M.motivAlpha(sz, 'netz', 27 * u);
      case 'video':
        return M.videoAlpha(M.motivAlpha(sz, 'netz', 8 * u), W, H, true);
      case 'videobreit':
        return M.videoAlpha(M.motivAlpha(sz, 'netz', 27 * u), W, H, true);
      case 'hverlauf': {
        // Masken-Verlauf von links (0) nach rechts (255) – wie eine Tiefenkarte, die nach hinten wachsende Unschaerfe meint
        const a = new Uint8Array(W * H);
        for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) a[y * W + x] = Math.round((x / (W - 1)) * 255);
        return a;
      }
      case 'voll':
        return new Uint8Array(W * H).fill(255);
      default:
        throw new Error(`Maske ${maske}?`);
    }
  };

  /**
   * opt: art, W, maske, ziel ('motiv'|'grund'), u (Unschaerfe 0..1), wege (['gpu','cpu']), bilder (bool), anpassung (Zusatz)
   */
  M.fall = (opt) => {
    const sz = M.szeneHolen(opt.art, opt.W);
    const { W, H } = sz;
    const alpha = M.alphaFuer(sz, opt.maske);
    const teil = M.netzTeil(alpha, W, H, opt.ziel === 'grund');
    const { raster, feld } = M.rasterFeld([teil], W, H);
    const maskImg = M.maskeAufBild(feld, raster, W, H);
    const bereiche = [{ feld, raster, anpassung: { unschaerfe: opt.u ?? 1, ...(opt.anpassung || {}) } }];
    const aus = { opt: { ...opt }, R: M.weichMod.bokehRadius(opt.u ?? 1, Math.max(W, H)) };
    const ergebnisse = {};
    for (const weg of opt.wege || ['gpu', 'cpu']) {
      const r = M.rendern(sz.orig, W, H, bereiche, weg);
      ergebnisse[weg] = r.daten;
      aus[`${weg}Weg`] = r.weg;
      aus[`${weg}Ms`] = +r.ms.toFixed(0);
    }
    const fremd = opt.ziel === 'motiv' ? 'grund' : 'motiv';
    const fremdNamen = { motiv: 'motiv', grund: 'grund' };
    aus.massnahmen = {};
    for (const weg of Object.keys(ergebnisse)) {
      const ab = M.messenAB(sz.orig, ergebnisse[weg], maskImg, W, H, sz.rBg, sz.rMo, fremd === 'motiv' ? 'motiv' : 'grund');
      delete ab.sdM;
      aus.massnahmen[weg] = ab;
    }
    // Kanten
    const bilder = { orig: sz.orig, ...ergebnisse };
    const prof = M.kantenProfile(sz, bilder, maskImg, sz.rBg, sz.rMo);
    aus.kante = { maske: M.profilKennzahlen(prof.maske, prof.ts) };
    aus.kante.orig = M.profilKennzahlen(prof.orig, prof.ts);
    for (const weg of Object.keys(ergebnisse)) aus.kante[weg] = M.profilKennzahlen(prof[weg], prof.ts);
    if (opt.art === 'B') {
      aus.lichter = {};
      for (const weg of Object.keys(ergebnisse)) {
        const l = M.lichterMessen(sz, ergebnisse[weg], aus.R);
        delete l.radial;
        aus.lichter[weg] = l;
      }
    }
    aus.ergebnisse = ergebnisse;
    aus.sz = sz;
    aus.maskImg = maskImg;
    aus.feld = feld;
    aus.raster = raster;
    return aus;
  };

  /** Bildausgabe fuer einen Fall als Data-URLs. */
  M.bilderFuer = (f, opt) => {
    const { W, H } = f.sz;
    const u = W / 1200;
    const x0 = Math.round((opt && opt.x0) ?? 640 * u), y0 = Math.round((opt && opt.y0) ?? 215 * u);
    const w = Math.round((opt && opt.w) ?? 160 * u), h = Math.round((opt && opt.h) ?? 120 * u);
    const zoom = (opt && opt.zoom) || 3;
    const liste = [{ titel: 'Original', daten: f.sz.orig }];
    for (const weg of Object.keys(f.ergebnisse)) liste.push({ titel: weg.toUpperCase(), daten: f.ergebnisse[weg] });
    const ausschnitt = M.montage(liste, W, H, x0, y0, w, h, zoom, (opt && opt.diff) || 4);
    const mask = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i += 1) {
      mask[i * 4] = mask[i * 4 + 1] = mask[i * 4 + 2] = f.maskImg[i];
      mask[i * 4 + 3] = 255;
    }
    const gesamt = M.montage([...liste.slice(0, 1), ...liste.slice(1), { titel: 'Maske', daten: mask }], W, H, 0, 0, W, H, 0.4, 0);
    return { ausschnitt, gesamt };
  };
})();

/* ---------- Motiv + Tiefe ---------- */
(() => {
  const M = window.M;
  /**
   * Die Maske "Motiv + Tiefe": Tiefenteil (dazu) und Netzteil (weg), so wie BildEditor.kombiAnlegen sie baut.
   * Die Tiefenkarte: oben fern (0), unten nah (255); das Motiv steht vorn.
   */
  M.tiefeMotiv = (sz, maskeArt, fokus, spanne) => {
    const { W, H } = sz;
    const u = W / 1200;
    const karte = new Uint8Array(W * H);
    for (let y = 0; y < H; y += 1)
      for (let x = 0; x < W; x += 1) {
        let t = y / (H - 1);
        if (sz.drin[y * W + x]) t = Math.max(t, 0.85);
        karte[y * W + x] = Math.round(255 * t);
      }
    const alpha = M.alphaFuer(sz, maskeArt);
    const tiefe = { id: `t${Math.random()}`, modus: 'dazu', umkehren: false, art: 'tiefe', breite: W, hoehe: H, karte, fokus, spanne, marke: Math.round(Math.random() * 1e9) };
    const netz = M.netzTeil(alpha, W, H, false, 'weg');
    const { raster, feld } = M.rasterFeld([tiefe, netz], W, H);
    // nur die Tiefe (ohne das Motiv)
    const { feld: nurTiefe } = M.rasterFeld([tiefe], W, H);
    // die Silhouette als Reinheit: 255 - Motiv
    const { feld: nurNetz } = M.rasterFeld([M.netzTeil(alpha, W, H, true, 'dazu')], W, H);
    return { raster, feld, nurTiefe, reinheit: nurNetz };
  };

  /** Schaerfe des Hintergrunds je Abstand vom Motiv, bei gleicher Tiefe. */
  M.haloSchaerfe = (sz, res, tiefeImg) => {
    const { W, H, sd } = sz;
    const lum = (i) => 0.3 * res[i * 4] + 0.59 * res[i * 4 + 1] + 0.11 * res[i * 4 + 2];
    const gruppen = [0, 4, 8, 16, 32, 64, 1e9];
    const s = new Array(gruppen.length - 1).fill(0), c = new Array(gruppen.length - 1).fill(0);
    let max = 0;
    for (let i = 0; i < W * H; i += 1) if (tiefeImg[i] > max) max = tiefeImg[i];
    for (let y = 1; y < H - 1; y += 1)
      for (let x = 1; x < W - 1; x += 1) {
        const i = y * W + x;
        if (sd[i] <= 0) continue;
        const d = tiefeImg[i] / (max || 1);
        if (d < 0.75 || d > 0.85) continue; // ein Band gleicher Tiefenunschaerfe
        const g = Math.abs(lum(i + 1) - lum(i - 1)) + Math.abs(lum(i + W) - lum(i - W));
        let k = 0;
        while (k < gruppen.length - 2 && sd[i] >= gruppen[k + 1]) k += 1;
        s[k] += g;
        c[k] += 1;
      }
    return s.map((v, k) => (c[k] ? +(v / c[k]).toFixed(2) : null));
  };
})();

(() => {
  const M = window.M;
  /** Alle Masse A-E fuer mehrere Ergebnisse (Name -> RGBA) einer Szene/Maske. */
  M.werten = (sz, maskImg, opt, ergebnisse, Rlicht) => {
    const { W, H } = sz;
    const fremd = opt.ziel === 'motiv' ? 'grund' : 'motiv';
    const aus = { massnahmen: {}, kante: {}, lichter: {} };
    for (const k of Object.keys(ergebnisse)) {
      const ab = M.messenAB(sz.orig, ergebnisse[k], maskImg, W, H, sz.rBg, sz.rMo, fremd === 'motiv' ? 'motiv' : 'grund');
      delete ab.sdM;
      aus.massnahmen[k] = ab;
    }
    const prof = M.kantenProfile(sz, { orig: sz.orig, ...ergebnisse }, maskImg, sz.rBg, sz.rMo);
    aus.kante.maske = M.profilKennzahlen(prof.maske, prof.ts);
    aus.kante.orig = M.profilKennzahlen(prof.orig, prof.ts);
    for (const k of Object.keys(ergebnisse)) aus.kante[k] = M.profilKennzahlen(prof[k], prof.ts);
    if (opt.art === 'B') {
      for (const k of Object.keys(ergebnisse)) {
        const l = M.lichterMessen(sz, ergebnisse[k], Rlicht);
        delete l.radial;
        aus.lichter[k] = l;
      }
    }
    return aus;
  };
})();
