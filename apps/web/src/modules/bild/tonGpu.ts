/**
 * Der Tonwert-Kern auf der Grafikeinheit – und ohne sie.
 *
 * Zwei Wege zum selben Ergebnis:
 *
 * - **WebGL2.** Die Rechnung aus `ton.ts`, noch einmal in GLSL. Das ist die
 *   einzige Verdopplung im ganzen Vorhaben, und sie ist bewusst: Ein Foto von
 *   4000 Punkten Kante hat zwölf Millionen Bildpunkte, und wer an einem
 *   Regler zieht, will sie sechzigmal in der Sekunde sehen. Damit die beiden
 *   Fassungen nicht auseinanderlaufen, hält `e2e/ton.spec.ts` sie
 *   gegeneinander: ein Testbild durch beide Wege, Bildpunkt für Bildpunkt
 *   verglichen.
 * - **Leinwand.** Ohne WebGL2 rechnet der Prozessor. Nicht mit `tonPunkt`
 *   selbst – das wären bei einer Million Bildpunkten eine halbe Sekunde –,
 *   sondern über die Farbtabelle aus `ton.ts`, die aus genau dieser Funktion
 *   gebaut wird.
 *
 * Beides liefert eine Leinwand, die überall dort eingesetzt wird, wo sonst
 * das Quellbild stünde. Der Rest der Bildbearbeitung merkt nichts davon.
 */

import {
  LUT_KANTE,
  formHin,
  istNeutral,
  lutAnwenden,
  lutBauen,
  farbSchluessel,
  tonSchluessel,
  vignetteFaktor,
  weissFaktoren,
  type Farbanpassung,
  type Anpassung,
} from './ton.js';

/* ---------- GLSL ---------- */

const ECKPUNKTE = `#version 300 es
in vec2 aOrt;
out vec2 vUv;
void main() {
  vUv = aOrt * 0.5 + 0.5;
  gl_Position = vec4(aOrt, 0.0, 1.0);
}`;

/**
 * Der Bildpunkt-Schattierer.
 *
 * Zeile für Zeile dasselbe wie `tonPunkt` in `ton.ts`, in derselben
 * Reihenfolge, mit denselben Konstanten. Wer hier etwas ändert, ändert es
 * dort mit – sonst schlägt der Vergleichstest fehl, und das ist seine
 * einzige Aufgabe.
 *
 * Zwei Dinge kommen hinzu, die dort nicht stehen können, weil sie nicht von
 * der Farbe allein abhängen: die Unschärfemaske (braucht die Nachbarpunkte,
 * deshalb ganz am Anfang) und die Vignette (braucht den Ort, deshalb ganz am
 * Ende).
 */
const FARBEN = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uBild;
uniform vec2 uTexel;
uniform float uBelichtung;
uniform float uKontrast;
uniform float uLichter;
uniform float uTiefen;
uniform float uSchwarz;
uniform vec3 uWeiss;
uniform float uSaettigung;
uniform float uDynamik;
uniform float uSchaerfe;
uniform float uVignette;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

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
}

/** Wurzel hebt an, Quadrat senkt ab – beides monoton und ohne Anschlag. */
vec3 biegen(vec3 wert, float staerke, float maske) {
  if (staerke == 0.0 || maske == 0.0) return wert;
  vec3 ziel = staerke > 0.0 ? sqrt(wert) : wert * wert;
  float anteil = abs(staerke) * maske;
  return wert * (1.0 - anteil) + ziel * anteil;
}

