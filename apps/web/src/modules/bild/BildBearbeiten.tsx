import { useState } from 'react';
import { BildEditor } from './BildEditor.js';

interface BildBearbeitenProps {
  /** Was bearbeitet werden soll. Liegt schon im Gerät – nichts wird geladen. */
  blob: Blob;
  name?: string | null;
  /** Bekommt die bearbeitete Fassung. Das Original bleibt unangetastet. */
  onFertig: (blob: Blob, name: string) => Promise<void> | void;
  /**
   * Bekommt statt dessen das unberührte Bild UND die Bearbeitung als Rezept.
   *
   * Fehlt es, gibt es den Knopf im Editor nicht. Die Auswahlblätter reichen es
   * nur durch, solange genau EIN Bild in der Auswahl liegt: Ein Rezept gehört
   * zu einem Bild, und eine Nachricht mit drei Bildern und einer Anweisung
   * liesse offen, zu welchem.
   */
  alsRezept?: (original: Blob, rezept: Blob, name: string) => Promise<void> | void;
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
  /**
   * Meldet, ob der Editor gerade offen ist.
   *
   * Wer diesen Knopf in ein Blatt setzt, MUSS darauf hören: Ein Blatt liegt
   * über der Werkstatt, der Editor ginge sonst dahinter auf. Siehe
   * `.is-beiseite` in `global.css`.
   */
  onOffen?: (offen: boolean) => void;
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
  alsRezept,
  label,
  zielName,
  startVerhaeltnis,
  className,
  tipp,
  onOffen,
}: BildBearbeitenProps) {
  const [offen, setOffen] = useState(false);

  // Den Melder an EINER Stelle bedienen, nicht an jedem der vier Wege hinaus.
  const setzen = (wert: boolean) => {
    setOffen(wert);
    onOffen?.(wert);
  };

  return (
    <>
      <button
        type="button"
        className={className ?? 'btn btn-sm'}
        onClick={() => setzen(true)}
        aria-label={label ? undefined : 'Bild bearbeiten'}
        data-tipp={tipp ?? 'Zuschneiden, geraderichten, Licht und Farbe – bevor du es sendest'}
      >
        {label ? `✏️ ${label}` : '✏️'}
      </button>

      {offen && (
        <BildEditor
          quelle={blob}
          name={name}
          onClose={() => setzen(false)}
          onFertig={async (fertig, fertigName) => {
            await onFertig(fertig, fertigName);
            setzen(false);
          }}
          onRezept={
            alsRezept
              ? async (original, rezept, rezeptName) => {
                  await alsRezept(original, rezept, rezeptName);
                  setzen(false);
                }
              : undefined
          }
          zielName={zielName ?? 'Übernehmen'}
          startVerhaeltnis={startVerhaeltnis}
        />
      )}
    </>
  );
}
