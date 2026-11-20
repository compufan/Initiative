import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { hakenFuer, type Haken, type MitgliedStand } from '@initiative/shared';
import { Avatar } from '../../components/Avatar.js';
import { EmptyState, Spinner } from '../../components/Feedback.js';
import { useChat, type ChatMessage } from '../../state/chat.js';
import { useMyId, useSession } from '../../state/session.js';
import { useEntwuerfe } from '../../state/entwuerfe.js';
import { toast, useHideNav } from '../../state/ui.js';
import { ChatInfoSheet } from './ChatInfoSheet.js';
import { Composer } from './Composer.js';
import { MessageActionsSheet } from './MessageActionsSheet.js';
import { MessageBubble } from './MessageBubble.js';
import { VerlaufsAntraege, VerlaufsGrenze, useVerlaufsantraege } from './VerlaufBand.js';
import { praesenzVon } from './praesenz.js';
import { WeiterleitenSheet } from './WeiterleitenSheet.js';
import { NachrichtenInfoSheet } from './NachrichtenInfoSheet.js';
import { ReaktionenSheet } from './ReaktionenSheet.js';
import { AuswahlLeiste } from './AuswahlLeiste.js';
import { ChatSuche } from './ChatSuche.js';
import { ChatMenue } from './ChatMenue.js';
import { EmojiPicker } from './EmojiPicker.js';
import { suchbegriffSetzen } from './suchbegriff.js';
import { chatOffenSetzen, untenSetzen } from '../../state/sichtbarkeit.js';
import {
  conversationAvatar,
  conversationTitle,
  counterpartOf,
  dayKey,
  formatDayLabel,
  formatLastSeen,
  isGrouped,
  memberCountLabel,
  memberName,
  typingLabel,
} from './helpers.js';

const NO_MESSAGES: ChatMessage[] = [];
const NO_TYPING: { userId: string; until: number; art: 'text' | 'audio' }[] = [];

type RenderItem =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'unread'; key: string }
  | {
      kind: 'message';
      key: string;
      message: ChatMessage;
      showSender: boolean;
      showAvatar: boolean;
      haken: Haken | null;
    };

/** Keeps the composer above the on-screen keyboard on iOS (100dvh stays put). */
function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return undefined;
    const update = () => {
      const overlap = window.innerHeight - viewport.height - viewport.offsetTop;
      setInset(overlap > 60 ? Math.round(overlap) : 0);
    };
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
    };
  }, []);
  return inset;
}

