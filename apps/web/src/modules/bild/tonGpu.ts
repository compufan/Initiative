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

import { BEREICHE_MAX } from './doc.js';
import type { Szene } from './maskenSpeicher.js';
import { maskeUmrastern } from './maske.js';
import { ABTAST_N, schaerfenFeld } from './schaerfe.js';
import { flaeche2d, glRaum } from './farbraum.js';
import {
  unscharfAufBytes,
  unscharfEbenen,
  type StufenGuete,
  type UnscharfEbene,
  type UnscharfQuelle,
} from './unscharf.js';
import {
  glslZahl,
  unscharfRechnen,
  unscharfVerwerfen,
  unscharfWerk,
  type UnscharfWerk,
} from './unscharfGpu.js';
import {
  LUT_KANTE,
  formHin,
  istNeutral,
  lutAnwenden,
  lutBauen,
  farbNeutral,
  farbSchluessel,
  tonSchluessel,
  vignetteFaktor,
  weissFaktoren,
  type Farbanpassung,
  type Anpassung,
} from './ton.js';
import {
  BAENDER,
  BAENDER_NEUTRAL,
  FARBTON_HUB,
  KURVEN_NEUTRAL,
  KURVE_STUETZEN,
  baenderNeutral,
  feinPunkt,
  kurvenFeld,
  kurvenNeutral,
} from './fein.js';

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
uniform float uSwRot;
uniform float uSwGruen;
uniform float uSchaerfe;
uniform float uVignette;

/*
 * Die örtlichen Anpassungen.
 *
 * EIN Atlas mit vier Kanälen statt vier Abtaster: In GLSL ES 3.00 lässt sich
 * ein Feld von „sampler2D“ nicht mit einer Laufvariablen indizieren. Kanal i
 * gehört zu Bereich i, ausgewählt per Skalarprodukt mit „uKanal[i]“.
 */
#define BEREICHE 4

/*
 * Der Feinschliff in Zahlen – aus „fein.ts“ eingesetzt, nicht abgeschrieben.
 *
 * Eine zweite Stelle, an der dieselben Konstanten stehen, ist eine zweite
 * Stelle, an der sie auseinanderlaufen koennen. Hier stehen sie nur einmal.
 */
#define STUETZEN ${KURVE_STUETZEN}
#define KURVEN_LAENGE ${KURVE_STUETZEN * 4}
#define BAENDER ${BAENDER.length}
#define ABTAST_N ${ABTAST_N}
const float SIGMA = ${glslZahl(ABTAST_N / 2)};
const float FARBTON_HUB = ${glslZahl(FARBTON_HUB)};
const float BAND_MITTE[BAENDER] = float[BAENDER](${BAENDER.map((b) => glslZahl(b.winkel / 360)).join(', ')});

uniform sampler2D uMasken;
uniform vec4 uKanal[BEREICHE];
uniform int uAnzahl;
uniform float uBelichtungB[BEREICHE];
uniform float uKontrastB[BEREICHE];
uniform float uLichterB[BEREICHE];
uniform float uTiefenB[BEREICHE];
uniform float uSchwarzB[BEREICHE];
uniform vec3 uWeissB[BEREICHE];
uniform float uSaettigungB[BEREICHE];
uniform float uDynamikB[BEREICHE];
uniform float uSwRotB[BEREICHE];
uniform float uSwGruenB[BEREICHE];
/**
 * Das Zwischenbild der Unschaerfe (Weichzeichnen und Bokeh), siehe
 * „unscharfGpu.ts“: RGB in Anzeigewerten, Alpha ist der Einfluss. Alpha 0
 * heisst unberuehrt – dann gilt das Original, Byte fuer Byte.
 */
uniform sampler2D uUnscharf;
uniform int uHatUnscharf;

/*
 * Der Feinschliff: vier Kurven zu je STUETZEN Werten, acht Farbbaender.
 *
 * Die Kurven kommen als TABELLE und nicht als Stuetzpunkte. Ein monotones
 * Spline je Bildpunkt auszuwerten hiesse, die Stuetzpunkte zu durchsuchen –
 * und vor allem: Prozessor und Grafikeinheit haetten zwei Auswertungen
 * derselben Kurve. Gerechnet wird sie genau einmal, in „fein.ts“.
 */
uniform float uKurven[KURVEN_LAENGE];
uniform bool uHatKurven;
/** Je Band: x = Farbton, y = Saettigung, z = Helligkeit. */
uniform vec3 uBand[BAENDER];
uniform float uSchaerfeRadius;
uniform float uSchaerfeSchwelle;
uniform bool uHatBaender;

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

/**
 * Die Farbkette – Wort für Wort „tonPunkt“ aus „ton.ts“.
 *
 * Als Funktion und nicht im Rumpf, weil ein Bereich sie noch einmal braucht.
 * Genau diese neun Regler und keinen mehr: „schaerfe“ bräuchte die Nachbarn
 * und „vignette“ den Ort – beides hat ein Bereich nicht.
 */
/*
 * Die gewichtete Helligkeit - der Farbfilter fuers Schwarz-Weiss.
 *
 * „swRot“ und „swGruen“ sind ABWEICHUNGEN von Rec.709; bei 0/0 kommt exakt
 * dot(c, LUMA) heraus. Muss Zeile fuer Zeile dasselbe rechnen wie
 * „gewichteteLuminanz“ in ton.ts - der Paritaetstest vergleicht beide
 * Bildpunkt fuer Bildpunkt.
 */
float grau(vec3 c, float swRot, float swGruen) {
  if (swRot == 0.0 && swGruen == 0.0) return dot(c, LUMA);
  float wr = max(0.0, 0.2126 + swRot * 0.6);
  float wg = max(0.0, 0.7152 + swGruen * 0.6);
  float wb = max(0.0, 0.0722 - (swRot + swGruen) * 0.6);
  float summe = wr + wg + wb;
  if (summe == 0.0) summe = 1.0;
  return (wr * c.r + wg * c.g + wb * c.b) / summe;
}

