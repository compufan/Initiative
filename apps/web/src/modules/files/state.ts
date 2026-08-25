import { create } from 'zustand';
import {
  buildCollectionTree,
  type CollectionDto,
  type CollectionItemDto,
  type CollectionNode,
} from '@initiative/shared';
import { api } from '../../lib/api.js';

/**
 * Der Zustand von „Dateien“.
 *
 * Sammlungen kommen als flache Liste vom Server und werden hier einmal zum
 * Baum zusammengesetzt. Die Inhalte eines Ordners werden erst geladen, wenn
 * man ihn öffnet – bei ein paar hundert Dateien will man nicht alles auf
 * einmal über ein Mobilfunknetz ziehen.
 */

interface FilesState {
  collections: CollectionDto[];
  /** Inhalte je Sammlung, nach dem ersten Öffnen. */
  items: Record<string, CollectionItemDto[]>;
  /** Welche Ordner schon geladen wurden – „leer“ und „ungeladen“ sind zweierlei. */
  loaded: Record<string, boolean>;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;

  load: () => Promise<void>;
  loadItems: (collectionId: string, force?: boolean) => Promise<void>;
  tree: () => CollectionNode[];
  byId: (id: string) => CollectionDto | undefined;
  /** Ordner direkt unter diesem – für die Ansicht eines geöffneten Ordners. */
  childrenOf: (parentId: string | null) => CollectionDto[];
  upsert: (collection: CollectionDto) => void;
  forget: (collectionId: string) => void;
  setItems: (collectionId: string, items: CollectionItemDto[]) => void;
}

function fehlertext(error: unknown): string {
  return error instanceof Error ? error.message : 'Unbekannter Fehler';
}

export const useFiles = create<FilesState>((set, get) => ({
  collections: [],
  items: {},
  loaded: {},
  status: 'idle',
  error: null,

  async load() {
    set({ status: get().collections.length > 0 ? 'ready' : 'loading', error: null });
    try {
      const { items } = await api.collections.list();
      set({ collections: items, status: 'ready', error: null });
    } catch (error) {
      // Die bereits geladenen Sammlungen stehen lassen: eine kurze Störung
      // soll nicht die ganze Ansicht leerräumen.
      set({ status: 'error', error: fehlertext(error) });
    }
  },

  async loadItems(collectionId, force = false) {
    if (!force && get().loaded[collectionId]) return;
    try {
      const { items } = await api.collections.items(collectionId);
      get().setItems(collectionId, items);
    } catch (error) {
      set({ error: fehlertext(error) });
    }
  },

  tree() {
    return buildCollectionTree(get().collections);
  },

  byId(id) {
    return get().collections.find((collection) => collection.id === id);
  },

  childrenOf(parentId) {
    const bekannt = new Set(get().collections.map((collection) => collection.id));
    return get()
      .collections.filter((collection) => {
        // Ein Ordner, dessen Elternteil man nicht sehen darf, gehört nach
        // oben – sonst wäre er nirgends erreichbar.
        const eltern =
          collection.parentId && bekannt.has(collection.parentId) ? collection.parentId : null;
        return eltern === parentId;
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  },

  upsert(collection) {
    set((state) => {
      const rest = state.collections.filter((entry) => entry.id !== collection.id);
      return { collections: [...rest, collection] };
    });
  },

  forget(collectionId) {
    set((state) => {
      const items = { ...state.items };
      const loaded = { ...state.loaded };
      delete items[collectionId];
      delete loaded[collectionId];
      return {
        collections: state.collections.filter((entry) => entry.id !== collectionId),
        items,
        loaded,
      };
    });
  },

  setItems(collectionId, items) {
    set((state) => ({
      items: { ...state.items, [collectionId]: items },
      loaded: { ...state.loaded, [collectionId]: true },
    }));
  },
}));

/**
 * Der Pfad von der obersten Ebene bis zu dieser Sammlung – für die
 * Brotkrumen-Leiste.
 *
 * Bricht ab, sobald ein Elternteil nicht bekannt ist: Man kann in einem
 * Unterordner stehen, ohne den darüber sehen zu dürfen.
 */
export function pfadZu(collections: CollectionDto[], id: string): CollectionDto[] {
  const nachId = new Map(collections.map((entry) => [entry.id, entry]));
  const pfad: CollectionDto[] = [];
  const gesehen = new Set<string>();
  let aktuell = nachId.get(id);
  while (aktuell && !gesehen.has(aktuell.id)) {
    gesehen.add(aktuell.id);
    pfad.unshift(aktuell);
    aktuell = aktuell.parentId ? nachId.get(aktuell.parentId) : undefined;
  }
  return pfad;
}
