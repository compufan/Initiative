/**
 * Richardson-Lucy auf der Grafikeinheit – der Weg, der wirklich benutzbar ist.
 *
 * # Warum der Prozessorweg nicht reicht
 *
 * Nachgemessen, nicht geschätzt (Node 22, ein Kanal, Linienkern von 25
 * Punkten):
 *
 *   * 1024 × 768, EINE Faltung: 2,9 s
 *   * 2048 × 1536, EINE Faltung: 8,5 s
 *   * 512 × 384, dreissig Durchgänge: 27,6 s – und das ist ein Kanal von drei
 *
 * Ein Durchgang sind zwei Faltungen. Bei der Ausgabegrösse dieses Editors
 * (2560 Punkte lange Kante) und dreissig Durchgängen wären das rund
 * fünfundzwanzig Minuten. `entfaltung.ts` bleibt der Prüfmassstab; gerechnet
 * wird hier.
 *
 * # Warum hier keine Kacheln stehen
 *
 * Im Kopf von `entfaltung.ts` stand, es brauche Kacheln, weil vier Texturen
 * bei zwölf Megapunkten in RGBA16F 366 MB belegen. Die Rechnung stimmt und
 * die Voraussetzung nicht: Dieser Editor gibt nie mehr als 2560 Punkte
 * Kantenlänge aus (`MAX_KANTE`), also höchstens gut fünf Megapunkte. Das sind
 * 39 MB je Textur und rund 157 MB für alle vier – unangenehm, aber tragbar,
 * und ohne eine einzige Naht im Bild.
 *
 * # Die vier Texturen, und warum es nicht drei sind
 *
 *   * `beobachtet` – das Ausgangsbild in linearem Licht. Wird in JEDEM
 *     Durchgang gebraucht und darf deshalb nie überschrieben werden.
 *   * `schaetzung` und `naechste` – das Ping-Pong-Paar. Aus der einen wird
 *     gelesen, in die andere geschrieben; dasselbe Bild gleichzeitig zu lesen
 *     und zu beschreiben ist in WebGL nicht definiert und ergibt auf
 *     verschiedenen Geräten verschiedenen Unsinn.
 *   * `verhaeltnis` – das Zwischenergebnis des ersten Durchgangs.
 *
 * # Warum die Stützstellen als Uniform und nicht als Textur
 *
 * Ein Linienkern von 25 Punkten sitzt in einem Feld von 29 × 29 = 841
 * Plätzen, von denen 51 besetzt sind. Läuft der Schattierer über alle 841 und
 * überspringt die leeren, kostet er trotzdem 841 Abfragen je Bildpunkt – ein
 * `continue` ist auf einer Grafikeinheit nur dann billig, wenn ALLE Fäden
 * eines Bündels es nehmen, und das tun sie hier nicht.
 *
 * Deshalb wird die BESETZTE Liste vorgerechnet und als Uniform übergeben. Aus
 * 841 Abfragen werden 51. Wie viele hineinpassen, sagt das Gerät selbst
 * (`MAX_FRAGMENT_UNIFORM_VECTORS`); der garantierte Mindestwert ist 224, echte
 * Geräte melden meist 1024. Ein Kern, der nicht hineinpasst, wird abgelehnt –
 * mit einer Auskunft, nicht mit einem falschen Bild.
 */

import { glRaum } from './farbraum.js';
import type { Kern } from './entfaltung.js';

/* ---------- GLSL ---------- */

const ECKPUNKTE = `#version 300 es
in vec2 aOrt;
out vec2 vUv;
void main() {
  vUv = aOrt * 0.5 + 0.5;
  gl_Position = vec4(aOrt, 0.0, 1.0);
}`;

/** Wort für Wort dieselbe Umrechnung wie in `ton.ts` und `tonGpu.ts`. */
const FARBRAUM = `
float zuLinear1(float c) {
  return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4);
}
vec3 zuLinear(vec3 c) {
  return vec3(zuLinear1(c.r), zuLinear1(c.g), zuLinear1(c.b));
}
float zuSrgb1(float c) {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}
vec3 zuSrgb(vec3 c) {
  return vec3(zuSrgb1(c.r), zuSrgb1(c.g), zuSrgb1(c.b));
}`;

