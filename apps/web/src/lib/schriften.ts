/**
 * Die Schriften, mit denen diese App auf Bilder schreibt.
 *
 * # Warum sie mitgeliefert werden
 *
 * Vorher standen hier reine Systemschrift-Stapel – `'Arial Narrow',
 * 'Roboto Condensed', …`. Das liest sich wie eine Auswahl und ist keine:
 *
 *   * „Schmal“ fand auf Android nichts davon. Roboto Condensed ist eine
 *     Google-Fonts-Schrift und kein Systembestandteil; gelandet ist es bei
 *     Roboto – also bei genau dem, was „Normal“ auch liefert. Zwei Knöpfe,
 *     ein Ergebnis.
 *   * „Rund“ fand weder Comic Sans MS noch Chalkboard SE noch Comic Neue und
 *     war dort schlicht nicht rund.
 *   * „Technisch“ nannte „SF Mono“, das Safari für Webinhalte gar nicht
 *     herausgibt.
 *
 * Das wäre Kosmetik, wenn das Ergebnis ein Text auf einer Seite wäre. Es ist
 * aber ein BILD: `zeichneAusgabe` rastert auf dem Gerät des Absenders, und
 * derselbe Knopfdruck ergibt auf iPhone und Android verschiedene Bilder. Beim
 * Rezept ist es schärfer – dort steht nur der Schlüssel in der Datei, und
 * gerechnet wird auf JEDEM Empfängergerät neu. Derselbe Anhang sieht dann bei
 * zwei Empfängern verschieden aus, und beim Weiterbearbeiten springt
 * zusätzlich die Grösse, weil eine andere Schrift anders breit misst.
 *
 * # Warum aus dem eigenen Haus und nicht von Google Fonts
 *
 * Weil es technisch gar nicht ginge: `font-src 'self'` und `style-src 'self'`
 * stehen in der Auslieferungsregel (siehe CSP.md), ein `<link>` auf
 * fonts.googleapis.com wäre also blockiert. Und es wäre auch ohne die Regel
 * falsch – eine selbstgehostete App soll keine IP-Adressen an Dritte geben,
 * und ohne Netz rasterte die Ausgabe dauerhaft die Ersatzschrift ins Bild.
 *
 * # Die Auswahl
 *
 * Acht mitgelieferte Schriften, alle unter der SIL Open Font License 1.1
 * (kommerziell nutzbar, Einbetten in Bilder ausdrücklich erlaubt), je auf
 * Latin gekürzt und als woff2 – zusammen rund 275 kB. Dazu „Normal“ als
 * einziger Systemstapel, weil das die Schrift der Oberfläche ist und ein Text
 * ohne besondere Absicht so aussehen soll wie die App.
 *
 * Gewählt ist nach ZWECK, nicht nach Namen: eine für die Überschrift, eine
 * fürs Plakat, eine für die Handschrift, eine für die Maschine, und so
 * weiter. Zwei Schriften, die dasselbe können, sind eine zu viel.
 */

/** Eine Schrift, wie Editor und Sticker-Studio sie anbieten. */
export interface Schriftart {
  key: string;
  label: string;
  /** Der CSS-Stapel: eigener Name zuerst, Systemschriften als Netz darunter. */
  stack: string;
  /**
   * Die mitgelieferten Schnitte – leer bei einem reinen Systemstapel.
   *
   * Der Schlüssel ist das Gewicht, der Wert der Dateiname unter
   * `/schriften/`. Zwei Schnitte gibt es nur dort, wo „fett“ etwas anderes
   * bedeuten soll als „dieselbe Schrift, künstlich verdickt“ – bei Anton und
   * Archivo Black ist der eine Schnitt bereits der fette.
   */
  schnitte: { gewicht: number; datei: string }[];
  /**
   * Das Gewicht, in dem diese Schrift auf einem Sticker steht.
   *
   * Sticker-Text war fest auf 800 gesetzt. Für eine Plakatschrift, die es nur
   * in einem Schnitt gibt, heisst das: Der Browser verdickt sie künstlich und
   * verschmiert die Formen, für die man sie gewählt hat.
   */
  stickerGewicht: number;
}

