import type { PressenVerlaufPunkt } from '@initiative/shared';

/**
 * Reine Rechnung hinter der Pressen-Statistik: Reihen für die Diagramme,
 * gleitendes Mittel, Histogramm, Tageszeit und Wochentag, schöne Achsenwerte
 * und die deutschen Zahlen- und Datumsformate. Ohne Oberfläche, damit sich
 * jede Zahl prüfen lässt.
 *
 * WARUM der Client das rechnet und nicht der Server: Der Server liefert die
 * Läufe des gewählten Zeitraums (die jüngsten 600) samt ihren Kopfzahlen. Wie sie
 * im Diagramm liegen, hängt von der Anzeige ab (Zeitzone des Geräts für
 * Tageszeit und Wochentag, Fenster des gleitenden Mittels) und braucht keinen
 * zweiten Weg übers Netz.
 */

/* ---------- Auswahl ---------- */

export type Zeitraum = '7' | '30' | 'alles';
export const ZEITRAEUME: { wert: Zeitraum; text: string }[] = [
  { wert: '7', text: '7 Tage' },
  { wert: '30', text: '30 Tage' },
  { wert: 'alles', text: 'Alles' },
];

const TAG_MS = 24 * 60 * 60 * 1000;

/** Beginn des Zeitraums als RFC 3339; `undefined` bei „Alles“. */
export function zeitraumVon(zeitraum: Zeitraum, jetzt: Date = new Date()): string | undefined {
  if (zeitraum === 'alles') return undefined;
  return new Date(jetzt.getTime() - Number(zeitraum) * TAG_MS).toISOString();
}

export type Metrik = 'wertung' | 'zeit' | 'verschuettet';
export const METRIKEN: { wert: Metrik; text: string; einheit: string }[] = [
  { wert: 'wertung', text: 'Wertung', einheit: 's' },
  { wert: 'zeit', text: 'Zeit', einheit: 's' },
  { wert: 'verschuettet', text: 'Verschüttet', einheit: 'ml' },
];

/** Wert eines Laufs in der Einheit des Diagramms (Sekunden bzw. Milliliter). */
export function metrikWert(punkt: PressenVerlaufPunkt, metrik: Metrik): number {
  if (metrik === 'wertung') return punkt.wertungMs / 1000;
  if (metrik === 'zeit') return punkt.dauerMs / 1000;
  return punkt.verschuettetDezi / 10;
}

/* ---------- Reihen ---------- */

export interface Reihenpunkt {
  /** Laufnummer im Zeitraum, ab 1 (nach Zeit geordnet). */
  nr: number;
  gespieltAm: string;
  wert: number;
  /** Gleitendes Mittel an dieser Stelle. */
  mittel: number;
}

/**
 * Trailing-Mittel: Jeder Wert ist der Durchschnitt der letzten `fenster`
 * Werte (am Anfang entsprechend weniger). So sieht man die Richtung, ohne dass
 * ein Ausreißer die ganze Linie verschiebt.
 */
export function gleitendesMittel(werte: readonly number[], fenster: number): number[] {
  const breite = Math.max(1, Math.floor(fenster));
  const aus: number[] = [];
  let summe = 0;
  for (let i = 0; i < werte.length; i += 1) {
    summe += werte[i]!;
    if (i >= breite) summe -= werte[i - breite]!;
    aus.push(summe / Math.min(breite, i + 1));
  }
  return aus;
}

/**
 * Die Reihe fürs Liniendiagramm. Vorzeitig abgestellte Läufe bleiben draußen
 * (ihre Zeit und Wertung sagen nichts über das Können, sie würden die Skala
 * sprengen); die Nummer zählt trotzdem nur, was im Diagramm steht.
 */
export function reihe(
  verlauf: readonly PressenVerlaufPunkt[],
  metrik: Metrik,
  fenster = 5,
): Reihenpunkt[] {
  const imZiel = verlauf.filter((p) => !p.vorzeitig);
  const werte = imZiel.map((p) => metrikWert(p, metrik));
  const mittel = gleitendesMittel(werte, fenster);
  return imZiel.map((p, i) => ({
    nr: i + 1,
    gespieltAm: p.gespieltAm,
    wert: werte[i]!,
    mittel: mittel[i]!,
  }));
}

