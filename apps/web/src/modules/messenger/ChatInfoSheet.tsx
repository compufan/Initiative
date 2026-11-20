import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ConversationDto, ConversationMemberDto } from '@initiative/shared';
import { Avatar } from '../../components/Avatar.js';
import { PersonenWahl } from '../../components/PersonenWahl.js';
import { Sheet } from '../../components/Sheet.js';
import { api } from '../../lib/api.js';
import { useChat } from '../../state/chat.js';
import { useMyId } from '../../state/session.js';
import { toast } from '../../state/ui.js';
import { verwaltung } from '../../lib/verwaltungApi.js';
import {
  canModerate,
  conversationAvatar,
  conversationTitle,
  counterpartOf,
  formatLastSeen,
  memberCountLabel,
  memberName,
  roleLabel,
} from './helpers.js';
import {
  ChatMitteilungen,
  Einladungslinks,
  GruppenInfo,
  GruppenSchalter,
  HintergrundWahl,
  MeldenSheet,
  MitgliedSheet,
} from './GruppenVerwaltung.js';
import { geleertAnwenden } from './leeren.js';
import './verwaltung.css';

import { FernsehSheet } from '../fernseher/FernsehSheet.js';

/** Was addMembersSchema erlaubt (packages/shared/src/schemas/conversation.ts). */
const HINZU_MAX = 100;

interface ChatInfoSheetProps {
  open: boolean;
  conversation: ConversationDto | null;
  onClose: () => void;
}

