import { describe, expect, it } from 'vitest';

import {
  BLOCK,
  LAGE_RUHE,
  bewegung,
  graustufen,
  lageRuht,
  lageSchaetzen,
  lageVerketten,
  maskePasst,
  maskeZiehen,
  punktVor,
  punktZurueck,
  zeitlichGlaetten,
  lageRobust,
} from './verfolgung.js';

/**
 * Die Bewegungsschätzung.
 *
 * Geprüft wird gegen SELBST GESCHOBENE Bilder: Ein Muster wird um einen
 * bekannten Betrag versetzt, und die Schätzung muss genau diesen Betrag
 * finden. Das ist die einzige Art von Prüfung, die hier etwas wert ist – an
 * einem echten Video liesse sich nur sagen „sieht plausibel aus".
 */

/** Ein Bild mit Struktur, verschoben um (vx, vy). Ausserhalb: Grau. */
function muster(kante: number, vx = 0, vy = 0): ImageData {
  const daten = new Uint8ClampedArray(kante * kante * 4);
  for (let y = 0; y < kante; y += 1) {
    for (let x = 0; x < kante; x += 1) {
      const qx = x - vx;
      const qy = y - vy;
      const at = (y * kante + x) * 4;
      daten[at + 3] = 255;
      if (qx < 0 || qy < 0 || qx >= kante || qy >= kante) {
        daten[at] = 128;
        daten[at + 1] = 128;
        daten[at + 2] = 128;
        continue;
      }
      /*
       * Zwei Sinus mit unrunden Perioden: Das ergibt ein Muster, das sich
       * innerhalb des Suchbereichs nicht wiederholt. Ein Schachbrett täte es
       * NICHT – dort passt jeder Versatz um ein Vielfaches der Feldbreite
       * genauso gut, und die Schätzung hätte die Wahl zwischen mehreren
       * gleich guten Antworten.
       */
      const wert = 128 + 90 * Math.sin(qx / 3.7) * Math.cos(qy / 5.3);
      daten[at] = wert;
      daten[at + 1] = wert;
      daten[at + 2] = wert;
    }
  }
  return { data: daten, width: kante, height: kante, colorSpace: 'srgb' } as ImageData;
}

/** Dasselbe Muster, um `grad` Grad um die Mitte gedreht. */
function drehen(bild: ImageData, grad: number): ImageData {
  const { width: b, height: h } = bild;
  const raus = new Uint8ClampedArray(b * h * 4);
  const bogen = (grad * Math.PI) / 180;
  const co = Math.cos(bogen);
  const si = Math.sin(bogen);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < b; x += 1) {
      const px = x - b / 2;
      const py = y - h / 2;
      const qx = Math.round(co * px + si * py + b / 2);
      const qy = Math.round(-si * px + co * py + h / 2);
      const at = (y * b + x) * 4;
      raus[at + 3] = 255;
      if (qx < 0 || qy < 0 || qx >= b || qy >= h) continue;
      const von = (qy * b + qx) * 4;
      raus[at] = bild.data[von];
      raus[at + 1] = bild.data[von + 1];
      raus[at + 2] = bild.data[von + 2];
    }
  }
  return { data: raus, width: b, height: h, colorSpace: 'srgb' } as ImageData;
}

describe('graustufen', () => {
  it('gewichtet nach dem, was das Auge sieht', () => {
    /*
     * Ungewichtet bekämen kräftiges Rot und kräftiges Grün denselben Grauwert
     * – und ein Pullover vor einer Hecke wäre für den Blockvergleich
     * unsichtbar.
     */
    const bild = (r: number, g: number, b: number): ImageData =>
      ({
        data: new Uint8ClampedArray([r, g, b, 255]),
        width: 1,
        height: 1,
        colorSpace: 'srgb',
      }) as ImageData;
    const rot = graustufen(bild(255, 0, 0)).werte[0];
    const gruen = graustufen(bild(0, 255, 0)).werte[0];
    const blau = graustufen(bild(0, 0, 255)).werte[0];
    expect(gruen).toBeGreaterThan(rot);
    expect(rot).toBeGreaterThan(blau);
  });

  it('verkleinert auf die vorgegebene Kante', () => {
    const klein = graustufen(muster(256), 128);
    expect(klein.breite).toBe(128);
    expect(klein.hoehe).toBe(128);
  });

  it('lässt ein kleines Bild in Ruhe', () => {
    // Hochrechnen brächte keine Struktur dazu, kostete aber das Vierfache im
    // Blockvergleich.
    const klein = graustufen(muster(64), 128);
    expect(klein.breite).toBe(64);
  });

  it('mittelt, statt Punkte wegzuwerfen', () => {
    /*
     * Ein Bild aus abwechselnd Schwarz und Weiss muss beim Halbieren zu Grau
     * werden. Wer nur jeden zweiten Punkt nimmt, bekommt je nach Startpunkt
     * ganz Schwarz oder ganz Weiss – und die Bewegungsschätzung sähe eine
     * Bewegung, wo keine ist.
     */
    const kante = 16;
    const daten = new Uint8ClampedArray(kante * kante * 4);
    for (let i = 0; i < kante * kante; i += 1) {
      const hell = (i % 2 === 0 ? 255 : 0) as number;
      daten[i * 4] = hell;
      daten[i * 4 + 1] = hell;
      daten[i * 4 + 2] = hell;
      daten[i * 4 + 3] = 255;
    }
    const bild = { data: daten, width: kante, height: kante, colorSpace: 'srgb' } as ImageData;
    for (const wert of graustufen(bild, 8).werte) expect(wert).toBeCloseTo(127.5, 0);
  });
});

