import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { LIMITS, type ConversationDto, type RsvpStatus } from '@initiative/shared';
import { Avatar } from '../../components/Avatar.js';
import { Spinner } from '../../components/Feedback.js';
import { api } from '../../lib/api.js';
import { useChat } from '../../state/chat.js';
import { useLeute } from '../../state/leute.js';
import { rsvpMeta } from './helpers.js';
import {
  aenderungsVorschau,
  alleWaehlen,
  bestehendeKarteHinweis,
  einzelchatMit,
  filtern,
  gruppeEntfernen,
  gruppeWaehlen,
  gruppenAus,
  gruppenStatus,
  kontakteAus,
  kontaktVon,
  niemand,
  personUmschalten,
  postenUmschalten,
  vorgeschlageneGruppen,
  vorschau,
  zaehlerText,
  type Auswahl,
  type Gruppe,
  type Kontakt,
} from './einladung.js';

/** In wie grossen Schritten die Liste wächst – bei 200 Kontakten zeichnet sie sonst alles auf einmal. */
const SCHRITT = 100;

/**
 * Was die Einladung braucht, aus dem Chat-Speicher: wer zur Wahl steht, welche
 * Gruppenchats es gibt, mit wem es schon einen Einzelchat gibt.
 *
 * Neu berechnet wird nur, wenn sich wirklich jemand ändert. Der Zustand ersetzt
 * `conversations` bei JEDER eingehenden Nachricht, auch aus fremden Chats; ohne
 * die Signatur zeichnete sich die Liste mit zweihundert Zeilen bei jeder
 * Nachricht irgendwo in der App neu (derselbe Kniff wie in `ExpenseSheet`).
 */
export function useEinladungsDaten(myId: string) {
  const conversations = useChat((state) => state.conversations);
  const geladen = useChat((state) => state.conversationsLoaded);
  const fehlgeschlagen = useChat((state) => state.conversationsFailed);
  const aktuell = useRef(conversations);
  aktuell.current = conversations;

  // Archivierte Einzelchats kennt der Speicher nicht (die Chatliste lädt sie
  // nicht), der Server nimmt für eine Einladung aber auch einen archivierten.
  // Ohne sie meldete die Vorschau bei jedem, der Chats archiviert, „neu
  // angelegt“, wo nichts entsteht. Einmal beim Öffnen geholt; schlägt es fehl,
  // bleibt die Zahl eine obere Grenze.
  const [archiviert, setArchiviert] = useState<ConversationDto[]>([]);
  const archiviertRef = useRef(archiviert);
  archiviertRef.current = archiviert;
  useEffect(() => {
    let abgebrochen = false;
    api.conversations
      .list(true)
      .then(({ items }) => {
        if (!abgebrochen) setArchiviert(items);
      })
      .catch(() => {});
    return () => {
      abgebrochen = true;
    };
  }, []);

  const signatur = useMemo(
    () =>
      conversations
        .map(
          (chat) =>
            `${chat.id}:${chat.type}:${chat.archived ? 'a' : '-'}:${chat.title ?? ''}:` +
            chat.members
              .map(
                (mitglied) =>
                  `${mitglied.userId}=${mitglied.user.displayName}=${mitglied.user.username}=${mitglied.nickname ?? ''}`,
              )
              .join(','),
        )
        .join('|'),
    [conversations],
  );
  const archivSignatur = useMemo(
    () => archiviert.map((chat) => `${chat.id}:${chat.members.length}`).join('|'),
    [archiviert],
  );

  const daten = useMemo(
    () => ({
      kontakte: kontakteAus(aktuell.current, myId),
      gruppen: gruppenAus(aktuell.current, myId),
      einzelchatMit: einzelchatMit([...aktuell.current, ...archiviertRef.current], myId),
    }),
    // `signatur` steht stellvertretend für den Inhalt von `conversations`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signatur, archivSignatur, myId],
  );

  // „Bereit“ erst, wenn die Chatliste wirklich vom Server kam (oder aus dem
  // Zwischenspeicher da ist): `initialised` gilt schon nach dem Lesen des
  // Zwischenspeichers, bei einem kalten Start ist die Liste dann noch leer.
  const bereit = geladen || conversations.length > 0;
  return {
    ...daten,
    bereit,
    listeFehler: !bereit && fehlgeschlagen,
    listeNochmal: () => {
      void useChat
        .getState()
        .loadConversations()
        .catch(() => {});
    },
  };
}

interface ZeileProps {
  kontakt: Kontakt;
  an: boolean;
  antwort: RsvpStatus | undefined;
  onUmschalten: (id: string) => void;
}

