/**
 * Weichzeichnen und Bokeh auf der Grafikeinheit – eine eigene Vorstufe vor dem
 * Hauptschattierer.
 *
 * Dieselbe Rechnung wie `unscharf.ts`, Durchgang für Durchgang: gleiche
 * Strecken, gleiche Abtastpunkte, gleiche Stärke, gleicher Kern, gleiche
 * Stufen. Warum, steht dort.
 *
 * # Wie es läuft
 *
 * Der Hauptschattierer rechnet die Tonkette in einem Zug. Die Unschärfe ist
 * keine Rechnung je Bildpunkt – sie braucht Nachbarschaften –, also läuft sie
 * davor in mehreren Durchgängen und liefert ein Zwischenbild: RGB in
 * Anzeigewerten, Alpha ist der Einfluss (0 heisst: unberührt, das Original
 * bleibt, Byte für Byte). Der Hauptschattierer liest es nur noch.
 *
 * Je Bereich und Regler:
 *
 * - **Bokeh**, je Stufe: Vorbereitung (Licht mal Gewicht, auf Blöcke der
 *   Arbeitsgrösse gemittelt) → zwei Strecken → drei Rauten, auf den
 *   Akkumulator addiert. Dann Zusammensetzen: Rückfall nach Deckung,
 *   Einblendung nach Stärke.
 * - **Weichzeichnen**: Vorbereitung → Gauss waagerecht → Gauss senkrecht →
 *   Zusammensetzen.
 *
 * Mehrere Bereiche und beide Regler laufen nacheinander, jeder auf dem
 * Ergebnis des vorigen (Zwischenbilder als RGBA16F, linear). Erst der letzte
 * Durchgang schreibt das Zwischenbild in Anzeigewerten als 8 Bit.
 *
 * # Räume
 *
 * Die Quelle liegt im Texturraum (die Leinwand wurde gespiegelt hochgeladen),
 * die Arbeitstexturen im BILDRAUM (Zeile 0 oben, wie der Maskenatlas und die
 * Prozessorfassung), das Ergebnis wieder im Texturraum, damit der
 * Hauptschattierer es an `gl_FragCoord` lesen kann. Gedreht wird an genau den
 * Stellen, die zwischen den Räumen vermitteln – so rechnen beide Wege auf
 * denselben Blöcken, auch wenn die Bildhöhe nicht durch den Massstab teilbar
 * ist.
 *
 * # Speicher
 *
 * Die Arbeitstexturen kommen aus einem Vorrat nach Grösse. Ohne ihn legte
 * jedes Filmbild fünf neue Texturen an, und auf einem Telefon geht dabei der
 * Grafikspeicher aus. Der Vorrat ist begrenzt; `texturenLebend` zählt mit,
 * damit ein Test sieht, dass er nicht wächst.
 *
 * Fehlen float-renderbare Ziele (`EXT_color_buffer_float`), gibt es diese
 * Vorstufe hier nicht: Die Aussenseite rechnet sie dann auf dem Prozessor und
 * lädt das Ergebnis als 8 Bit hoch.
 */

import {
  DECKUNG_BIS,
  DECKUNG_VON,
  ECKE_0,
  ECKE_1,
  ECKE_2,
  EINBLENDUNG_BIS,
  GAUSS_GRENZE,
  GAUSS_MAX,
  GUETEN,
  KERN_BIS,
  KERN_VON,
  LICHT_BIS,
  LICHT_STAERKE,
  LICHT_VON,
  REINHEIT_BIS,
  REINHEIT_VON,
  STAERKE_BIS,
  STAERKE_VON,
  arbeitsFaktor,
  linienAnzahl,
  stufenAnzahl,
  type StufenGuete,
  type UnscharfEbene,
} from './unscharf.js';

/** Eine Zahl als GLSL-Gleitkommaliteral – `0` allein wäre eine ganze Zahl. */
export function glslZahl(wert: number): string {
  const text = String(wert);
  return text.includes('.') || text.includes('e') ? text : `${text}.0`;
}

/* ---------- GLSL ---------- */

const ECKPUNKTE = `#version 300 es
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
`;

