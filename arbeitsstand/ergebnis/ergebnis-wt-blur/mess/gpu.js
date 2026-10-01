/*
 * Der Entwurf als Mehrdurchlauf-Schattierer (WebGL2), nur zum Messen von Kosten und Gleichheit mit der
 * Referenzrechnung (proto.js). Eigene Leinwand, eigene Programme – der Renderer der App bleibt unberuehrt.
 */
(() => {
  const M = window.M;
  const G = (M.G = {});

  const VS = `#version 300 es
in vec2 aOrt;
void main() { gl_Position = vec4(aOrt, 0.0, 1.0); }`;

  const KOPF = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
out vec4 fragColor;
float zuLinear1(float c) { return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4); }
vec3 zuLinear(vec3 c) { return vec3(zuLinear1(c.r), zuLinear1(c.g), zuLinear1(c.b)); }
float zuSrgb1(float c) { return c <= 0.0031308 ? c * 12.92 : 1.055 * pow(c, 1.0 / 2.4) - 0.055; }
vec3 zuSrgb(vec3 c) { return vec3(zuSrgb1(c.r), zuSrgb1(c.g), zuSrgb1(c.b)); }
float rampe(float x, float a, float b) { return clamp((x - a) / (b - a), 0.0, 1.0); }
float glatt(float a, float b, float x) { float t = rampe(x, a, b); return t * t * (3.0 - 2.0 * t); }
uniform int uReinheit;      // 0 = Kern aus der Maske selbst, 1 = alles gueltig (glatte Masken), 2 = eigenes Kernfeld
uniform sampler2D uKernT;
uniform float uSLo, uSHi, uRLo, uRHi, uGLo, uGHi;
float reinAus(float m, vec2 uv) { return uReinheit == 0 ? m : (uReinheit == 1 ? 1.0 : texture(uKernT, uv).r); }
float staerke(float m, float rein) { return rampe(m, uSLo, uSHi) * (uReinheit == 1 ? 1.0 : rampe(rein, uRLo, uRHi)); }
float kernGewicht(float rein) { return uReinheit == 1 ? 1.0 : rampe(rein, uGLo, uGHi); }
`;

  /* 1. Vorbereitung: Bild + Maske -> (Licht*Gewicht, Gewicht), in Arbeitsgroesse */
  const PREP = `${KOPF}
uniform sampler2D uQuelle;   // RGBA8 (sRGB) oder RGBA16F (linear)
uniform sampler2D uMaske;    // Maskenraster, Kanal R
uniform int uQuelleLinear;
uniform ivec2 uQuelleGroesse;
uniform int uFaktor;         // Quellpunkte je Arbeitspunkt und Achse
uniform float uTheta;
uniform float uThetaBis;
uniform float uK, uL0, uL1;  // Verstaerkung heller Stellen
void main() {
  ivec2 p0 = ivec2(gl_FragCoord.xy) * uFaktor;
  vec4 summe = vec4(0.0);
  for (int j = 0; j < uFaktor; j++) {
    for (int i = 0; i < uFaktor; i++) {
      ivec2 p = min(p0 + ivec2(i, j), uQuelleGroesse - 1);
      vec3 c = texelFetch(uQuelle, p, 0).rgb;
      if (uQuelleLinear == 0) c = zuLinear(c);
      vec2 uvp = (vec2(p) + 0.5) / vec2(uQuelleGroesse);
      float m = texture(uMaske, uvp).r;
      float rein = reinAus(m, uvp);
      float s = staerke(m, rein);
      float g = kernGewicht(rein);
      if (s < uTheta || s >= uThetaBis) g = 0.0;
      float hell = max(c.r, max(c.g, c.b));
      float b = 1.0 + uK * glatt(uL0, uL1, hell);
      float w = b * g;
      summe += vec4(c * w, w);
    }
  }
  fragColor = summe / float(uFaktor * uFaktor);
}`;

  /* 1b. Vorbereitung fuer bis zu vier Stufen in EINEM Durchgang (jeder Quellpunkt gehoert genau einer Stufe) */
const PREP_MRT = `${KOPF.replace('out vec4 fragColor;', '')}
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
layout(location = 3) out vec4 o3;
uniform sampler2D uQuelle;
uniform sampler2D uMaske;
uniform int uQuelleLinear;
uniform ivec2 uQuelleGroesse;
uniform int uFaktor;
uniform int uBandBasis;
uniform int uAnzahl;
uniform float uK, uL0, uL1;
void main() {
  ivec2 p0 = ivec2(gl_FragCoord.xy) * uFaktor;
  vec4 a0 = vec4(0.0), a1 = vec4(0.0), a2 = vec4(0.0), a3 = vec4(0.0);
  for (int j = 0; j < uFaktor; j++) {
    for (int i = 0; i < uFaktor; i++) {
      ivec2 p = min(p0 + ivec2(i, j), uQuelleGroesse - 1);
      vec2 uvp = (vec2(p) + 0.5) / vec2(uQuelleGroesse);
      float m = texture(uMaske, uvp).r;
      float rein = reinAus(m, uvp);
      float s = staerke(m, rein);
      int band = int(floor(s * float(uAnzahl) + 0.5)) - uBandBasis;
      if (band < 0 || band > 3) continue;
      float g = kernGewicht(rein);
      if (g <= 0.0) continue;
      vec3 c = texelFetch(uQuelle, p, 0).rgb;
      if (uQuelleLinear == 0) c = zuLinear(c);
      float hell = max(c.r, max(c.g, c.b));
      float w = (1.0 + uK * glatt(uL0, uL1, hell)) * g;
      vec4 v = vec4(c * w, w);
      if (band == 0) a0 += v; else if (band == 1) a1 += v; else if (band == 2) a2 += v; else a3 += v;
    }
  }
  float inv = 1.0 / float(uFaktor * uFaktor);
  o0 = a0 * inv; o1 = a1 * inv; o2 = a2 * inv; o3 = a3 * inv;
}`;

/* 2. Eine Strecke: Mittel ueber N Stellen von p bis p + Schritt */
  const LINIE = `${KOPF}
uniform sampler2D uQ;
uniform vec2 uSchritt;  // ganze Strecke in Texturkoordinaten
uniform int uN;
uniform vec2 uGroesse;
void main() {
  vec2 uv = (gl_FragCoord.xy) / uGroesse;
  vec4 s = vec4(0.0);
  for (int j = 0; j < uN; j++) {
    s += texture(uQ, uv + uSchritt * ((float(j) + 0.5) / float(uN)));
  }
  fragColor = s / float(uN);
}`;

  /* 3. Drei Rauten zum Sechseck */
  const VERBUND = `${KOPF}
uniform sampler2D uT0;
uniform sampler2D uT1;
uniform vec2 uE1;
uniform vec2 uE2;
uniform int uN;
uniform vec2 uGroesse;
void main() {
  vec2 uv = (gl_FragCoord.xy) / uGroesse;
  vec4 s = vec4(0.0);
  for (int j = 0; j < uN; j++) {
    float t = (float(j) + 0.5) / float(uN);
    s += texture(uT0, uv + uE1 * t);
    s += texture(uT0, uv + uE2 * t);
    s += texture(uT1, uv + uE2 * t);
  }
  fragColor = s / float(3 * uN);
}`;

  /* 4. Gauss, eine Achse */
  const GAUSS = `${KOPF}
uniform sampler2D uQ;
uniform vec2 uRichtung; // Texel in Texturkoordinaten
uniform float uSigma;
uniform int uR;
uniform vec2 uGroesse;
void main() {
  vec2 uv = gl_FragCoord.xy / uGroesse;
  vec4 s = vec4(0.0);
  float ges = 0.0;
  for (int j = -uR; j <= uR; j++) {
    float w = exp(-float(j * j) / (2.0 * uSigma * uSigma));
    s += w * texture(uQ, uv + uRichtung * float(j));
    ges += w;
  }
  fragColor = s / ges;
}`;

  /* 5. Zusammensetzen der Stufen: nach Maske die Stufe waehlen, Rueckfall nach Deckung, mit Original mischen */
  const STUFEN = `${KOPF}
uniform sampler2D uQuelle;
uniform int uQuelleLinear;
uniform sampler2D uMaske;
uniform sampler2D uS1, uS2, uS3, uS4, uS5, uS6, uS7, uS8;
uniform ivec2 uGroesse;
uniform int uAnzahl;
uniform int uSumme;
uniform float uDeckLo, uDeckHi;
uniform int uAusgabe; // 0 = linear in Float-Ziel, 1 = sRGB auf die Leinwand
vec4 stufe(int k, vec2 uv) {
  if (k == 1) return texture(uS1, uv);
  if (k == 2) return texture(uS2, uv);
  if (k == 3) return texture(uS3, uv);
  if (k == 4) return texture(uS4, uv);
  if (k == 5) return texture(uS5, uv);
  if (k == 6) return texture(uS6, uv);
  if (k == 7) return texture(uS7, uv);
  return texture(uS8, uv);
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 uv = (vec2(p) + 0.5) / vec2(uGroesse);
  vec4 roh = texelFetch(uQuelle, p, 0);
  vec3 S = uQuelleLinear == 0 ? zuLinear(roh.rgb) : roh.rgb;
  float m = texture(uMaske, uv).r;
  float s = staerke(m, reinAus(m, uv));
  float t = rampe(s, 0.0, 0.5);
  vec3 X = S;
  bool gleich = true;
  if (t > 0.0 && s > 0.0) {
    int k = int(floor(s * float(uAnzahl) + 0.5));
    if (k > 0) {
      vec4 b = stufe(min(k, uAnzahl), uv);
      if (uSumme == 1) {
        b = vec4(0.0);
        for (int q = 1; q <= 8; q++) { if (q > uAnzahl) break; b += stufe(q, uv); }
      }
      float deck = glatt(uDeckLo, uDeckHi, b.a);
      vec3 bl = b.a > 1e-6 ? b.rgb / b.a : S;
      X = S + (bl - S) * deck * t;
      gleich = false;
    }
  }
  if (uAusgabe == 1) {
    fragColor = vec4(gleich && uQuelleLinear == 0 ? roh.rgb : zuSrgb(clamp(X, 0.0, 1.0)), 1.0);
  } else {
    fragColor = vec4(X, gleich ? 0.0 : 1.0);
  }
}`;

  /* 6. Weichzeichnen zusammensetzen */
  const WEICH = `${KOPF}
uniform sampler2D uQuelle;   // X (linear, Float; Alpha = beruehrt) oder das 8-Bit-Bild
uniform sampler2D uOriginal; // immer das 8-Bit-Bild
uniform int uQuelleLinear;
uniform sampler2D uMaske;
uniform sampler2D uB;
uniform ivec2 uGroesse;
uniform float uDeckLo, uDeckHi;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 uv = (vec2(p) + 0.5) / vec2(uGroesse);
  vec4 roh = texelFetch(uQuelle, p, 0);
  vec3 S = uQuelleLinear == 0 ? zuLinear(roh.rgb) : roh.rgb;
  float m = texture(uMaske, uv).r;
  float w = staerke(m, reinAus(m, uv));
  vec3 X = S;
  bool gleich = uQuelleLinear == 0 || roh.a < 0.5;
  if (w > 0.0) {
    vec4 b = texture(uB, uv);
    float deck = glatt(uDeckLo, uDeckHi, b.a);
    vec3 bl = b.a > 1e-6 ? b.rgb / b.a : S;
    X = S + (bl - S) * deck * w;
    gleich = false;
  }
  fragColor = vec4(gleich ? texelFetch(uOriginal, p, 0).rgb : zuSrgb(clamp(X, 0.0, 1.0)), 1.0);
}`;

  function uebersetzen(gl, art, text) {
    const s = gl.createShader(art);
    gl.shaderSource(s, text);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) + '\n' + text.split('\n').map((z, i) => `${i + 1}: ${z}`).join('\n'));
    return s;
  }
  function programm(gl, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, uebersetzen(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(p, uebersetzen(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const orte = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i += 1) {
      const info = gl.getActiveUniform(p, i);
      orte[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name);
    }
    return { p, orte };
  }

  G.init = () => {
    if (G.gl) return G;
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('kein WebGL2');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('kein EXT_color_buffer_float');
    G.canvas = c;
    G.gl = gl;
    G.prog = {
      prep: programm(gl, PREP),
      prepMrt: programm(gl, PREP_MRT),
      linie: programm(gl, LINIE),
      verbund: programm(gl, VERBUND),
      gauss: programm(gl, GAUSS),
      stufen: programm(gl, STUFEN),
      weich: programm(gl, WEICH),
    };
    const puffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, puffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    for (const k of Object.keys(G.prog)) {
      const loc = gl.getAttribLocation(G.prog[k].p, 'aOrt');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    }
    G.leer = G.textur8(new Uint8Array(4), 1, 1, false);
    return G;
  };

  /** Eine Float-Textur samt Zielpuffer, aus dem Vorrat. */
  G.ziel = (b, h) => {
    const gl = G.gl;
    const t = gl.createTexture();
    // Auf einer Einheit anlegen, die sonst nie gelesen wird – sonst ueberschreibt das Anlegen die Bindung einer
    // gerade benutzten Textur (Rueckkopplung: Ziel und Quelle zugleich).
    gl.activeTexture(gl.TEXTURE0 + 15);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, b, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Zielpuffer unvollstaendig');
    return { t, f, b, h };
  };
  G.frei = (z) => {
    G.gl.deleteFramebuffer(z.f);
    G.gl.deleteTexture(z.t);
  };

  const binden = (gl, einheit, tex) => {
    gl.activeTexture(gl.TEXTURE0 + einheit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  };
  const zeichnen = (ziel) => {
    const gl = G.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, ziel ? ziel.f : null);
    gl.viewport(0, 0, ziel ? ziel.b : G.canvas.width, ziel ? ziel.h : G.canvas.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (G.debug) {
      const e = gl.getError();
      if (e) (G.fehler ??= []).push(`${G.aktuell}: ${e}`);
    }
  };
  const nutzen = (name) => {
    const gl = G.gl;
    G.aktuell = name;
    gl.useProgram(G.prog[name].p);
    return G.prog[name].orte;
  };

  /** RGBA8-Textur aus Bytes (Zeile 0 = oben, ohne Spiegelung). */
  G.textur8 = (daten, b, h, linear) => {
    const gl = G.gl;
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + 15);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, b, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, daten);
    const f = linear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };

  G.maskeTextur = (feld, rb, rh) => {
    const d = new Uint8Array(rb * rh * 4);
    for (let i = 0; i < rb * rh; i += 1) { d[i * 4] = feld[i]; d[i * 4 + 3] = 255; }
    return G.textur8(d, rb, rh, true);
  };

  /** Die gemeinsamen Uniforms: Maske (Einheit 1), Kernfeld (Einheit 13), Rampen. */
  G.gemeinsam = (u, o, kernTex) => {
    const gl = G.gl;
    gl.uniform1i(u.uReinheit, o.reinheit ?? 0);
    gl.uniform1f(u.uSLo, o.S_LO); gl.uniform1f(u.uSHi, o.S_HI);
    gl.uniform1f(u.uRLo, o.R_LO); gl.uniform1f(u.uRHi, o.R_HI);
    gl.uniform1f(u.uGLo, o.G_LO); gl.uniform1f(u.uGHi, o.G_HI);
    if (u.uKernT) {
      gl.activeTexture(gl.TEXTURE0 + 13);
      gl.bindTexture(gl.TEXTURE_2D, kernTex ?? G.leer);
      gl.uniform1i(u.uKernT, 13);
    }
  };

  G.standard = {
    S_LO: 0.03, S_HI: 0.97, R_LO: 0.25, R_HI: 0.75, G_LO: 0.5, G_HI: 0.9, DECKUNG_LO: 0.02, DECKUNG_HI: 0.2, K: 100, L0: 0.6, L1: 0.98,
  };
  G.standardAlt = { LOW: 0.06, HIGH: 0.92, KERN_LO: 0.5, KERN_HI: 0.9, T1: 0.5, DECKUNG_LO: 0.02, DECKUNG_HI: 0.2, K: 100, L0: 0.6, L1: 0.98 };

  /** Arbeitsmassstab so, dass der Radius in Arbeitspunkten hoechstens `grenze` ist: Faktor 1, 2 oder 4 (8). */
  G.faktorFuer = (radius, grenze) => {
    let f = 1;
    while (radius / f > grenze && f < 8) f *= 2;
    return f;
  };

  /**
   * Die Bokeh-Stufe. quelle: { tex, linear, b, h }, maske: Textur. Liefert ein Float-Ziel (linear, Vollaufloesung) oder malt
   * nach sRGB auf die Leinwand (ausgabe = true).
   * opt: { R (Radius in Bildpunkten), K (Stufen), reinheit (0/1), ebene (Zielpuffer fuer das Ergebnis oder null) }
   */
  G.bokeh = (quelle, maske, opt) => {
    const gl = G.gl;
    const o = { ...G.standard, ...opt };
    const { b, h } = quelle;
    const f = o.faktor ?? G.faktorFuer(o.R, 6);
    const wb = Math.ceil(b / f), wh = Math.ceil(h / f);
    const Kst = o.K_stufen;
    const P = G.ziel(wb, wh), T0 = G.ziel(wb, wh), T1 = G.ziel(wb, wh);
    const stufen = [];
    const e0 = [0, -1], e1 = [-0.8660254, 0.5], e2 = [0.8660254, 0.5];
    let mrtP = null;
    if (o.summiert && o.mrt) {
      mrtP = [];
      for (let gi = 0; gi < Math.ceil(Kst / 4); gi += 1) {
        const ziele = [];
        for (let q = 0; q < 4; q += 1) ziele.push(G.ziel(wb, wh));
        const fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        for (let q = 0; q < 4; q += 1) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + q, gl.TEXTURE_2D, ziele[q].t, 0);
        gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2, gl.COLOR_ATTACHMENT3]);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('MRT unvollstaendig');
        const um = nutzen('prepMrt');
        binden(gl, 0, quelle.tex);
        binden(gl, 1, maske);
        gl.uniform1i(um.uQuelle, 0);
        gl.uniform1i(um.uMaske, 1);
        gl.uniform1i(um.uQuelleLinear, quelle.linear ? 1 : 0);
        gl.uniform2i(um.uQuelleGroesse, b, h);
        gl.uniform1i(um.uFaktor, f);
        gl.uniform1i(um.uBandBasis, gi * 4 + 1);
        gl.uniform1i(um.uAnzahl, Kst);
        G.gemeinsam(um, o, o.kernTex);
        gl.uniform1f(um.uK, o.K); gl.uniform1f(um.uL0, o.L0); gl.uniform1f(um.uL1, o.L1);
        gl.viewport(0, 0, wb, wh);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
        gl.deleteFramebuffer(fbo);
        for (let q = 0; q < 4; q += 1) mrtP.push(ziele[q]);
      }
    }
    for (let k = 1; k <= Kst; k += 1) {
      const rk = (o.R / f) * (k / Kst); // Radius in Arbeitspunkten
      const n = Math.max(1, Math.min(63, Math.ceil(rk * (o.tapDichte ?? 1))));
      // Vorbereitung
      let u;
      if (!mrtP) {
      u = nutzen('prep');
      binden(gl, 0, quelle.tex);
      binden(gl, 1, maske);
      gl.uniform1i(u.uQuelle, 0);
      gl.uniform1i(u.uMaske, 1);
      gl.uniform1i(u.uQuelleLinear, quelle.linear ? 1 : 0);
      gl.uniform2i(u.uQuelleGroesse, b, h);
      gl.uniform1i(u.uFaktor, f);
      G.gemeinsam(u, o, o.kernTex);
      gl.uniform1f(u.uTheta, (k - 0.5) / Kst);
      gl.uniform1f(u.uThetaBis, o.summiert ? (k === Kst ? 9 : (k + 0.5) / Kst) : 9);
      gl.uniform1f(u.uK, o.K); gl.uniform1f(u.uL0, o.L0); gl.uniform1f(u.uL1, o.L1);
      zeichnen(P);
      }
      const Pk = mrtP ? mrtP[k - 1] : P;
      // zwei Strecken
      u = nutzen('linie');
      gl.uniform1i(u.uQ, 0);
      gl.uniform1i(u.uN, n);
      gl.uniform2f(u.uGroesse, wb, wh);
      binden(gl, 0, Pk.t);
      gl.uniform2f(u.uSchritt, (e0[0] * rk) / wb, (e0[1] * rk) / wh);
      zeichnen(T0);
      gl.uniform2f(u.uSchritt, (e1[0] * rk) / wb, (e1[1] * rk) / wh);
      zeichnen(T1);
      // drei Rauten
      u = nutzen('verbund');
      binden(gl, 0, T0.t);
      binden(gl, 1, T1.t);
      gl.uniform1i(u.uT0, 0);
      gl.uniform1i(u.uT1, 1);
      gl.uniform2f(u.uE1, (e1[0] * rk) / wb, (e1[1] * rk) / wh);
      gl.uniform2f(u.uE2, (e2[0] * rk) / wb, (e2[1] * rk) / wh);
      gl.uniform1i(u.uN, n);
      gl.uniform2f(u.uGroesse, wb, wh);
      const S = G.ziel(wb, wh);
      zeichnen(S);
      stufen.push(S);
    }
    G.frei(P); G.frei(T0); G.frei(T1);
    if (mrtP) for (const z of mrtP) G.frei(z);
    // Zusammensetzen
    const u = nutzen('stufen');
    binden(gl, 0, quelle.tex);
    binden(gl, 1, maske);
    gl.uniform1i(u.uQuelle, 0);
    gl.uniform1i(u.uMaske, 1);
    gl.uniform1i(u.uQuelleLinear, quelle.linear ? 1 : 0);
    for (let k = 0; k < 8; k += 1) {
      const name = `uS${k + 1}`;
      binden(gl, 2 + k, stufen[Math.min(k, stufen.length - 1)].t);
      gl.uniform1i(u[name], 2 + k);
    }
    gl.uniform2i(u.uGroesse, b, h);
    gl.uniform1i(u.uAnzahl, Kst);
    G.gemeinsam(u, o, o.kernTex);
    gl.uniform1f(u.uDeckLo, o.DECKUNG_LO); gl.uniform1f(u.uDeckHi, o.DECKUNG_HI);
    gl.uniform1i(u.uAusgabe, o.ausgabe ? 1 : 0);
    gl.uniform1i(u.uSumme, o.summiert ? 1 : 0);
    let ergebnis = null;
    if (o.ausgabe) {
      G.canvas.width = b;
      G.canvas.height = h;
      zeichnen(null);
    } else {
      ergebnis = G.ziel(b, h);
      zeichnen(ergebnis);
    }
    for (const s of stufen) G.frei(s);
    return ergebnis;
  };

  /** Die Weichzeichnen-Stufe (Gauss, Kreuzfaltung ueber Gewichte). */
  G.weich = (quelle, maske, opt) => {
    const gl = G.gl;
    const o = { ...G.standard, ...opt };
    const { b, h } = quelle;
    const f = o.faktor ?? G.faktorFuer(o.sigma * 3, 12);
    const wb = Math.ceil(b / f), wh = Math.ceil(h / f);
    const P = G.ziel(wb, wh), T = G.ziel(wb, wh), B = G.ziel(wb, wh);
    let u = nutzen('prep');
    binden(gl, 0, quelle.tex);
    binden(gl, 1, maske);
    gl.uniform1i(u.uQuelle, 0);
    gl.uniform1i(u.uMaske, 1);
    gl.uniform1i(u.uQuelleLinear, quelle.linear ? 1 : 0);
    gl.uniform2i(u.uQuelleGroesse, b, h);
    gl.uniform1i(u.uFaktor, f);
    G.gemeinsam(u, o, o.kernTex);
    gl.uniform1f(u.uTheta, 0);
    gl.uniform1f(u.uThetaBis, 9);
    gl.uniform1f(u.uK, 0); gl.uniform1f(u.uL0, 0.6); gl.uniform1f(u.uL1, 0.98);
    zeichnen(P);
    const sig = o.sigma / f;
    const r = Math.min(64, Math.ceil(sig * 3));
    u = nutzen('gauss');
    gl.uniform1i(u.uQ, 0);
    gl.uniform1f(u.uSigma, Math.max(0.3, sig));
    gl.uniform1i(u.uR, r);
    gl.uniform2f(u.uGroesse, wb, wh);
    binden(gl, 0, P.t);
    gl.uniform2f(u.uRichtung, 1 / wb, 0);
    zeichnen(T);
    binden(gl, 0, T.t);
    gl.uniform2f(u.uRichtung, 0, 1 / wh);
    zeichnen(B);
    u = nutzen('weich');
    binden(gl, 0, quelle.tex);
    binden(gl, 1, maske);
    binden(gl, 2, B.t);
    binden(gl, 3, quelle.original ?? quelle.tex);
    gl.uniform1i(u.uQuelle, 0);
    gl.uniform1i(u.uMaske, 1);
    gl.uniform1i(u.uB, 2);
    gl.uniform1i(u.uOriginal, 3);
    gl.uniform1i(u.uQuelleLinear, quelle.linear ? 1 : 0);
    gl.uniform2i(u.uGroesse, b, h);
    G.gemeinsam(u, o, o.kernTex);
    gl.uniform1f(u.uDeckLo, o.DECKUNG_LO); gl.uniform1f(u.uDeckHi, o.DECKUNG_HI);
    G.canvas.width = b;
    G.canvas.height = h;
    zeichnen(null);
    G.frei(P); G.frei(T); G.frei(B);
  };

  G.lesen = (b, h) => {
    const gl = G.gl;
    const d = new Uint8Array(b * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, b, h, gl.RGBA, gl.UNSIGNED_BYTE, d);
    return new Uint8ClampedArray(d.buffer);
  };
  G.sync = () => {
    const gl = G.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const x = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, x);
  };

  /**
   * Bokeh auf ein 8-Bit-Bild mit Maske (Bildgroesse). Liefert { daten, ms }.
   * par: { bokeh, K_stufen, reinheit }
   */
  G.bokehBild = (orig, W, H, maskImg, par, mess) => {
    G.init();
    const gl = G.gl;
    const maskeD = new Uint8Array(W * H);
    maskeD.set(maskImg);
    const quelle = { tex: G.textur8(orig, W, H, false), linear: false, b: W, h: H };
    const maske = G.maskeTextur(maskeD, W, H);
    const R = par.bokeh * 0.02 * Math.max(W, H);
    const laufen = () => {
      G.bokeh(quelle, maske, { R, K_stufen: par.K_stufen ?? 3, reinheit: par.reinheit ?? 0, ausgabe: true, K: par.K ?? 100, faktor: par.faktor, summiert: par.summiert, mrt: par.mrt, tapDichte: par.tapDichte, kernTex: par.kernImg ? G.maskeTextur(par.kernImg, W, H) : null });
    };
    laufen();
    G.sync();
    let ms = 0;
    if (mess) {
      const ts = [];
      for (let i = 0; i < mess; i += 1) {
        const t0 = performance.now();
        laufen();
        G.sync();
        ts.push(performance.now() - t0);
      }
      ts.sort((a, b) => a - b);
      ms = ts[Math.floor(ts.length / 2)];
    }
    const daten = G.lesen(W, H);
    gl.deleteTexture(quelle.tex);
    gl.deleteTexture(maske);
    // Zeile 0 = unten beim Lesen; wir haben ohne Spiegelung gearbeitet, also stimmt die Zeilenfolge bereits
    return { daten, ms };
  };

  G.weichBild = (orig, W, H, maskImg, par, mess) => {
    G.init();
    const gl = G.gl;
    const maskeD = new Uint8Array(W * H);
    maskeD.set(maskImg);
    const quelle = { tex: G.textur8(orig, W, H, false), linear: false, b: W, h: H };
    const maske = G.maskeTextur(maskeD, W, H);
    const sigma = par.weich * 0.012 * Math.max(W, H);
    const laufen = () => G.weich(quelle, maske, { sigma, reinheit: par.reinheit ?? 0, faktor: par.faktor, kernTex: par.kernImg ? G.maskeTextur(par.kernImg, W, H) : null });
    laufen();
    G.sync();
    let ms = 0;
    if (mess) {
      const ts = [];
      for (let i = 0; i < mess; i += 1) {
        const t0 = performance.now();
        laufen();
        G.sync();
        ts.push(performance.now() - t0);
      }
      ts.sort((a, b) => a - b);
      ms = ts[Math.floor(ts.length / 2)];
    }
    const daten = G.lesen(W, H);
    gl.deleteTexture(quelle.tex);
    gl.deleteTexture(maske);
    return { daten, ms };
  };

  /** Beide Stufen hintereinander: Bokeh (Zwischenbild linear, Float) dann Weichzeichnen auf die Leinwand. */
  G.beideBild = (orig, W, H, maskImg, par, mess) => {
    G.init();
    const gl = G.gl;
    const quelle = { tex: G.textur8(orig, W, H, false), linear: false, b: W, h: H };
    const maske = G.maskeTextur(maskImg, W, H);
    const R = par.bokeh * 0.02 * Math.max(W, H);
    const sigma = par.weich * 0.012 * Math.max(W, H);
    const laufen = () => {
      const kt = par.kernImg ? G.maskeTextur(par.kernImg, W, H) : null;
      const X = G.bokeh(quelle, maske, { R, K_stufen: par.K_stufen ?? 3, reinheit: par.reinheit ?? 0, ausgabe: false, K: par.K ?? 100, faktor: par.faktor, kernTex: kt });
      G.weich({ tex: X.t, linear: true, b: W, h: H, original: quelle.tex }, maske, { sigma, reinheit: par.reinheit ?? 0, faktor: par.faktorW, kernTex: kt });
      G.frei(X);
    };
    laufen();
    G.sync();
    let ms = 0;
    if (mess) {
      const ts = [];
      for (let i = 0; i < mess; i += 1) { const t0 = performance.now(); laufen(); G.sync(); ts.push(performance.now() - t0); }
      ts.sort((a, b) => a - b);
      ms = ts[Math.floor(ts.length / 2)];
    }
    const daten = G.lesen(W, H);
    gl.deleteTexture(quelle.tex);
    gl.deleteTexture(maske);
    return { daten, ms };
  };
})();
