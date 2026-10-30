import { useLayoutEffect, useRef, type MutableRefObject } from 'react';
import { MUND_HALB_X, MUND_HALB_Y } from '@initiative/shared';
import {
  BIER_ART,
  Fluessigkeit,
  MAX_BLASEN,
  MAX_PFUETZEN,
  MAX_RESTE,
  MAX_TROPFEN,
  glasLageInto,
  neueGlasLage,
  wandHalbbreite,
  type Eingang,
} from './pressenFluessigkeit.js';

/**
 * Bringt die Dekoration (`pressenFluessigkeit.ts`) auf den Bildschirm.
 *
 * Die Zeichnung (`PressenFigur.tsx`) legt die SVG-Elemente einmal an und gibt
 * sie hierher; ab dann schreibt eine eigene Schleife (`requestAnimationFrame`)
 * die Zahlen direkt in deren Attribute. Das Brett wird dafür NICHT neu
 * gerendert, und es wird nie Layout gelesen (kein `getBoundingClientRect`):
 * Es gibt keinen Layout-Thrash.
 *
 * Keine Allokation je Bild: Zahlen gehen über `SVGAnimatedLength.baseVal.value`
 * und `SVGTransform.setRotate/setTranslate` (keine Zeichenketten); ein
 * Zwischenspeicher lässt unveränderte Werte aus. Die einzigen Zeichenketten
 * entstehen, wenn ein Tropfen seine Art wechselt oder die Wangenfarbe merklich
 * kräftiger wird – selten.
 *
 * Die Schleife läuft nur, solange etwas in Bewegung ist (`unruhig`); danach
 * ruht sie, bis ein neuer Stand der Simulation sie weckt. Sie hängt an keiner
 * Uhr des Spiels – bei „Bewegung reduzieren“ rechnet sie nur einmal je Stand.
 */

export interface AnimationsElemente {
  glasWelle: SVGGElement | null;
  fluessig: SVGRectElement | null;
  schaum: SVGRectElement | null;
  oberflaeche: SVGEllipseElement | null;
  blasen: (SVGCircleElement | null)[];
  reste: (SVGCircleElement | null)[];
  randTropfen: SVGCircleElement | null;
  tropfen: (SVGCircleElement | null)[];
  /** Je Pfütze zwei Ellipsen: Hauptfläche (2·i) und Ausläufer (2·i + 1). */
  pfuetzen: (SVGEllipseElement | null)[];
  kehle: SVGGElement | null;
  wangeL: SVGEllipseElement | null;
  wangeR: SVGEllipseElement | null;
  mundBier: SVGEllipseElement | null;
}

export function neueElemente(): AnimationsElemente {
  return {
    glasWelle: null,
    fluessig: null,
    schaum: null,
    oberflaeche: null,
    blasen: new Array<SVGCircleElement | null>(MAX_BLASEN).fill(null),
    reste: new Array<SVGCircleElement | null>(MAX_RESTE).fill(null),
    randTropfen: null,
    tropfen: new Array<SVGCircleElement | null>(MAX_TROPFEN).fill(null),
    pfuetzen: new Array<SVGEllipseElement | null>(MAX_PFUETZEN * 2).fill(null),
    kehle: null,
    wangeL: null,
    wangeR: null,
    mundBier: null,
  };
}

const SCHAUM_FARBE = '#fff3c4';
const BIER_FARBE = '#e8a317';

type Laenge = 'cx' | 'cy' | 'r' | 'rx' | 'ry' | 'x' | 'y' | 'width' | 'height';

/** Setzt ein Längenattribut ohne Zeichenkette (im Test-DOM ohne SVG-Schnittstelle mit Attribut). */
function schreibe(el: SVGElement, name: Laenge, wert: number): void {
  const anim = (el as unknown as Record<string, SVGAnimatedLength | undefined>)[name];
  if (anim?.baseVal) anim.baseVal.value = wert;
  else el.setAttribute(name, String(wert));
}

/** Dreht oder verschiebt über die erste Transformation des Elements (zuvor im JSX angelegt). */
function transformiere(
  el: SVGGraphicsElement,
  art: 'drehen' | 'schieben',
  a: number,
  b: number,
  c: number,
): void {
  const liste = el.transform?.baseVal;
  const t = liste?.numberOfItems ? liste.getItem(0) : null;
  if (!t) {
    el.setAttribute(
      'transform',
      art === 'drehen' ? `rotate(${a} ${b} ${c})` : `translate(${a} ${b})`,
    );
    return;
  }
  if (art === 'drehen') t.setRotate(a, b, c);
  else t.setTranslate(a, b);
}

