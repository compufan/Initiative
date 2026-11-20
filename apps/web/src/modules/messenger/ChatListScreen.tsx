import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  messagePreview,
  ohneFormatierung,
  type ChatOrdnerDto,
  type ConversationDto,
  type MessageDto,
} from '@initiative/shared';
import { Avatar } from '../../components/Avatar.js';
import { EmptyState, Spinner } from '../../components/Feedback.js';
import { Screen } from '../../components/Screen.js';
import { api } from '../../lib/api.js';
import { useShallow } from 'zustand/react/shallow';
import { useChat } from '../../state/chat.js';
import { useEntwuerfe } from '../../state/entwuerfe.js';
import { useMyId } from '../../state/session.js';
import { toast } from '../../state/ui.js';
import { NewChatSheet } from './NewChatSheet.js';
import { verwaltung } from '../../lib/verwaltungApi.js';
import { ChatAktionenSheet, archivUmschalten, lesenUmschalten } from './ChatAktionenSheet.js';
import { OrdnerSheet } from './OrdnerSheet.js';
import { useLongPress } from './useLongPress.js';
import { systemText } from './SystemBubble.js';
import {
  abzeichen,
  FESTE_FILTER,
  filterAusSchluessel,
  filterSchluessel,
  filtern,
  istStumm,
  istUngelesen,
  sortieren,
  wischErgebnis,
  wischVersatz,
  type ListenFilter,
  type WischAktion,
} from './chatliste.js';
import './verwaltung.css';
import { gegenueberIds, onlineUnter } from './praesenz.js';
import {
  conversationAvatar,
  conversationTitle,
  counterpartOf,
  formatListStamp,
  senderName,
} from './helpers.js';

/** Der zuletzt gewählte Filter – nur eine Bequemlichkeit dieses Geräts. */
const FILTER_SPEICHER = 'initiative.chatliste.filter';

function gemerkterFilter(): ListenFilter {
  try {
    const filter = filterAusSchluessel(window.localStorage.getItem(FILTER_SPEICHER));
    // Das Archiv ist ein Abstecher, kein Zuhause: Wer zurückkommt, sieht die Chats.
    return filter.art === 'archiv' ? { art: 'alle' } : filter;
  } catch {
    return { art: 'alle' };
  }
}

