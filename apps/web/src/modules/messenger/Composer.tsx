import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  alleErwaehnt,
  erwaehnungEinfuegen,
  erwaehnungenImText,
  erwaehnungsAnfrage,
  erwaehnungsVorschlaege,
  messagePreview,
  type ClientMessageMetadata,
  type ConversationDto,
  type ErwaehnbarePerson,
  type ErwaehnungsAnfrage,
  type LinkVorschau,
} from '@initiative/shared';
import { Sheet } from '../../components/Sheet.js';
import { composerActions } from '../registry.js';
import type { ComposerAction } from '../types.js';
import { useChat, type ChatMessage } from '../../state/chat.js';
import { entwurfSetzen, useEntwuerfe } from '../../state/entwuerfe.js';
import { toast } from '../../state/ui.js';
import { senderName } from './helpers.js';
import { umschliessen, type Umschliessen } from './formathilfe.js';
import { darfModerieren, darfSchreiben, istGruppe } from './gruppenRechte.js';
import { useMyId, useSession } from '../../state/session.js';
import { ErwaehnungsVorschlaege } from './ErwaehnungsVorschlaege.js';
import { erwaehnbare, erwaehnteIn } from './erwaehnungshilfe.js';
import { LinkVorschauKarte, ersterLink } from './LinkVorschauKarte.js';
import { PlanenSheet } from './GeplantSheet.js';
import { api } from '../../lib/api.js';

const TYPING_THROTTLE_MS = 2500;
const TYPING_IDLE_MS = 3000;
const MAX_ROWS = 6;
/** So lange auf „Senden“ drücken, bis „Ohne Ton senden“ erscheint. */
const LEISE_DRUCK_MS = 500;

interface ComposerProps {
  conversationId: string;
  conversation: ConversationDto | null;
  replyTo: ChatMessage | null;
  onCancelReply: () => void;
  onScrollToBottom: () => void;
  /** Diese Nachricht wird gerade in der Eingabezeile bearbeitet. */
  bearbeiten?: ChatMessage | null;
  onBearbeitenEnde?: () => void;
  /** ↑ in der leeren Eingabe (Desktop): die letzte eigene Nachricht bearbeiten. */
  onLetzteBearbeiten?: () => void;
}

const FORMATE: { art: Umschliessen; zeichen: string; label: string; titel: string }[] = [
  { art: 'fett', zeichen: 'B', label: 'Fett', titel: 'Fett (*Text*)' },
  { art: 'kursiv', zeichen: 'I', label: 'Kursiv', titel: 'Kursiv (_Text_)' },
  { art: 'durch', zeichen: 'S', label: 'Durchgestrichen', titel: 'Durchgestrichen (~Text~)' },
  { art: 'mono', zeichen: '</>', label: 'Monospace', titel: 'Monospace (`Text`)' },
  { art: 'spoiler', zeichen: '▒', label: 'Spoiler', titel: 'Spoiler (||Text||)' },
];

