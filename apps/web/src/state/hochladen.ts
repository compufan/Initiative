import { create } from 'zustand';

/**
 * Wie weit ein Upload gerade ist – je Nachricht (`clientId`).
 *
 * Steht neben dem Chat-Speicher und nicht darin: Der Fortschritt ändert sich
 * alle paar Sekunden, und jede Änderung im Chat-Speicher liesse die ganze
 * Nachrichtenliste neu vergleichen. Hier hört nur die eine Blase zu, die ihn
 * zeigt (`PendingMedia`).
 */
export interface HochladeStand {
  geladen: number;
  gesamt: number;
  restSek: number | null;
}

interface HochladenState {
  stand: Record<string, HochladeStand>;
  setzen: (clientId: string, stand: HochladeStand) => void;
  entfernen: (clientId: string) => void;
}

export const useHochladen = create<HochladenState>((set) => ({
  stand: {},
  setzen: (clientId, stand) => set((alt) => ({ stand: { ...alt.stand, [clientId]: stand } })),
  entfernen: (clientId) =>
    set((alt) => {
      if (!(clientId in alt.stand)) return alt;
      const { [clientId]: _weg, ...rest } = alt.stand;
      return { stand: rest };
    }),
}));

/** Die Abbruchschalter der laufenden Uploads – nicht reaktiv, nur zum Ziehen. */
export const hochladeAbbruch = new Map<string, AbortController>();
