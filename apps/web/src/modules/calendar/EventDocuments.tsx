import { useEffect, useRef, useState } from 'react';
import { formatBytes, type EventAttachmentDto } from '@initiative/shared';
import { Spinner } from '../../components/Feedback.js';
import { api } from '../../lib/api.js';
import { toast } from '../../state/ui.js';
import { FileViewer } from '../files/FileViewer.js';
import { uploadBlob } from '../../lib/upload.js';
import { kindForFile, mimeForFile, withinUploadLimit } from '../media/helpers.js';

interface EventDocumentsProps {
  eventId: string;
}

/**
 * Dokumente am Termin: die Einladung als PDF, die Anfahrtsskizze, die
 * Speisekarte.
 *
 * Betrachtet wird alles mit demselben Betrachter wie in „Dateien“ – ein
 * zweiter Bildschirm für dieselbe Aufgabe wäre eine zweite Stelle, an der
 * sich Fehler einnisten.
 */
export function EventDocuments({ eventId }: EventDocumentsProps) {
  const [items, setItems] = useState<EventAttachmentDto[]>([]);
  const [laedt, setLaedt] = useState(true);
  const [busy, setBusy] = useState(false);
  const [betrachter, setBetrachter] = useState<number | null>(null);
  const dateiFeld = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let abgebrochen = false;
    setLaedt(true);
    void api.calendar
      .documents(eventId)
      .then((ergebnis) => {
        if (!abgebrochen) setItems(ergebnis.items);
      })
      .catch((error: unknown) => {
        if (!abgebrochen) toast(error instanceof Error ? error.message : 'Dokumente nicht ladbar');
      })
      .finally(() => {
        if (!abgebrochen) setLaedt(false);
      });
    return () => {
      abgebrochen = true;
    };
  }, [eventId]);

  async function hochladen(datei: File) {
    // Ein Dokument am Termin geht nicht durch die Outbox: die gehört zum
    // Chat, hier gibt es keine Nachricht, an der es hängen könnte.
    const kind = kindForFile(datei);
    // `withinUploadLimit` meldet selbst, wenn die Datei zu gross ist.
    if (!withinUploadLimit(kind, datei.size, datei.name)) return;
    setBusy(true);
    try {
      const attachment = await uploadBlob({
        kind,
        mime: mimeForFile(datei),
        fileName: datei.name,
        blob: datei,
      });
      const dokument = await api.calendar.addDocument(eventId, {
        attachmentId: attachment.id,
        title: datei.name,
      });
      setItems((liste) => [...liste, dokument]);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Hochladen fehlgeschlagen');
    } finally {
      setBusy(false);
      if (dateiFeld.current) dateiFeld.current.value = '';
    }
  }

  async function entfernen(id: string) {
    try {
      await api.calendar.removeDocument(eventId, id);
      setItems((liste) => liste.filter((eintrag) => eintrag.id !== id));
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Entfernen fehlgeschlagen');
    }
  }

  return (
    <section className="card stack" aria-labelledby="cal-docs-title">
      <div className="row row-between">
        <h2 id="cal-docs-title" className="cal-block-title">
          Dokumente
        </h2>
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy}
          onClick={() => dateiFeld.current?.click()}
        >
          {busy ? 'Lädt hoch …' : 'Datei hinzufügen'}
        </button>
      </div>

      <input
        ref={dateiFeld}
        type="file"
        hidden
        aria-hidden="true"
        onChange={(event) => {
          const datei = event.target.files?.[0];
          if (datei) void hochladen(datei);
        }}
      />

      {laedt ? (
        <Spinner label="Dokumente werden geladen …" />
      ) : items.length === 0 ? (
        <p className="cal-hint">
          Noch nichts angehängt. Einladung, Anfahrt, Speisekarte – hier finden es alle wieder.
        </p>
      ) : (
        <ul className="list">
          {items.map((item, index) => (
            <li key={item.id} className="cal-doc">
              <button type="button" className="cal-doc-open" onClick={() => setBetrachter(index)}>
                <span aria-hidden="true">📄</span>
                <span className="truncate">
                  {item.title ?? item.attachment.fileName ?? 'Datei'}
                </span>
                <span className="cal-doc-meta">{formatBytes(item.attachment.size)}</span>
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-label="Dokument entfernen"
                onClick={() => void entfernen(item.id)}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      {betrachter != null && items.length > 0 && (
        <FileViewer
          items={items.map((item) => item.attachment)}
          index={betrachter}
          onClose={() => setBetrachter(null)}
        />
      )}
    </section>
  );
}