class Treiber {
  readonly sim: Fluessigkeit;
  private bild = 0;
  private zeit = 0;
  private beendet = false;
  private readonly lage = neueGlasLage();
  /** Zuletzt geschriebene Werte, damit Unverändertes nicht erneut ins DOM geht. */
  private readonly speicher = new Float32Array(1024).fill(Number.NaN);
  private readonly tropfenArt = new Uint8Array(MAX_TROPFEN).fill(255);
  private wangenFarbe = -1;
  private slot = 0;

  constructor(
    private readonly el: AnimationsElemente,
    private readonly eingang: MutableRefObject<Eingang>,
    ruhig: boolean,
  ) {
    this.sim = new Fluessigkeit(ruhig);
  }

  /** Schreibt `wert`, wenn er sich merklich geändert hat. */
  private w(el: SVGElement | null, name: Laenge, wert: number): void {
    const i = this.slot;
    this.slot += 1;
    if (!el) return;
    if (Math.abs(this.speicher[i]! - wert) < 0.004) return;
    this.speicher[i] = wert;
    schreibe(el, name, wert);
  }

  /** Wie `w`, aber für eine Drehung/Verschiebung mit zwei bis drei Werten. */
  private t(
    el: SVGGraphicsElement | null,
    art: 'drehen' | 'schieben',
    a: number,
    b: number,
    c: number,
  ): void {
    const i = this.slot;
    this.slot += 3;
    if (!el) return;
    if (
      Math.abs(this.speicher[i]! - a) < 0.004 &&
      Math.abs(this.speicher[i + 1]! - b) < 0.004 &&
      Math.abs(this.speicher[i + 2]! - c) < 0.004
    ) {
      return;
    }
    this.speicher[i] = a;
    this.speicher[i + 1] = b;
    this.speicher[i + 2] = c;
    transformiere(el, art, a, b, c);
  }

  /** Rechnet und zeichnet; `sofort`: noch vor dem ersten Bild (kein Aufblitzen). */
  wecken(sofort: boolean): void {
    if (this.beendet) return;
    if (this.sim.ruhig) {
      this.sim.schritt(0, this.eingang.current);
      this.zeichne();
      return;
    }
    if (sofort) {
      this.sim.schritt(0.016, this.eingang.current);
      this.zeichne();
    }
    if (!this.bild) {
      this.zeit = performance.now();
      this.bild = requestAnimationFrame(this.takt);
    }
  }

  private takt = (jetzt: number): void => {
    this.bild = 0;
    if (this.beendet) return;
    const dt = (jetzt - this.zeit) / 1000;
    this.zeit = jetzt;
    this.sim.schritt(dt, this.eingang.current);
    this.zeichne();
    if (this.sim.unruhig()) this.bild = requestAnimationFrame(this.takt);
  };

  beenden(): void {
    this.beendet = true;
    if (this.bild) cancelAnimationFrame(this.bild);
    this.bild = 0;
  }

