import { ENGINE_INFO, type EngineKey } from './types.js';

/**
 * Welche Freistell-Verfahren auf **diesem Gerät** benutzt werden dürfen.
 *
 * Bewusst pro Gerät und nicht am Konto: Ein älteres iPhone soll das grosse
 * Modell abschalten können, ohne dass der Rechner darauf verzichten muss.
 */

const KEY = 'initiative.cutout-engines';

function defaults(): Record<EngineKey, boolean> {
  return Object.fromEntries(
    ENGINE_INFO.map((engine) => [engine.key, engine.defaultEnabled]),
  ) as Record<EngineKey, boolean>;
}

export function readEngineSettings(): Record<EngineKey, boolean> {
  const base = defaults();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return base;
    const stored = JSON.parse(raw) as Partial<Record<EngineKey, boolean>>;
    for (const engine of ENGINE_INFO) {
      const value = stored[engine.key];
      if (typeof value === 'boolean') base[engine.key] = value;
    }
    return base;
  } catch {
    // Privater Modus oder kaputter Eintrag – dann eben die Vorgaben.
    return base;
  }
}

export function writeEngineSetting(key: EngineKey, enabled: boolean): Record<EngineKey, boolean> {
  const next = { ...readEngineSettings(), [key]: enabled };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* nicht speicherbar – gilt dann nur für diese Sitzung */
  }
  return next;
}

export function isEngineEnabled(key: EngineKey): boolean {
  return readEngineSettings()[key];
}

/* ---------- Qualität: hoch oder niedrig ---------- */

/**
 * Welche Güte der Anwender für das Freistellen will.
 *
 * # Warum das NICHT in die Schalter oben gehört
 *
 * Die Schalter darüber beantworten eine andere Frage: „Welche Verfahren darf
 * dieses Gerät überhaupt herunterladen und laufen lassen?" Sie sind eine
 * Geräteentscheidung und gelten für ein 84-MB-Modell anders als für ein
 * 7-MB-Modell.
 *
 * Die Qualität ist eine Tagesentscheidung: „Welches der erlaubten Verfahren
 * will ich JETZT?" Beides in dieselben Schalter zu schreiben wäre nicht nur
 * unsauber, sondern falsch: „hoch" wählen hiesse dann „niedrig" abschalten –
 * und genau darauf bauen mehrere Stellen als RÜCKFALL. Der Fehlersatz von
 * BiRefNet rät wörtlich, „Niedrige Qualität" zu nehmen; gäbe es die dann
 * nicht mehr, liefe der Rat ins Leere.
 *
 * Deshalb: dieselbe Datei, eigener Schlüssel, eigene Vorgabe.
 */
export type Qualitaet = 'niedrig' | 'hoch';

const QUALITAET_KEY = 'initiative.cutout-qualitaet';

/**
 * Die Vorgabe ist „niedrig".
 *
 * Nicht aus Bescheidenheit: „Hoch" ist BiRefNet, und das sind 84 MB beim
 * ersten Mal und eine Grafikeinheit mit `shader-f16`. Wer die Wahl nie
 * getroffen hat, soll nicht beim ersten Freistellen 84 MB laden.
 */
export function readQualitaet(): Qualitaet {
  try {
    return localStorage.getItem(QUALITAET_KEY) === 'hoch' ? 'hoch' : 'niedrig';
  } catch {
    // Privater Modus – dann eben die Vorgabe.
    return 'niedrig';
  }
}

export function writeQualitaet(q: Qualitaet): Qualitaet {
  try {
    localStorage.setItem(QUALITAET_KEY, q);
  } catch {
    /* nicht speicherbar – gilt dann nur für diese Sitzung */
  }
  return q;
}

/**
 * Welches Verfahren für diese Güte zuständig ist.
 *
 * Reine Zuordnung, ohne Rücksicht darauf, ob es eingeschaltet oder auf diesem
 * Gerät lauffähig ist – das entscheidet `gewaehlterFreisteller`.
 */
export function freistellerFuer(q: Qualitaet): 'object' | 'birefnet' {
  return q === 'hoch' ? 'birefnet' : 'object';
}

/**
 * Das Verfahren, das hier und jetzt wirklich laufen kann – oder `null`.
 *
 * Drei Dinge müssen zusammenkommen: die Wahl des Anwenders, der Schalter für
 * dieses Gerät und – bei „hoch" – eine taugliche Grafikeinheit. Ohne sie ist
 * BiRefNet keine langsamere Wahl, sondern eine Falle: nachgemessen 295
 * Sekunden je Bild auf dem Prozessor, weil der für halbe Genauigkeit keine
 * Rechenwerke hat.
 *
 * Der Rückfall geht nach UNTEN, nie nach oben: Wer „hoch" gewählt hat und
 * keine Grafikeinheit hat, bekommt „niedrig" – ein gröberer Ausschnitt ist
 * besser als fünf Minuten Warten. Umgekehrt wird aus „niedrig" nie „hoch",
 * denn das wären ungefragte 84 MB.
 *
 * Diese Funktion steht hier und nicht in den zwei Oberflächen, damit beide
 * dieselbe Kette benutzen. Zweimal geschrieben hiesse: einmal geändert,
 * einmal vergessen.
 */
export function gewaehlterFreisteller(
  q: Qualitaet,
  grafikTauglich: boolean,
): 'object' | 'birefnet' | null {
  if (q === 'hoch' && grafikTauglich && isEngineEnabled('birefnet')) return 'birefnet';
  if (isEngineEnabled('object')) return 'object';
  // „Hoch" gewählt, „niedrig" abgeschaltet, keine Grafikeinheit: Dann bleibt
  // nur noch BiRefNet – und das wäre die Falle. Lieber gar nichts und ein
  // ehrlicher Hinweis.
  return null;
}
