import { describe, expect, it } from 'vitest';
import {
  allowsLevel,
  buildCollectionTree,
  grantCollectionSchema,
  type CollectionDto,
} from './collection.js';

function sammlung(id: string, parentId: string | null, name = id): CollectionDto {
  return {
    id,
    parentId,
    conversationId: null,
    name,
    description: null,
    color: null,
    memberLevel: 'edit',
    createdBy: null,
    myLevel: 'view',
    itemCount: 0,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

describe('Zugriffsstufen', () => {
  it('sind aufsteigend', () => {
    expect(allowsLevel('own', 'view')).toBe(true);
    expect(allowsLevel('own', 'edit')).toBe(true);
    expect(allowsLevel('edit', 'view')).toBe(true);
    expect(allowsLevel('view', 'edit')).toBe(false);
    expect(allowsLevel('none', 'view')).toBe(false);
  });
});

describe('Ordnerbaum', () => {
  it('haengt Kinder unter ihre Eltern', () => {
    const baum = buildCollectionTree([
      sammlung('kind', 'wurzel'),
      sammlung('wurzel', null),
      sammlung('enkel', 'kind'),
    ]);

    expect(baum).toHaveLength(1);
    expect(baum[0].collection.id).toBe('wurzel');
    expect(baum[0].depth).toBe(0);
    expect(baum[0].children[0].collection.id).toBe('kind');
    expect(baum[0].children[0].depth).toBe(1);
    expect(baum[0].children[0].children[0].collection.id).toBe('enkel');
  });

  it('zeigt einen Ordner oben, dessen Elternteil man nicht sehen darf', () => {
    // Der Normalfall, nicht ein Fehler: Zugriff auf "Rechnungen", aber nicht
    // auf den Ordner darueber. Ohne diese Regel waere der Ordner unsichtbar.
    const baum = buildCollectionTree([sammlung('rechnungen', 'nicht-sichtbar')]);
    expect(baum).toHaveLength(1);
    expect(baum[0].collection.id).toBe('rechnungen');
    expect(baum[0].depth).toBe(0);
  });

  it('sortiert nach Namen', () => {
    const baum = buildCollectionTree([
      sammlung('c', null, 'Zebra'),
      sammlung('a', null, 'Äpfel'),
      sammlung('b', null, 'Birnen'),
    ]);
    expect(baum.map((knoten) => knoten.collection.name)).toEqual(['Äpfel', 'Birnen', 'Zebra']);
  });

  it('laeuft bei einem Zyklus nicht ewig', () => {
    // Der Server verhindert das; ein beschaedigter Zwischenspeicher koennte
    // es trotzdem liefern, und dann darf die App nicht einfrieren.
    const baum = buildCollectionTree([sammlung('a', 'b'), sammlung('b', 'a')]);
    expect(baum.length).toBeLessThanOrEqual(2);
  });
});

describe('Recht vergeben', () => {
  it('nimmt entweder eine Person oder einen Chat', () => {
    expect(
      grantCollectionSchema.safeParse({
        userId: '0195b0a0-0000-7000-8000-000000000001',
        level: 'view',
      }).success,
    ).toBe(true);
    expect(
      grantCollectionSchema.safeParse({
        conversationId: '0195b0a0-0000-7000-8000-000000000002',
        level: 'edit',
      }).success,
    ).toBe(true);
  });

  it('weist beides und nichts zurueck', () => {
    expect(
      grantCollectionSchema.safeParse({
        userId: '0195b0a0-0000-7000-8000-000000000001',
        conversationId: '0195b0a0-0000-7000-8000-000000000002',
        level: 'view',
      }).success,
    ).toBe(false);
    expect(grantCollectionSchema.safeParse({ level: 'view' }).success).toBe(false);
  });

  it('kennt "none" nicht als vergebbare Stufe', () => {
    // Kein Zugriff heisst: kein Eintrag. Eine Zeile mit "none" waere ein
    // stiller Widerspruch zur Vererbung.
    expect(
      grantCollectionSchema.safeParse({
        userId: '0195b0a0-0000-7000-8000-000000000001',
        level: 'none',
      }).success,
    ).toBe(false);
  });
});
