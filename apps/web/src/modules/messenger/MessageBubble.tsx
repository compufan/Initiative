import { memo, useState, type ComponentType, type PointerEvent as ReactPointerEvent } from 'react';
import { hakenText, messagePreview, ohneFormatierung, type Haken } from '@initiative/shared';
import { messageRenderers } from '../registry.js';
import type { MessageRendererProps } from '../types.js';
import { Avatar } from '../../components/Avatar.js';
import { useChat } from '../../state/chat.js';
import { useMyId } from '../../state/session.js';
import { toast } from '../../state/ui.js';
import { TextBubble } from './TextBubble.js';
import { formatTime, senderName } from './helpers.js';
import { useLongPress } from './useLongPress.js';
import { blasenPropsGleich, type BlasenProps } from './praesenz.js';
import { ConfirmDialog } from '../profile/ConfirmDialog.js';
import { useSterne } from '../../state/sterne.js';
import { useWischenZumAntworten } from './wischen.js';

let rendererCache: Record<string, ComponentType<MessageRendererProps>> | null = null;

/** Renderer lookup across all modules; unknown types fall back to plain text. */
function rendererFor(type: string): ComponentType<MessageRendererProps> {
  rendererCache ??= messageRenderers();
  return rendererCache[type] ?? TextBubble;
}

/*
 * Eine Blase zeichnet nur neu, wenn sich IHRE Daten ändern.
 *
 * Ohne `memo` lief bei jeder neuen Nachricht, jedem Tippen-Hinweis und jedem
 * Scrollen ans Ende (`showJump`) der ganze Verlauf durch React – bei einem
 * Chat mit ein paar hundert geladenen Nachrichten spürbar auf einem älteren
 * Telefon. Was „ihre Daten" heisst, steht in `blasenPropsGleich`.
 */
export const MessageBubble = memo(MessageBubbleInnen, blasenPropsGleich);