vec3 kette(vec3 c, float belichtung, vec3 weiss, float schwarz, float lichter,
           float tiefen, float kontrast, float saettigung, float dynamik,
           float swRot, float swGruen) {
  // 1. Im linearen Licht: Belichtung und Weissabgleich.
  if (belichtung != 0.0 || weiss != vec3(1.0)) {
    c = zuSrgb(clamp(zuLinear(c) * exp2(belichtung) * weiss, 0.0, 1.0));
  }

  // 2. Im Anzeigeraum: Schwarzpunkt.
  if (schwarz != 0.0) {
    float s = schwarz * 0.25;
    if (s > 0.0) c = clamp((c - s) / (1.0 - s), 0.0, 1.0);
    else c = c * (1.0 + s) - s;
  }

  // 3. Tiefen und Lichter, über zwei weiche Masken.
  if (lichter != 0.0 || tiefen != 0.0) {
    float l = dot(c, LUMA);
    float maskeL = smoothstep(0.45, 1.0, l);
    float maskeT = 1.0 - smoothstep(0.0, 0.55, l);
    c = biegen(biegen(c, lichter, maskeL), tiefen, maskeT);
  }

  // 4. Kontrast.
  if (kontrast > 0.0) {
    c = c * (1.0 - kontrast) + (c * c * (3.0 - 2.0 * c)) * kontrast;
  } else if (kontrast < 0.0) {
    c = c * (1.0 + kontrast) + (c * 0.5 + 0.25) * (-kontrast);
  }

  // 5. Sättigung und Dynamik.
  if (saettigung != 0.0 || dynamik != 0.0) {
    float y = grau(c, swRot, swGruen);
    float faktor = 1.0 + saettigung;
    if (dynamik != 0.0) {
      float spanne = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
      faktor *= 1.0 + dynamik * (1.0 - spanne);
    }
    faktor = max(0.0, faktor);
    c = vec3(y) + (c - vec3(y)) * faktor;
  }

  return clamp(c, 0.0, 1.0);
}

/**
 * Der Maskenwert eines Bereichs an dieser Stelle.
 *
 * „1.0 − y“, weil das BILD beim Hochladen gespiegelt wird (eine Leinwand
 * zählt von oben, eine Textur von unten) und der Atlas nicht: Er kommt als
 * roher Puffer, für den der Spiegel-Merker nachweislich uneinheitlich
 * gehandhabt wird. Statt uns auf eine Lesart zu verlassen, klemmen wir ihn
 * beim Hochladen ausdrücklich ab und drehen hier von Hand.
 */
float maskeAn(vec2 uv, vec4 kanal) {
  return clamp(dot(texture(uMasken, vec2(uv.x, 1.0 - uv.y)), kanal), 0.0, 1.0);
}

/** Aus der Kurventabelle lesen – linear, genau wie „kurveAn" in fein.ts. */
float kurveAn(int kurve, float x) {
  float letzte = float(STUETZEN - 1);
  float f = clamp(x, 0.0, 1.0) * letzte;
  int i0 = int(min(floor(f), letzte));
  int i1 = min(i0 + 1, STUETZEN - 1);
  float t = f - float(i0);
  int at = kurve * STUETZEN;
  return mix(uKurven[at + i0], uKurven[at + i1], t);
}

/**
 * RGB → HSL. Wort fuer Wort „zuHsl" aus fein.ts.
 *
 * Ohne Verzweigung ueber „step" und „mix": Ein „if" je Kanal waere hier
 * derselbe Text, aber auf einer Grafikeinheit mit Sprungvorhersage teurer –
 * und vor allem laesst sich die Fassung ohne Verzweigung Zeile fuer Zeile
 * gegen die TypeScript-Fassung halten.
 */