void main() {
  vec3 c = texture(uBild, vUv).rgb;

  // Unschärfemaske: die Differenz zum Mittel der vier Nachbarn, verstärkt.
  if (uSchaerfe > 0.0) {
    vec3 weich = (
      texture(uBild, vUv + vec2(uTexel.x, 0.0)).rgb +
      texture(uBild, vUv - vec2(uTexel.x, 0.0)).rgb +
      texture(uBild, vUv + vec2(0.0, uTexel.y)).rgb +
      texture(uBild, vUv - vec2(0.0, uTexel.y)).rgb
    ) * 0.25;
    c = clamp(c + (c - weich) * uSchaerfe * 1.5, 0.0, 1.0);
  }

  // 1. Im linearen Licht: Belichtung und Weissabgleich.
  if (uBelichtung != 0.0 || uWeiss != vec3(1.0)) {
    c = zuSrgb(clamp(zuLinear(c) * exp2(uBelichtung) * uWeiss, 0.0, 1.0));
  }

  // 2. Im Anzeigeraum: Schwarzpunkt.
  if (uSchwarz != 0.0) {
    float s = uSchwarz * 0.25;
    if (s > 0.0) c = clamp((c - s) / (1.0 - s), 0.0, 1.0);
    else c = c * (1.0 + s) - s;
  }

  // 3. Tiefen und Lichter, über zwei weiche Masken.
  if (uLichter != 0.0 || uTiefen != 0.0) {
    float l = dot(c, LUMA);
    float maskeL = smoothstep(0.45, 1.0, l);
    float maskeT = 1.0 - smoothstep(0.0, 0.55, l);
    c = biegen(biegen(c, uLichter, maskeL), uTiefen, maskeT);
  }

  // 4. Kontrast.
  if (uKontrast > 0.0) {
    c = c * (1.0 - uKontrast) + (c * c * (3.0 - 2.0 * c)) * uKontrast;
  } else if (uKontrast < 0.0) {
    c = c * (1.0 + uKontrast) + (c * 0.5 + 0.25) * (-uKontrast);
  }

  // 5. Sättigung und Dynamik.
  if (uSaettigung != 0.0 || uDynamik != 0.0) {
    float y = dot(c, LUMA);
    float faktor = 1.0 + uSaettigung;
    if (uDynamik != 0.0) {
      float spanne = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
      faktor *= 1.0 + uDynamik * (1.0 - spanne);
    }
    faktor = max(0.0, faktor);
    c = vec3(y) + (c - vec3(y)) * faktor;
  }

  c = clamp(c, 0.0, 1.0);

  // 6. Vignette – als Letztes, weil sie vom Ort abhängt und nicht von der Farbe.
  if (uVignette != 0.0) {
    vec2 d = vUv - 0.5;
    float abstand = min(1.0, length(d) / 0.70710678);
    c = clamp(c * (1.0 - uVignette * smoothstep(0.3, 1.0, abstand)), 0.0, 1.0);
  }

  fragColor = vec4(c, 1.0);
}`;

/* ---------- WebGL2 ---------- */

/**
 * Zählwerk für die Prüfungen.
 *
 * Ein Test, der „das Bild wird nur einmal hochgeladen" behauptet, muss das
 * zählen können. Zeitmessungen an derselben Stelle wären auf einem
 * ausgelasteten Bauserver launisch; ein Zähler ist es nie.
 */
export const zaehler = { quellHochladen: 0 };

interface Werk {
  gl: WebGL2RenderingContext;
  programm: WebGLProgram;
  textur: WebGLTexture;
  orte: Record<string, WebGLUniformLocation | null>;
  leinwand: HTMLCanvasElement;
}

let werk: Werk | null | undefined;

/**
 * Was gerade in der Quelltextur liegt.
 *
 * Ohne diesen Zettel lud `aufGpu` bei **jedem** Bild das ganze Foto neu hoch.
 * Bei 4000 × 3000 sind das zwölf Megapixel und rund 48 MB über den Bus – je
 * Reglerraste, sechzigmal in der Sekunde gewünscht. Das war der grösste
 * Einzelposten auf dem Reglerweg und hat mit den Reglern selbst nichts zu tun.
 */
let quellzettel: { quelle: CanvasImageSource; breite: number; hoehe: number } | null = null;

/**
 * Eine eigene Leinwand zum Vorverkleinern.
 *
 * Nicht die aus `zeichnen.ts`: die benutzt `unkenntlich` im selben Rahmen.
 *
 * Das Verkleinern hier statt beim Textur-Abtasten ist zugleich das bessere
 * Bild: 4000 auf 1200 allein mit `LINEAR` ist Unterabtastung – vier von fünf
 * Bildpunkten werden ungesehen weggeworfen, und feine Strukturen flimmern.
 * `imageSmoothingQuality = 'high'` mittelt stattdessen über die Fläche.
 */
let verkleinerCanvas: HTMLCanvasElement | null = null;
function verkleinern(bild: CanvasImageSource, breite: number, hoehe: number): CanvasImageSource {
  if (!verkleinerCanvas) verkleinerCanvas = document.createElement('canvas');
  const flaeche = verkleinerCanvas;
  if (flaeche.width !== breite) flaeche.width = breite;
  if (flaeche.height !== hoehe) flaeche.height = hoehe;
  const ctx = flaeche.getContext('2d');
  if (!ctx) return bild;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'copy';
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bild, 0, 0, breite, hoehe);
  return flaeche;
}

function uebersetzen(gl: WebGL2RenderingContext, art: number, quelle: string): WebGLShader | null {
  const shader = gl.createShader(art);
  if (!shader) return null;
  gl.shaderSource(shader, quelle);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    // Nicht schweigend scheitern: Ein Übersetzungsfehler im Schattierer ist
    // ein Programmfehler, kein Gerätemangel.
    console.error('Schattierer:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

/**
 * Legt Kontext und Programm an – genau einmal.
 *
 * `undefined` heisst „noch nicht versucht“, `null` heisst „geht hier nicht“.
 * Der Unterschied zählt: Ein zweiter Versuch, den Kontext zu bekommen, würde
 * auf jedem Gerät ohne WebGL2 bei jedem Bild neu scheitern.
 */
function werkzeug(): Werk | null {
  if (werk !== undefined) return werk;
  werk = null;
  try {
    const leinwand = document.createElement('canvas');
    const gl = leinwand.getContext('webgl2', {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) return null;

    const ecken = uebersetzen(gl, gl.VERTEX_SHADER, ECKPUNKTE);
    const farben = uebersetzen(gl, gl.FRAGMENT_SHADER, FARBEN);
    if (!ecken || !farben) return null;
    const programm = gl.createProgram();
    if (!programm) return null;
    gl.attachShader(programm, ecken);
    gl.attachShader(programm, farben);
    gl.linkProgram(programm);
    if (!gl.getProgramParameter(programm, gl.LINK_STATUS)) {
      console.error('Programm:', gl.getProgramInfoLog(programm));
      return null;
    }
    gl.useProgram(programm);

    // Zwei Dreiecke, die den ganzen Bildschirm füllen.
    const puffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, puffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const ort = gl.getAttribLocation(programm, 'aOrt');
    gl.enableVertexAttribArray(ort);
    gl.vertexAttribPointer(ort, 2, gl.FLOAT, false, 0, 0);

    const textur = gl.createTexture();
    if (!textur) return null;
    gl.bindTexture(gl.TEXTURE_2D, textur);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    const namen = [
      'uBild',
      'uTexel',
      'uBelichtung',
      'uKontrast',
      'uLichter',
      'uTiefen',
      'uSchwarz',
      'uWeiss',
      'uSaettigung',
      'uDynamik',
      'uSchaerfe',
      'uVignette',
    ];
    const orte: Record<string, WebGLUniformLocation | null> = {};
    for (const name of namen) orte[name] = gl.getUniformLocation(programm, name);

    werk = { gl, programm, textur, orte, leinwand };
    return werk;
  } catch {
    return null;
  }
}

/** Rechnet ein Bild auf der Grafikeinheit durch. Gibt `null` zurück, wenn nicht. */
function aufGpu(
  bild: CanvasImageSource,
  breite: number,
  hoehe: number,
  a: Anpassung,
): HTMLCanvasElement | null {
  const w = werkzeug();
  if (!w) return null;
  const { gl, orte } = w;
  try {
    if (w.leinwand.width !== breite) w.leinwand.width = breite;
    if (w.leinwand.height !== hoehe) w.leinwand.height = hoehe;
    gl.viewport(0, 0, breite, hoehe);

    gl.bindTexture(gl.TEXTURE_2D, w.textur);
    const passt =
      quellzettel &&
      quellzettel.quelle === bild &&
      quellzettel.breite === breite &&
      quellzettel.hoehe === hoehe;
    if (!passt) {
      // `UNPACK_FLIP_Y`: Eine Leinwand zählt von oben, eine Textur von unten.
      // Ohne das stünde das Bild auf dem Kopf – und zwar nur mit
      // Grafikeinheit, also genau dort, wo es niemand vermutet.
      //
      // Nachgemessen an einer Kette aus drei Durchgängen (Quelle → A → B →
      // Bildschirm): Ein Zwischenziel dreht **nichts** um. Der Merker gehört
      // also genau auf dieses eine Hochladen und auf keinen Durchgang danach.
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        verkleinern(bild, breite, hoehe) as TexImageSource,
      );
      quellzettel = { quelle: bild, breite, hoehe };
      zaehler.quellHochladen += 1;
    }

    const [wr, wg, wb] = weissFaktoren(a.waerme, a.toenung);
    gl.uniform1i(orte.uBild, 0);
    gl.uniform2f(orte.uTexel, 1 / breite, 1 / hoehe);
    gl.uniform1f(orte.uBelichtung, a.belichtung);
    gl.uniform1f(orte.uKontrast, a.kontrast);
    gl.uniform1f(orte.uLichter, a.lichter);
    gl.uniform1f(orte.uTiefen, a.tiefen);
    gl.uniform1f(orte.uSchwarz, a.schwarz);
    gl.uniform3f(orte.uWeiss, wr, wg, wb);
    gl.uniform1f(orte.uSaettigung, a.saettigung);
    gl.uniform1f(orte.uDynamik, a.dynamik);
    gl.uniform1f(orte.uSchaerfe, a.schaerfe);
    gl.uniform1f(orte.uVignette, a.vignette);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (gl.isContextLost()) return null;
    return w.leinwand;
  } catch {
    // Ein verlorener Kontext ist auf einem Telefon Alltag, kein Fehler.
    // Der Quellzettel MUSS dabei mitfallen: Er behauptete sonst, in einer
    // Textur aus einem toten Kontext liege noch das richtige Bild.
    werk = undefined;
    quellzettel = null;
    return null;
  }
}

/* ---------- Leinwand als Rückfall ---------- */

/**
 * Die zuletzt gebauten Farbtabellen.
 *
 * Mehrere Plätze und nicht einer: Sobald es örtliche Anpassungen gibt, laufen
 * mehrere verschiedene Tabellen im selben Bilddurchgang. Mit einem Platz
 * verdrängten sie einander bei jedem Bereich, und jeder Verdränger kostet
 * 35 937 Aufrufe von `tonPunkt`.
 *
 * Der Schlüssel ist `farbSchluessel` und nicht `tonSchluessel`: `schaerfe`
 * und `vignette` stehen gar nicht in der Tabelle, ihre Änderung darf sie
 * also nicht wegwerfen.
 */
const TABELLEN_MAX = 6;
const tabellen = new Map<string, Uint8Array>();

function lutHolen(a: Farbanpassung): Uint8Array {
  const schluessel = farbSchluessel(a);
  const da = tabellen.get(schluessel);
  if (da) {
    // Ans Ende schieben: Map behält die Einfügereihenfolge, damit ist der
    // erste Eintrag immer der am längsten ungenutzte.
    tabellen.delete(schluessel);
    tabellen.set(schluessel, da);
    return da;
  }
  const daten = lutBauen(a);
  tabellen.set(schluessel, daten);
  if (tabellen.size > TABELLEN_MAX) {
    const aeltester = tabellen.keys().next().value;
    if (aeltester !== undefined) tabellen.delete(aeltester);
  }
  return daten;
}

/** Die Unschärfemaske auf dem Prozessor – vier Nachbarn, wie im Schattierer. */
function schaerfen(daten: Uint8ClampedArray, breite: number, hoehe: number, staerke: number): void {
  const kopie = new Uint8ClampedArray(daten);
  for (let y = 0; y < hoehe; y += 1) {
    for (let x = 0; x < breite; x += 1) {
      const at = (y * breite + x) * 4;
      for (let k = 0; k < 3; k += 1) {
        const links = kopie[(y * breite + Math.max(0, x - 1)) * 4 + k];
        const rechts = kopie[(y * breite + Math.min(breite - 1, x + 1)) * 4 + k];
        const oben = kopie[(Math.max(0, y - 1) * breite + x) * 4 + k];
        const unten = kopie[(Math.min(hoehe - 1, y + 1) * breite + x) * 4 + k];
        const weich = (links + rechts + oben + unten) * 0.25;
        daten[at + k] = kopie[at + k] + (kopie[at + k] - weich) * staerke * 1.5;
      }
    }
  }
}

function aufLeinwand(
  bild: CanvasImageSource,
  breite: number,
  hoehe: number,
  a: Anpassung,
): HTMLCanvasElement | null {
  const flaeche = document.createElement('canvas');
  flaeche.width = breite;
  flaeche.height = hoehe;
  const ctx = flaeche.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(bild, 0, 0, breite, hoehe);
  const bilddaten = ctx.getImageData(0, 0, breite, hoehe);
  const daten = bilddaten.data;

  if (a.schaerfe > 0) schaerfen(daten, breite, hoehe, a.schaerfe);

  const lut = lutHolen(a);
  for (let y = 0; y < hoehe; y += 1) {
    const v = (y + 0.5) / hoehe;
    for (let x = 0; x < breite; x += 1) {
      const at = (y * breite + x) * 4;
      const [r, g, b] = lutAnwenden(lut, daten[at], daten[at + 1], daten[at + 2]);
      const faktor = a.vignette === 0 ? 1 : vignetteFaktor((x + 0.5) / breite, v, a.vignette);
      daten[at] = r * faktor;
      daten[at + 1] = g * faktor;
      daten[at + 2] = b * faktor;
    }
  }
  ctx.putImageData(bilddaten, 0, 0);
  return flaeche;
}

/* ---------- die Aussenseite ---------- */

interface Merkzettel {
  flaeche: HTMLCanvasElement;
  schluessel: string;
  breite: number;
  hoehe: number;
  quelle: CanvasImageSource;
}

let gemerkt: Merkzettel | null = null;

/**
 * Welcher Weg zuletzt gerechnet hat.
 *
 * Nur zum Nachsehen – der Vergleichstest muss wissen, ob er wirklich die
 * Grafikeinheit gemessen hat. Ohne das ginge er auch dann durch, wenn still
 * der Prozessor eingesprungen wäre, und prüfte damit die Verdopplung nicht,
 * für die es ihn gibt.
 */
export let letzterWeg: 'gpu' | 'leinwand' | 'keiner' = 'keiner';

/**
 * Das Bild mit angewandten Tonwerten – oder das Bild selbst, wenn nichts
 * eingestellt ist.
 *
 * `breite`/`hoehe` sind die Arbeitsgrösse: In der Ansicht die Grösse, in der
 * das Bild ohnehin gezeigt wird, beim Ausgeben die volle. Eine Vignette und
 * eine Unschärfemaske sind massstabsabhängig, deshalb muss die Ausgabe in
 * ihrer eigenen Grösse gerechnet werden und nicht hochskaliert.
 *
 * Das Ergebnis ist eine **neue** Leinwand, sobald sich etwas ändert. Das ist
 * Absicht: Weiter oben hängen Zwischenspeicher an der Identität des Bildes
 * (der Weichzeichner in `zeichnen.ts`), und die würden eine im Stillen
 * überschriebene Leinwand nicht bemerken.
 */
export function getoentesBild(
  bild: CanvasImageSource,
  breite: number,
  hoehe: number,
  a: Anpassung,
): CanvasImageSource {
  if (istNeutral(a) || breite <= 0 || hoehe <= 0) return bild;
  const schluessel = tonSchluessel(a);
  if (
    gemerkt &&
    gemerkt.schluessel === schluessel &&
    gemerkt.breite === breite &&
    gemerkt.hoehe === hoehe &&
    gemerkt.quelle === bild
  ) {
    return gemerkt.flaeche;
  }
  const aufDerGpu = aufGpu(bild, breite, hoehe, a);
  letzterWeg = aufDerGpu ? 'gpu' : 'leinwand';
  const fertig = aufDerGpu ?? aufLeinwand(bild, breite, hoehe, a);
  if (!fertig) {
    letzterWeg = 'keiner';
    return bild;
  }
  // Die GPU-Leinwand wird beim nächsten Aufruf überschrieben – für den
  // Merkzettel braucht es eine eigene Kopie.
  const eigen = document.createElement('canvas');
  eigen.width = breite;
  eigen.height = hoehe;
  const ectx = eigen.getContext('2d');
  if (!ectx) return fertig;
  ectx.drawImage(fertig, 0, 0);
  gemerkt = { flaeche: eigen, schluessel, breite, hoehe, quelle: bild };
  return eigen;
}

/** Nur für Prüfungen: die Tabellenkantenlänge und die Achsenverzerrung. */
export const TABELLE = { kante: LUT_KANTE, formHin };