function MessageBubbleInnen({
  message,
  conversation,
  showSender,
  showAvatar,
  onOpenActions,
  onJumpTo,
  haken = null,
  auswahl = null,
  onAuswahl,
  onReply,
  onReaktionen,
}: BlasenProps) {
  const myId = useMyId();
  const isMine = message.senderId == null || message.senderId === myId;
  const Renderer = rendererFor(message.type);
  const istLokal = Boolean(message.pending || message.failed) || message.id.startsWith('local:');
  /*
   * Langes Drücken beginnt die Auswahl (wie bei WhatsApp); in der Auswahl
   * schaltet es um. Das Menü einer einzelnen Nachricht bleibt über „⋯“
   * erreichbar – auch mit der Tastatur. Lokale (noch nicht gesendete)
   * Nachrichten lassen sich nicht auswählen; für sie gibt es das Menü.
   */
  const longPress = useLongPress(() => {
    if (onAuswahl && !istLokal) onAuswahl(message);
    else onOpenActions(message);
  });
  const wischen = useWischenZumAntworten(
    onReply && auswahl === null && !istLokal && !message.deletedAt ? () => onReply(message) : null,
  );
  const gespeichert = useSterne((state) => Boolean(state.ids[message.id]));
  // Vor der frühen Rückkehr für Systemnachrichten: Ein Haken darf nicht
  // manchmal laufen und manchmal nicht.
  const [verwerfenFrage, setVerwerfenFrage] = useState(false);

  if (message.type === 'system') {
    return <Renderer message={message} conversation={conversation} isMine={isMine} />;
  }

  const isGroup = conversation?.type === 'group';
  const showName = showSender && isGroup && !isMine;

  async function retry() {
    if (!message.clientId) return;
    try {
      await useChat.getState().retryFailed(message.conversationId, message.clientId);
    } catch {
      toast('Erneutes Senden fehlgeschlagen', 'error');
    }
  }

  async function discard() {
    if (!message.clientId) return;
    try {
      await useChat.getState().discardFailed(message.conversationId, message.clientId);
      toast('Nachricht verworfen', 'success');
    } catch {
      toast('Verwerfen fehlgeschlagen', 'error');
    }
  }

  async function toggleReaction(emoji: string, mine: boolean) {
    try {
      await useChat.getState().toggleReaction(message, emoji, mine);
    } catch {
      toast('Reaktion konnte nicht gespeichert werden', 'error');
    }
  }

  const imAuswahlModus = auswahl !== null;
  const weitergeleitet = message.metadata?.weitergeleitet;

  // Beide Gesten am selben Element: langes Drücken und Wischen.
  const gesten = {
    ...longPress,
    onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
      longPress.onPointerDown(event);
      wischen.onPointerDown(event);
    },
    onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
      longPress.onPointerMove(event);
      wischen.onPointerMove(event);
    },
    onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
      longPress.onPointerUp();
      wischen.onPointerUp(event);
    },
    onPointerCancel(event: ReactPointerEvent<HTMLDivElement>) {
      longPress.onPointerCancel();
      wischen.onPointerCancel(event);
    },
  };

  return (
    <div
      className={`msg-row ${isMine ? 'msg-row-mine' : 'msg-row-theirs'}${showAvatar ? ' msg-row-start' : ''}${auswahl ? ' msg-row-ausgewaehlt' : ''}`}
      data-message-id={message.id}
      // In der Auswahl schaltet ein Tipp irgendwo auf die Zeile um.
      onClickCapture={
        imAuswahlModus && onAuswahl && !istLokal
          ? (event) => {
              event.preventDefault();
              event.stopPropagation();
              onAuswahl(message);
            }
          : undefined
      }
    >
      {imAuswahlModus && !istLokal && (
        <input
          type="checkbox"
          className="msg-auswahl"
          checked={auswahl}
          aria-label={`Nachricht auswählen: ${ohneFormatierung(messagePreview(message)).slice(0, 60)}`}
          onChange={() => onAuswahl?.(message)}
        />
      )}
      {!isMine && (
        <span className="msg-avatar-slot">
          {showAvatar && isGroup && (
            <Avatar
              name={senderName(conversation, message.senderId)}
              id={message.senderId ?? message.id}
              url={
                conversation?.members.find((member) => member.userId === message.senderId)?.user
                  .avatarUrl ?? null
              }
              size={30}
            />
          )}
        </span>
      )}

      <div className="msg-col" {...gesten}>
        {showName && (
          <span className="msg-sender">{senderName(conversation, message.senderId)}</span>
        )}

        {weitergeleitet && (
          <span className="msg-weitergeleitet">
            <span aria-hidden="true">↪ </span>
            {weitergeleitet.von ? `Weitergeleitet von ${weitergeleitet.von}` : 'Weitergeleitet'}
          </span>
        )}

        {message.replyTo && (
          <button
            type="button"
            className="msg-quote"
            onClick={() => message.replyTo && onJumpTo(message.replyTo.id)}
          >
            <span className="msg-quote-name">
              {senderName(conversation, message.replyTo.senderId)}
            </span>
            <span className="msg-quote-text truncate">{messagePreview(message.replyTo)}</span>
          </button>
        )}

        <Renderer message={message} conversation={conversation} isMine={isMine} />

        <div className="msg-meta">
          {gespeichert && (
            <span className="msg-stern" aria-label="gespeichert" title="gespeichert">
              ⭐
            </span>
          )}
          {message.editedAt && <span>bearbeitet</span>}
          <span>{formatTime(message.createdAt)}</span>
          {isMine && message.pending && <span aria-label="wird gesendet">⏳</span>}
          {isMine && message.failed && (
            <>
              <button
                type="button"
                className="msg-retry"
                data-tipp="Schickt die Nachricht noch einmal – der Text bleibt erhalten"
                onClick={() => void retry()}
              >
                ⚠️ Erneut senden
              </button>
              {/*
                  Verwerfen fragt nach.

                  Ein Tipp löschte den Outbox-Eintrag sofort, und damit war der
                  getippte Text unwiederbringlich fort – bei einer Nachricht,
                  die man gerade deshalb noch sieht, weil sie NICHT abgeschickt
                  werden konnte. Der Knopf sass dabei sechs Pixel neben „Erneut
                  senden“, also genau da, wo man hin will. Für „Für alle
                  löschen“ gibt es diese Rückfrage längst.
              */}
              <button
                type="button"
                className="msg-retry msg-retry-verwerfen"
                data-tipp="Wirft die nicht gesendete Nachricht weg – der Text ist danach fort"
                onClick={() => setVerwerfenFrage(true)}
              >
                Verwerfen
              </button>
            </>
          )}
          {isMine && !message.pending && !message.failed && (
            <Haekchen haken={haken ?? 'gesendet'} />
          )}
        </div>

        {message.reactions.length > 0 && (
          <div className="msg-reactions">
            {message.reactions.map((reaction) => {
              const mine = reaction.userIds.includes(myId);
              return (
                <button
                  key={reaction.emoji}
                  type="button"
                  className={`msg-reaction ${mine ? 'msg-reaction-mine' : ''}`}
                  onClick={() => void toggleReaction(reaction.emoji, mine)}
                  /*
                   * Das Emoji ist `aria-hidden`, sichtbar bleibt nur eine
                   * Zahl. Eine Vorlesehilfe las hier also „3" und sonst
                   * nichts – und ein Sehender wusste nicht, dass ein Tipp
                   * die eigene Reaktion setzt oder zurücknimmt.
                   */
                  aria-label={
                    mine
                      ? `Deine Reaktion ${reaction.emoji} zurücknehmen (${reaction.userIds.length})`
                      : `Mit ${reaction.emoji} reagieren (${reaction.userIds.length})`
                  }
                  aria-pressed={mine}
                  data-tipp={
                    mine
                      ? 'Nimmt deine Reaktion wieder zurück'
                      : 'Du reagierst mit diesem Emoji – noch einmal tippen nimmt es zurück'
                  }
                >
                  <span aria-hidden="true">{reaction.emoji}</span>
                  <span>{reaction.userIds.length}</span>
                </button>
              );
            })}
            {onReaktionen && (
              <button
                type="button"
                className="msg-reaction msg-reaction-wer"
                aria-label="Wer hat reagiert?"
                data-tipp="Zeigt, wer womit reagiert hat"
                onClick={() => onReaktionen(message)}
              >
                <span aria-hidden="true">⋯</span>
              </button>
            )}
          </div>
        )}
      </div>

      {!imAuswahlModus && (
        <button
          type="button"
          className="msg-more icon-btn"
          aria-label="Nachrichtenoptionen"
          onClick={() => onOpenActions(message)}
        >
          ⋯
        </button>
      )}

      {verwerfenFrage && (
        <ConfirmDialog
          open
          title="Nachricht verwerfen?"
          /*
              Was verloren geht, hängt an der Art.
              „Der getippte Text" stimmt für eine Textnachricht; bei einem Foto,
              einer Sprachnachricht oder einer Datei gibt es keinen Text, und der
              Satz beschriebe etwas, das gar nicht auf dem Spiel steht.
          */
          description={
            message.type === 'text'
              ? 'Der getippte Text ist danach fort. Sie wurde nie gesendet – niemand sonst hat sie gesehen.'
              : 'Der Anhang wird nicht mehr gesendet und aus dem Verlauf genommen. Niemand sonst hat ihn gesehen.'
          }
          confirmLabel="Verwerfen"
          cancelLabel="Behalten"
          danger
          onCancel={() => setVerwerfenFrage(false)}
          onConfirm={() => {
            setVerwerfenFrage(false);
            void discard();
          }}
        />
      )}
    </div>
  );
}

/**
 * ✓ gesendet, ✓✓ zugestellt, ✓✓ blau gelesen.
 *
 * Nicht nur die Farbe unterscheidet „gelesen“: Für Vorlesehilfen steht es im
 * Namen, und wer Blau nicht sieht, erkennt es am kräftigeren Strich.
 */
export function Haekchen({ haken }: { haken: Haken }) {
  if (haken === 'wartet') return null;
  const doppelt = haken !== 'gesendet';
  return (
    <span
      className={`msg-haken${haken === 'gelesen' ? ' msg-haken-gelesen' : ''}`}
      role="img"
      aria-label={hakenText(haken)}
      title={hakenText(haken)}
      data-haken={haken}
    >
      {doppelt ? '✓✓' : '✓'}
    </span>
  );
}
