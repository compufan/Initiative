import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ATTACHMENT_KINDS,
  allowsLevel,
  formatBytes,
  type AttachmentDto,
  type AttachmentKind,
  type CollectionDto,
  type CollectionItemDto,
} from '@initiative/shared';
import { EmptyState, Spinner } from '../../components/Feedback.js';
import { Screen } from '../../components/Screen.js';
import { api } from '../../lib/api.js';
import { prepareImage, uploadBlob } from '../../lib/upload.js';
import { useListenfilter, type Facette } from '../../components/Listenfilter.js';
import { useNamen } from '../../state/leute.js';
import { useMyId } from '../../state/session.js';
import { toast } from '../../state/ui.js';
import { CollectionSheet } from './CollectionSheet.js';
import { UploadToCollectionSheet } from './UploadToCollectionSheet.js';
import { FileViewer } from './FileViewer.js';
import { DateiAktionen } from '../media/DateiAktionen.js';
import { ShareSheet } from './ShareSheet.js';
import { FernsehSheet } from '../fernseher/FernsehSheet.js';
import { CastKnopf } from '../fernseher/CastKnopf.js';
import { ConfirmDialog } from '../profile/ConfirmDialog.js';
import { miniaturSrc } from '../media/helpers.js';
import { useLongPress } from '../messenger/useLongPress.js';
import { pfadZu, useFiles } from './state.js';
import { MAX_KANTE } from '../bild/doc.js';

const ART_TEXT: Record<AttachmentKind, string> = {
  image: 'Bilder',
  video: 'Videos',
  audio: 'Ton',
  file: 'Dateien',
  sticker: 'Sticker',
};

/**
 * „Dateien“ – die Ordneransicht.
 *
 * Ein Bildschirm für beides: die oberste Ebene (ohne Kennung in der Adresse)
 * und ein geöffneter Ordner. Das spart eine zweite, fast gleiche Ansicht und
 * hält die Brotkrumen-Leiste an einer Stelle.
 */
