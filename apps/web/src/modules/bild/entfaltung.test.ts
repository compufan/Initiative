import { describe, expect, it } from 'vitest';

import { falten, punktbildBauen, richardsonLucy, saumBegrenzen } from './entfaltung.js';

describe('punktbildBauen', () => {
  it('summiert immer auf eins', () => {
    /*
     * Die wichtigste Eigenschaft. Summierte der Kern auf 1,2, hellte jeder
     * Durchgang das Bild um zwanzig Prozent auf – nach dreissig Durchgängen
     * wäre es weiss. Richardson-Lucy setzt einen normierten Kern voraus.
     */
    for (const p of [
      { art: 'scheibe' as const, radius: 0.5 },
      { art: 'scheibe' as const, radius: 3 },
      { art: 'scheibe' as const, radius: 9.5 },
      { art: 'linie' as const, laenge: 2, winkel: 0 },
      { art: 'linie' as const, laenge: 15, winkel: 37 },
      { art: 'linie' as const, laenge: 30, winkel: 90 },
    ]) {
      const kern = punktbildBauen(p);
      let summe = 0;
      for (const wert of kern.werte) summe += wert;
      expect(summe, JSON.stringify(p)).toBeCloseTo(1, 6);
    }
  });

  it('hat eine ungerade Kante, damit die Mitte ein Punkt ist', () => {
    for (const r of [0.5, 1, 2.5, 7]) {
      const kern = punktbildBauen({ art: 'scheibe', radius: r });
      expect(kern.breite % 2, `Radius ${r}`).toBe(1);
      expect(kern.mx).toBe((kern.breite - 1) / 2);
    }
  });

  it('macht aus einer Scheibe etwas Rundes und aus einer Linie etwas Gerades', () => {
    const scheibe = punktbildBauen({ art: 'scheibe', radius: 4 });
    const linie = punktbildBauen({ art: 'linie', laenge: 8, winkel: 0 });
    const wert = (k: typeof scheibe, dx: number, dy: number) =>
      k.werte[(k.my + dy) * k.breite + (k.mx + dx)];
    // Die Scheibe trägt in beide Richtungen gleich weit.
    expect(wert(scheibe, 3, 0)).toBeGreaterThan(0);
    expect(wert(scheibe, 0, 3)).toBeGreaterThan(0);
    expect(wert(scheibe, 3, 0)).toBeCloseTo(wert(scheibe, 0, 3), 6);
    // Die waagerechte Linie nur in eine.
    expect(wert(linie, 3, 0)).toBeGreaterThan(0);
    expect(wert(linie, 0, 3)).toBe(0);
  });

  it('dreht die Linie mit dem Winkel', () => {
    const quer = punktbildBauen({ art: 'linie', laenge: 8, winkel: 90 });
    const wert = (dx: number, dy: number) =>
      quer.werte[(quer.my + dy) * quer.breite + (quer.mx + dx)];
    expect(wert(0, 3)).toBeGreaterThan(0);
    expect(wert(3, 0)).toBe(0);
  });

  it('macht aus einer Unschärfe von null die Selbstabbildung', () => {
    // „Keine Unschärfe" muss „nichts tun" heissen und darf nicht in eine
    // Division durch null laufen.
    const kern = punktbildBauen({ art: 'linie', laenge: 0, winkel: 0 });
    let summe = 0;
    for (const wert of kern.werte) summe += wert;
    expect(summe).toBeCloseTo(1, 6);
    expect(kern.werte[kern.my * kern.breite + kern.mx]).toBeGreaterThan(0.9);
  });
});

/** Ein Prüfbild mit harten Kanten, feinen Linien und einer glatten Fläche. */
function pruefbild(breite: number, hoehe: number): Float32Array {
  const d = new Float32Array(breite * hoehe);
  for (let y = 0; y < hoehe; y += 1) {
    for (let x = 0; x < breite; x += 1) {
      let wert = 0.15;
      if (x > breite * 0.55) wert = 0.75; // eine harte Kante
      if (y > hoehe * 0.7) wert = 0.45; // eine zweite, quer dazu
      if (x % 9 === 0 && y > hoehe * 0.2 && y < hoehe * 0.6) wert = 0.9; // feine Linien
      d[y * breite + x] = wert;
    }
  }
  return d;
}

