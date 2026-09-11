/**
 * Anträge auf den Verlauf vor dem eigenen Beitritt.
 *
 * Bewusst ein eigener Speicher und nicht Teil von `useChat`: Die Liste hängt
 * an einem geöffneten Gespräch, wird selten gebraucht und würde sonst bei
 * jeder eintreffenden Nachricht mit neu gezeichnet.
 */
import { create } from 'zustand';
import type { VerlaufsantragDto } from '@initiative/shared';
import { ApiError, api } from '../lib/api.js';
import { realtime } from '../lib/realtime.js';
import { useChat } from './chat.js';

const LEER: VerlaufsantragDto[] = [];

interface VerlaufState {
  antraege: Record<string, VerlaufsantragDto[]>;
  /** Läuft gerade ein Aufruf für dieses Gespräch? Sperrt die Knöpfe. */
  laeuft: Record<string, boolean>;
  laden: (conversationId: string) => Promise<void>;
  stellen: (conversationId: string) => Promise<void>;
  abstimmen: (conversationId: string, antragId: string, zustimmung: boolean) => Promise<void>;
  zurueckziehen: (conversationId: string, antragId: string) => Promise<void>;
}

/**
 * Nach jeder Entscheidung die Wahrheit nachholen.
 *
 * Der Server schickt zum Antrag nur „da hat sich etwas getan" und keinen
 * Inhalt – die Antwort hängt davon ab, wer fragt. Wurde mein Antrag
 * angenommen, ist ausserdem meine Grenze gefallen; das steht in `siehtAb` am
 * Mitglied und nicht im Antrag. Deshalb wird die Gesprächsliste neu geholt und
 * der Verlauf nur dann nachgeladen, wenn die Grenze wirklich verschwunden ist:
 * Der Vergleich vorher/nachher ist die einzige Auskunft, die nicht rät.
 */
async function nachziehen(conversationId: string, meineId: string): Promise<void> {
  const vorher = useChat
    .getState()
    .conversations.find((chat) => chat.id === conversationId)
    ?.members.find((mitglied) => mitglied.userId === meineId)?.siehtAb;

  await useChat.getState().loadConversations();

  const nachher = useChat
    .getState()
    .conversations.find((chat) => chat.id === conversationId)
    ?.members.find((mitglied) => mitglied.userId === meineId)?.siehtAb;

  if (vorher != null && nachher == null) {
    await useChat.getState().loadMessages(conversationId, { force: true });
  }
}

export const useVerlauf = create<VerlaufState>((set, get) => ({
  antraege: {},
  laeuft: {},

  async laden(conversationId) {
    try {
      const { items } = await api.verlauf.offene(conversationId);
      set((state) => ({ antraege: { ...state.antraege, [conversationId]: items } }));
    } catch (error) {
      // Offline bleibt stehen, was da ist: Ein leerer Streifen wäre die
      // Behauptung, es gebe keinen Antrag – und das wäre womöglich falsch.
      if (!(error instanceof ApiError && error.isOffline)) throw error;
    }
  },

  async stellen(conversationId) {
    if (get().laeuft[conversationId]) return;
    set((state) => ({ laeuft: { ...state.laeuft, [conversationId]: true } }));
    try {
      const antrag = await api.verlauf.stellen(conversationId);
      set((state) => ({
        antraege: {
          ...state.antraege,
          [conversationId]: [
            ...(state.antraege[conversationId] ?? []).filter((alt) => alt.id !== antrag.id),
            antrag,
          ],
        },
      }));
    } finally {
      set((state) => ({ laeuft: { ...state.laeuft, [conversationId]: false } }));
    }
  },

  async abstimmen(conversationId, antragId, zustimmung) {
    if (get().laeuft[conversationId]) return;
    set((state) => ({ laeuft: { ...state.laeuft, [conversationId]: true } }));
    try {
      const antrag = await api.verlauf.abstimmen(conversationId, antragId, zustimmung);
      set((state) => ({
        antraege: {
          ...state.antraege,
          [conversationId]: (state.antraege[conversationId] ?? []).map((alt) =>
            alt.id === antrag.id ? antrag : alt,
          ),
        },
      }));
    } finally {
      set((state) => ({ laeuft: { ...state.laeuft, [conversationId]: false } }));
    }
  },

  async zurueckziehen(conversationId, antragId) {
    if (get().laeuft[conversationId]) return;
    set((state) => ({ laeuft: { ...state.laeuft, [conversationId]: true } }));
    try {
      await api.verlauf.zurueckziehen(conversationId, antragId);
      set((state) => ({
        antraege: {
          ...state.antraege,
          [conversationId]: (state.antraege[conversationId] ?? []).filter(
            (alt) => alt.id !== antragId,
          ),
        },
      }));
    } finally {
      set((state) => ({ laeuft: { ...state.laeuft, [conversationId]: false } }));
    }
  },
}));

export function antraegeVon(state: VerlaufState, conversationId: string): VerlaufsantragDto[] {
  return state.antraege[conversationId] ?? LEER;
}

let verdrahtet = false;
export function connectVerlaufRealtime(meineId: () => string): void {
  if (verdrahtet) return;
  verdrahtet = true;

  realtime.on('verlauf.antrag', ({ conversationId }) => {
    void (async () => {
      await useVerlauf.getState().laden(conversationId);
      await nachziehen(conversationId, meineId());
    })();
  });
}
