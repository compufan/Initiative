/**
 * Text-Formatierung wie bei WhatsApp: *fett*, _kursiv_, ~durchgestrichen~,
 * `monospace`, ```Block``` und ||Spoiler||.
 *
 * # Warum ein eigener Parser
 *
 * Kein HTML, nirgends: Das Ergebnis ist ein Baum aus schlichten Knoten, den
 * die Oberfläche in React-Elemente übersetzt. Es gibt keinen Weg, über den
 * ein Zeichen aus der Nachricht als Markup im Browser landet.
 *
 * # Laufzeit
 *
 * Reguläre Ausdrücke mit verschachtelten Wiederholungen sind der klassische
 * Weg zu ReDoS – eine Nachricht aus zehntausend Sternchen hielte den Chat
 * minutenlang fest. Hier wird für jede Markierung EINMAL von rechts nach
 * links ausgerechnet, wo der nächste gültige Schluss liegt (`naechsterSchluss`).
 * Jede öffnende Markierung findet ihren Schluss dann ohne Suche. Innerhalb
 * einer Formatierung ist dieselbe Markierung nicht noch einmal erlaubt, also
 * ist die Schachtelung höchstens fünf tief und jedes Zeichen wird höchstens
 * fünfmal angesehen: linear in der Länge.
 *
 * # Regeln (dieselben wie im Server, `services/messages/formatierung.rs`)
 *
 * - Eine Markierung öffnet nur am Wortanfang (Anfang, Leerraum, öffnende
 *   Klammer/Anführung oder eine andere Markierung davor) und nur, wenn kein
 *   Leerraum folgt. Sie schliesst nur, wenn kein Leerraum davor steht und
 *   danach das Ende, Leerraum, Satzzeichen oder eine Markierung kommt. So
 *   bleiben `a*b*c`, `2 * 3 * 4` und `datei_name_neu.txt` unberührt.
 * - Inline-Formatierungen enden an der Zeile.
 * - `monospace` und ```Block``` werden nicht weiter ausgewertet.
 * - Ein Block ```…``` darf über Zeilen gehen.
 */

export type FormatArt = 'fett' | 'kursiv' | 'durch' | 'mono' | 'spoiler';

export type FormatKnoten =
  | { art: 'text'; text: string }
  | { art: 'block'; text: string }
  | { art: 'mono'; text: string }
  | { art: 'fett' | 'kursiv' | 'durch' | 'spoiler'; kinder: FormatKnoten[] };

interface Markierung {
  art: FormatArt;
  zeichen: string;
}

const MARKIERUNGEN: Markierung[] = [
  { art: 'spoiler', zeichen: '||' },
  { art: 'fett', zeichen: '*' },
  { art: 'kursiv', zeichen: '_' },
  { art: 'durch', zeichen: '~' },
  { art: 'mono', zeichen: '`' },
];

const MARKIERUNGSZEICHEN = new Set(['*', '_', '~', '`', '|']);
const VOR_OEFFNEN = new Set(['(', '[', '{', '"', "'", '«', '„', '‚', '»', '“', '‘', '-', '/']);
const NACH_SCHLUSS = new Set([
  '.',
  ',',
  ';',
  ':',
  '!',
  '?',
  ')',
  ']',
  '}',
  '"',
  "'",
  '»',
  '“',
  '”',
  '’',
  '«',
  '-',
  '/',
]);

function leer(zeichen: string | undefined): boolean {
  return zeichen === undefined || /\s/.test(zeichen);
}

function kannOeffnen(text: string, i: number, laenge: number): boolean {
  const davor = text[i - 1];
  const danach = text[i + laenge];
  if (danach === undefined || leer(danach)) return false;
  return (
    davor === undefined || leer(davor) || VOR_OEFFNEN.has(davor) || MARKIERUNGSZEICHEN.has(davor)
  );
}

function kannSchliessen(text: string, j: number, laenge: number): boolean {
  const davor = text[j - 1];
  const danach = text[j + laenge];
  if (davor === undefined || leer(davor)) return false;
  return (
    danach === undefined ||
    leer(danach) ||
    NACH_SCHLUSS.has(danach) ||
    MARKIERUNGSZEICHEN.has(danach)
  );
}

/**
 * Für jede Stelle k die erste Position ≥ k, an der `zeichen` gültig schliesst
 * (oder -1). Ein Durchgang von rechts nach links.
 */
function naechsterSchluss(text: string, zeichen: string): Int32Array {
  const n = text.length;
  const naechste = new Int32Array(n + 2).fill(-1);
  for (let k = n - 1; k >= 0; k -= 1) {
    const passt =
      text.startsWith(zeichen, k) &&
      k + zeichen.length <= n &&
      kannSchliessen(text, k, zeichen.length);
    naechste[k] = passt ? k : naechste[k + 1];
  }
  return naechste;
}

