import { useRef, useState } from 'react';
import { formatBytes } from '@initiative/shared';
import { Sheet } from '../../components/Sheet.js';
import { api } from '../../lib/api.js';
import { prepareImage, uploadBlob, videoPreview } from '../../lib/upload.js';
import { kindForFile, mimeForFile, withinUploadLimit } from '../media/helpers.js';
import { toast } from '../../state/ui.js';
import { useFiles } from './state.js';

interface Props {
  open: boolean;
  onClose: () => void;
  collectionId: string;
}

interface Posten {
  datei: File;
  zustand: 'wartet' | 'laeuft' | 'fertig' | 'fehler';
  meldung?: string;
}

/**
 * Dateien unmittelbar in eine Sammlung legen.
 *
 * Bisher führte der einzige Weg über den Chat: erst irgendwohin schicken, dann
 * die Nachricht lange antippen, dann „Zur Sammlung hinzufügen“. Für eine Datei,
 * die niemanden im Chat interessiert – ein Mietvertrag, ein Scan –, ist das ein
 * Umweg mit Nebenwirkung: Sie steht danach im Chatverlauf.
 *
 * Zwei Dinge, die hier bewusst anders sind als beim Senden im Chat:
 *
 * **Kein Outbox-Umweg.** Die Outbox gehört zum Chat; hier gibt es keine
 * Nachricht, an der etwas hängen könnte. Ohne Netz scheitert das Hochladen
 * deshalb sichtbar, statt still zu warten – und sagt das auch.
 *
 * **Vorschaubild trotzdem.** Für Bilder und Videos wird eines erzeugt, sonst
 * zeigt die Kachel in der Sammlung nur ein Symbol.
 */
export function UploadToCollectionSheet({ open, onClose, collectionId }: Props) {
  const [posten, setPosten] = useState<Posten[]>([]);
  const [laeuft, setLaeuft] = useState(false);
  const feld = useRef<HTMLInputElement | null>(null);

  async function hochladen(dateien: File[]) {
    const erlaubt = dateien.filter((datei) =>
      withinUploadLimit(kindForFile(datei), datei.size, datei.name),
    );
    if (erlaubt.length === 0) return;

    setPosten(erlaubt.map((datei) => ({ datei, zustand: 'wartet' })));
    setLaeuft(true);
    let geschafft = 0;

    for (const [index, datei] of erlaubt.entries()) {
      setPosten((liste) =>
        liste.map((eintrag, i) => (i === index ? { ...eintrag, zustand: 'laeuft' } : eintrag)),
      );
      try {
        // Nacheinander, nicht alle auf einmal: Ein Handy im Zug bekommt sonst
        // fünf halbe Uploads statt zwei ganze.
        const kind = kindForFile(datei);

        // Bild und Video bekommen ein Vorschaubild – ohne das zeigt die Kachel
        // in der Sammlung nur ein Symbol. Ein Bild wird dabei zugleich auf
        // vertretbare Kantenlänge gebracht.
        const bild = kind === 'image' ? await prepareImage(datei) : null;
        const video = kind === 'video' ? await videoPreview(datei) : null;

        const attachment = await uploadBlob({
          kind,
          mime: bild?.mime ?? mimeForFile(datei),
          fileName: datei.name,
          blob: bild?.blob ?? datei,
          width: bild?.width ?? video?.width,
          height: bild?.height ?? video?.height,
          durationMs: video?.durationMs,
          previewDataUrl: bild?.previewDataUrl ?? video?.previewDataUrl,
        });

        await api.collections.addItem(collectionId, {
          attachmentId: attachment.id,
          title: datei.name,
        });
        geschafft += 1;
        setPosten((liste) =>
          liste.map((eintrag, i) => (i === index ? { ...eintrag, zustand: 'fertig' } : eintrag)),
        );
      } catch (error) {
        setPosten((liste) =>
          liste.map((eintrag, i) =>
            i === index
              ? {
                  ...eintrag,
                  zustand: 'fehler',
                  meldung: error instanceof Error ? error.message : 'Fehlgeschlagen',
                }
              : eintrag,
          ),
        );
      }
    }

    setLaeuft(false);
    if (geschafft > 0) {
      await useFiles.getState().loadItems(collectionId, true);
      toast(
        geschafft === 1 ? 'Datei hinzugefügt.' : `${geschafft} Dateien hinzugefügt.`,
        'success',
      );
      // Nur schliessen, wenn wirklich alles durchlief – sonst verschwaende
      // die Meldung, welche Datei haengen blieb.
      if (geschafft === erlaubt.length) onClose();
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="Dateien hinzufügen">
      <div className="stack">
        <button
          type="button"
          className="btn btn-primary btn-block"
          disabled={laeuft}
          onClick={() => feld.current?.click()}
        >
          {laeuft ? 'Lädt hoch …' : 'Dateien auswählen'}
        </button>

        <input
          ref={feld}
          type="file"
          multiple
          hidden
          aria-hidden="true"
          onChange={(änderung) => {
            const dateien = Array.from(änderung.target.files ?? []);
            änderung.target.value = '';
            if (dateien.length > 0) void hochladen(dateien);
          }}
        />

        {posten.length > 0 && (
          <ul className="fil-upload-liste">
            {posten.map((eintrag, index) => (
              <li key={`${eintrag.datei.name}-${index}`} className="fil-upload-zeile">
                <span className="truncate">{eintrag.datei.name}</span>
                <span className="fil-upload-groesse">{formatBytes(eintrag.datei.size)}</span>
                <span className={`fil-upload-zustand is-${eintrag.zustand}`}>
                  {eintrag.zustand === 'wartet' && 'wartet'}
                  {eintrag.zustand === 'laeuft' && '…'}
                  {eintrag.zustand === 'fertig' && '✓'}
                  {eintrag.zustand === 'fehler' && (eintrag.meldung ?? 'Fehler')}
                </span>
              </li>
            ))}
          </ul>
        )}

        <p className="fil-hint">
          Die Datei landet nur in dieser Sammlung – nicht in einem Chat. Wer die Sammlung sehen
          darf, sieht sie.
        </p>
      </div>
    </Sheet>
  );
}
