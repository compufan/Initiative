/**
 * Adressen, Koordinaten und Links im Ort eines Termins erkennen.
 *
 * # Warum im Gerät und aus dem Text
 *
 * Der Ort bleibt, was er immer war: ein freier Text am Termin. Server,
 * Schema und Kalender-Abo ändern sich nicht. Die Erkennung läuft bei jedem
 * Anzeigen im Gerät – damit sehen alle Eingeladenen denselben Link, der
 * Altbestand wirkt sofort, und es braucht weder ein Netz noch eine
 * Geokodierung. Was die Karten-App daraus macht, entscheidet jeder selbst
 * (siehe `karten.ts`).
 *
 * # Warum eine Näherung und keine Gewissheit
 *
 * Ohne Verzeichnis der Postleitzahlen und Strassen lässt sich „12345 Berlin“
 * nicht von „12345 Besucher“ trennen. Deshalb drei Stufen (`Sicherheit`):
 *
 * - `sicher`: Strasse und Nummer mit Ort, oder mit eindeutigem Strassenwort
 *   (`-strasse`, `-weg`, `Rue …`), oder eine Koordinate.
 * - `vermutlich`: schwache Strassenwörter ohne Ort („Am Markt“-artig), oder
 *   eine fünfstellige Postleitzahl mit Ort allein.
 * - `offen`: nichts davon. Die Oberfläche bietet dann nur das gedämpfte „Auf
 *   Karte suchen“ an – wer einen Ort nicht erkannt bekommt, verliert nichts.
 *
 * Ein falscher Link kostet höchstens einen Tipp; ein fehlender niemanden die
 * Adresse, denn der Text steht ja da.
 *
 * # Aufbau
 *
 * Web-Adressen zuerst, dann Koordinaten, dann Strassen und Postleitzahlen.
 * Jede Stufe MASKIERT, was sie gefunden hat, damit die nächste nicht in
 * Webadressen oder Koordinaten nach Hausnummern sucht. Alle Muster sind ohne
 * verschachtelte Wiederholungen gebaut: Die Eingabe ist auf 300 Zeichen
 * begrenzt, und ein Ort, der die Seite einfriert, wäre ein Angriff auf alle
 * Eingeladenen.
 */
import type { Ziel } from './karten.js';

export type Sicherheit = 'sicher' | 'vermutlich' | 'offen';

/** Wie lang der Ort höchstens ist – dieselbe Grenze wie am Schema. */
export const MAX_ORT = 300;

interface FundBasis {
  /** Beginn und Ende (ohne) im normalisierten Text. */
  von: number;
  bis: number;
  text: string;
}

export interface WebFund extends FundBasis {
  art: 'web';
  /** Die geprüfte Adresse (`new URL(…).href`) – nur http und https, ohne Zugangsdaten. */
  url: string;
  /** Was angezeigt wird: Host und Pfad, aus der Adresse abgeleitet und gekürzt. */
  anzeige: string;
}

export interface AdressFund extends FundBasis {
  art: 'adresse';
  sicherheit: 'sicher' | 'vermutlich';
  /** Der Adresskern, der an die Karten-App geht: ohne Namen, Etage und Klammerzusätze. */
  suche: string;
  /** Was fehlt – für den Hinweis im Editor. */
  luecke: 'ort' | 'strasse' | null;
}

export interface PunktFund extends FundBasis {
  art: 'koordinate';
  breite: number;
  laenge: number;
}

export type Fund = WebFund | AdressFund | PunktFund;
export type KartenFund = AdressFund | PunktFund;
/** Der Text als lückenlose Folge: zusammengesetzt ergeben die Stücke wieder den Text. */
export type Stueck = { art: 'text'; text: string } | Fund;

export interface OrtAnalyse {
  /** Getrimmt, Leerraum zusammengefasst, höchstens `MAX_ORT` Zeichen. */
  text: string;
  /** Die stärkste Stufe aller Karten-Funde. Web-Adressen zählen nicht. */
  sicherheit: Sicherheit;
  stuecke: Stueck[];
  /**
   * Der Karten-Fund mit der höchsten Stufe, bei Gleichstand der erste im
   * Text. Nach ihm richten sich `ziel` und der Hinweis im Editor.
   */
  hauptfund: KartenFund | null;
  /** Das Ziel des Hauptfundes, sonst der bereinigte Suchtext, sonst nichts. */
  ziel: Ziel | null;
  /** Enthält Links und sonst nichts Kartierbares (Zoom, Teams, Meet). */
  nurWeb: boolean;
}

/* ---------- Bausteine der Muster ---------- */

const NAME = String.raw`[\p{L}'’-]`;
const KAP = String.raw`\p{Lu}${NAME}*`;

/*
 * Wortgrenzen mit Rückwärtssuche statt `\b`: In JavaScript ist `\b` auch mit
 * dem Flag `u` auf ASCII beschränkt – „ß“ und „ä“ gelten dort als
 * Nicht-Wortzeichen, und „Straße“ bekäme mitten im Wort eine Grenze.
 */
const WORTANFANG = String.raw`(?<![\p{L}\d])`;