/**
 * Maske, Kern und Stärke – Zeile für Zeile `staerke`, `kernGewicht` und
 * `reinWert` aus `unscharf.ts`, mit denselben Konstanten.
 *
 * Atlas und Kernatlas liegen im Bildraum (hochgeladen ohne Spiegelung), `uv`
 * ist hier immer ein Bildraum-Wert.
 */
const MASKE = `
uniform sampler2D uMaske;
uniform sampler2D uKern;
uniform vec4 uKanal;
uniform int uReinheit;
float maskeAn(vec2 uv) { return clamp(dot(texture(uMaske, uv), uKanal), 0.0, 1.0); }
float kernAn(vec2 uv) { return clamp(dot(texture(uKern, uv), uKanal), 0.0, 1.0); }
float reinAus(float m, vec2 uv) { return uReinheit == 2 ? kernAn(uv) : m; }
float staerke(float m, float rein) {
  float s = rampe(m, ${glslZahl(STAERKE_VON)}, ${glslZahl(STAERKE_BIS)});
  return uReinheit == 1 ? s : s * rampe(rein, ${glslZahl(REINHEIT_VON)}, ${glslZahl(REINHEIT_BIS)});
}
float kernGewicht(float rein) {
  return uReinheit == 1 ? 1.0 : rampe(rein, ${glslZahl(KERN_VON)}, ${glslZahl(KERN_BIS)});
}
`;

/**
 * Vorbereitung: je Arbeitspunkt der Mittelwert über den Block von
 * `uFaktor × uFaktor` Bildpunkten, am Rand geklemmt.
 *
 * Bokeh: nur Quellen der Stufe `uBand` zählen, mit Verstärkung heller
 * Stellen. Weichzeichnen: alle mit Kerngewicht. Ergebnis `(Licht · Gewicht,
 * Gewicht)`.
 */
const VOR = `${KOPF}${MASKE}
uniform sampler2D uQuelle;
uniform int uQuelleTextur;   // 1: Original im Texturraum, 8 Bit; 0: Zwischenbild im Bildraum, linear
uniform ivec2 uGroesse;
uniform int uFaktor;
uniform int uBokeh;
uniform int uBand;
uniform int uStufen;
void main() {
  ivec2 p0 = ivec2(gl_FragCoord.xy) * uFaktor;
  vec4 summe = vec4(0.0);
  for (int j = 0; j < uFaktor; j++) {
    for (int i = 0; i < uFaktor; i++) {
      ivec2 p = min(p0 + ivec2(i, j), uGroesse - 1);
      vec2 uv = (vec2(p) + 0.5) / vec2(uGroesse);
      float m = maskeAn(uv);
      float rein = reinAus(m, uv);
      float g = kernGewicht(rein);
      float w = g;
      if (uBokeh == 1) {
        float band = floor(staerke(m, rein) * float(uStufen) + 0.5);
        if (band != float(uBand)) continue;
      }
      if (g <= 0.0) continue;
      vec3 c = texelFetch(uQuelle, uQuelleTextur == 1 ? ivec2(p.x, uGroesse.y - 1 - p.y) : p, 0).rgb;
      if (uQuelleTextur == 1) c = zuLinear(c);
      if (uBokeh == 1) {
        float hell = max(c.r, max(c.g, c.b));
        w = (1.0 + ${glslZahl(LICHT_STAERKE)} * glatt(${glslZahl(LICHT_VON)}, ${glslZahl(LICHT_BIS)}, hell)) * g;
      }
      summe += vec4(c * w, w);
    }
  }
  fragColor = summe / float(uFaktor * uFaktor);
}`;

/** Eine Strecke: das Mittel über `uN` Stellen von hier bis `uSchritt` weiter. */
const STRECKE = `${KOPF}
uniform sampler2D uQ;
uniform vec2 uSchritt;
uniform int uN;
uniform vec2 uGroesse;
void main() {
  vec2 uv = gl_FragCoord.xy / uGroesse;
  vec4 s = vec4(0.0);
  for (int j = 0; j < uN; j++) {
    s += texture(uQ, uv + uSchritt * ((float(j) + 0.5) / float(uN)));
  }
  fragColor = s / float(uN);
}`;