vec3 zuHsl(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float l = (mx + mn) * 0.5;
  float d = mx - mn;
  if (d < 1e-7) return vec3(0.0, 0.0, l);
  float s = l > 0.5 ? d / max(1e-7, 2.0 - mx - mn) : d / max(1e-7, mx + mn);
  float h;
  if (mx == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
  else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
  else h = (c.r - c.g) / d + 4.0;
  return vec3(h / 6.0, s, l);
}

float hslKanal(float p, float q, float t) {
  float x = t;
  if (x < 0.0) x += 1.0;
  if (x > 1.0) x -= 1.0;
  if (x < 1.0 / 6.0) return p + (q - p) * 6.0 * x;
  if (x < 0.5) return q;
  if (x < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - x) * 6.0;
  return p;
}

vec3 ausHsl(vec3 hsl) {
  if (hsl.y < 1e-7) return vec3(hsl.z);
  float q = hsl.z < 0.5 ? hsl.z * (1.0 + hsl.y) : hsl.z + hsl.y - hsl.z * hsl.y;
  float p = 2.0 * hsl.z - q;
  return vec3(
    hslKanal(p, q, hsl.x + 1.0 / 3.0),
    hslKanal(p, q, hsl.x),
    hslKanal(p, q, hsl.x - 1.0 / 3.0)
  );
}

/**
 * Das gemittelte Bandergebnis fuer diesen Farbton.
 *
 * Zwischen zwei benachbarten Bandmitten wird ueberblendet – Wort fuer Wort
 * „bandGewichte" aus fein.ts, nur ohne das Feld: Es wirken immer genau zwei
 * Baender, und ihre Gewichte sind t und 1 − t.
 */
vec3 bandMittel(float farbton) {
  /*
   * Erst in den Kreis zurueck.
   *
   * „zuHsl" kann genau 1.0 liefern: Bei einem Rotton, dessen Blau um ein
   * Millionstel ueber dem Gruen liegt, ist (g − b) / d so klein, dass 6.0 +
   * dieser Wert in „float" wieder 6.0 ist – und 6.0 / 6.0 ist 1.0. Ein
   * Achtbitbild allein schafft das nicht (dort trennt mindestens 1/255), wohl
   * aber jede Farbe, die vorher durch Zerstreuung oder Kurve gelaufen ist.
   *
   * 1.0 faellt in keinen Abschnitt. Ohne diese Zeile fiele die Schleife bis
   * ans Ende durch, und auf einen ROTEN Bildpunkt wirkte der Regler von
   * Magenta – ein einzelner falscher Punkt mitten in einer Flaeche, den man
   * fuer Bildrauschen haelt. „bandGewichte" in fein.ts tut dasselbe in der
   * ersten Zeile.
   */
  float h = farbton - floor(farbton);
  int i = BAENDER - 1;
  for (int k = 0; k < BAENDER - 1; k++) {
    if (h >= BAND_MITTE[k] && h < BAND_MITTE[k + 1]) {
      i = k;
      break;
    }
  }
  float a = BAND_MITTE[i];
  // Nicht „BAND_MITTE[i + 1]": Beim letzten Band laege das ausserhalb des
  // Feldes, und ein Zugriff daneben ist in GLSL nicht definiert. Dort endet
  // der Abschnitt bei der vollen Umdrehung, wo wieder das erste Band steht.
  float b = i + 1 < BAENDER ? BAND_MITTE[min(i + 1, BAENDER - 1)] : 1.0;
  float t = smoothstep(0.0, 1.0, b > a ? (h - a) / (b - a) : 0.0);
  return mix(uBand[i], uBand[(i + 1) % BAENDER], t);
}

/** Kurven und Baender – dieselbe Reihenfolge wie „feinPunkt" in fein.ts. */
vec3 fein(vec3 c) {
  if (uHatKurven) {
    c = vec3(kurveAn(1, c.r), kurveAn(2, c.g), kurveAn(3, c.b));
    c = vec3(kurveAn(0, c.r), kurveAn(0, c.g), kurveAn(0, c.b));
  }
  if (uHatBaender) {
    vec3 hsl = zuHsl(c);
    float flaute = smoothstep(0.04, 0.18, hsl.y);
    if (flaute > 0.0) {
      vec3 d = bandMittel(hsl.x);
      float h = hsl.x + d.x * FARBTON_HUB * flaute;
      h -= floor(h);
      float sn = clamp(hsl.y * max(0.0, 1.0 + d.y * flaute), 0.0, 1.0);
      float ln = clamp(biegen(vec3(hsl.z), d.z * flaute, 1.0).x, 0.0, 1.0);
      c = ausHsl(vec3(h, sn, ln));
    }
  }
  return clamp(c, 0.0, 1.0);
}

void main() {
  vec3 scharf = texture(uBild, vUv).rgb;
  vec3 c = scharf;

  /*
   * Weichzeichnen und Bokeh ganz am Anfang: Eine Linse zeichnet unscharf, die
   * Entwicklung kommt danach. Waere es umgekehrt, verteilte die Scheibe
   * bereits getoente Farben und der Kontrast wuerde zweimal angefasst.
   *
   * Gerechnet ist das schon, in einer eigenen Vorstufe (unscharfGpu.ts); hier
   * wird nur gelesen. Alpha 0 heisst, dass die Vorstufe diesen Bildpunkt nicht
   * angefasst hat – dann bleibt das Original, und zwar das Byte selbst und
   * nicht ein Umweg ueber Gleitkomma.
   */
  float unscharf = 0.0;
  if (uHatUnscharf == 1) {
    vec4 u = texelFetch(uUnscharf, ivec2(gl_FragCoord.xy), 0);
    unscharf = u.a;
    if (u.a > 0.0) c = u.rgb;
  }

  /*
   * Unschärfemaske: die Differenz zum Mittel der vier Nachbarn, verstärkt.
   *
   * Mit „(1 − unscharf)“ gedaempft. Ohne das holte die Schaerfe genau die
   * Hochfrequenz aus dem scharfen Quellbild zurueck, die die Unschaerfe gerade
   * entfernt hat – der Hintergrund waere unscharf UND kantig.
   *
   * Und nur als ZUWACHS auf das, was dasteht: Vorher ersetzte die Schaerfe „c“
   * durch das geschaerfte Original, und wer Schaerfe und Unschaerfe zugleich
   * einstellte, verlor die Unschaerfe.
   */
  if (uSchaerfe > 0.0) {
    /*
     * Fuenf mal fuenf Stellen, im Abstand des halben Radius – dasselbe
     * Muster wie in schaerfe.ts, damit beide Wege gleich aussehen.
     *
     * Gerechnet wird in LINEAREM Licht. Anzeigewerte sind nicht proportional
     * zum Licht, und deshalb fiel derselbe Unterschied auf der hellen Seite
     * einer Kante staerker aus als auf der dunklen – das ist der helle Saum,
     * der bisher ueber jeder dunklen Kante stand.
     */
    float schritt = max(0.5, uSchaerfeRadius) / float(ABTAST_N);
    vec3 weich = vec3(0.0);
    vec3 kleinst = vec3(1.0);
    vec3 groesst = vec3(0.0);
    float summe = 0.0;
    for (int dy = -ABTAST_N; dy <= ABTAST_N; dy++) {
      for (int dx = -ABTAST_N; dx <= ABTAST_N; dx++) {
        vec2 ab = vec2(float(dx), float(dy)) * schritt;
        vec3 wert = zuLinear(texture(uBild, vUv + ab * uTexel).rgb);
        float q = dot(ab, ab) / (schritt * schritt * 2.0 * SIGMA * SIGMA);
        float g = exp(-q);
        weich += wert * g;
        summe += g;
        kleinst = min(kleinst, wert);
        groesst = max(groesst, wert);
      }
    }
    weich /= summe;
    vec3 mitte = zuLinear(scharf);
    vec3 diff = mitte - weich;
    /*
     * Die Schwelle, weich und nicht als Sprung: Eine harte Grenze erzeugt
     * genau dort, wo sie liegt, eine sichtbare Linie im Verlauf.
     */
    vec3 anteil = uSchaerfeSchwelle <= 0.0
      ? vec3(1.0)
      : smoothstep(vec3(0.0), vec3(1.0), (abs(diff) - uSchaerfeSchwelle) / uSchaerfeSchwelle);
    vec3 roh = mitte + diff * uSchaerfe * 1.5 * (1.0 - unscharf) * anteil;
    // Die Saumbegrenzung: steiler ja, ueber die Nachbarschaft hinaus nein.
    vec3 geschaerft = min(groesst, max(kleinst, roh));
    vec3 lin = unscharf > 0.0 ? zuLinear(c) + (geschaerft - mitte) : geschaerft;
    c = zuSrgb(clamp(lin, 0.0, 1.0));
  }

  // Die globale Anpassung.
  c = kette(c, uBelichtung, uWeiss, uSchwarz, uLichter, uTiefen, uKontrast,
            uSaettigung, uDynamik, uSwRot, uSwGruen);

  /*
   * Die Bereiche, der Reihe nach – jeder auf dem ERGEBNIS des vorigen.
   *
   * Dieselbe Vorschrift wie „bereichePunkt“ in „ton.ts“, und der
   * Vergleichstest hält beide gegeneinander. Nicht aus der Rohfarbe zu
   * rechnen ist der Punkt: Ein Bereich mit lauter Nullen nähme sonst dort,
   * wo seine Maske greift, die globale Anpassung wieder zurück.
   */
  for (int i = 0; i < BEREICHE; i++) {
    if (i >= uAnzahl) break;
    float w = maskeAn(vUv, uKanal[i]);
    // Die grosse Mehrheit der Bildpunkte liegt bei einem Verlauf oder einer
    // Ellipse ausserhalb; die Kette dort trotzdem zu rechnen wäre die
    // teuerste Zeile des Schattierers.
    if (w <= 0.002) continue;
    vec3 voll = kette(c, uBelichtungB[i], uWeissB[i], uSchwarzB[i], uLichterB[i],
                      uTiefenB[i], uKontrastB[i], uSaettigungB[i], uDynamikB[i],
                      uSwRotB[i], uSwGruenB[i]);
    c = mix(c, voll, w);
  }

  // Der Feinschliff: nach den Bereichen, vor der Vignette. Warum genau dort,
  // steht bei „feinPunkt“ im Rückfallweg.
  if (uHatKurven || uHatBaender) c = fein(c);

  // Vignette – als Letztes, weil sie vom Ort abhängt und nicht von der Farbe.
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
export const zaehler = {
  quellHochladen: 0,
  maskenHochladen: 0,
  /** Wie oft die Vorstufe der Unschaerfe wirklich gerechnet wurde. */
  stufenGerechnet: 0,
  /** Wieviele Texturen die Vorstufe gerade lebend haelt (Vorrat eingeschlossen). */
  texturenLebend: 0,
};

/**
 * Von aussen die Grafikeinheit abschalten – nur für Prüfungen.
 *
 * Der Rückfallweg lässt sich sonst auf keinem Gerät auslösen, das WebGL2
 * kann, und wäre damit genau der Weg, den nie jemand prüft.
 */
let gpuVerboten = false;
export function gpuAbschalten(an: boolean): void {
  gpuVerboten = an;
}

interface Werk {
  gl: WebGL2RenderingContext;
  programm: WebGLProgram;
  textur: WebGLTexture;
  /** Der Maskenatlas: ein Kanal je Bereich, in Rastergrösse. */
  masken: WebGLTexture;
  /** Die Kernfelder gemischter Masken, im selben Aufbau wie der Atlas. */
  kern: WebGLTexture;
  /** Das Zwischenbild der Unschaerfe, wenn es der Prozessor gerechnet hat. */
  hybrid: WebGLTexture;
  /** Eine Textur ohne Inhalt für Einheit 3, wenn nichts unscharf ist. */
  leer: WebGLTexture;
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
let quellzettel: {
  quelle: CanvasImageSource;
  stand: number;
  breite: number;
  hoehe: number;
} | null = null;

/*
 * Wie oft der INHALT einer Quelle seit ihrem Anlegen ausgetauscht wurde.
 *
 * Die Zettel hier und in `zeichnen.ts` erkannten „dasselbe Bild" an der
 * Objektidentität. Für ein Foto stimmt das; eine Leinwand, in die Bild für
 * Bild mit `putImageData` ein neuer Filmbild geschrieben wird, bleibt aber
 * dasselbe Objekt. Nachgemessen: Ein Film mit wanderndem Quadrat kam mit
 * dem Quadrat von Bild 0 in JEDEM Bild heraus – mit Farbanpassung und mit
 * Bereichen, auf der Grafikeinheit. Die Masken wurden je Bild neu gerechnet,
 * das Bild darunter nicht: „das Video bleibt stehen, die Maske wandert".
 */
const quellStand = new WeakMap<object, number>();

/**
 * Meldet, dass in `bild` jetzt ein anderes Bild steht – nach jedem
 * `putImageData` oder `drawImage` in eine wiederverwendete Leinwand.
 */
export function quelleVeraendert(bild: CanvasImageSource): void {
  quellStand.set(bild, (quellStand.get(bild) ?? 0) + 1);
}

/**
 * Der Stand, mit dem ein Zettel sein Ergebnis vergleicht. Ein laufendes
 * Video zählt als jedes Mal neu – sein Inhalt wechselt ohne Meldung.
 */
export function quellstand(bild: CanvasImageSource): number {
  if (typeof HTMLVideoElement !== 'undefined' && bild instanceof HTMLVideoElement) return NaN;
  return quellStand.get(bild) ?? 0;
}

/**
 * Was gerade im Maskenatlas liegt.
 *
 * Ein Reglerzug ändert die Masken nicht – ohne diesen Zettel gingen 3,1 MB
 * je Bild über den Bus, für ein Ergebnis, das sich nicht geändert hat.
 */
let atlasZettel: string | null = null;

/** Wofür das Kernfeld-Atlas gilt – derselbe Schlüssel wie beim Maskenatlas, oder `null`. */
let kernZettel: string | null = null;

/** Wofür das vom Prozessor gerechnete Zwischenbild der Unschärfe gilt. */
let hybridZettel: string | null = null;

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
  const ctx = flaeche2d(flaeche);
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
    /*
     * Sofort nach dem Anlegen, vor der ersten Textur.
     *
     * `unpackColorSpace` gilt beim Hochladen, `drawingBufferColorSpace` bei
     * der Ausgabe – siehe `farbraum.ts`. Später gesetzt wären die schon
     * hochgeladenen Texturen im falschen Raum, und der Werkzeugkasten hält
     * genau eine Textur über die ganze Lebenszeit.
     */
    glRaum(gl);

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
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, textur);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    // Der Maskenatlas auf Einheit 1. LINEAR ist hier keine Kosmetik: Das
    // Raster ist rund viermal gröber als das Bild, und mit dem nächsten
    // Nachbarn bekäme jede Maskenkante eine sichtbare Treppe.
    const masken = gl.createTexture();
    if (!masken) return null;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, masken);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    /*
     * Das Kernfeld auf Einheit 2, im selben Aufbau. Es wird nur gebraucht, wenn
     * ein Bereich eine gemischte Maske hat („Motiv + Tiefe“); sonst bleibt es
     * der eine Bildpunkt, mit dem es angelegt wurde – ein Abtaster ohne
     * Textur wäre ein Fehler, auch wenn er nie gelesen wird.
     */
    const kern = gl.createTexture();
    if (!kern) return null;
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, kern);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));

    // Einheit 3: das Zwischenbild der Unschärfe. Zwei Texturen, weil es von
    // zwei Wegen kommen kann (Vorstufe oder Prozessor) und eine leere, wenn
    // nichts unscharf ist.
    const hybrid = gl.createTexture();
    const leer = gl.createTexture();
    if (!hybrid || !leer) return null;
    for (const t of [hybrid, leer]) {
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        1,
        1,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        new Uint8Array(4),
      );
    }
    gl.activeTexture(gl.TEXTURE0);

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
      'uSwRot',
      'uSwGruen',
      'uSchaerfe',
      'uSchaerfeRadius',
      'uSchaerfeSchwelle',
      'uVignette',
      'uMasken',
      'uAnzahl',
      'uUnscharf',
      'uHatUnscharf',
      /*
       * Das GANZE Kurvenfeld unter EINEM Namen.
       *
       * `uKurven` allein bezeichnet in WebGL2 das Feld ab Index 0, und
       * `uniform1fv` schreibt dann alle 132 Werte auf einen Schlag. Die
       * Alternative wären 132 einzeln abgefragte Orte und 132 Aufrufe je
       * Bild – für dieselbe Wirkung.
       */
      'uKurven',
      'uHatKurven',
      'uHatBaender',
    ];
    for (let i = 0; i < BAENDER.length; i += 1) namen.push(`uBand[${i}]`);
    for (let i = 0; i < BEREICHE_MAX; i += 1) {
      namen.push(
        `uKanal[${i}]`,
        `uBelichtungB[${i}]`,
        `uKontrastB[${i}]`,
        `uLichterB[${i}]`,
        `uTiefenB[${i}]`,
        `uSchwarzB[${i}]`,
        `uWeissB[${i}]`,
        `uSaettigungB[${i}]`,
        `uDynamikB[${i}]`,
        `uSwRotB[${i}]`,
        `uSwGruenB[${i}]`,
      );
    }
    const orte: Record<string, WebGLUniformLocation | null> = {};
    for (const name of namen) orte[name] = gl.getUniformLocation(programm, name);

    werk = { gl, programm, textur, masken, kern, hybrid, leer, orte, leinwand };
    return werk;
  } catch {
    return null;
  }
}