/**
 * Hausnummer: `5`, `5a`, `12-14`, `12 - 14`, `12/3/7`.
 *
 * Nicht gefolgt von Ziffer, Buchstabe, `.5` oder `:30` (Uhrzeit, Datum) und
 * nicht von einem Wort, das aus der Zahl eine Menge macht: „Hauptstr. 5
 * Personen“ ist keine Adresse. Die Obergrenze eines Bereichs hat höchstens
 * drei Ziffern, damit „Hauptstr. 5 - 1010 Wien“ als Nummer 5 und
 * Postleitzahl 1010 gelesen wird und nicht als „5-1010“.
 */
const HAUSNUMMER = String.raw`(?<![\d\p{L}])\d{1,4}[a-zA-Z]?(?:\s?[-–/]\s?\d{1,3}[a-zA-Z]?){0,2}(?![\d\p{L}])(?![.:]\d)(?!\s*(?:Uhr\b|h\b|Min|Std|Stunden|Minuten|Personen|Leute|Euro|€|%|Tage|Jahre|Wochen|Kinder|Gäste|Teilnehmer|Mal\b))`;

const STRASSEN_ENDEN = String.raw`(?:straße|strasse|str\.|str(?![\p{L}])|weg|allee|gasse|platz|ring|damm|ufer|chaussee|steig|pfad|stieg|zeile|promenade|kai|lände|graben|gässchen|brücke|gracht|straat|laan|plein|kade|singel)`;

/**
 * Zusammengesetzte Wörter, die auf `-platz` oder `-weg` enden und keine
 * Strasse sind. Jede Zeile ist durch einen Test belegt; die Liste ist
 * lückenhaft (Festplatz, Lagerplatz), und die Lücken stehen als „bekannte
 * Grenze“ im Test, damit niemand sie „repariert“ und Besseres kaputt macht.
 */
const SPERRE_ZUSAMMENGESETZT =
  /^(?:park|stell|sitz|arbeits|stand|liege|zelt|camping|spiel|sport|grill|um|rück|heim|aus|vor|ab)(?:platz|weg)$/i;

const TITEL = String.raw`(?:(?:Dr|Prof|St|Hl|Ing)\.[-\s]?)?`;

/** Beiwörter, die vor einer zusammengesetzten Strasse stehen („Alte Landstraße“). */
const BEIWORT = String.raw`(?:Alte[rnms]?|Neue[rnms]?|Gro(?:ß|ss)e[rnms]?|Kleine[rnms]?|Lange[rnms]?|Breite[rnms]?|Obere[rnms]?|Untere[rnms]?|Hohe[rnms]?|Hintere[rnms]?|Vordere[rnms]?|Heilige[rnms]?)`;

const PRAEPOSITION = String.raw`(?:Am|An der|An den|An dem|Auf dem|Auf der|Auf den|Im|In der|In den|Zum|Zur|Zu den|Unter den|Unter der|Hinter dem|Vor dem|Bei der|Beim|Über dem)`;

/**
 * Namen, die nach einer Präposition oder einem Beiwort KEINE Strasse
 * einleiten: „Am Montag 12 Uhr“, „Im Raum 5“, „Am Wochenende 3 Stunden“.
 */
const KEIN_STRASSENNAME = String.raw`(?:Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag|Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember|Raum|Saal|Zimmer|Haus|Gebäude|Stock|Etage|Tisch|Gleis|Tor|Halle|Stand|Beispiel|Anfang|Ende|Wochenende|Abend|Morgen|Mittag|Moment|Treffen)`;

const TYPEN_VORN = String.raw`(?:Straße|Strasse|Platz|Weg|Allee|Ufer|Damm|Gasse|Ring|Markt|Brücke|Rue|Avenue|Boulevard|Chemin|Place|Route|Impasse|Quai|Via|Viale|Piazza|Corso|Largo|Vicolo|Strada|Calle|Carrer|Avenida|Plaza|Paseo|Rua|Praça|Ulica|Straat|Laan|Plein)`;
const PARTIKEL = String.raw`(?:(?:de la|de l'|de l’|du|des|de|di|del|della|dei|da|do|van|von|vom|zum|zur|an der|am|der|die|das|dem|des|d'|d’)\s+)`;

const TYPEN_HINTEN = String.raw`(?:Straße|Strasse|Str\.|Allee|Platz|Weg|Ring|Damm|Ufer|Gasse|Chaussee|Graben|Markt|Brücke|Zeile|Steig|Pfad)`;

/** Typwörter, die allein als ganzer Strassenname stehen („Graben 20“) – nur mit Ort dahinter. */
const NACKTE_TYPEN = String.raw`(?:Graben|Markt|Ring|Kai|Damm|Ufer|Zeile|Anger|Platz|Weg|Gasse|Allee|Straße|Strasse|Chaussee|Promenade|Brücke|Steig|Pfad)`;

const EN_TYP = String.raw`(?:Street|St\.?|Road|Rd\.?|Avenue|Ave\.?|Lane|Ln\.?|Drive|Court|Boulevard|Blvd\.?|Way|Square|Close|Terrace|Place|Crescent|Highway|Parkway)(?![\p{L}])`;
const FR_TYP = String.raw`(?:rue|avenue|av\.|boulevard|bd\.?|chemin|place|route|impasse|quai|allée|cours|passage|square|ruelle)`;

