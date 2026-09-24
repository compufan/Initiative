import { describe, expect, it } from 'vitest';

import { BEREICHE_MAX, BEREICH_NEUTRAL, neuesDoc } from '../bild/doc.js';
import type { Bereich, BildDoc, Maskenteil } from '../bild/doc.js';
import {
  bereicheAbUebernehmen,
  brauchtBildweise,
  docFuerBild,
  inhaltsTeile,
  istInhaltsTeil,
  zeitraumAktiv,
  type NeueDaten,
} from './bildweise.js';

/**
 * Welche Teile eines Bilddokumentes je Bild neu gerechnet werden müssen – und
 * wie sie wieder hineinkommen.
 *
 * Das ist die Stelle, an der sich ein Fehler am besten versteckt: Ein Teil,
 * das falsch eingesetzt wird, wirft nichts und meldet nichts. Man sieht es
 * am fertigen Film als „der Effekt klebt am ersten Bild" – und sucht dann
 * überall, nur nicht hier.
 */

function netzTeil(id: string, marke = 1): Maskenteil {
  return {
    id,
    modus: 'dazu',
    umkehren: false,
    art: 'netz',
    netz: 'person',
    breite: 4,
    hoehe: 4,
    alpha: new Uint8Array(16).fill(200),
    marke,
  };
}

function tiefenTeil(id: string): Maskenteil {
  return {
    id,
    modus: 'dazu',
    umkehren: false,
    art: 'tiefe',
    breite: 4,
    hoehe: 4,
    karte: new Uint8Array(16).fill(100),
    fokus: 0.5,
    spanne: 0.3,
    marke: 1,
  };
}

function verlaufTeil(id: string): Maskenteil {
  return {
    id,
    modus: 'dazu',
    umkehren: false,
    art: 'verlauf',
    von: { x: 0, y: 0 },
    bis: { x: 10, y: 10 },
  };
}

function docMit(...teile: Maskenteil[]): BildDoc {
  return {
    ...neuesDoc(64, 48),
    bereiche: [{ id: 'b1', name: 'Motiv', aktiv: true, teile, anpassung: BEREICH_NEUTRAL }],
  };
}

describe('istInhaltsTeil', () => {
  it('erkennt die drei Arten, die aus dem Bildinhalt kommen', () => {
    /*
     * Netz, Tiefe und Tipp hängen am, was IM Bild steht. Ein Verlauf oder ein
     * Radial beschreibt eine Form und gilt für jedes Bild gleich – dafür
     * etwas nachzurechnen, wäre reine Arbeit ohne Wirkung.
     */
    expect(istInhaltsTeil(netzTeil('n1'))).toBe(true);
    expect(istInhaltsTeil(tiefenTeil('d1'))).toBe(true);
    expect(istInhaltsTeil(verlaufTeil('v1'))).toBe(false);
  });
});

describe('inhaltsTeile', () => {
  it('nennt jedes Teil mit seinem Bereich', () => {
    // Die Bereichskennung wird zum Wiedereinsetzen gebraucht – ohne sie
    // müsste `docFuerBild` raten, wohin ein Teil gehört.
    const gefunden = inhaltsTeile(docMit(netzTeil('n1'), verlaufTeil('v1'), tiefenTeil('d1')));
    expect(gefunden.map((eintrag) => eintrag.teil.id)).toEqual(['n1', 'd1']);
    expect(gefunden.every((eintrag) => eintrag.bereich === 'b1')).toBe(true);
    expect(gefunden.map((eintrag) => eintrag.art)).toEqual(['netz', 'tiefe']);
  });

  it('übergeht abgeschaltete Bereiche', () => {
    /*
     * Ein Bereich ohne Haken wirkt nicht. Sein Netz trotzdem über fünfzig
     * Bilder laufen zu lassen, wären bei „Genau" anderthalb Minuten für
     * nichts – und zwar mit laufendem Balken, als geschähe etwas Nötiges.
     */
    const doc = docMit(netzTeil('n1'));
    const aus = { ...doc, bereiche: [{ ...doc.bereiche[0], aktiv: false }] };
    expect(inhaltsTeile(aus)).toEqual([]);
    expect(brauchtBildweise(aus)).toBe(false);
  });

  it('sagt bei einem Dokument ohne solche Teile, dass nichts zu tun ist', () => {
    expect(brauchtBildweise(docMit(verlaufTeil('v1')))).toBe(false);
    expect(brauchtBildweise(neuesDoc(64, 48))).toBe(false);
  });
});

