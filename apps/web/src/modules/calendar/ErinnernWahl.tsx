import { useId, useState } from 'react';
import type { ErinnernDto } from '@initiative/shared';

import {
  ANZAHL_VORGABEN,
  ERINNERN_STANDARD,
  FRIST_VORGABEN,
  anzahlText,
  erinnernPruefen,
  fristKurz,
  fristText,
} from './erinnern.js';

/**
 * Der Block „Erinnerung bei offener Antwort“ im Terminblatt.
 *
 * Aus, solange nichts gewählt ist. Beim Einschalten gilt „nach 2 Tagen,
 * dreimal“. Die Auswahl sind echte Optionsfelder (Pfeiltasten und
 * Vorlesehilfe kommen vom Browser), gestaltet als Chips; ein gespeicherter
 * Wert, der nicht zu den Vorgaben gehört (ein anderer Client hat ihn gesetzt),
 * steht unter „Eigene Dauer“ bzw. als zusätzliche Wahl, statt unsichtbar zu
 * bleiben.
 */
export function ErinnernWahl({
  wert,
  onChange,
  onFehler,
  gesperrt,
  hinweise,
}: {
  wert: ErinnernDto | null;
  onChange: (wert: ErinnernDto | null) => void;
  /** Meldet einen Fehler der Eingabe „Eigene Dauer“ – solange einer da ist, lässt sich nicht speichern. */
  onFehler: (fehler: string | null) => void;
  /** Warum sich der Schalter nicht einschalten lässt; `null`: frei. */
  gesperrt: string | null;
  /** Die Wirkung bei dieser Einstellung (`wirkungsHinweis`). */
  hinweise: string[];
}) {
  const id = useId();
  const an = wert !== null;
  const [eigen, setEigen] = useState(
    () => wert !== null && !(FRIST_VORGABEN as readonly number[]).includes(wert.nachStunden),
  );
  const [eigenText, setEigenText] = useState(() => String(wert?.nachStunden ?? ''));
  const [fehler, setFehler] = useState<string | null>(null);

  const melden = (neu: string | null) => {
    setFehler(neu);
    onFehler(neu);
  };

  const umschalten = (ein: boolean) => {
    if (!ein) {
      melden(null);
      setEigen(false);
      onChange(null);
      return;
    }
    setEigen(false);
    setEigenText(String(ERINNERN_STANDARD.nachStunden));
    onChange(ERINNERN_STANDARD);
  };

  const frist = (stunden: number) => {
    melden(null);
    setEigen(false);
    setEigenText(String(stunden));
    if (wert) onChange({ ...wert, nachStunden: stunden });
  };

  const eigeneDauer = (text: string) => {
    setEigenText(text);
    const stunden = Number(text);
    const fehlerText =
      text.trim() === ''
        ? 'Bitte Stunden eintragen.'
        : erinnernPruefen(stunden, wert?.anzahl ?? null);
    melden(fehlerText);
    if (!fehlerText && wert) onChange({ ...wert, nachStunden: stunden });
  };

  const anzahl = (neu: number | null) => {
    if (wert) onChange({ ...wert, anzahl: neu });
  };

  const fristName = `${id}-frist`;
  const anzahlName = `${id}-anzahl`;
  const anzahlen: readonly (number | null)[] =
    wert && !ANZAHL_VORGABEN.includes(wert.anzahl)
      ? [...ANZAHL_VORGABEN, wert.anzahl]
      : ANZAHL_VORGABEN;

  return (
    <div className="field cal-erinn">
      <label className="cal-switch">
        <span>Ausstehende erinnern</span>
        <input
          type="checkbox"
          role="switch"
          checked={an}
          disabled={gesperrt !== null && !an}
          aria-describedby={`${id}-zusammen`}
          onChange={(changed) => umschalten(changed.target.checked)}
        />
        <span className="cal-switch-track" aria-hidden="true" />
      </label>
      <span className="cal-field-label">Erinnerung bei offener Antwort</span>

      {gesperrt && !an && <p className="cal-hint">{gesperrt}</p>}
      {!an && !gesperrt && (
        <p className="cal-hint" id={`${id}-zusammen`}>
          Aus: Wer nicht antwortet, wird nicht erinnert.
        </p>
      )}

      {an && wert && (
        <>
          <fieldset className="cal-erinn-gruppe">
            <legend>Erste Erinnerung nach</legend>
            <div className="cal-chip-row">
              {FRIST_VORGABEN.map((stunden) => (
                <label
                  key={stunden}
                  className={`cal-erinn-chip ${!eigen && wert.nachStunden === stunden ? 'is-active' : ''}`}
                >
                  <input
                    type="radio"
                    name={fristName}
                    checked={!eigen && wert.nachStunden === stunden}
                    onChange={() => frist(stunden)}
                  />
                  <span>{fristKurz(stunden)}</span>
                </label>
              ))}
              <label className={`cal-erinn-chip ${eigen ? 'is-active' : ''}`}>
                <input
                  type="radio"
                  name={fristName}
                  checked={eigen}
                  onChange={() => {
                    setEigen(true);
                    eigeneDauer(eigenText || String(wert.nachStunden));
                  }}
                />
                <span>Eigene Dauer</span>
              </label>
            </div>
            {eigen && (
              <div className="cal-erinn-eigen">
                <input
                  className="input"
                  type="number"
                  inputMode="numeric"
                  min={12}
                  max={720}
                  step={1}
                  value={eigenText}
                  aria-label="Eigene Dauer in Stunden"
                  aria-invalid={fehler !== null}
                  aria-describedby={fehler ? `${id}-fehler` : `${id}-tipp`}
                  onChange={(changed) => eigeneDauer(changed.target.value)}
                />
                <span className="cal-inline-label">Stunden</span>
                {fehler ? (
                  <p className="cal-error" id={`${id}-fehler`}>
                    {fehler}
                  </p>
                ) : (
                  <p className="cal-hint" id={`${id}-tipp`}>
                    Vielfache von 24 Stunden erinnern zur selben Tageszeit wie die Einladung.
                  </p>
                )}
              </div>
            )}
          </fieldset>

          <fieldset className="cal-erinn-gruppe">
            <legend>Wie oft insgesamt</legend>
            <div className="cal-chip-row">
              {anzahlen.map((wahl) => (
                <label
                  key={wahl ?? 'bis'}
                  className={`cal-erinn-chip ${wert.anzahl === wahl ? 'is-active' : ''}`}
                >
                  <input
                    type="radio"
                    name={anzahlName}
                    checked={wert.anzahl === wahl}
                    onChange={() => anzahl(wahl)}
                  />
                  <span>
                    {wahl === null
                      ? 'Bis zum Termin'
                      : wahl === 1
                        ? 'Einmal'
                        : wahl === 2
                          ? 'Zweimal'
                          : wahl === 3
                            ? 'Dreimal'
                            : `${wahl}-mal`}
                  </span>
                </label>
              ))}
            </div>
            {wert.anzahl === null && <p className="cal-hint">Höchstens 10-mal.</p>}
          </fieldset>

          <p
            className="cal-hint"
            id={`${id}-zusammen`}
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            Wer nach {fristText(wert.nachStunden)} noch nicht geantwortet hat, bekommt im Einzelchat
            eine automatische Erinnerung – {anzahlText(wert.anzahl)}
            {wert.anzahl === 1 ? '' : ', jeweils nach derselben Frist'}. Wer antwortet, wird nicht
            mehr erinnert.
          </p>
          {hinweise.map((zeile) => (
            <p className="cal-hint" key={zeile}>
              {zeile}
            </p>
          ))}
        </>
      )}
    </div>
  );
}
