import { useState } from 'react';
import { messagePreview, ohneFormatierung, type ConversationDto } from '@initiative/shared';
import { Sheet } from '../../components/Sheet.js';
import { useChat, type ChatMessage } from '../../state/chat.js';
import { useSterne } from '../../state/sterne.js';
import { useMyId } from '../../state/session.js';
import { toast } from '../../state/ui.js';
import { canModerate, senderName } from './helpers.js';
import { weiterleitbar } from './WeiterleitenSheet.js';

/**
 * Die Kopfleiste der Mehrfachauswahl: wie viele, und was mit ihnen geschehen
 * soll – antworten (bei einer), speichern, kopieren, weiterleiten, löschen.
 */
export function AuswahlLeiste({
  nachrichten,
  conversation,
  onAbbrechen,
  onAntworten,
  onWeiterleiten,
  onMehr,
}: {
  nachrichten: ChatMessage[];
  conversation: ConversationDto | null;
  onAbbrechen: () => void;
  onAntworten: (message: ChatMessage) => void;
  onWeiterleiten: (nachrichten: ChatMessage[]) => void;
  onMehr: (message: ChatMessage) => void;
}) {
  const myId = useMyId();
  const sterne = useSterne((state) => state.ids);
  const [loeschenFrage, setLoeschenFrage] = useState(false);
  const anzahl = nachrichten.length;
  const eine = anzahl === 1 ? nachrichten[0] : null;
  const alleGespeichert = anzahl > 0 && nachrichten.every((item) => sterne[item.id]);
  const lebend = nachrichten.filter((item) => !item.deletedAt);
  const kannWeiterleiten = nachrichten.some(weiterleitbar);
  const darfModerieren = canModerate(conversation, myId);
  // „Für alle“ nur, wenn es für JEDE ausgewählte geht – sonst wäre unklar,
  // welche verschwinden und welche nicht.
  const kannFuerAlle =
    lebend.length === anzahl &&
    nachrichten.every((item) => item.senderId === myId || darfModerieren);

  async function kopieren() {
    const text = nachrichten
      .filter((item) => item.type !== 'system')
      .map((item) => {
        const zeit = new Date(item.createdAt).toLocaleString('de-DE', {
          day: '2-digit',
          month: '2-digit',
          year: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        });
        const name = item.senderId === myId ? 'Ich' : senderName(conversation, item.senderId);
        const inhalt = item.body?.trim() ? item.body.trim() : ohneFormatierung(messagePreview(item));
        return `[${zeit}] ${name}: ${inhalt}`;
      })
      .join('\n');
    try {
      if (!navigator.clipboard) throw new Error('clipboard');
      await navigator.clipboard.writeText(text);
      toast(anzahl === 1 ? 'Nachricht kopiert' : `${anzahl} Nachrichten kopiert`, 'success');
      onAbbrechen();
    } catch {
      toast('Kopieren wird von diesem Browser nicht unterstützt', 'error');
    }
  }

  async function speichern() {
    const setzen = !alleGespeichert;
    try {
      for (const item of lebend) {
        if (Boolean(sterne[item.id]) !== setzen) await useChat.getState().toggleStern(item, setzen);
      }
      toast(setzen ? 'Gespeichert' : 'Nicht mehr gespeichert', 'success');
      onAbbrechen();
    } catch {
      toast('Speichern hat nicht geklappt', 'error');
    }
  }

  async function loeschen(scope: 'me' | 'all') {
    setLoeschenFrage(false);
    let fehler = 0;
    for (const item of nachrichten) {
      try {
        await useChat.getState().deleteMessage(item, scope);
      } catch {
        fehler += 1;
      }
    }
    if (fehler > 0) toast(`${fehler} liessen sich nicht löschen`, 'error');
    onAbbrechen();
  }

  return (
    <header className="app-header msg-header msg-auswahl-leiste" aria-label="Auswahl">
      <button type="button" className="icon-btn" aria-label="Auswahl beenden" onClick={onAbbrechen}>
        ✕
      </button>
      <span className="msg-auswahl-zahl" aria-live="polite">
        {anzahl === 1 ? '1 ausgewählt' : `${anzahl} ausgewählt`}
      </span>
      <span className="msg-auswahl-knoepfe">
        {eine && !eine.deletedAt && (
          <button
            type="button"
            className="icon-btn"
            aria-label="Antworten"
            title="Antworten"
            onClick={() => onAntworten(eine)}
          >
            ↩️
          </button>
        )}
        {lebend.length > 0 && (
          <button
            type="button"
            className="icon-btn"
            aria-label={alleGespeichert ? 'Nicht mehr speichern' : 'Speichern'}
            title={alleGespeichert ? 'Nicht mehr speichern' : 'Speichern (Stern)'}
            aria-pressed={alleGespeichert}
            onClick={() => void speichern()}
          >
            {alleGespeichert ? '☆' : '⭐'}
          </button>
        )}
        <button
          type="button"
          className="icon-btn"
          aria-label="Kopieren"
          title="Als Text mit Absender und Zeit kopieren"
          onClick={() => void kopieren()}
        >
          📋
        </button>
        {kannWeiterleiten && (
          <button
            type="button"
            className="icon-btn"
            aria-label="Weiterleiten"
            title="Weiterleiten"
            onClick={() => onWeiterleiten(nachrichten)}
          >
            ↪️
          </button>
        )}
        <button
          type="button"
          className="icon-btn"
          aria-label="Löschen"
          title="Löschen"
          onClick={() => setLoeschenFrage(true)}
        >
          🗑️
        </button>
        {eine && (
          <button
            type="button"
            className="icon-btn"
            aria-label="Weitere Aktionen"
            title="Weitere Aktionen"
            onClick={() => onMehr(eine)}
          >
            ⋯
          </button>
        )}
      </span>

      <Sheet
        open={loeschenFrage}
        onClose={() => setLoeschenFrage(false)}
        title={anzahl === 1 ? 'Nachricht löschen?' : `${anzahl} Nachrichten löschen?`}
      >
        <div className="list msg-action-list">
          <button type="button" className="list-row" onClick={() => void loeschen('me')}>
            <span aria-hidden="true">🙈</span>
            <span>
              Nur für mich löschen
              <small className="msg-action-hint">Die anderen sehen sie weiterhin</small>
            </span>
          </button>
          {kannFuerAlle && (
            <button
              type="button"
              className="list-row msg-action-danger"
              onClick={() => void loeschen('all')}
            >
              <span aria-hidden="true">🗑️</span>
              <span>
                Für alle löschen
                <small className="msg-action-hint">Verschwindet bei allen im Chat</small>
              </span>
            </button>
          )}
          <button type="button" className="list-row" onClick={() => setLoeschenFrage(false)}>
            <span aria-hidden="true">✕</span>
            <span>Abbrechen</span>
          </button>
        </div>
      </Sheet>
    </header>
  );
}
