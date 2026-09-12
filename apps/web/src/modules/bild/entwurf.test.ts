import { beforeEach, describe, expect, it, vi } from 'vitest';

import { neuesDoc, type BildDoc } from './doc.js';

/*
 * Der Speicher wird ersetzt, nicht nachgebaut.
 *
 * `entwurf.ts` hängt an drei Funktionen aus `lib/db.ts`, und die brauchen
 * IndexedDB. Unter `environment: 'node'` gibt es das nicht – und es zu
 * emulieren hiesse, eine Datenbank zu prüfen, die niemand geschrieben hat.
 * Was hier geprüft werden soll, steht in `entwurf.ts`: welche Fälle einen
 * Entwurf VERWERFEN, bevor er überhaupt zum Anwender kommt.
 */
const speicher = new Map<string, unknown>();

vi.mock('../../lib/db.js', () => ({
  entwurfLesen: async (id: string) => speicher.get(id) ?? null,
  entwurfSchreiben: async (e: { id: string }) => {
    speicher.set(e.id, e);
  },
  entwurfLoeschen: async (id: string) => {
    speicher.delete(id);
  },
}));

const { bildKennung, entwurfAlter, entwurfHolen, entwurfSichern } = await import('./entwurf.js');

function getont(breite = 100, hoehe = 80): BildDoc {
  const doc = neuesDoc(breite, hoehe);
  doc.anpassung = { ...doc.anpassung, belichtung: 1.2 };
  return doc;
}

beforeEach(() => speicher.clear());

describe('bildKennung', () => {
  it('gibt für dieselben Bytes dieselbe Kennung', async () => {
    const a = new Blob([new Uint8Array([1, 2, 3, 4, 5])]);
    const b = new Blob([new Uint8Array([1, 2, 3, 4, 5])]);
    expect(await bildKennung(a)).toBe(await bildKennung(b));
  });

  it('unterscheidet zwei verschiedene Bilder', async () => {
    const a = new Blob([new Uint8Array([1, 2, 3, 4, 5])]);
    const b = new Blob([new Uint8Array([1, 2, 3, 4, 6])]);
    expect(await bildKennung(a)).not.toBe(await bildKennung(b));
  });

  it('trägt die Länge im Namen', async () => {
    /*
     * Die Länge steht vorn, und sie ist kein Schmuck: Sie schliesst die ganze
     * Klasse von Fehlern aus, in der eine Streuung zwei verschieden lange
     * Dateien zusammenwirft – und die Ersatzstreuung ohne `crypto.subtle`
     * sieht ohnehin nur eine Stichprobe.
     */
    const blob = new Blob([new Uint8Array(777)]);
    expect(await bildKennung(blob)).toMatch(/^777-/);
  });
});

describe('entwurfSichern / entwurfHolen', () => {
  it('bringt eine Bearbeitung hin und zurück', async () => {
    await entwurfSichern('k1', getont(), 100, 80, 'foto.jpg');
    const fund = await entwurfHolen('k1', 100, 80);
    expect(fund?.doc.anpassung.belichtung).toBeCloseTo(1.2);
  });

  it('gibt nichts zurück, wenn die Masse nicht passen', async () => {
    /*
     * Zwei Bilder mit gleicher Länge und gleicher Stichprobe sind bei der
     * Ersatzstreuung nicht ausgeschlossen. Passte ein Entwurf dann auf ein
     * ANDERES Bild, lägen Zuschnitt, Verlaufsgriffe und Pinselzüge an
     * plausibel falschen Stellen – der schlimmste Fehler, weil er nicht nach
     * einem Fehler aussieht.
     */
    await entwurfSichern('k1', getont(), 100, 80, null);
    expect(await entwurfHolen('k1', 200, 160)).toBeNull();
  });

  it('räumt den Entwurf weg, sobald nichts mehr da ist', async () => {
    await entwurfSichern('k1', getont(), 100, 80, null);
    expect(await entwurfHolen('k1', 100, 80)).not.toBeNull();

    // Alles zurückgenommen – das Bild ist wieder unberührt.
    await entwurfSichern('k1', neuesDoc(100, 80), 100, 80, null);
    expect(await entwurfHolen('k1', 100, 80)).toBeNull();
    expect(speicher.has('k1')).toBe(false);
  });

  it('legt für ein unberührtes Bild gar nichts erst an', async () => {
    await entwurfSichern('k1', neuesDoc(100, 80), 100, 80, null);
    expect(speicher.size).toBe(0);
  });

  it('teilt kein Feld mit dem lebenden Dokument', async () => {
    /*
     * Der Editor ändert sein Dokument nie an Ort und Stelle – aber der
     * Entwurf darf sich darauf nicht verlassen. Stünde im Speicher dieselbe
     * Punktliste, änderte der nächste Pinselstrich rückwirkend auch den
     * Entwurf, und ein „Neu anfangen" führte zurück auf einen Stand, den es
     * nie gab. (In der echten Datenbank verdeckt der Strukturklon von
     * IndexedDB das; im Entwurfsspeicher liegt die Rohform aber auch auf
     * anderen Wegen herum.)
     */
    const doc = getont();
    doc.striche.push({ farbe: '#000', breite: 10, punkte: [0, 0, 5, 5], art: 'farbe' });
    await entwurfSichern('k1', doc, 100, 80, null);
    doc.striche[0].punkte.push(99, 99);
    doc.anpassung.belichtung = -3;

    const fund = await entwurfHolen('k1', 100, 80);
    expect(fund?.doc.anpassung.belichtung).toBeCloseTo(1.2);
    expect(fund?.doc.striche[0].punkte).toEqual([0, 0, 5, 5]);
  });
});

describe('entwurfAlter', () => {
  it('nennt die Spanne in der Einheit, in der man sie denkt', () => {
    const jetzt = Date.parse('2026-09-12T12:00:00Z');
    expect(entwurfAlter(jetzt - 20_000, jetzt)).toBe('von gerade eben');
    expect(entwurfAlter(jetzt - 8 * 60_000, jetzt)).toBe('von vor 8 Minuten');
    expect(entwurfAlter(jetzt - 60 * 60_000, jetzt)).toBe('von vor 1 Stunde');
    expect(entwurfAlter(jetzt - 5 * 60 * 60_000, jetzt)).toBe('von vor 5 Stunden');
    expect(entwurfAlter(jetzt - 26 * 60 * 60_000, jetzt)).toBe('von gestern');
    expect(entwurfAlter(jetzt - 5 * 24 * 60 * 60_000, jetzt)).toBe('von vor 5 Tagen');
  });

  it('nennt eine Uhr, die nachgeht, nicht „in der Zukunft“', () => {
    // Ein Gerät, dessen Uhr gestellt wurde, hat plötzlich Entwürfe aus der
    // Zukunft. „von gerade eben" ist dann die einzige Antwort, die niemanden
    // verwirrt.
    const jetzt = Date.parse('2026-09-12T12:00:00Z');
    expect(entwurfAlter(jetzt + 60 * 60_000, jetzt)).toBe('von gerade eben');
  });
});
