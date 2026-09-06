import { describe, expect, it } from 'vitest';
import { messungText, stockungMessen, type Umgebung } from './stockung.js';

/**
 * Eine Uhr, die man von Hand stellt – und Bilder, die man von Hand auslöst.
 *
 * Damit lässt sich genau das nachstellen, worum es geht: ein Hauptfaden, der
 * eine Sekunde lang kein Bild mehr zeichnet.
 */
function pruefstand() {
  let jetzt = 0;
  const wartende: Array<{ kennung: number; rueckruf: () => void }> = [];
  let naechsteKennung = 1;
  let versteckt = false;
  const horcher: Array<() => void> = [];
  const umgebung: Umgebung = {
    uhr: () => jetzt,
    naechstesBild: (rueckruf) => {
      const kennung = naechsteKennung++;
      wartende.push({ kennung, rueckruf });
      return kennung;
    },
    abbrechen: (kennung) => {
      const index = wartende.findIndex((eintrag) => eintrag.kennung === kennung);
      if (index >= 0) wartende.splice(index, 1);
    },
    versteckt: () => versteckt,
    sichtbarkeitBeobachten: (rueckruf) => {
      horcher.push(rueckruf);
      return () => {
        const index = horcher.indexOf(rueckruf);
        if (index >= 0) horcher.splice(index, 1);
      };
    },
  };
  return {
    umgebung,
    /** Die App in den Hintergrund schicken – dann feuert kein Bild mehr. */
    wegschalten() {
      versteckt = true;
      for (const rueckruf of [...horcher]) rueckruf();
    },
    zurueckholen() {
      versteckt = false;
      for (const rueckruf of [...horcher]) rueckruf();
    },
    horcherZahl: () => horcher.length,
    /** Die Zeit weiterdrehen und dann ein Bild zeichnen lassen. */
    bild(nachMs: number) {
      jetzt += nachMs;
      const naechster = wartende.shift();
      naechster?.rueckruf();
    },
    /** Nur die Zeit weiterdrehen – kein Bild. So sieht Blockade aus. */
    warten(ms: number) {
      jetzt += ms;
    },
    offen: () => wartende.length,
  };
}

describe('stockungMessen', () => {
  it('meldet die längste Lücke zwischen zwei Bildern', () => {
    const stand = pruefstand();
    const messer = stockungMessen(stand.umgebung);
    stand.bild(16);
    stand.bild(17);
    stand.bild(950); // hier hat es geruckelt
    stand.bild(16);
    expect(messer.beenden()).toBe(950);
  });

  it('zählt auch die Blockade, nach der gar kein Bild mehr kam', () => {
    const stand = pruefstand();
    const messer = stockungMessen(stand.umgebung);
    stand.bild(16);
    // Der Hauptfaden rechnet bis zum Schluss durch: kein Bild mehr.
    stand.warten(1800);
    // Ohne das Nachmessen in `beenden` käme hier 16 heraus – also genau die
    // Auskunft „alles flüssig“ für den Fall, der am schlimmsten ruckelt.
    expect(messer.beenden()).toBe(1800);
  });

  it('gibt ohne Umgebung 0 zurück, statt zu raten', () => {
    expect(stockungMessen(null).beenden()).toBe(0);
  });

  it('verwirft die Messung, wenn die App zwischendurch im Hintergrund war', () => {
    const stand = pruefstand();
    const messer = stockungMessen(stand.umgebung);
    stand.bild(16);
    // Der Anwender wechselt die App. Der Browser zeichnet nicht mehr, also
    // feuert kein Bild – die Auszeit sähe aus wie eine Blockade, und zwar wie
    // die längste von allen.
    stand.wegschalten();
    stand.warten(50_000);
    stand.zurueckholen();
    stand.bild(16);
    expect(messer.beenden()).toBe(0);
  });

  it('verwirft auch, wenn die Messung im Hintergrund beginnt', () => {
    const stand = pruefstand();
    stand.wegschalten();
    const messer = stockungMessen(stand.umgebung);
    stand.warten(30_000);
    expect(messer.beenden()).toBe(0);
  });

  it('misst normal, wenn die App die ganze Zeit sichtbar war', () => {
    const stand = pruefstand();
    const messer = stockungMessen(stand.umgebung);
    stand.bild(16);
    stand.bild(800);
    expect(messer.beenden()).toBe(800);
  });

  it('meldet sich beim Beenden wieder von der Sichtbarkeit ab', () => {
    const stand = pruefstand();
    const messer = stockungMessen(stand.umgebung);
    expect(stand.horcherZahl()).toBe(1);
    messer.beenden();
    expect(stand.horcherZahl()).toBe(0);
  });

  it('hört nach dem Beenden auf, Bilder anzufordern', () => {
    const stand = pruefstand();
    const messer = stockungMessen(stand.umgebung);
    stand.bild(16);
    messer.beenden();
    expect(stand.offen()).toBe(0);
  });

  it('bleibt nach dem Beenden bei seinem Wert', () => {
    const stand = pruefstand();
    const messer = stockungMessen(stand.umgebung);
    stand.bild(16);
    stand.bild(500);
    const ersteAntwort = messer.beenden();
    stand.warten(9000);
    expect(messer.beenden()).toBe(ersteAntwort);
  });
});

describe('messungText', () => {
  it('nennt Weg, Rechenzeit und Stockung', () => {
    expect(messungText({ weg: 'arbeiter', ladeMs: 0, laufMs: 1800, stockungMs: 33 })).toBe(
      'im Arbeiter, gerechnet 1.8 s, längste Stockung der Oberfläche 33 ms',
    );
  });

  it('lässt die Ladezeit weg, wenn das Modell schon da war', () => {
    const text = messungText({ weg: 'arbeiter', ladeMs: 0, laufMs: 1200, stockungMs: 20 });
    expect(text).not.toContain('geladen');
  });

  it('verschweigt eine nicht gemessene Stockung, statt 0 ms zu behaupten', () => {
    const text = messungText({ weg: 'hauptfaden', ladeMs: 12000, laufMs: 1700, stockungMs: 0 });
    expect(text).toContain('geladen 12.0 s');
    expect(text).not.toContain('Stockung');
  });
});
