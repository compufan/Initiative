import { createElement, useMemo, useState } from 'react';
import {
  REACTION_EMOJIS,
  bearbeitenMoeglich,
  bearbeitenRestMinuten,
  fuerAlleLoeschenMoeglich,
  type ConversationDto,
} from '@initiative/shared';
import { api } from '../../lib/api.js';
import { angeheftetLaden, useChatZusatz, verlaufZeigen } from '../../state/angeheftet.js';
import { darfInfoAendern } from './gruppenRechte.js';
import { Sheet } from '../../components/Sheet.js';
import { messageActions } from '../registry.js';
import { useChat, type ChatMessage } from '../../state/chat.js';
import { useSterne } from '../../state/sterne.js';
import { useMyId } from '../../state/session.js';
import { canModerate } from './helpers.js';
import { toast } from '../../state/ui.js';
import { weiterleitbar } from './WeiterleitenSheet.js';

/** Was das Blatt an den Chat zurückgibt – der Chat öffnet die Folgeblätter. */
export interface NachrichtenHandlungen {
  onReply: (message: ChatMessage) => void;
  /** Bearbeiten in der Eingabezeile (wie bei WhatsApp), nicht im Blatt. */
  onEdit: (message: ChatMessage) => void;
  onForward: (message: ChatMessage) => void;
  onInfo: (message: ChatMessage) => void;
  onReaktionen: (message: ChatMessage) => void;
  /** Mehrfachauswahl mit dieser Nachricht beginnen. */
  onAuswaehlen: (message: ChatMessage) => void;
  /**
   * „＋“: die volle Emoji-Auswahl. Sie öffnet der Chat als eigenes Blatt –
   * ein Blatt im Blatt schloss beim ersten Tipp das äussere und nahm das
   * innere mit.
   */
  onEmojiWahl: (message: ChatMessage) => void;
}

interface MessageActionsSheetProps extends NachrichtenHandlungen {
  message: ChatMessage | null;
  conversation: ConversationDto | null;
  onClose: () => void;
}

export function MessageActionsSheet({
  message,
  conversation,
  onClose,
  ...handlungen
}: MessageActionsSheetProps) {
  return (
    <Sheet open={message != null} onClose={onClose} title="Nachricht">
      {message && (
        <Actions
          key={message.id}
          message={message}
          conversation={conversation}
          onClose={onClose}
          {...handlungen}
        />
      )}
    </Sheet>
  );
}

