/**
 * Die Farbflutung – „Antippen“ ohne jedes Modell.
 *
 * Herausgelöst aus `stickers/render.ts`, weil sie seit dem Fotoeditor ZWEI
 * Aufrufer hat und keiner von beiden den anderen braucht: Der Sticker
 * schneidet damit ein Motiv frei, die Bereiche des Fotoeditors machen daraus
 * einen Maskenteil. Die Zeichenkette der Sticker – Kontur, Schatten,
 * Schriftzüge, Leinwand – gehört in keinen von beiden Wegen hinein.
 *
 * `render.ts` gibt `flutmaske` und `dilateAlpha` unverändert weiter; für
 * dessen Aufrufer und für `render.test.ts` ändert sich nichts.
 *
 * **Warum das hier ohne Netz ist und bleibt.** Ein Netz muss geladen werden –
 * beim ersten Mal einige Megabyte, und auf manchen Geräten gar nicht. Diese
 * Datei rechnet auf jedem Gerät, sofort, ohne einen einzigen Byte aus dem
 * Netz. Sie trifft gröber; sie trifft aber immer.
 */

/** Der Abstand zweier Farben – der Mittelwert über die drei Kanäle. */
export function colourDistance(dr: number, dg: number, db: number): number {
  return Math.sqrt((dr * dr + dg * dg + db * db) / 3);
}

/**
 * Ein Saatpunkt der Flutung.
 *
 * Absichtlich als KLEINSTE Form beschrieben und nicht als `KeepSeed` aus
 * `render.ts`: Jener Typ trägt Gruppen- und Herkunftsangaben, die nur das
 * Sticker-Studio kennt, und der Fotoeditor hätte sie erfinden müssen. Ein
 * `KeepSeed` passt hier hinein, ohne dass es etwas davon weiss.
 */
export interface Saat {
  /** Im Bild, auf das geflutet wird – nicht auf einer Anzeigefläche. */
  x: number;
  y: number;
  /** Fehlt der Wert, gilt „dazu“. `weg` kann die Flutung nicht, siehe unten. */
  mode?: 'dazu' | 'weg';
}

/**
 * "Antippen zum Behalten": das Gegenstück zu `removeBackground`.
 *
 * Statt vom Rand her wegzuräumen, wächst hier von jeder angetippten Stelle ein
 * Bereich über farblich verwandte Nachbarn – alles ausserhalb wird
 * durchsichtig. Das trifft genau die Erwartung „ich tippe auf das, was ich im
 * Sticker haben will“, und funktioniert auf jedem Gerät ohne Download.
 *
 * Mehrere Antipper addieren sich, damit sich auch mehrfarbige Motive
 * zusammensetzen lassen (Gesicht, dann Haare, dann Pullover).
 */
export function flutmaske(image: ImageData, seeds: readonly Saat[], tolerance: number): Uint8Array {
  const { width, height, data } = image;
  const total = width * height;
  if (seeds.length === 0) return new Uint8Array(total);

  const keep = new Uint8Array(total);
  const visited = new Uint8Array(total);
  const stack = new Int32Array(total);

  for (const seed of seeds) {
    // Die Flutung kann kein Wegnehmen – ein Minus-Tipp waere hier ein
    // zusaetzlicher Saatpunkt, also das genaue Gegenteil des Gemeinten.
    if (seed.mode === 'weg') continue;
    const sx = Math.round(seed.x);
    const sy = Math.round(seed.y);
    if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
    const start = sy * width + sx;
    const startAt = start * 4;
    if (data[startAt + 3] === 0) continue;

    // Jeder Antipper beginnt mit frischer Besuchsliste, sonst blockieren sich
    // zwei Bereiche gegenseitig.
    visited.fill(0);
    const seedR = data[startAt];
    const seedG = data[startAt + 1];
    const seedB = data[startAt + 2];

    let top = 0;
    visited[start] = 1;
    keep[start] = 1;
    stack[top++] = start;

    while (top > 0) {
      const index = stack[--top];
      const x = index % width;
      const y = (index - x) / width;

      const visit = (neighbour: number) => {
        if (visited[neighbour]) return;
        visited[neighbour] = 1;
        const at = neighbour * 4;
        if (data[at + 3] === 0) return;
        const distance = colourDistance(
          data[at] - seedR,
          data[at + 1] - seedG,
          data[at + 2] - seedB,
        );
        if (distance <= tolerance) {
          keep[neighbour] = 1;
          stack[top++] = neighbour;
        }
      };

      if (x > 0) visit(index - 1);
      if (x < width - 1) visit(index + 1);
      if (y > 0) visit(index - width);
      if (y < height - 1) visit(index + width);
    }
  }

  // Kleine Löcher im Motiv schliessen (Lichtreflexe, Augen) und die Kante
  // weich auslaufen lassen, damit kein Treppenmuster stehen bleibt.
  const grown = dilateAlpha(
    Uint8Array.from(keep, (value) => (value ? 255 : 0)),
    width,
    height,
    2,
  );
  return blurAlpha(grown, width, height, 1);
}
/**
 * Das laufende Maximum über ein Fenster von 2r+1 – in EINER Linie.
 *
 * # Warum nicht einfach über das Fenster laufen
 *
 * Weil das je Punkt bis zu 2r+1 Vergleiche kostet, und r ist hier kein
 * Kleinkram: Ein Schlagschatten von 24 Punkten Weite sind 49 Vergleiche je
 * Bildpunkt. Nachgemessen auf 512 × 512 kostete allein der waagerechte
 * Durchgang 9,3 ms; mit dem senkrechten und dem zweiten Aufruf für die Kontur
 * kam der Sticker auf 50 ms je Bild – 20 Bilder je Sekunde, und das bei jedem
 * Ruck am Regler.
 *
 * # Das Verfahren
 *
 * Van Herk, Gil und Werman, 1992: Die Linie wird in Blöcke der Fensterbreite
 * zerlegt. In jedem Block wird einmal von links das laufende Maximum
 * aufgeschrieben (`praefix`) und einmal von rechts (`suffix`). Jedes Fenster
 * liegt dann über genau zwei benachbarten Blöcken, und sein Maximum ist
 * `max(suffix[Anfang], praefix[Ende])` – zwei Zugriffe, unabhängig von r.
 * Drei Durchgänge über die Linie statt r Vergleiche je Punkt.
 *
 * Das Verfahren ist über dreissig Jahre alt und Allgemeingut; hier steht es
 * als eigener Code, nicht als Abhängigkeit.
 *
 * # Der Rand
 *
 * Gepolstert wird mit NULL, und das ist kein Näherungswert, sondern genau
 * richtig: Null ist das neutrale Element des Maximums über Alphawerte. Ein
 * Fenster, das über den Rand hinausragt, bekommt dadurch dasselbe Ergebnis
 * wie ein Fenster, das am Rand aufhört – und genau so hat es die vorige
 * Fassung gerechnet.
 */
