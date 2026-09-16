/**
 * Die Reihenfolge einer Diashow – auf beiden Geräten dieselbe.
 *
 * # Warum nicht einfach `Math.random()`
 *
 * Weil zwei Geräte mitspielen. Der Fernseher zeigt, das Telefon ist die
 * Fernbedienung und sagt „Bild 7". Mischte jedes für sich, meinte „Bild 7"
 * auf beiden Seiten etwas anderes – und wer am Telefon „zurück" drückt,
 * landete auf dem Fernseher irgendwo.
 *
 * Deshalb wird die Mischung GERECHNET, aus einer Saat, die der Server vergibt
 * und beide Seiten bekommen. Gleiche Saat, gleiche Liste, gleiche Reihenfolge.
 *
 * # Warum eine eigene Zufallsquelle
 *
 * `Math.random()` lässt sich nicht säen. Hier steht deshalb mulberry32 –
 * vier Zeilen, gleichverteilt genug für eine Bilderfolge und auf jedem
 * Browser bis in den Bit hinein identisch, weil nur mit 32-Bit-Ganzzahlen
 * gerechnet wird. Eine Zufallsquelle mit Kommazahlen täte das nicht: Dort
 * hinge das letzte Bit an der Rundung.
 */

/** Ein gesäter Zufallsstrom – gleicher Startwert, gleiche Folge. */
export function zufall(saat: number): () => number {
  let zustand = saat >>> 0;
  return () => {
    zustand = (zustand + 0x6d2b79f5) >>> 0;
    let t = zustand;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Die Reihenfolge für `anzahl` Stücke.
 *
 * `linear` gibt 0, 1, 2 … zurück – nicht etwa nichts: Der Aufrufer soll in
 * beiden Fällen dasselbe tun und nicht an jeder Stelle nachfragen müssen,
 * welcher Modus gerade gilt.
 *
 * Gemischt wird nach Fisher-Yates, und zwar von hinten. Das ist der
 * Unterschied zwischen einer echten Mischung und der naheliegenden Variante
 * („für jede Stelle eine beliebige andere aussuchen"): Letztere ist messbar
 * schief – manche Anordnungen kommen häufiger vor als andere.
 */
export function reihenfolge(anzahl: number, modus: string, saat: number): number[] {
  const liste = Array.from({ length: Math.max(0, anzahl) }, (_, i) => i);
  if (modus !== 'zufall' || liste.length < 2) return liste;
  const wuerfel = zufall(saat);
  for (let i = liste.length - 1; i > 0; i -= 1) {
    const j = Math.floor(wuerfel() * (i + 1));
    const merk = liste[i];
    liste[i] = liste[j];
    liste[j] = merk;
  }
  return liste;
}
