import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { WARTEZEIT_MS, sucheLohnt, type OrtTreffer } from '../lib/ortSuche.js';
import { OrtHinweis } from './OrtHinweis.js';

/**
 * Das Ort-Feld mit Vorschlägen beim Tippen.
 *
 * Ein Feld, das freien Text annimmt UND vorschlägt: Wer „Willy“ tippt, sieht
 * Orte, Plätze und Adressen; wer eine Zoom-Adresse oder „bei mir“ schreibt,
 * wird nicht gestört und behält seinen Text. Vorschläge sind nur Hilfe – ein
 * Fehler beim Suchen (kein Netz, Dienst weg) macht das Feld nicht kaputt, es
 * bleibt ein Textfeld.
 *
 * Bedienung wie eine Auswahlbox (ARIA 1.2, „combobox“ mit „listbox“): Pfeil
 * ab/auf wählt, Eingabe übernimmt, Escape schliesst, ohne den Text anzutasten.
 * Ein Tippen nach der Übernahme sucht wieder; die Übernahme selbst nicht,
 * sonst klappte die Liste sofort wieder auf.
 *
 * Die Namensnennung (OpenStreetMap, ODbL) steht unter der Liste, solange sie
 * offen ist.
 */
export function OrtFeld({
  id,
  wert,
  onChange,
  hinweisId,
  maxLaenge,
  platzhalter,
}: {
  id: string;
  wert: string;
  onChange: (neu: string) => void;
  hinweisId: string;
  maxLaenge: number;
  platzhalter?: string;
}) {
  const listeId = useId();
  const [treffer, setTreffer] = useState<OrtTreffer[]>([]);
  const [quelle, setQuelle] = useState('');
  const [offen, setOffen] = useState(false);
  const [aktiv, setAktiv] = useState(-1);
  /** Der Text, den eine Übernahme gesetzt hat – für den wird nicht wieder gesucht. */
  const uebernommen = useRef<string | null>(null);
  /** Ob das Feld den Fokus hat – eine späte Antwort öffnet die Liste nur dann. */
  const imFokus = useRef(false);
  const [gewaehlt, setGewaehlt] = useState<string | null>(null);

  useEffect(() => {
    if (uebernommen.current === wert || !sucheLohnt(wert)) {
      setTreffer([]);
      setOffen(false);
      return;
    }
    const abbruch = new AbortController();
    const timer = window.setTimeout(() => {
      api.orte
        .suche(wert.trim(), abbruch.signal)
        .then((antwort) => {
          setTreffer(antwort.items);
          setQuelle(antwort.quelle);
          setAktiv(-1);
          setOffen(antwort.items.length > 0 && imFokus.current);
        })
        .catch(() => {
          // Ohne Vorschläge ist es ein Textfeld; kein Fehler, der stört.
          if (!abbruch.signal.aborted) {
            setTreffer([]);
            setOffen(false);
          }
        });
    }, WARTEZEIT_MS);
    return () => {
      window.clearTimeout(timer);
      abbruch.abort();
    };
  }, [wert]);

  const uebernehmen = (t: OrtTreffer) => {
    uebernommen.current = t.text;
    setGewaehlt(t.text.slice(0, maxLaenge));
    onChange(t.text.slice(0, maxLaenge));
    setOffen(false);
    setTreffer([]);
  };

  const mitTaste = (taste: React.KeyboardEvent<HTMLInputElement>) => {
    if (taste.key === 'Escape' && offen) {
      taste.preventDefault();
      // Escape schliesst nur die Liste, nicht das Blatt dahinter.
      taste.stopPropagation();
      setOffen(false);
      return;
    }
    if (!offen || treffer.length === 0) return;
    if (taste.key === 'ArrowDown') {
      taste.preventDefault();
      setAktiv((alt) => (alt + 1) % treffer.length);
    } else if (taste.key === 'ArrowUp') {
      taste.preventDefault();
      setAktiv((alt) => (alt <= 0 ? treffer.length - 1 : alt - 1));
    } else if (taste.key === 'Enter' && aktiv >= 0) {
      taste.preventDefault();
      uebernehmen(treffer[aktiv]!);
    }
  };

  const optionId = (i: number) => `${listeId}-${i}`;

  return (
    <div className="ort-feld">
      <input
        id={id}
        className="input"
        role="combobox"
        aria-expanded={offen}
        aria-controls={listeId}
        aria-autocomplete="list"
        aria-activedescendant={offen && aktiv >= 0 ? optionId(aktiv) : undefined}
        aria-describedby={hinweisId}
        value={wert}
        maxLength={maxLaenge}
        placeholder={platzhalter}
        autoComplete="off"
        onChange={(e) => {
          uebernommen.current = null;
          onChange(e.target.value);
        }}
        onKeyDown={mitTaste}
        onBlur={() => {
          imFokus.current = false;
          window.setTimeout(() => setOffen(false), 150);
        }}
        onFocus={() => {
          imFokus.current = true;
          if (treffer.length > 0) setOffen(true);
        }}
      />
      <ul id={listeId} role="listbox" aria-label="Ortsvorschläge" className="ort-liste" hidden={!offen}>
        {treffer.map((t, i) => (
          <li
            key={`${t.text}-${t.lat}`}
            id={optionId(i)}
            role="option"
            aria-selected={i === aktiv}
            className={`ort-treffer${i === aktiv ? ' is-active' : ''}`}
            // mousedown statt click: Der Fokus verlässt das Feld sonst vorher,
            // und die Liste ist weg, bevor der Klick ankommt.
            onMouseDown={(e) => {
              e.preventDefault();
              uebernehmen(t);
            }}
          >
            <span className="ort-titel">{t.titel}</span>
            {t.zeile && <span className="ort-zeile">{t.zeile}</span>}
          </li>
        ))}
        {offen && quelle && (
          <li role="presentation" className="ort-quelle">
            {quelle}
          </li>
        )}
      </ul>
      <OrtHinweis ort={wert} id={hinweisId} bestaetigt={gewaehlt !== null && gewaehlt === wert} />
    </div>
  );
}
