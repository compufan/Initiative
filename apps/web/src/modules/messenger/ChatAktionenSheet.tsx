import { useState } from 'react';
import type { ChatOrdnerDto, ConversationDto } from '@initiative/shared';
import { Sheet } from '../../components/Sheet.js';
import { api } from '../../lib/api.js';
import { verwaltung } from '../../lib/verwaltungApi.js';
import { useChat } from '../../state/chat.js';
import { useMyId } from '../../state/session.js';
import { toast } from '../../state/ui.js';
import {
  darfAnheften,
  istStumm,
  istUngelesen,
  STUMM_VORGABEN,
  stummBis,
  stummText,
  verschieben,
} from './chatliste.js';
import { geleertAnwenden } from './leeren.js';
import { conversationTitle } from './helpers.js';

function fehlertext(fehler: unknown, ersatz: string): string {
  return fehler instanceof Error && fehler.message ? fehler.message : ersatz;
}

/** Der Chat gilt als gelesen: Lesezeichen auf die letzte Nachricht, Markierung weg. */
export async function alsGelesen(chat: ConversationDto): Promise<void> {
  const letzte = chat.lastMessage;
  if (letzte && !letzte.id.startsWith('local-')) {
    await api.conversations.markRead(chat.id, letzte.id);
  }
  const neu = await verwaltung.gruppe.aendern(chat.id, { markedUnread: false });
  useChat.getState().upsertConversation({ ...neu, unreadCount: 0 });
}

export async function lesenUmschalten(chat: ConversationDto): Promise<void> {
  if (istUngelesen(chat)) {
    await alsGelesen(chat);
    toast('Als gelesen markiert', 'success');
  } else {
    const neu = await verwaltung.gruppe.aendern(chat.id, { markedUnread: true });
    useChat.getState().upsertConversation(neu);
    toast('Als ungelesen markiert', 'success');
  }
}

export async function archivUmschalten(chat: ConversationDto): Promise<ConversationDto> {
  const neu = await verwaltung.gruppe.aendern(chat.id, { archived: !chat.archived });
  useChat.getState().upsertConversation(neu);
  toast(neu.archived ? 'Chat archiviert' : 'Aus dem Archiv geholt', 'success');
  return neu;
}

interface ChatAktionenSheetProps {
  chat: ConversationDto | null;
  alle: ConversationDto[];
  ordner: ChatOrdnerDto[];
  onOrdnerGeaendert: (ordner: ChatOrdnerDto) => void;
  onClose: () => void;
  /** Nach Archivieren/Löschen: Die Liste nimmt den Chat heraus bzw. auf. */
  onGeaendert?: (chat: ConversationDto | null, id: string) => void;
}

/**
 * Das Menü eines Chats in der Liste – langes Drücken, Rechtsklick, die
 * Kontextmenü-Taste oder der Knopf „⋯“ an der Zeile.
 */