  private zeichne(): void {
    const { sim, el, lage } = this;
    const a = this.eingang.current;
    glasLageInto(lage, a);
    this.slot = 0;

    /* ---- Glas: Pegel, Schwappen, Schaum ---- */
    const boden = lage.bodenY;
    const pegel = boden * (1 - sim.niveau);
    const hatBier = sim.niveau > 0.003;
    this.t(el.glasWelle, 'drehen', sim.schwapp, 0, pegel);
    this.w(el.fluessig, 'y', pegel);
    this.w(el.fluessig, 'height', hatBier ? boden + 8 - pegel : 0);
    const welle = Math.sin(sim.wellePhase) * sim.welle * 1.7;
    const schaumHoehe = hatBier ? 2.5 + 9 * sim.schaum : 0;
    this.w(el.schaum, 'y', pegel - schaumHoehe - welle);
    this.w(el.schaum, 'height', hatBier ? schaumHoehe + welle + 1 : 0);
    this.w(el.oberflaeche, 'cy', pegel - schaumHoehe - welle);
    this.w(
      el.oberflaeche,
      'ry',
      hatBier
        ? 2 + 6 * lage.sinus + sim.welle * 2.2 * (0.5 + 0.5 * Math.sin(sim.wellePhase * 1.7))
        : 0,
    );

    for (let i = 0; i < MAX_BLASEN; i += 1) {
      const sichtbar = !sim.ruhig && sim.niveau > 0.05;
      const f = sim.blaseF[i]!;
      this.w(el.blasen[i]!, 'cx', sim.blaseX[i]!);
      this.w(el.blasen[i]!, 'cy', boden - f * (boden - pegel));
      this.w(el.blasen[i]!, 'r', sichtbar ? sim.blaseR[i]! * (1 - 0.3 * f) : 0);
    }
    for (let i = 0; i < MAX_RESTE; i += 1) {
      const f = sim.resteF[i]!;
      const hoehe = f * boden;
      // Nur über dem Pegel: Im Bier sähe man sie nicht.
      const sichtbar = i < sim.reste && hoehe < pegel - 1;
      const r = sim.resteR[i]!;
      this.w(el.reste[i]!, 'cx', sim.resteSeite[i]! * (wandHalbbreite(f) - r * 0.5));
      this.w(el.reste[i]!, 'cy', hoehe);
      this.w(el.reste[i]!, 'r', sichtbar ? r : 0);
    }
    this.w(el.randTropfen, 'cy', -lage.randRy + 3);
    this.w(el.randTropfen, 'r', sim.randR);

    /* ---- Tropfen ---- */
    for (let i = 0; i < MAX_TROPFEN; i += 1) {
      const kreis = el.tropfen[i]!;
      const r = sim.tropfenR[i]!;
      this.w(kreis, 'r', r);
      if (r <= 0) continue;
      this.w(kreis, 'cx', sim.tropfenX[i]!);
      this.w(kreis, 'cy', sim.tropfenY[i]!);
      const art = sim.tropfenArt[i]!;
      if (kreis && this.tropfenArt[i] !== art) {
        this.tropfenArt[i] = art;
        kreis.setAttribute('fill', art === BIER_ART ? BIER_FARBE : SCHAUM_FARBE);
      }
    }

    /* ---- Pfützen ---- */
    for (let i = 0; i < MAX_PFUETZEN; i += 1) {
      const da = i < sim.pfuetzenAnzahl;
      const r = da ? sim.pfuetzeR[i]! : 0;
      const x = sim.pfuetzeX[i]!;
      const y = sim.pfuetzeY[i]!;
      const seite = i % 2 === 0 ? 1 : -1;
      this.w(el.pfuetzen[2 * i]!, 'cx', x);
      this.w(el.pfuetzen[2 * i]!, 'cy', y);
      this.w(el.pfuetzen[2 * i]!, 'rx', r);
      this.w(el.pfuetzen[2 * i]!, 'ry', r * 0.55);
      this.w(el.pfuetzen[2 * i + 1]!, 'cx', x + seite * r * 0.5);
      this.w(el.pfuetzen[2 * i + 1]!, 'cy', y + r * 0.14);
      this.w(el.pfuetzen[2 * i + 1]!, 'rx', r * 0.6);
      this.w(el.pfuetzen[2 * i + 1]!, 'ry', r * 0.34);
    }

    /* ---- Mund: Schluck, Wangen, Inhalt ---- */
    const bump = sim.puls > 0 ? Math.sin(sim.puls * Math.PI) : 0;
    this.t(el.kehle, 'schieben', 0, 14 * bump, 0);
    const voll = sim.mundFuell;
    this.w(el.wangeL, 'rx', 14 + 12 * voll + 3 * bump);
    this.w(el.wangeL, 'ry', 11 + 9 * voll + 2 * bump);
    this.w(el.wangeR, 'rx', 14 + 12 * voll + 3 * bump);
    this.w(el.wangeR, 'ry', 11 + 9 * voll + 2 * bump);
    this.w(el.mundBier, 'rx', MUND_HALB_X * voll * (1 + 0.1 * bump));
    this.w(el.mundBier, 'ry', MUND_HALB_Y * voll * (1 + 0.1 * bump));
    // Die Wangen röten sich mit dem Mundinhalt (in 5-%-Schritten, damit selten ein Text entsteht).
    const stufe = Math.round((0.25 + 0.4 * voll) * 20);
    if (stufe !== this.wangenFarbe) {
      this.wangenFarbe = stufe;
      const deckkraft = String(stufe / 20);
      if (el.wangeL) el.wangeL.style.opacity = deckkraft;
      if (el.wangeR) el.wangeR.style.opacity = deckkraft;
    }
  }
}

/**
 * Hängt die Animation an eine Figur. Gibt die Elemente zurück, an die die
 * Zeichnung ihre `ref`s hängt; `ruhig` = keine Dynamik (Bewegung reduziert,
 * oder eine Figur, die nur zusieht).
 */
export function usePressenAnimation(eingang: Eingang, ruhig: boolean): AnimationsElemente {
  const elemente = useRef(neueElemente()).current;
  const aktuell = useRef(eingang);
  aktuell.current = eingang;
  const treiber = useRef<Treiber | null>(null);

  useLayoutEffect(() => {
    const neu = new Treiber(elemente, aktuell, ruhig);
    treiber.current = neu;
    neu.wecken(true);
    return () => {
      neu.beenden();
      treiber.current = null;
    };
  }, [elemente, ruhig]);

  // Jeder neue Stand der Simulation weckt die Schleife, falls sie ruht.
  useLayoutEffect(() => {
    treiber.current?.wecken(false);
  });

  return elemente;
}

/** Nur für die Zeichnung: Standardlage zum Berechnen von Maßen. */
export { glasLageInto, neueGlasLage };