/* ---------- Histogramm ---------- */

export interface Klasse {
  von: number;
  bis: number;
  anzahl: number;
}

const BREITEN = [0.5, 1, 2, 2.5, 5, 10, 20, 30, 60];

/**
 * Teilt Werte (Sekunden) in gleich breite Klassen. Die Breite wird aus einer
 * Liste „runder“ Breiten so gewählt, dass es 4 bis 10 Klassen gibt; leere
 * Klassen zwischen den Werten bleiben stehen (sie gehören zur Verteilung).
 */
export function histogramm(werte: readonly number[], zielKlassen = 8): Klasse[] {
  if (werte.length === 0) return [];
  const klein = Math.min(...werte);
  const gross = Math.max(...werte);
  const spanne = Math.max(gross - klein, 0.001);
  const breite = BREITEN.find((b) => spanne / b <= zielKlassen) ?? BREITEN[BREITEN.length - 1]!;
  const start = Math.floor(klein / breite) * breite;
  // Der größte Wert liegt in der letzten Klasse, nicht in einer eigenen darüber.
  const anzahlKlassen = Math.max(1, Math.min(Math.ceil((gross - start) / breite + 1e-9), 200));
  const klassen: Klasse[] = Array.from({ length: anzahlKlassen }, (_, i) => ({
    von: Math.round((start + i * breite) * 1000) / 1000,
    bis: Math.round((start + (i + 1) * breite) * 1000) / 1000,
    anzahl: 0,
  }));
  for (const wert of werte) {
    const i = Math.min(anzahlKlassen - 1, Math.max(0, Math.floor((wert - start) / breite)));
    klassen[i]!.anzahl += 1;
  }
  return klassen;
}

/* ---------- Tageszeit und Wochentag ---------- */

export interface Gruppe {
  schluessel: string;
  text: string;
  laeufe: number;
  /** Durchschnittliche Wertung (ms) der Läufe im Ziel; leer, wenn es keine gibt. */
  wertungMs: number | null;
}

function gruppiere(
  verlauf: readonly PressenVerlaufPunkt[],
  gruppen: { schluessel: string; text: string }[],
  zuordnen: (punkt: PressenVerlaufPunkt) => number,
): Gruppe[] {
  const summen = gruppen.map(() => ({ laeufe: 0, summe: 0, imZiel: 0 }));
  for (const p of verlauf) {
    const s = summen[zuordnen(p)]!;
    s.laeufe += 1;
    if (!p.vorzeitig) {
      s.summe += p.wertungMs;
      s.imZiel += 1;
    }
  }
  return gruppen.map((g, i) => ({
    ...g,
    laeufe: summen[i]!.laeufe,
    wertungMs: summen[i]!.imZiel > 0 ? summen[i]!.summe / summen[i]!.imZiel : null,
  }));
}

const WOCHENTAGE = [
  { schluessel: 'mo', text: 'Montag' },
  { schluessel: 'di', text: 'Dienstag' },
  { schluessel: 'mi', text: 'Mittwoch' },
  { schluessel: 'do', text: 'Donnerstag' },
  { schluessel: 'fr', text: 'Freitag' },
  { schluessel: 'sa', text: 'Samstag' },
  { schluessel: 'so', text: 'Sonntag' },
];

/** Läufe je Wochentag (Montag zuerst) in der Zeitzone des Geräts. */
export function nachWochentag(verlauf: readonly PressenVerlaufPunkt[]): Gruppe[] {
  // `getDay`: Sonntag = 0 → ans Ende der Woche.
  return gruppiere(verlauf, WOCHENTAGE, (p) => (new Date(p.gespieltAm).getDay() + 6) % 7);
}