/**
 * Die Bereiche mit Unschärfe für die Rechnung auf dem Prozessor: Masken (und
 * Kernfelder) vom Raster auf die Arbeitsgrösse gebracht.
 *
 * Bilinear – dasselbe, was die Grafikeinheit mit `LINEAR` tut. Mit dem
 * nächsten Nachbarn zeigte der Prozessorweg an jeder Maskenkante eine Treppe.
 */
function prozessorQuellen(
  szene: Szene,
  ebenen: readonly UnscharfEbene[],
  breite: number,
  hoehe: number,
): UnscharfQuelle[] {
  return ebenen.map((ebene) => {
    const b = szene.bereiche[ebene.platz];
    const { raster } = b.maske;
    const hoch = (feld: Uint8Array) =>
      maskeUmrastern(feld, raster.breite, raster.hoehe, breite, hoehe);
    return {
      ebene,
      maske: hoch(b.maske.feld),
      kern: ebene.reinheit === 2 && b.maske.kern ? hoch(b.maske.kern) : null,
    };
  });
}

/**
 * Das Zwischenbild der Unschärfe als Textur – von der Vorstufe auf der
 * Grafikeinheit, oder, wo die nicht geht, vom Prozessor.
 *
 * Der Schlüssel enthält alles, wovon das Bild abhängt: welches Bild hochgeladen
 * ist (`quellHochladen` zählt jedes Hochladen), welche Masken im Atlas liegen,
 * die Radien, die Güte und die Grösse. Ein Zug an „Belichtung“ ändert keins
 * davon – und die Unschärfe kostet dann nichts.
 */
