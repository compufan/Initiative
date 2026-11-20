import { useState } from 'react';
import { SELBSTLOESCHEN_STUFEN, selbstloeschenText, type ConversationDto } from '@initiative/shared';
import { Sheet } from '../../components/Sheet.js';
import { api } from '../../lib/api.js';
import { useChat } from '../../state/chat.js';
import { toast } from '../../state/ui.js';

/**
 * Selbstlöschende Nachrichten einstellen: aus, 24 Stunden, 7 Tage, 90 Tage.
 *
 * Gilt für alle im Chat und nur für Nachrichten, die danach geschrieben
 * werden. Die ehrliche Grenze steht dabei: Ohne Ende-zu-Ende-Verschlüsselung
 * schützt das nicht vor Kopien.
 */
export function SelbstloeschenSheet({
  open,
  conversation,
  darfAendern,
  onClose,
}: {
  open: boolean;
  conversation: ConversationDto | null;
  darfAendern: boolean;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const aktuell = conversation?.selbstloeschenS ?? null;
  const stufen: (number | null)[] = [null, ...SELBSTLOESCHEN_STUFEN];

  async function setzen(sekunden: number | null) {
    if (!conversation || sekunden === aktuell) return;
    setBusy(true);
    try {
      const neu = await api.messages.selbstloeschen(conversation.id, sekunden);
      useChat.getState().upsertConversation(neu);
      toast(
        sekunden ? `Neue Nachrichten verschwinden nach ${selbstloeschenText(sekunden)}` : 'Selbstlöschen aus',
        'success',
      );
      onClose();
    } catch (fehler) {
      toast(fehler instanceof Error ? fehler.message : 'Hat nicht geklappt', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="Selbstlöschende Nachrichten">
      <div className="stack">
        <p className="msg-action-hint">
          Neue Nachrichten in diesem Chat verschwinden nach der gewählten Zeit – bei allen. Ältere
          bleiben, wie sie sind.
        </p>
        <div className="list" role="radiogroup" aria-label="Dauer">
          {stufen.map((sekunden) => (
            <label key={sekunden ?? 'aus'} className="list-row msg-stufe">
              <input
                type="radio"
                name="selbstloeschen"
                checked={aktuell === sekunden}
                disabled={!darfAendern || busy}
                onChange={() => void setzen(sekunden)}
              />
              <span>{selbstloeschenText(sekunden)}</span>
            </label>
          ))}
        </div>
        {!darfAendern && (
          <p className="msg-action-hint">In dieser Gruppe ändern nur Admins diese Einstellung.</p>
        )}
        <p className="msg-hinweis-ehrlich" role="note">
          ⚠️ Ohne Ende-zu-Ende-Verschlüsselung schützt das nicht vor Kopien: Wer die Nachricht sieht,
          kann sie weiterleiten, kopieren oder ein Bildschirmfoto machen.
        </p>
      </div>
    </Sheet>
  );
}
