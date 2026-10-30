import { describe, expect, it } from 'vitest';
import { GLAS_ML, MUND_X, MUND_Y } from '@initiative/shared';
import {
  Fluessigkeit,
  MAX_PFUETZEN,
  MAX_TROPFEN,
  glasLageInto,
  neueGlasLage,
  neuerStrahl,
  strahlInto,
  type Eingang,
} from './pressenFluessigkeit.js';

const BILD = 1 / 60;

function eingang(teil: Partial<Eingang> = {}): Eingang {
  return {
    x: 140,
    y: 480,
    vx: 0,
    neigung: 0,
    neigungV: 0,
    fuellung: GLAS_ML,
    mund: 0,
    getrunken: 0,
    verschuettet: 0,
    fluss: 0,
    trifft: false,
    landeX: 140,
    landeY: 480,
    abgestellt: false,
    ...teil,
  };
}

/** Lässt `sekunden` vergehen, mit festen Bildern. */
function laufen(f: Fluessigkeit, a: Eingang, sekunden: number) {
  for (let t = 0; t < sekunden; t += BILD) f.schritt(BILD, a);
}

function aktiveTropfen(f: Fluessigkeit): number {
  let n = 0;
  for (let i = 0; i < MAX_TROPFEN; i += 1) if (f.tropfenLeben[i]! > 0) n += 1;
  return n;
}

describe('Füllstand', () => {
  it('sinkt weich auf die Füllung, ohne zu springen oder darunter zu geraten', () => {
    const f = new Fluessigkeit(false);
    f.schritt(BILD, eingang());
    const werte: number[] = [];
    const a = eingang({ fuellung: 150, neigung: 50, fluss: 20, landeX: MUND_X, landeY: MUND_Y });
    for (let i = 0; i < 120; i += 1) {
      f.schritt(BILD, a);
      werte.push(f.niveau);
    }
    expect(werte[0]!).toBeGreaterThan(0.9);
    expect(werte.every((w, i) => i === 0 || w <= werte[i - 1]! + 1e-9)).toBe(true);
    expect(Math.min(...werte)).toBeGreaterThanOrEqual(0.5 - 1e-9);
    expect(Math.abs(f.niveau - 0.5)).toBeLessThan(0.002);
    // Kein Sprung größer als ein Bruchteil je Bild.
    for (let i = 1; i < werte.length; i += 1) expect(werte[i - 1]! - werte[i]!).toBeLessThan(0.1);
  });

  it('bei „Bewegung reduzieren“ steht der Füllstand sofort', () => {
    const f = new Fluessigkeit(true);
    f.schritt(BILD, eingang());
    f.schritt(BILD, eingang({ fuellung: 90 }));
    expect(f.niveau).toBeCloseTo(0.3, 6);
    expect(f.unruhig()).toBe(false);
  });
});

describe('Schwappen', () => {
  it('schwingt nach einem Ruck, schlägt gegen die Richtung aus und klingt ab', () => {
    const f = new Fluessigkeit(false);
    f.schritt(BILD, eingang());
    // Glas wird nach rechts beschleunigt: die Oberfläche kippt nach hinten (positiv).
    let a = eingang({ vx: 120 });
    f.schritt(BILD, a);
    f.schritt(BILD, (a = eingang({ vx: 240 })));
    const grosse: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      f.schritt(BILD, a);
      grosse.push(f.schwapp);
    }
    expect(Math.max(...grosse)).toBeGreaterThan(1);
    expect(Math.min(...grosse)).toBeLessThan(0); // Gegenschwung
    laufen(f, a, 4);
    expect(f.schwapp).toBe(0);
    expect(f.welle).toBeLessThan(0.01);
  });

  it('bleibt in Grenzen, auch bei heftigem Ruck', () => {
    const f = new Fluessigkeit(false);
    f.schritt(BILD, eingang());
    f.schritt(BILD, eingang({ vx: 2000, neigungV: 500 }));
    for (let i = 0; i < 120; i += 1) {
      f.schritt(BILD, eingang({ vx: 2000, neigungV: 500 }));
      expect(Math.abs(f.schwapp)).toBeLessThanOrEqual(24);
      expect(Number.isFinite(f.schwapp)).toBe(true);
    }
  });

  it('schwappt in der ruhigen Darstellung nie', () => {
    const f = new Fluessigkeit(true);
    f.schritt(BILD, eingang());
    f.schritt(BILD, eingang({ vx: 600, neigungV: 200, fluss: 30 }));
    expect(f.schwapp).toBe(0);
    expect(f.welle).toBe(0);
  });
});