/**
 * Was als Ort nach einer Postleitzahl NICHT in Frage kommt: Zahlwörter und
 * Zeitangaben („12345 Besucher“, „2025 Mai“). Die häufigsten, nicht alle –
 * ohne Ortsverzeichnis gibt es keine vollständige Liste.
 */
const SPERRE_ORT =
  /^(?:Uhr|Euro|EUR|Teilnehmer|Personen|Besucher|Gäste|Kinder|Mitglieder|Minuten|Stunden|Meter|Kilometer|Mann|Leute|Plätze|Stück|Jahre|Tage|Wochen|Prozent|Dollar|Schüler|Zuschauer|Fans|Läufer|Cent|Punkte|Mal|Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag|Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)$/i;

/** Wörter, die nach „Strasse 5, …“ KEIN Ortsname sind, sondern Beiwerk. */
const KEIN_ORTSNAME = new RegExp(
  String.raw`^(?:${KEIN_STRASSENNAME}|Hinterhaus|Vorderhaus|Hinterhof|Erdgeschoss|Eingang|Aufgang|Büro|Praxis|Keller|Garten)$`,
  'i',
);

const ORTS_VORSILBE = String.raw`(?:Bad|Sankt|St\.|Neu|Alt|Gro(?:ß|ss)|Klein|Ober|Unter|Nieder|Hohen|Schwäbisch|Königs|Lutherstadt|Hansestadt)`;

const LAENDER = String.raw`(?:Deutschland|Germany|Österreich|Austria|Schweiz|Switzerland|Suisse|Svizzera|Italien|Italia|Frankreich|France|Niederlande|Nederland|Belgien|Luxemburg|Dänemark|Polen|Tschechien)`;

/**
 * Zwischen Strasse und Postleitzahl darf Beiwerk stehen, das nicht an die
 * Karte geht: Etage, Aufgang, Raum, ein Klammerzusatz. Der Link liegt trotzdem über der ganzen
 * Adresse, wie der Mensch sie geschrieben hat.
 */
const BEIWERK = String.raw`^(?:[\s,;–-]*(?:\d{1,2}\.?\s*(?:OG|Stock|Etage|Obergeschoss)|[EU]G|Hinterhaus|Vorderhaus|Aufgang\s*\w|Haus\s*\w|Raum\s*[\d.]+|Zimmer\s*[\d.]+|Eingang\s*\w|\([^()]{1,40}\)))*[\s,;–-]*$`;

/* ---------- Das Regelwerk, erst beim ersten Gebrauch gebaut ---------- */

interface StrassenRegel {
  id: 'zusammengesetzt' | 'zweiwort' | 'vorn' | 'praeposition' | 'beiwort' | 'nackt' | 'en' | 'fr';
  stark: boolean;
  /** Gilt nur, wenn Ort oder Postleitzahl folgt (sonst wäre „Weg 3“ eine Adresse). */
  nurMitOrt: boolean;
  muster: RegExp;
}

interface Regeln {
  web: RegExp;
  strassen: StrassenRegel[];
  beiwortDavor: RegExp;
  plzOrt: RegExp;
  beiwerk: RegExp;
  land: RegExp;
  ortsnameNachStrasse: RegExp;
  dezimal: RegExp;
  dezimalkomma: RegExp;
  himmelsrichtung: RegExp;
  himmelsrichtungVorn: RegExp;
  gradMinutenSekunden: RegExp;
  gradMinuten: RegExp;
}

