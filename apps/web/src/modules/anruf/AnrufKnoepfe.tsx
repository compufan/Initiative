import type { ConversationDto } from '@initiative/shared';
import { counterpartOf } from '../messenger/helpers.js';
import { anrufen, useAnruf } from './anruf.js';
import { istBelegt } from './klingelZustand.js';

/**
 * „Anrufen“ und „Videoanruf“ im Kopf eines Direktchats.
 *
 * Nur im Direktchat: Gruppenanrufe bräuchten einen Medienserver (SFU) und
 * gibt es nicht (siehe `docs/FEATURES.md`). Ohne WebRTC im Browser fehlen die
 * Knöpfe ganz, statt auf einen Fehler zu führen.
 */
export function AnrufKnoepfe({
  conversation,
  myId,
}: {
  conversation: ConversationDto;
  myId: string;
}) {
  const belegt = useAnruf((zustand) => istBelegt(zustand));
  if (conversation.type !== 'direct') return null;
  if (typeof RTCPeerConnection === 'undefined' || !navigator.mediaDevices?.getUserMedia)
    return null;
  const gegenueber = counterpartOf(conversation, myId);
  if (!gegenueber) return null;
  return (
    <>
      <button
        type="button"
        className="icon-btn"
        aria-label="Anrufen"
        title="Anrufen"
        disabled={belegt}
        onClick={() => void anrufen(conversation.id, gegenueber.userId, false)}
      >
        <span aria-hidden="true">📞</span>
      </button>
      <button
        type="button"
        className="icon-btn"
        aria-label="Videoanruf"
        title="Videoanruf"
        disabled={belegt}
        onClick={() => void anrufen(conversation.id, gegenueber.userId, true)}
      >
        <span aria-hidden="true">🎥</span>
      </button>
    </>
  );
}