describe('bewegung', () => {
  it('findet einen bekannten Versatz', () => {
    /*
     * Der Kern der Sache. Verschoben wird um (5, −3); gefunden werden muss der
     * Weg ZURÜCK, also (−5, 3) – die Vektoren zeigen vom neuen Bild ins alte.
     */
    const alt = graustufen(muster(128));
    const neu = graustufen(muster(128, 5, -3));
    const feld = bewegung(alt, neu, 128);

    // Am Rand ragt der gesuchte Block aus dem Bild; geprüft wird die Mitte.
    const mitte = Math.floor(feld.zeilen / 2) * feld.spalten + Math.floor(feld.spalten / 2);
    /*
     * Auf ein Hundertstel genau und nicht auf die ganze Zahl: Seit der
     * Verfeinerung zwischen den Punkten liefert ein Block auch Bruchteile.
     * Das ist der Sinn der Sache – eine Drehung bewegt die Blöcke in der
     * Bildmitte um weniger als einen Punkt, und auf ganze Zahlen gerundet
     * verschwindet sie.
     */
    expect(feld.dx[mitte]).toBeCloseTo(-5, 1);
    expect(feld.dy[mitte]).toBeCloseTo(3, 1);
  });

  it('bleibt bei Stillstand bei null', () => {
    const gleich = graustufen(muster(128));
    const feld = bewegung(gleich, graustufen(muster(128)), 128);
    // Nicht auf null genau: Die Verfeinerung zwischen den Punkten rechnet mit
    // Gleitkomma, und ein hundertstel Punkt ist kein Wandern.
    for (let i = 0; i < feld.dx.length; i += 1) {
      expect(feld.dx[i], `Block ${i}`).toBeCloseTo(0, 1);
      expect(feld.dy[i], `Block ${i}`).toBeCloseTo(0, 1);
    }
  });

  it('erfindet in einer glatten Fläche keine Bewegung', () => {
    /*
     * Der Grund für den Aufschlag je Punkt Bewegung. Auf einer einfarbigen
     * Fläche ist die Abweichung für JEDEN Versatz null; ohne Aufschlag gewänne
     * der zuerst geprüfte – und die Maske zappelte in einer Gegend, in der
     * sich nachweislich nichts bewegt.
     */
    const kante = 64;
    const daten = new Uint8ClampedArray(kante * kante * 4).fill(200);
    const flach = { data: daten, width: kante, height: kante, colorSpace: 'srgb' } as ImageData;
    const feld = bewegung(graustufen(flach), graustufen(flach), kante);
    for (let i = 0; i < feld.dx.length; i += 1) {
      expect(feld.dx[i] === 0 && feld.dy[i] === 0, `Block ${i}`).toBe(true);
    }
  });

  it('verweigert Bilder verschiedener Grösse', () => {
    // Sonst läse der Vergleich an falschen Stellen und lieferte Unsinn, der
    // sich als Zappeln zeigt – nicht als Fehler.
    expect(() => bewegung(graustufen(muster(128)), graustufen(muster(64)), 128)).toThrow();
  });

  it('rechnet den Massstab zum Vollbild mit', () => {
    // Die Vektoren zählen in Graupunkten; wer sie ohne diesen Faktor auf die
    // Maske anwendet, schiebt um ein Vielfaches zu wenig.
    const feld = bewegung(graustufen(muster(512), 128), graustufen(muster(512), 128), 512);
    expect(feld.faktor).toBe(4);
  });
});