/** Der Ordner unter `public/`, in dem die Dateien liegen. */
export const SCHRIFT_ORDNER = '/schriften';

export const SCHRIFTEN: Schriftart[] = [
  {
    key: 'system',
    label: 'Normal',
    stack: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    schnitte: [],
    stickerGewicht: 800,
  },
  {
    key: 'serif',
    label: 'Serifen',
    // Lora – eine Buchschrift mit genug Strichstärkenwechsel, dass sie auf
    // einem Foto nicht verschwindet.
    stack: '"Initiative Serifen", Georgia, "Times New Roman", serif',
    schnitte: [
      { gewicht: 400, datei: 'serif-400.woff2' },
      { gewicht: 700, datei: 'serif-700.woff2' },
    ],
    stickerGewicht: 700,
  },
  {
    key: 'mono',
    label: 'Technisch',
    // JetBrains Mono – gleiche Laufweite, klar unterscheidbare Null und O.
    stack: '"Initiative Technisch", ui-monospace, "Roboto Mono", Menlo, monospace',
    schnitte: [
      { gewicht: 400, datei: 'mono-400.woff2' },
      { gewicht: 700, datei: 'mono-700.woff2' },
    ],
    stickerGewicht: 700,
  },
  {
    key: 'rund',
    label: 'Rund',
    // Fredoka – freundlich und rund, und zwar auf JEDEM Gerät. Das war der
    // Eintrag, der auf Android vorher gar nichts fand.
    stack: '"Initiative Rund", "Comic Sans MS", "Chalkboard SE", cursive',
    schnitte: [
      { gewicht: 400, datei: 'rund-400.woff2' },
      { gewicht: 700, datei: 'rund-700.woff2' },
    ],
    stickerGewicht: 700,
  },
  {
    key: 'schmal',
    label: 'Schmal',
    // Oswald – wirklich schmal. Vorher landete dieser Eintrag auf Android bei
    // Roboto und war damit von „Normal“ nicht zu unterscheiden.
    stack: '"Initiative Schmal", "Arial Narrow", "Helvetica Neue", sans-serif',
    schnitte: [
      { gewicht: 400, datei: 'schmal-400.woff2' },
      { gewicht: 700, datei: 'schmal-700.woff2' },
    ],
    stickerGewicht: 700,
  },
  {
    key: 'plakat',
    label: 'Plakat',
    // Anton – schmal und sehr fett, die Schrift für ein Wort quer übers Bild.
    // Es gibt sie nur in einem Schnitt, und der ist schon der fette.
    stack: '"Initiative Plakat", "Arial Black", Impact, sans-serif',
    schnitte: [{ gewicht: 400, datei: 'plakat-400.woff2' }],
    stickerGewicht: 400,
  },
  {
    key: 'wucht',
    label: 'Wucht',
    // Archivo Black – breit und schwer, wo Anton schmal und schwer ist.
    stack: '"Initiative Wucht", "Arial Black", sans-serif',
    schnitte: [{ gewicht: 400, datei: 'wucht-400.woff2' }],
    stickerGewicht: 400,
  },
  {
    key: 'hand',
    label: 'Handschrift',
    // Caveat, im fetten Schnitt: Eine dünne Handschrift auf einem bunten Foto
    // ist nicht zu lesen.
    stack: '"Initiative Handschrift", "Bradley Hand", cursive',
    schnitte: [{ gewicht: 400, datei: 'hand-400.woff2' }],
    stickerGewicht: 400,
  },
  {
    key: 'elegant',
    label: 'Elegant',
    // Playfair Display – hoher Strichstärkenkontrast, für Einladungen und
    // alles, was nach Anlass aussehen soll.
    stack: '"Initiative Elegant", "Didot", Georgia, serif',
    schnitte: [
      { gewicht: 400, datei: 'elegant-400.woff2' },
      { gewicht: 700, datei: 'elegant-700.woff2' },
    ],
    stickerGewicht: 700,
  },
];

