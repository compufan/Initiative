/**
 * Aus einer Maske einzelne Teile machen – damit man sie antippen kann.
 *
 * Ein Modell wie u2netp liefert eine einzige Karte: für jeden Bildpunkt einen
 * Wert dafür, wie sehr er zum „Motiv“ gehört. Das ist die richtige Antwort auf
 * die Frage „was ist wichtig“, aber die falsche auf „was will ich behalten“.
 * Wer eine Bierflasche freistellen will, bekommt Flasche UND Person, weil
 * beide auffällig sind – und hat keine Handhabe, eines davon wegzunehmen.
 *
 * Die Lösung ist erstaunlich einfach: Die Karte zerfällt in
 * **zusammenhängende Flächen**. Flasche und Person sind zwei davon, sofern sie
 * sich nicht berühren. Damit wird aus „alles oder nichts“ ein Antippen: Tippe
 * die Flasche an, sie ist dabei; tippe die Person an, sie kommt dazu.
 *
 * Die Zerlegung ist nicht klug und muss es nicht sein. Sie kennt keine
 * Gegenstände – sie weiss nur, was zusammenhängt. Wenn die Person die Flasche
 * hält und beide über den Arm verbunden sind, sind sie ein Teil, und dann
 * bleibt das Radieren. Das ist ehrlicher als so zu tun, als verstünde die App
 * das Bild.
 */

/** Ab welchem Wert ein Bildpunkt als „gehört dazu“ gilt. */
const SCHWELLE = 128;

/**
 * Flächen, die kleiner sind als das, werden verworfen.
 *
 * Modelle produzieren an Kanten gern einzelne Sprenkel. Als antippbare Teile
 * wären sie nutzlos – man träfe sie nicht – und in der Liste nur Rauschen.
 * Ein Promille der Bildfläche ist grosszügig genug für eine Hand und klein
 * genug, um Staub auszusortieren.
 */
const MINDESTANTEIL = 0.001;

export interface Teile {
  /** Je Bildpunkt die Nummer seines Teils, 0 = gehört zu keinem. */
  labels: Int32Array;
  /** Wie viele Teile es gibt. Nummern laufen von 1 bis `anzahl`. */
  anzahl: number;
  /** Grösse je Teil in Bildpunkten, Index 1 … `anzahl`. */
  groessen: number[];
  width: number;
  height: number;
}

/**
 * Zerlegt eine Maske in zusammenhängende Flächen.
 *
 * Vier-Nachbarschaft (oben, unten, links, rechts) und keine Diagonalen: Über
 * Ecken verbundene Flächen sind fast immer zwei Dinge, die sich zufällig
 * berühren, und sie zusammenzufassen macht das Antippen unbrauchbar.
 *
 * Der Durchlauf ist iterativ mit eigenem Stapel, nicht rekursiv. Bei einem
 * Bild mit einer Million Punkten wäre Rekursion ein zuverlässiger Weg, den
 * Aufrufstapel zu sprengen – und zwar erst bei jemandem, der ein grosses Bild
 * hochlädt, also nie im Test.
 */
export function teileFinden(alpha: Uint8Array, width: number, height: number): Teile {
  const labels = new Int32Array(width * height);
  const groessen: number[] = [0];
  const mindest = Math.max(16, Math.floor(width * height * MINDESTANTEIL));
  const stapel: number[] = [];
  let naechste = 1;

  for (let start = 0; start < labels.length; start += 1) {
    if (labels[start] !== 0 || alpha[start] < SCHWELLE) continue;

    const nummer = naechste;
    let groesse = 0;
    stapel.length = 0;
    stapel.push(start);
    labels[start] = nummer;

    while (stapel.length > 0) {
      const at = stapel.pop() as number;
      groesse += 1;
      const x = at % width;
      const y = (at - x) / width;

      if (x > 0) pruefen(at - 1);
      if (x < width - 1) pruefen(at + 1);
      if (y > 0) pruefen(at - width);
      if (y < height - 1) pruefen(at + width);
    }

    function pruefen(nachbar: number) {
      if (labels[nachbar] !== 0 || alpha[nachbar] < SCHWELLE) return;
      labels[nachbar] = nummer;
      stapel.push(nachbar);
    }

    if (groesse < mindest) {
      // Zu klein: die Nummer wieder einsammeln, damit die Zählung dicht bleibt.
      for (let i = 0; i < labels.length; i += 1) {
        if (labels[i] === nummer) labels[i] = 0;
      }
    } else {
      groessen.push(groesse);
      naechste += 1;
    }
  }

  return { labels, anzahl: naechste - 1, groessen, width, height };
}

/**
 * Welches Teil liegt an dieser Stelle?
 *
 * Trifft der Finger daneben – und das tut er ständig, ein Finger ist breiter
 * als eine Kontur –, wird in wachsenden Ringen gesucht. Ohne das müsste man
 * eine dünne Flasche punktgenau treffen, und die Bedienung wäre eine Zumutung.
 */
export function teilAn(teile: Teile, x: number, y: number, umkreis = 12): number {
  const { labels, width, height } = teile;
  const mx = Math.round(x);
  const my = Math.round(y);
  if (mx < 0 || my < 0 || mx >= width || my >= height) return 0;

  const direkt = labels[my * width + mx];
  if (direkt !== 0) return direkt;

  for (let r = 1; r <= umkreis; r += 1) {
    for (let dy = -r; dy <= r; dy += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        // Nur der Rand des Quadrats – das Innere war in der Runde davor dran.
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const px = mx + dx;
        const py = my + dy;
        if (px < 0 || py < 0 || px >= width || py >= height) continue;
        const gefunden = labels[py * width + px];
        if (gefunden !== 0) return gefunden;
      }
    }
  }
  return 0;
}

/**
 * Die Maske für eine Auswahl von Teilen.
 *
 * Gibt es keine Auswahl, gilt die ganze Maske – so verhält sich das Modell
 * wie bisher, solange niemand etwas antippt. Wer einmal getippt hat, sieht
 * genau das, was er gewählt hat.
 */
export function maskeAus(alpha: Uint8Array, teile: Teile, gewaehlt: readonly number[]): Uint8Array {
  if (gewaehlt.length === 0) return alpha;
  const dabei = new Set(gewaehlt);
  const heraus = new Uint8Array(alpha.length);
  for (let i = 0; i < alpha.length; i += 1) {
    if (dabei.has(teile.labels[i])) heraus[i] = alpha[i];
  }
  return heraus;
}
