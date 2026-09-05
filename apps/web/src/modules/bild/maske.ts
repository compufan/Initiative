/**
 * Die Maskengeometrie der örtlichen Anpassungen – ohne Leinwand, ohne
 * Grafikeinheit.
 *
 * Eine Maske ist ein Graustufenfeld: ein Byte je Rasterpunkt, 0 heisst „hier
 * gar nicht“, 255 „hier ganz“. Gebaut wird sie hier, hochgeladen und
 * überblendet wird sie anderswo – diese Datei kennt weder `ImageData` noch
 * eine Textur und läuft deshalb unter `vitest` mit Umgebung `node`.
 *
 * **Alles Geometrische steht in Punkten des ORIGINALBILDES.** Drehung,
 * Spiegelung, Zuschnitt und Lupe kommen erst in der Zeichenschicht dazu; eine
 * Maske muss von ihnen nichts wissen. Wer hier Ansichtspunkte hineinreicht,
 * bekommt eine Maske, die beim ersten Drehen wegrutscht – und zwar nur beim
 * Drehen, weshalb es niemand beim Bauen merkt.
 *
 * **Alles Gerasterte steht dagegen im Raster.** Genau zwischen diesen beiden
 * Räumen liegt der Fehler, der in diesem Modul am leichtesten passiert:
 * `raster.faktor` beim Pinselradius zu vergessen (siehe `strichStempeln`).
 */

import { weich } from './ton.js';
import type { Maskenteil, Pinselstrich, RadialTeil, VerlaufTeil } from './doc.js';
import { tiefenFeld } from './tiefe.js';

function klemmen(wert: number, unten: number, oben: number): number {
  return wert < unten ? unten : wert > oben ? oben : wert;
}

/* ---------- das Raster ---------- */

/**
 * Die längste Kante des Maskenrasters.
 *
 * Masken werden NICHT in Originalgrösse gerechnet. Ein 4000 × 3000-Foto ergäbe
 * 12 MB je Maske; bei vier Bereichen und 25 Rückgängig-Schritten ist das der
 * Punkt, an dem ein Telefon die Seite wegwirft. Mit 1024 sind es 1024 × 768 =
 * 786 432 Bytes, also 0,79 MB je Bereich.
 *
 * Sichtbar ist der Unterschied nicht: Die Maske wird bilinear gelesen
 * (`maskeLesen`, auf der Grafikeinheit LINEAR), und eine Maskenkante ist ein
 * weicher Übergang und keine Zeichnung. Was dem Raster fehlt, ist Schärfe –
 * die eine Maske gar nicht haben darf.
 */
export const MASKEN_KANTE = 1024;

export interface Raster {
  breite: number;
  hoehe: number;
  /** Rasterpunkte je Originalpunkt, nie grösser als 1. */
  faktor: number;
}

/**
 * Das Raster für ein Bild dieser Grösse.
 *
 * Verkleinert wird nur, nie vergrössert: Ein 500 × 400-Bild bekommt Faktor 1
 * und das Raster 500 × 400. Ein hochgerechnetes Raster kostete das Vierfache
 * an Speicher und trüge kein Fitzelchen mehr Information – die Maske käme
 * weiterhin aus denselben paar Griffen.
 */
export function rasterFuer(breite: number, hoehe: number, kante = MASKEN_KANTE): Raster {
  const laengste = Math.max(1, breite, hoehe);
  const roh = Math.min(1, kante / laengste);
  const rb = Math.max(1, Math.round(breite * roh));
  const rh = Math.max(1, Math.round(hoehe * roh));
  /*
   * Der Faktor kommt aus der GERUNDETEN Rasterbreite, nicht aus `roh`.
   *
   * Sonst lägen Hin- und Rückrechnung um bis zu einen halben Rasterpunkt
   * auseinander – bei 4000 Punkten Breite und Faktor 0,256 ist das ein halber
   * Originalpunkt, aber bei einer krummen Kante wie 3999 wächst der Fehler
   * zum Bildrand hin auf, und ein Pinselstrich landete neben dem Finger.
   */
  return { breite: rb, hoehe: rh, faktor: rb / Math.max(1, breite) };
}