export function ChatScreen() {
  useHideNav();
  const navigate = useNavigate();
  const myId = useMyId();
  const params = useParams();
  const conversationId = params.conversationId ?? '';
  // Welcher Chat gerade offen ist – für laufende asynchrone Arbeit, die den
  // Wechsel überleben würde (siehe `jumpTo`).
  const aktuellerChat = useRef(conversationId);
  aktuellerChat.current = conversationId;
  const keyboardInset = useKeyboardInset();
  useVerlaufsantraege(conversationId);

  const conversation = useChat(
    (state) => state.conversations.find((item) => item.id === conversationId) ?? null,
  );
  const messages = useChat((state) => state.messages[conversationId] ?? NO_MESSAGES);
  const loading = useChat((state) => state.loading[conversationId] ?? false);
  const hasMore = useChat((state) => state.hasMore[conversationId] ?? false);
  const typingEntries = useChat((state) => state.typing[conversationId] ?? NO_TYPING);
  /*
   * Nur der Eintrag des Gegenübers, nicht die ganze Karte: Sonst zeichnete
   * jede Online-Meldung irgendeines Kontakts diesen Chat neu (siehe
   * `praesenz.ts`). In einer Gruppe gibt es kein Gegenüber – dann gar nichts.
   */
  const gegenueberId = conversation ? (counterpartOf(conversation, myId)?.userId ?? null) : null;
  const gegenueberPraesenz = useChat((state) => praesenzVon(state.presence, gegenueberId));

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const restore = useRef<{ height: number; top: number } | null>(null);
  const didInitialScroll = useRef(false);
  const unreadAnchor = useRef<{
    conversationId: string;
    enabled: boolean;
    lastReadId: string | null;
  }>({
    conversationId: '',
    enabled: false,
    lastReadId: null,
  });

  const [showJump, setShowJump] = useState(false);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [actionsFor, setActionsFor] = useState<ChatMessage | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [bearbeiten, setBearbeiten] = useState<ChatMessage | null>(null);
  const [weiterleiten, setWeiterleiten] = useState<ChatMessage[]>([]);
  const [infoFuer, setInfoFuer] = useState<ChatMessage | null>(null);
  const [reaktionenFuer, setReaktionenFuer] = useState<ChatMessage | null>(null);
  const [emojiFuer, setEmojiFuer] = useState<ChatMessage | null>(null);
  /** Mehrfachauswahl: `null` heisst „keine läuft“. */
  const [auswahl, setAuswahl] = useState<Set<string> | null>(null);
  const [sucheOffen, setSucheOffen] = useState(false);
  const [menueOffen, setMenueOffen] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const sprungZiel = searchParams.get('m');
  const staende = useChat((state) => state.staende[conversationId]);
  /*
   * Lesebestätigungen ausgeschaltet (Einstellungen → Privatsphäre): Im
   * Einzelchat sieht man dann auch die der anderen nicht – gegenseitig wie
   * bei WhatsApp. Der Server gibt die Stände dann schon nicht heraus; das hier
   * hält die Häkchen auch dann grau, wenn ein Ereignis sie doch brächte.
   */
  const lesebestaetigungenAus = useSession(
    (state) => state.user?.settings?.privacy?.readReceipts === false,
  );

  // Dieser Chat liegt jetzt vor Augen: Der Server schickt dafür keine
  // Mitteilungen, und die Liste zählt hier nichts hoch (`state/sichtbarkeit.ts`).
  useEffect(() => {
    if (!conversationId) return undefined;
    chatOffenSetzen(conversationId);
    return () => chatOffenSetzen(null);
  }, [conversationId]);

  useEffect(() => {
    if (!conversationId) return;
    didInitialScroll.current = false;
    atBottom.current = true;
    restore.current = null;
    setShowJump(false);
    setReplyTo(null);
    setActionsFor(null);
    setInfoOpen(false);
    setBearbeiten(null);
    setAuswahl(null);
    setSucheOffen(false);
    suchbegriffSetzen(null, null);
    void useChat.getState().ensureConversation(conversationId);
    void useChat.getState().staendeLaden(conversationId);
    useChat
      .getState()
      .loadMessages(conversationId)
      .catch(() => toast('Nachrichten konnten nicht geladen werden', 'error'));
  }, [conversationId]);

  // Freeze the read marker when the chat opens so the divider does not jump
  // away the moment the messages are marked as read.
  if (conversation && unreadAnchor.current.conversationId !== conversationId) {
    const me = conversation.members.find((member) => member.userId === myId);
    unreadAnchor.current = {
      conversationId,
      enabled: conversation.unreadCount > 0,
      lastReadId: me?.lastReadMessageId ?? null,
    };
  }

  /*
   * Die Stände aller anderen – für die Häkchen. Geladen aus `/staende`, mit
   * den Lesezeichen aus der Chatliste als Rückfall, solange das noch läuft.
   */
  const mitgliedStaende = useMemo<MitgliedStand[]>(
    () =>
      (conversation?.members ?? []).map((member) => ({
        userId: member.userId,
        siehtAb: member.siehtAb,
        gelesen: staende?.[member.userId]?.gelesen ?? member.lastReadMessageId,
        zugestellt: staende?.[member.userId]?.zugestellt ?? null,
      })),
    [conversation?.members, staende],
  );
  const lesebestaetigungen = !(lesebestaetigungenAus && conversation?.type === 'direct');

  // Den Antwortbezug eines Entwurfs wiederherstellen, sobald die Nachricht da ist.
  const entwurfAntwort = useEntwuerfe((state) => state.entwuerfe[conversationId]?.replyToId ?? null);
  useEffect(() => {
    if (!entwurfAntwort || replyTo?.id === entwurfAntwort) return;
    const ziel = messages.find((item) => item.id === entwurfAntwort);
    if (ziel) setReplyTo(ziel);
    // Nur beim Öffnen und wenn die Nachricht nachkommt – nicht nach „✕“.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entwurfAntwort, messages.length > 0, conversationId]);

  const items = useMemo<RenderItem[]>(() => {
    const out: RenderItem[] = [];
    const anchor = unreadAnchor.current;
    let previous: ChatMessage | undefined;
    let dividerPlaced = false;

    for (const message of messages) {
      let breakGroup = false;
      if (!previous || dayKey(previous.createdAt) !== dayKey(message.createdAt)) {
        out.push({
          kind: 'day',
          key: `day-${dayKey(message.createdAt)}`,
          label: formatDayLabel(message.createdAt),
        });
        breakGroup = true;
      }
      const isTheirs = message.senderId != null && message.senderId !== myId;
      const afterRead = anchor.lastReadId == null || message.id > anchor.lastReadId;
      if (anchor.enabled && !dividerPlaced && isTheirs && afterRead) {
        out.push({ kind: 'unread', key: 'unread-divider' });
        dividerPlaced = true;
        breakGroup = true;
      }
      const grouped = !breakGroup && isGrouped(previous, message);
      const meine = message.senderId == null || message.senderId === myId;
      out.push({
        kind: 'message',
        key: message.id,
        message,
        showSender: !grouped,
        showAvatar: !grouped,
        haken: meine
          ? hakenFuer(message, myId, mitgliedStaende, { lesebestaetigungen })
          : null,
      });
      previous = message;
    }
    return out;
  }, [messages, myId, conversationId, conversation, mitgliedStaende, lesebestaetigungen]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (restore.current) {
      const { height, top } = restore.current;
      restore.current = null;
      element.scrollTop = element.scrollHeight - height + top;
      return;
    }
    if (!didInitialScroll.current) {
      if (messages.length === 0) return;
      didInitialScroll.current = true;
      element.scrollTop = element.scrollHeight;
      return;
    }
    if (atBottom.current) element.scrollTop = element.scrollHeight;
  }, [items, messages.length, loading]);

  // Late-loading media must not push the newest message out of sight.
  useEffect(() => {
    const element = scrollRef.current;
    const content = contentRef.current;
    if (!element || !content || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      if (atBottom.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [conversationId]);

  useEffect(() => {
    if (messages.length > 0 && atBottom.current) useChat.getState().markRead(conversationId);
  }, [messages, conversationId]);

  function onScroll() {
    const element = scrollRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    const bottom = distance < 80;
    if (bottom !== atBottom.current) {
      atBottom.current = bottom;
      untenSetzen(bottom);
      setShowJump(!bottom);
      if (bottom) useChat.getState().markRead(conversationId);
    }
    if (element.scrollTop < 260 && hasMore && !loading && !restore.current) {
      restore.current = { height: element.scrollHeight, top: element.scrollTop };
      void useChat.getState().loadOlder(conversationId);
    }
  }

  function scrollToBottom(smooth = false) {
    const element = scrollRef.current;
    if (!element) return;
    atBottom.current = true;
    setShowJump(false);
    element.scrollTo({ top: element.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }

  /**
   * Zur zitierten Nachricht springen – und sie notfalls erst holen.
   *
   * Vorher wurde nur im gerenderten Verlauf gesucht. Ein Zitat zeigt aber
   * gerade auf etwas Älteres, und älter heisst in einem langen Chat: noch
   * nicht geladen. Der Tipp auf das Zitatfeld endete deshalb regelmässig bei
   * „Die Nachricht ist noch nicht geladen“ – während der Knopf „Ältere laden“
   * einen Zentimeter weiter oben genau das getan hätte.
   *
   * Die Kennungen sind zeitlich sortiert (UUIDv7), also lässt sich am
   * Vergleich mit der ältesten geladenen ablesen, ob weiteres Nachladen
   * überhaupt helfen kann. Die Obergrenze steht gegen den Fall, dass der
   * Server eine Nachricht nicht mehr liefert (gelöscht, kein Zugriff): Sonst
   * lädt die Schleife den ganzen Chat und findet trotzdem nichts.
   */
  /*
   * Mit `useCallback` und ohne Abhängigkeiten: Die Funktion geht an JEDE Blase
   * (`onJumpTo`), und eine neue Funktion je Zeichnen hebelte deren `memo` aus.
   * Sie liest alles Veränderliche über Refs und `getState()` – den Chat
   * eingeschlossen, siehe `zielChat`.
   */
  const jumpTo = useCallback(async (messageId: string) => {
    // Der Chat, für den dieser Sprung gilt. Wechselt der Anwender währenddessen
    // den Chat, hört die Schleife auf – sonst lüde sie Seite um Seite eines
    // Verlaufs nach, den niemand mehr ansieht.
    const zielChat = aktuellerChat.current;
    const selector =
      typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
        ? `[data-message-id="${CSS.escape(messageId)}"]`
        : `[data-message-id="${messageId}"]`;

    const suchen = () => scrollRef.current?.querySelector(selector) ?? null;
    const liste = () => useChat.getState().messages[zielChat] ?? [];
    const geladen = () => liste().some((item) => item.id === messageId);

    /*
     * Erst in EINEM Zug holen, was bis zur Nachricht fehlt (`?bis=`). Ein
     * Treffer aus der Suche, ein Sternchen oder ein Datum liegen oft
     * hunderte Nachrichten zurück – Seite um Seite wären das viele Anfragen
     * und am Ende die Obergrenze unten. Die Schleife bleibt als Rückfall.
     */
    if (!suchen() && !geladen()) {
      atBottom.current = false;
      await useChat.getState().ladenBis(zielChat, messageId);
      if (aktuellerChat.current !== zielChat) return;
    }
    const aelteste = () => liste().find((item) => !item.pending)?.id ?? null;
    const bild = () => new Promise<void>((weiter) => requestAnimationFrame(() => weiter()));
    const warten = (ms: number) => new Promise<void>((weiter) => window.setTimeout(weiter, ms));

    let grund: 'gefunden' | 'nicht-im-verlauf' | 'aufgegeben' = 'aufgegeben';
    let ladeversuche = 0;
    let wartezeit = 0;

    while (ladeversuche < 20) {
      if (suchen() || geladen()) {
        grund = 'gefunden';
        break;
      }
      if (aktuellerChat.current !== zielChat) return;

      const zustand = useChat.getState();

      /*
       * Die Kennungen sind zeitlich sortiert (UUIDv7).
       *
       * Liegt das Ziel NICHT vor der ältesten geladenen Nachricht, kann
       * Nachladen es nicht herbeischaffen – es müsste dann schon in der Liste
       * stehen. Ohne diesen Vergleich lief die Schleife zwanzig Seiten weit,
       * also über tausend Nachrichten, für ein Ziel, das dort nie auftauchen
       * kann. (Dieser Vergleich stand vorher nur im Kommentar.)
       */
      const rand = aelteste();
      if (rand && messageId >= rand) {
        grund = 'nicht-im-verlauf';
        break;
      }
      if (!(zustand.hasMore[zielChat] ?? false)) {
        grund = 'nicht-im-verlauf';
        break;
      }

      /*
       * Läuft schon ein Ladevorgang – das Scrollen stösst denselben an –,
       * kehrt `loadOlder` sofort und wirkungslos zurück. Dann wird gewartet,
       * ohne einen Versuch zu verbrauchen: höchstens fünf Sekunden, damit ein
       * hängender Server die Schleife nicht festhält.
       */
      if (zustand.loading[zielChat]) {
        if (wartezeit >= 5000) break;
        wartezeit += 100;
        await warten(100);
        continue;
      }

      const vorher = liste().length;
      ladeversuche += 1;
      await zustand.loadOlder(zielChat);
      // Nichts dazugekommen und auch nichts unterwegs: Der Aufruf ist
      // gescheitert (`loadOlder` verschluckt seinen Fehler). Weitere Versuche
      // würden nur dasselbe tun.
      if (liste().length === vorher && !useChat.getState().loading[zielChat]) break;
    }

    if (aktuellerChat.current !== zielChat) return;
    // Nach dem Nachladen braucht React ein Bild, bevor die Zeile im DOM steht.
    if (!suchen()) await bild();

    const target = suchen();
    if (!target) {
      /*
       * Drei Ausgänge, drei Auskünfte.
       *
       * Vorher hiess jeder Fehlschlag „Die Nachricht ist nicht mehr da“ – auch
       * dann, wenn nur das Netz weg war. Das ist die schlechteste der drei
       * Auskünfte: Sie klingt endgültig und stimmt genau dann nicht, wenn ein
       * zweiter Versuch geholfen hätte.
       */
      toast(
        grund === 'nicht-im-verlauf'
          ? 'Die Nachricht ist nicht mehr da'
          : 'Der Verlauf liess sich gerade nicht weit genug laden. Versuch es noch einmal.',
        'info',
      );
      return;
    }
    // Nicht mehr „unten“: Sonst zöge das nächste Bild (oder eine neue
    // Nachricht) den Verlauf wieder ans Ende, weg vom Ziel.
    atBottom.current = false;
    untenSetzen(false);
    setShowJump(true);
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    /*
     * Liegt das Ziel ganz oben, löst das Scrollen dorthin das Nachladen
     * älterer Seiten aus (`onScroll`), und das Zurücksetzen der Position
     * danach schob es wieder aus dem Bild. Kurz danach also noch einmal
     * nachsehen und – ohne Animation – zurechtrücken.
     */
    window.setTimeout(() => {
      if (aktuellerChat.current !== zielChat) return;
      const jetzt = suchen();
      const rahmen = scrollRef.current?.getBoundingClientRect();
      if (!jetzt || !rahmen) return;
      const lage = jetzt.getBoundingClientRect();
      if (lage.bottom < rahmen.top || lage.top > rahmen.bottom) {
        atBottom.current = false;
        jetzt.scrollIntoView({ block: 'center' });
      }
    }, 900);
    target.classList.add('msg-row-flash');
    window.setTimeout(() => target.classList.remove('msg-row-flash'), 1400);
  }, []);

  // Aus der globalen Suche oder den gespeicherten Nachrichten: `?m=<Kennung>`.
  useEffect(() => {
    if (!sprungZiel || !conversationId) return;
    // Den Parameter gleich entfernen: Zurück und Neuladen springen nicht erneut.
    setSearchParams(
      (vorher) => {
        const neu = new URLSearchParams(vorher);
        neu.delete('m');
        return neu;
      },
      { replace: true },
    );
    void (async () => {
      // Erst die erste Seite, dann springen – sonst sucht der Sprung im Leeren.
      await useChat
        .getState()
        .loadMessages(conversationId)
        .catch(() => {});
      atBottom.current = false;
      didInitialScroll.current = true;
      await jumpTo(sprungZiel);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sprungZiel, conversationId]);

  /* ---------- Auswahl, Antworten, Bearbeiten ---------- */

  const auswahlUmschalten = useCallback((message: ChatMessage) => {
    setAuswahl((bisher) => {
      const neu = new Set(bisher ?? []);
      if (neu.has(message.id)) neu.delete(message.id);
      else neu.add(message.id);
      return neu.size === 0 ? null : neu;
    });
  }, []);

  const antworten = useCallback((message: ChatMessage) => {
    setBearbeiten(null);
    setReplyTo(message);
    window.requestAnimationFrame(() =>
      document.querySelector<HTMLTextAreaElement>('.msg-composer-input')?.focus(),
    );
  }, []);

  const reaktionenZeigen = useCallback((message: ChatMessage) => setReaktionenFuer(message), []);

  /** ↑ in der leeren Zeile: die letzte eigene Textnachricht, die noch geht. */
  function letzteBearbeiten() {
    const eigene = [...messages]
      .reverse()
      .find(
        (item) =>
          item.senderId === myId &&
          item.type === 'text' &&
          !item.deletedAt &&
          !item.pending &&
          !item.failed,
      );
    if (eigene) setBearbeiten(eigene);
  }

  const ausgewaehlt = useMemo(
    () => (auswahl ? messages.filter((item) => auswahl.has(item.id)) : []),
    [auswahl, messages],
  );

  // Esc beendet die Auswahl (die Suche schliesst ihre eigene Leiste).
  useEffect(() => {
    if (!auswahl) return undefined;
    const beiTaste = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAuswahl(null);
    };
    window.addEventListener('keydown', beiTaste);
    return () => window.removeEventListener('keydown', beiTaste);
  }, [auswahl]);

  /** Ob hinter meiner Grenze wirklich etwas liegt – ändert zwei Texte. */
  const hatGrenze = conversation?.verdeckterVerlauf ?? false;

  const avatar = conversation ? conversationAvatar(conversation, myId) : null;
  const counterpart = conversation ? counterpartOf(conversation, myId) : null;
  const online = counterpart ? (gegenueberPraesenz?.online ?? false) : false;
  const typingNames = typingEntries
    .filter((entry) => entry.userId !== myId)
    .map((entry) => {
      const member = conversation?.members.find((item) => item.userId === entry.userId);
      return member ? memberName(member) : 'Jemand';
    });

  let status = 'Chat wird geladen …';
  if (typingNames.length > 0) {
    const aufnehmend = typingEntries
      .filter((entry) => entry.userId !== myId && entry.art === 'audio')
      .map((entry) => {
        const member = conversation?.members.find((item) => item.userId === entry.userId);
        return member ? memberName(member) : 'Jemand';
      });
    status = typingLabel(typingNames, aufnehmend);
  } else if (conversation?.type === 'group') {
    status = memberCountLabel(conversation);
  } else if (counterpart) {
    status = online
      ? 'online'
      : formatLastSeen(gegenueberPraesenz?.lastSeenAt ?? counterpart.user.lastSeenAt);
  }

  return (
    <div className="app-main msg-screen" style={{ paddingBottom: keyboardInset }}>
      {auswahl ? (
        <AuswahlLeiste
          nachrichten={ausgewaehlt}
          conversation={conversation}
          onAbbrechen={() => setAuswahl(null)}
          onAntworten={(message) => {
            setAuswahl(null);
            antworten(message);
          }}
          onWeiterleiten={(liste) => setWeiterleiten(liste)}
          onMehr={(message) => {
            setAuswahl(null);
            setActionsFor(message);
          }}
        />
      ) : (
      <header className="app-header msg-header">
        <button
          type="button"
          className="icon-btn"
          aria-label="Zurück zu den Chats"
          onClick={() => navigate('/chats')}
        >
          ‹
        </button>
        <button
          type="button"
          className="msg-header-main"
          onClick={() => setInfoOpen(true)}
          aria-label="Chat-Info öffnen"
        >
          {avatar ? (
            <Avatar
              name={avatar.name}
              id={avatar.id}
              url={avatar.url}
              size={38}
              online={conversation?.type === 'direct' ? online : undefined}
            />
          ) : (
            <span className="skeleton" style={{ width: 38, height: 38, borderRadius: '50%' }} />
          )}
          <span style={{ minWidth: 0 }}>
            <span className="msg-header-title truncate">
              {conversation ? conversationTitle(conversation, myId) : 'Chat'}
            </span>
            <span
              className={`msg-header-status truncate ${typingNames.length > 0 ? 'is-typing' : ''}`}
            >
              {status}
            </span>
          </span>
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Im Chat suchen"
          aria-expanded={sucheOffen}
          onClick={() => setSucheOffen((offen) => !offen)}
        >
          🔍
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Chat-Menü"
          aria-haspopup="dialog"
          onClick={() => setMenueOffen(true)}
        >
          ⋮
        </button>
      </header>
      )}

      {sucheOffen && !auswahl && (
        <ChatSuche
          conversationId={conversationId}
          conversation={conversation}
          onSprung={jumpTo}
          onSchliessen={() => {
            setSucheOffen(false);
            suchbegriffSetzen(null, null);
          }}
        />
      )}

      <VerlaufsAntraege conversation={conversation} myId={myId} />

      {/* Hintergrund je Chat: die Klasse setzt `--hg` (verwaltung.css). */}
      <div
        className={`msg-body${conversation?.hintergrund ? ` hg-${conversation.hintergrund} hat-hintergrund` : ''}`}
      >
        <div className="msg-scroll" ref={scrollRef} onScroll={onScroll}>
          <div className="msg-content" ref={contentRef}>
            {hasMore && (
              <div className="msg-loader">
                {loading ? <Spinner label="Ältere Nachrichten" /> : '…'}
              </div>
            )}

            {/*
             * Unter dem Nachlader: Erst wenn nichts Älteres mehr kommt, steht
             * hier wirklich der Anfang dessen, was ich sehen darf. Darüber
             * wäre der Satz „hier beginnt, was du sehen kannst" schlicht
             * falsch, solange noch eine Seite unterwegs ist.
             */}
            {!hasMore && <VerlaufsGrenze conversation={conversation} myId={myId} />}

            {messages.length === 0 && loading && (
              <div className="msg-loader">
                <Spinner label="Nachrichten werden geladen" />
              </div>
            )}

            {/*
             * Zwei leere Verläufe, zwei Wahrheiten. Wer gerade erst
             * dazugekommen ist, sieht womöglich nur deshalb nichts, weil
             * alles vor seinem Beitritt liegt – „schreib die erste
             * Nachricht" wäre dort schlicht falsch.
             */}
            {messages.length === 0 &&
              !loading &&
              (hatGrenze ? (
                <EmptyState
                  emoji="🕐"
                  title="Seit deinem Beitritt ist hier nichts geschrieben worden"
                  description="Was davor liegt, siehst du nur, wenn alle anderen zustimmen."
                />
              ) : (
                <EmptyState
                  emoji="👋"
                  title="Noch keine Nachrichten"
                  description="Schreib die erste Nachricht – sie landet sofort bei allen Mitgliedern."
                />
              ))}

            {items.map((item) => {
              if (item.kind === 'day') {
                return (
                  <div key={item.key} className="msg-day">
                    <span>{item.label}</span>
                  </div>
                );
              }
              if (item.kind === 'unread') {
                return (
                  <div key={item.key} className="msg-unread">
                    <span>Neue Nachrichten</span>
                  </div>
                );
              }
              return (
                <MessageBubble
                  key={item.key}
                  message={item.message}
                  conversation={conversation}
                  showSender={item.showSender}
                  showAvatar={item.showAvatar}
                  onOpenActions={setActionsFor}
                  onJumpTo={jumpTo}
                  haken={item.haken}
                  auswahl={auswahl ? auswahl.has(item.message.id) : null}
                  onAuswahl={auswahlUmschalten}
                  onReply={antworten}
                  onReaktionen={reaktionenZeigen}
                />
              );
            })}
          </div>
        </div>

        {showJump && (
          <button
            type="button"
            className="msg-jump"
            aria-label="Zu den neuesten Nachrichten"
            onClick={() => scrollToBottom(true)}
          >
            ↓
            {conversation && conversation.unreadCount > 0 && (
              <span className="chat-badge">{conversation.unreadCount}</span>
            )}
          </button>
        )}
      </div>

      <Composer
        conversationId={conversationId}
        conversation={conversation}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
        onScrollToBottom={() => scrollToBottom()}
        bearbeiten={bearbeiten}
        onBearbeitenEnde={() => setBearbeiten(null)}
        onLetzteBearbeiten={letzteBearbeiten}
      />

      <MessageActionsSheet
        message={actionsFor}
        conversation={conversation}
        onClose={() => setActionsFor(null)}
        onReply={antworten}
        onEdit={(message) => {
          setReplyTo(null);
          setBearbeiten(message);
        }}
        onForward={(message) => setWeiterleiten([message])}
        onInfo={setInfoFuer}
        onReaktionen={setReaktionenFuer}
        onAuswaehlen={(message) => setAuswahl(new Set([message.id]))}
        onEmojiWahl={setEmojiFuer}
      />

      <EmojiPicker
        open={emojiFuer != null}
        onClose={() => setEmojiFuer(null)}
        titel="Reagieren mit …"
        onWaehlen={(emoji) => {
          const ziel = emojiFuer;
          setEmojiFuer(null);
          if (!ziel) return;
          const aktuell =
            useChat.getState().messages[ziel.conversationId]?.find((m) => m.id === ziel.id) ?? ziel;
          const meins = aktuell.reactions.some(
            (r) => r.emoji === emoji && r.userIds.includes(myId),
          );
          useChat
            .getState()
            .toggleReaction(aktuell, emoji, meins)
            .catch(() => toast('Reaktion konnte nicht gespeichert werden', 'error'));
        }}
      />

      <WeiterleitenSheet
        nachrichten={weiterleiten}
        onClose={() => setWeiterleiten([])}
        onFertig={() => setAuswahl(null)}
      />

      <NachrichtenInfoSheet
        message={infoFuer}
        conversation={conversation}
        onClose={() => setInfoFuer(null)}
      />

      <ReaktionenSheet
        message={reaktionenFuer}
        conversation={conversation}
        onClose={() => setReaktionenFuer(null)}
      />

      <ChatMenue
        open={menueOffen}
        conversationId={conversationId}
        onClose={() => setMenueOffen(false)}
        onInfo={() => setInfoOpen(true)}
        onSuche={() => setSucheOffen(true)}
        onSprung={jumpTo}
        onUnten={() => scrollToBottom(true)}
      />

      <ChatInfoSheet
        open={infoOpen}
        conversation={conversation}
        onClose={() => setInfoOpen(false)}
      />
    </div>
  );
}