function baueRegeln(): Regeln {
  const baue = (muster: string, flags: string) => new RegExp(muster, flags);
  const erlaubterName = (name: string) =>
    String.raw`(?:(?!${KEIN_STRASSENNAME}(?![\p{L}]))${name})`;
  return {
    /*
     * Web-Adressen: mit Schema oder `www.`, dazu bloss die Besprechungsdienste
     * ohne Schema. Nackte Domains („beispiel.de“) bleiben Text: „z.B.“ oder
     * „2.14“ sähen sonst aus wie Adressen.
     */
    web: baue(
      String.raw`(?<![\p{L}\d])https?:\/\/[^\s<>"]+|(?<![\p{L}\d@./:-])www\.[^\s<>"]+|(?<![\p{L}\d@./-])(?:[\p{L}\d-]+\.)?(?:zoom\.us|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|whereby\.com|meet\.jit\.si|webex\.com|discord\.gg)(?:\/[^\s<>"]*)?`,
      'giu',
    ),
    strassen: [
      {
        id: 'zusammengesetzt',
        stark: true,
        nurMitOrt: false,
        muster: baue(
          String.raw`${WORTANFANG}${TITEL}${NAME}{3,}?${STRASSEN_ENDEN}\s*${HAUSNUMMER}`,
          'giu',
        ),
      },
      {
        id: 'zweiwort',
        stark: true,
        nurMitOrt: false,
        muster: baue(
          String.raw`${WORTANFANG}(?:${KAP}\s+){1,2}${TYPEN_HINTEN}\s*${HAUSNUMMER}`,
          'gu',
        ),
      },
      {
        // Ohne `i`: Mit dem Flag trifft `\p{Lu}` auch Kleinbuchstaben, und
        // „Weg nach Hause 3“ wäre eine Strasse. Die kleingeschriebenen
        // französischen Typwörter stehen im eigenen Muster `fr`.
        id: 'vorn',
        stark: true,
        nurMitOrt: false,
        muster: baue(
          String.raw`${WORTANFANG}${TYPEN_VORN}\s+${PARTIKEL}?(?:\d{1,2}\.\s+)?${KAP}(?:\s+${KAP}){0,2}\s*${HAUSNUMMER}`,
          'gu',
        ),
      },
      {
        id: 'praeposition',
        stark: false,
        nurMitOrt: false,
        muster: baue(
          String.raw`${WORTANFANG}${PRAEPOSITION}\s+${erlaubterName(KAP)}(?:\s+${erlaubterName(KAP)}){0,2}\s+${HAUSNUMMER}`,
          'gu',
        ),
      },
      {
        id: 'beiwort',
        stark: false,
        nurMitOrt: false,
        muster: baue(
          String.raw`${WORTANFANG}${BEIWORT}\s+${erlaubterName(KAP)}(?:\s+${KAP})?\s+${HAUSNUMMER}`,
          'gu',
        ),
      },
      {
        id: 'nackt',
        stark: false,
        nurMitOrt: true,
        muster: baue(String.raw`${WORTANFANG}${NACKTE_TYPEN}\s+${HAUSNUMMER}`, 'gu'),
      },
      {
        id: 'en',
        stark: true,
        nurMitOrt: false,
        muster: baue(
          String.raw`${WORTANFANG}\d{1,5}[a-zA-Z]?\s+(?:\p{Lu}[\p{L}'’.-]*\s+){1,3}${EN_TYP}`,
          'gu',
        ),
      },
      {
        id: 'fr',
        stark: true,
        nurMitOrt: false,
        muster: baue(
          String.raw`${WORTANFANG}\d{1,4}(?:bis|ter)?,?\s+${FR_TYP}\s+(?:(?:de la|de l'|de l’|du|des|de)\s+)?\p{L}${NAME}*(?:\s+\p{L}${NAME}*){0,2}`,
          'giu',
        ),
      },
    ],
    // Ohne `i`: Mit dem Flag liesse `[A-Z]{2}` (niederländische Postleitzahl,
    // „1015 CJ“) auch „2025 in Berlin“ als Postleitzahl „2025 in“ durch.
    plzOrt: baue(
      String.raw`(?<![\p{L}\d.,/+-])(?:(?<land>D|DE|A|AT|CH|L|FL|I|F|B|NL)\s?[-–]\s?)?(?<plz>\d{5}|\d{4}(?:\s?[A-Z]{2})?)(?![\d.,]\d)\s+(?<ort>(?:${ORTS_VORSILBE}[\s-])?\p{L}[\p{L}'’.-]*(?:\s+(?:am|im|an der|bei|ob der|in|vor der|unter)\s+\p{Lu}[\p{L}'’-]*)?)`,
      'gu',
    ),
    // Nicht nur Adjektive wie „Alte“: Ein Beiwort auf -er („Peter Hauptstr. 5“)
    // würde Namen vor einer Adresse in die Adresse ziehen.
    beiwortDavor: baue(String.raw`${WORTANFANG}${BEIWORT}\s+$`, 'u'),
    beiwerk: baue(BEIWERK, 'iu'),
    land: baue(String.raw`^\s*,\s*(${LAENDER})(?![\p{L}])`, 'iu'),
    ortsnameNachStrasse: baue(
      String.raw`^\s*,\s*(\p{Lu}[\p{L}'’-]+(?:\s+(?:am|im|an der|bei)\s+\p{Lu}[\p{L}'’-]+)?)(?=\s*(?:[,;(]|$))`,
      'u',
    ),
    // Dezimal mit Punkt, beide mindestens drei, eine mindestens vier
    // Nachkommastellen: schliesst „12.30, 14.45“ und „1.500, 2.500“ aus.
    dezimal: baue(
      String.raw`(?<![\d.,])([+-]?\d{1,2}\.\d{3,8})(?:\s*[,;/]\s*|\s+)([+-]?\d{1,3}\.\d{3,8})(?![\d.])`,
      'gu',
    ),
    // Dezimalkomma nur mit Semikolon oder Schrägstrich dazwischen: Ein Komma
    // trennt in „48,1371, 11,5754“ nicht erkennbar Zahl von Zahl.
    dezimalkomma: baue(
      String.raw`(?<![\d.,])([+-]?\d{1,2},\d{4,8})\s*[;/]\s*([+-]?\d{1,3},\d{4,8})(?![\d,])`,
      'gu',
    ),
    himmelsrichtung: baue(
      String.raw`(\d{1,2}(?:[.,]\d+)?)\s*°?\s*([NS])[,;\s]+(\d{1,3}(?:[.,]\d+)?)\s*°?\s*([EOW])(?![\p{L}])`,
      'gu',
    ),
    himmelsrichtungVorn: baue(
      String.raw`(?<![\p{L}])([NS])\s*(\d{1,2}(?:[.,]\d+)?)\s*°?[,;\s]+([EOW])\s*(\d{1,3}(?:[.,]\d+)?)\s*°?`,
      'gu',
    ),
    gradMinutenSekunden: baue(
      String.raw`(\d{1,2})\s*[°º]\s*(\d{1,2})\s*['’′]\s*(\d{1,2}(?:[.,]\d+)?)\s*(?:["”″]|''|’’)\s*([NS])[,;\s]+(\d{1,3})\s*[°º]\s*(\d{1,2})\s*['’′]\s*(\d{1,2}(?:[.,]\d+)?)\s*(?:["”″]|''|’’)\s*([EOW])`,
      'gu',
    ),
    gradMinuten: baue(
      String.raw`(\d{1,2})\s*[°º]\s*(\d{1,2}(?:[.,]\d+)?)\s*['’′]\s*([NS])[,;\s]+(\d{1,3})\s*[°º]\s*(\d{1,2}(?:[.,]\d+)?)\s*['’′]\s*([EOW])`,
      'gu',
    ),
  };
}

