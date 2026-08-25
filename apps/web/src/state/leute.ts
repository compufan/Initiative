import { create } from 'zustand';
import type { UserDto } from '@initiative/shared';
import { api } from '../lib/api.js';

/**
 * Namen zu Kennungen – einmal geholt, dann da.
 *
 * Die Ausgabenliste, die Teilnehmer eines Termins, die Anteile einer Rechnung:
 * Überall stehen Kennungen, und überall braucht es Namen. Bisher holte jede
 * Ansicht sie sich selbst, eine Anfrage je Person. Acht Beteiligte waren acht
 * Anfragen – und weil sie nacheinander über dieselbe Verbindung liefen, stand
 * die Liste spürbar lange ohne Namen da. Genau das hat der Anwender als
 * „dauert nach dem Aktualisieren lange“ gemeldet.
 *
 * Hier wird gesammelt statt einzeln gefragt:
 *
 * - Ein Vorrat im Speicher: Wer einmal geholt wurde, wird nicht wieder geholt.
 * - Anfragen werden **gebündelt**. Fragen fünf Ansichten im selben Augenblick
 *   nach Namen, wird daraus eine Anfrage, nicht fünf.
 * - Wer schon unterwegs ist, wird nicht doppelt angefordert.
 *
 * Bewusst nur im Arbeitsspeicher: Namen ändern sich, und ein alter Name aus
 * einem dauerhaften Speicher wäre schlimmer als eine Anfrage mehr.
 */

interface LeuteState {
  /** Was wir kennen. */
  byId: Record<string, UserDto>;
  /** Sorgt dafür, dass diese Kennungen bekannt sind. */
  sicherstellen: (ids: (string | null | undefined)[]) => void;
  /** Der Name zu einer Kennung – oder ein ehrlicher Platzhalter. */
  name: (id: string | null | undefined, ich?: string) => string;
}

let wartend = new Set<string>();
let unterwegs = new Set<string>();
let geplant: number | null = null;

export const useLeute = create<LeuteState>((set, get) => ({
  byId: {},

  sicherstellen(ids) {
    const { byId } = get();
    let neues = false;
    for (const id of ids) {
      if (!id || byId[id] || unterwegs.has(id) || wartend.has(id)) continue;
      wartend.add(id);
      neues = true;
    }
    if (!neues || geplant != null) return;

    // Ein Wimpernschlag Sammelzeit. In dieser Zeit melden sich alle Ansichten,
    // die gerade dasselbe brauchen – und es wird eine Anfrage daraus.
    geplant = window.setTimeout(() => {
      geplant = null;
      const stapel = [...wartend];
      wartend = new Set();
      if (stapel.length === 0) return;
      stapel.forEach((id) => unterwegs.add(id));

      void api.users
        .batch(stapel)
        .then(({ items }) => {
          set((vorher) => {
            const naechster = { ...vorher.byId };
            for (const person of items) naechster[person.id] = person;
            return { byId: naechster };
          });
        })
        .catch(() => {
          // Beim naechsten Anlauf darf es erneut versucht werden.
        })
        .finally(() => {
          stapel.forEach((id) => unterwegs.delete(id));
        });
    }, 20);
  },

  name(id, ich) {
    if (!id) return 'Unbekannt';
    if (ich && id === ich) return 'Du';
    return get().byId[id]?.displayName ?? '…';
  },
}));

/** Namen für diese Kennungen bereitstellen und die Nachschlagefunktion geben. */
export function useNamen(ids: (string | null | undefined)[], ich?: string) {
  const byId = useLeute((state) => state.byId);
  useLeute.getState().sicherstellen(ids);
  return (id: string | null | undefined) => {
    if (!id) return 'Unbekannt';
    if (ich && id === ich) return 'Du';
    return byId[id]?.displayName ?? '…';
  };
}