/**
 * Der Originalpunkt eines Rasterpunkts – auf Punktmitten gerechnet.
 *
 * Das `+ 0,5 … − 0,5` ist kein Feinschliff: Ohne es liegt die Maske um einen
 * halben Rasterpunkt versetzt, bei Faktor 0,256 also um knapp zwei
 * Originalpunkte. Am weichen Verlauf sieht das niemand, an der harten
 * Pinselkante schon.
 *
 * Beide Achsen benutzen denselben `faktor`. Das Raster hält das
 * Seitenverhältnis bis auf die Rundung auf ganze Punkte ein; eine zweite
 * Achsenzahl unterschiede sich erst in der vierten Stelle und wäre vor allem
 * eine weitere Gelegenheit, die falsche zu erwischen.
 */
export function rasterNachOriginal(r: Raster, gx: number, gy: number): { x: number; y: number } {
  return { x: (gx + 0.5) / r.faktor - 0.5, y: (gy + 0.5) / r.faktor - 0.5 };
}

/** Die Gegenrichtung, je Achse. Bewusst dieselbe Formel, nur umgestellt. */
function nachRaster(r: Raster, wert: number): number {
  return (wert + 0.5) * r.faktor - 0.5;
}

/**
 * Die Originalkoordinaten aller Zeilen und Spalten, einmal vorgerechnet.
 *
 * 1024 + 768 Divisionen statt 786 432 – und, wichtiger, die Umrechnung steht
 * weiterhin nur an einer Stelle (`rasterNachOriginal`). Eine zweite, „schnelle“
 * Fassung derselben Formel driftet von der ersten weg, sobald jemand an einer
 * von beiden das Vorzeichen richtigstellt.
 */
function achsen(raster: Raster): { xs: Float64Array; ys: Float64Array } {
  const xs = new Float64Array(raster.breite);
  const ys = new Float64Array(raster.hoehe);
  for (let gx = 0; gx < raster.breite; gx += 1) xs[gx] = rasterNachOriginal(raster, gx, 0).x;
  for (let gy = 0; gy < raster.hoehe; gy += 1) ys[gy] = rasterNachOriginal(raster, 0, gy).y;
  return { xs, ys };
}

/* ---------- Verlauf ---------- */

export interface VerlaufVor {
  vonX: number;
  vonY: number;
  dx: number;
  dy: number;
  laenge2: number;
}

/**
 * Die Achse eines Verlaufs, einmal ausgerechnet.
 *
 * Getrennt vom Gewicht, weil `verlaufGewicht` je Griffbewegung 786 432-mal
 * läuft: Die Differenz und ihr Quadrat gehören nicht in diese Schleife.
 */
export function verlaufVorbereiten(t: VerlaufTeil): VerlaufVor {
  const dx = t.bis.x - t.von.x;
  const dy = t.bis.y - t.von.y;
  return { vonX: t.von.x, vonY: t.von.y, dx, dy, laenge2: dx * dx + dy * dy };
}

/**
 * Das Gewicht an einer Stelle: 0 am Anfangsgriff, 1 am Endgriff.
 *
 * Gerechnet wird die PROJEKTION auf die Achse, nicht der Abstand zum
 * Anfangsgriff. Nur so ist das Gewicht auf jeder Senkrechten zur Achse
 * konstant – ein Abstand ergäbe konzentrische Ringe und damit einen
 * radialen Verlauf, der an den beiden Griffen zufällig richtig aussieht.
 */
export function verlaufGewicht(v: VerlaufVor, x: number, y: number): number {
  // Beide Griffe aufeinander: Der Anwender hat gerade erst aufgesetzt. 1 statt
  // 0/0 – die Maske ist dann voll offen, nicht NaN und damit schwarz.
  if (v.laenge2 === 0) return 1;
  const t = ((x - v.vonX) * v.dx + (y - v.vonY) * v.dy) / v.laenge2;
  return weich(0, 1, t);
}