/**
 * `undefined`: noch nicht gebaut. `null`: Bauen gescheitert.
 *
 * Das Regelwerk entsteht erst beim ersten Aufruf und nicht beim Laden des
 * Moduls: Ein Browser ohne Rückwärtssuche würde sonst die ganze App beim
 * Start mit einem Syntaxfehler abbrechen. So wird aus dem Fehler „kein Fund“
 * – eine Karte, die nicht aufgeht, ist besser als eine App, die nicht
 * aufgeht.
 */
let regeln: Regeln | null | undefined;

function regelwerk(): Regeln | null {
  if (regeln !== undefined) return regeln;
  try {
    regeln = baueRegeln();
  } catch {
    regeln = null;
  }
  return regeln;
}

/* ---------- Hilfen ---------- */

/** Getrimmt, Leerraum zusammengefasst, auf `MAX_ORT` gekürzt (ohne ein Surrogatpaar zu teilen). */
function normalisieren(ort: string | null | undefined): string {
  if (typeof ort !== 'string') return '';
  let text = ort.replace(/\s+/g, ' ').trim();
  if (text.length > MAX_ORT) {
    let ende = MAX_ORT;
    const letzter = text.charCodeAt(ende - 1);
    if (letzter >= 0xd800 && letzter <= 0xdbff) ende -= 1;
    text = text.slice(0, ende).trim();
  }
  return text;
}

/**
 * Ersetzt eine Spanne, ohne die Längen zu verschieben. Das Zeichen ist kein
 * Leerraum, kein Buchstabe und keine Ziffer: Weder `\s*` noch eine Wortgrenze
 * reicht über die Stelle hinweg, ein Fund kann sie also nie überspannen.
 */
const MASKE = '\u0000';

function maskieren(text: string, von: number, bis: number): string {
  return text.slice(0, von) + MASKE.repeat(bis - von) + text.slice(bis);
}

function dezimal(zahl: string): number {
  return Number(zahl.replace(',', '.'));
}

function kuerzen(text: string, grenze: number): string {
  return text.length > grenze ? `${text.slice(0, grenze - 1)}…` : text;
}

/* ---------- Web-Adressen ---------- */