const TAGESZEITEN = [
  { schluessel: 'nacht', text: 'Nacht (0–6 Uhr)' },
  { schluessel: 'morgen', text: 'Vormittag (6–12 Uhr)' },
  { schluessel: 'nachmittag', text: 'Nachmittag (12–18 Uhr)' },
  { schluessel: 'abend', text: 'Abend (18–24 Uhr)' },
];

/** Läufe je Tageszeit in der Zeitzone des Geräts. */
export function nachTageszeit(verlauf: readonly PressenVerlaufPunkt[]): Gruppe[] {
  return gruppiere(verlauf, TAGESZEITEN, (p) => Math.floor(new Date(p.gespieltAm).getHours() / 6));
}

/* ---------- Achsen ---------- */

/** „Schöne“ Achsenwerte (1, 2, 5 · 10ⁿ) von `min` bis `max`, etwa `anzahl` Stück. */
export function schoeneTicks(min: number, max: number, anzahl = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (max - min < 1e-9) return [min];
  const roh = (max - min) / Math.max(1, anzahl);
  const zehner = 10 ** Math.floor(Math.log10(roh));
  const faktor = [1, 2, 5, 10].find((f) => f * zehner >= roh) ?? 10;
  const schritt = faktor * zehner;
  const ticks: number[] = [];
  for (let t = Math.ceil(min / schritt) * schritt; t <= max + schritt * 1e-9; t += schritt) {
    ticks.push(Math.round(t / schritt) * schritt);
  }
  return ticks;
}

/** Lineare Abbildung eines Bereichs auf einen anderen (Achse nach Pixeln). */
export function skala(
  vonMin: number,
  vonMax: number,
  nachMin: number,
  nachMax: number,
): (wert: number) => number {
  const spanne = vonMax - vonMin;
  return (wert) =>
    spanne === 0
      ? (nachMin + nachMax) / 2
      : nachMin + ((wert - vonMin) / spanne) * (nachMax - nachMin);
}

/* ---------- Formate (deutsch) ---------- */

const zahlFormat = (stellen: number) =>
  new Intl.NumberFormat('de-DE', {
    minimumFractionDigits: stellen,
    maximumFractionDigits: stellen,
  });
const FORMATE = [zahlFormat(0), zahlFormat(1), zahlFormat(2)];

export const zahl = (wert: number, stellen: 0 | 1 | 2 = 0) => FORMATE[stellen]!.format(wert);
export const sekunden = (ms: number) => `${zahl(ms / 1000, 1)} s`;
export const milliliter = (dezi: number) => `${zahl(dezi / 10, 1)} ml`;
export const liter = (dezi: number) =>
  dezi >= 10_000 ? `${zahl(dezi / 10_000, 2)} l` : milliliter(dezi);
export const prozent = (anteil: number, stellen: 0 | 1 = 0) => `${zahl(anteil * 100, stellen)} %`;
export const mitVorzeichen = (ms: number) =>
  `${ms > 0 ? '+' : ms < 0 ? '−' : ''}${zahl(Math.abs(ms) / 1000, 1)} s`;

const datumFormat = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' });
const datumZeitFormat = new Intl.DateTimeFormat('de-DE', {
  dateStyle: 'medium',
  timeStyle: 'short',
});
export const datum = (iso: string) => datumFormat.format(new Date(iso));
export const datumZeit = (iso: string) => datumZeitFormat.format(new Date(iso));

/** Dauer insgesamt als „2 h 5 min“ oder „45 s“. */
export function dauerLang(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min ${s % 60} s`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

export const AUSGANG_TEXT: Record<string, string> = {
  sieg: 'Sieg',
  niederlage: 'Niederlage',
  atempo: 'Atempo',
  nicht_gewertet: 'Nicht gewertet',
};
export const MODUS_TEXT: Record<string, string> = {
  spiegel: 'Gegen den Spiegel',
  duell: 'Duell',
  ampel: 'Ampel',
  staffette: 'Staffette',
};
export const ART_TEXT: Record<string, string> = {
  echtzeit: 'Zusammen (Echtzeit)',
  asynchron: 'Wann ich will',
};
