/**
 * Die zwei kleinen Rechnungen, die überall gebraucht werden.
 *
 * Sie standen in `ton.ts`, und dort hätten sie auch bleiben können – bis
 * `fein.ts` dazukam. Das braucht beide, und `ton.ts` braucht die Typen aus
 * `fein.ts`: ein Ring aus zwei Dateien, die sich gegenseitig zur Laufzeit
 * brauchen. Solche Ringe lösen sich in ESM meistens von selbst auf und
 * manchmal nicht, je nachdem, wer zuerst geladen wird – und der Fehler sieht
 * dann aus wie „irgendetwas ist undefined", nicht wie ein Ring.
 *
 * Eine dritte Datei ohne eigene Abhängigkeiten löst das ohne Kunstgriff.
 */

/** Auf 0 … 1 klemmen. */
export function halten(wert: number): number {
  return wert < 0 ? 0 : wert > 1 ? 1 : wert;
}

/**
 * Der weiche Übergang von 0 auf 1 – dieselbe Kurve, die GLSL `smoothstep`
 * heisst.
 *
 * Ausgeführt, damit `maske.ts` sie benutzt statt eine zweite hinzuschreiben:
 * Die Kanten einer Maske und die Kanten von Lichtern/Tiefen sollen sich
 * gleich anfühlen, und zwei Fassungen derselben Kurve driften auseinander.
 */
export function weich(von: number, bis: number, wert: number): number {
  const t = halten((wert - von) / (bis - von || 1));
  return t * t * (3 - 2 * t);
}