function webFunde(text: string, regel: Regeln): WebFund[] {
  const funde: WebFund[] = [];
  for (const treffer of text.matchAll(regel.web)) {
    let roh = treffer[0];
    // Satzzeichen am Ende gehören zum Satz, nicht zur Adresse. Eine
    // schliessende Klammer nur, wenn sie keine öffnende vor sich hat
    // („https://example.org/a_(b).“ behält „(b)“).
    for (;;) {
      const letztes = roh.slice(-1);
      if (/[.,;:!?'"»”]/.test(letztes)) {
        roh = roh.slice(0, -1);
      } else if (
        letztes === ')' &&
        (roh.match(/\(/g) ?? []).length < (roh.match(/\)/g) ?? []).length
      ) {
        roh = roh.slice(0, -1);
      } else {
        break;
      }
    }
    if (roh.length === 0) continue;
    let url: URL;
    try {
      url = new URL(/^https?:\/\//i.test(roh) ? roh : `https://${roh}`);
    } catch {
      continue;
    }
    // Nur Web. `javascript:`, `data:`, `intent:`, `file:` und `ftp:` werden
    // nie zum Link – schon die Muster oben lassen sie nicht durch, das hier
    // ist der zweite Riegel.
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    // `https://bank.de@fremd.example` zeigt vorn einen Namen und führt zu
    // einem anderen Rechner: Täuschung. Wer so schreibt, bekommt keinen Link.
    if (url.username || url.password) continue;
    if (!url.hostname.includes('.')) continue;
    const pfad = url.pathname === '/' ? '' : url.pathname;
    funde.push({
      art: 'web',
      von: treffer.index,
      bis: treffer.index + roh.length,
      text: roh,
      url: url.href,
      // Aus der Adresse abgeleitet, nicht aus dem Text: So kann die Anzeige
      // nicht etwas anderes behaupten, als der Link tut.
      anzeige: kuerzen(`${url.host}${pfad}`, 40),
    });
  }
  return funde;
}

/* ---------- Koordinaten ---------- */

function koordinatenFunde(text: string, regel: Regeln): PunktFund[] {
  const funde: PunktFund[] = [];
  const hinzu = (treffer: RegExpMatchArray, breite: number, laenge: number) => {
    if (Math.abs(breite) > 90 || Math.abs(laenge) > 180) return;
    const von = treffer.index ?? 0;
    funde.push({
      art: 'koordinate',
      von,
      bis: von + treffer[0].length,
      text: treffer[0],
      breite,
      laenge,
    });
  };
  const stellen = (zahl: string) => (zahl.split('.')[1] ?? '').length;

  for (const t of text.matchAll(regel.dezimal)) {
    if (Math.max(stellen(t[1]), stellen(t[2])) < 4) continue;
    hinzu(t, Number(t[1]), Number(t[2]));
  }
  for (const t of text.matchAll(regel.dezimalkomma)) hinzu(t, dezimal(t[1]), dezimal(t[2]));
  for (const t of text.matchAll(regel.himmelsrichtung)) {
    hinzu(t, dezimal(t[1]) * (t[2] === 'S' ? -1 : 1), dezimal(t[3]) * (t[4] === 'W' ? -1 : 1));
  }
  for (const t of text.matchAll(regel.himmelsrichtungVorn)) {
    hinzu(t, dezimal(t[2]) * (t[1] === 'S' ? -1 : 1), dezimal(t[4]) * (t[3] === 'W' ? -1 : 1));
  }
  for (const t of text.matchAll(regel.gradMinutenSekunden)) {
    // Minuten und Sekunden unter 60: „48°75'“ ist keine Koordinate.
    if (Number(t[2]) >= 60 || dezimal(t[3]) >= 60 || Number(t[6]) >= 60 || dezimal(t[7]) >= 60) {
      continue;
    }
    const breite =
      (Number(t[1]) + Number(t[2]) / 60 + dezimal(t[3]) / 3600) * (t[4] === 'S' ? -1 : 1);
    const laenge =
      (Number(t[5]) + Number(t[6]) / 60 + dezimal(t[7]) / 3600) * (t[8] === 'W' ? -1 : 1);
    hinzu(t, breite, laenge);
  }
  for (const t of text.matchAll(regel.gradMinuten)) {
    if (dezimal(t[2]) >= 60 || dezimal(t[5]) >= 60) continue;
    hinzu(
      t,
      (Number(t[1]) + dezimal(t[2]) / 60) * (t[3] === 'S' ? -1 : 1),
      (Number(t[4]) + dezimal(t[5]) / 60) * (t[6] === 'W' ? -1 : 1),
    );
  }
  return ohneUeberlappung(funde);
}

/** Sortiert nach Beginn; was in einen früheren Fund hineinragt, fällt weg. */
function ohneUeberlappung<T extends { von: number; bis: number }>(funde: T[]): T[] {
  const geordnet = [...funde].sort((a, b) => a.von - b.von || b.bis - a.bis);
  const frei: T[] = [];
  let ende = -1;
  for (const fund of geordnet) {
    if (fund.von < ende) continue;
    frei.push(fund);
    ende = fund.bis;
  }
  return frei;
}

/* ---------- Strassen und Postleitzahlen ---------- */

interface Strasse {
  von: number;
  bis: number;
  stark: boolean;
  nurMitOrt: boolean;
}

interface PostleitzahlOrt {
  von: number;
  bis: number;
  land: string | null;
  plz: string;
  ort: string;
  gross: boolean;
}

function strassenFinden(text: string, regel: Regeln): Strasse[] {
  const gefunden: Strasse[] = [];
  for (const { id, stark, nurMitOrt, muster } of regel.strassen) {
    for (const treffer of text.matchAll(muster)) {
      let von = treffer.index ?? 0;
      if (id === 'zusammengesetzt') {
        const kern =
          treffer[0]
            .replace(/\s*\d.*$/, '')
            .split(/\s+/)
            .pop() ?? '';
        if (SPERRE_ZUSAMMENGESETZT.test(kern.replace(/\.$/, ''))) continue;
        // Das Beiwort davor („Alte Landstraße“) gehört zum Namen. Es wird
        // NACHTRÄGLICH davorgesetzt und nicht im Muster mitgesucht: Das Muster
        // läuft mit `i`, und dort träfe `\p{Lu}` auch „der“.
        const davor = regel.beiwortDavor.exec(text.slice(0, von));
        if (davor) von = davor.index;
      }
      gefunden.push({ von, bis: (treffer.index ?? 0) + treffer[0].length, stark, nurMitOrt });
    }
  }
  return gefunden;
}

function postleitzahlenFinden(text: string, regel: Regeln): PostleitzahlOrt[] {
  const gefunden: PostleitzahlOrt[] = [];
  for (const treffer of text.matchAll(regel.plzOrt)) {
    const gruppen = treffer.groups ?? {};
    const ort = gruppen.ort ?? '';
    if (SPERRE_ORT.test(ort.split(/\s+/)[0] ?? '')) continue;
    const von = treffer.index ?? 0;
    gefunden.push({
      von,
      bis: von + treffer[0].length,
      land: gruppen.land ?? null,
      plz: gruppen.plz ?? '',
      ort,
      gross: /^\p{Lu}/u.test(ort),
    });
  }
  return gefunden;
}

/**
 * Strassen und Postleitzahlen zu Adressen zusammenfassen.
 *
 * Eine Strasse nimmt die nächste Postleitzahl mit Ort dahinter mit, wenn
 * dazwischen nur Trenner und Beiwerk stehen; sonst einen Ortsnamen nach dem
 * Komma; dazu ein folgendes Land. `suche` entsteht aus den BESTANDTEILEN, das
 * Beiwerk fällt weg – die Spanne (`von`/`bis`) umfasst es trotzdem.
 */
function adressenFinden(arbeit: string, text: string, regel: Regeln): AdressFund[] {
  const strassen = strassenFinden(arbeit, regel).sort((a, b) => a.von - b.von);
  const postleitzahlen = postleitzahlenFinden(arbeit, regel);
  const benutzt = new Set<PostleitzahlOrt>();
  const belegt = (von: number, bis: number, adressen: { von: number; bis: number }[]) =>
    adressen.some((a) => von < a.bis && bis > a.von);
  const landNach = (position: number) => regel.land.exec(arbeit.slice(position));

  interface Roh {
    von: number;
    bis: number;
    suche: string;
    sicherheit: 'sicher' | 'vermutlich' | 'offen';
    luecke: 'ort' | 'strasse' | null;
  }
  const roh: Roh[] = [];

  for (const strasse of strassen) {
    if (belegt(strasse.von, strasse.bis, roh)) continue;
    let bis = strasse.bis;
    let ort: string | null = null;
    const plz = postleitzahlen.find(
      (kandidat) =>
        kandidat.von >= strasse.bis && regel.beiwerk.test(arbeit.slice(strasse.bis, kandidat.von)),
    );
    if (plz) {
      bis = plz.bis;
      ort = `${plz.plz} ${plz.ort}`;
      benutzt.add(plz);
    } else {
      const name = regel.ortsnameNachStrasse.exec(arbeit.slice(strasse.bis));
      if (name && !SPERRE_ORT.test(name[1]) && !KEIN_ORTSNAME.test(name[1])) {
        bis = strasse.bis + name[0].length;
        ort = name[1];
      }
    }
    // Ohne Ort gilt ein nacktes Typwort („Weg 3“) nicht als Adresse.
    if (strasse.nurMitOrt && !ort) continue;
    const land = landNach(bis);
    if (land) bis += land[0].length;
    const suche = [arbeit.slice(strasse.von, strasse.bis).trim(), ort, land ? land[1] : null]
      .filter(Boolean)
      .join(', ');
    roh.push({
      von: strasse.von,
      bis,
      suche,
      sicherheit: ort || strasse.stark ? 'sicher' : 'vermutlich',
      luecke: ort ? null : 'ort',
    });
  }

  for (const plz of postleitzahlen) {
    if (benutzt.has(plz) || !plz.gross) continue;
    if (belegt(plz.von, plz.bis, roh)) continue;
    let bis = plz.bis;
    const land = landNach(bis);
    if (land) bis += land[0].length;
    // Mit Ländervorsatz („A-1010 Wien“) ist es sicher. Fünfstellig allein
    // ist es vermutlich; vierstellig ohne Vorsatz sähe zu sehr nach einer
    // Jahreszahl aus („2025 Berlin Marathon“) und bleibt aussen vor.
    const fuenf = plz.plz.replace(/\s?[A-Z]{2}$/, '').length === 5 || /[A-Z]{2}$/.test(plz.plz);
    const sicherheit = plz.land ? 'sicher' : fuenf ? 'vermutlich' : 'offen';
    // Der Vorsatz bleibt im Text stehen, geht aber nicht an die Suche: Strenge
    // Suchen (OpenStreetMap) kennen „A-1010“ nicht, und der Ortsname trennt
    // ohnehin.
    roh.push({
      von: plz.von,
      bis,
      suche: [`${plz.plz} ${plz.ort}`, land ? land[1] : null].filter(Boolean).join(', '),
      sicherheit,
      luecke: 'strasse',
    });
  }

  return roh
    .filter((a): a is Roh & { sicherheit: 'sicher' | 'vermutlich' } => a.sicherheit !== 'offen')
    .sort((a, b) => a.von - b.von)
    .map((a) => ({
      art: 'adresse' as const,
      von: a.von,
      bis: a.bis,
      text: text.slice(a.von, a.bis),
      suche: a.suche,
      sicherheit: a.sicherheit,
      luecke: a.sicherheit === 'sicher' && a.luecke === 'strasse' ? null : a.luecke,
    }));
}

/* ---------- Suchtext für Orte ohne Adresse ---------- */

/**
 * Orte, die ausdrücklich keine sind: Besprechungsdienste, „zu Hause“, noch
 * offene Angaben. Dafür gibt es keinen „Auf Karte suchen“-Link – er suchte
 * nach „Zoom“.
 */
const OHNE_KARTE =
  /^(?:online|zoom|teams|meet|jitsi|webex|telefon(?:isch)?|per telefon|(?:tel|telefon|fon|handy|mobil)\.?:?\s*[\d\s+()/-]+|digital|virtuell|remote|video(?:call|konferenz)?|zu ?hause|daheim|bei (?:mir|dir|uns|euch)|bei (?:oma|opa|mama|papa|mutti|vati)|bei familie \S+|homeoffice|home office|tba|tbd|n\.? ?n\.?|noch offen|wird noch bekannt gegeben|folgt)\.?$/iu;

/**
 * Ein Schema statt eines Ortes („javascript:alert(1)“). Als Link wäre es
 * ohnehin harmlos – es ginge kodiert als Suchtext an die Karte –, aber ein
 * „Auf Karte suchen“ dahinter zu zeigen wäre ein Angebot, das niemand will.
 */
const FREMDES_SCHEMA = /^(?:javascript|vbscript|data|blob|file|ftp|intent|mailto|tel|sms)\s*:/i;

const BEIWERK_SEGMENT =
  /^(?:Raum|Zimmer|Saal|Etage|Stock|EG|UG|OG|Eingang|Ausgang|Gebäude|Haus)\b|^\d{1,2}\.\s*(?:OG|Stock|Etage)/iu;

/**
 * Was bei einem Ort ohne erkannte Adresse an die Karte ginge – oder `null`,
 * wenn es nichts zu suchen gibt.
 *
 * Streicht, was eine Suche in die Irre führt: Präfix („Treffpunkt:“), Links,
 * Klammerzusätze und Segmente mit Beiwerk (Raum, Eingang, Etage). „Stadtpark,
 * Eingang Nord“ wird zu „Stadtpark“.
 */
export function suchtextOffen(text: string, funde: readonly Fund[] = []): string | null {
  let rest = text.replace(/\s+/g, ' ').trim();
  // Die Spannen der Web-Funde gelten für den normalisierten Text, den auch
  // `ortAnalysieren` übergibt. Von hinten nach vorn, damit sie gültig bleiben.
  for (const fund of [...funde].sort((a, b) => b.von - a.von)) {
    if (fund.art === 'web') rest = rest.slice(0, fund.von) + rest.slice(fund.bis);
  }
  const praefix = /^(?:(?:Ort|Wo)\s*:|Treffpunkt(?![\p{L}])\s*:?)\s*/iu;
  rest = rest
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(praefix, '');
  const segmente = rest
    .split(/\s*[,;]\s*/)
    .map((segment) => segment.replace(praefix, '').trim())
    .filter((segment) => segment && !BEIWERK_SEGMENT.test(segment));
  rest = segmente
    .join(', ')
    .replace(/[:,;\s-]+$/, '')
    .trim();
  if ((rest.match(/\p{L}/gu) ?? []).length < 3) return null;
  if (OHNE_KARTE.test(rest) || FREMDES_SCHEMA.test(rest)) return null;
  return rest;
}

/* ---------- Die Analyse ---------- */

const RANG: Record<Sicherheit, number> = { offen: 0, vermutlich: 1, sicher: 2 };

function sicherheitVon(fund: KartenFund): Sicherheit {
  return fund.art === 'koordinate' ? 'sicher' : fund.sicherheit;
}

function zielVon(fund: KartenFund): Ziel {
  return fund.art === 'koordinate'
    ? { art: 'punkt', breite: fund.breite, laenge: fund.laenge }
    : { art: 'text', text: fund.suche };
}

function stueckeBauen(text: string, funde: Fund[]): Stueck[] {
  const stuecke: Stueck[] = [];
  let position = 0;
  for (const fund of funde) {
    if (fund.von > position) stuecke.push({ art: 'text', text: text.slice(position, fund.von) });
    stuecke.push(fund);
    position = fund.bis;
  }
  if (position < text.length) stuecke.push({ art: 'text', text: text.slice(position) });
  return stuecke;
}

/**
 * Den Ort eines Termins lesen. Rein, ohne Netz, ohne Zustand; wirft nie.
 *
 * `null`, `undefined`, Leerraum und Unlesbares ergeben „offen“ ohne Ziel.
 */
export function ortAnalysieren(ort: string | null | undefined): OrtAnalyse {
  const text = normalisieren(ort);
  const offen = (): OrtAnalyse => {
    const suche = text ? suchtextOffen(text) : null;
    return {
      text,
      sicherheit: 'offen',
      stuecke: text ? [{ art: 'text', text }] : [],
      hauptfund: null,
      ziel: suche ? { art: 'text', text: suche } : null,
      nurWeb: false,
    };
  };
  if (!text) return offen();

  const regel = regelwerk();
  if (!regel) return offen();

  let arbeit = text;
  const web = webFunde(arbeit, regel);
  for (const fund of web) arbeit = maskieren(arbeit, fund.von, fund.bis);

  const punkte = koordinatenFunde(arbeit, regel);
  for (const fund of punkte) arbeit = maskieren(arbeit, fund.von, fund.bis);

  const adressen = adressenFinden(arbeit, text, regel);

  // Die Spannen sind nach dem Maskieren überlappungsfrei; die letzte Prüfung
  // hält das fest, falls ein Muster einmal etwas Unerwartetes liefert – die
  // Stücke ergeben sonst nicht mehr den Text.
  const alle = ohneUeberlappung<Fund>([...web, ...punkte, ...adressen]);

  let hauptfund: KartenFund | null = null;
  for (const fund of alle) {
    if (fund.art === 'web') continue;
    if (!hauptfund || RANG[sicherheitVon(fund)] > RANG[sicherheitVon(hauptfund)]) hauptfund = fund;
  }

  let ziel: Ziel | null = hauptfund ? zielVon(hauptfund) : null;
  if (!ziel) {
    const suche = suchtextOffen(text, alle);
    if (suche) ziel = { art: 'text', text: suche };
  }

  return {
    text,
    sicherheit: hauptfund ? sicherheitVon(hauptfund) : 'offen',
    stuecke: stueckeBauen(text, alle),
    hauptfund,
    ziel,
    nurWeb: web.length > 0 && ziel === null,
  };
}