/** Für jede Stelle k die Position des nächsten Zeilenumbruchs ≥ k (oder n). */
function naechsteZeile(text: string): Int32Array {
  const n = text.length;
  const naechste = new Int32Array(n + 2).fill(n);
  for (let k = n - 1; k >= 0; k -= 1) {
    naechste[k] = text[k] === '\n' ? k : naechste[k + 1];
  }
  return naechste;
}

interface Vorrechnung {
  text: string;
  schluss: Map<FormatArt, Int32Array>;
  zeile: Int32Array;
}

function inline(
  v: Vorrechnung,
  anfang: number,
  ende: number,
  erlaubt: ReadonlySet<FormatArt>,
): FormatKnoten[] {
  const { text } = v;
  const knoten: FormatKnoten[] = [];
  let puffer = '';
  const leeren = () => {
    if (puffer) knoten.push({ art: 'text', text: puffer });
    puffer = '';
  };
  let i = anfang;
  while (i < ende) {
    let getroffen = false;
    if (MARKIERUNGSZEICHEN.has(text[i])) {
      for (const markierung of MARKIERUNGEN) {
        if (!erlaubt.has(markierung.art)) continue;
        const laenge = markierung.zeichen.length;
        if (!text.startsWith(markierung.zeichen, i) || !kannOeffnen(text, i, laenge)) continue;
        const ab = i + laenge + 1;
        const j = ab <= ende ? (v.schluss.get(markierung.art)?.[ab] ?? -1) : -1;
        // Gültig nur innerhalb dieses Abschnitts und derselben Zeile.
        if (j < 0 || j + laenge > ende || v.zeile[i] < j) continue;
        leeren();
        if (markierung.art === 'mono') {
          knoten.push({ art: 'mono', text: text.slice(i + laenge, j) });
        } else {
          const ohne = new Set(erlaubt);
          ohne.delete(markierung.art);
          knoten.push({
            art: markierung.art,
            kinder: inline(v, i + laenge, j, ohne),
          });
        }
        i = j + laenge;
        getroffen = true;
        break;
      }
    }
    if (!getroffen) {
      puffer += text[i];
      i += 1;
    }
  }
  leeren();
  return knoten;
}

const ALLE: ReadonlySet<FormatArt> = new Set(MARKIERUNGEN.map((m) => m.art));

/** Zerlegt einen Nachrichtentext in Formatierungsknoten. */
export function formatierungParsen(text: string): FormatKnoten[] {
  const v: Vorrechnung = {
    text,
    schluss: new Map(MARKIERUNGEN.map((m) => [m.art, naechsterSchluss(text, m.zeichen)])),
    zeile: naechsteZeile(text),
  };
  const knoten: FormatKnoten[] = [];
  // Erst die Blöcke: ```…``` gewinnt gegen alles andere, auch über Zeilen.
  let i = 0;
  while (i < text.length) {
    const auf = text.indexOf('```', i);
    if (auf < 0) break;
    const zu = text.indexOf('```', auf + 3);
    if (zu < 0 || zu === auf + 3) break;
    knoten.push(...inline(v, i, auf, ALLE));
    // Ein Zeilenumbruch direkt nach dem Öffnen und vor dem Schluss gehört zur
    // Markierung, nicht zum Inhalt.
    knoten.push({ art: 'block', text: text.slice(auf + 3, zu).replace(/^\n/, '').replace(/\n$/, '') });
    i = zu + 3;
  }
  knoten.push(...inline(v, i, text.length, ALLE));
  return knoten;
}

/** Was ein Spoiler in einer Vorschau zeigt: dass da etwas ist, nicht was. */
export const SPOILER_ERSATZ = '▒▒▒';

/** Der Text ohne Markierungen – für Vorschauen in Liste und Mitteilung. */
export function knotenAlsText(knoten: FormatKnoten[]): string {
  let aus = '';
  for (const k of knoten) {
    if (k.art === 'text' || k.art === 'mono' || k.art === 'block') aus += k.text;
    else if (k.art === 'spoiler') aus += SPOILER_ERSATZ;
    else aus += knotenAlsText(k.kinder);
  }
  return aus;
}

export function ohneFormatierung(text: string): string {
  return knotenAlsText(formatierungParsen(text));
}

/** Ob überhaupt etwas formatiert ist – erspart dem Renderer die Arbeit. */
export function hatFormatierung(text: string): boolean {
  return /[*_~`|]/.test(text);
}
