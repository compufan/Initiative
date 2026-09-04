import { describe, expect, it } from 'vitest';
import {
  BEREICH_NEUTRAL,
  ansichtAlsZuschnitt,
  ansichtGroesse,
  aufVerhaeltnis,
  ausgabeGroesse,
  docKopie,
  docUnberuehrt,
  nachAnsicht,
  nachOriginal,
  neuesDoc,
  weiterdrehen,
  zuschnittHalten,
  zuschnittInAnsicht,
  type BildDoc,
  type Drehung,
  type Maskenteil,
} from './doc.js';

const W = 400;
const H = 300;

function doc(drehung: Drehung, spiegel = false): BildDoc {
  return { ...neuesDoc(W, H), drehung, spiegel };
}

describe('Drehen und Spiegeln', () => {
  it('tauscht die Kanten nur beim Hochkantdrehen', () => {
    expect(ansichtGroesse(W, H, 0)).toEqual({ w: 400, h: 300 });
    expect(ansichtGroesse(W, H, 90)).toEqual({ w: 300, h: 400 });
    expect(ansichtGroesse(W, H, 180)).toEqual({ w: 400, h: 300 });
    expect(ansichtGroesse(W, H, 270)).toEqual({ w: 300, h: 400 });
  });

  it('schiebt die linke obere Ecke im Uhrzeigersinn herum', () => {
    const ecke = { x: 0, y: 0 };
    expect(nachAnsicht(ecke, W, H, doc(0))).toEqual({ x: 0, y: 0 });
    // 90 Grad im Uhrzeigersinn: oben links landet oben rechts, und die neue
    // Breite ist die alte Hoehe.
    expect(nachAnsicht(ecke, W, H, doc(90))).toEqual({ x: 300, y: 0 });
    expect(nachAnsicht(ecke, W, H, doc(180))).toEqual({ x: 400, y: 300 });
    expect(nachAnsicht(ecke, W, H, doc(270))).toEqual({ x: 0, y: 400 });
  });

  it('findet für jeden Punkt wieder zurück', () => {
    const punkte = [
      { x: 0, y: 0 },
      { x: 400, y: 300 },
      { x: 137, y: 42 },
    ];
    for (const drehung of [0, 90, 180, 270] as Drehung[]) {
      for (const spiegel of [false, true]) {
        for (const p of punkte) {
          const hin = nachAnsicht(p, W, H, doc(drehung, spiegel));
          const zurueck = nachOriginal(hin, W, H, doc(drehung, spiegel));
          expect(zurueck.x).toBeCloseTo(p.x, 6);
          expect(zurueck.y).toBeCloseTo(p.y, 6);
        }
      }
    }
  });

  it('spiegelt waagerecht, nicht senkrecht', () => {
    expect(nachAnsicht({ x: 0, y: 50 }, W, H, doc(0, true))).toEqual({ x: 400, y: 50 });
  });

  it('dreht in beide Richtungen und bleibt im Bereich', () => {
    expect(weiterdrehen(0, 1)).toBe(90);
    expect(weiterdrehen(270, 1)).toBe(0);
    expect(weiterdrehen(0, -1)).toBe(270);
    expect(weiterdrehen(90, -3)).toBe(180);
  });
});

describe('Zuschnitt', () => {
  it('bleibt im Bild, auch wenn man ihn hinausschiebt', () => {
    expect(zuschnittHalten({ x: -50, y: -50, w: 100, h: 100 }, W, H)).toEqual({
      x: 0,
      y: 0,
      w: 100,
      h: 100,
    });
    expect(zuschnittHalten({ x: 9999, y: 9999, w: 100, h: 100 }, W, H)).toEqual({
      x: 300,
      y: 200,
      w: 100,
      h: 100,
    });
  });

  it('wird nicht kleiner beim Verschieben, sondern nur zurückgeschoben', () => {
    // Ein zu breites Rechteck wird auf Bildbreite gestutzt und liegt dann bei 0 –
    // nicht bei 0 mit halber Breite.
    const gehalten = zuschnittHalten({ x: 200, y: 0, w: 9999, h: 100 }, W, H);
    expect(gehalten).toEqual({ x: 0, y: 0, w: 400, h: 100 });
  });

  it('dreht mit dem Bild mit', () => {
    // Ein Streifen am linken Rand liegt nach 90 Grad oben.
    const streifen = { x: 0, y: 0, w: 40, h: 300 };
    const inAnsicht = zuschnittInAnsicht(streifen, W, H, doc(90));
    expect(inAnsicht).toEqual({ x: 0, y: 0, w: 300, h: 40 });
  });

  it('nimmt ein in der Ansicht gezogenes Rechteck entgegen', () => {
    const gezogen = { x: 0, y: 0, w: 300, h: 40 };
    const amOriginal = ansichtAlsZuschnitt(gezogen, W, H, doc(90));
    expect(amOriginal).toEqual({ x: 0, y: 0, w: 40, h: 300 });
  });

  it('verkleinert auf ein festes Verhältnis, statt zu wachsen', () => {
    const quadrat = aufVerhaeltnis({ x: 0, y: 0, w: 400, h: 300 }, 1, W, H);
    expect(quadrat.w).toBe(300);
    expect(quadrat.h).toBe(300);
    // Der Mittelpunkt bleibt, wo er war.
    expect(quadrat.x + quadrat.w / 2).toBeCloseTo(200, 6);
  });

  it('bekommt auch ein breites Verhältnis in ein schmales Bild', () => {
    const breit = aufVerhaeltnis({ x: 0, y: 0, w: 300, h: 400 }, 16 / 9, 300, 400);
    expect(breit.w).toBeLessThanOrEqual(300);
    expect(breit.h).toBeLessThanOrEqual(400);
    expect(breit.w / breit.h).toBeCloseTo(16 / 9, 6);
  });
});