/* ---------- Ellipse ---------- */

export interface RadialVor {
  mx: number;
  my: number;
  cos: number;
  sin: number;
  rx: number;
  ry: number;
  /** Ab welchem Abstand der Abfall beginnt, 0 … 0,98. */
  innen: number;
}

/**
 * Die Ellipse, einmal ausgerechnet.
 *
 * `cos`/`sin` sind die von MINUS dem Winkel. Die Ellipse ist um `winkel`
 * gedreht, gebraucht wird aber die Gegenrichtung: Ein Weltpunkt muss in das
 * Bezugssystem der Ellipse, und das ist die Drehung zurück. Mit dem falschen
 * Vorzeichen dreht sich die Maske beim Ziehen am Winkelgriff verkehrt herum –
 * bei Winkel 0 und bei einem Kreis sieht man davon nichts.
 */
export function radialVorbereiten(t: RadialTeil): RadialVor {
  return {
    mx: t.mitte.x,
    my: t.mitte.y,
    cos: Math.cos(-t.winkel),
    sin: Math.sin(-t.winkel),
    // Halbachse 0 gibt es genau einen Zeigerschritt lang, nämlich beim
    // Aufziehen einer neuen Ellipse. 0/0 wäre NaN, und NaN malte ein Loch in
    // die Bildmitte, das erst beim nächsten Loslassen verschwindet.
    rx: Math.abs(t.rx) || 1,
    ry: Math.abs(t.ry) || 1,
    innen: 1 - klemmen(t.weichheit, 0.02, 1),
  };
}

/** 1 in der Mitte, 0 auf der Ellipse und ausserhalb. */
export function radialGewicht(v: RadialVor, x: number, y: number): number {
  const px = x - v.mx;
  const py = y - v.my;
  const ux = (px * v.cos - py * v.sin) / v.rx;
  const uy = (px * v.sin + py * v.cos) / v.ry;
  /*
   * `Math.sqrt` und nicht `Math.hypot`.
   *
   * `hypot` schützt vor Überlauf, skaliert dafür seine Argumente und ist auf
   * V8 rund dreimal so teuer. Hier gibt es nichts zu schützen: `ux` und `uy`
   * sind auf die Halbachsen normiert und liegen im Bereich weniger Einheiten.
   * Bei 786 432 Rasterpunkten je Griffbewegung ist das der Unterschied
   * zwischen einer Ellipse, die am Finger klebt, und einer, die nachzieht.
   */
  const d = Math.sqrt(ux * ux + uy * uy);
  return 1 - weich(v.innen, 1, d);
}

/* ---------- Pinsel ---------- */

/** Abstand eines Punktes zur STRECKE a–b, nicht zur Geraden. */
export function abstandZuStrecke(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const laenge2 = dx * dx + dy * dy;
  // Ohne die Begrenzung auf 0 … 1 wäre es die Gerade, und ein Strich hätte an
  // seinen Enden keine runde Kappe, sondern liefe endlos weiter.
  const t = laenge2 === 0 ? 0 : klemmen(((px - ax) * dx + (py - ay) * dy) / laenge2, 0, 1);
  const qx = px - (ax + dx * t);
  const qy = py - (ay + dy * t);
  return Math.sqrt(qx * qx + qy * qy);
}