/** Drei Rauten zum Sechseck, auf den Akkumulator der vorigen Stufen addiert. */
const RAUTEN = `${KOPF}
uniform sampler2D uT0;
uniform sampler2D uT1;
uniform sampler2D uAkku;
uniform int uHatAkku;
uniform vec2 uE1;
uniform vec2 uE2;
uniform int uN;
uniform vec2 uGroesse;
void main() {
  vec2 uv = gl_FragCoord.xy / uGroesse;
  vec4 s = vec4(0.0);
  for (int j = 0; j < uN; j++) {
    float t = (float(j) + 0.5) / float(uN);
    s += texture(uT0, uv + uE1 * t);
    s += texture(uT0, uv + uE2 * t);
    s += texture(uT1, uv + uE2 * t);
  }
  vec4 vorher = uHatAkku == 1 ? texture(uAkku, uv) : vec4(0.0);
  fragColor = vorher + s / float(3 * uN);
}`;

/** Gauss, eine Achse; die Gewichte werden mitgezählt und hinterher geteilt. */
const GAUSS = `${KOPF}
uniform sampler2D uQ;
uniform vec2 uRichtung;
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

/**
 * Das Zusammensetzen beider Regler.
 *
 * Quelle und Ergebnis liegen je nach Durchgang in verschiedenen Räumen (siehe
 * Kopf der Datei): Der erste Durchgang liest das Original im Texturraum, der
 * letzte schreibt das Zwischenbild im Texturraum. Dazwischen steht alles im
 * Bildraum. `pi` ist immer der Bildpunkt im Bildraum, den dieser Fragment
 * betrifft.
 */
const KOMPOSIT = `${KOPF}${MASKE}
uniform sampler2D uQuelle;
uniform int uQuelleTextur;
uniform sampler2D uAkku;
uniform ivec2 uGroesse;
uniform int uBokeh;
uniform int uStufen;
uniform int uAusgabe;        // 1: Anzeigewerte, 8 Bit, Texturraum; 0: linear, Float, Bildraum
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 pi = uAusgabe == 1 ? ivec2(p.x, uGroesse.y - 1 - p.y) : p;
  vec2 uv = (vec2(pi) + 0.5) / vec2(uGroesse);
  vec4 roh = texelFetch(uQuelle, uQuelleTextur == 1 ? ivec2(pi.x, uGroesse.y - 1 - pi.y) : pi, 0);
  vec3 S = uQuelleTextur == 1 ? zuLinear(roh.rgb) : roh.rgb;
  float a = uQuelleTextur == 1 ? 0.0 : roh.a;
  vec3 X = S;
  float m = maskeAn(uv);
  float s = staerke(m, reinAus(m, uv));
  // Bokeh blendet bis zu einer Stärke ein und braucht einen Empfänger mit
  // eigener Stufe; Weichzeichnen überblendet einfach nach Stärke.
  float t = uBokeh == 1 ? rampe(s, 0.0, ${glslZahl(EINBLENDUNG_BIS)}) : s;
  bool wirkt = t > 0.0 && s > 0.0;
  if (wirkt && uBokeh == 1) wirkt = floor(s * float(uStufen) + 0.5) >= 1.0;
  if (wirkt) {
    vec4 b = texture(uAkku, uv);
    float deck = glatt(${glslZahl(DECKUNG_VON)}, ${glslZahl(DECKUNG_BIS)}, b.a);
    vec3 bl = b.a > 1e-6 ? b.rgb / b.a : S;
    float w = deck * t;
    X = S + (bl - S) * w;
    a = max(a, w);
  }
  fragColor = uAusgabe == 1 ? vec4(zuSrgb(clamp(X, 0.0, 1.0)), a) : vec4(X, a);
}`;

/* ---------- Werk ---------- */

/** Ein Ziel: Textur samt Zielpuffer. */
interface Ziel {
  readonly textur: WebGLTexture;
  readonly puffer: WebGLFramebuffer;
  readonly b: number;
  readonly h: number;
  readonly art: 'f16' | 'u8';
}

interface Programm {
  readonly programm: WebGLProgram;
  readonly orte: Record<string, WebGLUniformLocation | null>;
}

/** Was die Aussenseite zum Mitzählen mitgibt – dieselbe Zählwerk-Struktur wie `tonGpu`. */
export interface UnscharfZaehler {
  stufenGerechnet: number;
  texturenLebend: number;
}

export interface UnscharfWerk {
  readonly gl: WebGL2RenderingContext;
  readonly zaehler: UnscharfZaehler;
  readonly vor: Programm;
  readonly strecke: Programm;
  readonly rauten: Programm;
  readonly gauss: Programm;
  readonly komposit: Programm;
  readonly feld: WebGLVertexArrayObject;
  /** Freie Ziele, ältestes zuerst. */
  readonly vorrat: Ziel[];
  /** Das letzte Ergebnis samt Zettel – es bleibt, bis sich etwas ändert. */
  ergebnis: Ziel | null;
  zettel: string | null;
  /** Ein Durchgang ist an diesem Gerät gescheitert: Ab jetzt rechnet der Prozessor. */
  defekt: boolean;
}

/** So viele Bytes bleiben im Vorrat liegen; mehr wird sofort freigegeben. */
const VORRAT_MAX = 48e6;

const bytesVon = (z: Ziel) => z.b * z.h * (z.art === 'f16' ? 8 : 4);

/**
 * Von aussen die Float-Ziele sperren – nur für Prüfungen.
 *
 * Der Hybrid-Weg lässt sich sonst auf keinem Gerät auslösen, das
 * `EXT_color_buffer_float` kann, und wäre damit der Weg, den nie jemand prüft.
 */
let floatVerboten = false;
export function floatZieleSperren(an: boolean): void {
  floatVerboten = an;
}

function uebersetzen(gl: WebGL2RenderingContext, art: number, text: string): WebGLShader {
  const shader = gl.createShader(art);
  if (!shader) throw new Error('kein Schattierer');
  gl.shaderSource(shader, text);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    // Ein Übersetzungsfehler ist ein Programmfehler, kein Gerätemangel.
    const meldung = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Unschärfe-Schattierer: ${meldung ?? '?'}`);
  }
  return shader;
}

