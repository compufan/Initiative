import { describe, expect, it, vi } from 'vitest';
import type { AccessLevel, CollectionDto } from '@initiative/shared';

// `pfadZu` liegt im Dateien-Speicher, und der zieht den Client mit – hier
// wird nichts davon gerufen.
vi.mock('../../lib/api.js', () => ({ api: { collections: { list: vi.fn(), items: vi.fn() } } }));

const { ebenen, gleichnamigUnter, ordnerZeilen, pfadText } = await import('./ordner.js');

function sammlung(
  id: string,
  parentId: string | null,
  name = id,
  myLevel: AccessLevel = 'edit',
): CollectionDto {
  return {
    id,
    parentId,
    conversationId: null,
    name,
    description: null,
    color: null,
    memberLevel: 'none',
    createdBy: null,
    myLevel,
    itemCount: 0,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

/** Eine Kette `k1 > k2 > … > kN`. */
function kette(laenge: number): CollectionDto[] {
  return Array.from({ length: laenge }, (_, i) =>
    sammlung(`k${i + 1}`, i === 0 ? null : `k${i}`, `Ebene ${i + 1}`),
  );
}

describe('Ordnerzeilen', () => {
  it('stehen in Baumreihenfolge, mit Einrückung und nach Namen sortiert', () => {
    const alle = [
      sammlung('urlaub', 'familie', 'Urlaube'),
      sammlung('arbeit', null, 'Arbeit'),
      sammlung('familie', null, 'Familie'),
      sammlung('alt', 'familie', 'Älteres'),
    ];
    const zeilen = ordnerZeilen(alle);
    expect(zeilen.map((zeile) => [zeile.collection.id, zeile.depth])).toEqual([
      ['arbeit', 0],
      ['familie', 0],
      ['alt', 1],
      ['urlaub', 1],
    ]);
    expect(zeilen.every((zeile) => zeile.wahlbar && zeile.grund === null)).toBe(true);
  });

  it('lassen einen Ordner nur zum Ansehen weg, wenn darunter nichts änderbar ist', () => {
    const alle = [
      sammlung('nur', null, 'Nur ansehen', 'view'),
      sammlung('nur-kind', 'nur', 'Auch nur ansehen', 'view'),
      sammlung('frei', null, 'Frei'),
    ];
    expect(ordnerZeilen(alle).map((zeile) => zeile.collection.id)).toEqual(['frei']);
  });

  it('behalten einen Ordner nur zum Ansehen als graue Zeile, wenn darunter etwas änderbar ist', () => {
    const alle = [
      sammlung('bodos', null, 'Bodos', 'view'),
      sammlung('offen', 'bodos', 'Offen', 'edit'),
      sammlung('zu', 'bodos', 'Zu', 'view'),
    ];
    const zeilen = ordnerZeilen(alle);
    expect(zeilen.map((zeile) => zeile.collection.id)).toEqual(['bodos', 'offen']);
    expect(zeilen[0]).toMatchObject({ wahlbar: false, grund: 'nurAnsehen', depth: 0 });
    expect(zeilen[1]).toMatchObject({ wahlbar: true, grund: null, depth: 1 });
  });

  it('zeigen mit nurAendern: false auch Ordner zum Ansehen als wählbar', () => {
    const alle = [sammlung('a', null, 'A', 'view')];
    expect(ordnerZeilen(alle, { nurAendern: false })[0]).toMatchObject({ wahlbar: true });
  });

  it('sperren die Ebene, ab der der Server ablehnt (Wurzel = Ebene 1)', () => {
    const zeilen = ordnerZeilen(kette(8));
    // Pfadlänge 7: ein Kind wäre die achte Ebene – erlaubt.
    expect(zeilen[6]).toMatchObject({ wahlbar: true, grund: null });
    // Pfadlänge 8: ein Kind wäre die neunte – der Server antwortet 400.
    expect(zeilen[7]).toMatchObject({ wahlbar: false, grund: 'zuTief' });
  });

  it('sperren auch, was der Server schon als zu tief abgelehnt hat', () => {
    // Bei einem unsichtbaren Elternordner kennt der Client nur eine Untergrenze.
    const alle = [sammlung('a', 'unsichtbar', 'A')];
    expect(ordnerZeilen(alle)[0]?.wahlbar).toBe(true);
    expect(ordnerZeilen(alle, { zuTiefIds: new Set(['a']) })[0]).toMatchObject({
      wahlbar: false,
      grund: 'zuTief',
    });
  });

  it('hängen sich bei einem Zyklus oder fehlendem Elternordner nicht auf', () => {
    const zyklus = [sammlung('a', 'b'), sammlung('b', 'a')];
    expect(ordnerZeilen(zyklus).length).toBeLessThanOrEqual(2);
    expect(ebenen(zyklus, 'a')).toBeLessThanOrEqual(2);

    const verwaist = [sammlung('kind', 'weg', 'Kind')];
    expect(ordnerZeilen(verwaist)[0]).toMatchObject({ depth: 0, wahlbar: true });
    expect(ebenen(verwaist, 'kind')).toBe(1);
  });

  it('filtern auf Treffer samt Vorfahren, die Vorfahren gedämpft', () => {
    const alle = [
      sammlung('familie', null, 'Familie'),
      sammlung('urlaub', 'familie', 'Urlaube'),
      sammlung('hütte', 'urlaub', 'Hütte 2025'),
      sammlung('arbeit', null, 'Arbeit'),
    ];
    const zeilen = ordnerZeilen(alle, { filter: ' hütte ' });
    expect(zeilen.map((zeile) => [zeile.collection.id, zeile.gedaempft])).toEqual([
      ['familie', true],
      ['urlaub', true],
      ['hütte', false],
    ]);
    // Gedämpft ist nur die Anzeige – wählbar bleibt, was änderbar ist.
    expect(zeilen.every((zeile) => zeile.wahlbar)).toBe(true);
  });
});

describe('Pfadtext', () => {
  const alle = [
    sammlung('a', null, 'A'),
    sammlung('b', 'a', 'B'),
    sammlung('c', 'b', 'C'),
    sammlung('d', 'c', 'D'),
    sammlung('fremd-kind', 'unsichtbar', 'Kind'),
  ];

  it('trennt mit „ › “', () => {
    expect(pfadText(alle, 'b')).toBe('A › B');
    expect(pfadText(alle, 'a')).toBe('A');
  });

  it('kürzt auf die letzten drei Ebenen', () => {
    expect(pfadText(alle, 'd')).toBe('… › B › C › D');
    expect(pfadText(alle, 'd', { max: 2 })).toBe('… › C › D');
  });

  it('beginnt mit „… › “, wenn der oberste sichtbare Ordner einen unsichtbaren Elternordner hat', () => {
    expect(pfadText(alle, 'fremd-kind')).toBe('… › Kind');
  });

  it('ist leer für eine unbekannte Sammlung', () => {
    expect(pfadText(alle, 'gibt-es-nicht')).toBe('');
  });
});

describe('Gleichnamige Sammlung', () => {
  const alle = [
    sammlung('familie', null, 'Familie'),
    sammlung('hütte', 'familie', 'Hüttenwochenende'),
    sammlung('fremd', 'unsichtbar', 'Fremdes Kind'),
  ];

  it('ignoriert Gross-/Kleinschreibung und Randleerzeichen', () => {
    expect(gleichnamigUnter(alle, 'familie', '  hÜTTENwochenende ')?.id).toBe('hütte');
    expect(gleichnamigUnter(alle, null, 'FAMILIE')?.id).toBe('familie');
  });

  it('sucht nur im gewählten Ordner', () => {
    expect(gleichnamigUnter(alle, null, 'Hüttenwochenende')).toBeUndefined();
    expect(gleichnamigUnter(alle, 'familie', 'Familie')).toBeUndefined();
  });

  it('rechnet oben auch Ordner mit unsichtbarem Elternordner dazu', () => {
    expect(gleichnamigUnter(alle, null, 'fremdes kind')?.id).toBe('fremd');
  });

  it('meldet bei leerem Namen nichts', () => {
    expect(gleichnamigUnter(alle, null, '   ')).toBeUndefined();
  });
});