/** Eine Person in der Liste. Memoisiert: Beim Anhaken zeichnet sich nur diese Zeile neu. */
const PersonenZeile = memo(function PersonenZeile({
  kontakt,
  an,
  antwort,
  onUmschalten,
}: ZeileProps) {
  const meta = antwort ? rsvpMeta(antwort) : null;
  return (
    <label className="cal-einl-zeile">
      <input type="checkbox" checked={an} onChange={() => onUmschalten(kontakt.id)} />
      <Avatar name={kontakt.displayName} id={kontakt.id} url={kontakt.avatarUrl} size={32} />
      <span className="cal-einl-name">
        <span className="truncate">{kontakt.displayName}</span>
        <span className="cal-einl-nutzer truncate">@{kontakt.username}</span>
      </span>
      {/* Die Antwort steht als Text und Zeichen da – Farbe allein sagt es nicht. */}
      {meta && (
        <span className="cal-einl-antwort" style={{ color: meta.color }}>
          <span aria-hidden="true">{meta.symbol}</span> {meta.label}
        </span>
      )}
    </label>
  );
});

export interface EinladungsWahlProps {
  myId: string;
  auswahl: Auswahl;
  onChange: (auswahl: Auswahl) => void;
  /** Hauptschalter „Einladung im Chat senden“. */
  senden: boolean;
  onSenden: (an: boolean) => void;
  /** Unterschalter: Karte in die Einzelchats. */
  einzelchats: boolean;
  onEinzelchats: (an: boolean) => void;
  /**
   * Beim Bearbeiten: wer schon eingeladen ist (ohne den Ersteller), mit seiner
   * Antwort. Die Vorschau beschreibt dann den Unterschied zu diesem Stand.
   */
  bisher?: Record<string, RsvpStatus>;
  /**
   * Beim Bearbeiten: die Gruppenchats, in denen die Karte schon steht. `null`,
   * solange das noch geladen wird – dann zeigt das Feld eine Platzhalterzeile,
   * und der Editor schickt `gruppenChatIds` nicht mit.
   */
  bestehendeGruppen?: string[] | null;
  /** Das Laden der bestehenden Gruppenkarten ist gescheitert. */
  gruppenFehler?: boolean;
  /** Versucht, die bestehenden Gruppenkarten noch einmal zu laden. */
  onGruppenNochmal?: () => void;
  /**
   * Nachträglich einladen (Detailseite): Wer schon eingeladen ist, steht nicht
   * zur Wahl, und es gibt keine Gruppenchats – nur Personen.
   */
  nurNeue?: boolean;
  /** Weitere Zeilen der Vorschau, die der Editor kennt (zum Beispiel „Zeit geändert“). */
  zusatzZeilen?: string[];
}

/**
 * Das Feld „Eingeladen“ – die Liste aller Personen, die man einladen kann,
 * mit Schnellwahl, Gruppenchats und einer Vorschau, wohin die Einladung geht.
 *
 * Die Liste steht immer da, auch wenn niemand gewählt ist: Die Suche **filtert**
 * sie nur. Vorher musste man einen Namen tippen, um überhaupt einen zu sehen.
 *
 * Die Komponente hält keinen eigenen Zustand ausser dem, was nur sie angeht
 * (Suchtext, Anzeige, Aufklappen). Wer gewählt ist, kommt und geht über
 * `auswahl`; alle Regeln stehen in `einladung.ts` und sind dort getestet.
 *
 * `PersonenWahl` bleibt unangetastet: Sie hat ein anderes Modell (Vorschläge,
 * `fest`, `ausschluss`) und sechs weitere Nutzer.
 */