function programmBauen(gl: WebGL2RenderingContext, fragment: string): Programm {
  const programm = gl.createProgram();
  if (!programm) throw new Error('kein Programm');
  gl.attachShader(programm, uebersetzen(gl, gl.VERTEX_SHADER, ECKPUNKTE));
  gl.attachShader(programm, uebersetzen(gl, gl.FRAGMENT_SHADER, fragment));
  // Der Eckpunkt hat immer Platz 0 – unser eigenes Feld füttert genau den.
  gl.bindAttribLocation(programm, 0, 'aOrt');
  gl.linkProgram(programm);
  if (!gl.getProgramParameter(programm, gl.LINK_STATUS)) {
    throw new Error(`Unschärfe-Programm: ${gl.getProgramInfoLog(programm) ?? '?'}`);
  }
  const orte: Record<string, WebGLUniformLocation | null> = {};
  const anzahl = gl.getProgramParameter(programm, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < anzahl; i += 1) {
    const info = gl.getActiveUniform(programm, i);
    if (info) orte[info.name] = gl.getUniformLocation(programm, info.name);
  }
  return { programm, orte };
}

let werk: UnscharfWerk | null | undefined;
/** Für welchen Kontext `werk` gilt – ein anderer (nach Verlust) fängt von vorn an. */
let werkFuer: WebGL2RenderingContext | null = null;

/**
 * Legt die Programme an – einmal je Kontext.
 *
 * `null` heisst: Auf diesem Gerät gibt es die Vorstufe nicht. Das ist der
 * Normalfall für einen Browser ohne `EXT_color_buffer_float`, kein Fehler;
 * die Aussenseite rechnet dann auf dem Prozessor.
 */