function unscharfHolen(
  w: Werk,
  bild: CanvasImageSource,
  breite: number,
  hoehe: number,
  szene: Szene,
  ebenen: readonly UnscharfEbene[],
  guete: StufenGuete,
): WebGLTexture | null {
  const schluessel = [
    zaehler.quellHochladen,
    atlasZettel,
    ebenen.map((e) => `${e.platz}:${e.bokehPx}:${e.weichPx}:${e.reinheit}`).join(','),
    guete,
    `${breite}x${hoehe}`,
  ].join('|');
  const stufe: UnscharfWerk | null = unscharfWerk(w.gl, zaehler);
  if (stufe) {
    const textur = unscharfRechnen(
      stufe,
      { quelle: w.textur, atlas: w.masken, kernAtlas: w.kern, breite, hoehe, guete },
      ebenen,
      schluessel,
    );
    if (textur) return textur;
  }
  return unscharfHybrid(w, bild, breite, hoehe, szene, ebenen, guete, schluessel);
}

/**
 * Der Hybrid-Weg: Fehlen float-renderbare Ziele (`EXT_color_buffer_float`),
 * rechnet der Prozessor die Vorstufe und lädt das Ergebnis als 8 Bit hoch –
 * Anzeigewerte, Alpha ist der Einfluss, genau das Format der Vorstufe.
 *
 * Der Rest bleibt auf der Grafikeinheit. Das kostet ein halbe bis eine
 * Sekunde, aber nur, wenn sich etwas an der Unschärfe ändert – dank des
 * Zettels nicht bei jedem Zug an einem anderen Regler.
 */
function unscharfHybrid(
  w: Werk,
  bild: CanvasImageSource,
  breite: number,
  hoehe: number,
  szene: Szene,
  ebenen: readonly UnscharfEbene[],
  guete: StufenGuete,
  schluessel: string,
): WebGLTexture | null {
  const { gl } = w;
  if (hybridZettel === schluessel) return w.hybrid;
  const flaeche = verkleinern(bild, breite, hoehe);
  const ctx = flaeche instanceof HTMLCanvasElement ? flaeche2d(flaeche) : null;
  if (!ctx) return null;
  const bilddaten = ctx.getImageData(0, 0, breite, hoehe);
  const einfluss = unscharfAufBytes(
    bilddaten.data,
    breite,
    hoehe,
    prozessorQuellen(szene, ebenen, breite, hoehe),
    guete,
  );
  for (let i = 0; i < einfluss.length; i += 1) bilddaten.data[i * 4 + 3] = einfluss[i];
  gl.activeTexture(gl.TEXTURE3);
  gl.bindTexture(gl.TEXTURE_2D, w.hybrid);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    breite,
    hoehe,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    bilddaten.data,
  );
  gl.activeTexture(gl.TEXTURE0);
  hybridZettel = schluessel;
  zaehler.stufenGerechnet += 1;
  return w.hybrid;
}