export function EinladungsWahl({
  myId,
  auswahl,
  onChange,
  senden,
  onSenden,
  einzelchats,
  onEinzelchats,
  bisher,
  bestehendeGruppen,
  gruppenFehler = false,
  onGruppenNochmal,
  nurNeue = false,
  zusatzZeilen = [],
}: EinladungsWahlProps) {
  const {
    kontakte,
    gruppen,
    einzelchatMit: mitEinzelchat,
    bereit,
    listeFehler,
    listeNochmal,
  } = useEinladungsDaten(myId);
  const leute = useLeute((state) => state.byId);

  // Solange nicht bekannt ist, wo der Termin schon als Karte steht (Bearbeiten),
  // lässt sich keine Gruppe wählen: Die Wahl würde beim Speichern verworfen.
  const gruppenUnbekannt = bestehendeGruppen === null;

  const panelId = useId();
  const [suche, setSuche] = useState('');
  const [anzeige, setAnzeige] = useState<'alle' | 'gewaehlt'>('alle');
  const [sichtbar, setSichtbar] = useState(SCHRITT);
  const [gruppenOffen, setGruppenOffen] = useState(false);
  const [meldung, setMeldung] = useState<string | null>(null);
  const [niemandFrage, setNiemandFrage] = useState(false);
  /**
   * Wer beim Wechsel in die Ansicht „Gewählt“ gewählt war: Diese Zeilen bleiben
   * stehen, auch wenn man sie dort abwählt – sonst verschwindet die Zeile samt
   * Fokus unter der Hand, und wer mit der Tastatur arbeitet, verliert seine
   * Stelle. Beim Verlassen der Ansicht räumt sich die Liste auf.
   */
  const [festgehalten, setFestgehalten] = useState<Set<string>>(new Set());
  const gruppenKnopf = useRef<HTMLButtonElement>(null);
  const gruppenPanel = useRef<HTMLDivElement>(null);
  const frageRef = useRef<HTMLDivElement>(null);

  // Der Aufrufer reicht `onChange` meist als frische Funktion durch; über eine
  // Referenz bleiben die Rückrufe der Zeilen stabil, und die Zeilen bleiben
  // memoisiert.
  const aktuell = useRef({ auswahl, onChange });
  aktuell.current = { auswahl, onChange };

  const ausschluss = useMemo(
    () => (nurNeue ? new Set(Object.keys(bisher ?? {})) : null),
    [nurNeue, bisher],
  );
  const waehlbar = useMemo(
    () => (ausschluss ? kontakte.filter((kontakt) => !ausschluss.has(kontakt.id)) : kontakte),
    [kontakte, ausschluss],
  );
  const kontaktIds = useMemo(() => new Set(kontakte.map((kontakt) => kontakt.id)), [kontakte]);
  const gewaehlt = useMemo(() => new Set(auswahl.personen), [auswahl.personen]);

  /* ---------- Suche im Verzeichnis (ab zwei Zeichen) ---------- */

  const [treffer, setTreffer] = useState<Kontakt[]>([]);
  const [sucht, setSucht] = useState(false);
  const [suchFehler, setSuchFehler] = useState(false);
  const [nochmal, setNochmal] = useState(0);

  useEffect(() => {
    const begriff = suche.trim();
    if (begriff.length < 2) {
      setTreffer([]);
      setSuchFehler(false);
      return undefined;
    }
    setSucht(true);
    setSuchFehler(false);
    // Ein Abbruch-Merker, nicht nur ein abgeräumter Zeitgeber: Der Zeitgeber
    // wird abgebrochen, die schon laufende Anfrage nicht. Eine ältere, langsamere
    // Antwort überschriebe sonst die Treffer der neueren (wie in `PersonenWahl`).
    let abgebrochen = false;
    const zeitgeber = window.setTimeout(() => {
      void api.users
        .search(begriff)
        .then((ergebnis) => {
          if (!abgebrochen) setTreffer(ergebnis.items.map(kontaktVon));
        })
        .catch(() => {
          if (!abgebrochen) {
            setTreffer([]);
            setSuchFehler(true);
          }
        })
        .finally(() => {
          if (!abgebrochen) setSucht(false);
        });
    }, 250);
    return () => {
      abgebrochen = true;
      window.clearTimeout(zeitgeber);
      setSucht(false);
    };
  }, [suche, nochmal]);

  /*
   * Gewählte, die keine Kontakte sind (früher über die Suche geholt, oder beim
   * Bearbeiten schon eingeladen), stehen immer unter „Weitere Personen“, damit
   * sie abwählbar bleiben. Ihre Namen kommen gebündelt aus `useLeute` – eine
   * Anfrage, nicht eine je Person.
   */
  const fremdGewaehlt = useMemo(
    () => auswahl.personen.filter((id) => !kontaktIds.has(id)),
    [auswahl.personen, kontaktIds],
  );
  /*
   * Auch wer abgewählt wurde, bleibt in der Liste: Wer schon eingeladen war oder
   * in diesem Blatt einmal gewählt wurde und kein Kontakt ist, ließe sich sonst
   * nur über eine neue Suche (oder durch Abbrechen des ganzen Blatts) wieder
   * zurückwählen – genau diese Leute erreicht man nur über die Suche.
   */
  const [fremdGemerkt, setFremdGemerkt] = useState<string[]>([]);
  const fremdSchluessel = fremdGewaehlt.join(',');
  useEffect(() => {
    if (!fremdSchluessel) return;
    setFremdGemerkt((bisherGemerkt) => {
      const neu = fremdSchluessel.split(',').filter((id) => !bisherGemerkt.includes(id));
      return neu.length > 0 ? [...bisherGemerkt, ...neu] : bisherGemerkt;
    });
  }, [fremdSchluessel]);
  const fremdBisher = useMemo(
    () => (nurNeue ? [] : Object.keys(bisher ?? {}).filter((id) => !kontaktIds.has(id))),
    [nurNeue, bisher, kontaktIds],
  );
  const fremdAlle = useMemo(
    () => [...new Set([...fremdGewaehlt, ...fremdBisher, ...fremdGemerkt])],
    [fremdGewaehlt, fremdBisher, fremdGemerkt],
  );
  const fremdAlleSchluessel = fremdAlle.join(',');
  useEffect(() => {
    if (fremdAlleSchluessel) useLeute.getState().sicherstellen(fremdAlleSchluessel.split(','));
  }, [fremdAlleSchluessel]);

  const weitere = useMemo(() => {
    const liste: Kontakt[] = [];
    const gesehen = new Set<string>();
    const aufnehmen = (kontakt: Kontakt | undefined) => {
      if (!kontakt || gesehen.has(kontakt.id) || kontaktIds.has(kontakt.id)) return;
      if (kontakt.id === myId || ausschluss?.has(kontakt.id)) return;
      gesehen.add(kontakt.id);
      liste.push(kontakt);
    };
    for (const id of fremdAlle) {
      const nutzer = leute[id];
      aufnehmen(
        nutzer
          ? kontaktVon(nutzer)
          : { id, displayName: 'Unbekannt', username: '…', avatarUrl: null },
      );
    }
    for (const kontakt of treffer) aufnehmen(kontakt);
    return liste;
  }, [fremdAlle, leute, treffer, kontaktIds, myId, ausschluss]);

  const nameVon = useCallback(
    (id: string): string => {
      const kontakt = kontakte.find((eintrag) => eintrag.id === id);
      if (kontakt) return kontakt.displayName;
      return (
        leute[id]?.displayName ?? treffer.find((eintrag) => eintrag.id === id)?.displayName ?? '…'
      );
    },
    [kontakte, leute, treffer],
  );

  /* ---------- Rückrufe ---------- */

  const umschalten = useCallback((id: string) => {
    const { auswahl: jetzt, onChange: aendern } = aktuell.current;
    aendern(personUmschalten(jetzt, id));
    setMeldung(null);
  }, []);

  const alleKontakte = useMemo(() => alleWaehlen(waehlbar, auswahl), [waehlbar, auswahl]);

  function alle() {
    setNiemandFrage(false);
    onChange(alleKontakte.auswahl);
    setMeldung(null);
  }

  function keinen() {
    // Beim Bearbeiten heisst „Niemand“ auch: die schon Eingeladenen ausladen.
    // Das fragt vorher nach – ein Fehlgriff liesse sich nur einzeln zurücknehmen.
    if (!nurNeue && ausgeladenAnzahl > 0 && !niemandFrage) {
      setNiemandFrage(true);
      return;
    }
    setNiemandFrage(false);
    onChange(nurNeue ? { ...auswahl, personen: [] } : niemand());
    setMeldung(null);
  }

  function waehleGruppe(gruppe: Gruppe) {
    if (gruppenUnbekannt) {
      setMeldung(
        gruppenFehler
          ? 'Erst muss sich laden lassen, wo der Termin schon steht – versuche es unten noch einmal.'
          : 'Einen Augenblick – es wird noch geladen, wo der Termin schon steht.',
      );
      setGruppenOffen(false);
      return;
    }
    const ergebnis = gruppeWaehlen(auswahl, gruppe);
    if (ergebnis.zuViele) {
      setMeldung(
        auswahl.gruppen.length >= LIMITS.einladungGruppenMax
          ? `Höchstens ${LIMITS.einladungGruppenMax} Gruppenchats.`
          : `Dieser Gruppenchat hat ${gruppe.anzahl} Mitglieder – mehr als ${LIMITS.einladungenMax} lassen sich nicht einladen.`,
      );
    } else {
      setMeldung(null);
      onChange(ergebnis.auswahl);
    }
    setNiemandFrage(false);
    setGruppenOffen(false);
    gruppenKnopf.current?.focus();
  }

  // Beim Öffnen wandert der Fokus auf die erste Zeile.
  useEffect(() => {
    if (gruppenOffen) gruppenPanel.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [gruppenOffen]);

  // Die Rückfrage meldet sich als Hinweis und nimmt den Fokus mit: Wer mit
  // Tastatur oder Vorlesehilfe arbeitet, merkt sonst nicht, dass etwas gefragt wird.
  useEffect(() => {
    if (niemandFrage) frageRef.current?.focus();
  }, [niemandFrage]);

  /**
   * Esc schließt im geöffneten Gruppenfeld nur das Feld. Das Blatt hört auf
   * dasselbe Esc am Fenster und schlösse sonst alles, samt aller Eingaben.
   */
  function gruppenTaste(taste: React.KeyboardEvent) {
    if (taste.key !== 'Escape' || !gruppenOffen) return;
    taste.preventDefault();
    taste.stopPropagation();
    setGruppenOffen(false);
    gruppenKnopf.current?.focus();
  }

  /* ---------- Anzeige ---------- */

  const gefiltert = useMemo(() => filtern(waehlbar, suche), [waehlbar, suche]);
  const gezeigt = useMemo(
    () =>
      anzeige === 'gewaehlt'
        ? gefiltert.filter((kontakt) => gewaehlt.has(kontakt.id) || festgehalten.has(kontakt.id))
        : gefiltert,
    [gefiltert, anzeige, gewaehlt, festgehalten],
  );
  const weitereGezeigt =
    anzeige === 'gewaehlt'
      ? weitere.filter((kontakt) => gewaehlt.has(kontakt.id) || festgehalten.has(kontakt.id))
      : weitere;

  const moeglich = waehlbar.length + weitere.filter((kontakt) => gewaehlt.has(kontakt.id)).length;
  const anzahl = auswahl.personen.filter((id) => id !== myId).length;

  // Der Umschalter „Alle · Gewählt“ steht nur bei vielen Personen. Verschwindet
  // er (die wählbare Menge schrumpft, etwa nach dem Einladen), darf die Ansicht
  // nicht auf „Gewählt“ hängenbleiben: Die Liste bliebe leer, und der Weg zurück
  // wäre weg.
  const umschalterSichtbar = moeglich > 8;
  useEffect(() => {
    if (!umschalterSichtbar && anzeige === 'gewaehlt') setAnzeige('alle');
  }, [umschalterSichtbar, anzeige]);

  function anzeigeWechseln(neu: 'alle' | 'gewaehlt') {
    setAnzeige(neu);
    setFestgehalten(neu === 'gewaehlt' ? new Set(auswahl.personen) : new Set());
  }
  const gruppenNachId = useMemo(
    () => new Map(gruppen.map((gruppe) => [gruppe.id, gruppe])),
    [gruppen],
  );

  const vorgeschlagen = useMemo(
    () => (nurNeue || gruppenUnbekannt ? [] : vorgeschlageneGruppen(gruppen, auswahl)),
    [gruppen, auswahl, nurNeue, gruppenUnbekannt],
  );

  const zeilen = useMemo(() => {
    const eingabe = { senden, einzelchats };
    if (bisher) {
      // Beim nachträglichen Einladen enthält die Wahl nur die Neuen; die schon
      // Eingeladenen werden nicht ausgeladen und gehören nicht in den Vergleich.
      const vorher = nurNeue ? [] : Object.keys(bisher);
      return aenderungsVorschau({
        myId,
        auswahl,
        eingabe,
        gruppen,
        vorher,
        zugesagt: new Set(vorher.filter((id) => bisher[id] === 'yes' || bisher[id] === 'maybe')),
        bestehendeGruppen: nurNeue ? null : (bestehendeGruppen ?? null),
        einzelchatMit: mitEinzelchat,
        name: nameVon,
      });
    }
    return vorschau({
      myId,
      auswahl,
      eingabe,
      gruppen,
      einzelchatMit: mitEinzelchat,
      name: nameVon,
    });
  }, [
    bisher,
    myId,
    auswahl,
    senden,
    einzelchats,
    gruppen,
    nurNeue,
    bestehendeGruppen,
    mitEinzelchat,
    nameVon,
  ]);

  const suchtext = suche.trim();
  // „Du hast noch keine Kontakte“ gilt nur, wenn es wirklich keine gibt. Beim
  // nachträglichen Einladen ist die wählbare Liste auch dann leer, wenn alle
  // Kontakte schon eingeladen sind – das ist etwas anderes.
  const keineKontakte =
    bereit &&
    kontakte.length === 0 &&
    waehlbar.length === 0 &&
    weitere.length === 0 &&
    suchtext === '';
  const alleEingeladen =
    bereit &&
    nurNeue &&
    kontakte.length > 0 &&
    waehlbar.length === 0 &&
    weitere.length === 0 &&
    suchtext === '';

  // Wie viele schon Eingeladene würde „Niemand“ ausladen?
  const ausgeladenAnzahl = auswahl.personen.filter((id) => id in (bisher ?? {})).length;

  return (
    <fieldset className="field cal-einl">
      <legend>{nurNeue ? 'Wen einladen?' : 'Eingeladen'}</legend>

      {/* „0 von 0 Personen“ sagt nichts, was die Hinweise darunter nicht besser sagen. */}
      {!keineKontakte && !alleEingeladen && (
        <p className="cal-einl-zahl" role="status" aria-live="polite">
          {zaehlerText(anzahl, moeglich)}
        </p>
      )}
      {!nurNeue && <p className="cal-hint">Du bist immer dabei.</p>}

      {!bereit ? (
        listeFehler ? (
          <p className="cal-hint" role="alert">
            Deine Kontakte konnten nicht geladen werden.{' '}
            <button type="button" className="btn btn-sm" onClick={listeNochmal}>
              Erneut versuchen
            </button>
          </p>
        ) : (
          <Spinner label="Kontakte werden geladen …" />
        )
      ) : (
        <>
          <div className="cal-einl-schnell">
            <button
              type="button"
              className="btn btn-sm"
              disabled={waehlbar.length === 0 || alleKontakte.abgeschnitten}
              aria-label="Alle Kontakte einladen"
              onClick={alle}
            >
              Alle
            </button>
            <button
              type="button"
              className="btn btn-sm"
              aria-label="Niemand einladen"
              onClick={keinen}
            >
              Niemand
            </button>
            {!nurNeue && gruppen.length > 0 && (
              <button
                ref={gruppenKnopf}
                type="button"
                className="btn btn-sm"
                aria-expanded={gruppenOffen}
                aria-controls={panelId}
                disabled={gruppenUnbekannt}
                title={
                  gruppenUnbekannt ? 'Es wird noch geladen, wo der Termin schon steht.' : undefined
                }
                onKeyDown={gruppenTaste}
                onClick={() => setGruppenOffen((offen) => !offen)}
              >
                Gruppenchat … <span aria-hidden="true">{gruppenOffen ? '▴' : '▾'}</span>
              </button>
            )}
          </div>

          {alleKontakte.abgeschnitten && (
            <p className="cal-hint">
              Mehr als {LIMITS.einladungenMax} Kontakte – wähle einen Gruppenchat oder einzelne
              Personen.
            </p>
          )}
          {meldung && (
            <p className="cal-error" role="alert">
              {meldung}
            </p>
          )}

          {niemandFrage && (
            <div
              ref={frageRef}
              tabIndex={-1}
              className="cal-einl-frage"
              role="alert"
              aria-label="Rückfrage"
            >
              <p>
                {ausgeladenAnzahl === 1 ? '1 Person wird' : `${ausgeladenAnzahl} Personen werden`}{' '}
                ausgeladen. {ausgeladenAnzahl === 1 ? 'Ihre Karte' : 'Ihre Karten'} im Einzelchat{' '}
                {ausgeladenAnzahl === 1 ? 'wird' : 'werden'} gelöscht.
              </p>
              <div className="cal-einl-frage-knoepfe">
                <button type="button" className="btn btn-sm btn-danger" onClick={keinen}>
                  Ja, ausladen
                </button>
                <button type="button" className="btn btn-sm" onClick={() => setNiemandFrage(false)}>
                  Abbrechen
                </button>
              </div>
            </div>
          )}

          {gruppenOffen && (
            <div
              id={panelId}
              ref={gruppenPanel}
              className="cal-einl-gruppenwahl"
              role="group"
              aria-label="Gruppenchat wählen"
              onKeyDown={gruppenTaste}
            >
              {gruppen.map((gruppe) => {
                const gewaehltChip = auswahl.gruppen.includes(gruppe.id);
                return (
                  <button
                    key={gruppe.id}
                    type="button"
                    className="cal-einl-gruppe"
                    aria-pressed={gewaehltChip}
                    onClick={() => waehleGruppe(gruppe)}
                  >
                    <span className="truncate">{gruppe.titel}</span>
                    <span className="cal-einl-nutzer">{gruppe.anzahl} Mitglieder</span>
                    <span aria-hidden="true">{gewaehltChip ? '✓' : ''}</span>
                  </button>
                );
              })}
            </div>
          )}

          <input
            type="search"
            className="input cal-einl-suche"
            value={suche}
            placeholder="Person suchen …"
            aria-label="Person suchen"
            autoComplete="off"
            onChange={(wechsel) => {
              setSuche(wechsel.target.value);
              setSichtbar(SCHRITT);
            }}
          />

          {umschalterSichtbar && (
            <div className="cal-einl-anzeige" role="group" aria-label="Anzeige">
              {/* Der sichtbare Text steht am Anfang des Namens: Wer „Gewählt 3“
                  sagt, trifft die Taste, und die Zahl wird mitgelesen. */}
              <button
                type="button"
                aria-pressed={anzeige === 'alle'}
                aria-label={`Alle ${waehlbar.length} Personen anzeigen`}
                className={anzeige === 'alle' ? 'is-active' : undefined}
                onClick={() => anzeigeWechseln('alle')}
              >
                Alle {waehlbar.length}
              </button>
              <button
                type="button"
                aria-pressed={anzeige === 'gewaehlt'}
                aria-label={`Gewählt ${anzahl}: nur gewählte Personen anzeigen`}
                className={anzeige === 'gewaehlt' ? 'is-active' : undefined}
                onClick={() => anzeigeWechseln('gewaehlt')}
              >
                Gewählt {anzahl}
              </button>
            </div>
          )}

          {keineKontakte ? (
            <p className="cal-hint">
              Du hast noch keine Kontakte – such eine Person mit dem Suchfeld.
            </p>
          ) : alleEingeladen ? (
            <p className="cal-hint">
              Alle deine Kontakte sind schon eingeladen – such eine weitere Person mit dem Suchfeld.
            </p>
          ) : (
            <div className="cal-einl-liste" role="group" aria-label="Personen">
              {gezeigt.slice(0, sichtbar).map((kontakt) => (
                <PersonenZeile
                  key={kontakt.id}
                  kontakt={kontakt}
                  an={gewaehlt.has(kontakt.id)}
                  antwort={bisher?.[kontakt.id]}
                  onUmschalten={umschalten}
                />
              ))}
              {/* Der Leerzustand steht unabhängig vom Suchtext da: In der Ansicht
                  „Gewählt“ ohne Auswahl bliebe die Fläche sonst völlig leer. */}
              {gezeigt.length === 0 && weitereGezeigt.length === 0 && anzeige === 'gewaehlt' && (
                <p className="cal-hint">Niemand gewählt.</p>
              )}
              {gezeigt.length === 0 && anzeige === 'alle' && suchtext !== '' && (
                <p className="cal-hint">Keiner deiner Kontakte passt.</p>
              )}
              {gezeigt.length > sichtbar && (
                <button
                  type="button"
                  className="btn btn-sm cal-einl-mehr"
                  onClick={() => setSichtbar((bisherSichtbar) => bisherSichtbar + SCHRITT)}
                >
                  Weitere anzeigen ({gezeigt.length - sichtbar})
                </button>
              )}
            </div>
          )}

          {/* Verzeichnis: ab zwei Zeichen, und die schon Gewählten von ausserhalb. */}
          {(weitereGezeigt.length > 0 || sucht || suchFehler || suchtext.length >= 2) && (
            <>
              <h3 className="cal-einl-titel">Weitere Personen auf diesem Server</h3>
              {sucht && <p className="cal-hint">Wird gesucht …</p>}
              {suchFehler && (
                <p className="cal-hint">
                  Die Suche ist gerade nicht möglich.{' '}
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setNochmal((zaehler) => zaehler + 1)}
                  >
                    Erneut versuchen
                  </button>
                </p>
              )}
              {!sucht && !suchFehler && suchtext.length >= 2 && weitereGezeigt.length === 0 && (
                <p className="cal-hint">Niemand gefunden.</p>
              )}
              {weitereGezeigt.length > 0 && (
                <div className="cal-einl-liste" role="group" aria-label="Weitere Personen">
                  {weitereGezeigt.map((kontakt) => (
                    <div key={kontakt.id} className="cal-einl-weitere">
                      <PersonenZeile
                        kontakt={kontakt}
                        an={gewaehlt.has(kontakt.id)}
                        antwort={bisher?.[kontakt.id]}
                        onUmschalten={umschalten}
                      />
                      <span className="cal-einl-nutzer">nicht in deinen Chats</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {!nurNeue &&
            (auswahl.gruppen.length > 0 ||
              bestehendeGruppen === null ||
              vorgeschlagen.length > 0) && (
              <>
                <h3 className="cal-einl-titel">Gruppenchats</h3>
                {bestehendeGruppen === null &&
                  (gruppenFehler ? (
                    <p className="cal-hint is-warnung" role="alert">
                      Wo der Termin schon steht, ließ sich nicht laden. Solange das fehlt, lässt
                      sich kein Gruppenchat wählen.{' '}
                      {onGruppenNochmal && (
                        <button type="button" className="btn btn-sm" onClick={onGruppenNochmal}>
                          Erneut versuchen
                        </button>
                      )}
                    </p>
                  ) : (
                    <p className="cal-hint">Gruppenkarten werden geladen …</p>
                  ))}
                {auswahl.gruppen.length > 0 && (
                  <ul className="cal-einl-chips" aria-label="Ausgewählte Gruppenchats">
                    {auswahl.gruppen.map((id) => {
                      const gruppe = gruppenNachId.get(id);
                      if (!gruppe) return null;
                      const status = gruppenStatus(gruppe, auswahl.personen);
                      const steht = bestehendeGruppen?.includes(id) ?? false;
                      const aus = auswahl.postenAus.includes(id);
                      const kannPosten = status.vollstaendig || steht;
                      return (
                        <li
                          key={id}
                          className={`cal-einl-chip ${status.vollstaendig ? '' : 'is-unvollstaendig'}`}
                        >
                          <div className="cal-einl-chip-kopf">
                            <strong className="truncate">{gruppe.titel}</strong>
                            <span className="cal-einl-nutzer">
                              {status.eingeladen} von {status.gesamt} eingeladen
                            </span>
                            <button
                              type="button"
                              className="icon-btn"
                              aria-label={`Gruppenchat ${gruppe.titel} entfernen`}
                              title="Entfernen – die Personen bleiben gewählt"
                              onClick={() => onChange(gruppeEntfernen(auswahl, id))}
                            >
                              ✕
                            </button>
                          </div>
                          {steht && status.fehlen.length > 0 ? (
                            <p className="cal-hint">
                              {bestehendeKarteHinweis(status.fehlen, nameVon)}
                            </p>
                          ) : !status.vollstaendig ? (
                            <p className="cal-hint is-warnung">
                              {status.fehlen.map(nameVon).join(', ')}{' '}
                              {status.fehlen.length === 1 ? 'fehlt' : 'fehlen'} → hier wird nicht
                              gepostet
                            </p>
                          ) : steht ? (
                            <p className="cal-hint">Die Karte steht bereits in diesem Chat.</p>
                          ) : null}
                          <label className="cal-switch">
                            <span>Dort posten</span>
                            <input
                              type="checkbox"
                              role="switch"
                              aria-label={`Dort posten: ${gruppe.titel}`}
                              checked={kannPosten && !aus}
                              disabled={!kannPosten || !senden}
                              onChange={() => onChange(postenUmschalten(auswahl, id))}
                            />
                            <span className="cal-switch-track" aria-hidden="true" />
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {vorgeschlagen.length > 0 && (
                  <div className="cal-einl-vorschlaege">
                    {vorgeschlagen.map((gruppe) => (
                      <button
                        key={gruppe.id}
                        type="button"
                        className="cal-chip"
                        onClick={() => waehleGruppe(gruppe)}
                      >
                        ＋ Auch in „{gruppe.titel}“ posten
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}

          {!nurNeue && (
            <>
              <label className="cal-switch">
                <span>Einladung im Chat senden</span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={senden}
                  onChange={(wechsel) => onSenden(wechsel.target.checked)}
                />
                <span className="cal-switch-track" aria-hidden="true" />
              </label>
              {senden && (
                <label className="cal-switch cal-einl-unter">
                  <span>Einzelchats</span>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={einzelchats}
                    onChange={(wechsel) => onEinzelchats(wechsel.target.checked)}
                  />
                  <span className="cal-switch-track" aria-hidden="true" />
                </label>
              )}
            </>
          )}

          {/* Die Live-Region ist der Behälter, die Liste darin eine echte Liste:
              `role="status"` an der `ul` nähme den Einträgen ihren Listenkontext. */}
          <div
            className="cal-einl-vorschau"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            aria-label="Was mit der Einladung geschieht"
          >
            {zeilen.length + zusatzZeilen.length > 0 && (
              <ul>
                {[...zeilen, ...zusatzZeilen].map((zeile) => (
                  <li key={zeile}>{zeile}</li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </fieldset>
  );
}