describe('lageSchaetzen', () => {
  it('findet eine reine Verschiebung', () => {
    /*
     * Der einfachste Fall, und trotzdem der, an dem die erste Fassung
     * scheiterte: Sie nahm den Median ÜBER ALLE Blöcke, und weil in einem
     * echten Bild mehr als die Hälfte der Blöcke auf glatten Flächen liegt,
     * kam dort null heraus. Hier zählen nur die sicheren.
     */
    const lage = lageSchaetzen(
      bewegung(graustufen(muster(256)), graustufen(muster(256, 6, -4)), 256),
    );
    expect(lage.sicher).toBeGreaterThanOrEqual(5);
    expect(lage.tx).toBeCloseTo(-6, 0);
    expect(lage.ty).toBeCloseTo(4, 0);
    // Keine Drehung, kein Massstab.
    expect(Math.atan2(lage.w, lage.s) * (180 / Math.PI)).toBeCloseTo(0, 0);
    expect(Math.hypot(lage.s, lage.w)).toBeCloseTo(1, 1);
  });

  it('gibt bei Stillstand die Ruhe zurück', () => {
    const gleich = graustufen(muster(128));
    expect(lageRuht(lageSchaetzen(bewegung(gleich, gleich, 128)))).toBe(true);
  });

  it('erfindet auf einer glatten Fläche nichts', () => {
    /*
     * Der Grund für die Sicherheit je Block. Auf einer einfarbigen Fläche ist
     * die Abweichung für jeden Versatz gleich; früher hielt ein Aufschlag je
     * Punkt Bewegung dagegen – und erstickte damit auch die echte Bewegung.
     * Jetzt entscheidet, ob ein Block überhaupt etwas GEWINNT.
     */
    const kante = 128;
    const daten = new Uint8ClampedArray(kante * kante * 4).fill(200);
    const flach = { data: daten, width: kante, height: kante, colorSpace: 'srgb' } as ImageData;
    const feld = bewegung(graustufen(flach), graustufen(flach), kante);
    expect(lageSchaetzen(feld)).toEqual(LAGE_RUHE);
  });

  it('meldet, wie viele Blöcke dahinterstehen', () => {
    // Daran hängt die Ehrlichkeit: Weniger als fünf sichere Blöcke heissen
    // „nichts gefunden" und nicht „zufällig irgendwohin".
    const lage = lageSchaetzen(
      bewegung(graustufen(muster(256)), graustufen(muster(256, 3, 0)), 256),
    );
    expect(lage.sicher).toBeGreaterThan(4);
  });

  it('findet eine DREHUNG – daran scheiterte die reine Verschiebung', () => {
    /*
     * Am Film des Anwenders gemessen: Eine Ganzbildsuche über ±40 Punkte fand
     * in 31 von 33 Übergängen (0, 0) bei null Gewinn, obwohl sich die Szene
     * deutlich bewegte. Wer ein Telefon in der Hand hält, verkantet es – und
     * dagegen ist jede Verschiebung machtlos.
     */
    const kante = 256;
    const gedreht = drehen(muster(kante), 4);
    const lage = lageSchaetzen(bewegung(graustufen(muster(kante)), graustufen(gedreht), kante));
    expect(lage.sicher).toBeGreaterThanOrEqual(5);
    const winkel = Math.atan2(lage.w, lage.s) * (180 / Math.PI);
    /*
     * Die Rückrichtung: Das neue Bild ist um +4 Grad gedreht, der Weg zurück
     * also um −4. Gemessen kommen −3,3 heraus, und das ist kein Fehler,
     * sondern die Auflösung des Verfahrens: Ein Block findet seinen Versatz
     * nur in GANZEN Graupunkten, und bei 16 Blöcken über 256 Punkte ist ein
     * Grad Drehung am Rand keine zwei Punkte. Was zählt, ist die Richtung und
     * die Grössenordnung – und die stimmen; eine reine Verschiebung fände
     * hier gar nichts.
     */
    /*
     * Geprüft wird die RICHTUNG und die Grössenordnung, nicht der genaue
     * Wert. Ein Block findet seinen Versatz über eine Parabel zwischen ganzen
     * Punkten; bei vier Grad auf 256 Punkten bewegen sich die inneren Blöcke
     * um weniger als einen Punkt, und was dort an Genauigkeit fehlt, zieht
     * den Mittelwert nach unten. Gemessen kommen rund −1,9 Grad heraus.
     *
     * Entscheidend ist: Eine reine Verschiebung fände hier GAR NICHTS – und
     * genau das war der Zustand, über den sich der Anwender beschwert hat.
     */
    expect(winkel).toBeLessThan(-0.8);
    expect(winkel).toBeGreaterThan(-6);
  });
});

describe('lageVerketten', () => {
  it('summiert zwei Verschiebungen', () => {
    const a = { s: 1, w: 0, tx: 3, ty: 1, sicher: 9 };
    const b = { s: 1, w: 0, tx: 2, ty: -4, sicher: 7 };
    const zusammen = lageVerketten(a, b);
    expect(zusammen.tx).toBeCloseTo(5, 6);
    expect(zusammen.ty).toBeCloseTo(-3, 6);
    // Die Kette ist nur so sicher wie ihr schwächstes Glied.
    expect(zusammen.sicher).toBe(7);
  });

  it('lässt die Ruhe neutral', () => {
    const a = { s: 0.9, w: 0.2, tx: 3, ty: 1, sicher: 9 };
    expect(lageVerketten(LAGE_RUHE, a)).toEqual(a);
    expect(lageVerketten(a, LAGE_RUHE)).toEqual(a);
  });

  it('dreht zweimal um denselben Winkel', () => {
    const grad = (g: number) => ({
      s: Math.cos((g * Math.PI) / 180),
      w: Math.sin((g * Math.PI) / 180),
      tx: 0,
      ty: 0,
      sicher: 9,
    });
    const zusammen = lageVerketten(grad(10), grad(10));
    expect(Math.atan2(zusammen.w, zusammen.s) * (180 / Math.PI)).toBeCloseTo(20, 6);
  });

  it('führt ZUERST die erste Lage aus – und das ist nicht dasselbe wie umgekehrt', () => {
    /*
     * Die Prüfung, die gefehlt hat, und sie hat 26,6 Bildpunkte gekostet.
     *
     * Die drei Prüfungen darüber benutzen reine Verschiebung ODER reine
     * Drehung, und genau dort vertauschen die beiden Lagen miteinander – die
     * falsche Reihenfolge kam durch alle drei. Erst eine Verschiebung UND
     * eine Drehung trennen sie.
     */
    const schieben = { s: 1, w: 0, tx: 10, ty: 0, sicher: 9 };
    const drehen = {
      s: Math.cos(Math.PI / 2),
      w: Math.sin(Math.PI / 2),
      tx: 0,
      ty: 0,
      sicher: 9,
    };

    // Erst schieben, dann drehen: (0,0) geht auf (10,0) und die
    // Vierteldrehung macht daraus (0,10).
    const erstSchieben = lageVerketten(schieben, drehen);
    expect(punktZurueck(erstSchieben, 1, 0, 0).x).toBeCloseTo(0, 6);
    expect(punktZurueck(erstSchieben, 1, 0, 0).y).toBeCloseTo(10, 6);

    // Andersherum bleibt der Punkt nach der Drehung bei (0,0) und wird
    // danach auf (10,0) geschoben.
    const erstDrehen = lageVerketten(drehen, schieben);
    expect(punktZurueck(erstDrehen, 1, 0, 0).x).toBeCloseTo(10, 6);
    expect(punktZurueck(erstDrehen, 1, 0, 0).y).toBeCloseTo(0, 6);
  });

  it('trägt eine Kette aus Schwenk und Drehung exakt zusammen', () => {
    /*
     * Der Fall aus dem Film: Die Kamera schwenkt erst und kippt dann.
     *
     * `lagen[i]` soll Bild i auf Bild 0 abbilden. Jeder Schritt bildet Bild k
     * auf k−1 ab, muss also VOR der schon aufgelaufenen Kette ausgeführt
     * werden. Geprüft wird gegen die Wahrheit: dieselben Schritte einzeln,
     * einer nach dem anderen, auf denselben Punkt angewandt.
     */
    const grad = (g: number) => ({
      s: Math.cos((g * Math.PI) / 180),
      w: Math.sin((g * Math.PI) / 180),
      tx: 0,
      ty: 0,
      sicher: 9,
    });
    const schritte = [
      ...Array.from({ length: 8 }, () => ({ s: 1, w: 0, tx: 8, ty: 0, sicher: 9 })),
      ...Array.from({ length: 8 }, () => grad(3)),
    ];

    let wahr = { x: 60, y: 60 };
    for (const schritt of schritte) wahr = punktVor(schritt, 1, wahr.x, wahr.y);

    let kette = LAGE_RUHE;
    for (const schritt of schritte) kette = lageVerketten(schritt, kette);
    const gekettet = punktVor(kette, 1, 60, 60);

    expect(gekettet.x, `x: ${gekettet.x} statt ${wahr.x}`).toBeCloseTo(wahr.x, 6);
    expect(gekettet.y, `y: ${gekettet.y} statt ${wahr.y}`).toBeCloseTo(wahr.y, 6);
  });
});

