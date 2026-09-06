import { useState } from 'react';
import { BildEditor } from './BildEditor.js';

interface BildBearbeitenProps {
  /** Was bearbeitet werden soll. Liegt schon im Gerät – nichts wird geladen. */
  blob: Blob;
  name?: string | null;
  /** Bekommt die bearbeitete Fassung. Das Original bleibt unangetastet. */
  onFertig: (blob: Blob, name: string) => Promise<void> | void;
  /** Beschriftung des Knopfes. Nur ein Symbol, wenn leer. */
  label?: string;
  /** Was auf dem Speichern-Knopf im Editor steht. */
  zielName?: string;
  /** Rastet den Zuschnitt sofort auf diese Form ein, z. B. 1 für quadratisch. */
  startVerhaeltnis?: number;
  /** Zusätzliche Klassen für den Knopf, damit er sich einfügt. */
  className?: string;
  /** Der Tooltip. Sagt, was passiert – nicht, wie der Knopf heisst. */
  tipp?: string;
}

/**
 * Der Weg in den Fotoeditor für ein Bild, das noch **nicht** hochgeladen ist.
 *
 * `FotoWerkstatt` kann das nicht: Sie beginnt bei einem `AttachmentDto` und
 * holt die Bytes vom Server. Vor dem Senden gibt es aber weder Anhang noch
 * Server – nur eine Datei im Gerät. Genau dieser Fall fehlte, und deshalb war
 * der Editor bisher erst erreichbar, NACHDEM ein Bild verschickt war: Wer ein
 * schiefes Foto gerade rücken wollte, musste es erst allen zeigen.
 */
export function BildBearbeiten({
  blob,
  name,
  onFertig,
  label,
  zielName,
  startVerhaeltnis,
  className,
  tipp,
}: BildBearbeitenProps) {
  const [offen, setOffen] = useState(false);

  return (
    <>
      <button
        type="button"
        className={className ?? 'btn btn-sm'}
        onClick={() => setOffen(true)}
        aria-label={label ? undefined : 'Bild bearbeiten'}
        data-tipp={tipp ?? 'Zuschneiden, geraderichten, Licht und Farbe – bevor du es sendest'}
      >
        {label ? `✏️ ${label}` : '✏️'}
      </button>

      {offen && (
        <BildEditor
          quelle={blob}
          name={name}
          onClose={() => setOffen(false)}
          onFertig={async (fertig, fertigName) => {
            await onFertig(fertig, fertigName);
            setOffen(false);
          }}
          zielName={zielName ?? 'Übernehmen'}
          startVerhaeltnis={startVerhaeltnis}
        />
      )}
    </>
  );
}
