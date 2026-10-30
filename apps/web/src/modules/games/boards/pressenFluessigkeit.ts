import {
  FELD_BREITE,
  FELD_TIEFE,
  GLAS_ML,
  GLAS_START_X,
  MUND_KAPAZITAET_ML,
  MUND_X,
  MUND_Y,
} from '@initiative/shared';

/**
 * Das Bier als Beiwerk: Füllstand, Schwappen, Schaum, Blasen, Strahl mit
 * Tropfen, Nachlaufen, Pfützen und die Schluckbewegung des Munds.
 *
 * REIN DEKORATIV. Die Spielphysik (`pressen-sim.ts`, bitgleich) bleibt
 * unberührt: Diese Datei LIEST nur, was die Simulation zeigt (`Eingang`), und
 * rechnet daraus Bilder. Nichts davon fließt in Zeit, Verschüttetes oder Wertung
 * zurück – zwei Geräte mit verschiedener Bildrate spielen denselben Lauf.
 *
 * WARUM so gebaut:
 *  - Alles liegt in vorab angelegten Feldern (Float32Array): Ein Bild
 *    allokiert nichts, auch nicht auf einem Handy. Die Zufallszahlen kommen aus
 *    einer eigenen, festen Reihe (kein `Math.random`) – die Darstellung ist
 *    wiederholbar und damit testbar.
 *  - Die Zeichnung (`usePressenAnimation.ts`) schreibt die Ergebnisse direkt in
 *    SVG-Attribute, ohne React-Render und ohne Layout zu lesen.
 *  - `ruhig` = „Bewegung reduzieren“: Der Füllstand springt auf den Wert,
 *    nichts schwappt, es gibt weder Tropfen noch Blasen noch Wellen; Pfützen und
 *    Schaum stehen ruhig da. Die Darstellung bleibt vollständig lesbar.
 */

/** Was die Simulation zeigt – ein Ausschnitt von `SimZustand`. */
export interface Eingang {
  x: number;
  y: number;
  vx: number;
  neigung: number;
  neigungV: number;
  fuellung: number;
  mund: number;
  getrunken: number;
  verschuettet: number;
  fluss: number;
  trifft: boolean;
  landeX: number;
  landeY: number;
  /** Glas steht auf dem Tisch. */
  abgestellt: boolean;
}

export const MAX_TROPFEN = 32;
export const MAX_PFUETZEN = 6;
export const MAX_BLASEN = 5;
export const MAX_RESTE = 6;

/** Ort des abgestellten Glases (wie in der Zeichnung). */
export const ABGESTELLT_X = 800;
export const ABGESTELLT_Y = 470;

/** Tropfenart: Bier oder Schaum (die Farbe setzt die Zeichnung). */
export const BIER_ART = 0;
export const SCHAUM_ART = 1;

const SCHWERKRAFT = 820;
/** Eigenfrequenz des Schwappens (rad/s) und Dämpfung: etwas über 2 Hz, klingt in einer Sekunde ab. */
const OMEGA = 14;
const ZETA = 0.16;
/** Wie viel Grad Oberflächenneigung 1 Einheit/s² seitlicher Beschleunigung ergibt. */
const NEIGUNG_JE_BESCHLEUNIGUNG = 10 / 620;
const NEIGUNG_JE_DREHUNG = 0.07;
const SCHWAPP_MAX = 24;
/** Ab dieser Menge getrunkenes Bier (ml) gibt es einen Schluck. */
const SCHLUCK_ML = 5;
const SCHLUCK_DAUER_S = 0.18;
/** Radius einer Pfütze (Einheiten) aus ihrer Menge (ml). */
const pfuetzenRadius = (ml: number) => Math.min(140, 7 + 7.5 * Math.sqrt(ml));

/** Maße des Glases wie in der Zeichnung (aufrecht und geneigt). */
export interface GlasLage {
  glasX: number;
  glasY: number;
  sinus: number;
  randRy: number;
  bodenY: number;
}

