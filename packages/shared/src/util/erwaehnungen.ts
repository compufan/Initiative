/**
 * @Erwähnungen: Erkennen beim Tippen, Vorschläge, Einfügen und Markieren.
 *
 * Im Text steht der Anzeigename („@Anna Müller“) – lesbar auch für alte
 * Fassungen der App und in Mitteilungen. Wen er meint, steht daneben in
 * `metadata.mentions` (Kennungen): Namen sind nicht eindeutig und können sich
 * ändern, Kennungen nicht. Beim Senden zählt nur, wessen „@Name“ noch im Text
 * steht (`erwaehnungenImText`) – wer eine Erwähnung wieder löscht, erwähnt
 * niemanden mehr.
 */

/** Was nach einem „@“ an der Schreibmarke steht. */
export interface ErwaehnungsAnfrage {
  /** Stelle des „@“. */
  start: number;
  /** Der Text nach dem „@“ bis zur Schreibmarke. */
  suche: string;
}

/** Höchstens so lang ist das, wonach nach einem „@“ gesucht wird. */
const SUCHE_MAX = 32;

/**
 * Steht die Schreibmarke gerade in einem „@…“? Das „@“ muss am Anfang oder
 * nach Leerraum stehen (sonst ist es eine E-Mail-Adresse), danach kein
 * Leerraum bis zur Marke.
 */
export function erwaehnungsAnfrage(text: string, marke: number): ErwaehnungsAnfrage | null {
  const vorher = text.slice(0, Math.max(0, Math.min(marke, text.length)));
  const at = vorher.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(vorher[at - 1]!)) return null;
  const suche = vorher.slice(at + 1);
  if (/\s/.test(suche) || suche.length > SUCHE_MAX) return null;
  return { start: at, suche };
}

export interface ErwaehnbarePerson {
  userId: string;
  name: string;
  username?: string;
}

/** Sonderziel „@alle“ (nur Admins in Gruppen). */
export const ALLE_KENNUNG = 'alle';

function normal(text: string): string {
  return text.toLocaleLowerCase('de').normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

/**
 * Vorschläge zu einer Suche: Anzeigename oder Benutzername, Wortanfang vor
 * Treffer mitten im Namen, höchstens `max`. Ich selbst stehe nicht darin.
 */
export function erwaehnungsVorschlaege(
  personen: ErwaehnbarePerson[],
  suche: string,
  ich: string | null,
  max = 8,
): ErwaehnbarePerson[] {
  const nadel = normal(suche);
  const bewertet: { person: ErwaehnbarePerson; rang: number }[] = [];
  for (const person of personen) {
    if (person.userId === ich) continue;
    const name = normal(person.name);
    const nutzer = normal(person.username ?? '');
    let rang = -1;
    if (nadel.length === 0) rang = 2;
    else if (name.startsWith(nadel) || nutzer.startsWith(nadel)) rang = 0;
    else if (name.split(/\s+/).some((wort) => wort.startsWith(nadel))) rang = 1;
    else if (name.includes(nadel) || nutzer.includes(nadel)) rang = 2;
    if (rang >= 0) bewertet.push({ person, rang });
  }
  bewertet.sort((a, b) => a.rang - b.rang || a.person.name.localeCompare(b.person.name, 'de'));
  return bewertet.slice(0, max).map((eintrag) => eintrag.person);
}

/** Setzt „@Name “ an die Stelle der Anfrage; liefert Text und neue Marke. */
export function erwaehnungEinfuegen(
  text: string,
  anfrage: ErwaehnungsAnfrage,
  name: string,
): { text: string; marke: number } {
  const ende = anfrage.start + 1 + anfrage.suche.length;
  const einsatz = `@${name} `;
  const danach = text.slice(ende).replace(/^ /, '');
  return {
    text: text.slice(0, anfrage.start) + einsatz + danach,
    marke: anfrage.start + einsatz.length,
  };
}

/** Steht „@Name“ als ganze Erwähnung im Text (nicht als Teil eines längeren Wortes)? */
function enthaeltErwaehnung(text: string, name: string): boolean {
  const suche = `@${name}`;
  let ab = text.indexOf(suche);
  while (ab >= 0) {
    const davor = ab === 0 ? ' ' : text[ab - 1]!;
    const danach = text[ab + suche.length] ?? ' ';
    if (/\s/.test(davor) && !/[\p{L}\p{N}_]/u.test(danach)) return true;
    ab = text.indexOf(suche, ab + 1);
  }
  return false;
}

/**
 * Die Kennungen derer, deren Erwähnung noch im Text steht – ohne Doppelte, in
 * der Reihenfolge der Auswahl, höchstens 50.
 */
export function erwaehnungenImText(text: string, gewaehlt: ErwaehnbarePerson[]): string[] {
  const ids: string[] = [];
  for (const person of gewaehlt) {
    if (person.userId === ALLE_KENNUNG || ids.includes(person.userId)) continue;
    if (enthaeltErwaehnung(text, person.name)) ids.push(person.userId);
  }
  return ids.slice(0, 50);
}

/** Steht „@alle“ im Text? */
export function alleErwaehnt(text: string): boolean {
  return enthaeltErwaehnung(text, 'alle');
}

export type ErwaehnungsStueck =
  | { art: 'text'; text: string }
  | { art: 'erwaehnung'; text: string; userId: string };

/**
 * Zerlegt einen Text in normale Stücke und Erwähnungen – für die Darstellung.
 * Gesucht wird nur nach den Namen der wirklich Erwähnten (aus
 * `metadata.mentions`), längste zuerst; ein „@Irgendwas“ ohne Kennung bleibt
 * gewöhnlicher Text.
 */
export function erwaehnungenZerlegen(
  text: string,
  erwaehnte: ErwaehnbarePerson[],
  alle = false,
): ErwaehnungsStueck[] {
  const namen = [...erwaehnte]
    .filter((p) => p.name.length > 0)
    .sort((a, b) => b.name.length - a.name.length);
  if (alle) namen.push({ userId: ALLE_KENNUNG, name: 'alle' });
  if (namen.length === 0) return [{ art: 'text', text }];
  const aus: ErwaehnungsStueck[] = [];
  let puffer = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '@' && (i === 0 || /\s/.test(text[i - 1]!))) {
      const treffer = namen.find((p) => {
        if (!text.startsWith(p.name, i + 1)) return false;
        const danach = text[i + 1 + p.name.length] ?? ' ';
        return !/[\p{L}\p{N}_]/u.test(danach);
      });
      if (treffer) {
        if (puffer) aus.push({ art: 'text', text: puffer });
        puffer = '';
        const stueck = `@${treffer.name}`;
        aus.push({ art: 'erwaehnung', text: stueck, userId: treffer.userId });
        i += stueck.length;
        continue;
      }
    }
    puffer += text[i];
    i += 1;
  }
  if (puffer) aus.push({ art: 'text', text: puffer });
  return aus;
}