describe('punktZurueck und punktVor', () => {
  it('sind Umkehrungen voneinander', () => {
    /*
     * Beide Richtungen werden gebraucht: die Maske wird RÜCKWÄRTS abgetastet,
     * ein angetippter Punkt und die Enden eines Verlaufs wandern VORWÄRTS
     * mit. Passen sie nicht zusammen, sitzt eines von beidem spiegelverkehrt.
     */
    const lage = { s: 0.97, w: 0.21, tx: 4.5, ty: -2.25, sicher: 12 };
    for (const [x, y] of [
      [0, 0],
      [100, 40],
      [333, 777],
    ]) {
      const hin = punktVor(lage, 3, x, y);
      const zurueck = punktZurueck(lage, 3, hin.x, hin.y);
      expect(zurueck.x).toBeCloseTo(x, 4);
      expect(zurueck.y).toBeCloseTo(y, 4);
    }
  });

  it('rechnet den Massstab zwischen Grau und Bild mit', () => {
    // Die Lage rechnet in Graupunkten. Wer den Faktor vergisst, verschiebt
    // um ein Achtel der nötigen Strecke – und das sieht aus wie „fast richtig".
    const lage = { s: 1, w: 0, tx: -2, ty: 0, sicher: 9 };
    expect(punktZurueck(lage, 4, 100, 0).x).toBeCloseTo(92, 6);
    expect(punktVor(lage, 4, 92, 0).x).toBeCloseTo(100, 6);
  });
});