/** sRGB hinein, lineares Licht heraus – der Start beider Bilder. */
const START = `#version 300 es
precision highp float;
uniform sampler2D uQuelle;
in vec2 vUv;
out vec4 fFarbe;
${FARBRAUM}
void main() {
  vec4 c = texture(uQuelle, vUv);
  fFarbe = vec4(zuLinear(c.rgb), c.a);
}`;

/**
 * Erster Durchgang: das Verhältnis zwischen Beobachtung und Vorhersage.
 *
 *     v = b / (s ⊛ k)
 *
 * Die Dämpfung zieht Verhältnisse nahe eins gegen eins zurück. Ohne sie
 * verstärkt jeder weitere Durchgang das Rauschen, und ein glatter Himmel wird
 * grieselig.
 */
function verhaeltnisQuelle(taps: number): string {
  return `#version 300 es
precision highp float;
uniform sampler2D uSchaetzung;
uniform sampler2D uBeobachtet;
uniform vec2 uSchritt;
uniform int uAnzahl;
uniform float uDaempfung;
uniform vec3 uTaps[${taps}];
in vec2 vUv;
out vec4 fFarbe;
void main() {
  vec3 summe = vec3(0.0);
  for (int i = 0; i < uAnzahl; i++) {
    vec3 tap = uTaps[i];
    summe += texture(uSchaetzung, vUv + tap.xy * uSchritt).rgb * tap.z;
  }
  vec3 b = texture(uBeobachtet, vUv).rgb;
  // Unter diesem Wert ist die Division nicht mehr sinnvoll – dort ist ohnehin
  // nichts. Dieselbe Schwelle wie auf dem Prozessorweg.
  vec3 v = mix(vec3(1.0), b / max(summe, vec3(1e-6)), step(vec3(1e-6), summe));
  if (uDaempfung > 0.0) {
    vec3 ab = abs(v - 1.0);
    vec3 t = clamp(ab / uDaempfung, 0.0, 1.0);
    // Weich gegen eins, nicht abgeschnitten: Ein harter Schnitt erzeugt an
    // der Schwelle eine sichtbare Grenze im Bild.
    vec3 weich = 1.0 + (v - 1.0) * t * t;
    v = mix(weich, v, step(uDaempfung, ab));
  }
  fFarbe = vec4(v, 1.0);
}`;
}

/**
 * Zweiter Durchgang: die multiplikative Korrektur.
 *
 *     s' = s · (v ⊛ k̃)
 *
 * `k̃` ist der um seine Mitte gedrehte Kern – deshalb steht bei den
 * Stützstellen ein Minus vor dem Versatz. Multiplikativ, und genau deshalb
 * entgleist das Verfahren nicht: Eine Schätzung kann nie negativ werden.
 */
function schrittQuelle(taps: number): string {
  return `#version 300 es
precision highp float;
uniform sampler2D uVerhaeltnis;
uniform sampler2D uSchaetzung;
uniform vec2 uSchritt;
uniform int uAnzahl;
uniform vec3 uTaps[${taps}];
in vec2 vUv;
out vec4 fFarbe;
void main() {
  vec3 summe = vec3(0.0);
  for (int i = 0; i < uAnzahl; i++) {
    vec3 tap = uTaps[i];
    summe += texture(uVerhaeltnis, vUv - tap.xy * uSchritt).rgb * tap.z;
  }
  vec3 neu = texture(uSchaetzung, vUv).rgb * summe;
  // Nicht negativ und nicht unendlich – beides ist rechnerisch möglich und im
  // Bild eine Katastrophe.
  fFarbe = vec4(clamp(neu, 0.0, 64.0), 1.0);
}`;
}