/** Parabel des Strahls: Start, Kontrollpunkt, Landung. */
export interface Strahl {
  sx: number;
  sy: number;
  cx: number;
  cy: number;
  ex: number;
  ey: number;
  breite: number;
}

export function neueGlasLage(): GlasLage {
  return { glasX: 0, glasY: 0, sinus: 0, randRy: 13, bodenY: 56 };
}

export function neuerStrahl(): Strahl {
  return { sx: 0, sy: 0, cx: 0, cy: 0, ex: 0, ey: 0, breite: 0 };
}

/**
 * Wo das Glas steht und wie tief es ist. `sinus` kommt aus einer Tabelle von
 * Hand, nicht aus `Math.sin` je Bild: Die Zeichnung braucht es mehrfach.
 */
export function glasLageInto(aus: GlasLage, a: Eingang): GlasLage {
  const grad = Math.min(100, Math.max(0, a.neigung));
  const sinus = Math.sin((grad * Math.PI) / 180);
  aus.sinus = sinus;
  aus.glasX = a.abgestellt ? ABGESTELLT_X : a.x;
  aus.glasY = a.abgestellt ? ABGESTELLT_Y : a.y;
  aus.randRy = 13 + 14 * sinus;
  aus.bodenY = a.abgestellt ? 74 : 56 + 44 * sinus;
  return aus;
}

export function strahlInto(aus: Strahl, a: Eingang, lage: GlasLage): Strahl {
  aus.sx = lage.glasX;
  aus.sy = lage.glasY - lage.randRy;
  aus.breite = Math.min(15, 2.5 + a.fluss / 7);
  const weite = Math.hypot(a.landeX - aus.sx, a.landeY - aus.sy);
  aus.cx = (aus.sx + a.landeX) / 2;
  aus.cy = Math.min(aus.sy, a.landeY) - (36 + weite * 0.28);
  aus.ex = a.landeX;
  aus.ey = a.landeY;
  return aus;
}

/** Halbe Breite des Glases in Tiefe `f` (0 = Rand, 1 = Boden) – wie der Klippfad der Zeichnung. */
export const wandHalbbreite = (f: number) => 36 - 10 * f;

/**
 * Der Zustand der Dekoration. `schritt(dt, eingang)` rechnet ein Bild weiter,
 * danach liest die Zeichnung die öffentlichen Felder.
 */
export class Fluessigkeit {
  /* ---- Glas ---- */
  /** Angezeigter Füllstand 0 bis 1 (folgt der Füllung weich). */
  niveau = 1;
  /** Neigung der Oberfläche gegen das Glas (Grad) und ihre Geschwindigkeit. */
  schwapp = 0;
  schwappV = 0;
  /** Unruhe der Oberfläche 0 bis 1 und die Phase der Welle. */
  welle = 0;
  wellePhase = 0;
  /** Dicke der Schaumkrone 0 bis 1. */
  schaum = 0;
  /* ---- Mund ---- */
  /** Schluck-Puls 1 → 0 nach jedem Schluck, und der weich nachgeführte Mundinhalt 0 bis 1. */
  puls = 0;
  mundFuell = 0;
  /* ---- Blasen (Anteil der Strecke Boden → Oberfläche) ---- */
  readonly blaseX = new Float32Array(MAX_BLASEN);
  readonly blaseF = new Float32Array(MAX_BLASEN);
  readonly blaseV = new Float32Array(MAX_BLASEN);
  readonly blaseR = new Float32Array(MAX_BLASEN);
  /* ---- Schaumreste an der Glaswand ---- */
  readonly resteSeite = new Float32Array(MAX_RESTE);
  readonly resteF = new Float32Array(MAX_RESTE);
  readonly resteR = new Float32Array(MAX_RESTE);
  private resteAnzahl = 0;
  private resteNaechste = 0;
  /* ---- hängender Tropfen am Rand ---- */
  randR = 0;
  /* ---- Tropfen ---- */
  readonly tropfenX = new Float32Array(MAX_TROPFEN);
  readonly tropfenY = new Float32Array(MAX_TROPFEN);
  readonly tropfenVx = new Float32Array(MAX_TROPFEN);
  readonly tropfenVy = new Float32Array(MAX_TROPFEN);
  readonly tropfenR0 = new Float32Array(MAX_TROPFEN);
  readonly tropfenLeben = new Float32Array(MAX_TROPFEN);
  readonly tropfenDauer = new Float32Array(MAX_TROPFEN);
  readonly tropfenArt = new Uint8Array(MAX_TROPFEN);
  /** Aktueller Radius je Tropfen (0 = unsichtbar) – das liest die Zeichnung. */
  readonly tropfenR = new Float32Array(MAX_TROPFEN);
  /* ---- Pfützen ---- */
  readonly pfuetzeX = new Float32Array(MAX_PFUETZEN);
  readonly pfuetzeY = new Float32Array(MAX_PFUETZEN);
  readonly pfuetzeMl = new Float32Array(MAX_PFUETZEN);
  /** Angezeigter Radius, wächst weich auf `pfuetzenRadius(ml)`. */
  readonly pfuetzeR = new Float32Array(MAX_PFUETZEN);
  pfuetzenAnzahl = 0;

