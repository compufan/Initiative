import { describe, expect, it } from 'vitest';

import { rleKodieren, metaMessen, rleDekodieren } from './rle.js';
import {
  GrauLru,
  Kette,
  Netzvorrat,
  Tiefenvorrat,
  Vorrat,
  type KettenEintrag,
} from './spurVorrat.js';

/**
 * Der Vorrat der Verfolgung: was bleibt, was geht, und in welcher
 * Reihenfolge – gegen ein kleines Budget, damit sich Verdrängung zeigen
 * lässt, ohne hundert Megabyte anzulegen.
 */

const B = 64;
const H = 48;

function scheibe(cx: number, cy: number, r: number): Uint8Array {
  const m = new Uint8Array(B * H);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < B; x += 1) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) m[y * B + x] = 255;
  }
  return m;
}

function eintrag(maske: Uint8Array, guete: 'grob' | 'fein' = 'fein'): KettenEintrag {
  return { rle: rleKodieren(maske), meta: metaMessen(maske, B, H), marke: 1, guete };
}

/** Ein Eintrag mit genau so vielen Nutzbytes – für Rechnungen mit dem Budget. */
function schwer(bytes: number): KettenEintrag {
  return {
    rle: new Uint8Array(bytes),
    meta: metaMessen(new Uint8Array(B * H), B, H),
    marke: 1,
    guete: 'fein',
  };
}

describe('Kette', () => {
  it('lässt Grobes nie über Feines schreiben – Feines über Grobes schon', () => {
    const kette = new Kette('k1|40|64x48|K4', 10);
    expect(kette.ablegen(12, eintrag(scheibe(20, 20, 5), 'grob'))).toBe(true);
    expect(kette.ablegen(12, eintrag(scheibe(22, 20, 5), 'fein'))).toBe(true);
    expect(kette.ablegen(12, eintrag(scheibe(40, 20, 5), 'grob'))).toBe(false);
    const da = kette.bild(12);
    expect(da && !da.verloren && da.meta.mx).toBeCloseTo(22, 0);
    expect(kette.version).toBe(2);
  });

  it('zählt ihre Bytes – mit und ohne Ränder', () => {
    const kette = new Kette('k1', 0);
    kette.ablegen(1, schwer(1000));
    kette.ablegen(2, { verloren: true, guete: 'fein' });
    const nurBilder = kette.bytes;
    expect(nurBilder).toBeGreaterThan(1000);
    kette.randAblegen('vor', 'fein', {
      k: 2,
      rand: {
        tempo: null,
        abgelehnt: 0,
        flaeche: 0,
        drift: { x: 0, y: 0 },
        vomAnker: { x: 0, y: 0 },
        abwesendSeit: null,
        letzterKasten: null,
        letztesTempo: null,
      },
      roh: new Uint8Array(500),
      mitte: null,
      punkte: null,
      innen: null,
    });
    expect(kette.bytes).toBeGreaterThan(nurBilder + 500);
    expect(kette.rand('vor', 'fein', 2)?.k).toBe(2);
    expect(kette.rand('vor', 'grob', 2)).toBeUndefined();
    expect(kette.rand('rueck', 'fein', 2)).toBeUndefined();
  });
});

