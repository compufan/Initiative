import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollectionDto } from '@initiative/shared';

vi.mock('../../lib/api.js', () => ({
  api: { collections: { list: vi.fn(), items: vi.fn() } },
}));

const { pfadZu, useFiles } = await import('./state.js');

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
    myLevel: 'edit',
    itemCount: 0,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

beforeEach(() => {
  useFiles.setState({ collections: [], items: {}, loaded: {}, status: 'idle', error: null });
});

describe('Pfad zu einer Sammlung', () => {
  it('geht von oben nach unten', () => {
    const alle = [sammlung('enkel', 'kind'), sammlung('kind', 'wurzel'), sammlung('wurzel', null)];
    expect(pfadZu(alle, 'enkel').map((eintrag) => eintrag.id)).toEqual([
      'wurzel',
      'kind',
      'enkel',
    ]);
  });

  it('bricht ab, wo man den Elternordner nicht sehen darf', () => {
    // Der Normalfall bei geteilten Unterordnern: Man steht in "Rechnungen",
    // ohne den Ordner darueber zu kennen. Der Pfad beginnt dann eben dort.
    const alle = [sammlung('rechnungen', 'fremd')];
    expect(pfadZu(alle, 'rechnungen').map((eintrag) => eintrag.id)).toEqual(['rechnungen']);
  });

  it('laeuft bei einem Zyklus nicht ewig', () => {
    const alle = [sammlung('a', 'b'), sammlung('b', 'a')];
    expect(pfadZu(alle, 'a').length).toBeLessThanOrEqual(2);
  });
});

describe('Ordner einer Ebene', () => {
  it('zeigt oben auch die, deren Elternteil fehlt', () => {
    useFiles.setState({
      collections: [
        sammlung('wurzel', null, 'Wurzel'),
        sammlung('kind', 'wurzel', 'Kind'),
        sammlung('verwaist', 'unsichtbar', 'Verwaist'),
      ],
    });

    const oben = useFiles.getState().childrenOf(null);
    expect(oben.map((eintrag) => eintrag.id).sort()).toEqual(['verwaist', 'wurzel']);
    expect(useFiles.getState().childrenOf('wurzel').map((e) => e.id)).toEqual(['kind']);
  });

  it('sortiert nach Namen', () => {
    useFiles.setState({
      collections: [
        sammlung('c', null, 'Zebra'),
        sammlung('a', null, 'Äpfel'),
        sammlung('b', null, 'Birnen'),
      ],
    });
    expect(useFiles.getState().childrenOf(null).map((e) => e.name)).toEqual([
      'Äpfel',
      'Birnen',
      'Zebra',
    ]);
  });
});

describe('Zwischenspeicher', () => {
  it('unterscheidet "leer" von "noch nicht geladen"', () => {
    // Sonst zeigt die App "Noch nichts drin", waehrend der Inhalt unterwegs
    // ist - genau der Fehler, der im Chat schon einmal Nachrichten
    // verschwinden liess.
    expect(useFiles.getState().loaded['x']).toBeUndefined();
    useFiles.getState().setItems('x', []);
    expect(useFiles.getState().loaded['x']).toBe(true);
    expect(useFiles.getState().items['x']).toEqual([]);
  });

  it('vergisst beim Loeschen auch den Inhalt', () => {
    useFiles.setState({ collections: [sammlung('x', null)] });
    useFiles.getState().setItems('x', []);
    useFiles.getState().forget('x');
    expect(useFiles.getState().collections).toEqual([]);
    expect(useFiles.getState().items['x']).toBeUndefined();
    expect(useFiles.getState().loaded['x']).toBeUndefined();
  });

  it('ersetzt eine Sammlung, statt sie doppelt zu fuehren', () => {
    useFiles.setState({ collections: [sammlung('x', null, 'Alt')] });
    useFiles.getState().upsert(sammlung('x', null, 'Neu'));
    expect(useFiles.getState().collections).toHaveLength(1);
    expect(useFiles.getState().collections[0].name).toBe('Neu');
  });
});