/**
 * Stempelt einen Strich in ein Rasterfeld.
 *
 * **Der Radius wird umgerechnet.** `strich.breite` steht in Originalpunkten,
 * gestempelt wird im Raster – ohne `raster.faktor` ist der Pinsel bei einem
 * 4000-Punkte-Foto knapp viermal zu dick. Das ist der wahrscheinlichste Fehler
 * in dieser Datei, und er fällt in keinem kleinen Testbild auf, weil dort
 * `faktor` genau 1 ist.
 *
 * **Verrechnet wird mit `max` beziehungsweise `min`, nie mit `+=`.** Ein Strich
 * fährt beim Malen über seine eigene Spur zurück; mit einer Summe würde die
 * Stelle, an der der Finger langsamer wurde, heller als der Rest.
 *
 * `abIndex` ist der erste PUNKT, der noch nicht im Feld steht. Der erste noch
 * fehlende ABSCHNITT ist deshalb `abIndex − 1`: Der Abschnitt vom letzten
 * bereits gestempelten Punkt zum ersten neuen gehört noch dazu. Eine Stelle zu
 * spät angefangen, und im Strich klafft je Fortschreibung eine Lücke.
 */
export function strichStempeln(
  feld: Uint8Array,
  raster: Raster,
  strich: Pinselstrich,
  abIndex = 0,
): void {
  const anzahl = strich.punkte.length >> 1;
  if (anzahl === 0) return;
  const radius = (strich.breite / 2) * raster.faktor;
  if (!(radius > 0)) return;
  const kern = radius * klemmen(strich.haerte, 0, 1);
  // Ein einzelner Punkt ist ein Abschnitt auf sich selbst – ein Tupfer.
  const abschnitte = Math.max(1, anzahl - 1);
  const erster = Math.max(0, Math.trunc(abIndex) - 1);

  for (let s = erster; s < abschnitte; s += 1) {
    const j = Math.min(s + 1, anzahl - 1);
    const ax = nachRaster(raster, strich.punkte[s * 2]);
    const ay = nachRaster(raster, strich.punkte[s * 2 + 1]);
    const bx = nachRaster(raster, strich.punkte[j * 2]);
    const by = nachRaster(raster, strich.punkte[j * 2 + 1]);

    // Nur das Rechteck um diesen einen Abschnitt. Über das ganze Feld zu
    // laufen kostete bei jedem Zeigerereignis 786 432 Abstände statt einiger
    // hundert – und ein Strich besteht aus dutzenden Abschnitten.
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - radius));
    const x1 = Math.min(raster.breite - 1, Math.ceil(Math.max(ax, bx) + radius));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - radius));
    const y1 = Math.min(raster.hoehe - 1, Math.ceil(Math.max(ay, by) + radius));

    for (let gy = y0; gy <= y1; gy += 1) {
      const zeile = gy * raster.breite;
      for (let gx = x0; gx <= x1; gx += 1) {
        const d = abstandZuStrecke(gx, gy, ax, ay, bx, by);
        // Ausserhalb des Radius wird nichts angefasst. Die Abfrage ist nicht
        // bloss Abkürzung: Bei Härte 1 fallen `kern` und `radius` zusammen,
        // und `weich` weicht bei gleicher Ober- und Untergrenze auf eine
        // Spanne von 1 aus – der Pinsel bekäme einen Punkt Übergriff.
        if (d >= radius) continue;
        const wert = Math.round((1 - weich(kern, radius, d)) * 255);
        const i = zeile + gx;
        if (strich.abziehen) {
          const neu = 255 - wert;
          if (neu < feld[i]) feld[i] = neu;
        } else if (wert > feld[i]) {
          feld[i] = wert;
        }
      }
    }
  }
}

/* ---------- Netzmaske ---------- */

/**
 * Bringt ein Graustufenfeld auf eine andere Grösse – bilinear, je Achse
 * getrennt.
 *
 * Gebraucht für die Netzmasken: Das Modell löst auf 320 × 320 auf, die Vorlage
 * ist höchstens 1536 Punkte lang, das Maskenraster 1024. Alle drei Zahlen sind
 * verschieden, und keine ist ein Vielfaches der anderen.
 *
 * Gerechnet wird auf Punktmitten (`(i + 0,5) · qb / zb − 0,5`). Ohne die beiden
 * halben Punkte sitzt die Maske um einen halben Zielpunkt daneben, und beim
 * Vergrössern reicht der Fehler bis an den Rand des ersten Quellpunkts – ein
 * freigestelltes Motiv bekäme an einer Seite eine helle Kante.
 */
