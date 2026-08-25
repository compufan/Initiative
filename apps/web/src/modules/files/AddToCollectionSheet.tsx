import { useEffect, useMemo, useState } from 'react';
import { allowsLevel, type AttachmentDto } from '@initiative/shared';
import { Sheet } from '../../components/Sheet.js';
import { Spinner } from '../../components/Feedback.js';
import { api } from '../../lib/api.js';
import { toast } from '../../state/ui.js';
import type { MessageActionProps } from '../types.js';
import { CollectionSheet } from './CollectionSheet.js';
import { useFiles } from './state.js';

/**
 * „Zur Sammlung hinzufügen“ – aus dem Chat heraus, für alle im Chat.
 *
 * Es wird nichts noch einmal hochgeladen: Die Datei liegt bereits als Anhang
 * auf dem Server, sie bekommt hier nur einen zweiten Platz. Deshalb geht das
 * auch mit einer Datei, die jemand anderes geschickt hat.
 */
export function AddToCollectionSheet({ message, conversation, onClose }: MessageActionProps) {
  const collections = useFiles((state) => state.collections);
  const load = useFiles((state) => state.load);
  const status = useFiles((state) => state.status);
  const [busy, setBusy] = useState<string | null>(null);
  const [neu, setNeu] = useState(false);
  const [erledigt, setErledigt] = useState<string[]>([]);

  const anhaenge: AttachmentDto[] = message.attachments;

  useEffect(() => {
    void load();
  }, [load]);

  // Nur Ordner, in die man auch etwas legen darf. Ein Ordner, den man nur
  // ansehen darf, gehört hier nicht in die Liste – der Server lehnte ab, und
  // der Anwender hätte den Knopf umsonst gedrückt.
  const moeglich = useMemo(
    () =>
      collections
        .filter((collection) => allowsLevel(collection.myLevel, 'edit'))
        .sort((a, b) => {
          // Sammlungen aus genau diesem Chat zuerst – das ist fast immer die
          // gemeinte.
          const aHier = a.conversationId === conversation?.id ? 0 : 1;
          const bHier = b.conversationId === conversation?.id ? 0 : 1;
          return aHier - bHier || a.name.localeCompare(b.name, 'de');
        }),
    [collections, conversation?.id],
  );

  async function hinzufuegen(collectionId: string) {
    setBusy(collectionId);
    try {
      for (const anhang of anhaenge) {
        await api.collections.addItem(collectionId, {
          attachmentId: anhang.id,
          messageId: message.id,
        });
      }
      // Der Inhalt dieses Ordners ist jetzt veraltet.
      await useFiles.getState().loadItems(collectionId, true);
      setErledigt((liste) => [...liste, collectionId]);
      toast(
        anhaenge.length === 1
          ? 'Zur Sammlung hinzugefügt.'
          : `${anhaenge.length} Dateien hinzugefügt.`,
      );
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Hinzufügen fehlgeschlagen');
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <Sheet open={!neu} onClose={onClose} title="Zur Sammlung hinzufügen">
        <div className="stack">
          <p className="fil-hint">
            {anhaenge.length === 1
              ? 'Diese Datei bekommt einen zweiten Platz – im Chat bleibt sie stehen.'
              : `${anhaenge.length} Dateien bekommen einen zweiten Platz – im Chat bleiben sie stehen.`}
          </p>

          <button type="button" className="list-row" onClick={() => setNeu(true)}>
            <span aria-hidden="true">➕</span>
            <span>Neue Sammlung anlegen</span>
          </button>

          {status === 'loading' && collections.length === 0 ? (
            <Spinner label="Sammlungen werden geladen …" />
          ) : moeglich.length === 0 ? (
            <p className="fil-hint">
              Es gibt noch keine Sammlung, in die du etwas legen darfst. Leg oben eine an.
            </p>
          ) : (
            <ul className="list">
              {moeglich.map((collection) => (
                <li key={collection.id}>
                  <button
                    type="button"
                    className="list-row"
                    disabled={busy != null}
                    onClick={() => void hinzufuegen(collection.id)}
                  >
                    <span aria-hidden="true">
                      {erledigt.includes(collection.id) ? '✅' : '📁'}
                    </span>
                    <span className="truncate">
                      {collection.name}
                      {collection.conversationId === conversation?.id && (
                        <span className="fil-badge">aus diesem Chat</span>
                      )}
                    </span>
                    {busy === collection.id && <span className="fil-meta">…</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Sheet>

      <CollectionSheet
        open={neu}
        onClose={() => setNeu(false)}
        conversationId={conversation?.id ?? null}
        onSaved={(collection) => void hinzufuegen(collection.id)}
      />
    </>
  );
}
