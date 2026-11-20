import { create } from 'zustand';
import type { GeplantDto, MessageDto } from '@initiative/shared';
import { api } from '../lib/api.js';
import { realtime } from '../lib/realtime.js';

/**
 * Angeheftete Nachrichten und geplante Nachrichten je Chat.
 *
 * Beide holt der Bildschirm, wenn ein Chat aufgeht, und der Server meldet
 * Änderungen nur als Hinweis (`conversation.angeheftet`, `geplant.updated`) –
 * was angeheftet ist, hängt an der Verlaufsgrenze des Betrachters, und
 * Geplantes sieht nur der Absender. Neu holen ist dafür der einfachste
 * richtige Weg.
 */
interface ChatZusatzState {
  angeheftet: Record<string, MessageDto[]>;
  geplant: Record<string, GeplantDto[]>;
  /** Für welche Nachricht das Blatt „Bearbeitungsverlauf“ offen ist. */
  verlaufFuer: MessageDto | null;
}

export const useChatZusatz = create<ChatZusatzState>(() => ({
  angeheftet: {},
  geplant: {},
  verlaufFuer: null,
}));

/** Das Blatt „Bearbeitungsverlauf“ öffnen (aus der Blase oder dem Menü). */
export function verlaufZeigen(message: MessageDto | null): void {
  useChatZusatz.setState({ verlaufFuer: message });
}

export async function angeheftetLaden(conversationId: string): Promise<void> {
  try {
    const { items } = await api.messages.angeheftet(conversationId);
    useChatZusatz.setState((state) => ({
      angeheftet: { ...state.angeheftet, [conversationId]: items },
    }));
  } catch {
    /* offline – der Banner bleibt, wie er war */
  }
}

export async function geplantLaden(conversationId: string): Promise<void> {
  try {
    const { items } = await api.messages.geplant(conversationId);
    useChatZusatz.setState((state) => ({
      geplant: { ...state.geplant, [conversationId]: items },
    }));
  } catch {
    /* offline */
  }
}

/** Eine gelöschte Nachricht verschwindet auch aus dem Banner, sofort. */
export function angeheftetOhne(conversationId: string, messageId: string): void {
  useChatZusatz.setState((state) => {
    const liste = state.angeheftet[conversationId];
    if (!liste?.some((m) => m.id === messageId)) return {};
    return {
      angeheftet: {
        ...state.angeheftet,
        [conversationId]: liste.filter((m) => m.id !== messageId),
      },
    };
  });
}

let verdrahtet = false;

/** Einmal: auf die Hinweise des Servers hören. */
export function chatZusatzVerdrahten(): void {
  if (verdrahtet) return;
  verdrahtet = true;
  realtime.on('conversation.angeheftet', ({ conversationId }) => {
    void angeheftetLaden(conversationId);
  });
  realtime.on('geplant.updated', ({ conversationId }) => {
    void geplantLaden(conversationId);
  });
  realtime.on('message.deleted', ({ conversationId, messageId }) =>
    angeheftetOhne(conversationId, messageId),
  );
}