/** Der mittlere Abstand zweier Bilder – ohne den Rand, wo gespiegelt wird. */
function abstand(
  a: Float32Array,
  b: Float32Array,
  breite: number,
  hoehe: number,
  rand = 6,
): number {
  let summe = 0;
  let n = 0;
  for (let y = rand; y < hoehe - rand; y += 1) {
    for (let x = rand; x < breite - rand; x += 1) {
      summe += Math.abs(a[y * breite + x] - b[y * breite + x]);
      n += 1;
    }
  }
  return summe / Math.max(1, n);
}

describe('falten', () => {
  it('spiegelt am Rand, statt den Randpunkt in die Länge zu ziehen', () => {
    /*
     * Am Bildrand fehlen dem Kern Nachbarn, und was man dort einsetzt, sieht
     * man im fertigen Bild.
     *
     * Mit Null aufzufüllen hiesse „dahinter ist es stockdunkel“ – die
     * Entfaltung sähe am Rand eine Kante, die es nicht gibt, und legte einen
     * hellen Saum um das ganze Bild. Den Randpunkt zu wiederholen ist besser,
     * zieht aber jeden Verlauf am Rand flach: ein Streifen, der im Motiv
     * nicht vorkommt.
     *
     * Geprüft an einem Verlauf, weil nur dort der Unterschied sichtbar wird:
     * Gespiegelt setzt sich die Steigung fort, geklemmt bricht sie ab.
     */
    const B = 16;
    const H = 3;
    const verlauf = new Float32Array(B * H);
    for (let y = 0; y < H; y += 1) for (let x = 0; x < B; x += 1) verlauf[y * B + x] = x;
    const kern = punktbildBauen({ art: 'linie', laenge: 8, winkel: 0 });
    const raus = new Float32Array(B * H);
    falten(verlauf, raus, B, H, kern);

    /*
     * Nachgemessen am linken Rand: gespiegelt 2,00 – geklemmt 1,00. Beim
     * Klemmen wiederholt sich die Null nach links und zieht das Mittel
     * herunter; gespiegelt kommen die Werte 1, 2, 3 … von rechts zurück.
     *
     * In der Mitte, wo kein Rand stört, muss beides denselben Wert ergeben
     * wie der Verlauf selbst – das prüft die zweite Zeile und hält fest, dass
     * hier nicht irgendetwas verschoben ist.
     */
    expect(raus[1 * B + 8], 'in der Mitte stimmt die Faltung nicht').toBeCloseTo(8, 5);
    expect(raus[1 * B + 0], 'am linken Rand wurde geklemmt statt gespiegelt').toBeGreaterThan(1.5);
    // Und am rechten genauso: gespiegelt 13,00 – geklemmt 14,00.
    expect(raus[1 * B + (B - 1)], 'am rechten Rand wurde geklemmt statt gespiegelt').toBeLessThan(
      13.5,
    );

    /*
     * Und dasselbe senkrecht. Zwei Zeilen im Code, zwei Ränder – und sie
     * lassen sich unabhängig voneinander kaputtmachen; eine Prüfung nur
     * waagerecht hätte das nicht gemerkt.
     */
    const hB = 3;
    const hH = 16;
    const hoch = new Float32Array(hB * hH);
    for (let y = 0; y < hH; y += 1) for (let x = 0; x < hB; x += 1) hoch[y * hB + x] = y;
    const quer = new Float32Array(hB * hH);
    falten(hoch, quer, hB, hH, punktbildBauen({ art: 'linie', laenge: 8, winkel: 90 }));
    expect(quer[8 * hB + 1], 'in der Mitte stimmt die Faltung senkrecht nicht').toBeCloseTo(8, 5);
    expect(quer[0 * hB + 1], 'am oberen Rand wurde geklemmt statt gespiegelt').toBeGreaterThan(1.5);
    expect(quer[(hH - 1) * hB + 1], 'am unteren Rand wurde geklemmt statt gespiegelt').toBeLessThan(
      13.5,
    );
  });

  it('erhält eine gleichmässige Fläche genau', () => {
    // Ein normierter Kern über eine ebene Fläche muss die Fläche ergeben –
    // sonst stimmt die Normierung oder der Rand nicht.
    const B = 12;
    const H = 9;
    const eben = new Float32Array(B * H).fill(0.37);
    const raus = new Float32Array(B * H);
    falten(eben, raus, B, H, punktbildBauen({ art: 'scheibe', radius: 2.5 }));
    for (const wert of raus) expect(wert).toBeCloseTo(0.37, 5);
  });

  it('dreht den Kern für den Rückweg wirklich um', () => {
    /*
     * Zum Geltungsbereich dieses Tests, damit sich niemand täuscht: Er prüft
     * das UMDREHEN in `falten`, nicht die Stelle in `richardsonLucy`, die es
     * benutzt. Die lässt sich nicht prüfen, und zwar nachweislich nicht –
     * beide Punktbildfunktionen dieses Moduls sind punktsymmetrisch, für sie
     * ist das Umdrehen wirkungslos. Richtig ist es trotzdem: Die Rechnung
     * verlangt den gespiegelten Kern, und der nächste Kern muss nicht mehr
     * symmetrisch sein.
     */
    /*
     * Beide Punktbildfunktionen dieses Moduls – Scheibe wie Linie – sind
     * punktsymmetrisch; für sie ist das Umdrehen nachweislich wirkungslos.
     * Richtig sein muss es trotzdem, denn die Rechnung verlangt es, und der
     * nächste Kern muss es nicht mehr sein.
     *
     * Deshalb hier ein von Hand gebauter, ausdrücklich UNsymmetrischer Kern.
     */
    const kern = {
      werte: Float32Array.from([0, 0, 0, 0, 0, 0, 1, 0, 0]),
      breite: 3,
      hoehe: 3,
      mx: 1,
      my: 1,
    };
    const B = 5;
    const H = 3;
    const ein = new Float32Array(B * H);
    ein[1 * B + 2] = 1;
    const hin = new Float32Array(B * H);
    const zurueck = new Float32Array(B * H);
    falten(ein, hin, B, H, kern, false);
    falten(ein, zurueck, B, H, kern, true);
    /*
     * Nachgerechnet: `aus[y][x] = Σ ein[y + ky − my][x + kx − mx] · g`. Der
     * Kern steht auf (ky 2, kx 0), also `aus[y][x] = ein[y+1][x−1]` – der
     * Punkt wandert eine Zeile hoch und eine Spalte nach rechts. Umgedreht
     * wird derselbe Kern bei (ky 0, kx 2) gelesen, also `ein[y−1][x+1]`, und
     * der Punkt wandert genau andersherum.
     */
    expect(hin[0 * B + 3]).toBeCloseTo(1, 6);
    expect(zurueck[2 * B + 1]).toBeCloseTo(1, 6);
  });
});

