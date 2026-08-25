import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  allowsLevel,
  formatBytes,
  type AttachmentDto,
  type CollectionDto,
  type CollectionItemDto,
} from '@initiative/shared';
import { EmptyState, Spinner } from '../../components/Feedback.js';
import { Screen } from '../../components/Screen.js';
import { api } from '../../lib/api.js';
import { toast } from '../../state/ui.js';
import { CollectionSheet } from './CollectionSheet.js';
import { FileViewer } from './FileViewer.js';
import { ShareSheet } from './ShareSheet.js';
import { pfadZu, useFiles } from './state.js';

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

  const collections = useFiles((state) => state.collections);
  const status = useFiles((state) => state.status);
  const fehler = useFiles((state) => state.error);
  const alleItems = useFiles((state) => state.items);
  const geladen = useFiles((state) => state.loaded);
  const load = useFiles((state) => state.load);
  const loadItems = useFiles((state) => state.loadItems);

  const [neu, setNeu] = useState(false);
  const [bearbeiten, setBearbeiten] = useState(false);
  const [teilen, setTeilen] = useState(false);
  const [betrachter, setBetrachter] = useState<number | null>(null);

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

  const anhaenge: AttachmentDto[] = items.map((item) => item.attachment);
  const darfAendern = aktuell ? allowsLevel(aktuell.myLevel, 'edit') : true;
  const darfBesitzen = aktuell ? allowsLevel(aktuell.myLevel, 'own') : false;

  async function loeschen() {
    if (!aktuell) return;
    try {
      await api.collections.remove(aktuell.id);
      useFiles.getState().forget(aktuell.id);
      toast('Sammlung gelöscht. Die Dateien selbst bleiben im Chat.');
      navigate(aktuell.parentId ? `/dateien/${aktuell.parentId}` : '/dateien');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Löschen fehlgeschlagen');
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
      back={collectionId ? (aktuell?.parentId ? `/dateien/${aktuell.parentId}` : '/dateien') : false}
      actions={
        darfAendern && (
          <button
            type="button"
            className="icon-btn"
            aria-label="Neue Sammlung"
            onClick={() => setNeu(true)}
          >
            ＋
          </button>
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
          {darfBesitzen && (
            <>
              <button type="button" className="btn btn-sm" onClick={() => setTeilen(true)}>
                Teilen
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setBearbeiten(true)}>
                Bearbeiten
              </button>
              <button type="button" className="btn btn-sm btn-danger" onClick={() => void loeschen()}>
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

      {fehler && status === 'error' && (
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
              ? 'Dateien kommen aus dem Chat hierher: Nachricht lange antippen → „Zur Sammlung hinzufügen“.'
              : 'Leg eine Sammlung an – oder tippe im Chat eine Datei lange an und wähle „Zur Sammlung hinzufügen“.'
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

          {collectionId && !inhaltGeladen && <Spinner label="Inhalt wird geladen …" />}

          {items.length > 0 && (
            <ul className="fil-grid">
              {items.map((item, index) => (
                <DateiKachel
                  key={item.id}
                  item={item}
                  collectionId={collectionId!}
                  onOpen={() => setBetrachter(index)}
                />
              ))}
            </ul>
          )}
        </div>
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
      {betrachter != null && anhaenge.length > 0 && (
        <FileViewer items={anhaenge} index={betrachter} onClose={() => setBetrachter(null)} />
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

function DateiKachel({
  item,
  collectionId,
  onOpen,
}: {
  item: CollectionItemDto;
  collectionId: string;
  onOpen: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const darfAendern = allowsLevel(item.myLevel, 'edit');
  const name = item.title ?? item.attachment.fileName ?? 'Datei';

  async function entfernen() {
    setBusy(true);
    try {
      await api.collections.removeItem(collectionId, item.id);
      await useFiles.getState().loadItems(collectionId, true);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Entfernen fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="fil-tile">
      <button type="button" className="fil-tile-open" onClick={onOpen}>
        {item.attachment.previewDataUrl ? (
          <img className="fil-thumb" src={item.attachment.previewDataUrl} alt="" />
        ) : (
          <span className="fil-thumb fil-thumb-icon" aria-hidden="true">
            {SYMBOLE[item.attachment.kind] ?? '📄'}
          </span>
        )}
        <span className="fil-tile-name truncate">{name}</span>
        <span className="fil-meta">{formatBytes(item.attachment.size)}</span>
      </button>
      {darfAendern && (
        <button
          type="button"
          className="fil-tile-remove"
          aria-label={`„${name}“ aus der Sammlung entfernen`}
          disabled={busy}
          onClick={() => void entfernen()}
        >
          ✕
        </button>
      )}
    </li>
  );
}