export function maskeUmrastern(
  alpha: Uint8Array,
  qb: number,
  qh: number,
  zb: number,
  zh: number,
): Uint8Array {
  const ziel = new Uint8Array(zb * zh);
  if (qb <= 0 || qh <= 0 || zb <= 0 || zh <= 0) return ziel;

  // Die Spaltenanteile einmal für alle Zeilen – sie hängen nicht von y ab.
  const sx0 = new Int32Array(zb);
  const sx1 = new Int32Array(zb);
  const stx = new Float64Array(zb);
  for (let i = 0; i < zb; i += 1) {
    const s = klemmen(((i + 0.5) * qb) / zb - 0.5, 0, qb - 1);
    const g = Math.floor(s);
    sx0[i] = g;
    sx1[i] = Math.min(qb - 1, g + 1);
    stx[i] = s - g;
  }

  for (let j = 0; j < zh; j += 1) {
    const s = klemmen(((j + 0.5) * qh) / zh - 0.5, 0, qh - 1);
    const y0 = Math.floor(s);
    const y1 = Math.min(qh - 1, y0 + 1);
    const ty = s - y0;
    const oben = y0 * qb;
    const unten = y1 * qb;
    const zeile = j * zb;
    for (let i = 0; i < zb; i += 1) {
      const tx = stx[i];
      const a = alpha[oben + sx0[i]];
      const b = alpha[oben + sx1[i]];
      const c = alpha[unten + sx0[i]];
      const d = alpha[unten + sx1[i]];
      const o = a + (b - a) * tx;
      const u = c + (d - c) * tx;
      ziel[zeile + i] = Math.round(o + (u - o) * ty);
    }
  }
  return ziel;
}

/* ---------- Teile und Faltung ---------- */

function verlaufFeld(teil: VerlaufTeil, raster: Raster): Uint8Array {
  const feld = new Uint8Array(raster.breite * raster.hoehe);
  const vor = verlaufVorbereiten(teil);
  const { xs, ys } = achsen(raster);
  for (let gy = 0; gy < raster.hoehe; gy += 1) {
    const zeile = gy * raster.breite;
    const y = ys[gy];
    for (let gx = 0; gx < raster.breite; gx += 1) {
      feld[zeile + gx] = Math.round(verlaufGewicht(vor, xs[gx], y) * 255);
    }
  }
  return feld;
}

function radialFeld(teil: RadialTeil, raster: Raster): Uint8Array {
  const feld = new Uint8Array(raster.breite * raster.hoehe);
  const vor = radialVorbereiten(teil);
  const { xs, ys } = achsen(raster);
  for (let gy = 0; gy < raster.hoehe; gy += 1) {
    const zeile = gy * raster.breite;
    const y = ys[gy];
    for (let gx = 0; gx < raster.breite; gx += 1) {
      feld[zeile + gx] = Math.round(radialGewicht(vor, xs[gx], y) * 255);
    }
  }
  return feld;
}

/** Ein einzelner Maskenteil als Rasterfeld, mit `umkehren` schon angewandt. */
export function teilBauen(teil: Maskenteil, raster: Raster): Uint8Array {
  let feld: Uint8Array;
  switch (teil.art) {
    case 'verlauf':
      feld = verlaufFeld(teil, raster);
      break;
    case 'radial':
      feld = radialFeld(teil, raster);
      break;
    case 'pinsel':
      feld = new Uint8Array(raster.breite * raster.hoehe);
      // Ein Radierstrich auf leerem Feld tut nichts – das ist so gewollt: Der
      // Radiergummi wirkt innerhalb SEINES Teils, nicht auf die Teile darunter.
      // Dafür gibt es den Modus `weg`.
      for (const strich of teil.striche) strichStempeln(feld, raster, strich);
      break;
    case 'netz':
      feld = maskeUmrastern(teil.alpha, teil.breite, teil.hoehe, raster.breite, raster.hoehe);
      break;
    case 'tiefe':
      /*
       * Nicht `maskeUmrastern`: Die Karte ist keine Maske, sondern eine
       * Entfernung. Erst muss sie auf das Raster, DANN wird daraus die
       * Unschärfe – umgekehrt würde über den Knick an der Fokusebene
       * gemittelt, und mitten im Verlauf stünde ein scharfer Streifen.
       * `tiefenFeld` macht genau diese Reihenfolge.
       */
      feld = tiefenFeld(
        { breite: teil.breite, hoehe: teil.hoehe, feld: teil.karte },
        teil.fokus,
        teil.spanne,
        raster.breite,
        raster.hoehe,
      );
      break;
  }
  if (teil.umkehren) {
    for (let i = 0; i < feld.length; i += 1) feld[i] = 255 - feld[i];
  }
  return feld;
}