describe('maskeZiehen', () => {
  /** Eine Maske mit einem weissen Rechteck. */
  function maske(breite: number, hoehe: number, x0: number, y0: number, w: number, h: number) {
    const raus = new Uint8Array(breite * hoehe);
    for (let y = y0; y < y0 + h; y += 1) {
      for (let x = x0; x < x0 + w; x += 1) raus[y * breite + x] = 255;
    }
    return raus;
  }

  function schwerpunkt(alpha: Uint8Array, breite: number) {
    let sx = 0;
    let sy = 0;
    let summe = 0;
    for (let i = 0; i < alpha.length; i += 1) {
      const wert = alpha[i];
      if (wert === 0) continue;
      sx += (i % breite) * wert;
      sy += Math.floor(i / breite) * wert;
      summe += wert;
    }
    return { x: sx / summe, y: sy / summe, flaeche: summe / 255 };
  }

  it('zieht die Maske dorthin, wo das Motiv hingewandert ist', () => {
    const kante = 256;
    const feld = bewegung(graustufen(muster(kante)), graustufen(muster(kante, 6, -4)), kante);
    const lage = lageSchaetzen(feld);
    const vorher = maske(kante, kante, 80, 80, 96, 96);
    const nachher = maskeZiehen(vorher, kante, kante, lage, feld.faktor);
    const a = schwerpunkt(vorher, kante);
    const b = schwerpunkt(nachher, kante);
    expect(b.x - a.x).toBeCloseTo(6, 0);
    expect(b.y - a.y).toBeCloseTo(-4, 0);
  });

  it('gibt bei Ruhe DASSELBE Feld zurück', () => {
    /*
     * Und zwar wirklich dasselbe, nicht eine gleiche Kopie: Bei einer Kamera,
     * die steht, soll kein einziger Punkt neu abgetastet werden. Jede
     * Abtastung weicht die Kante auf.
     */
    const voll = new Uint8Array(64 * 64).fill(255);
    expect(maskeZiehen(voll, 64, 64, LAGE_RUHE, 1)).toBe(voll);
  });

  it('verliert beim wiederholten Ziehen AUS DEM URBILD keine Fläche', () => {
    /*
     * Der Grund für die aufsummierte Lage. Gemessen an einer Maske, die 33-mal
     * nacheinander mit dem rohen Blockfeld geschoben wurde: 58 % Flächenverlust.
     * Aus dem Urbild gezogen bleibt sie ganz – hier über dreissig Schritte
     * geprüft.
     */
    const kante = 128;
    const urbild = maske(kante, kante, 30, 30, 48, 48);
    const schritt = { s: 1, w: 0, tx: -0.5, ty: 0, sicher: 9 };
    let kette = LAGE_RUHE;
    for (let i = 0; i < 30; i += 1) kette = lageVerketten(kette, schritt);
    const gezogen = maskeZiehen(urbild, kante, kante, kette, 1);
    const a = schwerpunkt(urbild, kante);
    const b = schwerpunkt(gezogen, kante);
    expect(b.x - a.x).toBeCloseTo(15, 0);
    expect(b.flaeche / a.flaeche).toBeGreaterThan(0.97);
  });

  it('zieht am Bildrand keinen Streifen hinter sich her', () => {
    const kante = 64;
    const voll = new Uint8Array(kante * kante).fill(255);
    const gezogen = maskeZiehen(voll, kante, kante, { s: 1, w: 0, tx: -8, ty: 0, sicher: 9 }, 1);
    for (let y = 0; y < kante; y += 1) {
      expect(gezogen[y * kante], `Zeile ${y} links`).toBe(0);
      expect(gezogen[y * kante + (kante - 1)], `Zeile ${y} rechts`).toBe(255);
    }
  });

  it('mischt die Nachbarn, statt den nächsten zu nehmen', () => {
    const kante = 32;
    const feld = new Uint8Array(kante * kante);
    for (let y = 0; y < kante; y += 1) {
      for (let x = 16; x < kante; x += 1) feld[y * kante + x] = 255;
    }
    const gezogen = maskeZiehen(feld, kante, kante, { s: 1, w: 0, tx: 0.5, ty: 0, sicher: 9 }, 1);
    expect(Array.from(gezogen).filter((wert) => wert > 0 && wert < 255).length).toBeGreaterThan(0);
  });

  it('bleibt ein Block gross, auch wenn das Bild kein Vielfaches davon ist', () => {
    // Ohne Aufrunden bliebe rechts ein Streifen ohne Vektor.
    const feld = bewegung(graustufen(muster(100)), graustufen(muster(100)), 100);
    expect(feld.spalten).toBe(Math.ceil(feld.grauBreite / BLOCK));
  });
});

describe('maskePasst', () => {
  /** Eine Maske mit einem Rechteck der gegebenen Grösse. */
  function fleck(kante: number, w: number, h: number): Uint8Array {
    const raus = new Uint8Array(kante * kante);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) raus[y * kante + x] = 255;
    }
    return raus;
  }

  it('lässt eine Maske durch, die zur Erwartung passt', () => {
    const a = fleck(64, 30, 30);
    const b = fleck(64, 32, 31);
    expect(maskePasst(b, a).haelt).toBe(true);
  });

  it('verwirft eine Maske, die aufplatzt', () => {
    /*
     * Genau der gemessene Fall: Am Film eines Anwenders sprang die
     * abgedunkelte Fläche auf jedem vierten Bild von 4 % auf 56 % – um den
     * Faktor dreizehn. Der Nutzer sah das als „der markierte Bereich bleibt
     * nicht dort, wo er soll".
     */
    const klein = fleck(64, 16, 16);
    const riesig = fleck(64, 60, 60);
    const befund = maskePasst(riesig, klein);
    expect(befund.haelt).toBe(false);
    expect(befund.verhaeltnis).toBeGreaterThan(3);
  });

  it('verwirft eine Maske, die auf einmal leer ist', () => {
    // Genauso verdächtig wie eine, die platzt – nur fällt sie weniger auf.
    expect(maskePasst(new Uint8Array(64 * 64), fleck(64, 30, 30)).haelt).toBe(false);
  });

  it('verwirft eine Maske, die woanders sitzt', () => {
    /*
     * Gleiche Fläche, kein gemeinsamer Punkt. Ein Flächenvergleich allein
     * liesse das durch – und genau so wandert eine Maske vom Motiv auf den
     * Hintergrund, ohne dass eine Zahl sich ändert.
     */
    const links = fleck(64, 20, 20);
    const rechts = new Uint8Array(64 * 64);
    for (let y = 40; y < 60; y += 1) for (let x = 40; x < 60; x += 1) rechts[y * 64 + x] = 255;
    const befund = maskePasst(rechts, links);
    expect(befund.haelt).toBe(false);
    expect(befund.deckung).toBe(0);
  });

  it('lässt beim ERSTEN Schlüsselbild alles durch', () => {
    // Dort gibt es nichts zu vergleichen. Eine Maske abzulehnen, weil noch
    // keine da war, wäre der sicherste Weg, gar keine zu bekommen.
    expect(maskePasst(fleck(64, 60, 60), null).haelt).toBe(true);
  });

  it('zählt ab halber Deckung, nicht ab jedem Hauch', () => {
    // Beide Masken haben weiche Ränder; ein Rand zählte sonst als halbe
    // Fläche mit, und das Verhältnis wäre von der Kantenlänge bestimmt.
    const hauch = new Uint8Array(64 * 64).fill(40);
    expect(maskePasst(hauch, new Uint8Array(64 * 64)).haelt).toBe(true);
  });
});