  /* ---- Gedächtnis zwischen den Bildern ---- */
  private bekannt = false;
  private fuellungAlt = GLAS_ML;
  private verschuettetAlt = 0;
  private getrunkenAlt = 0;
  private vxAlt = 0;
  private neigungVAlt = 0;
  private schluckRest = 0;
  private seed = 20_240_611;
  private akkuStrahl = 0;
  private akkuLandung = 0;
  private akkuMund = 0;
  private akkuUeberlauf = 0;
  private akkuRand = 0;
  private akkuTisch = 0;
  private resteZeit = 0;
  private randTropfenZahl = 0;
  private nachlaufen = false;
  private beweglich = false;
  private readonly lage = neueGlasLage();
  private readonly strahl = neuerStrahl();
  private zielNiveau = 1;
  private zielSchaum = 0;

  constructor(readonly ruhig: boolean) {}

  /** Gleichmäßige Zufallszahl 0 bis 1 aus einer festen Reihe (LCG). */
  private zufall(): number {
    this.seed = (Math.imul(this.seed, 1_664_525) + 1_013_904_223) >>> 0;
    return this.seed / 4_294_967_296;
  }

  private spanne(von: number, bis: number): number {
    return von + (bis - von) * this.zufall();
  }

  /** Alles auf Anfang für diesen Eingang (neuer Lauf oder erste Anzeige). */
  zuruecksetzen(a: Eingang): void {
    this.bekannt = true;
    this.seed = 20_240_611;
    this.niveau = this.zielNiveau = Math.min(1, Math.max(0, a.fuellung / GLAS_ML));
    this.schwapp = this.schwappV = this.welle = this.wellePhase = 0;
    this.zielSchaum = a.fuellung > 0 ? 0.3 : 0;
    this.schaum = this.zielSchaum;
    this.puls = 0;
    this.mundFuell = Math.min(1, a.mund / MUND_KAPAZITAET_ML);
    this.tropfenLeben.fill(0);
    this.tropfenR.fill(0);
    this.pfuetzenAnzahl = 0;
    this.pfuetzeMl.fill(0);
    this.pfuetzeR.fill(0);
    this.resteAnzahl = 0;
    this.resteNaechste = 0;
    this.resteR.fill(0);
    this.randR = 0;
    this.randTropfenZahl = 0;
    this.nachlaufen = false;
    this.akkuStrahl = this.akkuLandung = this.akkuMund = 0;
    this.akkuUeberlauf = this.akkuRand = this.akkuTisch = this.resteZeit = 0;
    this.schluckRest = 0;
    this.fuellungAlt = a.fuellung;
    this.verschuettetAlt = a.verschuettet;
    this.getrunkenAlt = a.getrunken;
    this.vxAlt = a.vx;
    this.neigungVAlt = a.neigungV;
    for (let i = 0; i < MAX_BLASEN; i += 1) this.blaseNeu(i, this.zufall());
    // Ein leeres Glas, das nicht gerade geleert wurde (Ansicht eines fertigen Laufs):
    // Es bleiben Schaumreste an der Wand.
    if (a.fuellung <= 0) {
      for (let i = 0; i < 4; i += 1) this.resteDazu(0.18 + 0.2 * i, i % 2 ? 1 : -1, 2.4 + (i % 2));
    }
    // Verschüttetes, das schon da war (fremder oder früherer Lauf): als Pfütze ohne Wachsen.
    if (a.verschuettet > 0.2) {
      this.pfuetzeDazu(FELD_BREITE / 2 - 40, FELD_TIEFE - 150, a.verschuettet);
      this.pfuetzeR[0] = pfuetzenRadius(this.pfuetzeMl[0]!);
    }
  }