describe('richardsonLucy', () => {
  it('holt eine bekannte Unschärfe zurück', () => {
    /*
     * Der eigentliche Beweis, und er ist streng: Ein scharfes Bild wird mit
     * einer bekannten Punktbildfunktion verschmiert, und die Entfaltung muss
     * näher am Original landen als das verschmierte Bild.
     *
     * Verlangt wird nicht „gleich", sondern „deutlich näher" – die
     * Information am Rand des Frequenzbandes ist wirklich weg, und ein Test,
     * der Gleichheit fordert, würde ein Verfahren verlangen, das es nicht
     * gibt.
     */
    const B = 64;
    const H = 48;
    const scharf = pruefbild(B, H);
    const kern = punktbildBauen({ art: 'scheibe', radius: 2.5 });
    const verschmiert = new Float32Array(B * H);
    falten(scharf, verschmiert, B, H, kern);

    const vorher = abstand(scharf, verschmiert, B, H);
    const zurueck = richardsonLucy(verschmiert, B, H, kern, 40);
    const nachher = abstand(scharf, zurueck, B, H);

    /*
     * Nachgemessen: Bei vierzig Durchgängen bleiben rund 69 Prozent des
     * Fehlers, bei 150 noch 41, bei 300 noch 31. Das Verfahren nähert sich
     * langsam – und es kommt NIE ganz hin.
     *
     * Das ist keine Schwäche der Umsetzung, sondern Physik: Eine Scheibe von
     * 2,5 Punkten Radius löscht bestimmte Frequenzen vollständig aus, und was
     * mit null multipliziert wurde, lässt sich nicht zurückdividieren. Ein
     * Test, der Gleichheit fordert, verlangte ein Verfahren, das es nicht
     * gibt.
     */
    expect(vorher).toBeGreaterThan(0.02);
    expect(nachher, `vorher ${vorher.toFixed(4)}, nachher ${nachher.toFixed(4)}`).toBeLessThan(
      vorher * 0.8,
    );
  });

  it('wird mit mehr Durchgängen besser, nicht schlechter', () => {
    /*
     * Die Eigenschaft, die zeigt, dass es WIRKLICH das Verfahren ist und
     * nicht irgendeine Schärfung, die zufällig hilft: Richardson-Lucy nähert
     * sich mit jedem Durchgang an. Liefe es auseinander, stiege der Abstand
     * wieder – und genau das tut eine falsch aufgeschriebene Iteration.
     */
    const B = 64;
    const H = 48;
    const scharf = pruefbild(B, H);
    const kern = punktbildBauen({ art: 'scheibe', radius: 2.5 });
    const verschmiert = new Float32Array(B * H);
    falten(scharf, verschmiert, B, H, kern);

    const bei = (n: number) => abstand(scharf, richardsonLucy(verschmiert, B, H, kern, n), B, H);
    const zehn = bei(10);
    const vierzig = bei(40);
    const hundertfuenfzig = bei(150);
    expect(vierzig).toBeLessThan(zehn);
    expect(hundertfuenfzig).toBeLessThan(vierzig);
  });

  it('holt auch eine Verwacklung zurück', () => {
    const B = 64;
    const H = 48;
    const scharf = pruefbild(B, H);
    const kern = punktbildBauen({ art: 'linie', laenge: 9, winkel: 20 });
    const verschmiert = new Float32Array(B * H);
    falten(scharf, verschmiert, B, H, kern);

    const vorher = abstand(scharf, verschmiert, B, H);
    const nachher = abstand(scharf, richardsonLucy(verschmiert, B, H, kern, 80), B, H);
    expect(nachher, `vorher ${vorher.toFixed(4)}, nachher ${nachher.toFixed(4)}`).toBeLessThan(
      vorher * 0.8,
    );
  });

  it('wird mit dem FALSCHEN Kern nicht besser', () => {
    /*
     * Die Gegenprobe, ohne die alles darüber wertlos wäre: Wenn jeder Kern
     * das Bild verbessert, misst der Test nicht die Entfaltung, sondern
     * irgendeine allgemeine Schärfung.
     *
     * Verschmiert wird mit einer Linie, entfaltet mit einer quer dazu. Das
     * Ergebnis darf nicht annähernd so gut sein wie mit dem richtigen Kern.
     */
    const B = 64;
    const H = 48;
    const scharf = pruefbild(B, H);
    const echt = punktbildBauen({ art: 'linie', laenge: 9, winkel: 0 });
    const falsch = punktbildBauen({ art: 'linie', laenge: 9, winkel: 90 });
    const verschmiert = new Float32Array(B * H);
    falten(scharf, verschmiert, B, H, echt);

    const mitRichtig = abstand(scharf, richardsonLucy(verschmiert, B, H, echt, 40), B, H);
    const mitFalsch = abstand(scharf, richardsonLucy(verschmiert, B, H, falsch, 40), B, H);
    expect(mitFalsch).toBeGreaterThan(mitRichtig * 1.5);
  });

  it('lässt ein Bild ohne Unschärfe in Ruhe', () => {
    const B = 32;
    const H = 32;
    const bild = pruefbild(B, H);
    const kern = punktbildBauen({ art: 'linie', laenge: 0, winkel: 0 });
    const raus = richardsonLucy(bild, B, H, kern, 20);
    expect(abstand(bild, raus, B, H, 2)).toBeLessThan(0.02);
  });

  it('erzeugt nie eine negative Helligkeit', () => {
    /*
     * Das ist der Grund, warum es ein multiplikatives Verfahren ist. Wiener
     * und Verwandte lassen negative Werte zu, und die sind an jeder Kante das
     * Klingeln, das man dann wegfiltern muss.
     */
    const B = 48;
    const H = 32;
    const kern = punktbildBauen({ art: 'scheibe', radius: 3 });
    const verschmiert = new Float32Array(B * H);
    falten(pruefbild(B, H), verschmiert, B, H, kern);
    const raus = richardsonLucy(verschmiert, B, H, kern, 50);
    for (const wert of raus) {
      expect(wert).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(wert)).toBe(true);
    }
  });

  it('erhält die Lichtmenge', () => {
    // Eine Eigenschaft des Verfahrens, und ein guter Wächter: Wer die
    // Normierung des Kerns kaputtmacht, sieht es hier sofort.
    const B = 48;
    const H = 32;
    const kern = punktbildBauen({ art: 'scheibe', radius: 2 });
    const verschmiert = new Float32Array(B * H);
    falten(pruefbild(B, H), verschmiert, B, H, kern);
    const raus = richardsonLucy(verschmiert, B, H, kern, 30);
    const summe = (f: Float32Array) => f.reduce((a, b) => a + b, 0);
    expect(summe(raus) / summe(verschmiert)).toBeCloseTo(1, 1);
  });

  it('verstärkt mit Dämpfung weniger Rauschen', () => {
    /*
     * Ohne Dämpfung verstärkt jeder Durchgang genau das Rauschen, das in
     * einer glatten Fläche steht – nach dreissig Durchgängen ist ein Himmel
     * grieselig. Gemessen wird deshalb an einer Fläche, in der NICHTS steht
     * ausser Rauschen.
     */
    const B = 48;
    const H = 48;
    const flaeche = new Float32Array(B * H);
    let z = 7;
    for (let i = 0; i < flaeche.length; i += 1) {
      z = (z * 1103515245 + 12345) & 0x7fffffff;
      flaeche[i] = 0.5 + (((z >>> 16) % 100) - 50) / 5000;
    }
    const kern = punktbildBauen({ art: 'scheibe', radius: 2 });
    const korn = (f: Float32Array) => {
      let summe = 0;
      for (const wert of f) summe += Math.abs(wert - 0.5);
      return summe;
    };
    const ohne = korn(richardsonLucy(flaeche, B, H, kern, 40, 0));
    const mit = korn(richardsonLucy(flaeche, B, H, kern, 40, 0.05));
    expect(mit).toBeLessThan(ohne);
  });
});

