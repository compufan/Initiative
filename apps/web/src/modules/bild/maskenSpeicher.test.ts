import { beforeEach, describe, expect, it } from 'vitest';
import { NEUTRAL, tonSchluessel } from './ton.js';
import { BEREICH_NEUTRAL, neuesDoc, type Bereich, type BildDoc, type Maskenteil } from './doc.js';
import {
  speicherLeeren,
  szeneBauen,
  szeneNeutral,
  szeneSchluessel,
  zaehler,
} from './maskenSpeicher.js';

const B = 800;
const H = 600;

function verlauf(id = 'v1'): Maskenteil {
  return {
    id,
    modus: 'dazu',
    umkehren: false,
    art: 'verlauf',
    von: { x: 0, y: 0 },
    bis: { x: 0, y: H },
  };
}

function bereich(patch: Partial<Bereich> = {}): Bereich {
  return {
    id: 'b1',
    name: 'Verlauf 1',
    aktiv: true,
    teile: [verlauf()],
    anpassung: { ...BEREICH_NEUTRAL, belichtung: 0.5 },
    ...patch,
  };
}

function doc(bereiche: Bereich[]): BildDoc {
  return { ...neuesDoc(B, H), bereiche };
}

describe('szeneBauen', () => {
  beforeEach(speicherLeeren);

  it('rastert eine Maske genau einmal, egal wie oft man fragt', () => {
    const d = doc([bereich()]);
    szeneBauen(d, B, H);
    const nachErstem = { ...zaehler };
    szeneBauen(d, B, H);
    szeneBauen(d, B, H);
    expect(zaehler).toEqual(nachErstem);
  });

  it('kostet einen Reglerzug keine einzige gerasterte Maske', () => {
    /*
     * Der ganze Zweck dieser Datei. Der Zwischenspeicher hängt an der
     * IDENTITÄT des `teile`-Feldes, und `docKopie` reicht sie ausdrücklich
     * per Referenz weiter – ändert sich nur ein Regler, ist es dasselbe
     * Objekt.
     *
     * Mutation: den Zettel am Bereichsobjekt statt am `teile`-Feld aufhängen.
     * Dann verfehlt er bei jeder Reglerraste, und jedes Bild rastert bei vier
     * Bereichen über drei Millionen Rasterpunkte neu.
     */
    const teile = [verlauf()];
    const erste = doc([bereich({ teile })]);
    szeneBauen(erste, B, H);
    const vorher = { teile: zaehler.teile, falten: zaehler.falten };

    for (let i = 1; i <= 20; i += 1) {
      const gezogen = doc([
        bereich({ teile, anpassung: { ...BEREICH_NEUTRAL, belichtung: i / 20 } }),
      ]);
      szeneBauen(gezogen, B, H);
    }
    expect(zaehler.teile).toBe(vorher.teile);
    expect(zaehler.falten).toBe(vorher.falten);
  });

  it('lässt den Maskenstand beim Reglerzug stehen und ändert den Schlüssel doch', () => {
    const teile = [verlauf()];
    const a = szeneBauen(doc([bereich({ teile })]), B, H);
    const b = szeneBauen(
      doc([bereich({ teile, anpassung: { ...BEREICH_NEUTRAL, belichtung: 0.9 } })]),
      B,
      H,
    );
    expect(b.bereiche[0].maske.stand).toBe(a.bereiche[0].maske.stand);
    expect(b.schluessel).not.toBe(a.schluessel);
  });

  it('rastert neu, sobald sich ein Teil wirklich ändert', () => {
    const a = szeneBauen(doc([bereich()]), B, H);
    const vorher = zaehler.teile;
    const anders: Maskenteil = {
      id: 'v1',
      modus: 'dazu',
      umkehren: false,
      art: 'verlauf',
      von: { x: 0, y: 0 },
      bis: { x: 0, y: H / 2 },
    };
    const b = szeneBauen(doc([bereich({ teile: [anders] })]), B, H);
    expect(zaehler.teile).toBeGreaterThan(vorher);
    expect(b.bereiche[0].maske.stand).not.toBe(a.bereiche[0].maske.stand);
  });

  it('lässt abgeschaltete, leere und farbneutrale Bereiche weg', () => {
    const d = doc([
      bereich({ id: 'aus', aktiv: false }),
      bereich({ id: 'leer', teile: [] }),
      bereich({ id: 'neutral', anpassung: { ...BEREICH_NEUTRAL } }),
      bereich({ id: 'wirkt' }),
    ]);
    const szene = szeneBauen(d, B, H);
    expect(szene.bereiche.map((b) => b.id)).toEqual(['wirkt']);
  });

  it('behält einen Bereich, der nur Unschärfe einstellt', () => {
    // Die Falle: Seine neun Farbregler stehen alle auf null. Wer nur die
    // Farbe prüft, wirft das Bokeh weg.
    const d = doc([bereich({ id: 'bokeh', anpassung: { ...BEREICH_NEUTRAL, unschaerfe: 0.8 } })]);
    expect(szeneBauen(d, B, H).bereiche.map((b) => b.id)).toEqual(['bokeh']);
  });

  it('behält die Reihenfolge der übrigen Bereiche', () => {
    const d = doc([
      bereich({ id: 'eins' }),
      bereich({ id: 'aus', aktiv: false }),
      bereich({ id: 'zwei' }),
    ]);
    expect(szeneBauen(d, B, H).bereiche.map((b) => b.id)).toEqual(['eins', 'zwei']);
  });
});