export function Composer({
  conversationId,
  conversation,
  replyTo,
  onCancelReply,
  onScrollToBottom,
  bearbeiten = null,
  onBearbeitenEnde,
  onLetzteBearbeiten,
}: ComposerProps) {
  const [text, setText] = useState('');
  const [actionsOpen, setActionsOpen] = useState(false);
  const [activeAction, setActiveAction] = useState<ComposerAction | null>(null);
  const [auswahl, setAuswahl] = useState<{ von: number; bis: number } | null>(null);
  const [leiseMenue, setLeiseMenue] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastTypingAt = useRef(0);
  const idleTimer = useRef<number | null>(null);
  const druckWecker = useRef<number | null>(null);
  const langGedrueckt = useRef(false);
  /** Der Text vor dem Bearbeiten – er kommt danach zurück. */
  const vorBearbeiten = useRef<string | null>(null);
  /*
   * Erwähnungen: wen ich in diesem Entwurf über die Vorschläge gewählt habe.
   * Gesendet wird nur, wessen „@Name“ noch im Text steht.
   */
  const gewaehlt = useRef<ErwaehnbarePerson[]>([]);
  const [anfrage, setAnfrage] = useState<ErwaehnungsAnfrage | null>(null);
  const [aktivIndex, setAktivIndex] = useState(0);
  const listeId = useId();
  /** Link-Vorschau des ersten Links (nur mit eingeschalteter Einstellung). */
  const [vorschau, setVorschau] = useState<LinkVorschau | null>(null);
  const verworfeneVorschau = useRef<string | null>(null);
  const [planen, setPlanen] = useState<{
    body: string;
    replyToId: string | null;
    metadata: ClientMessageMetadata;
  } | null>(null);

  const entwurf = useEntwuerfe((state) => state.entwuerfe[conversationId]);

  /*
   * Gruppenregeln vorab zeigen statt am 403/429 des Servers zu scheitern:
   * „Nur Admins dürfen senden“ sperrt die Zeile mit Hinweis, der langsame
   * Modus zählt die Restzeit herunter. Entschieden wird weiter im Server –
   * das hier ist nur die Anzeige (`gruppenRechte.ts`).
   *
   * Wann ich zuletzt geschrieben habe, steht nicht im Chat-DTO; die neueste
   * eigene Nachricht im geladenen Verlauf genügt dafür (der Server bleibt die
   * Quelle, ein 429 kommt im Zweifel trotzdem).
   */
  const myId = useMyId();
  const linkVorschauenAn = useSession((state) => state.user?.settings?.linkVorschauen === true);
  const personen = useMemo(() => erwaehnbare(conversation, myId), [conversation, myId]);
  const vorschlaege = useMemo(
    () => (anfrage ? erwaehnungsVorschlaege(personen, anfrage.suche, myId) : []),
    [anfrage, personen, myId],
  );
  const nurAdminsGesperrt = conversation != null && !darfSchreiben(conversation, myId);
  const langsam =
    conversation && istGruppe(conversation) && !darfModerieren(conversation, myId)
      ? (conversation.settings?.langsamerModus ?? 0)
      : 0;
  const letzteEigene = useChat((state) => {
    if (!langsam) return null;
    const liste = state.messages[conversationId] ?? [];
    for (let i = liste.length - 1; i >= 0; i -= 1) {
      const item = liste[i];
      if ((item.senderId === myId || item.pending) && item.type !== 'system') return item.createdAt;
    }
    return null;
  });
  const [jetzt, setJetzt] = useState(() => Date.now());
  const frei = letzteEigene ? Date.parse(letzteEigene) + langsam * 1000 : 0;
  const restSekunden = langsam > 0 ? Math.max(0, Math.ceil((frei - jetzt) / 1000)) : 0;
  useEffect(() => {
    if (restSekunden <= 0) return undefined;
    const id = window.setInterval(() => setJetzt(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [restSekunden > 0]);
  useEffect(() => setJetzt(Date.now()), [letzteEigene]);

  const actions = useMemo(() => composerActions(), []);
  // Aktionen mit eigenem Knopf stehen zusätzlich in der Eingabezeile – im
  // Menü bleiben sie trotzdem, damit es genau einen vollständigen Ort gibt.
  const pinned = useMemo(() => actions.filter((action) => action.pinned), [actions]);
  const canSend =
    text.trim().length > 0 && !nurAdminsGesperrt && (restSekunden === 0 || Boolean(bearbeiten));

  const stopTyping = () => {
    if (idleTimer.current != null) {
      window.clearTimeout(idleTimer.current);
      idleTimer.current = null;
    }
    if (lastTypingAt.current !== 0) {
      lastTypingAt.current = 0;
      useChat.getState().setTyping(conversationId, false);
    }
  };

  // Leaving the chat (or switching to another one) must not leave a stale
  // "tippt …" indicator behind for everybody else.
  useEffect(() => stopTyping, [conversationId]);

  // Ein anderer Chat: dessen Entwurf in die Zeile (oder leer).
  useEffect(() => {
    setText(useEntwuerfe.getState().entwuerfe[conversationId]?.text ?? '');
    setAuswahl(null);
    setAnfrage(null);
    setVorschau(null);
    gewaehlt.current = [];
    vorBearbeiten.current = null;
    window.requestAnimationFrame(resize);
  }, [conversationId]);

  /*
   * Ein Entwurf von einem anderen Gerät: übernehmen, solange hier niemand
   * tippt. Mitten ins Tippen hinein zu schreiben wäre schlimmer als ein
   * veralteter Entwurf – das eigene Tippen gewinnt ohnehin (neuester Stand).
   */
  useEffect(() => {
    if (bearbeiten || !entwurf) return;
    if (document.activeElement === textareaRef.current) return;
    if (entwurf.text !== text) {
      setText(entwurf.text);
      window.requestAnimationFrame(resize);
    }
    // Nur bei neuem Entwurf, nicht bei jedem Tastendruck.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entwurf?.stand]);

  /*
   * Der Antwortbezug gehört zum Entwurf – aber nur eine echte Änderung zählt.
   * Beim Öffnen des Chats stünde hier sonst der leere Anfangstext und
   * überschriebe den Entwurf, den das Öffnen gerade wiederherstellt.
   */
  const bisherigeAntwort = useRef<{ chat: string; id: string | null }>({ chat: '', id: null });
  useEffect(() => {
    const id = replyTo?.id ?? null;
    const vorher = bisherigeAntwort.current;
    bisherigeAntwort.current = { chat: conversationId, id };
    if (bearbeiten || vorher.chat !== conversationId || vorher.id === id) return;
    const textJetzt = useEntwuerfe.getState().entwuerfe[conversationId]?.text ?? '';
    entwurfSetzen(conversationId, textJetzt, id);
  }, [replyTo?.id, conversationId, bearbeiten]);

  // Bearbeiten beginnt: Text der Nachricht in die Zeile, Fokus ans Ende.
  useEffect(() => {
    if (!bearbeiten) return;
    vorBearbeiten.current = text;
    setText(bearbeiten.body ?? '');
    gewaehlt.current = erwaehnteIn(bearbeiten.metadata, conversation);
    window.requestAnimationFrame(() => {
      resize();
      const feld = textareaRef.current;
      if (feld) {
        feld.focus();
        feld.setSelectionRange(feld.value.length, feld.value.length);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bearbeiten?.id]);

  function resize() {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    const lineHeight = Number.parseFloat(window.getComputedStyle(element).lineHeight) || 22;
    const padding = element.offsetHeight - element.clientHeight + 16;
    const max = lineHeight * MAX_ROWS + padding;
    element.style.height = `${Math.min(element.scrollHeight, max)}px`;
    element.style.overflowY = element.scrollHeight > max ? 'auto' : 'hidden';
  }

  /*
   * Link-Vorschau: Steht ein Link im Text und ist die Einstellung an, fragt
   * die App nach kurzer Pause den eigenen Server. Nur der Absender löst das
   * aus; wer sie verworfen hat (✕), bekommt für denselben Link keine neue.
   */
  const link = linkVorschauenAn && !bearbeiten ? ersterLink(text) : null;
  useEffect(() => {
    if (!link) {
      setVorschau(null);
      return undefined;
    }
    if (vorschau?.url === link || verworfeneVorschau.current === link) return undefined;
    let aktiv = true;
    const wecker = window.setTimeout(() => {
      api.messages
        .linkVorschau(link)
        .then((ergebnis) => {
          if (aktiv) setVorschau(ergebnis);
        })
        .catch(() => {
          if (aktiv) setVorschau(null);
        });
    }, 700);
    return () => {
      aktiv = false;
      window.clearTimeout(wecker);
    };
    // Nur bei einem anderen Link neu fragen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link]);

  function anfrageAktualisieren(wert: string, marke: number | null) {
    const neu = marke == null ? null : erwaehnungsAnfrage(wert, marke);
    setAnfrage(neu);
    setAktivIndex(0);
  }

  function erwaehnen(person: ErwaehnbarePerson) {
    const feld = textareaRef.current;
    if (!anfrage || !feld) return;
    const ergebnis = erwaehnungEinfuegen(text, anfrage, person.name);
    if (!gewaehlt.current.some((p) => p.userId === person.userId)) {
      gewaehlt.current = [...gewaehlt.current, person];
    }
    setAnfrage(null);
    handleChange(ergebnis.text, false);
    window.requestAnimationFrame(() => {
      feld.focus();
      feld.setSelectionRange(ergebnis.marke, ergebnis.marke);
    });
  }

  /** Was aus dem Text an Zusatzangaben folgt: Erwähnungen, @alle, Vorschau. */
  function zusatzAus(body: string): ClientMessageMetadata {
    const metadata: ClientMessageMetadata = {};
    const mentions = erwaehnungenImText(body, gewaehlt.current);
    if (mentions.length > 0) metadata.mentions = mentions;
    if (alleErwaehnt(body) && personen.some((p) => p.userId === 'alle')) {
      metadata.mentionsAlle = true;
    }
    if (vorschau && body.includes(vorschau.url)) {
      const { bildUrl: _bild, ...ohneBildUrl } = vorschau;
      metadata.linkVorschau = ohneBildUrl;
    }
    return metadata;
  }

  function handleChange(value: string, anfragePruefen = true) {
    setText(value);
    resize();
    if (anfragePruefen) anfrageAktualisieren(value, textareaRef.current?.selectionStart ?? null);
    if (!bearbeiten) entwurfSetzen(conversationId, value, replyTo?.id ?? null);
    if (value.trim().length === 0 || bearbeiten) {
      stopTyping();
      return;
    }
    const now = Date.now();
    if (now - lastTypingAt.current > TYPING_THROTTLE_MS) {
      lastTypingAt.current = now;
      useChat.getState().setTyping(conversationId, true, 'text');
    }
    if (idleTimer.current != null) window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(stopTyping, TYPING_IDLE_MS);
  }

  function bearbeitenBeenden(zurueck = true) {
    const vorher = vorBearbeiten.current;
    vorBearbeiten.current = null;
    setText(zurueck ? (vorher ?? '') : (vorher ?? ''));
    onBearbeitenEnde?.();
    window.requestAnimationFrame(resize);
  }

  async function speichernBearbeitet() {
    if (!bearbeiten) return;
    const body = text.trim();
    if (body.length === 0 || body === bearbeiten.body) {
      bearbeitenBeenden();
      return;
    }
    const nachricht = bearbeiten;
    const mentions = erwaehnungenImText(body, gewaehlt.current);
    bearbeitenBeenden();
    try {
      await useChat.getState().editMessage(nachricht, body, mentions);
    } catch {
      toast('Nachricht konnte nicht bearbeitet werden', 'error');
    }
  }

  async function send(silent = false) {
    if (bearbeiten) {
      await speichernBearbeitet();
      return;
    }
    const body = text.trim();
    if (body.length === 0) return;
    const replyToId = replyTo?.id ?? null;
    const metadata = zusatzAus(body);
    setText('');
    setAuswahl(null);
    setAnfrage(null);
    setVorschau(null);
    gewaehlt.current = [];
    stopTyping();
    onCancelReply();
    window.requestAnimationFrame(resize);
    try {
      await useChat.getState().sendMessage(conversationId, {
        type: 'text',
        body,
        replyToId,
        silent,
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      });
      if (silent) toast('Ohne Ton gesendet', 'success');
      onScrollToBottom();
    } catch {
      toast('Nachricht konnte nicht gesendet werden', 'error');
      setText(body);
      window.requestAnimationFrame(resize);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Die Vorschlagsliste hat Vorrang: ↑/↓ wählen, Enter/Tab übernehmen.
    if (anfrage && vorschlaege.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const schritt = event.key === 'ArrowDown' ? 1 : -1;
        setAktivIndex((i) => (i + schritt + vorschlaege.length) % vorschlaege.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const person = vorschlaege[Math.min(aktivIndex, vorschlaege.length - 1)];
        if (person) erwaehnen(person);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setAnfrage(null);
        return;
      }
    }
    if (event.key === 'Escape' && bearbeiten) {
      event.preventDefault();
      bearbeitenBeenden();
      return;
    }
    // ↑ in der leeren Zeile: die letzte eigene Nachricht bearbeiten (Desktop).
    if (
      event.key === 'ArrowUp' &&
      !bearbeiten &&
      text.length === 0 &&
      !event.shiftKey &&
      !event.altKey &&
      onLetzteBearbeiten
    ) {
      event.preventDefault();
      onLetzteBearbeiten();
      return;
    }
    // Physical keyboards send with Enter; on touch devices Enter stays a newline.
    if (event.key !== 'Enter' || event.shiftKey) return;
    if (!window.matchMedia('(pointer: fine)').matches) return;
    event.preventDefault();
    void send();
  }

  function auswahlMerken() {
    const feld = textareaRef.current;
    if (!feld) return;
    const { selectionStart: von, selectionEnd: bis } = feld;
    setAuswahl(bis > von ? { von, bis } : null);
    if (bis === von) anfrageAktualisieren(feld.value, von);
  }

  function spaeterSenden() {
    setLeiseMenue(false);
    const body = text.trim();
    if (!body) return;
    setPlanen({ body, replyToId: replyTo?.id ?? null, metadata: zusatzAus(body) });
  }

  function formatieren(art: Umschliessen) {
    const feld = textareaRef.current;
    if (!feld || !auswahl) return;
    const ergebnis = umschliessen(text, auswahl.von, auswahl.bis, art);
    handleChange(ergebnis.text);
    window.requestAnimationFrame(() => {
      feld.focus();
      feld.setSelectionRange(ergebnis.von, ergebnis.bis);
      setAuswahl({ von: ergebnis.von, bis: ergebnis.bis });
    });
  }

  function druckAnfang() {
    langGedrueckt.current = false;
    if (!canSend || bearbeiten) return;
    druckWecker.current = window.setTimeout(() => {
      druckWecker.current = null;
      langGedrueckt.current = true;
      setLeiseMenue(true);
      try {
        navigator.vibrate?.(10);
      } catch {
        /* kein Motor */
      }
    }, LEISE_DRUCK_MS);
  }

  function druckEnde() {
    if (druckWecker.current != null) {
      window.clearTimeout(druckWecker.current);
      druckWecker.current = null;
    }
  }

  const ActiveActionView = activeAction?.render;

  return (
    <div className="msg-composer">
      {bearbeiten && (
        <div className="msg-composer-reply msg-composer-bearbeiten" role="status">
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="msg-quote-name">✏️ Nachricht bearbeiten</div>
            <div className="msg-quote-text truncate">{messagePreview(bearbeiten)}</div>
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label="Bearbeiten abbrechen"
            onClick={() => bearbeitenBeenden()}
          >
            ✕
          </button>
        </div>
      )}

      {nurAdminsGesperrt && (
        <div className="msg-composer-hinweis" role="status">
          🔒 Nur Admins dürfen in dieser Gruppe schreiben.
        </div>
      )}
      {!nurAdminsGesperrt && restSekunden > 0 && !bearbeiten && (
        <div className="msg-composer-hinweis" role="status" aria-live="off">
          🐢 Langsamer Modus: nächste Nachricht in{' '}
          {restSekunden >= 60
            ? `${Math.floor(restSekunden / 60)}:${String(restSekunden % 60).padStart(2, '0')} min`
            : `${restSekunden} s`}
        </div>
      )}

      {replyTo && !bearbeiten && (
        <div className="msg-composer-reply">
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="msg-quote-name">{senderName(conversation, replyTo.senderId)}</div>
            <div className="msg-quote-text truncate">{messagePreview(replyTo)}</div>
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label="Antwort verwerfen"
            onClick={onCancelReply}
          >
            ✕
          </button>
        </div>
      )}

      <ErwaehnungsVorschlaege
        id={listeId}
        vorschlaege={anfrage ? vorschlaege : []}
        aktiv={aktivIndex}
        onWaehlen={erwaehnen}
      />

      {vorschau && !bearbeiten && (
        <LinkVorschauKarte
          vorschau={vorschau}
          imEntwurf
          onVerwerfen={() => {
            verworfeneVorschau.current = vorschau.url;
            setVorschau(null);
          }}
        />
      )}

      {auswahl && (
        <div className="msg-formathilfe" role="toolbar" aria-label="Formatierung">
          {FORMATE.map((format) => (
            <button
              key={format.art}
              type="button"
              className={`msg-format msg-format-${format.art}`}
              aria-label={format.label}
              title={format.titel}
              // Der Fokus bleibt in der Zeile, damit die Auswahl stehen bleibt.
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => formatieren(format.art)}
            >
              {format.zeichen}
            </button>
          ))}
        </div>
      )}

      <div className="msg-composer-row">
        {/* „Anhang hinzufügen“ stand hier und war schlicht falsch: Hinter dem
            Knopf liegen auch Sticker, Termin, Umfrage und Spiel. */}
        {actions.length > 0 && !bearbeiten && (
          <button
            type="button"
            className="icon-btn msg-composer-plus"
            aria-label="Mehr hinzufügen"
            onClick={() => setActionsOpen(true)}
          >
            ＋
          </button>
        )}
        {/* Aktionen, die sich einen eigenen Platz gewünscht haben. */}
        {!bearbeiten &&
          pinned.map((action) => action.knopf ? (
            // Eigener Knopf (Sprachnachricht: gedrückt halten), sonst der übliche.
            <action.knopf
              key={action.key}
              conversationId={conversationId}
              oeffnen={() => setActiveAction(action)}
            />
          ) : (
            <button
              key={action.key}
              type="button"
              className="icon-btn msg-composer-pinned"
              aria-label={action.label}
              title={action.label}
              onClick={() => setActiveAction(action)}
            >
              <span aria-hidden="true">{action.icon}</span>
            </button>
          ))}
        <textarea
          ref={textareaRef}
          className="msg-composer-input"
          rows={1}
          placeholder={bearbeiten ? 'Nachricht bearbeiten' : 'Nachricht schreiben'}
          disabled={nurAdminsGesperrt}
          aria-label={bearbeiten ? 'Nachricht bearbeiten' : 'Nachricht schreiben'}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={Boolean(anfrage && vorschlaege.length > 0)}
          aria-controls={anfrage && vorschlaege.length > 0 ? listeId : undefined}
          aria-activedescendant={
            anfrage && vorschlaege.length > 0 ? `${listeId}-${aktivIndex}` : undefined
          }
          value={text}
          enterKeyHint="enter"
          onChange={(event) => handleChange(event.target.value)}
          onKeyDown={onKeyDown}
          onSelect={auswahlMerken}
          onBlur={() => window.setTimeout(auswahlMerken, 0)}
          onFocus={onScrollToBottom}
        />
        <div className="msg-send-halter">
          <button
            type="button"
            className="msg-send"
            aria-label={bearbeiten ? 'Änderung speichern' : 'Senden'}
            aria-haspopup={bearbeiten ? undefined : 'menu'}
            title={bearbeiten ? undefined : 'Lange drücken: ohne Ton oder später senden'}
            disabled={!canSend}
            onPointerDown={druckAnfang}
            onPointerUp={druckEnde}
            onPointerLeave={druckEnde}
            onPointerCancel={druckEnde}
            onContextMenu={(event) => {
              event.preventDefault();
              if (canSend && !bearbeiten) setLeiseMenue(true);
            }}
            onClick={() => {
              // Ein langer Druck hat das Menü geöffnet – kein Senden dazu.
              if (langGedrueckt.current) {
                langGedrueckt.current = false;
                return;
              }
              void send();
            }}
          >
            {bearbeiten ? '✓' : '➤'}
          </button>
          {leiseMenue && (
            <div className="msg-leise-menue" role="menu" aria-label="Senden-Optionen">
              <button
                type="button"
                role="menuitem"
                className="list-row"
                autoFocus
                onClick={() => {
                  setLeiseMenue(false);
                  void send(true);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setLeiseMenue(false);
                }}
              >
                <span aria-hidden="true">🔕</span>
                <span>Ohne Ton senden</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="list-row"
                onClick={spaeterSenden}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setLeiseMenue(false);
                }}
              >
                <span aria-hidden="true">🕒</span>
                <span>Später senden …</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="list-row"
                onClick={() => setLeiseMenue(false)}
              >
                <span aria-hidden="true">✕</span>
                <span>Abbrechen</span>
              </button>
            </div>
          )}
        </div>
      </div>

      <Sheet open={actionsOpen} onClose={() => setActionsOpen(false)} title="Hinzufügen">
        <div className="msg-action-grid">
          {actions.map((action) => (
            <button
              key={action.key}
              type="button"
              className="msg-action-tile"
              onClick={() => {
                setActionsOpen(false);
                setActiveAction(action);
              }}
            >
              <span className="msg-action-icon" aria-hidden="true">
                {action.icon}
              </span>
              <span>{action.label}</span>
            </button>
          ))}
        </div>
      </Sheet>

      <PlanenSheet
        conversationId={conversationId}
        entwurf={planen}
        onClose={() => setPlanen(null)}
        onGeplant={() => {
          setPlanen(null);
          setText('');
          setVorschau(null);
          gewaehlt.current = [];
          entwurfSetzen(conversationId, '', null);
          onCancelReply();
          window.requestAnimationFrame(resize);
        }}
      />

      {ActiveActionView && (
        <ActiveActionView
          key={activeAction?.key}
          conversationId={conversationId}
          onClose={() => setActiveAction(null)}
        />
      )}
    </div>
  );
}
