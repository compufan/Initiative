/**
 * Emoji-Auswahl: Daten laden (erst bei Bedarf) und durchsuchen.
 *
 * Die Liste (`emojiDaten.json`, rund 760 Emoji, 38 KB) ist eine eigene
 * Zusammenstellung: deutsche Namen von Hand, englische aus der Unicode
 * Character Database (siehe Lizenzliste). Sie kommt als eigenes Stück der
 * App erst, wenn jemand die Auswahl öffnet – im Chat selbst kostet sie
 * nichts. Kein Abruf von fremden Servern.
 */

export interface EmojiKategorie {
  id: string;
  name: string;
  symbol: string;
}

export interface EmojiEintrag {
  emoji: string;
  kategorie: string;
  de: string;
  en: string;
}

export interface EmojiDaten {
  kategorien: EmojiKategorie[];
  emoji: EmojiEintrag[];
}

let geladen: Promise<EmojiDaten> | null = null;

export function emojiLaden(): Promise<EmojiDaten> {
  geladen ??= import('./emojiDaten.json').then((modul) => {
    const roh = (modul as { default: { kategorien: EmojiKategorie[]; emoji: string[][] } }).default;
    return {
      kategorien: roh.kategorien,
      emoji: roh.emoji.map(([emoji, kategorie, de, en]) => ({ emoji, kategorie, de, en })),
    };
  });
  return geladen;
}

/** Klein, ohne Umlaute und Akzente: „Bär“ findet auch „baer“ und „bar“. */
export function normalisieren(text: string): string {
  return text
    .toLocaleLowerCase('de')
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/**
 * Suchen nach deutschen und englischen Namen. Treffer am Wortanfang zuerst,
 * dann irgendwo im Namen. Mehrere Wörter müssen alle passen.
 */
export function emojiSuchen(eintraege: readonly EmojiEintrag[], suche: string): EmojiEintrag[] {
  const woerter = normalisieren(suche).split(/\s+/).filter(Boolean);
  if (woerter.length === 0) return [];
  const vorn: EmojiEintrag[] = [];
  const irgendwo: EmojiEintrag[] = [];
  for (const eintrag of eintraege) {
    const namen = normalisieren(`${eintrag.de} ${eintrag.en}`);
    const umlautlos = namen.replace(/ae/g, 'a').replace(/oe/g, 'o').replace(/ue/g, 'u');
    const passt = (wort: string) => namen.includes(wort) || umlautlos.includes(wort);
    if (!woerter.every(passt)) continue;
    const amAnfang = namen.split(/\s+/).some((teil) => teil.startsWith(woerter[0]));
    (amAnfang ? vorn : irgendwo).push(eintrag);
  }
  return [...vorn, ...irgendwo];
}

const ZULETZT_SCHLUESSEL = 'initiative:emoji-zuletzt';
const ZULETZT_MAX = 16;

/** Zuletzt benutzte Emoji – nur auf diesem Gerät. */
export function zuletztLesen(): string[] {
  try {
    const roh = localStorage.getItem(ZULETZT_SCHLUESSEL);
    const liste = roh ? (JSON.parse(roh) as unknown) : [];
    return Array.isArray(liste) ? liste.filter((e): e is string => typeof e === 'string') : [];
  } catch {
    return [];
  }
}

export function zuletztMerken(emoji: string): void {
  try {
    const liste = [emoji, ...zuletztLesen().filter((e) => e !== emoji)].slice(0, ZULETZT_MAX);
    localStorage.setItem(ZULETZT_SCHLUESSEL, JSON.stringify(liste));
  } catch {
    /* privater Modus – dann eben ohne */
  }
}