describe('docFuerBild', () => {
  it('setzt neue Maskenwerte ein', () => {
    const doc = docMit(netzTeil('n1'));
    const daten = new Map<string, NeueDaten>([
      ['n1', { breite: 2, hoehe: 2, werte: new Uint8Array([1, 2, 3, 4]) }],
    ]);
    const neu = docFuerBild(doc, daten, 0);
    const teil = neu.bereiche[0].teile[0];
    expect(teil.art).toBe('netz');
    if (teil.art !== 'netz') return;
    expect(teil.breite).toBe(2);
    expect(Array.from(teil.alpha)).toEqual([1, 2, 3, 4]);
  });

  it('vergibt eine NEUE Marke, statt die alte zu behalten', () => {
    /*
     * Die Marke ist die Ersatzidentität der Maske: Ein Zwischenspeicher kann
     * einen `Uint8Array` nicht als Schlüssel benutzen und merkt sich
     * stattdessen diese Zahl. Bliebe sie gleich, bekäme Bild 2 die gerasterte
     * Maske von Bild 1 – ohne Fehler, ohne Warnung, und der Effekt klebte am
     * ersten Bild fest.
     */
    const doc = docMit(netzTeil('n1', 7));
    const eins = docFuerBild(
      doc,
      new Map([['n1', { breite: 2, hoehe: 2, werte: new Uint8Array(4) }]]),
      0,
    );
    const zwei = docFuerBild(
      doc,
      new Map([['n1', { breite: 2, hoehe: 2, werte: new Uint8Array(4) }]]),
      0,
    );
    const marke = (d: BildDoc) => {
      const teil = d.bereiche[0].teile[0];
      return teil.art === 'netz' ? teil.marke : -1;
    };
    expect(marke(eins)).not.toBe(7);
    expect(marke(zwei)).not.toBe(marke(eins));
  });

  it('schreibt bei „tiefe“ die KARTE und nicht ein Alpha', () => {
    // Ein Tiefenteil beschreibt die Entfernung, nicht die Maske – die
    // entsteht erst aus Fokus und Spanne. Ins falsche Feld geschrieben, wäre
    // die Tiefenschärfe wirkungslos.
    const doc = docMit(tiefenTeil('d1'));
    const neu = docFuerBild(
      doc,
      new Map([['d1', { breite: 2, hoehe: 2, werte: new Uint8Array([9, 9, 9, 9]) }]]),
      0,
    );
    const teil = neu.bereiche[0].teile[0];
    expect(teil.art).toBe('tiefe');
    if (teil.art !== 'tiefe') return;
    expect(Array.from(teil.karte)).toEqual([9, 9, 9, 9]);
    // Fokus und Spanne gehören dem Bildwunsch und nicht dem Bild – sie
    // bleiben über den ganzen Film stehen.
    expect(teil.fokus).toBe(0.5);
    expect(teil.spanne).toBe(0.3);
  });

  it('lässt ein Teil stehen, für das nichts geliefert wurde', () => {
    /*
     * Wenn das Netz auf einem Bild nichts gefunden hat, ist die zuletzt
     * gültige Maske ein besseres Ergebnis als gar keine: Ohne sie bliebe die
     * Wirkung für genau ein Bild aus, und das sieht man als Zucken.
     */
    const doc = docMit(netzTeil('n1'), tiefenTeil('d1'));
    const neu = docFuerBild(
      doc,
      new Map([['n1', { breite: 2, hoehe: 2, werte: new Uint8Array(4) }]]),
      0,
    );
    expect(neu.bereiche[0].teile[1]).toBe(doc.bereiche[0].teile[1]);
  });

  it('lässt das Dokument selbst unangetastet', () => {
    // Der Aufrufer hält das Urdokument und rechnet daraus Bild für Bild. Wer
    // es dabei verändert, baut das zweite Bild auf dem ersten auf.
    const doc = docMit(netzTeil('n1'));
    const vorher = doc.bereiche[0].teile[0];
    docFuerBild(doc, new Map([['n1', { breite: 2, hoehe: 2, werte: new Uint8Array(4) }]]), 0);
    expect(doc.bereiche[0].teile[0]).toBe(vorher);
  });

  it('gibt bei leerer Lieferung dasselbe Dokument zurück', () => {
    /*
     * Und zwar wirklich DASSELBE, nicht eine gleiche Kopie. Daran hängt der
     * Zwischenspeicher des Zeichners: Ist das Feld dasselbe Objekt, ist die
     * Maske dieselbe – und ein Bild ohne Inhaltsteile kostet dann gar nichts.
     */
    const doc = docMit(verlaufTeil('v1'));
    expect(docFuerBild(doc, new Map(), 0)).toBe(doc);
  });

  it('blendet einen zeitlich begrenzten Bereich ausserhalb seines Zeitraums aus', () => {
    // Der Kern von „ab hier freistellen": Ein Bereich mit `zeitraum` wirkt
    // nur innerhalb seines Fensters – ausserhalb wird er wie abgeschaltet
    // behandelt, obwohl sein eigener `aktiv`-Haken gesetzt bleibt.
    const doc: BildDoc = {
      ...neuesDoc(64, 48),
      bereiche: [
        {
          id: 'b1',
          name: 'Ab der Mitte',
          aktiv: true,
          teile: [netzTeil('n1')],
          anpassung: BEREICH_NEUTRAL,
          zeitraum: { vonMs: 2000, bisMs: null },
        },
      ],
    };
    expect(docFuerBild(doc, new Map(), 1000).bereiche[0].aktiv).toBe(false);
    expect(docFuerBild(doc, new Map(), 2000).bereiche[0].aktiv).toBe(true);
    expect(docFuerBild(doc, new Map(), 5000).bereiche[0].aktiv).toBe(true);
  });

  it('blendet einen zeitlich begrenzten Bereich nach seinem Ende wieder aus', () => {
    const doc: BildDoc = {
      ...neuesDoc(64, 48),
      bereiche: [
        {
          id: 'b1',
          name: 'Nur die Mitte',
          aktiv: true,
          teile: [netzTeil('n1')],
          anpassung: BEREICH_NEUTRAL,
          zeitraum: { vonMs: 2000, bisMs: 4000 },
        },
      ],
    };
    expect(docFuerBild(doc, new Map(), 1000).bereiche[0].aktiv).toBe(false);
    expect(docFuerBild(doc, new Map(), 3000).bereiche[0].aktiv).toBe(true);
    expect(docFuerBild(doc, new Map(), 4000).bereiche[0].aktiv).toBe(false);
  });

  it('lässt einen abgeschalteten Bereich abgeschaltet, auch innerhalb seines Zeitraums', () => {
    const doc: BildDoc = {
      ...neuesDoc(64, 48),
      bereiche: [
        {
          id: 'b1',
          name: 'Aus',
          aktiv: false,
          teile: [netzTeil('n1')],
          anpassung: BEREICH_NEUTRAL,
          zeitraum: { vonMs: 0, bisMs: null },
        },
      ],
    };
    expect(docFuerBild(doc, new Map(), 500).bereiche[0].aktiv).toBe(false);
  });
});

