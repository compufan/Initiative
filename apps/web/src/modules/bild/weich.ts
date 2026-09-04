/**
 * Der Weichzeichner des Bokeh-Werkzeugs – als Schiebefenster mit laufender
 * Summe.
 *
 * Warum es diese Datei gibt: In `zeichnen.ts` steht schon ein
 * Kastenweichzeichner, und der zählt für JEDEN Bildpunkt sein ganzes Fenster
 * neu zusammen – 2r+1 Summanden, zwei Durchgänge, drei Kanäle. Dieselbe
 * Rechnung mit laufender Summe kommt mit einer Addition und einer
 * Subtraktion je Bildpunkt aus, unabhängig vom Radius.
 *
 * Nachgemessen auf 1200 × 900, beide Fassungen gegeneinander, nach
 * Aufwärmlauf und als Bestwert aus drei Durchgängen:
 *
 *     Radius 8:   308 ms → 41 ms   (Faktor 7,6)
 *     Radius 24:  854 ms → 40 ms   (Faktor 21,6)
 *     Radius 36: 1217 ms → 43 ms   (Faktor 28,1)
 *     Radius 60: 2083 ms → 43 ms   (Faktor 48,2)
 *
 * Die zweite Spalte ist die eigentliche Aussage: Sie steht, über den ganzen
 * Bereich. Der alte Weichzeichner wächst linear mit dem Radius, dieser gar
 * nicht – und genau am Radius dreht beim Bokeh der Regler.
 *
 * Der Aufwärmlauf ist nicht kosmetisch: Ohne ihn kam für Radius 8 der höchste
 * Wert der ganzen Reihe heraus (84 ms gegen 43 ms bei Radius 36), also eine
 * Kurve, die mit dem Radius FÄLLT. Das war die Übersetzungsarbeit des ersten
 * Laufs, als Messung ausgegeben.
 *
 * Kein Aufruf von `zeichnen.ts` wandert hier mit hinein: Diese Datei ist rein
 * – kein Dokument, keine Leinwand, keine `ImageData` – und deshalb unter
 * vitest mit `environment: 'node'` prüfbar.
 *
 * Die beiden Durchgänge sind getrennt (waagerecht, dann senkrecht). Ein
 * getrennter Kasten zweimal ist derselbe Kasten wie einmal zweidimensional,
 * kostet aber 2·(2r+1) statt (2r+1)² Summanden.
 */

/**
 * Kastenweichzeichner über RGBA, waagerecht und senkrecht getrennt.
 *
 * Arbeitet an Ort und Stelle und rührt nur R, G und B an. Alpha bleibt
 * unangetastet: Das Bokeh liegt unter einer Maske, und ein mitgemittelter
 * Alphakanal fräse die Maskenkante rund, obwohl die Maske selbst gar nicht
 * weichgezeichnet werden sollte.
 *
 * Am Rand wird auf den Randpunkt geklemmt, das Fenster hat also überall genau
 * 2r+1 Stützstellen. Die Alternative – nur über die vorhandenen Nachbarn
 * mitteln, wie es der alte Weichzeichner tut – lässt sich nicht als laufende
 * Summe schreiben, weil der Teiler dann von Punkt zu Punkt wechselt.
 */