describe('Ausgabegrösse', () => {
  it('lässt kleine Bilder in Ruhe', () => {
    expect(ausgabeGroesse({ x: 0, y: 0, w: 400, h: 300 }, 0)).toEqual({
      w: 400,
      h: 300,
      faktor: 1,
    });
  });

  it('begrenzt die längste Kante und behält das Verhältnis', () => {
    const gross = ausgabeGroesse({ x: 0, y: 0, w: 8000, h: 4000 }, 0, 2560);
    expect(gross.w).toBe(2560);
    expect(gross.h).toBe(1280);
  });

  it('rechnet die Drehung mit ein, nicht nur den Ausschnitt', () => {
    const hochkant = ausgabeGroesse({ x: 0, y: 0, w: 400, h: 300 }, 90);
    expect(hochkant).toEqual({ w: 300, h: 400, faktor: 1 });
  });
});

describe('Bereiche im Dokument', () => {
  /** Ein Bereich mit einem Netzteil – dem grössten, das es gibt. */
  function mitBereich(): BildDoc {
    const doc = neuesDoc(4000, 3000);
    const netz: Maskenteil = {
      id: 't1',
      modus: 'dazu',
      umkehren: false,
      art: 'netz',
      netz: 'object',
      breite: 4,
      hoehe: 4,
      alpha: new Uint8Array(16).fill(200),
      marke: 1,
    };
    return {
      ...doc,
      bereiche: [
        {
          id: 'b1',
          name: 'Motiv',
          aktiv: true,
          teile: [netz],
          anpassung: { ...BEREICH_NEUTRAL, belichtung: 0.5 },
        },
      ],
    };
  }

  it('legt ein neues Dokument ohne Bereiche an', () => {
    expect(neuesDoc(100, 80).bereiche).toEqual([]);
  });

  it('nimmt die Bereiche in die Kopie mit', () => {
    // Die Falle, die erst beim ersten Rückgängig auffiele: Ein vergessenes
    // Feld in `docKopie` löscht die Bereiche lautlos, sobald jemand einen
    // Schritt zurückgeht.
    const kopie = docKopie(mitBereich());
    expect(kopie.bereiche).toHaveLength(1);
    expect(kopie.bereiche[0].name).toBe('Motiv');
    expect(kopie.bereiche[0].anpassung.belichtung).toBe(0.5);
  });

  it('teilt die Maskenteile per Referenz und kopiert die Regler', () => {
    /*
     * Der Unterschied ist Speicher, und zwar viel: Ein Netzteil ist bei einem
     * Handyfoto bis zu 1,8 MB gross, der Verlauf fasst 25 Schritte, und es
     * dürfen vier Bereiche sein. Tief kopiert wären das 180 MB für nichts –
     * die Teile werden nie an Ort und Stelle geändert.
     *
     * Die Regler dagegen MÜSSEN kopiert werden: An ihnen wird gedreht.
     */
    const doc = mitBereich();
    const kopie = docKopie(doc);
    expect(kopie.bereiche[0].teile).toBe(doc.bereiche[0].teile);
    expect(kopie.bereiche[0].anpassung).not.toBe(doc.bereiche[0].anpassung);
    expect(kopie.bereiche[0]).not.toBe(doc.bereiche[0]);
    expect(kopie.bereiche).not.toBe(doc.bereiche);
  });

  it('lässt eine Änderung an der Kopie das Original in Ruhe', () => {
    const doc = mitBereich();
    const kopie = docKopie(doc);
    kopie.bereiche[0].anpassung.belichtung = -2;
    kopie.bereiche[0].name = 'anders';
    kopie.bereiche.push({ ...kopie.bereiche[0], id: 'b2' });
    expect(doc.bereiche[0].anpassung.belichtung).toBe(0.5);
    expect(doc.bereiche[0].name).toBe('Motiv');
    expect(doc.bereiche).toHaveLength(1);
  });

  it('legt über fünfundzwanzig Verlaufsschritte kein zweites Maskenfeld an', () => {
    // 25 ist `VERLAUF_MAX` im Editor. Die Prüfung ist der Grund, warum die
    // Teile per Referenz wandern.
    const doc = mitBereich();
    const alpha = (doc.bereiche[0].teile[0] as { alpha: Uint8Array }).alpha;
    let jetzt = doc;
    for (let i = 0; i < 25; i += 1) jetzt = docKopie(jetzt);
    expect((jetzt.bereiche[0].teile[0] as { alpha: Uint8Array }).alpha).toBe(alpha);
  });

  it('gilt mit einem Bereich nicht mehr als unberührt', () => {
    // Sonst behauptete der Editor „Noch nichts geändert – gespeichert würde
    // eine Kopie des Originals“ für ein Bild mit vier örtlichen Anpassungen.
    expect(docUnberuehrt(neuesDoc(4000, 3000), 4000, 3000)).toBe(true);
    expect(docUnberuehrt(mitBereich(), 4000, 3000)).toBe(false);
  });
});