describe('zeitlichGlaetten', () => {
  it('nimmt einen einzelnen Ausreisser heraus', () => {
    /*
     * Genau der Fall, um den es geht: Das Netz trifft in einem Bild von
     * dreien daneben. Ungeglättet blitzt dort ein Loch auf.
     */
    const voll = () => new Uint8Array([255, 255]);
    const loch = new Uint8Array([0, 0]);
    const geglaettet = zeitlichGlaetten([voll(), loch, voll()]);
    expect(geglaettet[1][0]).toBeGreaterThan(100);
    expect(geglaettet[1][0]).toBeLessThan(255);
  });

  it('lässt eine ruhige Folge unverändert', () => {
    // Sonst kostete das Glätten bei einer Einstellung ohne Bewegung Schärfe,
    // ohne irgendetwas zu gewinnen.
    const folge = [new Uint8Array([200, 10]), new Uint8Array([200, 10]), new Uint8Array([200, 10])];
    for (const maske of zeitlichGlaetten(folge)) expect(Array.from(maske)).toEqual([200, 10]);
  });

  it('kommt mit dem ersten und dem letzten Bild zurecht', () => {
    // Am Rand gibt es nur einen Nachbarn. Wer dort über ein halb leeres
    // Fenster mittelt, macht den ersten Rand blasser als alle anderen.
    const folge = [new Uint8Array([255]), new Uint8Array([255]), new Uint8Array([255])];
    const geglaettet = zeitlichGlaetten(folge);
    expect(geglaettet[0][0]).toBe(255);
    expect(geglaettet[2][0]).toBe(255);
  });

  it('gibt bei Fenster eins Kopien zurück und nicht dieselben Felder', () => {
    // Sonst schriebe ein späterer Schritt in die Masken, die der Aufrufer
    // noch hält.
    const urbild = new Uint8Array([7]);
    const raus = zeitlichGlaetten([urbild], 1);
    expect(raus[0]).not.toBe(urbild);
    expect(raus[0][0]).toBe(7);
  });

  it('kommt mit gar nichts zurecht', () => {
    expect(zeitlichGlaetten([])).toEqual([]);
  });
});

describe('zeitlichGlaetten an einer Schnittkante', () => {
  const voll = (wert: number) => new Uint8Array(4).fill(wert);

  it('mittelt ohne Schnitt über die Nachbarn', () => {
    const folge = [voll(0), voll(0), voll(255), voll(255)];
    const raus = zeitlichGlaetten(folge);
    // Bild 1 sieht 0, 0, 255 – also 85.
    expect(raus[1][0]).toBe(85);
  });

  it('mittelt NICHT über eine Schnittkante hinweg', () => {
    /*
     * Über einen Schnitt zu mitteln hiesse, die Maske der einen Szene in die
     * andere hineinzurechnen: Am Schnitt stünde für ein Bild eine Maske, die
     * zu keinem der beiden Bilder gehört – ein Geist der vorigen Einstellung.
     */
    const folge = [voll(0), voll(0), voll(255), voll(255)];
    const raus = zeitlichGlaetten(folge, 3, new Set([2]));
    expect(raus[1][0]).toBe(0);
    expect(raus[2][0]).toBe(255);
  });

  it('glättet innerhalb eines Stücks weiter', () => {
    const folge = [voll(0), voll(255), voll(0), voll(90), voll(120), voll(150)];
    const raus = zeitlichGlaetten(folge, 3, new Set([3]));
    // Bild 1 liegt im ersten Stück und sieht 0, 255, 0 – also 85.
    expect(raus[1][0]).toBe(85);
    // Bild 4 liegt im zweiten Stück und sieht 90, 120, 150 – also 120.
    expect(raus[4][0]).toBe(120);
  });
});

/** Ein Rechteckbild mit Struktur, Hintergrund bei `hx`, ein Kasten an (kx, ky). */
function szene(breite: number, hoehe: number, hx: number, kx: number, ky: number): ImageData {
  const daten = new Uint8ClampedArray(breite * hoehe * 4);
  for (let y = 0; y < hoehe; y += 1) {
    for (let x = 0; x < breite; x += 1) {
      const at = (y * breite + x) * 4;
      const sx = x - hx;
      let wert = 128 + 70 * Math.sin(sx / 4.1 + Math.cos(y / 6.7)) * Math.cos(y / 3.9 - sx / 11);
      if (x >= kx && x < kx + 60 && y >= ky && y < ky + 60) {
        // Ein eigenes, sich nicht wiederholendes Muster – ein periodisches
        // passte bei mehreren Versätzen gleich gut.
        const ox = x - kx;
        const oy = y - ky;
        wert = 128 + 90 * Math.sin(ox / 5.1 + Math.cos(oy / 3.7)) * Math.cos(oy / 7.3 - ox / 13);
      }
      daten[at] = wert;
      daten[at + 1] = wert;
      daten[at + 2] = wert;
      daten[at + 3] = 255;
    }
  }
  return { data: daten, width: breite, height: hoehe, colorSpace: 'srgb' } as ImageData;
}