/**
 * Die Saumbegrenzung, in zwei Durchgängen.
 *
 * Gesucht sind kleinster und grösster Quellwert in einem Quadrat. Über ein
 * Quadrat von 17 × 17 wären das 289 Abfragen je Bildpunkt; getrennt nach
 * waagerecht und senkrecht sind es 17 und noch einmal 17. Minimum und Maximum
 * erlauben das, weil beide über die Zeilen und dann über die Spalten
 * dasselbe ergeben wie über die ganze Fläche.
 *
 * `uAchse` ist (1,0) oder (0,1). Herausgegeben werden zwei Werte je Kanal –
 * deshalb zwei Ausgabeziele.
 */
const SPANNE = `#version 300 es
precision highp float;
uniform sampler2D uKlein;
uniform sampler2D uGross;
uniform vec2 uSchritt;
uniform vec2 uAchse;
uniform int uRadius;
in vec2 vUv;
layout(location = 0) out vec4 fKlein;
layout(location = 1) out vec4 fGross;
void main() {
  vec3 klein = texture(uKlein, vUv).rgb;
  vec3 gross = texture(uGross, vUv).rgb;
  for (int i = 1; i <= 64; i++) {
    if (i > uRadius) break;
    vec2 ab = uAchse * uSchritt * float(i);
    klein = min(klein, min(texture(uKlein, vUv + ab).rgb, texture(uKlein, vUv - ab).rgb));
    gross = max(gross, max(texture(uGross, vUv + ab).rgb, texture(uGross, vUv - ab).rgb));
  }
  fKlein = vec4(klein, 1.0);
  fGross = vec4(gross, 1.0);
}`;

/**
 * Letzter Durchgang: klemmen und zurück in den Anzeigeraum.
 *
 * Die Saumbegrenzung ist dieselbe Idee wie bei der Unschärfemaske: Eine
 * Entfaltung schiesst an harten Kanten über – das ist das bekannte Klingeln.
 * Innerhalb der Helligkeiten zu bleiben, die in der Umgebung wirklich
 * vorkommen, nimmt ihm die Spitze, ohne die zurückgeholte Struktur
 * anzutasten.
 */
const AUSGABE = `#version 300 es
precision highp float;
uniform sampler2D uSchaetzung;
uniform sampler2D uKlein;
uniform sampler2D uGross;
uniform bool uBegrenzen;
in vec2 vUv;
out vec4 fFarbe;
${FARBRAUM}
void main() {
  vec3 c = texture(uSchaetzung, vUv).rgb;
  if (uBegrenzen) {
    c = clamp(c, texture(uKlein, vUv).rgb, texture(uGross, vUv).rgb);
  }
  fFarbe = vec4(zuSrgb(clamp(c, 0.0, 1.0)), 1.0);
}`;

/* ---------- Stützstellen ---------- */

/** Eine besetzte Stelle des Kerns: Versatz in Punkten und Gewicht. */
export interface Stuetze {
  dx: number;
  dy: number;
  gewicht: number;
}

/**
 * Die besetzten Stellen eines Kerns – in der Reihenfolge, in der sie stehen.
 *
 * Genau null wird weggelassen, nichts Kleines: Ein Schwellenwert („unter
 * 1/1000 zählt nicht") würde die Summe verändern, und ein Kern, der nicht auf
 * eins summiert, hellt das Bild in jedem Durchgang auf oder dunkelt es ab.
 */
export function stuetzen(kern: Kern): Stuetze[] {
  const raus: Stuetze[] = [];
  for (let ky = 0; ky < kern.hoehe; ky += 1) {
    for (let kx = 0; kx < kern.breite; kx += 1) {
      const gewicht = kern.werte[ky * kern.breite + kx];
      if (gewicht === 0) continue;
      raus.push({ dx: kx - kern.mx, dy: ky - kern.my, gewicht });
    }
  }
  return raus;
}

/* ---------- Werkzeug ---------- */

interface Werk {
  gl: WebGL2RenderingContext;
  leinwand: HTMLCanvasElement;
  /** Wie viele Stützstellen dieses Gerät verträgt. */
  taps: number;
}

let werk: Werk | null | undefined;
let gpuVerboten = false;

/** Von aussen abschalten – nur für Prüfungen, wie in `tonGpu.ts`. */
export function entfaltungGpuAbschalten(an: boolean): void {
  gpuVerboten = an;
  if (an) werk = null;
  else werk = undefined;
}