  private blaseNeu(i: number, f: number): void {
    this.blaseX[i] = this.spanne(-19, 19);
    this.blaseF[i] = f;
    this.blaseV[i] = this.spanne(0.3, 0.7);
    this.blaseR[i] = this.spanne(1.3, 2.7);
  }

  private resteDazu(f: number, seite: number, r: number): void {
    const i = this.resteNaechste;
    this.resteSeite[i] = seite;
    this.resteF[i] = f;
    this.resteR[i] = r;
    this.resteNaechste = (i + 1) % MAX_RESTE;
    this.resteAnzahl = Math.min(MAX_RESTE, this.resteAnzahl + 1);
  }

  private tropfenDazu(
    art: number,
    x: number,
    y: number,
    vx: number,
    vy: number,
    r: number,
    leben: number,
  ): void {
    for (let i = 0; i < MAX_TROPFEN; i += 1) {
      if (this.tropfenLeben[i]! > 0) continue;
      this.tropfenArt[i] = art;
      this.tropfenX[i] = x;
      this.tropfenY[i] = y;
      this.tropfenVx[i] = vx;
      this.tropfenVy[i] = vy;
      this.tropfenR0[i] = r;
      this.tropfenLeben[i] = leben;
      this.tropfenDauer[i] = leben;
      this.tropfenR[i] = r;
      return;
    }
  }

  /** Menge `ml` bei `(x, y)` auf den Tisch: zu einer Pfütze in der Nähe oder eine neue. */
  private pfuetzeDazu(x: number, y: number, ml: number): void {
    let naechste = -1;
    let abstand = 70 * 70;
    for (let i = 0; i < this.pfuetzenAnzahl; i += 1) {
      const dx = this.pfuetzeX[i]! - x;
      const dy = (this.pfuetzeY[i]! - y) * 1.6;
      const d = dx * dx + dy * dy;
      if (d < abstand) {
        abstand = d;
        naechste = i;
      }
    }
    if (naechste < 0 && this.pfuetzenAnzahl < MAX_PFUETZEN) {
      naechste = this.pfuetzenAnzahl;
      this.pfuetzenAnzahl += 1;
      this.pfuetzeX[naechste] = x;
      this.pfuetzeY[naechste] = y;
      this.pfuetzeMl[naechste] = 0;
      this.pfuetzeR[naechste] = 0;
    } else if (naechste < 0) {
      // Voll: zur nächstgelegenen schlagen, auch wenn sie weiter weg liegt.
      let best = Infinity;
      for (let i = 0; i < this.pfuetzenAnzahl; i += 1) {
        const d = Math.hypot(this.pfuetzeX[i]! - x, this.pfuetzeY[i]! - y);
        if (d < best) {
          best = d;
          naechste = i;
        }
      }
    }
    const alt = this.pfuetzeMl[naechste]!;
    const gewicht = ml / (alt + ml);
    this.pfuetzeX[naechste] = this.pfuetzeX[naechste]! + (x - this.pfuetzeX[naechste]!) * gewicht;
    this.pfuetzeY[naechste] = this.pfuetzeY[naechste]! + (y - this.pfuetzeY[naechste]!) * gewicht;
    this.pfuetzeMl[naechste] = alt + ml;
  }