describe('lageRobust', () => {
  it('sieht bei ruhender Kamera keine Bewegung, auch wenn ein Gegenstand durchs Bild läuft', () => {
    /*
     * Der Fall, an dem `lageSchaetzen` die Kamera mit dem Gegenstand
     * verwechselt: Nur der Kasten hat sich bewegt, also zählte nur er. Hier
     * stimmen die ruhenden Hintergrundblöcke mit.
     */
    const vorher = graustufen(szene(320, 180, 0, 100, 60));
    const nachher = graustufen(szene(320, 180, 0, 108, 60));
    const feld = bewegung(vorher, nachher, 320);
    const alt = lageSchaetzen(feld);
    expect(Math.abs(alt.tx), 'die alte Schätzung folgt dem Kasten').toBeGreaterThan(3);
    const neu = lageRobust(feld);
    expect(neu).not.toBeNull();
    expect(lageRuht(neu?.lage ?? LAGE_RUHE)).toBe(true);
  });

  it('findet einen Schwenk des ganzen Bildes', () => {
    const vorher = graustufen(szene(320, 180, 0, 100, 60));
    const nachher = graustufen(szene(320, 180, 5, 105, 60));
    const neu = lageRobust(bewegung(vorher, nachher, 320));
    expect(neu?.lage.tx).toBeCloseTo(-5, 0);
    expect(neu?.lage.ty).toBeCloseTo(0, 0);
  });

  it('findet die Bewegung des Gegenstandes, wenn nur seine Blöcke zählen', () => {
    const vorher = graustufen(szene(320, 180, 0, 96, 48));
    const nachher = graustufen(szene(320, 180, 0, 104, 48));
    const feld = bewegung(vorher, nachher, 320);
    // Die Blöcke, die ganz im Kasten des NEUEN Bildes liegen.
    const gewicht = new Float32Array(feld.spalten * feld.zeilen);
    for (let bz = 0; bz < feld.zeilen; bz += 1) {
      for (let bs = 0; bs < feld.spalten; bs += 1) {
        const x0 = bs * 24;
        const y0 = bz * 24;
        if (x0 >= 104 && x0 + 24 <= 164 && y0 >= 48 && y0 + 24 <= 108)
          gewicht[bz * feld.spalten + bs] = 1;
      }
    }
    const neu = lageRobust(feld, gewicht);
    expect(neu?.lage.tx).toBeCloseTo(-8, 0);
  });

  it('gibt ohne aussagekräftige Blöcke null zurück, statt Ruhe zu behaupten', () => {
    const glatt = {
      data: new Uint8ClampedArray(64 * 64 * 4).fill(128),
      width: 64,
      height: 64,
      colorSpace: 'srgb',
    } as ImageData;
    expect(lageRobust(bewegung(graustufen(glatt), graustufen(glatt), 64))).toBeNull();
  });
});

describe('bewegung bei hochkant gehaltenem Telefon', () => {
  it('findet eine grosse Verschiebung auch, wenn das Bild höher als breit ist', () => {
    /*
     * Die grobe Stufe hing an der Breite. Hochkant (540 × 960) fiel sie weg,
     * und die Reichweite schrumpfte auf ±25 Bildpunkte – nachgemessen kam
     * eine Verschiebung um 45 als −3,4 heraus.
     */
    const hochkant = (vx: number) => {
      const b = 540;
      const h = 960;
      const daten = new Uint8ClampedArray(b * h * 4);
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < b; x += 1) {
          const qx = x - vx;
          const at = (y * b + x) * 4;
          const wert =
            128 + 80 * Math.sin(qx / 9.7 + Math.cos(y / 17)) * Math.cos(y / 12.3 - qx / 31);
          daten[at] = wert;
          daten[at + 1] = wert;
          daten[at + 2] = wert;
          daten[at + 3] = 255;
        }
      }
      return { data: daten, width: b, height: h, colorSpace: 'srgb' } as ImageData;
    };
    const feld = bewegung(graustufen(hochkant(0)), graustufen(hochkant(45)), 540);
    const lage = lageRobust(feld)?.lage ?? LAGE_RUHE;
    // In Bildpunkten: tx ist in Graupunkten, `faktor` rechnet zurück.
    expect(lage.tx * feld.faktor).toBeCloseTo(-45, -0.5);
  });
});