describe('Vorrat', () => {
  it('verdrängt zuerst ersetzte Ketten, die am längsten nicht gebraucht wurden', () => {
    const vorrat = new Vorrat(20_000, 16, 1_000_000);
    const alt1 = vorrat.kette('alt1', 0);
    alt1.ablegen(1, schwer(6000));
    const alt2 = vorrat.kette('alt2', 0);
    alt2.ablegen(1, schwer(6000));
    const neu = vorrat.kette('neu', 0);
    neu.ablegen(1, schwer(6000));
    vorrat.aktuellSetzen(['neu']);
    // alt1 wird noch einmal gebraucht (die Vorschau zeigt es als veraltet) – alt2 geht zuerst.
    expect(vorrat.holen('alt1')).toBe(alt1);
    neu.ablegen(2, schwer(6000));
    expect(vorrat.aufraeumen()).toEqual([]);
    expect(vorrat.holen('alt2')).toBeUndefined();
    expect(vorrat.holen('alt1')).toBe(alt1);
    expect(vorrat.holen('neu')).toBe(neu);
  });

  it('räumt danach den Netzvorrat – und hält erst dann eine gebrauchte Kette an', () => {
    const vorrat = new Vorrat(20_000, 16, 1_000_000);
    const maske = new Uint8Array(100_000);
    // Eine Maske voller Rauschen: Lauflängen helfen nicht, sie wiegt fast ihre Grösse.
    for (let i = 0; i < maske.length; i += 1) maske[i] = 20 + ((i * 37) % 200);
    vorrat.netz.ablegen('object', 3, maske);
    expect(vorrat.netz.bytes).toBeGreaterThan(20_000);
    const a = vorrat.kette('a', 0);
    a.ablegen(1, schwer(8000));
    vorrat.aktuellSetzen(['a']);
    expect(vorrat.aufraeumen()).toEqual([]);
    expect(vorrat.netz.bytes).toBe(0);
    expect(vorrat.holen('a')).toBe(a);

    // Jetzt reichen die gebrauchten Ketten allein nicht: Die am wenigsten fertige hält an.
    const b = vorrat.kette('b', 0);
    b.ablegen(1, schwer(15_000));
    vorrat.aktuellSetzen(['a', 'b']);
    const fertig = new Map([
      ['a', 0.9],
      ['b', 0.2],
    ]);
    expect(vorrat.aufraeumen((s) => fertig.get(s) ?? 0)).toEqual(['b']);
    // Angehalten, nicht gelöscht: Was sie hat, bleibt.
    expect(vorrat.holen('b')?.bild(1)).toBeDefined();
  });

  it('zählt alles zusammen', () => {
    const vorrat = new Vorrat();
    const leer = vorrat.bytes;
    vorrat.kette('x', 0).ablegen(1, schwer(1000));
    vorrat.tiefe.ablegen(0, { breite: 10, hoehe: 10, werte: new Uint8Array(100) });
    vorrat.grau.ablegen(0, { breite: 10, hoehe: 10, werte: new Float32Array(100) });
    expect(vorrat.bytes).toBeGreaterThan(leer + 1200);
    vorrat.leeren();
    expect(vorrat.bytes).toBe(leer);
  });
});

describe('Netzvorrat', () => {
  it('liefert, was abgelegt wurde, und vergisst nach Bytes', () => {
    const netz = new Netzvorrat(3300);
    const a = scheibe(20, 20, 10);
    netz.ablegen('object', 7, a);
    expect(netz.hat('object', 7)).toBe(true);
    expect(netz.hat('birefnet', 7)).toBe(false);
    expect(Array.from(netz.holen('object', 7, B * H) ?? [])).toEqual(Array.from(a));
    // Viel Rauschen verdrängt den alten Eintrag.
    const laut = new Uint8Array(B * H).map((_, i) => 30 + ((i * 53) % 190));
    netz.ablegen('object', 8, laut);
    expect(netz.hat('object', 7)).toBe(false);
  });
});

describe('Tiefenvorrat', () => {
  it('gibt jeder Karte eine eigene Marke', () => {
    const tiefe = new Tiefenvorrat();
    const eins = tiefe.ablegen(4, { breite: 2, hoehe: 1, werte: new Uint8Array([1, 2]) });
    const zwei = tiefe.ablegen(8, { breite: 2, hoehe: 1, werte: new Uint8Array([3, 4]) });
    expect(eins.marke).not.toBe(zwei.marke);
    expect(tiefe.holen(4)).toBe(eins);
    expect(tiefe.hat(5)).toBe(false);
  });
});

describe('GrauLru', () => {
  it('rundet auf ganze Stufen – frisch und aus dem Speicher dasselbe', () => {
    const lru = new GrauLru(2, 4);
    const frisch = lru.ablegen(1, {
      breite: 2,
      hoehe: 2,
      werte: Float32Array.from([10.4, 10.6, -3, 300]),
    });
    expect(Array.from(frisch.werte)).toEqual([10, 11, 0, 255]);
    expect(Array.from(lru.holen(1)?.werte ?? [])).toEqual([10, 11, 0, 255]);
  });

  it('hält nur so viele Bilder, wie es soll', () => {
    const lru = new GrauLru(2, 4);
    const grau = { breite: 2, hoehe: 2, werte: new Float32Array(4) };
    lru.ablegen(1, grau);
    lru.ablegen(2, grau);
    lru.ablegen(3, grau);
    expect(lru.hat(1)).toBe(false);
    expect(lru.hat(2) && lru.hat(3)).toBe(true);
  });

  it('packt eine abgelegte leere Maske in voller Länge aus', () => {
    // Für den Rand eines Fensters: Eine leere rohe Maske muss als Anker taugen.
    expect(rleDekodieren(rleKodieren(new Uint8Array(B * H)), B * H)).toHaveLength(B * H);
  });
});