export function ChatInfoSheet({ open, conversation, onClose }: ChatInfoSheetProps) {
  const navigate = useNavigate();
  const myId = useMyId();
  const presence = useChat((state) => state.presence);
  const conversations = useChat((state) => state.conversations);
  const [aufFernseher, setAufFernseher] = useState(false);
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);

  /**
   * Wen man schon kennt: alle aus den eigenen Unterhaltungen, die hier noch
   * fehlen.
   *
   * Bisher musste man jeden Namen tippen – auch den von jemandem, mit dem man
   * täglich schreibt. Wer nur das Gesicht kennt und nicht die Schreibweise,
   * kam gar nicht weiter.
   */
  const bekannte = useMemo(() => {
    const drin = new Set(conversation?.members.map((mitglied) => mitglied.userId) ?? []);
    const gesammelt = new Map<string, { id: string; displayName: string }>();
    for (const chat of conversations) {
      for (const mitglied of chat.members) {
        if (mitglied.userId === myId || drin.has(mitglied.userId)) continue;
        gesammelt.set(mitglied.userId, {
          id: mitglied.userId,
          displayName: mitglied.user.displayName,
        });
      }
    }
    return [...gesammelt.values()].sort((a, b) => a.displayName.localeCompare(b.displayName, 'de'));
  }, [conversations, conversation, myId]);
  const [busy, setBusy] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [frage, setFrage] = useState<'leeren' | 'loeschen' | null>(null);
  const [mitgliedOffen, setMitgliedOffen] = useState<ConversationMemberDto | null>(null);
  const [melden, setMelden] = useState(false);
  /** Wen ich blockiert habe – für „Blockieren“/„Freigeben“. */
  const [gesperrt, setGesperrt] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) {
      setAdding(false);
      setPicked([]);
      setConfirmLeave(false);
      setFrage(null);
      setMitgliedOffen(null);
      setMelden(false);
      return;
    }
    let weg = false;
    verwaltung.sperren
      .liste()
      .then(({ items }) => {
        if (!weg) setGesperrt(new Set(items.map((person) => person.id)));
      })
      .catch(() => {
        // Ohne Liste zeigt der Knopf „Blockieren“ – der Server weiss es besser.
      });
    return () => {
      weg = true;
    };
  }, [open]);

  function sperreGeaendert(person: string, an: boolean) {
    setGesperrt((alt) => {
      const neu = new Set(alt);
      if (an) neu.add(person);
      else neu.delete(person);
      return neu;
    });
  }

  if (!conversation) return null;

  const isGroup = conversation.type === 'group';
  const moderator = canModerate(conversation, myId);
  const avatar = conversationAvatar(conversation, myId);
  const gegenueber = counterpartOf(conversation, myId);

  async function apply(patch: Record<string, unknown>, message: string, failure: string) {
    if (!conversation) return;
    setBusy(true);
    try {
      const updated = await api.conversations.update(conversation.id, patch);
      useChat.getState().upsertConversation(updated);
      toast(message, 'success');
    } catch {
      toast(failure, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function addMembers() {
    if (!conversation || picked.length === 0) return;
    setBusy(true);
    try {
      // Nur wirklich Neue: `add_members` schreibt zwar doppelt ohne Schaden,
      // setzt aber eine Systemnachricht „X wurde hinzugefügt“ ab – für
      // jemanden, der längst dabei ist, wäre das eine Falschmeldung im Chat.
      const drin = new Set(conversation.members.map((mitglied) => mitglied.userId));
      const neue = picked.filter((id) => !drin.has(id));
      if (neue.length === 0) {
        setPicked([]);
        setAdding(false);
        return;
      }
      if (neue.length > HINZU_MAX) {
        // Sonst kommt die Absage erst vom Server, nachdem man ausgewaehlt hat
        // und nicht mehr weiss, welche zu viel sind.
        toast(`Höchstens ${HINZU_MAX} auf einmal`, 'error');
        setBusy(false);
        return;
      }
      const updated = await api.conversations.addMembers(conversation.id, neue);
      useChat.getState().upsertConversation(updated);
      setPicked([]);
      setAdding(false);
      toast('Mitglieder hinzugefügt', 'success');
    } catch {
      toast('Mitglieder konnten nicht hinzugefügt werden', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function leave() {
    if (!conversation) return;
    setBusy(true);
    try {
      await api.conversations.removeMember(conversation.id, myId);
      useChat.getState().removeConversation(conversation.id);
      onClose();
      navigate('/chats', { replace: true });
    } catch {
      toast('Chat konnte nicht verlassen werden', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function leeren() {
    if (!conversation) return;
    setBusy(true);
    try {
      const neu = await verwaltung.liste.leeren(conversation.id);
      useChat.getState().upsertConversation(neu);
      await geleertAnwenden(neu);
      setFrage(null);
      toast('Chat geleert – nur bei dir', 'success');
    } catch {
      toast('Leeren fehlgeschlagen', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function fuerMichLoeschen() {
    if (!conversation) return;
    setBusy(true);
    try {
      await verwaltung.liste.ausblenden(conversation.id);
      useChat.getState().removeConversation(conversation.id);
      onClose();
      navigate('/chats', { replace: true });
      toast('Chat gelöscht – nur bei dir', 'success');
    } catch {
      toast('Löschen fehlgeschlagen', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function sperreUmschalten(person: string) {
    setBusy(true);
    const war = gesperrt.has(person);
    try {
      if (war) await verwaltung.sperren.freigeben(person);
      else await verwaltung.sperren.blockieren(person);
      sperreGeaendert(person, !war);
      toast(war ? 'Freigegeben' : 'Blockiert', 'success');
    } catch {
      toast('Das hat nicht geklappt', 'error');
    } finally {
      setBusy(false);
    }
  }

  if (adding) {
    return (
      <Sheet open={open} onClose={onClose} title="Mitglieder hinzufügen">
        <div className="stack">
          <PersonenWahl
            label="Wer dazukommen soll"
            suchePlatzhalter="Jemanden suchen"
            vorschlaege={bekannte}
            gewaehlt={picked}
            onChange={setPicked}
            // Wer schon drin ist, taucht gar nicht erst auf – auch nicht über
            // die Suche.
            ausschluss={conversation.members.map((member) => member.userId)}
          />
          <div className="row" style={{ gap: 'var(--space-2)' }}>
            <button type="button" className="btn btn-ghost" onClick={() => setAdding(false)}>
              Zurück
            </button>
            <button
              type="button"
              className="btn btn-primary"
              style={{ flex: 1 }}
              disabled={busy || picked.length === 0}
              onClick={() => void addMembers()}
            >
              {picked.length > 0 ? `${picked.length} hinzufügen` : 'Hinzufügen'}
            </button>
          </div>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet open={open} onClose={onClose} title="Chat-Info">
      <div className="msg-info-head">
        <Avatar name={avatar.name} id={avatar.id} url={avatar.url} size={64} />
        <div style={{ minWidth: 0 }}>
          <strong className="truncate" style={{ display: 'block' }}>
            {conversationTitle(conversation, myId)}
          </strong>
          <span className="muted" style={{ fontSize: '0.85rem' }}>
            {isGroup ? memberCountLabel(conversation) : 'Direktchat'}
          </span>
        </div>
      </div>

      {isGroup && <GruppenInfo chat={conversation} myId={myId} />}

      <ChatMitteilungen chat={conversation} />

      {/*
          „Auf den Fernseher" im Chat-Menü.

          Hier und nicht im Nachrichtenmenü daneben: Dort ginge es um EINE
          Nachricht, hier geht es um den Verlauf. Und es steht über den
          Mitgliedern, weil es eine Handlung ist und keine Auskunft.

          Es ist die ehrliche Fassung des Wunsches, „die gesamte App auf dem
          Fernseher zu spiegeln". Pixel spiegeln kann eine Web-App nicht – die
          Belege dafür stehen in `docs/FEATURES.md`. Eine zweite Ansicht, vom
          Telefon ferngesteuert, geht auf jedem Fernseher mit Browser und ist
          aus vier Metern lesbar statt eine geschrumpfte Telefonoberfläche.
      */}
      <section className="stack">
        <button type="button" className="btn btn-block" onClick={() => setAufFernseher(true)}>
          📺 Diesen Chat auf den Fernseher
        </button>
      </section>
      <FernsehSheet
        open={aufFernseher}
        onClose={() => setAufFernseher(false)}
        gespraech={{ id: conversation.id, name: conversationTitle(conversation, myId) }}
        titel="Chat auf den Fernseher"
      />

      <section className="stack">
        <span className="msg-info-label">
          {isGroup ? memberCountLabel(conversation) : 'Mitglieder'}
        </span>
        <div className="list msg-picker-list">
          {conversation.members.map((member) => {
            const online = presence[member.userId]?.online ?? false;
            const lastSeen = presence[member.userId]?.lastSeenAt ?? member.user.lastSeenAt;
            return (
              <button
                key={member.userId}
                type="button"
                className="list-row gv-mitglied"
                aria-label={`${memberName(member)}${member.userId === myId ? ' (du)' : ''}, ${roleLabel(member.role)} – Aktionen`}
                onClick={() => setMitgliedOffen(member)}
              >
                <Avatar
                  name={memberName(member)}
                  id={member.userId}
                  url={member.user.avatarUrl}
                  size={40}
                  online={online}
                />
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span className="truncate" style={{ display: 'block', fontWeight: 600 }}>
                    {memberName(member)}
                    {member.userId === myId ? ' (du)' : ''}
                  </span>
                  <span className="muted truncate" style={{ display: 'block', fontSize: '0.8rem' }}>
                    {online ? 'online' : formatLastSeen(lastSeen)}
                  </span>
                </span>
                <span className="badge">{roleLabel(member.role)}</span>
              </button>
            );
          })}
        </div>
        {isGroup && moderator && (
          <button type="button" className="btn btn-block" onClick={() => setAdding(true)}>
            ＋ Mitglieder hinzufügen
          </button>
        )}
      </section>

      {isGroup && moderator && (
        <>
          <Einladungslinks chat={conversation} titel={conversationTitle(conversation, myId)} />
          <GruppenSchalter chat={conversation} />
        </>
      )}

      <HintergrundWahl chat={conversation} />

      {!isGroup && gegenueber && (
        <section className="stack" aria-label="Sicherheit">
          <button
            type="button"
            className="btn btn-block"
            disabled={busy}
            onClick={() => void sperreUmschalten(gegenueber.userId)}
          >
            {gesperrt.has(gegenueber.userId)
              ? `✅ ${memberName(gegenueber)} freigeben`
              : `⛔ ${memberName(gegenueber)} blockieren`}
          </button>
          {gesperrt.has(gegenueber.userId) && (
            <span className="muted" style={{ fontSize: '0.82rem' }}>
              Blockiert: Ihr könnt einander hier nicht schreiben, und {memberName(gegenueber)} sieht
              weder dein Bild noch wann du online bist.
            </span>
          )}
          <button type="button" className="btn btn-block" onClick={() => setMelden(true)}>
            🚩 {memberName(gegenueber)} melden
          </button>
        </section>
      )}

      <section className="stack">
        <button
          type="button"
          className="btn btn-block"
          disabled={busy}
          onClick={() =>
            void apply(
              { archived: !conversation.archived },
              conversation.archived ? 'Chat wiederhergestellt' : 'Chat archiviert',
              'Archivieren fehlgeschlagen',
            )
          }
        >
          {conversation.archived ? '📥 Aus dem Archiv holen' : '🗄️ Chat archivieren'}
        </button>
        {frage ? (
          <div className="stack">
            <p style={{ margin: 0 }}>
              {frage === 'leeren'
                ? 'Alle Nachrichten verschwinden – nur bei dir. Die anderen behalten alles.'
                : 'Der Chat verschwindet aus deiner Liste und wird für dich geleert. Schreibt dir die Person wieder, taucht er neu auf.'}
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
                onClick={() => void (frage === 'leeren' ? leeren() : fuerMichLoeschen())}
              >
                {frage === 'leeren' ? 'Chat leeren' : 'Für mich löschen'}
              </button>
            </div>
          </div>
        ) : (
          <>
            <button
              type="button"
              className="btn btn-block"
              disabled={busy}
              onClick={() => setFrage('leeren')}
            >
              🧹 Chat leeren
            </button>
            {!isGroup && (
              <button
                type="button"
                className="btn btn-danger btn-block"
                disabled={busy}
                onClick={() => setFrage('loeschen')}
              >
                🗑️ Chat löschen
              </button>
            )}
          </>
        )}
        <button
          type="button"
          className="btn btn-danger btn-block"
          disabled={busy}
          onClick={() => (confirmLeave ? void leave() : setConfirmLeave(true))}
        >
          {confirmLeave ? 'Wirklich verlassen?' : 'Chat verlassen'}
        </button>
      </section>

      {mitgliedOffen && (
        <MitgliedSheet
          chat={conversation}
          mitglied={
            conversation.members.find((member) => member.userId === mitgliedOffen.userId) ??
            mitgliedOffen
          }
          myId={myId}
          gesperrt={gesperrt.has(mitgliedOffen.userId)}
          onSperreGeaendert={(an) => sperreGeaendert(mitgliedOffen.userId, an)}
          onClose={() => setMitgliedOffen(null)}
        />
      )}
      {melden && gegenueber && (
        <MeldenSheet
          ziel={{ userId: gegenueber.userId, name: memberName(gegenueber) }}
          onClose={() => setMelden(false)}
        />
      )}
    </Sheet>
  );
}
