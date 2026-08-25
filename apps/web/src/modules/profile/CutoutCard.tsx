import { useState } from 'react';
import { readEngineSettings, writeEngineSetting } from '../stickers/engines/settings.js';
import { ENGINE_INFO, downloadHint, type EngineKey } from '../stickers/engines/types.js';
import { Toggle } from './Toggle.js';

/**
 * Welche Freistell-Verfahren dieses Gerät benutzen darf.
 *
 * Gilt bewusst nur für dieses Gerät: Auf einem älteren iPhone will man das
 * grosse Modell abschalten, auf dem Rechner nicht. Alles rechnet im Gerät –
 * der Server ist unbeteiligt, es entstehen keine laufenden Kosten.
 */
export function CutoutCard() {
  const [enabled, setEnabled] = useState(() => readEngineSettings());

  function toggle(key: EngineKey, next: boolean) {
    setEnabled(writeEngineSetting(key, next));
  }

  return (
    <section className="card stack" aria-labelledby="prf-cutout-title">
      <h2 className="prf-block-title" id="prf-cutout-title">
        Freistellen für Sticker
      </h2>
      <p className="prf-hint">
        Gilt nur für dieses Gerät. Die Erkennung läuft im Gerät selbst – es werden keine Bilder
        irgendwohin geschickt, und es entstehen keine laufenden Kosten.
      </p>

      {ENGINE_INFO.filter((engine) => engine.key !== 'tap').map((engine) => (
        <Toggle
          key={engine.key}
          label={engine.label}
          description={`${engine.description} ${downloadHint(engine)}`}
          checked={enabled[engine.key]}
          onChange={(next) => toggle(engine.key, next)}
        />
      ))}

      <p className="prf-hint">
        „Antippen“ ist immer verfügbar und braucht keinen Download – es bleibt der Rückfall, wenn
        ein Modell abgeschaltet ist oder mit einem Motiv nicht zurechtkommt.
      </p>
    </section>
  );
}