/**
 * Alle Teile eines Bereichs zu einer Maske.
 *
 * Angefangen wird bei NULL, nicht bei 255. Ein Bereich ohne Teile wirkt
 * nirgends – andersherum wirkte er überall, und wer einen neuen Bereich
 * anlegt, hätte das ganze Bild angefasst, bevor er den ersten Griff gezogen
 * hat.
 *
 * Die Reihenfolge ist bedeutsam, weil `weg` und `nur` nur auf das wirken, was
 * VOR ihnen liegt. „Motiv, aber nicht sein Schatten“ ist Motiv dazu, Schatten
 * weg – umgekehrt bleibt vom Abziehen auf leerem Feld nichts übrig.
 */
export function teileFalten(teile: readonly Maskenteil[], raster: Raster): Uint8Array {
  return felderFalten(
    teile,
    teile.map((teil) => teilBauen(teil, raster)),
    raster.breite * raster.hoehe,
  );
}

/**
 * Dieselbe Faltung, aber mit schon gebauten Feldern.
 *
 * Getrennt, weil der Zwischenspeicher (`maskenSpeicher.ts`) die Teilfelder
 * aufhebt und beim Reglerziehen gar nicht neu baut – er braucht die
 * Faltungsvorschrift, nicht das Bauen. Die Vorschrift steht deshalb hier
 * genau einmal; `teileFalten` ist nur noch der Weg für alle, die beides
 * wollen.
 *
 * `laenge` statt `raster`, damit die Funktion nichts über Raster wissen muss.
 */
export function felderFalten(
  teile: readonly Maskenteil[],
  felder: readonly Uint8Array[],
  laenge: number,
): Uint8Array {
  const werk = new Uint8Array(laenge);
  for (const [nummer, teil] of teile.entries()) {
    const g = felder[nummer];
    if (!g) continue;
    switch (teil.modus) {
      case 'dazu':
        for (let i = 0; i < werk.length; i += 1) if (g[i] > werk[i]) werk[i] = g[i];
        break;
      case 'weg':
        for (let i = 0; i < werk.length; i += 1) {
          const neu = 255 - g[i];
          if (neu < werk[i]) werk[i] = neu;
        }
        break;
      case 'nur':
        for (let i = 0; i < werk.length; i += 1) if (g[i] < werk[i]) werk[i] = g[i];
        break;
    }
  }
  return werk;
}

/* ---------- Lesen und Kennungen ---------- */

/**
 * Liest die Maske an einer Stelle, `u`/`v` in 0 … 1.
 *
 * Bilinear auf Punktmitten – dasselbe, was die Grafikeinheit mit einer Textur
 * auf LINEAR tut. Nächster Nachbar wäre hier billiger und auf dem Bildschirm
 * eine Treppe: Bei Faktor 0,256 ist ein Rasterpunkt fast vier Originalpunkte
 * gross.
 */
