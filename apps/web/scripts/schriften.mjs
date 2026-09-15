/**
 * Baut `src/styles/schriften.css` aus `src/lib/schriften.ts`.
 *
 * # Warum erzeugt und nicht von Hand gepflegt
 *
 * Weil es zwei Listen wären, die dasselbe sagen – und die zweite läuft der
 * ersten hinterher. Genau daran krankte die Schriftauswahl schon einmal:
 * `SCHRIFTEN` im Fotoeditor und `STICKER_SCHRIFTEN` im Sticker-Studio waren
 * eine Wort-für-Wort-Kopie, und wer einen Eintrag ergänzte, ergänzte ihn
 * zweimal oder eben nicht.
 *
 * Eine fehlende `@font-face`-Regel fällt ausserdem nicht auf: Der Browser
 * nimmt still die nächstbeste Schrift, und sichtbar wird es erst an einem
 * Bild, das auf einem anderen Gerät anders aussieht.
 *
 * Aufruf: `pnpm schriften`. Läuft ausserdem vor jedem Bauen.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const hier = dirname(fileURLToPath(import.meta.url));
const webDir = join(hier, '..');
const QUELLE = join(webDir, 'src', 'lib', 'schriften.ts');
const ZIEL = join(webDir, 'src', 'styles', 'schriften.css');

const KOPF = `/*
 * Die mitgelieferten Schriften.
 *
 * ERZEUGT – nicht von Hand ändern. Die Wahrheit steht in
 * \`src/lib/schriften.ts\`; dieses Blatt wird daraus gebaut
 * (\`pnpm schriften\`). Zwei von Hand gepflegte Listen laufen auseinander, und
 * man merkt es erst an einem Sticker, auf dem die falsche Schrift steht.
 *
 * \`font-display: block\` und nicht \`swap\`: Was hier gezeichnet wird, landet in
 * einem BILD. Ein Tausch nach dem Rastern kommt zu spät – dann steht die
 * Ersatzschrift für immer darin. Lieber einen Augenblick nichts sehen als
 * dauerhaft das Falsche. Gewartet wird ohnehin in \`schriftBereit\`.
 */
`;

/**
 * Die Einträge aus der TypeScript-Datei lesen.
 *
 * Mit einem Ausdruck und nicht durch Einlesen des Moduls: Das Skript läuft in
 * Node, die Datei ist TypeScript, und ein Übersetzungsschritt nur für eine
 * Liste von neun Einträgen wäre mehr Maschinerie als Nutzen. Findet der
 * Ausdruck nichts, bricht das Skript ab – still ein leeres Blatt zu schreiben
 * wäre der schlimmere Ausgang.
 */
function eintraegeAus(text) {
  const raus = [];
  const muster =
    /\{\s*key: '([a-z]+)',\s*label: '([^']+)',[\s\S]*?stack: '([^']+)',\s*schnitte: \[([\s\S]*?)\],/g;
  let treffer;
  while ((treffer = muster.exec(text)) !== null) {
    const [, key, label, stack, schnitte] = treffer;
    const paare = [...schnitte.matchAll(/gewicht: (\d+), datei: '([^']+)'/g)].map((m) => ({
      gewicht: Number(m[1]),
      datei: m[2],
    }));
    raus.push({ key, label, stack, schnitte: paare });
  }
  return raus;
}

const quelle = await readFile(QUELLE, 'utf8');
const eintraege = eintraegeAus(quelle);
if (eintraege.length === 0) {
  throw new Error(`Keine Schriften in ${QUELLE} gefunden – hat sich der Aufbau geändert?`);
}

const bloecke = [KOPF];
let schnitte = 0;
for (const eintrag of eintraege) {
  if (eintrag.schnitte.length === 0) continue;
  const name = eintrag.stack.split(',')[0].trim().replace(/^"|"$/g, '');
  for (const schnitt of eintrag.schnitte) {
    schnitte += 1;
    bloecke.push(
      `@font-face {\n` +
        `  font-family: '${name}';\n` +
        `  font-style: normal;\n` +
        `  font-weight: ${schnitt.gewicht};\n` +
        `  font-display: block;\n` +
        `  src: url('/schriften/${schnitt.datei}') format('woff2');\n` +
        `}\n`,
    );
  }
}

await writeFile(ZIEL, bloecke.join('\n'), 'utf8');
const mit = eintraege.filter((e) => e.schnitte.length > 0).length;
console.log(
  `schriften.css: ${mit} mitgelieferte Schriften, ${schnitte} Schnitte, ` +
    `${eintraege.length - mit} Systemstapel.`,
);