  /** Läuft noch etwas, das ein weiteres Bild braucht? Sonst darf die Schleife ruhen. */
  unruhig(): boolean {
    if (this.ruhig) return false;
    if (this.beweglich || this.nachlaufen) return true;
    if (Math.abs(this.schwapp) > 0.05 || Math.abs(this.schwappV) > 0.5 || this.welle > 0.01) {
      return true;
    }
    if (this.puls > 0.002) return true;
    if (Math.abs(this.niveau - this.zielNiveau) > 0.0006) return true;
    if (Math.abs(this.schaum - this.zielSchaum) > 0.003) return true;
    for (let i = 0; i < MAX_TROPFEN; i += 1) if (this.tropfenLeben[i]! > 0) return true;
    for (let i = 0; i < this.pfuetzenAnzahl; i += 1) {
      if (Math.abs(this.pfuetzeR[i]! - pfuetzenRadius(this.pfuetzeMl[i]!)) > 0.15) return true;
    }
    return false;
  }

  /** Ein Bild weiter. `dt` in Sekunden (wird auf 50 ms gedeckelt). */
  schritt(dtRoh: number, a: Eingang): void {
    const dt = Math.min(0.05, Math.max(0, dtRoh));
    // Neuer Lauf (das Glas ist wieder voll, das Verschüttete weg) oder erste Anzeige.
    if (
      !this.bekannt ||
      a.fuellung > this.fuellungAlt + 1 ||
      a.verschuettet < this.verschuettetAlt - 0.01 ||
      a.getrunken < this.getrunkenAlt - 0.01
    ) {
      this.zuruecksetzen(a);
    }
    glasLageInto(this.lage, a);
    this.zielNiveau = Math.min(1, Math.max(0, a.fuellung / GLAS_ML));
    this.zielSchaum = a.fuellung > 0 ? 0.3 : 0;
    const dVerschuettet = Math.max(0, a.verschuettet - this.verschuettetAlt);
    const dGetrunken = Math.max(0, a.getrunken - this.getrunkenAlt);

    if (this.ruhig) {
      this.schrittRuhig(a, dVerschuettet);
      return;
    }

    /* ---- Füllstand folgt weich ---- */
    const folgen = 1 - Math.exp(-dt / 0.08);
    this.niveau += (this.zielNiveau - this.niveau) * folgen;
    if (Math.abs(this.niveau - this.zielNiveau) < 0.0004) this.niveau = this.zielNiveau;

    /* ---- Schwappen: Federschwinger, angestoßen von Beschleunigung und Drehung ---- */
    this.schwappV += NEIGUNG_JE_BESCHLEUNIGUNG * OMEGA * OMEGA * (a.vx - this.vxAlt);
    this.schwappV += NEIGUNG_JE_DREHUNG * OMEGA * OMEGA * 0.1 * (a.neigungV - this.neigungVAlt);
    this.vxAlt = a.vx;
    this.neigungVAlt = a.neigungV;
    this.schwappV += (-OMEGA * OMEGA * this.schwapp - 2 * ZETA * OMEGA * this.schwappV) * dt;
    this.schwapp += this.schwappV * dt;
    if (this.schwapp > SCHWAPP_MAX) {
      this.schwapp = SCHWAPP_MAX;
      this.schwappV = Math.min(0, this.schwappV);
    } else if (this.schwapp < -SCHWAPP_MAX) {
      this.schwapp = -SCHWAPP_MAX;
      this.schwappV = Math.max(0, this.schwappV);
    }
    if (Math.abs(this.schwapp) < 0.02 && Math.abs(this.schwappV) < 0.3) {
      this.schwapp = this.schwappV = 0;
    }

    /* ---- Welle: stärker beim Gießen und Schwappen, klingt langsamer ab ---- */
    const welleZiel = Math.min(1, Math.abs(this.schwappV) / 90 + (a.fluss > 0 ? a.fluss / 55 : 0));
    this.welle +=
      (welleZiel - this.welle) * (1 - Math.exp(-dt / (welleZiel > this.welle ? 0.05 : 0.5)));
    if (this.welle < 0.005 && welleZiel === 0) this.welle = 0;
    this.wellePhase += dt * (14 + 10 * this.welle);

    /* ---- Schaum: wächst beim Gießen, setzt sich ab ---- */
    if (a.fluss > 0) this.schaum = Math.min(1, this.schaum + dt * (0.4 + a.fluss / 35));
    if (this.schaum > this.zielSchaum) {
      this.schaum = Math.max(this.zielSchaum, this.schaum - dt * (a.fuellung > 0 ? 0.14 : 0.6));
    } else if (this.schaum < this.zielSchaum) {
      this.schaum = Math.min(this.zielSchaum, this.schaum + dt * 0.5);
    }

    /* ---- Beweglich? Solange das Glas „im Spiel“ ist, steigen Blasen ---- */
    this.beweglich =
      this.niveau > 0.05 &&
      (a.fluss > 0 ||
        a.neigung > 0.5 ||
        a.getrunken > 0 ||
        a.verschuettet > 0 ||
        a.x !== GLAS_START_X);
    if (this.beweglich && this.niveau > 0.05) {
      for (let i = 0; i < MAX_BLASEN; i += 1) {
        this.blaseF[i] = this.blaseF[i]! + this.blaseV[i]! * dt;
        if (this.blaseF[i]! >= 1) this.blaseNeu(i, 0);
      }
    }

    /* ---- Schaumreste an der Wand, solange der Pegel sinkt ---- */
    if (a.fluss > 0) {
      this.resteZeit += dt;
      if (this.resteZeit > 0.2) {
        this.resteZeit = 0;
        this.resteDazu(
          Math.max(0.02, 1 - this.niveau),
          this.zufall() < 0.5 ? -1 : 1,
          this.spanne(2.2, 4.4),
        );
      }
    }
    for (let i = 0; i < this.resteAnzahl; i += 1) {
      this.resteF[i] = Math.min(0.97, this.resteF[i]! + 0.012 * dt);
      this.resteR[i] = Math.max(1.2, this.resteR[i]! - 0.12 * dt);
    }

    /* ---- Strahl: Tropfen am Strang, Spritzer bei der Landung ---- */
    const imSpiel = a.fluss > 0 && !a.abgestellt;
    if (imSpiel) {
      strahlInto(this.strahl, a, this.lage);
      const s = this.strahl;
      // Je dünner der Strahl, desto mehr löst er sich in einzelne Tropfen auf.
      const duenn = 1 - Math.min(1, a.fluss / 24);
      this.akkuStrahl += (5 + a.fluss * 0.6 + duenn * 10) * dt;
      while (this.akkuStrahl >= 1) {
        this.akkuStrahl -= 1;
        const t = this.spanne(0.2, 0.95);
        const u = 1 - t;
        this.tropfenDazu(
          BIER_ART,
          u * u * s.sx + 2 * u * t * s.cx + t * t * s.ex,
          u * u * s.sy + 2 * u * t * s.cy + t * t * s.ey,
          this.spanne(-55, 55),
          this.spanne(-45, 35),
          (1.4 + this.zufall() * 2) * (0.55 + 0.45 * Math.min(1, a.fluss / 14)),
          this.spanne(0.3, 0.55),
        );
      }
      if (a.trifft) {
        // Schaumspritzer am Mund.
        this.akkuMund += (6 + a.fluss * 0.5) * dt;
        while (this.akkuMund >= 1) {
          this.akkuMund -= 1;
          this.tropfenDazu(
            SCHAUM_ART,
            a.landeX + this.spanne(-22, 22),
            a.landeY + this.spanne(-8, 8),
            this.spanne(-70, 70),
            this.spanne(-130, -45),
            this.spanne(1.5, 3.1),
            this.spanne(0.3, 0.5),
          );
        }
      } else {
        // Es geht daneben: Bier spritzt vom Tisch hoch.
        this.akkuLandung += (9 + a.fluss * 0.9) * dt;
        while (this.akkuLandung >= 1) {
          this.akkuLandung -= 1;
          this.tropfenDazu(
            BIER_ART,
            a.landeX + this.spanne(-14, 14),
            a.landeY + this.spanne(-5, 5),
            this.spanne(-160, 160),
            this.spanne(-230, -80),
            this.spanne(2, 4.4),
            this.spanne(0.45, 0.8),
          );
        }
      }
    }

    /* ---- Mund läuft über ---- */
    if (a.mund > MUND_KAPAZITAET_ML * 0.92) {
      this.akkuUeberlauf += 9 * dt;
      while (this.akkuUeberlauf >= 1) {
        this.akkuUeberlauf -= 1;
        this.tropfenDazu(
          BIER_ART,
          MUND_X + this.spanne(-42, 42),
          MUND_Y + 40,
          this.spanne(-14, 14),
          this.spanne(25, 70),
          this.spanne(2.4, 4),
          this.spanne(0.7, 1),
        );
      }
    }

    /* ---- Nachlaufen: nach dem letzten Strahl hängen Tropfen am Rand ---- */
    this.nachlaufen =
      a.fuellung <= 0 && !a.abgestellt && a.neigung > 12 && this.randTropfenZahl < 5;
    if (this.nachlaufen) {
      this.randR += dt * 10; // wächst in 0,4 s auf 4
      if (this.randR >= 4) {
        this.randR = 0;
        this.randTropfenZahl += 1;
        this.tropfenDazu(
          BIER_ART,
          this.lage.glasX + 8,
          this.lage.glasY - this.lage.randRy + 3,
          this.spanne(-6, 12),
          this.spanne(10, 40),
          3.6,
          0.55,
        );
      }
    } else if (a.fuellung > 0 || a.abgestellt) {
      this.randR = 0;
    }

    /* ---- Schluck: nach jeweils SCHLUCK_ML getrunkenem Bier ein Puls ---- */
    this.schluckRest += dGetrunken;
    while (this.schluckRest >= SCHLUCK_ML) {
      this.schluckRest -= SCHLUCK_ML;
      this.puls = 1;
    }
    this.puls = Math.max(0, this.puls - dt / SCHLUCK_DAUER_S);
    this.mundFuell +=
      (Math.min(1, a.mund / MUND_KAPAZITAET_ML) - this.mundFuell) * (1 - Math.exp(-dt / 0.06));

    /* ---- Verschüttetes wird zur Pfütze, wo es landete ---- */
    if (dVerschuettet > 0) {
      if (imSpiel && !a.trifft) {
        this.pfuetzeDazu(
          Math.min(FELD_BREITE - 40, Math.max(40, a.landeX)),
          Math.min(FELD_TIEFE - 30, Math.max(40, a.landeY)),
          dVerschuettet,
        );
      } else if (imSpiel || a.mund > MUND_KAPAZITAET_ML - 0.5) {
        // Der Mund war voll: Es läuft am Kinn herunter auf den Tisch davor.
        this.pfuetzeDazu(MUND_X + this.spanne(-40, 40), MUND_Y + 140, dVerschuettet);
      } else {
        // Vorzeitig abgestellt: der Rest läuft am Glas aus.
        this.pfuetzeDazu(
          this.lage.glasX,
          Math.min(FELD_TIEFE - 40, this.lage.glasY + 40),
          dVerschuettet,
        );
      }
    }
    for (let i = 0; i < this.pfuetzenAnzahl; i += 1) {
      const ziel = pfuetzenRadius(this.pfuetzeMl[i]!);
      this.pfuetzeR[i] =
        this.pfuetzeR[i]! + (ziel - this.pfuetzeR[i]!) * (1 - Math.exp(-dt / 0.25));
      // Eine große Pfütze nahe der Tischkante tropft hinunter.
      if (this.pfuetzeMl[i]! > 8 && this.pfuetzeY[i]! > FELD_TIEFE - 120) {
        this.akkuTisch += 0.9 * dt;
        if (this.akkuTisch >= 1) {
          this.akkuTisch = 0;
          this.tropfenDazu(
            BIER_ART,
            this.pfuetzeX[i]! + this.spanne(-30, 30),
            this.pfuetzeY[i]! + this.pfuetzeR[i]! * 0.5,
            0,
            this.spanne(20, 50),
            3.2,
            0.9,
          );
        }
      }
    }

    /* ---- Tropfen fliegen ---- */
    for (let i = 0; i < MAX_TROPFEN; i += 1) {
      const leben = this.tropfenLeben[i]!;
      if (leben <= 0) continue;
      const rest = leben - dt;
      if (rest <= 0) {
        this.tropfenLeben[i] = 0;
        this.tropfenR[i] = 0;
        continue;
      }
      this.tropfenLeben[i] = rest;
      this.tropfenVy[i] = this.tropfenVy[i]! + SCHWERKRAFT * dt;
      this.tropfenX[i] = this.tropfenX[i]! + this.tropfenVx[i]! * dt;
      this.tropfenY[i] = this.tropfenY[i]! + this.tropfenVy[i]! * dt;
      // Zum Ende hin schrumpfen (ersetzt das Ausblenden, ohne Zeichenketten je Bild).
      this.tropfenR[i] = this.tropfenR0[i]! * Math.sqrt(rest / this.tropfenDauer[i]!);
    }
    this.fuellungAlt = a.fuellung;
    this.verschuettetAlt = a.verschuettet;
    this.getrunkenAlt = a.getrunken;
  }