describe('Schluck', () => {
  it('kommt nur, wenn wirklich getrunken wurde – je 5 ml einer', () => {
    const f = new Fluessigkeit(false);
    f.schritt(BILD, eingang());
    laufen(f, eingang({ mund: 10 }), 0.5);
    expect(f.puls).toBe(0);
    f.schritt(BILD, eingang({ mund: 10, getrunken: 4 }));
    expect(f.puls).toBe(0);
    f.schritt(BILD, eingang({ mund: 10, getrunken: 5.5 }));
    expect(f.puls).toBeGreaterThan(0.9);
    laufen(f, eingang({ mund: 10, getrunken: 5.5 }), 0.4);
    expect(f.puls).toBe(0);
    // Der Mund füllt sich weich mit.
    expect(f.mundFuell).toBeGreaterThan(0.3);
  });
});

describe('Strahl, Tropfen und Nachlaufen', () => {
  const gießen = (fluss: number, trifft: boolean) =>
    eingang({
      x: 480,
      y: 330,
      neigung: 50,
      fuellung: 200,
      fluss,
      trifft,
      landeX: trifft ? MUND_X : 800,
      landeY: trifft ? MUND_Y : 300,
      verschuettet: 0,
    });

  it('löst Tropfen vom Strahl, bleibt im Vorrat und verwirft sie wieder', () => {
    const f = new Fluessigkeit(false);
    f.schritt(BILD, eingang());
    const a = gießen(26, false);
    let hoechste = 0;
    for (let i = 0; i < 90; i += 1) {
      f.schritt(BILD, a);
      hoechste = Math.max(hoechste, aktiveTropfen(f));
    }
    expect(hoechste).toBeGreaterThan(4);
    expect(hoechste).toBeLessThanOrEqual(MAX_TROPFEN);
    for (let i = 0; i < MAX_TROPFEN; i += 1) {
      expect(Number.isFinite(f.tropfenX[i]!) && Number.isFinite(f.tropfenY[i]!)).toBe(true);
    }
    // Strahl aus, Glas still: alles kommt zur Ruhe.
    laufen(f, eingang({ neigung: 50, fuellung: 200 }), 3);
    expect(aktiveTropfen(f)).toBe(0);
    // Solange Bier im Glas ist, steigen Blasen; ist es leer und abgestellt, ruht alles.
    expect(f.unruhig()).toBe(true);
    laufen(f, eingang({ fuellung: 0, getrunken: 200, abgestellt: true }), 3);
    expect(f.unruhig()).toBe(false);
  });

  it('wird dünner und zeigt dann mehr Tropfenabriss: weniger Fluss, kleinere Tropfen', () => {
    const grosse = (fluss: number) => {
      const f = new Fluessigkeit(false);
      f.schritt(BILD, eingang());
      let summe = 0;
      let n = 0;
      for (let i = 0; i < 120; i += 1) {
        f.schritt(BILD, gießen(fluss, false));
        for (let k = 0; k < MAX_TROPFEN; k += 1) {
          if (f.tropfenLeben[k]! > 0 && f.tropfenArt[k] === 0 && f.tropfenVy[k]! < 0) {
            summe += f.tropfenR0[k]!;
            n += 1;
          }
        }
      }
      return summe / Math.max(1, n);
    };
    expect(grosse(4)).toBeLessThan(grosse(28));
  });

  it('bildet Schaum beim Gießen und lässt ihn danach absinken', () => {
    const f = new Fluessigkeit(false);
    f.schritt(BILD, eingang());
    laufen(f, gießen(30, true), 1.2);
    const dick = f.schaum;
    expect(dick).toBeGreaterThan(0.6);
    laufen(f, eingang({ fuellung: 150 }), 5);
    expect(f.schaum).toBeLessThan(dick);
    expect(f.schaum).toBeCloseTo(0.3, 2);
  });

  it('lässt nach dem letzten Strahl Tropfen am Rand wachsen und fallen – höchstens fünf', () => {
    const f = new Fluessigkeit(false);
    f.schritt(BILD, gießen(10, true));
    const leer = eingang({ x: 480, y: 330, neigung: 80, fuellung: 0, getrunken: 200 });
    let gesehen = 0;
    let letzte = 0;
    for (let i = 0; i < 60 * 6; i += 1) {
      f.schritt(BILD, leer);
      if (f.randR > letzte) letzte = f.randR;
      if (f.randR === 0 && letzte > 0) {
        gesehen += 1;
        letzte = 0;
      }
    }
    expect(gesehen).toBe(5);
    // Ist das Glas abgestellt, ist Schluss mit dem Nachlaufen.
    const g = new Fluessigkeit(false);
    g.schritt(BILD, gießen(10, true));
    laufen(g, { ...leer, abgestellt: true }, 1);
    expect(g.randR).toBe(0);
  });

  it('zeichnet Schaumreste an die Wand, wenn der Pegel sinkt, und im leeren Glas bleiben sie', () => {
    const f = new Fluessigkeit(false);
    f.schritt(BILD, eingang());
    laufen(f, gießen(26, true), 1);
    expect(f.reste).toBeGreaterThan(2);
    const g = new Fluessigkeit(false);
    g.schritt(BILD, eingang({ fuellung: 0, getrunken: 300, abgestellt: true }));
    expect(g.reste).toBeGreaterThanOrEqual(3);
  });
});