export function maskeLesen(feld: Uint8Array, raster: Raster, u: number, v: number): number {
  const fx = klemmen(u * raster.breite - 0.5, 0, raster.breite - 1);
  const fy = klemmen(v * raster.hoehe - 0.5, 0, raster.hoehe - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(raster.breite - 1, x0 + 1);
  const y1 = Math.min(raster.hoehe - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const oben = y0 * raster.breite;
  const unten = y1 * raster.breite;
  const o = feld[oben + x0] + (feld[oben + x1] - feld[oben + x0]) * tx;
  const un = feld[unten + x0] + (feld[unten + x1] - feld[unten + x0]) * tx;
  return o + (un - o) * ty;
}

/**
 * Eine Kennung, die sich genau dann ändert, wenn sich die gerasterte Maske
 * ändert.
 *
 * Ein Netzteil geht über seine `marke` ein und NIE über sein `alpha`: Ein
 * `Uint8Array` in einer Zeichenkettenschablone wird klaglos zu
 * `[object Uint8Array]`, und der Zwischenspeicher lieferte danach für jede
 * Netzmaske dieselbe alte Maske zurück – ohne Fehlermeldung, ohne Absturz,
 * einfach mit dem falschen Bild.
 *
 * Beim Pinsel steht die Punktzahl drin und nicht die Punkte selbst: Ein Strich
 * wächst nur am Ende, also reicht die Zahl, um „hat sich etwas getan“ zu
 * beantworten. Breite, Härte und Radiergummi müssen dagegen einzeln hinein –
 * sie ändern das Ergebnis, ohne die Zahl zu bewegen.
 */
export function teilSchluessel(teil: Maskenteil): string {
  const kopf = `${teil.id}|${teil.modus}|${teil.umkehren ? 1 : 0}|${teil.art}`;
  switch (teil.art) {
    case 'verlauf':
      return `${kopf}|${teil.von.x},${teil.von.y},${teil.bis.x},${teil.bis.y}`;
    case 'radial':
      return (
        `${kopf}|${teil.mitte.x},${teil.mitte.y},${teil.rx},${teil.ry}` +
        `,${teil.winkel},${teil.weichheit}`
      );
    case 'pinsel': {
      let punkte = 0;
      let formen = '';
      for (const strich of teil.striche) {
        punkte += strich.punkte.length >> 1;
        formen += `;${strich.breite},${strich.haerte},${strich.abziehen ? 1 : 0}`;
      }
      return `${kopf}|${teil.striche.length}|${punkte}${formen}`;
    }
    case 'netz':
      return `${kopf}|${teil.netz}|${teil.breite}x${teil.hoehe}|${teil.marke}`;
    // Fokus und Spanne MÜSSEN hinein: Sie ändern die Maske, ohne die Karte
    // anzufassen – das ist ja gerade der Sinn des Umwegs über die Entfernung.
    // Die Karte selbst geht wie beim Netzteil nur über die Marke ein.
    case 'tiefe':
      return `${kopf}|${teil.breite}x${teil.hoehe}|${teil.marke}|${teil.fokus},${teil.spanne}`;
  }
}

/**
 * Ob die Maske irgendwo etwas durchlässt.
 *
 * Lohnt sich, weil eine leere Maske den ganzen Bereich überflüssig macht: Kein
 * Hochladen, kein zusätzlicher Durchgang. Und leer ist sie öfter als man denkt
 * – ein Teil `dazu` und derselbe Teil `weg` ist genau das, was beim Probieren
 * herauskommt.
 */
export function maskeTraegtEtwas(feld: Uint8Array): boolean {
  for (let i = 0; i < feld.length; i += 1) if (feld[i] !== 0) return true;
  return false;
}

/*
 * Weltweit steigend, nie zurückgesetzt.
 *
 * Die Ersatzidentität für ein `Uint8Array`: Zwei Netzläufe können dasselbe
 * Ergebnis haben und sind trotzdem zwei Masken. Ein Zähler beantwortet „ist
 * das noch dieselbe?“ richtig, ein Vergleich der Bytes wäre 12 MB teuer und
 * eine Prüfsumme immer noch 12 MB zu lesen.
 */
let markenZaehler = 0;

export function naechsteMarke(): number {
  markenZaehler += 1;
  return markenZaehler;
}