export function ChatAktionenSheet({
  chat,
  alle,
  ordner,
  onOrdnerGeaendert,
  onClose,
  onGeaendert,
}: ChatAktionenSheetProps) {
  const myId = useMyId();
  const [busy, setBusy] = useState(false);
  const [frage, setFrage] = useState<'leeren' | 'loeschen' | null>(null);
  const [stummOffen, setStummOffen] = useState(false);

  if (!chat) return null;
  const titel = conversationTitle(chat, myId);
  const stumm = istStumm(chat);

  async function tun(arbeit: () => Promise<void>, fehler: string, schliessen = true) {
    setBusy(true);
    try {
      await arbeit();
      if (schliessen) {
        setFrage(null);
        setStummOffen(false);
        onClose();
      }
    } catch (error) {
      toast(fehlertext(error, fehler), 'error');
    } finally {
      setBusy(false);
    }
  }

  const aktuell = chat;

  async function anheften() {
    const neu = await verwaltung.gruppe.aendern(aktuell.id, { pinned: !aktuell.pinnedAt });
    useChat.getState().upsertConversation(neu);
    onGeaendert?.(neu, neu.id);
    toast(neu.pinnedAt ? 'Angeheftet' : 'Nicht mehr angeheftet', 'success');
  }

  async function ordnen(richtung: 'hoch' | 'runter') {
    const reihe = verschieben(alle, aktuell.id, richtung);
    await verwaltung.liste.angeheftetOrdnen(reihe);
    // Die neue Reihenfolge kommt per Rundruf; bis dahin genügt der Server-Stand.
    const { items } = await api.conversations.list();
    for (const eintrag of items) useChat.getState().upsertConversation(eintrag);
  }

  async function stummSetzen(bis: string | null) {
    const neu = await verwaltung.gruppe.aendern(aktuell.id, { mutedUntil: bis });
    useChat.getState().upsertConversation(neu);
    onGeaendert?.(neu, neu.id);
    toast(bis ? 'Stummgeschaltet' : 'Mitteilungen wieder an', 'success');
  }

  async function ordnerUmschalten(eintrag: ChatOrdnerDto) {
    const drin = eintrag.chats.includes(aktuell.id);
    const chats = drin
      ? eintrag.chats.filter((id) => id !== aktuell.id)
      : [...eintrag.chats, aktuell.id];
    const neu = await verwaltung.liste.ordnerAendern(eintrag.id, { chats });
    onOrdnerGeaendert(neu);
    toast(drin ? `Aus „${eintrag.name}“ genommen` : `In „${eintrag.name}“ gelegt`, 'success');
  }

  async function leeren() {
    const neu = await verwaltung.liste.leeren(aktuell.id);
    useChat.getState().upsertConversation(neu);
    await geleertAnwenden(neu);
    toast('Chat geleert – nur bei dir', 'success');
  }

  async function loeschen() {
    if (aktuell.type === 'direct') {
      await verwaltung.liste.ausblenden(aktuell.id);
      toast('Chat gelöscht – nur bei dir', 'success');
    } else {
      await api.conversations.removeMember(aktuell.id, myId);
      toast('Gruppe verlassen', 'success');
    }
    useChat.getState().removeConversation(aktuell.id);
    onGeaendert?.(null, aktuell.id);
  }

  const angeheftetReihe = verschieben(alle, chat.id, 'hoch');
  const stelle = angeheftetReihe.indexOf(chat.id);
  const angeheftet = Boolean(chat.pinnedAt);

  return (
    <Sheet open onClose={onClose} title={titel}>
      <div className="stack chat-aktionen" role="group" aria-label={`Aktionen für ${titel}`}>
        {frage ? (
          <>
            <p style={{ margin: 0 }}>
              {frage === 'leeren'
                ? 'Alle Nachrichten in diesem Chat verschwinden – nur bei dir. Die anderen behalten alles.'
                : chat.type === 'direct'
                  ? 'Der Chat verschwindet aus deiner Liste und wird für dich geleert. Schreibt dir die Person wieder, taucht er neu auf.'
                  : 'Du verlässt die Gruppe. Zurück kommst du nur, wenn dich jemand wieder hinzufügt.'}
            </p>
            <div className="row" style={{ gap: 'var(--space-2)' }}>
              <button type="button" className="btn" onClick={() => setFrage(null)}>
                Abbrechen
              </button>
              <button
                type="button"
                className="btn btn-danger"
                style={{ flex: 1 }}
                disabled={busy}
                autoFocus
                onClick={() =>
                  void tun(
                    frage === 'leeren' ? leeren : loeschen,
                    frage === 'leeren' ? 'Leeren fehlgeschlagen' : 'Löschen fehlgeschlagen',
                  )
                }
              >
                {frage === 'leeren'
                  ? 'Chat leeren'
                  : chat.type === 'direct'
                    ? 'Für mich löschen'
                    : 'Gruppe verlassen'}
              </button>
            </div>
          </>
        ) : stummOffen ? (
          <>
            {STUMM_VORGABEN.map((vorgabe) => (
              <button
                key={vorgabe.wert}
                type="button"
                className="btn btn-block"
                disabled={busy}
                onClick={() =>
                  void tun(
                    () => stummSetzen(stummBis(vorgabe.wert)),
                    'Stummschalten fehlgeschlagen',
                  )
                }
              >
                {vorgabe.label}
              </button>
            ))}
            <button type="button" className="btn btn-ghost" onClick={() => setStummOffen(false)}>
              Zurück
            </button>
          </>
        ) : (
          <>
            {!chat.archived && (
              <button
                type="button"
                className="btn btn-block"
                disabled={busy || !darfAnheften(alle, chat)}
                onClick={() => void tun(anheften, 'Anheften fehlgeschlagen')}
              >
                {angeheftet ? '📌 Nicht mehr anheften' : '📌 Anheften'}
              </button>
            )}
            {!chat.archived && !angeheftet && !darfAnheften(alle, chat) && (
              <span className="muted" style={{ fontSize: '0.82rem' }}>
                Du kannst höchstens fünf Chats anheften.
              </span>
            )}
            {angeheftet && angeheftetReihe.length > 1 && (
              <div className="row" style={{ gap: 'var(--space-2)' }}>
                <button
                  type="button"
                  className="btn"
                  style={{ flex: 1 }}
                  disabled={busy || stelle <= 0}
                  onClick={() => void tun(() => ordnen('hoch'), 'Umordnen fehlgeschlagen', false)}
                >
                  ↑ Nach oben
                </button>
                <button
                  type="button"
                  className="btn"
                  style={{ flex: 1 }}
                  disabled={busy || stelle < 0 || stelle >= angeheftetReihe.length - 1}
                  onClick={() => void tun(() => ordnen('runter'), 'Umordnen fehlgeschlagen', false)}
                >
                  ↓ Nach unten
                </button>
              </div>
            )}
            <button
              type="button"
              className="btn btn-block"
              disabled={busy}
              onClick={() => void tun(() => lesenUmschalten(chat), 'Ändern fehlgeschlagen')}
            >
              {istUngelesen(chat) ? '✓ Als gelesen markieren' : '● Als ungelesen markieren'}
            </button>
            {stumm ? (
              <button
                type="button"
                className="btn btn-block"
                disabled={busy}
                onClick={() => void tun(() => stummSetzen(null), 'Ändern fehlgeschlagen')}
              >
                🔔 Stummschaltung aufheben
                <span className="muted" style={{ display: 'block', fontSize: '0.78rem' }}>
                  {stummText(chat)}
                </span>
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-block"
                disabled={busy}
                onClick={() => setStummOffen(true)}
              >
                🔕 Stummschalten …
              </button>
            )}
            <button
              type="button"
              className="btn btn-block"
              disabled={busy}
              onClick={() =>
                void tun(async () => {
                  const neu = await archivUmschalten(chat);
                  onGeaendert?.(neu, neu.id);
                }, 'Archivieren fehlgeschlagen')
              }
            >
              {chat.archived ? '📥 Aus dem Archiv holen' : '🗄️ Archivieren'}
            </button>
            {ordner.length > 0 && (
              <fieldset className="chat-aktionen-ordner">
                <legend className="msg-info-label">Ordner</legend>
                {ordner.map((eintrag) => {
                  const drin = eintrag.chats.includes(chat.id);
                  return (
                    <label key={eintrag.id} className="row" style={{ gap: 'var(--space-2)' }}>
                      <input
                        type="checkbox"
                        checked={drin}
                        disabled={busy}
                        onChange={() =>
                          void tun(
                            () => ordnerUmschalten(eintrag),
                            'Ordner ändern fehlgeschlagen',
                            false,
                          )
                        }
                      />
                      <span>{eintrag.name}</span>
                    </label>
                  );
                })}
              </fieldset>
            )}
            <button
              type="button"
              className="btn btn-block"
              disabled={busy}
              onClick={() => setFrage('leeren')}
            >
              🧹 Chat leeren
            </button>
            <button
              type="button"
              className="btn btn-block btn-danger"
              disabled={busy}
              onClick={() => setFrage('loeschen')}
            >
              {chat.type === 'direct' ? '🗑️ Chat löschen' : '🚪 Gruppe verlassen'}
            </button>
          </>
        )}
      </div>
    </Sheet>
  );
}