/** Rechnet ein Bild auf der Grafikeinheit durch. Gibt `null` zurück, wenn nicht. */
function aufGpu(
  bild: CanvasImageSource,
  breite: number,
  hoehe: number,
  a: Anpassung,
  szene: Szene,
  guete: StufenGuete,
): HTMLCanvasElement | null {
  if (gpuVerboten) return null;
  const w = werkzeug();
  if (!w) return null;
  const { gl, orte } = w;
  // Schon vor dem Hochladen: Ein Kontext, der zwischen zwei Bildern verloren
  // ging, kostet sonst einen Durchlauf ins Leere.
  if (gl.isContextLost()) {
    werkVerwerfen();
    return null;
  }
  try {
    if (w.leinwand.width !== breite) w.leinwand.width = breite;
    if (w.leinwand.height !== hoehe) w.leinwand.height = hoehe;
    gl.viewport(0, 0, breite, hoehe);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, w.textur);
    const stand = quellstand(bild);
    const passt =
      quellzettel &&
      quellzettel.quelle === bild &&
      quellzettel.stand === stand &&
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
      quellzettel = { quelle: bild, stand, breite, hoehe };
      zaehler.quellHochladen += 1;
    }

    atlasHochladen(w, szene);

    /*
     * Die Vorstufe der Unschärfe – vor allem anderen, weil sie Programm,
     * Ziel und Texturbindungen verstellt. Danach wird der Hauptdurchlauf
     * ausdrücklich wiederhergestellt.
     */
    const ebenen = unscharfEbenen(szene.bereiche, breite, hoehe);
    const unscharf =
      ebenen.length > 0 ? unscharfHolen(w, bild, breite, hoehe, szene, ebenen, guete) : null;
    gl.useProgram(w.programm);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, breite, hoehe);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, unscharf ?? w.leer);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, w.masken);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, w.textur);

    const [wr, wg, wb] = weissFaktoren(a.waerme, a.toenung);
    gl.uniform1i(orte.uBild, 0);
    gl.uniform1i(orte.uMasken, 1);
    gl.uniform1i(orte.uUnscharf, 3);
    gl.uniform1i(orte.uHatUnscharf, unscharf ? 1 : 0);
    gl.uniform1i(orte.uAnzahl, szene.bereiche.length);
    for (let i = 0; i < BEREICHE_MAX; i += 1) {
      const b = szene.bereiche[i];
      // Der Kanalwähler: ein 1 an der Stelle dieses Bereichs, sonst 0. Das
      // Skalarprodukt im Schattierer greift damit genau einen Kanal heraus.
      gl.uniform4f(
        orte[`uKanal[${i}]`],
        i === 0 ? 1 : 0,
        i === 1 ? 1 : 0,
        i === 2 ? 1 : 0,
        i === 3 ? 1 : 0,
      );
      const t = b ? b.anpassung : null;
      gl.uniform1f(orte[`uBelichtungB[${i}]`], t ? t.belichtung : 0);
      gl.uniform1f(orte[`uKontrastB[${i}]`], t ? t.kontrast : 0);
      gl.uniform1f(orte[`uLichterB[${i}]`], t ? t.lichter : 0);
      gl.uniform1f(orte[`uTiefenB[${i}]`], t ? t.tiefen : 0);
      gl.uniform1f(orte[`uSchwarzB[${i}]`], t ? t.schwarz : 0);
      const [br, bg, bb] = t ? weissFaktoren(t.waerme, t.toenung) : [1, 1, 1];
      gl.uniform3f(orte[`uWeissB[${i}]`], br, bg, bb);
      gl.uniform1f(orte[`uSaettigungB[${i}]`], t ? t.saettigung : 0);
      gl.uniform1f(orte[`uDynamikB[${i}]`], t ? t.dynamik : 0);
      gl.uniform1f(orte[`uSwRotB[${i}]`], t ? t.swRot : 0);
      gl.uniform1f(orte[`uSwGruenB[${i}]`], t ? t.swGruen : 0);
    }

    gl.uniform2f(orte.uTexel, 1 / breite, 1 / hoehe);
    gl.uniform1f(orte.uBelichtung, a.belichtung);
    gl.uniform1f(orte.uKontrast, a.kontrast);
    gl.uniform1f(orte.uLichter, a.lichter);
    gl.uniform1f(orte.uTiefen, a.tiefen);
    gl.uniform1f(orte.uSchwarz, a.schwarz);
    gl.uniform3f(orte.uWeiss, wr, wg, wb);
    gl.uniform1f(orte.uSaettigung, a.saettigung);
    gl.uniform1f(orte.uDynamik, a.dynamik);
    gl.uniform1f(orte.uSwRot, a.swRot);
    gl.uniform1f(orte.uSwGruen, a.swGruen);
    gl.uniform1f(orte.uSchaerfe, a.schaerfe);
    gl.uniform1f(orte.uSchaerfeRadius, a.schaerfeRadius);
    gl.uniform1f(orte.uSchaerfeSchwelle, a.schaerfeSchwelle);
    gl.uniform1f(orte.uVignette, a.vignette);

    /*
     * Der Feinschliff.
     *
     * Die Schalter `uHatKurven`/`uHatBaender` stehen nicht aus Sparsamkeit
     * da: Ohne sie liefe die Bandschleife für JEDEN Bildpunkt eines
     * unbearbeiteten Fotos – acht Durchgänge mit einer HSL-Hin- und
     * Rückrechnung, für ein Ergebnis, das sich nicht von der Eingabe
     * unterscheidet. Die Kurvenwerte werden trotzdem immer geschrieben:
     * Ein Uniform, das von einem vorigen Bild stehengeblieben ist, wäre
     * genau die Sorte Fehler, die nur beim zweiten Bild auftritt.
     */
    const kurven = a.kurven ?? KURVEN_NEUTRAL;
    const baender = a.baender ?? BAENDER_NEUTRAL;
    gl.uniform1fv(orte.uKurven, kurvenFeld(kurven));
    gl.uniform1i(orte.uHatKurven, kurvenNeutral(kurven) ? 0 : 1);
    gl.uniform1i(orte.uHatBaender, baenderNeutral(baender) ? 0 : 1);
    for (let i = 0; i < BAENDER.length; i += 1) {
      const band = baender[i];
      gl.uniform3f(
        orte[`uBand[${i}]`],
        band ? band.farbton : 0,
        band ? band.saettigung : 0,
        band ? band.helligkeit : 0,
      );
    }

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (gl.isContextLost()) {
      // Ein toter Kontext wirft nichts, er tut nur nichts: ohne das Verwerfen
      // blieb er für die ganze Sitzung der „Werkzeugkasten“, und jedes Bild
      // lief über Aufrufe ins Leere zum Prozessor.
      werkVerwerfen();
      return null;
    }
    return w.leinwand;
  } catch {
    // Ein verlorener Kontext ist auf einem Telefon Alltag, kein Fehler.
    werkVerwerfen();
    return null;
  }
}

/**
 * Vergisst alles, was an einem Kontext hing – nach einem Verlust zeigen
 * Texturen und Zettel ins Leere.
 *
 * Der Quellzettel MUSS dabei mitfallen: Er behauptete sonst, in einer Textur
 * aus einem toten Kontext liege noch das richtige Bild. Dasselbe gilt für den
 * Atlas, die Kernfelder, das Zwischenbild der Unschärfe samt Vorrat – und der
 * Zähler der lebenden Texturen beginnt von vorn. Das nächste Bild legt einen
 * neuen Kontext an; solange der Prozessor rechnet, sieht niemand etwas.
 */
function werkVerwerfen(): void {
  werk = undefined;
  quellzettel = null;
  atlasZettel = null;
  kernZettel = null;
  hybridZettel = null;
  unscharfVerwerfen();
  zaehler.texturenLebend = 0;
}

/**
 * Legt die Masken aller Bereiche als einen RGBA-Atlas ab.
 *
 * Kanal 0 ist Bereich 0 und so fort. Alle Bereiche teilen sich dasselbe
 * Raster (`szeneBauen` sorgt dafür), sonst gäbe es keinen gemeinsamen Atlas.
 */