export function DateienScreen() {
  const { collectionId } = useParams<{ collectionId?: string }>();
  const navigate = useNavigate();
  const myId = useMyId();

  const collections = useFiles((state) => state.collections);
  const status = useFiles((state) => state.status);
  const fehler = useFiles((state) => state.error);
  const [loeschFrage, setLoeschFrage] = useState(false);
  const [loeschtGerade, setLoeschtGerade] = useState(false);
  const alleItems = useFiles((state) => state.items);
  const geladen = useFiles((state) => state.loaded);
  const load = useFiles((state) => state.load);
  const loadItems = useFiles((state) => state.loadItems);

  const [neu, setNeu] = useState(false);
  const [hochladen, setHochladen] = useState(false);
  const [bearbeiten, setBearbeiten] = useState(false);
  const [teilen, setTeilen] = useState(false);
  const [fernseher, setFernseher] = useState(false);
  /**
   * Welche Datei im Betrachter offen ist – als Kennung, nicht als Platznummer.
   *
   * Eine Platznummer stimmte nur so lange, wie die Liste unveraendert bleibt.
   * Sobald gefiltert wird oder eine Datei dazukommt, zeigte sie auf etwas
   * anderes – und man tippt auf ein Foto und bekommt ein PDF. Mit der Kennung
   * schliesst sich der Betrachter von selbst, wenn die Datei aus der Auswahl
   * faellt.
   */
  const [betrachterId, setBetrachterId] = useState<string | null>(null);
  /**
   * Die Mehrfachauswahl – als Kennungen der EINTRÄGE, nicht der Anhänge.
   *
   * Dieselbe Datei kann zweimal in derselben Sammlung liegen (einmal aus dem
   * Chat, einmal direkt abgelegt). Mit Anhangskennungen liesse sich der eine
   * Eintrag nicht vom anderen unterscheiden, und „diesen hier löschen" träfe
   * beide.
   */
  const [auswahl, setAuswahl] = useState<string[]>([]);
  const [auswahlAktionen, setAuswahlAktionen] = useState(false);

  const aktuell = collectionId ? collections.find((entry) => entry.id === collectionId) : undefined;
  // Nicht als Selektor: `childrenOf` baut jedes Mal ein neues Feld, und zustand
  // haelt das fuer eine Aenderung – die Ansicht liefe endlos im Kreis und
  // bliebe leer. Deshalb aus `collections` ableiten, das sich wirklich nur
  // aendert, wenn es sich geaendert hat.
  const ordner = useMemo(
    () => useFiles.getState().childrenOf(collectionId ?? null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [collections, collectionId],
  );
  const items = collectionId ? (alleItems[collectionId] ?? []) : [];
  /*
   * Wie viel sich davon überhaupt auf einem Fernseher zeigen lässt.
   *
   * Ein Ordner mit Tonaufnahmen und PDFs bekommt keinen Fernsehknopf: Der
   * Server wiese die Liste ab („weder Fotos noch Videos"), und ein Knopf, der
   * zuverlässig eine Fehlermeldung ergibt, ist schlechter als keiner.
   */
  const zeigbareIds = items
    .filter((eintrag) => eintrag.attachment.kind === 'image' || eintrag.attachment.kind === 'video')
    .map((eintrag) => eintrag.attachment.id);
  const zeigbare = zeigbareIds.length;
  const inhaltGeladen = collectionId ? Boolean(geladen[collectionId]) : true;

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (collectionId) void loadItems(collectionId);
  }, [collectionId, loadItems]);

  const pfad = useMemo(
    () => (collectionId ? pfadZu(collections, collectionId) : []),
    [collections, collectionId],
  );

  // Wer eine Datei hinzugefuegt hat, steht nur als Kennung am Eintrag.
  const namen = useNamen(
    items.map((item) => item.addedBy),
    myId,
  );

  const facetten: Facette<CollectionItemDto>[] = useMemo(
    () => [
      {
        key: 'art',
        label: 'Art',
        reihenfolge: [...ATTACHMENT_KINDS],
        werte: (item) => [{ id: item.attachment.kind, label: ART_TEXT[item.attachment.kind] }],
      },
      {
        key: 'herkunft',
        label: 'Herkunft',
        reihenfolge: ['chat', 'direkt'],
        werte: (item) => [
          item.messageId
            ? { id: 'chat', label: 'Aus dem Chat' }
            : { id: 'direkt', label: 'Direkt abgelegt' },
        ],
      },
      {
        key: 'von',
        label: 'Hinzugefügt von',
        werte: (item) => (item.addedBy ? [{ id: item.addedBy, label: namen(item.addedBy) }] : []),
      },
    ],
    [namen],
  );

  const filter = useListenfilter(items, {
    suchePlatzhalter: 'Datei suchen …',
    suchtext: (item) => `${item.title ?? ''} ${item.attachment.fileName ?? ''} ${item.note ?? ''}`,
    facetten,
  });

  /*
   * Jeder Ordner geht ungefiltert auf.
   *
   * Beide Routen zeigen dieselbe Komponenteninstanz (App.tsx setzt keinen
   * `key`), also überlebte der Filterzustand den Ordnerwechsel: Man suchte in
   * einem Ordner nach „Vertrag“, ging eine Ebene tiefer – und der neue Ordner
   * sah leer aus. Die Filterleiste erscheint zudem erst ab zwei Dateien, der
   * Grund war also unter Umständen gar nicht zu sehen.
   *
   * Die Rücksetzfunktion wird über eine Referenz gelesen: Sie entsteht bei
   * jedem Bild neu, im Abhängigkeitsfeld liefe der Effekt dauernd.
   */
  const zuruecksetzenRef = useRef(filter.zuruecksetzen);
  zuruecksetzenRef.current = filter.zuruecksetzen;
  useEffect(() => {
    zuruecksetzenRef.current();
    // Eine Auswahl aus dem vorigen Ordner gilt hier nicht mehr. Ohne das
    // stünde „3 ausgewählt" über einem Ordner, in dem keine dieser Dateien
    // liegt.
    setAuswahl([]);
  }, [collectionId]);

  // Der Betrachter haengt an einem Index – und zwar in GENAU der Liste, die
  // gerade gezeigt wird. Kaeme er aus `items` und die Kacheln aus der
  // gefilterten Liste, oeffnete ein Tipp die falsche Datei.
  const sichtbar = filter.gefiltert;
  const anhaenge: AttachmentDto[] = sichtbar.map((item) => item.attachment);
  const betrachterIndex = betrachterId
    ? sichtbar.findIndex((item) => item.id === betrachterId)
    : -1;
  const darfAendern = aktuell ? allowsLevel(aktuell.myLevel, 'edit') : true;
  const darfBesitzen = aktuell ? allowsLevel(aktuell.myLevel, 'own') : false;

  /*
   * Die Auswahl, aber nur, was auch wirklich noch da ist.
   *
   * Zwischen dem Antippen und dem Handeln kann gefiltert, gelöscht oder neu
   * geladen worden sein. Ohne diesen Abgleich stünde „5 ausgewählt" über drei
   * Kacheln, und die Sammelaktion arbeitete auf Kennungen ins Leere.
   */
  const gewaehlt = useMemo(
    () => sichtbar.filter((item) => auswahl.includes(item.id)),
    [sichtbar, auswahl],
  );
  const auswahlAktiv = gewaehlt.length > 0;

  function auswahlUmschalten(itemId: string) {
    setAuswahl((liste) =>
      liste.includes(itemId) ? liste.filter((wert) => wert !== itemId) : [...liste, itemId],
    );
  }

  /** Alle ausgewählten Einträge entfernen – nacheinander, damit ein Fehler den Rest nicht mitnimmt. */
  async function gewaehlteEntfernen() {
    if (!collectionId) return;
    let weg = 0;
    const gescheitert: string[] = [];
    for (const item of gewaehlt) {
      try {
        await api.collections.removeItem(collectionId, item.id);
        weg += 1;
      } catch {
        gescheitert.push(item.title ?? item.attachment.fileName ?? 'Datei');
      }
    }
    await useFiles.getState().loadItems(collectionId, true);
    setAuswahl([]);
    if (gescheitert.length > 0) {
      toast(`${weg} entfernt, ${gescheitert.length} nicht: ${gescheitert.join(', ')}`, 'error');
    } else {
      toast(weg === 1 ? 'Entfernt.' : `${weg} Dateien entfernt.`, 'success');
    }
  }

  /**
   * Einen einzelnen Eintrag entfernen – aus dem Betrachter heraus.
   *
   * Sucht über den ANHANG, weil der Betrachter nur Anhänge kennt: Er bekommt
   * `AttachmentDto[]`, keine Sammlungseinträge.
   */
  async function eintragEntfernen(anhangId: string) {
    if (!collectionId) return;
    const eintrag = items.find((wert) => wert.attachment.id === anhangId);
    if (!eintrag) return;
    await api.collections.removeItem(collectionId, eintrag.id);
    await useFiles.getState().loadItems(collectionId, true);
  }

  /**
   * Eine Sammlung löschen – mit Rückfrage und gegen Doppeltippen gesperrt.
   *
   * Vorher lag das auf einem einzigen Tipp, unmittelbar neben „Bearbeiten“,
   * und es gibt kein Rückgängig. Überall sonst in dieser App steht vor dem
   * Löschen ein zweiter Schritt; hier fehlte er als einziger.
   */
  async function loeschen() {
    if (!aktuell || loeschtGerade) return;
    setLoeschtGerade(true);
    try {
      await api.collections.remove(aktuell.id);
      useFiles.getState().forget(aktuell.id);
      setLoeschFrage(false);
      toast('Sammlung gelöscht. Die Dateien selbst bleiben im Chat.');
      navigate(aktuell.parentId ? `/dateien/${aktuell.parentId}` : '/dateien');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Löschen fehlgeschlagen', 'error');
    } finally {
      setLoeschtGerade(false);
    }
  }

  const laedtNoch = status === 'loading' && collections.length === 0;

  return (
    <Screen
      title={aktuell?.name ?? 'Dateien'}
      subtitle={
        aktuell?.description ??
        (collectionId ? undefined : 'Ordner und Dateien, geteilt mit wem du willst')
      }
      back={
        collectionId ? (aktuell?.parentId ? `/dateien/${aktuell.parentId}` : '/dateien') : false
      }
      actions={
        darfAendern && (
          <>
            {/* Der Weg, der bisher ganz fehlte: eine Datei direkt hierher
                legen, ohne sie vorher durch einen Chat zu schicken. */}
            {collectionId && (
              <button
                type="button"
                className="icon-btn"
                aria-label="Dateien hinzufügen"
                title="Dateien hinzufügen"
                onClick={() => setHochladen(true)}
              >
                ⬆️
              </button>
            )}
            <button
              type="button"
              className="icon-btn"
              aria-label="Neue Sammlung"
              onClick={() => setNeu(true)}
            >
              ＋
            </button>
          </>
        )
      }
    >
      {pfad.length > 1 && (
        <nav className="fil-breadcrumb" aria-label="Pfad">
          <button type="button" className="fil-crumb" onClick={() => navigate('/dateien')}>
            Alle
          </button>
          {pfad.map((eintrag, index) => (
            <span key={eintrag.id} className="fil-crumb-wrap">
              <span aria-hidden="true">›</span>
              {index === pfad.length - 1 ? (
                <span className="fil-crumb fil-crumb-current">{eintrag.name}</span>
              ) : (
                <button
                  type="button"
                  className="fil-crumb"
                  onClick={() => navigate(`/dateien/${eintrag.id}`)}
                >
                  {eintrag.name}
                </button>
              )}
            </span>
          ))}
        </nav>
      )}

      {aktuell && (
        <div className="fil-toolbar">
          <span className="fil-badge">{RECHT_TEXT[aktuell.myLevel]}</span>
          {/*
           * Auch für den, der nur ansehen darf: Etwas auf dem eigenen
           * Fernseher zu zeigen ist Ansehen, nicht Ändern.
           */}
          {aktuell.myLevel !== 'none' && zeigbare > 0 && (
            <>
              {/*
                Zwei Wege nebeneinander, und das ist Absicht.

                Der Cast-Knopf ist der kurze: ein Fingertipp, Geräteliste von
                Chrome, los. Er erscheint nur dort, wo es ihn gibt – Chrome
                und Edge, https, ein Gerät in Reichweite.

                „Auf den Fernseher“ daneben ist der lange und der
                verlässlichere: Er braucht kein Chromecast, läuft in jedem
                Browser, zeigt Bilder in voller Grösse und läuft weiter, wenn
                das Telefon in der Tasche steckt. Wer beides hat, soll wählen
                können; wer nur eines hat, sieht nur eines.
              */}
              <CastKnopf stuecke={zeigbareIds} sekunden={8} was={aktuell.name} modusWahl />
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setFernseher(true)}
                data-tipp="Diese Sammlung als Diashow auf einem Fernseher zeigen – auch ohne Chromecast"
              >
                📺 Auf den Fernseher
              </button>
            </>
          )}
          {darfBesitzen && (
            <>
              <button type="button" className="btn btn-sm" onClick={() => setTeilen(true)}>
                Teilen
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setBearbeiten(true)}>
                Bearbeiten
              </button>
              <button
                type="button"
                className="btn btn-sm btn-danger"
                onClick={() => setLoeschFrage(true)}
                data-tipp="Diese Sammlung entfernen – die Dateien bleiben im Chat"
              >
                Löschen
              </button>
            </>
          )}
          {!darfBesitzen && aktuell.myLevel !== 'none' && (
            <button type="button" className="btn btn-sm" onClick={() => setTeilen(true)}>
              Wer hat Zugriff?
            </button>
          )}
        </div>
      )}

      {/*
        Früher stand hier zusätzlich `status === 'error'`. Damit blieb ein
        gescheitertes Laden des ORDNERINHALTS stumm: `loadItems` setzt nur
        `error`, nicht `status`. Sichtbar war das als Ladeanzeige, die sich
        endlos dreht und nie sagt, was los ist.
      */}
      {fehler && (
        <p className="fil-hint fil-hint-warn" role="status">
          {fehler}
        </p>
      )}

      {laedtNoch ? (
        <Spinner label="Sammlungen werden geladen …" />
      ) : ordner.length === 0 && items.length === 0 && inhaltGeladen ? (
        <EmptyState
          emoji="📁"
          title={collectionId ? 'Noch nichts drin' : 'Noch keine Sammlung'}
          description={
            collectionId
              ? 'Lade Dateien direkt hoch – oder tippe im Chat eine Nachricht lange an und wähle „Zur Sammlung hinzufügen“.'
              : 'Leg eine Sammlung an. Dateien kommen dann direkt hinein oder aus einem Chat dazu.'
          }
          action={
            collectionId && darfAendern ? (
              <button type="button" className="btn btn-primary" onClick={() => setHochladen(true)}>
                Dateien hinzufügen
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="stack">
          {ordner.length > 0 && (
            <ul className="list">
              {ordner.map((eintrag) => (
                <li key={eintrag.id}>
                  <button
                    type="button"
                    className="list-row"
                    onClick={() => navigate(`/dateien/${eintrag.id}`)}
                  >
                    <span aria-hidden="true">📁</span>
                    <span className="truncate">{eintrag.name}</span>
                    <span className="fil-meta">
                      {eintrag.itemCount === 1 ? '1 Datei' : `${eintrag.itemCount} Dateien`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {collectionId && !inhaltGeladen && !fehler && <Spinner label="Inhalt wird geladen …" />}

          {items.length > 1 && !auswahlAktiv && filter.steuerung}

          {/*
            Die Auswahlleiste ersetzt die Filterleiste, statt sich darunter zu
            schieben. Beides zugleich wären zwei Werkzeugleisten übereinander
            auf einem Telefon – und filtern will hier gerade niemand.
          */}
          {auswahlAktiv && (
            <div className="fil-toolbar fil-auswahlleiste" role="status">
              <strong>{gewaehlt.length} ausgewählt</strong>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setAuswahl(sichtbar.map((item) => item.id))}
              >
                Alle
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setAuswahl([])}>
                Aufheben
              </button>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => setAuswahlAktionen(true)}
              >
                ⋯ Aktionen
              </button>
            </div>
          )}

          {sichtbar.length > 0 && (
            <ul className="fil-grid">
              {sichtbar.map((item) => (
                <DateiKachel
                  key={item.id}
                  item={item}
                  collectionId={collectionId!}
                  ausgewaehlt={auswahl.includes(item.id)}
                  auswahlAktiv={auswahlAktiv}
                  onWaehlen={() => auswahlUmschalten(item.id)}
                  onOpen={() => setBetrachterId(item.id)}
                />
              ))}
            </ul>
          )}

          {items.length > 0 && sichtbar.length === 0 && (
            <p className="fil-hint">
              Nichts gefunden.{' '}
              <button type="button" className="btn btn-sm" onClick={filter.zuruecksetzen}>
                Filter zurücksetzen
              </button>
            </p>
          )}
        </div>
      )}

      {collectionId && (
        <UploadToCollectionSheet
          open={hochladen}
          onClose={() => setHochladen(false)}
          collectionId={collectionId}
        />
      )}

      <CollectionSheet
        open={neu}
        onClose={() => setNeu(false)}
        parentId={collectionId ?? null}
        conversationId={aktuell?.conversationId ?? null}
        onSaved={(collection) => navigate(`/dateien/${collection.id}`)}
      />
      {aktuell && (
        <CollectionSheet
          key={`bearbeiten-${aktuell.updatedAt}`}
          open={bearbeiten}
          onClose={() => setBearbeiten(false)}
          collection={aktuell}
        />
      )}
      {aktuell && teilen && (
        <ShareSheet open={teilen} onClose={() => setTeilen(false)} collection={aktuell} />
      )}
      {aktuell && fernseher && (
        <FernsehSheet
          open={fernseher}
          onClose={() => setFernseher(false)}
          collection={aktuell}
          titel={`„${aktuell.name}“ auf den Fernseher`}
        />
      )}

      {aktuell && (
        <ConfirmDialog
          open={loeschFrage}
          title={`„${aktuell.name}“ löschen?`}
          description="Der Ordner samt seiner Einträge verschwindet. Die Dateien selbst bleiben im Chat, in dem sie geschickt wurden – und lassen sich von dort wieder ablegen."
          confirmLabel="Löschen"
          danger
          busy={loeschtGerade}
          onCancel={() => setLoeschFrage(false)}
          onConfirm={() => void loeschen()}
        />
      )}
      {collectionId && (
        <DateiAktionen
          open={auswahlAktionen}
          onClose={() => setAuswahlAktionen(false)}
          anhaenge={gewaehlt.map((item) => item.attachment)}
          loeschen={darfAendern ? gewaehlteEntfernen : undefined}
          loeschText={
            gewaehlt.every((item) => item.messageId)
              ? 'Die Dateien bleiben in den Chats, aus denen sie kommen – sie sind nur nicht mehr in dieser Sammlung.'
              : 'Ein Teil davon wurde direkt hier abgelegt und liegt in keinem Chat. Diese Dateien sind danach nicht mehr erreichbar.'
          }
          onGeaendert={() => void loadItems(collectionId, true)}
        />
      )}

      {betrachterIndex >= 0 && (
        <FileViewer
          items={anhaenge}
          index={betrachterIndex}
          onClose={() => setBetrachterId(null)}
          zielName={darfAendern ? 'In die Sammlung' : undefined}
          aktionen={
            collectionId
              ? {
                  loeschen: darfAendern ? (datei) => eintragEntfernen(datei.id) : undefined,
                  loeschText: (datei) =>
                    items.find((item) => item.attachment.id === datei.id)?.messageId
                      ? 'Die Datei bleibt im Chat, aus dem sie kommt – sie ist nur nicht mehr in dieser Sammlung.'
                      : 'Diese Datei wurde direkt hier abgelegt und liegt in keinem Chat. Nach dem Entfernen ist sie nicht mehr erreichbar.',
                  onGeaendert: () => void loadItems(collectionId, true),
                }
              : undefined
          }
          ablegen={
            darfAendern && aktuell
              ? async (blob, name) => {
                  // Die bearbeitete Fassung kommt als eigener Eintrag dazu; das
                  // Original bleibt unberuehrt daneben stehen.
                  // `MAX_KANTE`, nicht 1920: Was der Editor ausgibt, geht in seiner
                  // vollen Kante weiter. (Das Argument stand vorher auf 1920 und
                  // wurde von `fertig` stillschweigend übergangen – jetzt gilt es,
                  // also muss hier stehen, was wirklich gemeint ist.)
                  const bild = await prepareImage(blob, MAX_KANTE, true);
                  const anhang = await uploadBlob({
                    kind: 'image',
                    mime: bild.mime,
                    fileName: name,
                    blob: bild.blob,
                    width: bild.width,
                    height: bild.height,
                    previewDataUrl: bild.previewDataUrl,
                  });
                  await api.collections.addItem(aktuell.id, {
                    attachmentId: anhang.id,
                    title: name,
                  });
                  await useFiles.getState().loadItems(aktuell.id, true);
                  toast('Bearbeitete Fassung hinzugefügt.', 'success');
                }
              : undefined
          }
        />
      )}
    </Screen>
  );
}

const RECHT_TEXT: Record<CollectionDto['myLevel'], string> = {
  none: 'kein Zugriff',
  view: 'nur ansehen',
  edit: 'ansehen und ändern',
  own: 'gehört dir',
};

const SYMBOLE: Record<string, string> = {
  image: '🖼️',
  video: '🎬',
  audio: '🎵',
  file: '📄',
  sticker: '🌟',
};

/**
 * Das Bild einer Kachel – erst der Klecks, dann das Miniaturbild.
 *
 * Die eingebettete Vorschau steht sofort da (sie liegt schon in der Liste),
 * das Miniaturbild vom Server wird darüber eingeblendet. Ohne den Klecks
 * darunter blitzte beim Blättern eine leere Fläche auf; ohne das Miniaturbild
 * bliebe es bei 160 Punkten, und das ist auf einer Kachel eines Tablets
 * sichtbar zu wenig.
 *
 * `loading="lazy"`: In einem Ordner mit vierzig Dateien sind höchstens sechs
 * zu sehen. Ohne das holte der Browser alle vierzig.
 *
 * Schlägt das Miniaturbild fehl – ein Video, ein HEIC vom iPhone, eine PDF –,
 * bleibt der Klecks stehen beziehungsweise das Symbol. Das ist die richtige
 * Antwort und kein Fehler: Für diese Typen kann der Server keines rechnen.
 */
function Kachelbild({ attachment }: { attachment: AttachmentDto }) {
  const [da, setDa] = useState(false);
  const [kaputt, setKaputt] = useState(false);
  const bildhaft = attachment.kind === 'image' || attachment.kind === 'sticker';

  if (!attachment.previewDataUrl && !bildhaft) {
    return (
      <span className="fil-thumb fil-thumb-icon" aria-hidden="true">
        {SYMBOLE[attachment.kind] ?? '📄'}
      </span>
    );
  }

  return (
    <span className="fil-thumb-stapel">
      {attachment.previewDataUrl && (
        <img className="fil-thumb fil-thumb-klecks" src={attachment.previewDataUrl} alt="" />
      )}
      {bildhaft && !kaputt && (
        <img
          className={da ? 'fil-thumb is-da' : 'fil-thumb'}
          src={miniaturSrc(attachment, 160)}
          alt=""
          loading="lazy"
          decoding="async"
          onLoad={() => setDa(true)}
          onError={() => setKaputt(true)}
        />
      )}
      {!attachment.previewDataUrl && !da && (
        <span className="fil-thumb fil-thumb-icon" aria-hidden="true">
          {SYMBOLE[attachment.kind] ?? '📄'}
        </span>
      )}
    </span>
  );
}

/**
 * Eine Kachel – und der Einstieg in die Mehrfachauswahl.
 *
 * Langes Drücken wählt aus, wie überall sonst in dieser App (im Chat öffnet
 * es das Nachrichtenmenü, hier die Auswahl). Solange etwas ausgewählt ist,
 * wählt ein kurzer Tipp weiter aus, statt die Datei zu öffnen – sonst müsste
 * man zwischen zwei Dateien jedes Mal den Betrachter wegklicken.
 */
function DateiKachel({
  item,
  collectionId,
  ausgewaehlt,
  auswahlAktiv,
  onWaehlen,
  onOpen,
}: {
  item: CollectionItemDto;
  collectionId: string;
  ausgewaehlt: boolean;
  auswahlAktiv: boolean;
  onWaehlen: () => void;
  onOpen: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [frage, setFrage] = useState(false);
  const darfAendern = allowsLevel(item.myLevel, 'edit');
  const name = item.title ?? item.attachment.fileName ?? 'Datei';
  /*
   * Langes Drücken UND der Klick danach – das ist ein Ereignis zu viel.
   *
   * `useLongPress` schlägt nach 450 ms zu, der Finger liegt aber noch auf der
   * Kachel. Beim Loslassen feuert der Browser zusätzlich ein `click`, und der
   * traf hier denselben Knopf: Die Auswahl ging auf, und im selben Atemzug
   * wieder zu. Sichtbar war davon nichts – man drückte lange und es geschah
   * scheinbar gar nichts.
   *
   * Im Chat fällt das nicht auf, weil dort ein Blatt aufgeht und der Klick auf
   * dessen Hintergrund landet. Hier bleibt die Kachel, wo sie ist.
   *
   * Zurückgesetzt wird beim nächsten Zeigerdruck und nicht nach dem Klick:
   * Über das Kontextmenü (rechte Maustaste) folgt gar kein Klick, und eine
   * Sperre, die dann liegen bliebe, frässe den nächsten echten Tipp.
   */
  const langGedrueckt = useRef(false);
  const roh = useLongPress(() => {
    langGedrueckt.current = true;
    onWaehlen();
  });
  const langdruck = {
    ...roh,
    onPointerDown(event: ReactPointerEvent) {
      langGedrueckt.current = false;
      roh.onPointerDown(event);
    },
  };

  async function entfernen() {
    setBusy(true);
    setFrage(false);
    try {
      await api.collections.removeItem(collectionId, item.id);
      await useFiles.getState().loadItems(collectionId, true);
      toast(`„${name}“ entfernt.`, 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Entfernen fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={ausgewaehlt ? 'fil-tile is-gewaehlt' : 'fil-tile'}>
      <button
        type="button"
        className="fil-tile-open"
        aria-pressed={auswahlAktiv ? ausgewaehlt : undefined}
        onClick={() => {
          if (langGedrueckt.current) return;
          if (auswahlAktiv) onWaehlen();
          else onOpen();
        }}
        {...langdruck}
      >
        <Kachelbild attachment={item.attachment} />
        <span className="fil-tile-name truncate">{name}</span>
        <span className="fil-meta">
          {formatBytes(item.attachment.size)}
          {/*
            Ein ausgelagertes Foto lädt beim ersten Mal länger. Das hier ist
            der Unterschied zwischen „langsam" und „langsam, weil es dort
            liegt" – und damit zwischen kaputt und erklärt.
          */}
          {item.attachment.ablage === 'fern' && (
            <span data-tipp="Liegt auf dem grossen Speicher – das erste Laden dauert einen Moment länger.">
              {' '}
              ☁️
            </span>
          )}
        </span>
      </button>
      {auswahlAktiv && (
        <span className="fil-tile-haken" aria-hidden="true">
          {ausgewaehlt ? '☑️' : '⬜'}
        </span>
      )}
      {/*
          Das ✕ fragt nach.

          Es sitzt 26 × 26 Pixel gross direkt auf dem Vorschaubild – also
          genau dort, wohin der Daumen beim Öffnen der Datei geht – und
          entfernte den Eintrag ohne Rückfrage, ohne Meldung und ohne
          Rückgängig. Überall sonst in dieser App steht vor dem Entfernen ein
          zweiter Schritt.
      */}
      {darfAendern && !auswahlAktiv && (
        <button
          type="button"
          className="fil-tile-remove"
          aria-label={`„${name}“ aus der Sammlung entfernen`}
          data-tipp={
            item.messageId
              ? 'Nimmt die Datei aus dieser Sammlung – im Chat bleibt sie stehen'
              : 'Diese Datei liegt nur hier – nach dem Entfernen ist sie fort'
          }
          disabled={busy}
          onClick={() => setFrage(true)}
        >
          ✕
        </button>
      )}
      {frage && (
        <ConfirmDialog
          open
          title={`„${name}“ entfernen?`}
          /*
              Zwei Herkünfte, zwei Wahrheiten.

              Hier stand für jede Datei „Die Datei bleibt dort, wo sie
              herkommt". Für eine über „Dateien hinzufügen" direkt abgelegte
              Datei stimmt das nicht: Sie hängt an keiner Nachricht, dieser
              Eintrag ist ihr einziger Ort, und nach dem Entfernen ist sie
              nicht mehr erreichbar. Derselbe Bildschirm unterscheidet die
              beiden Fälle im Filter „Herkunft" längst.
          */
          description={
            item.messageId
              ? 'Die Datei bleibt im Chat, aus dem sie kommt – sie ist nur nicht mehr in dieser Sammlung.'
              : 'Diese Datei wurde direkt hier abgelegt und liegt in keinem Chat. Nach dem Entfernen ist sie nicht mehr erreichbar.'
          }
          confirmLabel="Entfernen"
          danger
          busy={busy}
          onCancel={() => setFrage(false)}
          onConfirm={() => void entfernen()}
        />
      )}
    </li>
  );
}