describe('szeneSchluessel', () => {
  beforeEach(speicherLeeren);

  it('ist ohne Bereiche Byte für Byte der alte Tonschlüssel', () => {
    // Damit sich ein Bild ohne örtliche Anpassungen genau wie vorher verhält
    // – derselbe Merkzettel, dieselben Treffer.
    const d = doc([]);
    expect(szeneBauen(d, B, H).schluessel).toBe(tonSchluessel(d.anpassung));
    expect(szeneSchluessel(NEUTRAL, [])).toBe(tonSchluessel(NEUTRAL));
  });

  it('ändert sich bei jedem Regler eines Bereichs', () => {
    /*
     * Ein GETEILTES `teile`-Feld ist hier Bedingung, nicht Bequemlichkeit:
     * Legte jeder Aufruf ein eigenes an, bekäme jede Maske einen neuen Stand,
     * und der Schlüssel unterschiede sich schon deswegen. Die Prüfung sähe
     * grün aus und bewiese über die Regler gar nichts – genau der Fehler, den
     * sie bei anderen finden soll.
     */
    const teile = [verlauf()];
    const grund = szeneBauen(doc([bereich({ teile })]), B, H).schluessel;
    const felder = [
      'belichtung',
      'kontrast',
      'lichter',
      'tiefen',
      'schwarz',
      'waerme',
      'toenung',
      'saettigung',
      'dynamik',
      'unschaerfe',
    ] as const;
    for (const feld of felder) {
      const anders = szeneBauen(
        doc([bereich({ teile, anpassung: { ...BEREICH_NEUTRAL, belichtung: 0.5, [feld]: 0.31 } })]),
        B,
        H,
      ).schluessel;
      expect(anders, `Regler ${feld} steht nicht im Schlüssel`).not.toBe(grund);
    }
  });

  it('ändert sich, wenn zwei Bereiche die Plätze tauschen', () => {
    // Die Reihenfolge ist bildwirksam – jeder Bereich rechnet auf dem
    // Ergebnis des vorigen.
    const a = bereich({ id: 'a', anpassung: { ...BEREICH_NEUTRAL, belichtung: 1 } });
    const b = bereich({
      id: 'b',
      teile: [verlauf('v2')],
      anpassung: { ...BEREICH_NEUTRAL, kontrast: 1 },
    });
    const hin = szeneBauen(doc([a, b]), B, H).schluessel;
    const her = szeneBauen(doc([b, a]), B, H).schluessel;
    expect(hin).not.toBe(her);
  });

  it('ändert sich, wenn sich die Maske ändert – bei gleichen Reglern', () => {
    /*
     * Die Gegenrichtung: Gleiche Regler, andere Maske. Ohne den Stand im
     * Schlüssel bekäme der Renderer denselben und zeigte weiter die alte
     * Maske – der Verlaufsgriff liesse sich ziehen, und im Bild bewegte sich
     * nichts.
     */
    const a = szeneBauen(doc([bereich({ teile: [verlauf()] })]), B, H);
    const anders: Maskenteil = {
      id: 'v1',
      modus: 'dazu',
      umkehren: false,
      art: 'verlauf',
      von: { x: 0, y: 0 },
      bis: { x: B, y: 0 },
    };
    const b = szeneBauen(doc([bereich({ teile: [anders] })]), B, H);
    expect(b.bereiche[0].maske.stand).not.toBe(a.bereiche[0].maske.stand);
    expect(b.schluessel).not.toBe(a.schluessel);
  });

  it('enthält keinen Maskenpuffer, sondern seinen Stand', () => {
    /*
     * Die stillste Falle des ganzen Vorhabens: Ein `Uint8Array` in einer
     * Vorlagenzeichenkette wird zu `[object Object]`. Zwei verschiedene
     * Masken bekämen denselben Schlüssel, und der Merkzettel des Renderers
     * lieferte alte Bildpunkte – ohne Fehlermeldung, ohne Absturz.
     */
    const schluessel = szeneBauen(doc([bereich()]), B, H).schluessel;
    expect(schluessel).not.toContain('[object');
    expect(schluessel.length).toBeLessThan(500);
  });
});

describe('szeneNeutral', () => {
  beforeEach(speicherLeeren);

  it('ist ohne alles wahr', () => {
    expect(szeneNeutral(NEUTRAL, szeneBauen(doc([]), B, H))).toBe(true);
  });

  it('ist mit einem Bereich falsch, auch wenn global nichts eingestellt ist', () => {
    /*
     * Daran hängt mehr als eine gesparte Rechnung: Bei „nichts zu tun“ gibt
     * der Renderer das QUELLBILD selbst zurück, und eine Ebene darüber hängt
     * an genau dieser Objektidentität die Umrechnung der Verpixel-Ausschnitte.
     * Ein Bereich, der hier durchrutscht, liesse einen Balken bei halbem
     * Massstab an der doppelten Stelle lesen.
     */
    expect(szeneNeutral(NEUTRAL, szeneBauen(doc([bereich()]), B, H))).toBe(false);
  });

  it('ist mit einem reinen Unschärfe-Bereich ebenfalls falsch', () => {
    const d = doc([bereich({ anpassung: { ...BEREICH_NEUTRAL, unschaerfe: 1 } })]);
    expect(szeneNeutral(NEUTRAL, szeneBauen(d, B, H))).toBe(false);
  });
});