function atlasHochladen(w: Werk, szene: Szene): void {
  const { gl } = w;
  const schluessel = szene.bereiche.map((b) => `${b.id}@${b.maske.stand}`).join('#');
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, w.masken);
  if (atlasZettel === schluessel) {
    gl.activeTexture(gl.TEXTURE0);
    kernHochladen(w, szene, schluessel);
    return;
  }

  const erste = szene.bereiche[0];
  const rb = erste ? erste.maske.raster.breite : 1;
  const rh = erste ? erste.maske.raster.hoehe : 1;
  const atlas = new Uint8Array(rb * rh * 4);
  for (let i = 0; i < szene.bereiche.length && i < BEREICHE_MAX; i += 1) {
    const feld = szene.bereiche[i].maske.feld;
    for (let at = 0; at < feld.length; at += 1) atlas[at * 4 + i] = feld[at];
  }

  /*
   * Zwei Merker, die hier ausdrücklich gesetzt werden müssen:
   *
   * `UNPACK_ALIGNMENT` steht auf 4, und eine Rasterzeile ist selten durch
   * vier teilbar – bei einem Hochformat etwa 768 breit ist sie es, bei 769
   * nicht, und die Maske stünde geschert statt kaputt. (Bei RGBA ist die
   * Zeile immer durch vier teilbar; der Merker steht trotzdem, weil ein
   * späterer Wechsel auf einkanalig ihn sonst still bräuchte.)
   *
   * `UNPACK_FLIP_Y` ist Modulzustand: Das Bild-Hochladen setzt ihn auf
   * `true` und stellt ihn nicht zurück. Ob er auf einen rohen Puffer wirkt,
   * wird uneinheitlich gehandhabt – wir verlassen uns auf keine Lesart,
   * klemmen ihn hier ab und drehen im Schattierer von Hand.
   */
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, rb, rh, 0, gl.RGBA, gl.UNSIGNED_BYTE, atlas);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.activeTexture(gl.TEXTURE0);
  atlasZettel = schluessel;
  zaehler.maskenHochladen += 1;
  kernHochladen(w, szene, schluessel);
}

/**
 * Das Kernfeld-Atlas: derselbe Aufbau wie der Maskenatlas, nur mit den
 * Kernfeldern gemischter Masken. Gebraucht wird es nur, wo eine Maske
 * Silhouette und glatte Teile mischt – sonst bleibt es leer, und es kostet
 * nichts.
 */