  /** „Bewegung reduzieren“: derselbe Zustand, aber ohne Dynamik. */
  private schrittRuhig(a: Eingang, dVerschuettet: number): void {
    this.niveau = this.zielNiveau;
    this.schwapp = this.schwappV = this.welle = 0;
    this.schaum = this.zielSchaum;
    this.puls = 0;
    this.randR = 0;
    this.mundFuell = Math.min(1, a.mund / MUND_KAPAZITAET_ML);
    if (dVerschuettet > 0) {
      const imSpiel = a.fluss > 0 && !a.abgestellt;
      this.pfuetzeDazu(
        imSpiel && !a.trifft ? Math.min(FELD_BREITE - 40, Math.max(40, a.landeX)) : MUND_X,
        imSpiel && !a.trifft ? Math.min(FELD_TIEFE - 30, Math.max(40, a.landeY)) : MUND_Y + 140,
        dVerschuettet,
      );
    }
    for (let i = 0; i < this.pfuetzenAnzahl; i += 1) {
      this.pfuetzeR[i] = pfuetzenRadius(this.pfuetzeMl[i]!);
    }
    // Ein leeres Glas behält seine Schaumreste, ein Glas im Spiel hat keine.
    if (a.fuellung <= 0 && this.resteAnzahl === 0) {
      for (let i = 0; i < 4; i += 1) this.resteDazu(0.18 + 0.2 * i, i % 2 ? 1 : -1, 2.4 + (i % 2));
    }
    this.fuellungAlt = a.fuellung;
    this.verschuettetAlt = a.verschuettet;
    this.getrunkenAlt = a.getrunken;
    this.vxAlt = a.vx;
    this.neigungVAlt = a.neigungV;
  }

  /** Anzahl sichtbarer Schaumreste (die Zeichnung blendet den Rest aus). */
  get reste(): number {
    return this.resteAnzahl;
  }
}