export function kastenWeichRgba(
  daten: Uint8ClampedArray,
  breite: number,
  hoehe: number,
  radius: number,
): void {
  /*
   * Positiv abfragen, nicht negativ ausschliessen.
   *
   * `r <= 0` ist bei `NaN` falsch, die Abkürzung griffe also nicht: `teiler`
   * würde NaN, jeder Farbwert als NaN geschrieben und von
   * `Uint8ClampedArray` stumm als 0 abgelegt. Nachgemessen: ein Feld aus
   * lauter 200 kam mit `radius = NaN` als reines Schwarz zurück, bei
   * unverändertem Alphakanal – unter einer Maske also ein schwarzer Fleck
   * ohne jede Fehlermeldung.
   *
   * Der Weg dahin ist kurz: `bokehRadius(NaN, 1200)` gibt ebenfalls NaN
   * zurück, und die beiden Funktionen sind genau so verkettet gedacht. Ein
   * unendlicher Radius wiederum liesse den Vorlauf gar nicht enden.
   */
  if (!Number.isFinite(radius) || !Number.isFinite(breite) || !Number.isFinite(hoehe)) return;
  const r = Math.floor(radius);
  if (r <= 0 || breite <= 0 || hoehe <= 0) return;

  // Einmal belegt, nicht je Kanal: 1200 × 900 × 4 Zahlen sind 17 MB, und
  // dreimal davon je Rahmen zu belegen beschäftigt allein den Aufräumer.
  const zwischen = new Float32Array(breite * hoehe * 4);
  const teiler = 1 / (2 * r + 1);

  for (let k = 0; k < 3; k += 1) {
    for (let y = 0; y < hoehe; y += 1) {
      const zeile = y * breite * 4;
      // Der Anfangswert enthält den linken Randpunkt (r+1)-fach – genau das
      // ist das Klemmen, nur ohne Fallunterscheidung in der Schleife.
      let summe = daten[zeile + k] * (r + 1);
      for (let x = 1; x <= r; x += 1) {
        summe += daten[zeile + Math.min(breite - 1, x) * 4 + k];
      }
      for (let x = 0; x < breite; x += 1) {
        zwischen[zeile + x * 4 + k] = summe * teiler;
        // Wer
        // das Abziehen vergisst, bekommt keinen Weichzeichner, sondern ein
        // nach rechts immer heller laufendes Bild.
        const rein = daten[zeile + Math.min(breite - 1, x + r + 1) * 4 + k];
        const raus = daten[zeile + Math.max(0, x - r) * 4 + k];
        summe += rein - raus;
      }
    }

    for (let x = 0; x < breite; x += 1) {
      const spalte = x * 4 + k;
      let summe = zwischen[spalte] * (r + 1);
      for (let y = 1; y <= r; y += 1) {
        summe += zwischen[Math.min(hoehe - 1, y) * breite * 4 + spalte];
      }
      for (let y = 0; y < hoehe; y += 1) {
        daten[y * breite * 4 + spalte] = summe * teiler;
        const rein = zwischen[Math.min(hoehe - 1, y + r + 1) * breite * 4 + spalte];
        const raus = zwischen[Math.max(0, y - r) * breite * 4 + spalte];
        summe += rein - raus;
      }
    }
  }
}

/**
 * Der Bokeh-Radius als Anteil der Bildkante.
 *
 * `unschaerfe` ist ein Regler von 0 … 1, `kante` die Kantenlänge, auf der
 * gerade gerechnet wird. Ein Regler auf 1 weicht also ein Fünfzigstel der
 * Kante auf.
 *
 * Und deshalb ein Anteil und keine Bildpunkte: Die Vorschau rechnet auf
 * 1200 Punkten Breite, die Ausgabe auf 2560. Ein fester Radius von 24 wäre in
 * der Ausgabe halb so stark wie in der Vorschau – man stellt das Bokeh am
 * Regler ein und bekommt ein anderes Bild heraus, als man gesehen hat.
 *
 * Dieselbe Regel wie in `ton.ts`/`tonGpu.ts`: Die Regler dort sind einheitenlose Werte
 * von 0 … 1, und wo eine Länge vorkommt, ist sie am Bild gemessen und nicht
 * in Bildpunkten – `vignetteFaktor` bekommt `u`/`v` in 0 … 1 und normiert auf
 * die halbe Diagonale. Die eine Stelle, die das nicht tut, ist die
 * Unschärfemaske von `schaerfe`: Sie nimmt immer die vier direkten Nachbarn
 * und wirkt darum in der grossen Ausgabe feiner als in der Vorschau. Genau
 * dieser Unterschied soll sich beim Bokeh nicht wiederholen.
 */
export function bokehRadius(unschaerfe: number, kante: number): number {
  return Math.max(0, Math.round(unschaerfe * 0.02 * kante));
}