function kernHochladen(w: Werk, szene: Szene, schluessel: string): void {
  const { gl } = w;
  const hat = szene.bereiche.some((b) => b.maske.kern);
  const soll = hat ? schluessel : null;
  if (kernZettel === soll) return;
  kernZettel = soll;
  if (!hat) return;
  const erste = szene.bereiche[0];
  const rb = erste.maske.raster.breite;
  const rh = erste.maske.raster.hoehe;
  const atlas = new Uint8Array(rb * rh * 4);
  for (let i = 0; i < szene.bereiche.length && i < BEREICHE_MAX; i += 1) {
    const feld = szene.bereiche[i].maske.kern;
    if (!feld) continue;
    for (let at = 0; at < feld.length; at += 1) atlas[at * 4 + i] = feld[at];
  }
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, w.kern);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, rb, rh, 0, gl.RGBA, gl.UNSIGNED_BYTE, atlas);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.activeTexture(gl.TEXTURE0);
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
function aufLeinwand(
  bild: CanvasImageSource,
  breite: number,
  hoehe: number,
  a: Anpassung,
  szene: Szene,
  guete: StufenGuete,
): HTMLCanvasElement | null {
  const flaeche = document.createElement('canvas');
  flaeche.width = breite;
  flaeche.height = hoehe;
  const ctx = flaeche2d(flaeche, { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(bild, 0, 0, breite, hoehe);
  const bilddaten = ctx.getImageData(0, 0, breite, hoehe);
  const daten = bilddaten.data;

  /*
   * Weichzeichnen und Bokeh ganz am Anfang: Eine Linse zeichnet unscharf, die
   * Entwicklung kommt danach. Wäre es umgekehrt, verteilte die Scheibe
   * bereits getönte Farben, und der Kontrast würde zweimal angefasst.
   *
   * Dieselbe Rechnung wie die Grafikeinheit (`unscharf.ts`, `unscharfGpu.ts`):
   * gleiche Strecken, gleicher Kern, gleiche Stufen. Dass es hier einmal ein
   * Kastenmittel und ein anderes Bild als auf dem Telefon mit Grafikeinheit
   * war, ist der Fehler, den es nicht wieder geben soll – der Vergleichstest
   * hält beide Wege jetzt auch mit Unschärfe gegeneinander.
   */
  // Das Bild, wie es vor der Unschärfe war – die Schärfe liest daraus.
  const unverwischt = a.schaerfe > 0 ? new Uint8ClampedArray(daten) : daten;
  let daempfung: Uint8Array | null = null;
  const ebenen = unscharfEbenen(szene.bereiche, breite, hoehe);
  if (ebenen.length > 0) {
    daempfung = unscharfAufBytes(
      daten,
      breite,
      hoehe,
      prozessorQuellen(szene, ebenen, breite, hoehe),
      guete,
    );
  }

  if (a.schaerfe > 0) {
    schaerfenFeld(
      daten,
      breite,
      hoehe,
      a.schaerfe,
      a.schaerfeRadius,
      a.schaerfeSchwelle,
      daempfung,
      unverwischt,
    );
  }

  /*
   * Die Farbtabelle nur, wo es Farbe zu rechnen gibt.
   *
   * Sie hat 33 Stützstellen je Achse, auf ganze Bytes gerundet, und
   * interpoliert trilinear – auch eine neutrale Tabelle verändert deshalb
   * Bytes, gemessen 12 % der Kanalwerte um eine Stufe. Ein Bereich, der nur
   * unscharf zeichnet, soll aber ausserhalb seiner Maske jedes Byte lassen,
   * und die Grafikeinheit rechnet bei neutralen Reglern ohnehin gar nichts.
   */
  const globalFarbe = !farbNeutral(a);
  const lut = globalFarbe ? lutHolen(a) : null;
  /*
   * Die Kurventabelle einmal je Bild, nicht einmal je Bildpunkt.
   *
   * `null`, wenn die Kurven gerade sind: Dann läuft die Auswertung gar nicht
   * erst an, und bei einem Foto von zwölf Megapunkten sind das sechsunddreissig
   * Millionen Tabellenzugriffe, die niemand braucht.
   */
  const feinFeld = kurvenNeutral(a.kurven ?? KURVEN_NEUTRAL)
    ? null
    : kurvenFeld(a.kurven ?? KURVEN_NEUTRAL);
  const feinBaender = baenderNeutral(a.baender ?? BAENDER_NEUTRAL) ? null : a.baender;
  /*
   * Je Bereich EINE Farbtabelle und EIN auf Bildgrösse gezogenes Gewicht.
   *
   * Das Ausdehnen ist bilinear und damit dasselbe, was die Grafikeinheit mit
   * `LINEAR` tut – mit dem nächsten Nachbarn zeigte der Rückfallweg an jeder
   * Maskenkante eine Treppe, wo die Grafikeinheit weich ist, und der
   * Vergleichstest zwischen beiden Wegen fiele zu Recht.
   */
  const bereiche = szene.bereiche
    .filter((b) => !farbNeutral(b.anpassung))
    .map((b) => ({
      lut: lutHolen(b.anpassung),
      gewicht: maskeUmrastern(
        b.maske.feld,
        b.maske.raster.breite,
        b.maske.raster.hoehe,
        breite,
        hoehe,
      ),
    }));

  for (let y = 0; y < hoehe; y += 1) {
    const v = (y + 0.5) / hoehe;
    for (let x = 0; x < breite; x += 1) {
      const at = (y * breite + x) * 4;
      let [r, g, b] = lut
        ? lutAnwenden(lut, daten[at], daten[at + 1], daten[at + 2])
        : [daten[at], daten[at + 1], daten[at + 2]];
      for (const bereich of bereiche) {
        const w = bereich.gewicht[y * breite + x];
        if (w === 0) continue;
        const [vr, vg, vb] = lutAnwenden(bereich.lut, r, g, b);
        if (w === 255) {
          r = vr;
          g = vg;
          b = vb;
          continue;
        }
        /*
         * Erst rechnen, dann mischen – nicht umgekehrt.
         *
         * Die gemischte Farbe durch die Tabelle zu schicken wäre etwas
         * anderes: Die Kette ist nicht linear, und bei kräftigen Kurven
         * liegen die beiden Wege über zehn Stufen auseinander. Der
         * Schattierer mischt ebenfalls hinterher (`mix(c, voll, w)`).
         */
        const t = w / 255;
        r += (vr - r) * t;
        g += (vg - g) * t;
        b += (vb - b) * t;
      }
      if (feinFeld || feinBaender) {
        /*
         * Der Feinschliff NACH den Bereichen, vor der Vignette.
         *
         * Nach den Bereichen, weil eine Kurve das letzte Wort über die
         * Gradation hat – genau wie in jedem Bearbeitungsprogramm, in dem die
         * Kurve unter den Grundreglern sitzt. Vor der Vignette, weil die vom
         * ORT abhängt und nicht von der Farbe: Sie gehört ganz ans Ende.
         */
        const [fr, fg, fb] = feinPunkt([r / 255, g / 255, b / 255], feinFeld, feinBaender);
        r = fr * 255;
        g = fg * 255;
        b = fb * 255;
      }
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
  stand: number;
  /** Zur Güte gehört das Ergebnis: ein Standbild in „mittel“ ist keins in „hoch“. */
  guete: StufenGuete;
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
  return bildRechnen(bild, breite, hoehe, a, LEERE_SZENE);
}

/** Eine Szene ohne örtliche Anpassungen – der Normalfall. */
const LEERE_SZENE: Szene = { bereiche: [], schluessel: '' };

/**
 * Dasselbe, aber mit örtlichen Anpassungen.
 *
 * `getoentesBild` ist der Sonderfall ohne Bereiche und bleibt bestehen, damit
 * der Vergleichstest gegen `tonPunkt` unverändert gilt.
 */
export function bildRechnen(
  bild: CanvasImageSource,
  breite: number,
  hoehe: number,
  a: Anpassung,
  szene: Szene,
  optionen?: {
    /**
     * Für Bilder, die gleich wieder vergehen – die Vorschau beim Wischen und
     * Abspielen eines Films.
     *
     * Dann gibt es weder Merkzettel noch eigene Kopie: Bei jedem Filmbild
     * ändert sich das Ergebnis ohnehin, und je Bild eine neue Leinwand samt
     * 2D-Kontext anzulegen, ist auf einem Telefon genau das, woran der
     * Grafikspeicher ausgeht. Zurück kommt die Leinwand der Grafikeinheit
     * selbst; sie gilt nur bis zum nächsten Aufruf.
     */
    readonly fluechtig?: boolean;
    /**
     * Wie genau Weichzeichnen und Bokeh rechnen – ohne Angabe `hoch`.
     * Beide Wege, Grafikeinheit und Prozessor, halten sich daran; der
     * Vergleichstest rechnet sie auf derselben Güte.
     */
    readonly guete?: StufenGuete;
  },
): CanvasImageSource {
  /*
   * Der Kurzschluss prüft BEIDES.
   *
   * Daran hängt mehr als eine gesparte Rechnung: Bei „nichts zu tun“ kommt
   * das Quellbild SELBST zurück, und eine Ebene darüber hängt an genau
   * dieser Objektidentität die Umrechnung der Verpixel-Ausschnitte
   * (`quellSkala` in `zeichnen.ts`). Käme hier bei neutraler globaler
   * Anpassung, aber vorhandenen Bereichen weiterhin das Original zurück,
   * läse jeder Verpixelungsbalken bei halbem Massstab an der doppelten
   * Stelle.
   */
  if ((istNeutral(a) && szene.bereiche.length === 0) || breite <= 0 || hoehe <= 0) return bild;
  const schluessel = szene.bereiche.length > 0 ? szene.schluessel : tonSchluessel(a);
  const stand = quellstand(bild);
  const guete = optionen?.guete ?? 'hoch';
  if (
    !optionen?.fluechtig &&
    gemerkt &&
    gemerkt.schluessel === schluessel &&
    gemerkt.breite === breite &&
    gemerkt.hoehe === hoehe &&
    gemerkt.quelle === bild &&
    gemerkt.stand === stand &&
    gemerkt.guete === guete
  ) {
    return gemerkt.flaeche;
  }
  const aufDerGpu = aufGpu(bild, breite, hoehe, a, szene, guete);
  letzterWeg = aufDerGpu ? 'gpu' : 'leinwand';
  const fertig = aufDerGpu ?? aufLeinwand(bild, breite, hoehe, a, szene, guete);
  if (!fertig) {
    letzterWeg = 'keiner';
    return bild;
  }
  if (optionen?.fluechtig) {
    /*
     * Dieselbe Leinwand, neuer Inhalt – und das muss jeder erfahren, der
     * sich ein Ergebnis an ihr merkt. Sonst zeigte `unkenntlich` in
     * `zeichnen.ts` auf jedem weiteren Filmbild den Weichzeichnerfleck des
     * ersten: dieselbe Fehlerklasse wie das eingefrorene Video aus 6faac08.
     */
    quelleVeraendert(fertig);
    return fertig;
  }
  // Die GPU-Leinwand wird beim nächsten Aufruf überschrieben – für den
  // Merkzettel braucht es eine eigene Kopie.
  const eigen = document.createElement('canvas');
  eigen.width = breite;
  eigen.height = hoehe;
  const ectx = flaeche2d(eigen);
  if (!ectx) return fertig;
  ectx.drawImage(fertig, 0, 0);
  gemerkt = { flaeche: eigen, schluessel, breite, hoehe, quelle: bild, stand, guete };
  return eigen;
}

/** Nur für Prüfungen: die Tabellenkantenlänge und die Achsenverzerrung. */
export const TABELLE = { kante: LUT_KANTE, formHin };