function maxLinie(
  ein: Uint8Array,
  einAb: number,
  einSchritt: number,
  aus: Uint8Array,
  ausAb: number,
  ausSchritt: number,
  n: number,
  radius: number,
  polster: Uint8Array,
  praefix: Uint8Array,
  suffix: Uint8Array,
): void {
  const fenster = 2 * radius + 1;
  const gesamt = Math.ceil((n + 2 * radius) / fenster) * fenster;
  polster.fill(0, 0, gesamt);
  for (let i = 0; i < n; i += 1) polster[radius + i] = ein[einAb + i * einSchritt];

  for (let block = 0; block < gesamt; block += fenster) {
    praefix[block] = polster[block];
    for (let k = 1; k < fenster; k += 1) {
      const v = polster[block + k];
      const p = praefix[block + k - 1];
      praefix[block + k] = v > p ? v : p;
    }
    const ende = block + fenster - 1;
    suffix[ende] = polster[ende];
    for (let k = fenster - 2; k >= 0; k -= 1) {
      const v = polster[block + k];
      const s = suffix[block + k + 1];
      suffix[block + k] = v > s ? v : s;
    }
  }

  for (let i = 0; i < n; i += 1) {
    const a = suffix[i];
    const b = praefix[i + fenster - 1];
    aus[ausAb + i * ausSchritt] = a > b ? a : b;
  }
}
/**
 * Separable maximum filter – the dilation of the alpha mask.
 *
 * Zwei Durchgänge, waagerecht und senkrecht; zusammen ergibt das ein
 * quadratisches Fenster. Das Ergebnis ist Byte für Byte dasselbe wie bei der
 * vorigen Fassung, die je Punkt über das ganze Fenster lief – geprüft in
 * `render.test.ts` gegen eine unmittelbare Nachbildung.
 */
export function dilateAlpha(
  alpha: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  const result = new Uint8Array(alpha.length);
  if (width <= 0 || height <= 0) return result;
  if (radius < 1) {
    result.set(alpha);
    return result;
  }

  // Die drei Hilfsfelder einmal für beide Durchgänge – sie sind nur so lang
  // wie die längste Linie, nicht so gross wie das Bild.
  const fenster = 2 * radius + 1;
  const laenge = Math.ceil((Math.max(width, height) + 2 * radius) / fenster) * fenster;
  const polster = new Uint8Array(laenge);
  const praefix = new Uint8Array(laenge);
  const suffix = new Uint8Array(laenge);

  const horizontal = new Uint8Array(alpha.length);
  for (let y = 0; y < height; y += 1) {
    maxLinie(
      alpha,
      y * width,
      1,
      horizontal,
      y * width,
      1,
      width,
      radius,
      polster,
      praefix,
      suffix,
    );
  }
  for (let x = 0; x < width; x += 1) {
    maxLinie(horizontal, x, width, result, x, width, height, radius, polster, praefix, suffix);
  }
  return result;
}
/** Box blur with a running sum – rounds the corners of the square dilation. */
export function blurAlpha(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  if (radius < 1) return mask;
  const window = radius * 2 + 1;
  const horizontal = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let sum = 0;
    for (let x = -radius; x <= radius; x += 1)
      sum += mask[row + Math.min(width - 1, Math.max(0, x))];
    for (let x = 0; x < width; x += 1) {
      horizontal[row + x] = sum / window;
      sum -= mask[row + Math.max(0, x - radius)];
      sum += mask[row + Math.min(width - 1, x + radius + 1)];
    }
  }

  const result = new Uint8Array(mask.length);
  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let y = -radius; y <= radius; y += 1) {
      sum += horizontal[Math.min(height - 1, Math.max(0, y)) * width + x];
    }
    for (let y = 0; y < height; y += 1) {
      result[y * width + x] = sum / window;
      sum -= horizontal[Math.max(0, y - radius) * width + x];
      sum += horizontal[Math.min(height - 1, y + radius + 1) * width + x];
    }
  }
  return result;
}
