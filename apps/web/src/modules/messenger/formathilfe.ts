/**
 * Die Formatierungshilfe der Eingabezeile: markierten Text in Zeichen
 * einschliessen (*fett*, _kursiv_ …) – oder sie wieder entfernen, wenn sie
 * schon darum stehen.
 *
 * Leerraum am Rand der Auswahl bleibt draussen: „*fett *“ wäre nach den
 * Regeln des Parsers (`formatierung.ts`) keine Formatierung, weil vor dem
 * schliessenden Zeichen kein Leerraum stehen darf. Wer ein Wort samt
 * folgendem Leerzeichen markiert (Doppelklick in manchen Browsern), bekäme
 * sonst Sternchen statt Fettdruck.
 */
export type Umschliessen = 'fett' | 'kursiv' | 'durch' | 'mono' | 'spoiler';

const ZEICHEN: Record<Umschliessen, string> = {
  fett: '*',
  kursiv: '_',
  durch: '~',
  mono: '`',
  spoiler: '||',
};

export function umschliessen(
  text: string,
  von: number,
  bis: number,
  art: Umschliessen,
): { text: string; von: number; bis: number } {
  const zeichen = ZEICHEN[art];
  let a = Math.max(0, Math.min(von, bis));
  let b = Math.min(text.length, Math.max(von, bis));
  while (a < b && /\s/.test(text[a])) a += 1;
  while (b > a && /\s/.test(text[b - 1])) b -= 1;
  if (a === b) return { text, von, bis };
  const n = zeichen.length;
  // Schon eingeschlossen (aussen oder innen)? Dann wieder ausschliessen.
  if (text.slice(a - n, a) === zeichen && text.slice(b, b + n) === zeichen) {
    return {
      text: text.slice(0, a - n) + text.slice(a, b) + text.slice(b + n),
      von: a - n,
      bis: b - n,
    };
  }
  const innen = text.slice(a, b);
  if (innen.length > 2 * n && innen.startsWith(zeichen) && innen.endsWith(zeichen)) {
    const ohne = innen.slice(n, innen.length - n);
    return { text: text.slice(0, a) + ohne + text.slice(b), von: a, bis: a + ohne.length };
  }
  return {
    text: text.slice(0, a) + zeichen + innen + zeichen + text.slice(b),
    von: a + n,
    bis: b + n,
  };
}