/** Der CSS-Stapel zu einem Schlüssel – unbekannte fallen auf „Normal“. */
export function schriftStack(key: string): string {
  return (SCHRIFTEN.find((eintrag) => eintrag.key === key) ?? SCHRIFTEN[0]).stack;
}

/** Der Eintrag zu einem Schlüssel – unbekannte fallen auf „Normal“. */
export function schriftart(key: string): Schriftart {
  return SCHRIFTEN.find((eintrag) => eintrag.key === key) ?? SCHRIFTEN[0];
}

/**
 * Die Schrift laden, bevor auf eine Leinwand geschrieben wird.
 *
 * # Warum das sein muss
 *
 * `ctx.fillText` wartet auf nichts. Ist die Schrift noch nicht da, rastert die
 * Leinwand die ERSATZSCHRIFT – und zwar endgültig: Das Ergebnis ist ein Bild,
 * und ein Bild lädt nicht nach. Beim Rezept wäre der Schaden noch grösser,
 * weil dort auf dem Gerät jedes Empfängers gerechnet wird; wer das Foto als
 * Erster öffnet, bekäme die Ersatzschrift eingebrannt.
 *
 * `document.fonts.load` will eine vollständige CSS-Kurzschreibweise, also
 * Gewicht UND Grösse. Die Grösse ist dabei gleichgültig – geladen wird die
 * Datei, nicht ein Schriftgrad –, sie muss nur dastehen.
 *
 * Gibt `Promise<void>` zurück und wirft nie: Eine Schrift, die nicht kommt,
 * ist ein schlechteres Bild, kein Fehler. Wer wartet, wartet höchstens bis
 * zum Zeitablauf; danach wird mit dem gezeichnet, was da ist.
 */
export async function schriftBereit(key: string, zeitMs = 3000): Promise<void> {
  const art = schriftart(key);
  if (art.schnitte.length === 0) return;
  const schriften = (globalThis as { document?: Document }).document?.fonts;
  if (!schriften) return;
  const name = art.stack.split(',')[0].trim();
  const warten = Promise.all(
    art.schnitte.map((schnitt) => schriften.load(`${schnitt.gewicht} 16px ${name}`)),
  );
  await Promise.race([
    warten.catch(() => undefined),
    new Promise((auf) => setTimeout(auf, zeitMs)),
  ]);
}

/**
 * Die Schriften laden, die in diesem Dokument wirklich vorkommen.
 *
 * Genau so viel wie nötig: Wer ein Foto ohne Schriftzug ausgibt, soll auf
 * nichts warten. Und `document.fonts.load` auf eine schon geladene Schrift
 * kostet nichts – man darf es also vor jeder Ausgabe rufen, ohne mitzuzählen.
 */
export async function schriftenBereit(
  schluessel: readonly (string | undefined | null)[],
  zeitMs = 3000,
): Promise<void> {
  const gebraucht = [...new Set(schluessel.filter((k): k is string => Boolean(k)))];
  if (gebraucht.length === 0) return;
  await Promise.race([
    Promise.all(gebraucht.map((k) => schriftBereit(k, zeitMs))).catch(() => undefined),
    new Promise((auf) => setTimeout(auf, zeitMs)),
  ]);
}

/** Alle mitgelieferten Schriften laden – für den Editor, der sie alle anbietet. */
export async function alleSchriftenBereit(zeitMs = 5000): Promise<void> {
  await Promise.race([
    Promise.all(SCHRIFTEN.map((art) => schriftBereit(art.key, zeitMs))).catch(() => undefined),
    new Promise((auf) => setTimeout(auf, zeitMs)),
  ]);
}