function uebersetzen(gl: WebGL2RenderingContext, art: number, quelle: string): WebGLShader | null {
  const shader = gl.createShader(art);
  if (!shader) return null;
  gl.shaderSource(shader, quelle);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error('Entfaltung, Schattierer:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function programmBauen(gl: WebGL2RenderingContext, fragment: string): WebGLProgram | null {
  const ecken = uebersetzen(gl, gl.VERTEX_SHADER, ECKPUNKTE);
  const farben = uebersetzen(gl, gl.FRAGMENT_SHADER, fragment);
  if (!ecken || !farben) return null;
  const programm = gl.createProgram();
  if (!programm) return null;
  gl.attachShader(programm, ecken);
  gl.attachShader(programm, farben);
  gl.bindAttribLocation(programm, 0, 'aOrt');
  gl.linkProgram(programm);
  if (!gl.getProgramParameter(programm, gl.LINK_STATUS)) {
    console.error('Entfaltung, Programm:', gl.getProgramInfoLog(programm));
    return null;
  }
  return programm;
}

/**
 * Kontext und Grenzen – genau einmal.
 *
 * `undefined` heisst „noch nicht versucht“, `null` heisst „geht hier nicht“.
 * Der Unterschied zählt: Ein zweiter Versuch würde auf jedem Gerät ohne
 * WebGL2 bei jedem Bild neu scheitern.
 */
function werkzeug(): Werk | null {
  if (werk !== undefined) return werk;
  werk = null;
  if (gpuVerboten) return null;
  try {
    const leinwand = document.createElement('canvas');
    const gl = leinwand.getContext('webgl2', { alpha: false, antialias: false });
    if (!gl) return null;
    glRaum(gl);
    /*
     * Ohne diese Erweiterung lässt sich in eine Gleitkommatextur nicht
     * HINEINZEICHNEN – lesen ginge, schreiben nicht. Und genau das ist hier
     * der ganze Vorgang.
     *
     * In acht Bit rechnen wäre kein Ausweg: Richardson-Lucy rechnet mit
     * VERHÄLTNISSEN, und die liegen regelmässig über eins. Ein Wert, der bei
     * eins abgeschnitten wird, ist keine Näherung, sondern eine andere
     * Rechnung.
     */
    if (!gl.getExtension('EXT_color_buffer_float')) {
      if (!gl.getExtension('EXT_color_buffer_half_float')) return null;
    }
    const vektoren = gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS) as number;
    // Zwanzig Vektoren bleiben für alles andere im Schattierer übrig; der
    // Rest steht den Stützstellen zu.
    const taps = Math.max(16, Math.min(512, vektoren - 20));
    werk = { gl, leinwand, taps };
    return werk;
  } catch {
    return null;
  }
}

/** Wie viele besetzte Stellen dieses Gerät verträgt – 0 heisst „keine Grafikeinheit“. */
export function stuetzenGrenze(): number {
  return werkzeug()?.taps ?? 0;
}

interface Ziel {
  textur: WebGLTexture;
  rahmen: WebGLFramebuffer;
}

function zielBauen(gl: WebGL2RenderingContext, b: number, h: number): Ziel | null {
  const textur = gl.createTexture();
  const rahmen = gl.createFramebuffer();
  if (!textur || !rahmen) return null;
  gl.bindTexture(gl.TEXTURE_2D, textur);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, b, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
  /*
   * `NEAREST`, obwohl es hier NICHTS ändert – nachgemessen.
   *
   * Die Stützstellen sind ganze Bildpunkte, und `vUv` liegt in der Mitte
   * eines Bildpunkts; `vUv + dx/breite` trifft damit wieder genau eine
   * Mitte. Dort geben `LINEAR` und `NEAREST` denselben Wert, und ein
   * Umstellen auf `LINEAR` geht durch jede Prüfung.
   *
   * Es steht trotzdem hier: Das Ergebnis hinge sonst daran, dass die
   * Rundung der Abtasteinheit genau trifft – auf jedem Gerät, bei jeder
   * Bildgrösse. `NEAREST` nimmt diese Abhängigkeit heraus, statt auf sie zu
   * bauen.
   */
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  /*
   * Und `MIRRORED_REPEAT` statt `CLAMP_TO_EDGE`: Klemmen zieht den Randpunkt
   * in die Länge und erzeugt dort einen Streifen. Gespiegelt ist dasselbe,
   * was der Prozessorweg tut.
   */
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
  gl.bindFramebuffer(gl.FRAMEBUFFER, rahmen);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, textur, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return null;
  return { textur, rahmen };
}

