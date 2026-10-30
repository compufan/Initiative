import { useFiles } from '../modules/files/state.js';
import { useChat } from './chat.js';
import { useLeute } from './leute.js';
import { useVerlauf } from './verlauf.js';

/**
 * Den Arbeitsspeicher des abgemeldeten Kontos leeren.
 *
 * `logout` räumt IndexedDB und den Medienspeicher – die Zustände im
 * Arbeitsspeicher blieben aber stehen, denn die Seite wird beim Abmelden nicht
 * neu geladen. Meldete sich danach im selben Tab jemand anderes an, sah er die
 * Chatliste des Vorgängers, bis die eigene vom Server kam; ohne Netz blieb sie
 * ganz stehen. Ebenso dessen Nachrichten, Sammlungen und Verlaufsanträge.
 *
 * `getInitialState` ist der Zustand von `create` – mit den Aktionen, also
 * dasselbe wie nach einem frischen Laden der Seite.
 */
export function sitzungsZustandLeeren(): void {
  useChat.setState(useChat.getInitialState(), true);
  useVerlauf.setState(useVerlauf.getInitialState(), true);
  useFiles.setState(useFiles.getInitialState(), true);
  useLeute.setState(useLeute.getInitialState(), true);
}