export function unscharfWerk(
  gl: WebGL2RenderingContext,
  zaehler: UnscharfZaehler,
): UnscharfWerk | null {
  if (floatVerboten) return null;
  if (werkFuer === gl && werk !== undefined) return werk && !werk.defekt ? werk : null;
  werkFuer = gl;
  werk = null;
  try {
    if (!gl.getExtension('EXT_color_buffer_float')) return null;

    const feld = gl.createVertexArray();
    const puffer = gl.createBuffer();
    if (!feld || !puffer) return null;
    gl.bindVertexArray(feld);
    gl.bindBuffer(gl.ARRAY_BUFFER, puffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    const neu: UnscharfWerk = {
      gl,
      zaehler,
      vor: programmBauen(gl, VOR),
      strecke: programmBauen(gl, STRECKE),
      rauten: programmBauen(gl, RAUTEN),
      gauss: programmBauen(gl, GAUSS),
      komposit: programmBauen(gl, KOMPOSIT),
      feld,
      vorrat: [],
      ergebnis: null,
      zettel: null,
      defekt: false,
    };
    // Probe: Lässt sich ein Float-Ziel wirklich beschreiben? Die Erweiterung
    // zu melden und es dann nicht zu können, kommt auf einzelnen Geräten vor.
    const probe = zielAnlegen(neu, 'f16', 4, 4);
    zielLoeschen(neu, probe);
    werk = neu;
    return neu;
  } catch (fehler) {
    // Ein verlorener Kontext ist Alltag und geht nach oben; alles andere
    // heisst nur: diese Vorstufe gibt es hier nicht.
    if (gl.isContextLost()) throw fehler;
    console.error('Unschärfe auf der Grafikeinheit nicht verfügbar:', fehler);
    return null;
  } finally {
    gl.activeTexture(gl.TEXTURE0);
  }
}

/** Vergisst alles – nach einem Kontextverlust zeigen Texturen ins Leere. */
export function unscharfVerwerfen(): void {
  werk = undefined;
  werkFuer = null;
}

/* ---------- Ziele und Vorrat ---------- */

function zielAnlegen(w: UnscharfWerk, art: 'f16' | 'u8', b: number, h: number): Ziel {
  const { gl } = w;
  const textur = gl.createTexture();
  const puffer = gl.createFramebuffer();
  if (!textur || !puffer) throw new Error('kein Ziel');
  // Auf einer Einheit anlegen, die sonst nie gelesen wird: Sonst überschreibt
  // das Anlegen die Bindung einer gerade benutzten Textur.
  gl.activeTexture(gl.TEXTURE0 + 15);
  gl.bindTexture(gl.TEXTURE_2D, textur);
  gl.texStorage2D(gl.TEXTURE_2D, 1, art === 'f16' ? gl.RGBA16F : gl.RGBA8, b, h);
  const filter = art === 'f16' ? gl.LINEAR : gl.NEAREST;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindFramebuffer(gl.FRAMEBUFFER, puffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, textur, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.activeTexture(gl.TEXTURE0);
  w.zaehler.texturenLebend += 1;
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteFramebuffer(puffer);
    gl.deleteTexture(textur);
    w.zaehler.texturenLebend -= 1;
    throw new Error(`Zielpuffer unvollständig (${art}, ${b}×${h})`);
  }
  return { textur, puffer, b, h, art };
}

function zielLoeschen(w: UnscharfWerk, z: Ziel): void {
  w.gl.deleteFramebuffer(z.puffer);
  w.gl.deleteTexture(z.textur);
  w.zaehler.texturenLebend -= 1;
}

function nehmen(w: UnscharfWerk, art: 'f16' | 'u8', b: number, h: number): Ziel {
  const at = w.vorrat.findIndex((z) => z.art === art && z.b === b && z.h === h);
  if (at >= 0) return w.vorrat.splice(at, 1)[0];
  return zielAnlegen(w, art, b, h);
}

function zurueck(w: UnscharfWerk, z: Ziel): void {
  w.vorrat.push(z);
  let summe = w.vorrat.reduce((s, x) => s + bytesVon(x), 0);
  while (summe > VORRAT_MAX && w.vorrat.length > 0) {
    const alt = w.vorrat.shift() as Ziel;
    summe -= bytesVon(alt);
    zielLoeschen(w, alt);
  }
}

/* ---------- Durchgänge ---------- */

function binden(w: UnscharfWerk, einheit: number, textur: WebGLTexture): void {
  w.gl.activeTexture(w.gl.TEXTURE0 + einheit);
  w.gl.bindTexture(w.gl.TEXTURE_2D, textur);
}

function nutzen(w: UnscharfWerk, p: Programm): Record<string, WebGLUniformLocation | null> {
  w.gl.useProgram(p.programm);
  return p.orte;
}

function zeichnen(w: UnscharfWerk, ziel: Ziel): void {
  const { gl } = w;
  gl.bindFramebuffer(gl.FRAMEBUFFER, ziel.puffer);
  gl.viewport(0, 0, ziel.b, ziel.h);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

/** Woher ein Durchgang sein Bild liest. */
interface Quelle {
  readonly textur: WebGLTexture;
  /** Das Original im Texturraum (8 Bit, sRGB) – sonst ein Zwischenbild. */
  readonly original: boolean;
  /** Nur bei Zwischenbildern: das Ziel, damit es danach in den Vorrat zurück kann. */
  readonly ziel?: Ziel;
}

export interface UnscharfAuftrag {
  readonly quelle: WebGLTexture;
  readonly atlas: WebGLTexture;
  readonly kernAtlas: WebGLTexture;
  readonly breite: number;
  readonly hoehe: number;
  readonly guete: StufenGuete;
}

/** Atlas, Kern, Kanal und Reinheit eines Bereichs auf die Einheiten 1 und 2. */
function maskeSetzen(
  w: UnscharfWerk,
  u: Record<string, WebGLUniformLocation | null>,
  a: UnscharfAuftrag,
  ebene: UnscharfEbene,
): void {
  const { gl } = w;
  binden(w, 1, a.atlas);
  binden(w, 2, a.kernAtlas);
  gl.uniform1i(u.uMaske, 1);
  gl.uniform1i(u.uKern, 2);
  gl.uniform4f(
    u.uKanal,
    ebene.platz === 0 ? 1 : 0,
    ebene.platz === 1 ? 1 : 0,
    ebene.platz === 2 ? 1 : 0,
    ebene.platz === 3 ? 1 : 0,
  );
  gl.uniform1i(u.uReinheit, ebene.reinheit);
}

/** Die Vorbereitung für eine Stufe (Bokeh) oder den Gauss (Weichzeichnen) in `ziel`. */
function vorbereiten(
  w: UnscharfWerk,
  a: UnscharfAuftrag,
  ebene: UnscharfEbene,
  q: Quelle,
  ziel: Ziel,
  f: number,
  bokehStufe: { band: number; stufen: number } | null,
): void {
  const { gl } = w;
  const u = nutzen(w, w.vor);
  binden(w, 0, q.textur);
  maskeSetzen(w, u, a, ebene);
  gl.uniform1i(u.uQuelle, 0);
  gl.uniform1i(u.uQuelleTextur, q.original ? 1 : 0);
  gl.uniform2i(u.uGroesse, a.breite, a.hoehe);
  gl.uniform1i(u.uFaktor, f);
  gl.uniform1i(u.uBokeh, bokehStufe ? 1 : 0);
  gl.uniform1i(u.uBand, bokehStufe ? bokehStufe.band : 0);
  gl.uniform1i(u.uStufen, bokehStufe ? bokehStufe.stufen : 1);
  zeichnen(w, ziel);
}

/** Der Akkumulator aller Stufen der Scheibe: Summe der Sechsecke. */
function bokehAkku(w: UnscharfWerk, a: UnscharfAuftrag, ebene: UnscharfEbene, q: Quelle): Ziel {
  const { gl } = w;
  const g = GUETEN[a.guete];
  const R = ebene.bokehPx;
  const K = stufenAnzahl(ebene.reinheit, a.guete);
  const f = arbeitsFaktor(R, g.arbeitsradius, a.breite, a.hoehe);
  const wb = Math.ceil(a.breite / f);
  const wh = Math.ceil(a.hoehe / f);
  const p = nehmen(w, 'f16', wb, wh);
  const t0 = nehmen(w, 'f16', wb, wh);
  const t1 = nehmen(w, 'f16', wb, wh);
  let akku = nehmen(w, 'f16', wb, wh);
  let frei = nehmen(w, 'f16', wb, wh);

  for (let k = 1; k <= K; k += 1) {
    const rk = (R / f) * (k / K);
    const n = linienAnzahl(rk, g.dichte);
    vorbereiten(w, a, ebene, q, p, f, { band: k, stufen: K });

    // Zwei Strecken aus der Vorbereitung.
    let u = nutzen(w, w.strecke);
    gl.uniform1i(u.uQ, 3);
    gl.uniform1i(u.uN, n);
    gl.uniform2f(u.uGroesse, wb, wh);
    binden(w, 3, p.textur);
    gl.uniform2f(u.uSchritt, (ECKE_0[0] * rk) / wb, (ECKE_0[1] * rk) / wh);
    zeichnen(w, t0);
    gl.uniform2f(u.uSchritt, (ECKE_1[0] * rk) / wb, (ECKE_1[1] * rk) / wh);
    zeichnen(w, t1);

    // Drei Rauten, auf die vorigen Stufen addiert.
    u = nutzen(w, w.rauten);
    binden(w, 3, t0.textur);
    binden(w, 4, t1.textur);
    binden(w, 5, akku.textur);
    gl.uniform1i(u.uT0, 3);
    gl.uniform1i(u.uT1, 4);
    gl.uniform1i(u.uAkku, 5);
    gl.uniform1i(u.uHatAkku, k === 1 ? 0 : 1);
    gl.uniform2f(u.uE1, (ECKE_1[0] * rk) / wb, (ECKE_1[1] * rk) / wh);
    gl.uniform2f(u.uE2, (ECKE_2[0] * rk) / wb, (ECKE_2[1] * rk) / wh);
    gl.uniform1i(u.uN, n);
    gl.uniform2f(u.uGroesse, wb, wh);
    zeichnen(w, frei);
    // Lesen und Schreiben nie in dieselbe Textur: abwechseln.
    [akku, frei] = [frei, akku];
  }
  zurueck(w, p);
  zurueck(w, t0);
  zurueck(w, t1);
  zurueck(w, frei);
  return akku;
}

/** Das gaussweiche Bild der Kernpunkte im Arbeitsmassstab. */
function weichFeld(w: UnscharfWerk, a: UnscharfAuftrag, ebene: UnscharfEbene, q: Quelle): Ziel {
  const { gl } = w;
  const sigma = ebene.weichPx;
  const f = arbeitsFaktor(sigma * 3, GAUSS_GRENZE, a.breite, a.hoehe);
  const wb = Math.ceil(a.breite / f);
  const wh = Math.ceil(a.hoehe / f);
  const p = nehmen(w, 'f16', wb, wh);
  const quer = nehmen(w, 'f16', wb, wh);
  const fertig = nehmen(w, 'f16', wb, wh);
  vorbereiten(w, a, ebene, q, p, f, null);

  const u = nutzen(w, w.gauss);
  gl.uniform1i(u.uQ, 3);
  gl.uniform1f(u.uSigma, Math.max(0.3, sigma / f));
  gl.uniform1i(u.uR, Math.min(GAUSS_MAX, Math.ceil((sigma / f) * 3)));
  gl.uniform2f(u.uGroesse, wb, wh);
  binden(w, 3, p.textur);
  gl.uniform2f(u.uRichtung, 1 / wb, 0);
  zeichnen(w, quer);
  binden(w, 3, quer.textur);
  gl.uniform2f(u.uRichtung, 0, 1 / wh);
  zeichnen(w, fertig);
  zurueck(w, p);
  zurueck(w, quer);
  return fertig;
}

/** Setzt ein Feld aus dem Arbeitsmassstab mit der Quelle zusammen – in `ziel`. */
function zusammensetzen(
  w: UnscharfWerk,
  a: UnscharfAuftrag,
  ebene: UnscharfEbene,
  q: Quelle,
  feld: Ziel,
  ziel: Ziel,
  letzter: boolean,
  bokeh: boolean,
): void {
  const { gl } = w;
  const u = nutzen(w, w.komposit);
  binden(w, 0, q.textur);
  binden(w, 5, feld.textur);
  maskeSetzen(w, u, a, ebene);
  gl.uniform1i(u.uQuelle, 0);
  gl.uniform1i(u.uQuelleTextur, q.original ? 1 : 0);
  gl.uniform1i(u.uAkku, 5);
  gl.uniform2i(u.uGroesse, a.breite, a.hoehe);
  gl.uniform1i(u.uBokeh, bokeh ? 1 : 0);
  gl.uniform1i(u.uStufen, bokeh ? stufenAnzahl(ebene.reinheit, a.guete) : 1);
  gl.uniform1i(u.uAusgabe, letzter ? 1 : 0);
  zeichnen(w, ziel);
  zurueck(w, feld);
  if (q.ziel) zurueck(w, q.ziel);
}

/**
 * Rechnet die Vorstufe – oder gibt das Ergebnis des letzten Mals zurück, wenn
 * sich nichts geändert hat.
 *
 * `schluessel` ist alles, wovon das Zwischenbild abhängt: Quelle, Masken,
 * Radien, Güte, Grösse. Ein Zug an „Belichtung“ ändert keinen davon, und die
 * Unschärfe kostet dann nichts.
 *
 * Gibt `null` zurück, wenn es auf diesem Gerät nicht geht; die Aussenseite
 * rechnet dann auf dem Prozessor. Zustand der Grafikeinheit danach: eigenes
 * Programm, Ziel und Feld gebunden – die Aussenseite stellt ihren
 * Hauptdurchlauf wieder her.
 */
export function unscharfRechnen(
  w: UnscharfWerk,
  auftrag: UnscharfAuftrag,
  ebenen: readonly UnscharfEbene[],
  schluessel: string,
): WebGLTexture | null {
  if (w.zettel === schluessel && w.ergebnis) return w.ergebnis.textur;
  const { gl } = w;
  try {
    w.zettel = null;
    gl.bindVertexArray(w.feld);
    const { breite, hoehe } = auftrag;
    if (!w.ergebnis || w.ergebnis.b !== breite || w.ergebnis.h !== hoehe) {
      if (w.ergebnis) zielLoeschen(w, w.ergebnis);
      w.ergebnis = null;
      w.ergebnis = zielAnlegen(w, 'u8', breite, hoehe);
    }

    let q: Quelle = { textur: auftrag.quelle, original: true };
    ebenen.forEach((ebene, i) => {
      const letzteEbene = i === ebenen.length - 1;
      if (ebene.bokehPx > 0) {
        const nurBokeh = ebene.weichPx === 0;
        const akku = bokehAkku(w, auftrag, ebene, q);
        const ziel =
          letzteEbene && nurBokeh ? (w.ergebnis as Ziel) : nehmen(w, 'f16', breite, hoehe);
        zusammensetzen(w, auftrag, ebene, q, akku, ziel, ziel === w.ergebnis, true);
        q = { textur: ziel.textur, original: false, ziel };
      }
      if (ebene.weichPx > 0) {
        const feld = weichFeld(w, auftrag, ebene, q);
        const ziel = letzteEbene ? (w.ergebnis as Ziel) : nehmen(w, 'f16', breite, hoehe);
        zusammensetzen(w, auftrag, ebene, q, feld, ziel, ziel === w.ergebnis, false);
        q = { textur: ziel.textur, original: false, ziel };
      }
    });
    w.zaehler.stufenGerechnet += 1;
    w.zettel = schluessel;
    return (w.ergebnis as Ziel).textur;
  } catch (fehler) {
    // Ein verlorener Kontext geht nach oben (dort wird alles verworfen); ein
    // Ziel, das sich nicht beschreiben lässt, heisst nur: nicht auf dieser
    // Grafikeinheit. Dann rechnet der Prozessor, und zwar jedes Mal.
    if (gl.isContextLost()) throw fehler;
    console.error('Unschärfe auf der Grafikeinheit gescheitert:', fehler);
    w.defekt = true;
    w.zettel = null;
    return null;
  } finally {
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE0);
  }
}
