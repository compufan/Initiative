import { useState } from 'react';
import { readEngineSettings, writeEngineSetting } from '../stickers/engines/settings.js';
import { ENGINE_INFO, downloadHint } from '../stickers/engines/types.js';
import { Toggle } from './Toggle.js';

/**
 * Der Schalter für die Tiefenkarte im Foto-Editor.
 *
 * Eine eigene Karte und keine Zeile mehr bei „Freistellen für Sticker“: Das
 * Modell stellt nichts frei. Es schätzt für jeden Bildpunkt die Entfernung,
 * und es gehört zu einem anderen Werkzeug an einer anderen Stelle der App.
 * Unter einer Überschrift, die „Freistellen“ heisst, würde es jeder für einen
 * weiteren Freisteller halten – und dann enttäuscht sein, weil seine Kante an
 * Haaren schlechter ist als die von „Person“.
 *
 * Die Verwaltung dahinter ist dieselbe: eine Liste der Modelle, die im Gerät
 * laufen dürfen, ein Schalter je Gerät.
 */
export function TiefeCard() {
  const [enabled, setEnabled] = useState(() => readEngineSettings());
  const info = ENGINE_INFO.find((engine) => engine.key === 'tiefe');
  if (!info) return null;

  return (
    <section className="card stack" aria-labelledby="prf-tiefe-title">
      <h2 className="prf-block-title" id="prf-tiefe-title">
        Tiefenschärfe im Foto-Editor
      </h2>
      <p className="prf-hint">
        Gilt nur für dieses Gerät. Die Schätzung läuft im Gerät selbst – es werden keine Bilder
        irgendwohin geschickt, und es entstehen keine laufenden Kosten.
      </p>

      <Toggle
        label={info.label}
        description={`${info.description} ${downloadHint(info)}`}
        checked={enabled[info.key]}
        onChange={(next) => setEnabled(writeEngineSetting(info.key, next))}
      />

      <p className="prf-hint">
        Ein Lauf dauert auf einem Telefon rund drei Sekunden und passiert einmal je Foto – die
        beiden Regler „Fokus“ und „Tiefenbereich“ danach laufen flüssig.
      </p>
    </section>
  );
}