describe('saumBegrenzen', () => {
  it('holt einen Ausreisser auf die Nachbarschaft zurück', () => {
    const B = 8;
    const H = 8;
    const quelle = new Float32Array(B * H).fill(0.4);
    const ergebnis = new Float32Array(B * H).fill(0.4);
    ergebnis[3 * B + 3] = 5;
    ergebnis[5 * B + 5] = -2;
    saumBegrenzen(ergebnis, quelle, B, H, 2);
    expect(ergebnis[3 * B + 3]).toBeCloseTo(0.4, 6);
    expect(ergebnis[5 * B + 5]).toBeCloseTo(0.4, 6);
  });

  it('lässt zurückgeholte Struktur stehen, die im Bild vorkommt', () => {
    const B = 8;
    const H = 8;
    const quelle = new Float32Array(B * H).fill(0.2);
    for (let y = 0; y < H; y += 1) quelle[y * B + 4] = 0.8;
    const ergebnis = new Float32Array(quelle);
    // Eine Kante, die steiler geworden ist – aber innerhalb der Spanne.
    ergebnis[3 * B + 3] = 0.7;
    saumBegrenzen(ergebnis, quelle, B, H, 2);
    expect(ergebnis[3 * B + 3]).toBeCloseTo(0.7, 6);
  });
});