export interface EntfaltungAuftrag {
  quelle: ImageData;
  kern: Kern;
  iterationen: number;
  daempfung: number;
  /** Die Saumbegrenzung – der Radius, in dem geklemmt wird. 0 schaltet sie ab. */
  saumRadius: number;
}

/** Warum es nicht ging – in Worten, die in der Oberfläche stehen dürfen. */
export class EntfaltungFehler extends Error {
  constructor(text: string) {
    super(text);
    this.name = 'EntfaltungFehler';
  }
}

/**
 * Entfalten, mit Fortschritt und ohne die Oberfläche einzufrieren.
 *
 * Die Durchgänge werden in Häppchen über mehrere Bildwechsel verteilt. Ohne
 * das stünde die Oberfläche für Sekunden – und ein Fortschrittsbalken, der
 * sich nicht bewegen kann, ist schlimmer als keiner.
 */
export async function entfaltenAufGpu(
  auftrag: EntfaltungAuftrag,
  melden?: (anteil: number) => void,
): Promise<ImageData> {
  const w = werkzeug();
  if (!w) {
    throw new EntfaltungFehler(
      'Dieses Gerät kann nicht entfalten – dafür braucht es WebGL 2 mit Gleitkommazielen.',
    );
  }
  const { gl } = w;
  const punkte = stuetzen(auftrag.kern);
  if (punkte.length > w.taps) {
    throw new EntfaltungFehler(
      `Diese Unschärfe ist für dieses Gerät zu gross (${punkte.length} Stützstellen, ${w.taps} gehen).`,
    );
  }

  const breite = auftrag.quelle.width;
  const hoehe = auftrag.quelle.height;
  w.leinwand.width = breite;
  w.leinwand.height = hoehe;

  const start = programmBauen(gl, START);
  const verhaeltnisP = programmBauen(gl, verhaeltnisQuelle(w.taps));
  const schrittP = programmBauen(gl, schrittQuelle(w.taps));
  const spanneP = programmBauen(gl, SPANNE);
  const ausgabeP = programmBauen(gl, AUSGABE);
  if (!start || !verhaeltnisP || !schrittP || !spanneP || !ausgabeP) {
    throw new EntfaltungFehler('Die Schattierer liessen sich nicht bauen.');
  }

  const eck = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, eck);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const quelltextur = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, quelltextur);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, auftrag.quelle);

  const ziele: (Ziel | null)[] = [];
  const machen = () => {
    const z = zielBauen(gl, breite, hoehe);
    ziele.push(z);
    return z;
  };
  const beobachtet = machen();
  const ersteSchaetzung = machen();
  const zweiteSchaetzung = machen();
  const verhaeltnis = machen();
  const braucheSaum = auftrag.saumRadius > 0;
  const kleinA = braucheSaum ? machen() : null;
  const grossA = braucheSaum ? machen() : null;
  const kleinB = braucheSaum ? machen() : null;
  const grossB = braucheSaum ? machen() : null;

  const aufraeumen = () => {
    for (const z of ziele) {
      if (!z) continue;
      gl.deleteTexture(z.textur);
      gl.deleteFramebuffer(z.rahmen);
    }
    gl.deleteTexture(quelltextur);
    gl.deleteBuffer(eck);
    for (const p of [start, verhaeltnisP, schrittP, spanneP, ausgabeP]) gl.deleteProgram(p);
  };

  if (!beobachtet || !ersteSchaetzung || !zweiteSchaetzung || !verhaeltnis) {
    aufraeumen();
    throw new EntfaltungFehler('Für dieses Bild reichte der Speicher der Grafikeinheit nicht.');
  }
  // Das Ping-Pong-Paar: aus der einen wird gelesen, in die andere geschrieben.
  let schaetzung: Ziel = ersteSchaetzung;
  let naechste: Ziel = zweiteSchaetzung;

  const schritt = new Float32Array([1 / breite, 1 / hoehe]);
  const tapFeld = new Float32Array(w.taps * 3);
  for (let i = 0; i < punkte.length; i += 1) {
    tapFeld[i * 3] = punkte[i].dx;
    tapFeld[i * 3 + 1] = punkte[i].dy;
    tapFeld[i * 3 + 2] = punkte[i].gewicht;
  }

  const zeichnen = (ziel: Ziel | null) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, ziel?.rahmen ?? null);
    gl.viewport(0, 0, breite, hoehe);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  const binden = (einheit: number, textur: WebGLTexture) => {
    gl.activeTexture(gl.TEXTURE0 + einheit);
    gl.bindTexture(gl.TEXTURE_2D, textur);
  };

  try {
    // ---- Start: sRGB in lineares Licht, zweimal (Beobachtung und Schätzung).
    gl.useProgram(start);
    binden(0, quelltextur);
    gl.uniform1i(gl.getUniformLocation(start, 'uQuelle'), 0);
    zeichnen(beobachtet);
    zeichnen(schaetzung);

    // ---- Die Durchgänge, in Häppchen über mehrere Bildwechsel.
    const orteV = {
      s: gl.getUniformLocation(verhaeltnisP, 'uSchaetzung'),
      b: gl.getUniformLocation(verhaeltnisP, 'uBeobachtet'),
      schritt: gl.getUniformLocation(verhaeltnisP, 'uSchritt'),
      anzahl: gl.getUniformLocation(verhaeltnisP, 'uAnzahl'),
      daempfung: gl.getUniformLocation(verhaeltnisP, 'uDaempfung'),
      taps: gl.getUniformLocation(verhaeltnisP, 'uTaps'),
    };
    const orteS = {
      v: gl.getUniformLocation(schrittP, 'uVerhaeltnis'),
      s: gl.getUniformLocation(schrittP, 'uSchaetzung'),
      schritt: gl.getUniformLocation(schrittP, 'uSchritt'),
      anzahl: gl.getUniformLocation(schrittP, 'uAnzahl'),
      taps: gl.getUniformLocation(schrittP, 'uTaps'),
    };

    for (let i = 0; i < auftrag.iterationen; i += 1) {
      gl.useProgram(verhaeltnisP);
      binden(0, schaetzung.textur);
      binden(1, beobachtet.textur);
      gl.uniform1i(orteV.s, 0);
      gl.uniform1i(orteV.b, 1);
      gl.uniform2fv(orteV.schritt, schritt);
      gl.uniform1i(orteV.anzahl, punkte.length);
      gl.uniform1f(orteV.daempfung, auftrag.daempfung);
      gl.uniform3fv(orteV.taps, tapFeld);
      zeichnen(verhaeltnis);

      gl.useProgram(schrittP);
      binden(0, verhaeltnis.textur);
      binden(1, schaetzung.textur);
      gl.uniform1i(orteS.v, 0);
      gl.uniform1i(orteS.s, 1);
      gl.uniform2fv(orteS.schritt, schritt);
      gl.uniform1i(orteS.anzahl, punkte.length);
      gl.uniform3fv(orteS.taps, tapFeld);
      zeichnen(naechste);

      const merk: Ziel = schaetzung;
      schaetzung = naechste;
      naechste = merk;

      /*
       * Alle paar Durchgänge Luft holen.
       *
       * `gl.finish()` erst, dann das Warten: Ohne das sammelt der Treiber die
       * Befehle aller Durchgänge in einer Schlange und arbeitet sie am Ende
       * am Stück ab – der Fortschrittsbalken sprünge dann von null auf hundert
       * und die Oberfläche stünde trotzdem.
       */
      if (i % 4 === 3 || i === auftrag.iterationen - 1) {
        gl.finish();
        melden?.((i + 1) / auftrag.iterationen);
        await new Promise((auf) => requestAnimationFrame(() => auf(undefined)));
      }
    }

    // ---- Die Spanne der Quelle, für die Saumbegrenzung.
    if (braucheSaum && kleinA && grossA && kleinB && grossB) {
      gl.useProgram(spanneP);
      const orte = {
        klein: gl.getUniformLocation(spanneP, 'uKlein'),
        gross: gl.getUniformLocation(spanneP, 'uGross'),
        schritt: gl.getUniformLocation(spanneP, 'uSchritt'),
        achse: gl.getUniformLocation(spanneP, 'uAchse'),
        radius: gl.getUniformLocation(spanneP, 'uRadius'),
      };
      const radius = Math.min(64, Math.max(1, Math.round(auftrag.saumRadius)));
      const doppelZiel = (a: Ziel, b: Ziel) => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, a.rahmen);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, b.textur, 0);
        gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
        gl.viewport(0, 0, breite, hoehe);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, null, 0);
        gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      };
      // Waagerecht: aus der Beobachtung in A.
      binden(0, beobachtet.textur);
      binden(1, beobachtet.textur);
      gl.uniform1i(orte.klein, 0);
      gl.uniform1i(orte.gross, 1);
      gl.uniform2fv(orte.schritt, schritt);
      gl.uniform1i(orte.radius, radius);
      gl.uniform2f(orte.achse, 1, 0);
      doppelZiel(kleinA, grossA);
      // Senkrecht: aus A in B.
      binden(0, kleinA.textur);
      binden(1, grossA.textur);
      gl.uniform2f(orte.achse, 0, 1);
      doppelZiel(kleinB, grossB);
    }

    // ---- Zurück in den Anzeigeraum und herauslesen.
    gl.useProgram(ausgabeP);
    binden(0, schaetzung.textur);
    if (braucheSaum && kleinB && grossB) {
      binden(1, kleinB.textur);
      binden(2, grossB.textur);
    }
    gl.uniform1i(gl.getUniformLocation(ausgabeP, 'uSchaetzung'), 0);
    gl.uniform1i(gl.getUniformLocation(ausgabeP, 'uKlein'), 1);
    gl.uniform1i(gl.getUniformLocation(ausgabeP, 'uGross'), 2);
    gl.uniform1i(gl.getUniformLocation(ausgabeP, 'uBegrenzen'), braucheSaum ? 1 : 0);
    zeichnen(null);

    const bytes = new Uint8ClampedArray(breite * hoehe * 4);
    gl.readPixels(0, 0, breite, hoehe, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    /*
     * Hier steht KEINE Umkehrung, und das ist der Punkt.
     *
     * „WebGL liest von unten nach oben" ist die Faustregel, und sie führt hier
     * in die Irre: Sie gilt gegenüber einer Leinwand, die von oben nach unten
     * gezeichnet wurde. Hochgeladen wurde aber ohne `UNPACK_FLIP_Y_WEBGL`,
     * also liegt Zeile null des Bildes bei v = 0, und v = 0 zeichnet der
     * Eckpunktschattierer an die UNTERE Kante. `readPixels` fängt unten an –
     * und damit bei Zeile null. Beide Drehungen heben sich auf.
     *
     * Nachgemessen, nicht überlegt: Mit der Umkehrung lag das Ergebnis 0,228
     * neben dem scharfen Bild und damit SCHLECHTER als die Unschärfe selbst
     * (0,182); ohne sie 0,0888 – und der Prozessorweg kommt auf 0,0891.
     * `e2e/entfaltung.spec.ts` misst beide Lagen und hält das fest.
     */
    // Die Deckkraft der Quelle bleibt, wie sie war – entfaltet wird die Farbe.
    for (let i = 3; i < bytes.length; i += 4) bytes[i] = auftrag.quelle.data[i];
    return new ImageData(bytes, breite, hoehe);
  } finally {
    aufraeumen();
  }
}
