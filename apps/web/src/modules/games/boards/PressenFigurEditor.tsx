import { useEffect, useRef, useState } from 'react';
import {
  PRESSEN_FIGUR_GRENZEN,
  PRESSEN_FIGUR_SCHLUESSEL,
  standardFigur,
  zufallsFigur,
  type PressenFigurDaten,
  type PressenFigurMerkmal,
} from '@initiative/shared';
import { Sheet } from '../../../components/Sheet.js';
import { toast } from '../../../state/ui.js';
import { errorMessage, patchMe } from '../../profile/helpers.js';
import {
  BART_NAMEN,
  BEREIT,
  BRILLE_NAMEN,
  FRISUR_NAMEN,
  HAAR_FARBEN,
  HAUT_FARBEN,
  HUT_NAMEN,
  PressenFigur,
  SHIRT_FARBEN,
} from './PressenFigur.js';

const HAUT_NAMEN = ['Sehr hell', 'Hell', 'Beige', 'Mittel', 'Braun', 'Dunkelbraun', 'Sehr dunkel'];
const HAAR_NAMEN = [
  'Schwarz',
  'Dunkelbraun',
  'Braun',
  'Hellbraun',
  'Blond',
  'Hellblond',
  'Grau',
  'Weiß',
  'Rot',
  'Blau',
];
const SHIRT_NAMEN = [
  'Rot',
  'Orange',
  'Gelb',
  'Hellgrün',
  'Grün',
  'Türkis',
  'Blau',
  'Violett',
  'Lila',
  'Pink',
  'Anthrazit',
  'Weiß',
];

interface Gruppe {
  merkmal: PressenFigurMerkmal;
  titel: string;
  namen: readonly string[];
  farben?: readonly string[];
}

const GRUPPEN: Gruppe[] = [
  { merkmal: 'frisur', titel: 'Frisur', namen: FRISUR_NAMEN },
  { merkmal: 'haarfarbe', titel: 'Haarfarbe', namen: HAAR_NAMEN, farben: HAAR_FARBEN },
  { merkmal: 'haut', titel: 'Hautfarbe', namen: HAUT_NAMEN, farben: HAUT_FARBEN },
  { merkmal: 'shirt', titel: 'Shirt', namen: SHIRT_NAMEN, farben: SHIRT_FARBEN },
  { merkmal: 'bart', titel: 'Bart', namen: BART_NAMEN },
  { merkmal: 'brille', titel: 'Brille', namen: BRILLE_NAMEN },
  { merkmal: 'hut', titel: 'Hut', namen: HUT_NAMEN },
];

interface Props {
  open: boolean;
  onClose: () => void;
  /** Die Figur, mit der das Blatt aufgeht (die gespeicherte oder die Standardfigur). */
  start: PressenFigurDaten;
  /** Kennung für „Zurücksetzen“ auf die Standardfigur. */
  kennung: string;
}

/**
 * Das Bearbeitungsblatt für das eigene Strichmännchen, mit Vorschau.
 *
 * Gespeichert wird in den Konto-Einstellungen (`settings.modules.pressenFigur`),
 * also über Geräte und Spiele hinweg; der Server prüft die Grenzen noch einmal.
 */
export function PressenFigurEditor({ open, onClose, start, kennung }: Props) {
  const [figur, setFigur] = useState<PressenFigurDaten>(start);
  const [speichert, setSpeichert] = useState(false);

  // Beim Öffnen immer von der gespeicherten Figur ausgehen – und NUR dann: `start`
  // ist bei jedem Rendern des Bretts ein neues Objekt (die Uhr tickt jede
  // Sekunde), und als Abhängigkeit setzte es die Auswahl ständig zurück.
  const startRef = useRef(start);
  startRef.current = start;
  useEffect(() => {
    if (open) setFigur(startRef.current);
  }, [open]);

  const setze = (merkmal: PressenFigurMerkmal, wert: number) =>
    setFigur((alt) => ({ ...alt, [merkmal]: wert }));

  async function speichern() {
    setSpeichert(true);
    try {
      await patchMe({ settings: { modules: { [PRESSEN_FIGUR_SCHLUESSEL]: figur } } });
      toast('Dein Strichmännchen ist gespeichert', 'success');
      onClose();
    } catch (error) {
      toast(errorMessage(error, 'Speichern fehlgeschlagen'), 'error');
    } finally {
      setSpeichert(false);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} variant="modal" title="Dein Strichmännchen">
      <div className="pressen-editor" data-testid="pressen-figur-editor">
        <div className="pressen-editor-vorschau">
          <PressenFigur
            ansicht={{ ...BEREIT, x: 500, y: 330 }}
            figur={figur}
            bewegt
            titel="Vorschau deines Strichmännchens"
          />
        </div>
        {GRUPPEN.map((gruppe) => {
          const max = PRESSEN_FIGUR_GRENZEN[gruppe.merkmal];
          return (
            <fieldset key={gruppe.merkmal} className="pressen-editor-gruppe">
              <legend>{gruppe.titel}</legend>
              <div className="pressen-editor-wahl" role="radiogroup" aria-label={gruppe.titel}>
                {Array.from({ length: max + 1 }, (_, i) => {
                  const gewaehlt = figur[gruppe.merkmal] === i;
                  const farbe = gruppe.farben?.[i];
                  return (
                    <button
                      key={i}
                      type="button"
                      role="radio"
                      aria-checked={gewaehlt}
                      aria-label={gruppe.namen[i] ?? `${gruppe.titel} ${i + 1}`}
                      className={`pressen-editor-knopf${farbe ? ' ist-farbe' : ''}${gewaehlt ? ' is-gewaehlt' : ''}`}
                      style={farbe ? { background: farbe } : undefined}
                      onClick={() => setze(gruppe.merkmal, i)}
                    >
                      {farbe ? '' : gruppe.namen[i]}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          );
        })}
        <div className="pressen-editor-aktionen">
          <button type="button" className="btn" onClick={() => setFigur(zufallsFigur(Math.random))}>
            🎲 Würfeln
          </button>
          <button type="button" className="btn" onClick={() => setFigur(standardFigur(kennung))}>
            Zurücksetzen
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Abbrechen
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={speichert}
            onClick={() => void speichern()}
          >
            Speichern
          </button>
        </div>
      </div>
    </Sheet>
  );
}