describe('Pfützen', () => {
  const daneben = (verschuettet: number, landeX: number, landeY = 300) =>
    eingang({
      x: 480,
      y: 330,
      neigung: 50,
      fuellung: 200,
      fluss: 20,
      trifft: false,
      landeX,
      landeY,
      verschuettet,
    });

  it('bleiben, wo sie entstanden, auch wenn der Strahl weiterwandert', () => {
    const f = new Fluessigkeit(false);
    f.schritt(BILD, eingang());
    for (let i = 1; i <= 30; i += 1) f.schritt(BILD, daneben(i * 0.3, 800));
    expect(f.pfuetzenAnzahl).toBe(1);
    expect(f.pfuetzeX[0]).toBeCloseTo(800, 0);
    // Der Strahl wandert weit weg: eine zweite Pfütze, die erste bleibt.
    for (let i = 31; i <= 60; i += 1) f.schritt(BILD, daneben(i * 0.3, 200, 150));
    expect(f.pfuetzenAnzahl).toBe(2);
    expect(f.pfuetzeX[0]).toBeCloseTo(800, 0);
    expect(f.pfuetzeX[1]).toBeCloseTo(200, 0);
    // Menge stimmt: alles Verschüttete liegt in einer Pfütze.
    expect(f.pfuetzeMl[0]! + f.pfuetzeMl[1]!).toBeCloseTo(18, 1);
  });

  it('wachsen weich zum Zielradius und nie über den Vorrat hinaus', () => {
    const f = new Fluessigkeit(false);
    f.schritt(BILD, eingang());
    f.schritt(BILD, daneben(40, 800));
    expect(f.pfuetzeR[0]).toBeLessThan(5);
    laufen(f, daneben(40, 800), 2);
    expect(f.pfuetzeR[0]).toBeGreaterThan(40);
    // Viele weit verteilte Spritzer: höchstens MAX_PFUETZEN.
    for (let i = 0; i < 20; i += 1) {
      f.schritt(BILD, daneben(41 + i, 60 + i * 45, 80 + i * 20));
    }
    expect(f.pfuetzenAnzahl).toBeLessThanOrEqual(MAX_PFUETZEN);
  });

  it('stehen in der ruhigen Darstellung sofort in voller Größe', () => {
    const f = new Fluessigkeit(true);
    f.schritt(BILD, eingang());
    f.schritt(BILD, daneben(25, 700));
    expect(f.pfuetzenAnzahl).toBe(1);
    expect(f.pfuetzeR[0]).toBeGreaterThan(30);
    expect(aktiveTropfen(f)).toBe(0);
  });

  it('zeigen bei einem fertigen Lauf (nur die Menge bekannt) eine Pfütze', () => {
    const f = new Fluessigkeit(false);
    f.schritt(BILD, eingang({ fuellung: 0, verschuettet: 12, getrunken: 288, abgestellt: true }));
    expect(f.pfuetzenAnzahl).toBe(1);
    expect(f.pfuetzeMl[0]).toBeCloseTo(12, 5);
    expect(f.pfuetzeR[0]).toBeGreaterThan(20);
  });
});