describe('zeitraumAktiv', () => {
  it('gilt ohne Zeitraum immer', () => {
    expect(zeitraumAktiv(undefined, 0)).toBe(true);
    expect(zeitraumAktiv(undefined, 999_999)).toBe(true);
  });

  it('gilt ab dem Anfang, ohne Ende', () => {
    const zeitraum = { vonMs: 1000, bisMs: null };
    expect(zeitraumAktiv(zeitraum, 999)).toBe(false);
    expect(zeitraumAktiv(zeitraum, 1000)).toBe(true);
    expect(zeitraumAktiv(zeitraum, 1_000_000)).toBe(true);
  });

  it('endet GENAU an bisMs – das Bild dort gehört schon der Ablösung', () => {
    // „Bis der Bereich verändert wird": Der ABGELÖSTE Bereich endet exakt
    // dort, wo der ABLÖSENDE beginnt – kein Bild darf beiden gehören, sonst
    // zeichnete `zeichnen.ts` zwei einander widersprechende Masken.
    const zeitraum = { vonMs: 0, bisMs: 2000 };
    expect(zeitraumAktiv(zeitraum, 1999)).toBe(true);
    expect(zeitraumAktiv(zeitraum, 2000)).toBe(false);
  });
});

describe('bereicheAbUebernehmen', () => {
  const bereich = (teile: Maskenteil[], zusatz: Partial<Bereich> = {}): Bereich => ({
    id: 'b1',
    name: 'Motiv',
    aktiv: true,
    teile,
    anpassung: BEREICH_NEUTRAL,
    ...zusatz,
  });
  const docMitBereichen = (...bereiche: Bereich[]): BildDoc => ({
    ...neuesDoc(64, 48),
    bereiche,
  });

  it('gibt einem neu angelegten Bereich einen offenen Zeitraum ab der Sitzungsstelle', () => {
    const alt = docMitBereichen();
    const neu = docMitBereichen(bereich([netzTeil('n1')]));
    const ergebnis = bereicheAbUebernehmen(alt, neu, 4200);
    expect(ergebnis.bereiche).toHaveLength(1);
    expect(ergebnis.bereiche[0].zeitraum).toEqual({ vonMs: 4200, bisMs: null });
  });

  it('lässt einen unangetasteten Bereich exakt die ALTE Fassung bleiben', () => {
    // Referenzgleich, nicht nur wertgleich – sonst verliert der
    // Maskenzwischenspeicher seinen Treffer für jeden unberührten Bereich.
    const vorhanden = bereich([netzTeil('n1')], { zeitraum: { vonMs: 500, bisMs: null } });
    const alt = docMitBereichen(vorhanden);
    // „neu" simuliert `docKopie`: gleiche Teile-REFERENZ, aber eine neue
    // `anpassung`-Kopie mit denselben Werten.
    const neu = docMitBereichen({ ...vorhanden, anpassung: { ...vorhanden.anpassung } });
    const ergebnis = bereicheAbUebernehmen(alt, neu, 4200);
    expect(ergebnis.bereiche[0]).toBe(vorhanden);
  });

  it('teilt einen bereits aktiven Bereich, der in der Sitzung verändert wurde', () => {
    const vorhanden = bereich([netzTeil('n1')], { zeitraum: { vonMs: 0, bisMs: null } });
    const alt = docMitBereichen(vorhanden);
    const neu = docMitBereichen(bereich([netzTeil('n1', 9)], { id: 'b1' }));
    const ergebnis = bereicheAbUebernehmen(alt, neu, 4200);

    expect(ergebnis.bereiche).toHaveLength(2);
    expect(ergebnis.bereiche[0]).toEqual({ ...vorhanden, zeitraum: { vonMs: 0, bisMs: 4200 } });
    expect(ergebnis.bereiche[1].id).not.toBe('b1');
    expect(ergebnis.bereiche[1].zeitraum).toEqual({ vonMs: 4200, bisMs: null });
    expect(ergebnis.bereiche[1].teile).toEqual([netzTeil('n1', 9)]);
  });

  it('übernimmt eine Änderung an einem noch NICHT begonnenen Bereich als Ganzes', () => {
    // Wer an einem Bereich schraubt, der zur Sitzungsstelle noch gar nicht
    // aktiv ist, meint offensichtlich seine ganze Zeitspanne.
    const vorhanden = bereich([netzTeil('n1')], { zeitraum: { vonMs: 5000, bisMs: null } });
    const alt = docMitBereichen(vorhanden);
    const neu = docMitBereichen(bereich([netzTeil('n1', 9)], {
      id: 'b1',
      zeitraum: { vonMs: 5000, bisMs: null },
    }));
    const ergebnis = bereicheAbUebernehmen(alt, neu, 4200);
    expect(ergebnis.bereiche).toHaveLength(1);
    expect(ergebnis.bereiche[0].zeitraum).toEqual({ vonMs: 5000, bisMs: null });
    expect(ergebnis.bereiche[0].teile).toEqual([netzTeil('n1', 9)]);
  });

  it('lässt einen gelöschten Bereich gelöscht', () => {
    const vorhanden = bereich([netzTeil('n1')]);
    const alt = docMitBereichen(vorhanden);
    const neu = docMitBereichen();
    expect(bereicheAbUebernehmen(alt, neu, 4200).bereiche).toEqual([]);
  });

  it('teilt nicht über BEREICHE_MAX hinaus', () => {
    /*
     * `tonGpu.ts` reserviert genau `BEREICHE_MAX` Plätze auf der
     * Grafikeinheit – ein Bereich darüber hinaus würde dort schlicht nicht
     * mehr gezeichnet. Bei vier bereits aktiven, alle in der Sitzung
     * verändert, blieben bei ungebremstem Teilen acht übrig; hier dürfen es
     * höchstens vier werden.
     */
    const vorhandene = Array.from({ length: BEREICHE_MAX }, (_, i) =>
      bereich([netzTeil(`n${i}`)], { id: `b${i}`, zeitraum: { vonMs: 0, bisMs: null } }),
    );
    const alt = docMitBereichen(...vorhandene);
    const neu = docMitBereichen(
      ...vorhandene.map((b, i) => bereich([netzTeil(`n${i}`, 9)], { id: b.id })),
    );
    const ergebnis = bereicheAbUebernehmen(alt, neu, 4200);
    expect(ergebnis.bereiche.length).toBeLessThanOrEqual(BEREICHE_MAX);
  });
});