describe('lageRobust nach der Gegenlesung', () => {
  /** Ein Bild, dessen Hintergrund um `hx` verschoben ist; oben ein Band nur aus waagrechten Streifen. */
  function mitStreifen(hx: number, anteil: number): ImageData {
    const breite = 320;
    const hoehe = 180;
    const daten = new Uint8ClampedArray(breite * hoehe * 4);
    for (let y = 0; y < hoehe; y += 1) {
      for (let x = 0; x < breite; x += 1) {
        const sx = x - hx;
        const wert =
          y < hoehe * anteil
            ? // Ein Regal, eine Jalousie: nur senkrechte Veränderung.
              128 + 80 * Math.sin(y / 2.3)
            : 128 + 70 * Math.sin(sx / 4.1 + Math.cos(y / 6.7)) * Math.cos(y / 3.9 - sx / 11);
        const at = (y * breite + x) * 4;
        daten[at] = wert;
        daten[at + 1] = wert;
        daten[at + 2] = wert;
        daten[at + 3] = 255;
      }
    }
    return { data: daten, width: breite, height: hoehe, colorSpace: 'srgb' } as ImageData;
  }

  it('lässt Blöcke mit Struktur in nur einer Richtung nicht für Stillstand stimmen', () => {
    /*
     * Bei einem waagrechten Schwenk passt ein Block aus waagrechten
     * Streifen an jeder Stelle gleich gut und bleibt bei (0, 0). Zählte er
     * als „ruhend mit Struktur", gewänne bei 60 % Streifen der Stillstand –
     * nachgemessen kam genau null heraus statt des Schwenks.
     */
    for (const anteil of [0.5, 0.6, 0.7]) {
      const feld = bewegung(
        graustufen(mitStreifen(0, anteil)),
        graustufen(mitStreifen(6, anteil)),
        320,
      );
      const lage = lageRobust(feld)?.lage;
      expect(lage?.tx ?? 0, `Streifenanteil ${anteil}`).toBeCloseTo(-6, 0);
    }
  });

  it('wählt bei zwei gleich grossen Gruppen EINE – nicht ihr Mittel', () => {
    /*
     * Eine Mitzieh-Aufnahme: links steht der Gegenstand still im Bild,
     * rechts zieht der Hintergrund vorbei. Der Median lag zwischen beiden,
     * und heraus kam eine Bewegung, die zu keiner Hälfte passte.
     */
    const szeneHaelfte = (hx: number) => {
      const breite = 320;
      const hoehe = 180;
      const daten = new Uint8ClampedArray(breite * hoehe * 4);
      for (let y = 0; y < hoehe; y += 1) {
        for (let x = 0; x < breite; x += 1) {
          const links = x < breite / 2;
          const sx = links ? x : x - hx;
          const wert = links
            ? 128 + 90 * Math.sin(sx / 5.1 + Math.cos(y / 3.7)) * Math.cos(y / 7.3 - sx / 13)
            : 128 + 70 * Math.sin(sx / 4.1 + Math.cos(y / 6.7)) * Math.cos(y / 3.9 - sx / 11);
          const at = (y * breite + x) * 4;
          daten[at] = wert;
          daten[at + 1] = wert;
          daten[at + 2] = wert;
          daten[at + 3] = 255;
        }
      }
      return { data: daten, width: breite, height: hoehe, colorSpace: 'srgb' } as ImageData;
    };
    const feld = bewegung(graustufen(szeneHaelfte(0)), graustufen(szeneHaelfte(6)), 320);
    const lage = lageRobust(feld)?.lage ?? LAGE_RUHE;
    const naechste = Math.min(Math.abs(lage.tx), Math.abs(lage.tx + 6));
    expect(naechste, `tx ${lage.tx.toFixed(2)}`).toBeLessThan(0.5);
    expect(Math.hypot(lage.s, lage.w)).toBeCloseTo(1, 2);
  });
});

describe('bewegung bei kleinen Schritten hochkant', () => {
  it('lässt eine kleine Verschiebung nicht von der groben Stufe verwürfeln', () => {
    /*
     * Seit auch hochkant grob gesucht wird, sprangen einzelne Randblöcke auf
     * zwanzig Graupunkte daneben, und die einfache Schätzung (die das GIF
     * benutzt) mittelte sie mit. Weiches Rauschen als Bild.
     */
    const breite = 540;
    const hoehe = 960;
    const rauschen = new Float32Array((breite + 40) * (hoehe + 40));
    // Ein ordentlicher Zufall (mulberry32): Ein einfacher Kongruenzgenerator
    // legt ein Gitter ins Rauschen, und die Suche fände dessen Wiederholung.
    let saat = 12345;
    for (let i = 0; i < rauschen.length; i += 1) {
      saat = (saat + 0x6d2b79f5) | 0;
      let t = Math.imul(saat ^ (saat >>> 15), 1 | saat);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      rauschen[i] = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    const rb = breite + 40;
    const weich = (x: number, y: number) => {
      let summe = 0;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) summe += rauschen[(y + dy) * rb + x + dx];
      }
      return summe / 25;
    };
    const bildMit = (vx: number, vy: number) => {
      const daten = new Uint8ClampedArray(breite * hoehe * 4);
      for (let y = 0; y < hoehe; y += 1) {
        for (let x = 0; x < breite; x += 1) {
          const wert = 40 + 400 * (weich(x - vx + 20, y - vy + 20) - 0.5) + 88;
          const at = (y * breite + x) * 4;
          daten[at] = wert;
          daten[at + 1] = wert;
          daten[at + 2] = wert;
          daten[at + 3] = 255;
        }
      }
      return { data: daten, width: breite, height: hoehe, colorSpace: 'srgb' } as ImageData;
    };
    // Gemessen vorher: 0,9 und 2,3 Punkte; im Querformat vor dieser Fassung
    // 4,9 und 2,4. Und eine Verschiebung um 45 Punkte hochkant: 40 statt 0.
    for (const [vx, vy] of [
      [4, -3],
      [10, 6],
      [0, 45],
    ]) {
      const feld = bewegung(graustufen(bildMit(0, 0)), graustufen(bildMit(vx, vy)), breite);
      const lage = lageSchaetzen(feld);
      let fehler = 0;
      let zahl = 0;
      for (let y = 100; y < hoehe - 100; y += 60) {
        for (let x = 100; x < breite - 100; x += 60) {
          const q = punktZurueck(lage, feld.faktor, x, y);
          fehler += Math.hypot(q.x - (x - vx), q.y - (y - vy));
          zahl += 1;
        }
      }
      expect(fehler / zahl, `(${vx}, ${vy})`).toBeLessThan(0.8);
    }
  });
});