describe('Neuer Lauf und Wiederholbarkeit', () => {
  it('setzt alles zurück, sobald das Glas wieder voll und das Verschüttete weg ist', () => {
    const f = new Fluessigkeit(false);
    f.schritt(BILD, eingang());
    laufen(
      f,
      eingang({
        fuellung: 100,
        fluss: 20,
        verschuettet: 30,
        landeX: 700,
        landeY: 300,
        neigung: 60,
      }),
      1,
    );
    expect(f.pfuetzenAnzahl).toBeGreaterThan(0);
    f.schritt(BILD, eingang());
    expect(f.pfuetzenAnzahl).toBe(0);
    expect(aktiveTropfen(f)).toBe(0);
    expect(f.niveau).toBe(1);
  });

  it('rechnet bei gleichen Eingaben gleich (feste Zufallsreihe, keine Uhr)', () => {
    const lauf = () => {
      const f = new Fluessigkeit(false);
      f.schritt(BILD, eingang());
      const a = eingang({
        x: 480,
        y: 330,
        neigung: 55,
        fuellung: 180,
        fluss: 22,
        landeX: 760,
        landeY: 280,
        verschuettet: 3,
        vx: 80,
      });
      laufen(f, a, 1.5);
      return [f.tropfenX.slice(), f.pfuetzeR.slice(), f.schwapp, f.schaum];
    };
    expect(lauf()).toEqual(lauf());
  });
});

describe('Geometrie', () => {
  it('stellt das Glas aufrecht und abgestellt an den richtigen Ort', () => {
    const lage = glasLageInto(neueGlasLage(), eingang({ x: 300, y: 400 }));
    expect([lage.glasX, lage.glasY, lage.bodenY, lage.randRy]).toEqual([300, 400, 56, 13]);
    const weg = glasLageInto(neueGlasLage(), eingang({ abgestellt: true }));
    expect([weg.glasX, weg.glasY, weg.bodenY]).toEqual([800, 470, 74]);
    const geneigt = glasLageInto(neueGlasLage(), eingang({ neigung: 90 }));
    expect(geneigt.bodenY).toBeCloseTo(100, 6);
  });

  it('führt den Strahl vom vorderen Rand zur Landung', () => {
    const a = eingang({ x: 400, y: 350, neigung: 50, fluss: 14, landeX: 500, landeY: 210 });
    const s = strahlInto(neuerStrahl(), a, glasLageInto(neueGlasLage(), a));
    expect([s.ex, s.ey]).toEqual([500, 210]);
    expect(s.sx).toBe(400);
    expect(s.sy).toBeLessThan(350);
    expect(s.cy).toBeLessThan(Math.min(s.sy, s.ey));
    expect(s.breite).toBeCloseTo(4.5, 6);
  });
});
