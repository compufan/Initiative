import { create } from 'zustand';

/**
 * Der Suchbegriff der Suche im Chat – damit die Blasen ihre Treffer markieren.
 *
 * Ein eigener kleiner Speicher statt einer Eigenschaft an jeder Blase: Die
 * Blasen sind `memo`-gekapselt (`blasenPropsGleich`), und ein neuer Begriff
 * hätte jede Blase über ihre Eigenschaften neu zeichnen lassen. So zeichnen
 * nur die Textblasen dieses Chats, die den Begriff lesen.
 */
interface SuchState {
  conversationId: string | null;
  begriff: string | null;
}

export const useSuche = create<SuchState>(() => ({ conversationId: null, begriff: null }));

export function suchbegriffSetzen(conversationId: string | null, begriff: string | null): void {
  const sauber = begriff?.trim() ? begriff.trim() : null;
  useSuche.setState({ conversationId, begriff: sauber });
}

export function useSuchbegriff(conversationId: string): string | null {
  return useSuche((state) => (state.conversationId === conversationId ? state.begriff : null));
}
