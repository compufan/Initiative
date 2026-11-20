import { create } from 'zustand';
import { api } from '../lib/api.js';

/**
 * Gespeicherte Nachrichten („Sternchen“) – nur die Kennungen.
 *
 * Die Blase zeigt ein Sternchen, das Blatt bietet „Speichern“ oder
 * „Nicht mehr speichern“ an. Dafür genügt die Menge der Kennungen; die Liste
 * mit Inhalt lädt der Bildschirm „Gespeicherte Nachrichten“ selbst. Sterne
 * sieht niemand sonst – der Server meldet Änderungen nur an die eigenen
 * Geräte (`star.updated`).
 */
interface SternState {
  ids: Record<string, true>;
}

export const useSterne = create<SternState>(() => ({ ids: {} }));

export function sternSetzenLokal(messageId: string, gesetzt: boolean): void {
  useSterne.setState((state) => {
    if (Boolean(state.ids[messageId]) === gesetzt) return {};
    const ids = { ...state.ids };
    if (gesetzt) ids[messageId] = true;
    else delete ids[messageId];
    return { ids };
  });
}

export async function sterneLaden(): Promise<void> {
  try {
    const { items } = await api.messages.sternKennungen();
    useSterne.setState({ ids: Object.fromEntries(items.map((id) => [id, true as const])) });
  } catch {
    /* offline – beim nächsten Nachholen */
  }
}

export function sterneVergessen(): void {
  useSterne.setState({ ids: {} });
}