function Actions({
  message,
  conversation,
  onClose,
  onReply,
  onEdit,
  onForward,
  onInfo,
  onReaktionen,
  onAuswaehlen,
  onEmojiWahl,
}: NachrichtenHandlungen & {
  message: ChatMessage;
  conversation: ConversationDto | null;
  onClose: () => void;
}) {
  const myId = useMyId();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const gespeichert = useSterne((state) => Boolean(state.ids[message.id]));

  const isMine = message.senderId == null || message.senderId === myId;
  const isLocal = Boolean(message.pending || message.failed);
  const einmal = message.metadata?.einmalAnsehen === true;
  const canReply = !isLocal && !message.deletedAt;
  /*
   * Bearbeiten: Text und Bildunterschriften, nur in den ersten fünfzehn
   * Minuten (der Server prüft dasselbe). Einmal ansehbare Medien haben keine
   * Unterschrift, Standort und Kontakt sind keine Texte.
   */
  const bearbeitbareArt =
    message.type === 'text' ||
    (['image', 'video', 'file', 'audio'].includes(message.type) && message.attachments.length > 0);
  const canEdit =
    isMine &&
    !isLocal &&
    bearbeitbareArt &&
    !einmal &&
    !message.deletedAt &&
    bearbeitenMoeglich(message.createdAt);
  const angeheftet = useChatZusatz((state) =>
    (state.angeheftet[message.conversationId] ?? []).some((m) => m.id === message.id),
  );
  const darfAnheften =
    !isLocal &&
    !message.deletedAt &&
    !einmal &&
    message.type !== 'system' &&
    conversation != null &&
    (conversation.type === 'direct' || darfInfoAendern(conversation, myId));
  // Lokale Nachrichten haben den Server nie erreicht; sie werden nicht
  // geloescht, sondern aus der Outbox verworfen. Ohne das blieb ein
  // haengender Bild-Upload dauerhaft im Chat stehen.
  //
  // Die beiden Arten zu loeschen haben verschiedene Voraussetzungen, und das
  // ist der ganze Punkt: Den eigenen Verlauf darf jeder raeumen, auch von
  // fremden Nachrichten. Bei ANDEREN etwas verschwinden zu lassen, steht nur
  // dem zu, der es geschrieben hat.
  const kannFuerMich = !isLocal && !message.deletedAt;
  /*
   * Auch die Gruppenverwaltung darf für alle löschen.
   *
   * Hier stand `isMine`, und das war eine Lücke zwischen vier Stellen, die
   * dasselbe sagen sollten: Der Server erlaubt es ausdrücklich
   * (`darf_moderieren` in messages.rs), `canModerate` steht dafür bereit,
   * FEATURES.md verspricht es – nur die Oberfläche bot es nicht an. Wer eine
   * Gruppe verwaltet, konnte eine entgleiste Nachricht nicht entfernen.
   *
   * Der Kommentar unten spricht von etwas anderem: „nur für mich" gegen „für
   * alle". Diese Unterscheidung bleibt, sie hat mit Moderation nichts zu tun.
   */
  const moderiert = !isLocal && canModerate(conversation, myId) && conversation?.type === 'group';
  // Für alle löschen: eigene binnen 48 Stunden, Admins einer Gruppe ohne Frist.
  const canDelete =
    isLocal ||
    moderiert ||
    (isMine && fuerAlleLoeschenMoeglich(message.createdAt, false));
  const canCopy = Boolean(message.body?.trim());

  // Was andere Bereiche der App an dieser Nachricht anbieten – etwa „Zur
  // Sammlung hinzufügen“. Der Messenger muss davon nichts wissen.
  const [offen, setOffen] = useState<string | null>(null);
  const weitere = useMemo(
    () =>
      isLocal || einmal
        ? []
        : messageActions().filter((action) => action.applies(message, conversation)),
    [isLocal, einmal, message, conversation],
  );
  const offeneAktion = weitere.find((action) => action.key === offen);

  /** Habe ich mit diesem Emoji schon reagiert? */
  function istMeins(emoji: string): boolean {
    return message.reactions.some(
      (reaction) => reaction.emoji === emoji && reaction.userIds.includes(myId),
    );
  }

  async function react(emoji: string) {
    const mine = istMeins(emoji);
    try {
      await useChat.getState().toggleReaction(message, emoji, mine);
      onClose();
    } catch {
      toast('Reaktion konnte nicht gespeichert werden', 'error');
    }
  }

  async function copy() {
    const text = message.body ?? '';
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(text);
      toast('Text kopiert', 'success');
      onClose();
    } catch {
      toast('Kopieren wird von diesem Browser nicht unterstützt', 'error');
    }
  }

  async function sternUmschalten() {
    try {
      await useChat.getState().toggleStern(message, !gespeichert);
      toast(gespeichert ? 'Nicht mehr gespeichert' : 'Gespeichert', 'success');
      onClose();
    } catch {
      toast('Speichern hat nicht geklappt', 'error');
    }
  }

  // Einmal ansehbar: weder weiterleiten noch speichern – das wären Kopien.
  const kannWeiterleiten = weiterleitbar(message) && !einmal;
  const kannSpeichern = !isLocal && !message.deletedAt && message.type !== 'system' && !einmal;

  async function anheftenUmschalten() {
    try {
      if (angeheftet) await api.messages.loesen(message.id);
      else await api.messages.anheften(message.id);
      void angeheftetLaden(message.conversationId);
      toast(angeheftet ? 'Gelöst' : 'Angeheftet', 'success');
      onClose();
    } catch (fehler) {
      toast(fehler instanceof Error ? fehler.message : 'Hat nicht geklappt', 'error');
    }
  }
  const kannInfo = isMine && !isLocal && !message.deletedAt;
  const hatReaktionen = message.reactions.length > 0;

  async function remove(scope: 'me' | 'all') {
    setBusy(true);
    try {
      if (isLocal && message.clientId) {
        await useChat.getState().discardFailed(message.conversationId, message.clientId);
      } else {
        await useChat.getState().deleteMessage(message, scope);
      }
      onClose();
    } catch {
      toast('Nachricht konnte nicht gelöscht werden', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="msg-reaction-picker">
        {/*
            Die eigene Reaktion ist zu sehen.

            Der Knopf schaltet um – ein zweiter Tipp nimmt die Reaktion zurück
            (`react` oben) –, nur sah man das der Reihe nicht an: Alle sieben
            Emoji sahen gleich aus, auch das eigene. Wer wissen wollte, ob er
            schon reagiert hatte, musste das Blatt schliessen und unter der
            Nachricht nachsehen. Und wer sein Herz noch einmal antippte, nahm es
            weg, ohne das erwartet zu haben.
        */}
        {REACTION_EMOJIS.map((emoji) => {
          const meins = istMeins(emoji);
          return (
            <button
              key={emoji}
              type="button"
              className={`msg-reaction-choice ${meins ? 'msg-reaction-choice-mine' : ''}`}
              aria-label={meins ? `${emoji} zurücknehmen` : `Mit ${emoji} reagieren`}
              aria-pressed={meins}
              data-tipp={meins ? `${emoji} wieder wegnehmen` : `Mit ${emoji} reagieren`}
              onClick={() => void react(emoji)}
            >
              {emoji}
            </button>
          );
        })}
        <button
          type="button"
          className="msg-reaction-choice msg-reaction-mehr"
          aria-label="Weitere Emoji"
          data-tipp="Alle Emoji mit Suche"
          onClick={() => {
            onEmojiWahl(message);
            onClose();
          }}
        >
          ＋
        </button>
      </div>

      <div className="list msg-action-list">
        {canReply && (
          <button
            type="button"
            className="list-row"
            onClick={() => {
              onReply(message);
              onClose();
            }}
          >
            <span aria-hidden="true">↩️</span>
            <span>Antworten</span>
          </button>
        )}
        {canCopy && (
          <button type="button" className="list-row" onClick={() => void copy()}>
            <span aria-hidden="true">📋</span>
            <span>Kopieren</span>
          </button>
        )}
        {kannWeiterleiten && (
          <button
            type="button"
            className="list-row"
            onClick={() => {
              onForward(message);
              onClose();
            }}
          >
            <span aria-hidden="true">↪️</span>
            <span>Weiterleiten</span>
          </button>
        )}
        {kannSpeichern && (
          <button type="button" className="list-row" onClick={() => void sternUmschalten()}>
            <span aria-hidden="true">{gespeichert ? '☆' : '⭐'}</span>
            <span>{gespeichert ? 'Nicht mehr speichern' : 'Speichern (Stern)'}</span>
          </button>
        )}
        {canEdit && (
          <button
            type="button"
            className="list-row"
            onClick={() => {
              onEdit(message);
              onClose();
            }}
          >
            <span aria-hidden="true">✏️</span>
            <span>
              {message.type === 'text' ? 'Bearbeiten' : 'Bildunterschrift bearbeiten'}
              <small className="msg-action-hint">
                Noch {bearbeitenRestMinuten(message.createdAt)} min möglich
              </small>
            </span>
          </button>
        )}
        {message.editedAt && !message.deletedAt && (
          <button
            type="button"
            className="list-row"
            onClick={() => {
              verlaufZeigen(message);
              onClose();
            }}
          >
            <span aria-hidden="true">🕘</span>
            <span>Bearbeitungsverlauf</span>
          </button>
        )}
        {darfAnheften && (
          <button type="button" className="list-row" onClick={() => void anheftenUmschalten()}>
            <span aria-hidden="true">📌</span>
            <span>{angeheftet ? 'Lösen' : 'Anheften'}</span>
          </button>
        )}
        {hatReaktionen && (
          <button
            type="button"
            className="list-row"
            onClick={() => {
              onReaktionen(message);
              onClose();
            }}
          >
            <span aria-hidden="true">😊</span>
            <span>Wer hat reagiert?</span>
          </button>
        )}
        {kannInfo && (
          <button
            type="button"
            className="list-row"
            onClick={() => {
              onInfo(message);
              onClose();
            }}
          >
            <span aria-hidden="true">ℹ️</span>
            <span>Info (gelesen, zugestellt)</span>
          </button>
        )}
        {!isLocal && (
          <button
            type="button"
            className="list-row"
            onClick={() => {
              onAuswaehlen(message);
              onClose();
            }}
          >
            <span aria-hidden="true">☑️</span>
            <span>Auswählen</span>
          </button>
        )}
        {weitere.map((action) => (
          <button
            key={action.key}
            type="button"
            className="list-row"
            onClick={() => setOffen(action.key)}
          >
            <span aria-hidden="true">{action.icon}</span>
            <span>{action.label}</span>
          </button>
        ))}
        {/*
          Zwei Arten zu löschen, und sie bedeuten etwas ganz Verschiedenes.

          „Nur für mich“ räumt den eigenen Verlauf – ein Foto, das man nicht
          ständig sehen will. Bei allen anderen bleibt alles, wie es war, und
          deshalb geht das auch mit fremden Nachrichten.

          „Für alle“ nimmt sie überall zurück und ist deshalb auf eigene
          Nachrichten beschränkt (Gruppenverwalter dürfen mehr). Fremde Worte
          aus einem fremden Verlauf zu entfernen, steht niemandem zu.

          Der Sicherheitsschritt hängt nur an „für alle“: Nur dort ist das
          Löschen nicht mehr rückgängig zu machen.
        */}
        {kannFuerMich && (
          <button
            type="button"
            className="list-row"
            disabled={busy}
            onClick={() => void remove('me')}
          >
            <span aria-hidden="true">🙈</span>
            <span>
              Nur für mich löschen
              <small className="msg-action-hint">Die anderen sehen sie weiterhin</small>
            </span>
          </button>
        )}
        {canDelete && (
          <button
            type="button"
            className="list-row msg-action-danger"
            disabled={busy}
            onClick={() =>
              isLocal
                ? void remove('all')
                : confirmDelete
                  ? void remove('all')
                  : setConfirmDelete(true)
            }
          >
            <span aria-hidden="true">🗑️</span>
            <span>
              {isLocal ? (
                'Verwerfen'
              ) : confirmDelete ? (
                'Wirklich für alle löschen?'
              ) : (
                <>
                  Für alle löschen
                  <small className="msg-action-hint">Verschwindet bei allen im Chat</small>
                </>
              )}
            </span>
          </button>
        )}
      </div>

      {offeneAktion &&
        createElement(offeneAktion.render, {
          message,
          conversation,
          onClose: () => {
            setOffen(null);
            onClose();
          },
        })}
    </div>
  );
}