export function ChatListScreen() {
  const navigate = useNavigate();
  const myId = useMyId();
  const conversations = useChat((state) => state.conversations);
  /*
   * Nicht die ganze Präsenzkarte: nur, wer von den Gegenübern in der Liste
   * gerade online ist. `useShallow` vergleicht das Feld nach Inhalt – eine
   * Meldung über jemanden ausserhalb der Liste, oder ein verschobenes
   * „zuletzt gesehen", zeichnet die Liste so nicht neu (siehe `praesenz.ts`).
   */
  const gegenueber = useMemo(() => gegenueberIds(conversations, myId), [conversations, myId]);
  const onlineIds = useChat(useShallow((state) => onlineUnter(state.presence, gegenueber)));
  const online = useMemo(() => new Set(onlineIds), [onlineIds]);
  const typing = useChat((state) => state.typing);
  const initialised = useChat((state) => state.initialised);

  const [params, setParams] = useSearchParams();
  const [newChatOpen, setNewChatOpen] = useState(params.get('new') === '1');
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<MessageDto[]>([]);
  const [searching, setSearching] = useState(false);
  const requestId = useRef(0);

  // The PWA shortcut "Neuer Chat" opens /chats?new=1.
  useEffect(() => {
    if (params.get('new') !== '1') return;
    setNewChatOpen(true);
    const next = new URLSearchParams(params);
    next.delete('new');
    setParams(next, { replace: true });
  }, [params, setParams]);

  const term = query.trim();

  useEffect(() => {
    if (term.length < 2) {
      setHits([]);
      setSearching(false);
      return undefined;
    }
    setSearching(true);
    const current = ++requestId.current;
    const timer = window.setTimeout(async () => {
      try {
        const { items } = await api.messages.search(term);
        if (current !== requestId.current) return;
        setHits(items);
      } catch {
        if (current !== requestId.current) return;
        setHits([]);
        toast('Nachrichtensuche fehlgeschlagen', 'error');
      } finally {
        if (current === requestId.current) setSearching(false);
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [term]);

  /*
   * Das Archiv – bisher eine Einbahnstrasse.
   *
   * „Chat archivieren" nahm den Chat aus der Liste, und damit war er weg:
   * `api.conversations.list()` fragt ohne Argument nur die unarchivierten ab.
   * Heute ist das Archiv einer der Filter über der Liste (und der Knopf oben
   * führt weiter dorthin). Geladen wird erst beim Hinsehen: Wer nie
   * archiviert, soll dafür auch keine Anfrage bezahlen.
   */
  const [filter, setFilterRoh] = useState<ListenFilter>(gemerkterFilter);
  const archivOffen = filter.art === 'archiv';
  const [archiv, setArchiv] = useState<ConversationDto[] | null>(null);
  const [ordner, setOrdner] = useState<ChatOrdnerDto[]>([]);
  const [ordnerBearbeiten, setOrdnerBearbeiten] = useState<ChatOrdnerDto | 'neu' | null>(null);
  const [aktionenFuer, setAktionenFuer] = useState<string | null>(null);

  function setFilter(neu: ListenFilter) {
    setFilterRoh(neu);
    try {
      window.localStorage.setItem(FILTER_SPEICHER, filterSchluessel(neu));
    } catch {
      // Ohne Speicher (privates Fenster) gilt der Filter eben nur jetzt.
    }
  }

  useEffect(() => {
    let weg = false;
    verwaltung.liste
      .ordner()
      .then(({ items }) => {
        if (!weg) setOrdner(items);
      })
      .catch(() => {
        // Ohne Ordner bleibt die Liste benutzbar – die festen Filter genügen.
      });
    return () => {
      weg = true;
    };
  }, []);

  // Ein gemerkter Ordner, den es nicht mehr gibt, fällt auf „Alle“ zurück.
  useEffect(() => {
    if (filter.art === 'ordner' && ordner.length > 0 && !ordner.some((o) => o.id === filter.id)) {
      setFilter({ art: 'alle' });
    }
  }, [filter, ordner]);

  useEffect(() => {
    if (!archivOffen) return;
    let weg = false;
    api.conversations
      .list(true)
      .then(({ items }) => {
        if (!weg) setArchiv(items);
      })
      .catch(() => {
        if (!weg) {
          setArchiv([]);
          toast('Das Archiv konnte nicht geladen werden', 'error');
        }
      });
    return () => {
      weg = true;
    };
  }, [archivOffen]);

  /** Alles, was die Liste kennt: die offenen aus dem Speicher, das Archiv nachgeladen. */
  const bekannt = useMemo(() => {
    const ids = new Set(conversations.map((chat) => chat.id));
    return [...conversations, ...(archiv ?? []).filter((chat) => !ids.has(chat.id))];
  }, [conversations, archiv]);

  const visible = useMemo(() => {
    const gefiltert = filtern(bekannt, filter, ordner);
    const gesucht =
      term.length === 0
        ? gefiltert
        : gefiltert.filter((conversation) =>
            conversationTitle(conversation, myId).toLowerCase().includes(term.toLowerCase()),
          );
    return sortieren(gesucht);
  }, [bekannt, filter, ordner, myId, term]);

  const aktionenChat = aktionenFuer
    ? (bekannt.find((chat) => chat.id === aktionenFuer) ?? null)
    : null;

  /** Nach Archivieren/Löschen: das nachgeladene Archiv mitführen. */
  function nachAenderung(chat: ConversationDto | null, id: string) {
    setArchiv((liste) => {
      if (liste === null) return liste;
      const ohne = liste.filter((eintrag) => eintrag.id !== id);
      return chat?.archived ? [chat, ...ohne] : ohne;
    });
  }

  async function gewischt(chat: ConversationDto, aktion: WischAktion) {
    try {
      if (aktion === 'archivieren') {
        const neu = await archivUmschalten(chat);
        nachAenderung(neu, neu.id);
      } else {
        await lesenUmschalten(chat);
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Das hat nicht geklappt', 'error');
    }
  }

  function ordnerGeaendert(neu: ChatOrdnerDto | null, id?: string) {
    setOrdner((liste) => {
      if (!neu) return liste.filter((eintrag) => eintrag.id !== id);
      const da = liste.some((eintrag) => eintrag.id === neu.id);
      return da ? liste.map((eintrag) => (eintrag.id === neu.id ? neu : eintrag)) : [...liste, neu];
    });
  }

  function closeSearch() {
    setSearchOpen(false);
    setQuery('');
    setHits([]);
  }

  return (
    <Screen
      title={archivOffen ? 'Archiv' : 'Chats'}
      bare
      actions={
        <>
          <button
            type="button"
            className="icon-btn"
            aria-label={searchOpen ? 'Suche schließen' : 'Chats durchsuchen'}
            aria-expanded={searchOpen}
            onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
          >
            {searchOpen ? '✕' : '🔍'}
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label={archivOffen ? 'Zurück zu den Chats' : 'Archivierte Chats'}
            aria-pressed={archivOffen}
            data-tipp={
              archivOffen
                ? 'Zurück zur normalen Chatliste'
                : 'Zeigt die Chats, die du archiviert hast – von dort holst du sie zurück'
            }
            onClick={() => setFilter(archivOffen ? { art: 'alle' } : { art: 'archiv' })}
          >
            {archivOffen ? '💬' : '🗄️'}
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Gespeicherte Nachrichten"
            data-tipp="Alle Nachrichten, die du mit einem Stern gespeichert hast"
            onClick={() => navigate('/gespeichert')}
          >
            ⭐
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Neuer Chat"
            data-tipp="Jemanden anschreiben oder eine Gruppe gründen"
            onClick={() => setNewChatOpen(true)}
          >
            ✎
          </button>
        </>
      }
    >
      <div className="page">
        <FilterLeiste
          filter={filter}
          ordner={ordner}
          chats={bekannt}
          onFilter={setFilter}
          onOrdnerNeu={() => setOrdnerBearbeiten('neu')}
          onOrdnerBearbeiten={(eintrag) => setOrdnerBearbeiten(eintrag)}
        />
        {archivOffen ? (
          <>
            {archiv === null && (
              <div style={{ padding: 'var(--space-5)' }}>
                <Spinner label="Archiv wird geladen" />
              </div>
            )}
            {archiv !== null && visible.length === 0 && (
              <EmptyState
                emoji="🗄️"
                title="Nichts archiviert"
                description="Archivierte Chats verschwinden aus der Liste, bleiben aber vollständig erhalten. Hier findest du sie wieder."
              />
            )}
            {visible.length > 0 && (
              <div className="list">
                {visible.map((conversation) => (
                  <ChatRow
                    key={conversation.id}
                    conversation={conversation}
                    myId={myId}
                    online={undefined}
                    typing={false}
                    onAktionen={() => setAktionenFuer(conversation.id)}
                    onWisch={(aktion) => void gewischt(conversation, aktion)}
                  />
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            {searchOpen && (
              <div className="chat-search">
                <input
                  className="input"
                  type="search"
                  inputMode="search"
                  autoFocus
                  placeholder="Chats und Nachrichten durchsuchen"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
            )}

            {!initialised && conversations.length === 0 && (
              <div style={{ padding: 'var(--space-5)' }}>
                <Spinner label="Chats werden geladen" />
              </div>
            )}

            {initialised && conversations.length === 0 && (
              <EmptyState
                emoji="💬"
                title="Noch keine Chats"
                description="Starte ein Gespräch – such dir jemanden oder gründe direkt eine Gruppe."
                action={
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => setNewChatOpen(true)}
                  >
                    Neuen Chat starten
                  </button>
                }
              />
            )}

            {conversations.length > 0 && visible.length === 0 && term.length === 0 && (
              <EmptyState
                emoji={filter.art === 'ungelesen' ? '✅' : '📂'}
                title={filter.art === 'ungelesen' ? 'Alles gelesen' : 'Hier ist nichts'}
                description={
                  filter.art === 'ordner'
                    ? 'Leg Chats über ihr Menü (langes Drücken oder „⋯“) in diesen Ordner.'
                    : 'Kein Chat passt zu diesem Filter.'
                }
              />
            )}

            {conversations.length > 0 &&
              visible.length === 0 &&
              term.length > 0 &&
              hits.length === 0 &&
              !searching && (
                <EmptyState
                  emoji="🔍"
                  title="Nichts gefunden"
                  description={`Keine Treffer für „${term}“.`}
                />
              )}

            {visible.length > 0 && (
              <div className="list">
                {visible.map((conversation) => (
                  <ChatRow
                    key={conversation.id}
                    conversation={conversation}
                    myId={myId}
                    online={
                      conversation.type === 'direct'
                        ? online.has(counterpartOf(conversation, myId)?.userId ?? '')
                        : undefined
                    }
                    typing={(typing[conversation.id] ?? []).some((entry) => entry.userId !== myId)}
                    onAktionen={() => setAktionenFuer(conversation.id)}
                    onWisch={(aktion) => void gewischt(conversation, aktion)}
                  />
                ))}
              </div>
            )}

            {term.length >= 2 && (
              <div className="chat-hits">
                <div className="msg-info-label" style={{ padding: '0 var(--space-4)' }}>
                  Nachrichten
                </div>
                {searching && (
                  <div style={{ padding: 'var(--space-3) var(--space-4)' }}>
                    <Spinner label="Suche läuft" />
                  </div>
                )}
                {!searching && hits.length === 0 && (
                  <p className="muted" style={{ padding: '0 var(--space-4)', fontSize: '0.88rem' }}>
                    Keine passenden Nachrichten.
                  </p>
                )}
                <div className="list">
                  {hits.map((hit) => {
                    const conversation =
                      conversations.find((item) => item.id === hit.conversationId) ?? null;
                    return (
                      <button
                        key={hit.id}
                        type="button"
                        className="list-row"
                        onClick={() => {
                          closeSearch();
                          // Zum Treffer springen, nicht nur in den Chat.
                          navigate(`/chats/${hit.conversationId}?m=${hit.id}`);
                        }}
                      >
                        <span aria-hidden="true" style={{ fontSize: '1.2rem' }}>
                          💬
                        </span>
                        <span style={{ minWidth: 0, flex: 1 }}>
                          <span className="truncate" style={{ display: 'block', fontWeight: 600 }}>
                            {conversation ? conversationTitle(conversation, myId) : 'Chat'}
                          </span>
                          <span
                            className="muted truncate"
                            style={{ display: 'block', fontSize: '0.84rem' }}
                          >
                            {senderName(conversation, hit.senderId)}: {messagePreview(hit)}
                          </span>
                        </span>
                        <span className="faint" style={{ fontSize: '0.75rem' }}>
                          {formatListStamp(hit.createdAt)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <NewChatSheet open={newChatOpen} onClose={() => setNewChatOpen(false)} />
      {aktionenChat && (
        <ChatAktionenSheet
          chat={aktionenChat}
          alle={bekannt}
          ordner={ordner}
          onOrdnerGeaendert={(neu) => ordnerGeaendert(neu)}
          onGeaendert={nachAenderung}
          onClose={() => setAktionenFuer(null)}
        />
      )}
      {ordnerBearbeiten && (
        <OrdnerSheet
          ordner={ordnerBearbeiten === 'neu' ? null : ordnerBearbeiten}
          chats={conversations.filter((chat) => !chat.archived)}
          anzahl={ordner.length}
          onClose={() => setOrdnerBearbeiten(null)}
          onGespeichert={(neu) => {
            ordnerGeaendert(neu);
            setFilter({ art: 'ordner', id: neu.id });
          }}
          onGeloescht={(id) => {
            ordnerGeaendert(null, id);
            setFilter({ art: 'alle' });
          }}
        />
      )}
    </Screen>
  );
}

/** Die Filter über der Liste: feste Chips, eigene Ordner, „＋ Ordner“. */
function FilterLeiste({
  filter,
  ordner,
  chats,
  onFilter,
  onOrdnerNeu,
  onOrdnerBearbeiten,
}: {
  filter: ListenFilter;
  ordner: ChatOrdnerDto[];
  chats: ConversationDto[];
  onFilter: (filter: ListenFilter) => void;
  onOrdnerNeu: () => void;
  onOrdnerBearbeiten: (ordner: ChatOrdnerDto) => void;
}) {
  const ungelesen = chats.filter((chat) => !chat.archived && istUngelesen(chat)).length;
  const aktiv = filterSchluessel(filter);
  return (
    <div className="chat-filter" role="toolbar" aria-label="Chats filtern">
      {FESTE_FILTER.map((eintrag) => (
        <button
          key={eintrag.art}
          type="button"
          className="chat-filter-chip"
          aria-pressed={aktiv === eintrag.art}
          onClick={() => onFilter({ art: eintrag.art })}
        >
          {eintrag.label}
          {eintrag.art === 'ungelesen' && ungelesen > 0 && (
            <span className="chat-filter-zahl" aria-label={`${ungelesen} ungelesen`}>
              {ungelesen}
            </span>
          )}
        </button>
      ))}
      {ordner.map((eintrag) => {
        const schluessel = filterSchluessel({ art: 'ordner', id: eintrag.id });
        const gewaehlt = aktiv === schluessel;
        return (
          <button
            key={eintrag.id}
            type="button"
            className="chat-filter-chip"
            aria-pressed={gewaehlt}
            data-tipp={gewaehlt ? 'Noch einmal tippen: Ordner bearbeiten' : undefined}
            onClick={() =>
              gewaehlt ? onOrdnerBearbeiten(eintrag) : onFilter({ art: 'ordner', id: eintrag.id })
            }
          >
            📁 {eintrag.name}
          </button>
        );
      })}
      <button
        type="button"
        className="chat-filter-chip chat-filter-neu"
        aria-label="Neuer Ordner"
        onClick={onOrdnerNeu}
      >
        ＋ Ordner
      </button>
    </div>
  );
}

function ChatRow({
  conversation,
  myId,
  online,
  typing,
  onAktionen,
  onWisch,
}: {
  conversation: ConversationDto;
  myId: string;
  online: boolean | undefined;
  typing: boolean;
  onAktionen: () => void;
  onWisch: (aktion: WischAktion) => void;
}) {
  const avatar = conversationAvatar(conversation, myId);
  const last = conversation.lastMessage;
  const stumm = istStumm(conversation);
  const marke = abzeichen(conversation);
  const titel = conversationTitle(conversation, myId);
  const langDruecken = useLongPress(onAktionen);
  const [versatz, setVersatz] = useState(0);
  const start = useRef<{ x: number; y: number; breite: number } | null>(null);
  /** Ein Wisch soll nicht zusätzlich den Chat öffnen. */
  const gewischt = useRef(false);

  const entwurf = useEntwuerfe((state) => state.entwuerfe[conversation.id]?.text.trim() ?? '');
  let preview = 'Noch keine Nachrichten';
  if (typing) {
    preview = 'tippt …';
  } else if (entwurf) {
    // Wie bei WhatsApp: Was man angefangen hat, steht vor der letzten Nachricht.
    preview = `Entwurf: ${ohneFormatierung(entwurf)}`;
  } else if (last) {
    const prefix =
      last.type === 'system' || last.metadata?.erinnerung
        ? ''
        : last.senderId === myId || last.senderId == null
          ? 'Du: '
          : conversation.type === 'group'
            ? `${senderName(conversation, last.senderId)}: `
            : '';
    // Systemzeilen als Satz („Anna hat die Gruppe umbenannt“) statt „Nachricht“.
    preview =
      last.type === 'system'
        ? systemText(last, conversation, myId)
        : `${prefix}${messagePreview(last)}`;
  }

  function runter(event: ReactPointerEvent) {
    langDruecken.onPointerDown(event);
    gewischt.current = false;
    // Wischen nur mit Finger oder Stift: Mit der Maus zieht man nicht an Zeilen.
    if (event.pointerType === 'mouse') return;
    start.current = {
      x: event.clientX,
      y: event.clientY,
      breite: event.currentTarget.getBoundingClientRect().width,
    };
  }

  function bewegen(event: ReactPointerEvent) {
    langDruecken.onPointerMove(event);
    const anfang = start.current;
    if (!anfang) return;
    const dx = event.clientX - anfang.x;
    const dy = event.clientY - anfang.y;
    const neu = wischVersatz(dx, dy);
    if (Math.abs(neu) > 10) gewischt.current = true;
    setVersatz(neu);
  }

  function hoch(event: ReactPointerEvent) {
    langDruecken.onPointerUp();
    const anfang = start.current;
    start.current = null;
    setVersatz(0);
    if (!anfang) return;
    const aktion = wischErgebnis(event.clientX - anfang.x, event.clientY - anfang.y, anfang.breite);
    if (aktion) onWisch(aktion);
  }

  function abbrechen() {
    langDruecken.onPointerCancel();
    start.current = null;
    setVersatz(0);
  }

  const lesenText = istUngelesen(conversation) ? 'Gelesen' : 'Ungelesen';

  return (
    <div
      className={`chat-row-wrap${versatz !== 0 ? ' is-wischend' : ''}`}
      onPointerDown={runter}
      onPointerMove={bewegen}
      onPointerUp={hoch}
      onPointerCancel={abbrechen}
      onContextMenu={langDruecken.onContextMenu}
    >
      {versatz !== 0 && (
        <span
          className={`chat-row-wischziel ${versatz > 0 ? 'is-rechts' : 'is-links'}`}
          aria-hidden="true"
        >
          {versatz > 0
            ? `✓ ${lesenText}`
            : `🗄️ ${conversation.archived ? 'Zurückholen' : 'Archivieren'}`}
        </span>
      )}
      <Link
        className={`list-row chat-row${conversation.pinnedAt ? ' is-angeheftet' : ''}`}
        to={`/chats/${conversation.id}`}
        style={versatz !== 0 ? { transform: `translateX(${versatz}px)` } : undefined}
        draggable={false}
        onClickCapture={(event) => {
          if (gewischt.current) {
            event.preventDefault();
            gewischt.current = false;
            return;
          }
          // Öffnen nimmt die Markierung „ungelesen“ zurück – auch wenn keine
          // neue Nachricht da ist, die das Lesen ohnehin erledigen würde.
          if (conversation.markedUnread) {
            useChat.getState().upsertConversation({ ...conversation, markedUnread: false });
            void verwaltung.gruppe.aendern(conversation.id, { markedUnread: false }).catch(() => {
              // Der nächste Abgleich holt es nach.
            });
          }
        }}
        onKeyDown={(event) => {
          // Tastatur-Alternativen zum Wischen: Entf archiviert, „u“ schaltet
          // gelesen/ungelesen. Das Menü öffnet Umschalt+F10 oder die
          // Kontextmenü-Taste (ein `contextmenu`-Ereignis, siehe oben).
          if (event.key === 'Delete') {
            event.preventDefault();
            onWisch('archivieren');
          } else if (event.key === 'u' && !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.preventDefault();
            onWisch('lesen');
          }
        }}
        aria-keyshortcuts="Delete U Shift+F10"
      >
        <Avatar name={avatar.name} id={avatar.id} url={avatar.url} size={50} online={online} />
        <span className="chat-row-main">
          <span className="chat-row-line">
            <span className="chat-row-name truncate">{titel}</span>
            <span className="chat-row-time">
              {conversation.pinnedAt && (
                <span aria-label="angeheftet" title="angeheftet">
                  📌
                </span>
              )}
              {stumm && (
                <span aria-label="stummgeschaltet" title="stummgeschaltet">
                  🔕
                </span>
              )}
              {last ? formatListStamp(last.createdAt) : ''}
            </span>
          </span>
          <span className="chat-row-line">
            <span className={`chat-row-preview truncate ${typing ? 'chat-row-typing' : ''}`}>
              {preview}
            </span>
            {marke?.art === 'zahl' && <span className="chat-badge">{marke.text}</span>}
            {marke?.art === 'punkt' && (
              <span className="chat-badge chat-badge-punkt" aria-label="als ungelesen markiert" />
            )}
          </span>
        </span>
      </Link>
      <button
        type="button"
        className="icon-btn chat-row-menu"
        aria-label={`Aktionen für ${titel}`}
        aria-haspopup="dialog"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={onAktionen}
      >
        ⋯
      </button>
    </div>
  );
}
