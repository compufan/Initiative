/**
 * Ein GIF schreiben – damit ein Sticker sich bewegen kann.
 *
 * # Warum von Hand und warum überhaupt
 *
 * Bisher blieb ein bewegtes Bild nur dann bewegt, wenn es UNBERÜHRT
 * durchgereicht wurde: `bewegt.ts` erkennt es am Kopf, und das Studio schaltet
 * dann Kontur, Schatten und Freistellen ab. Sobald jemand etwas daran macht –
 * und darum geht man ins Studio –, wird aus dem bewegten Bild ein Standbild,
 * weil eine Leinwand genau ein Teilbild aufnimmt.
 *
 * Um das zu ändern, muss am Ende wieder eine Datei stehen, die sich bewegt.
 * Der Browser kann keine schreiben: `canvas.toBlob` kennt nur Standbilder,
 * WebCodecs kann bewegte Bilder lesen und nicht schreiben, und einen
 * bewegten WebP-Kodierer gibt es nirgends eingebaut. Ein `<video>` wäre keine
 * Antwort – ein Sticker steht in einem `<img>`.
 *
 * Bleibt GIF. Das Format ist von 1989 und vollständig beschrieben; das Patent
 * auf LZW (Unisys) ist 2004 abgelaufen, in allen Ländern. Es gibt also nichts
 * zu lizenzieren und nichts zu umgehen.
 *
 * # Was das Format kostet
 *
 * 256 Farben je Teilbild und Durchsichtigkeit nur als JA oder NEIN – keine
 * weichen Ränder. Für ein Foto wäre das zu wenig; für einen Sticker, der
 * ohnehin eine kräftige Kontur hat, ist es genau richtig. Wo ein weicher Rand
 * gebraucht wird, steht er als harter – und darum wird die Kontur beim
 * Freistellen nicht abgeschaltet, sondern hilft.
 *
 * # Der Aufbau
 *
 *   1. Aus allen Teilbildern EINE Farbtafel rechnen (Median-Schnitt).
 *   2. Jedes Teilbild auf Tafelplätze abbilden.
 *   3. Die Platznummern mit LZW packen.
 *   4. Kopf, Tafel, Schleifenvermerk und je Teilbild einen Block schreiben.
 *
 * Eine GEMEINSAME Tafel und nicht eine je Teilbild: Bei zwanzig Teilbildern
 * wären das zwanzig mal 768 Byte allein an Tafeln, und sie flackerten
 * gegeneinander – dieselbe Farbe bekäme in jedem Teilbild einen anderen
 * Platz und damit einen leicht anderen Ton.
 */

import { AbbruchError } from './engines/index.js';

/** Ein Teilbild samt seiner Standzeit. */
export interface Teilbild {
  daten: ImageData;
  /** Wie lange es steht, in Millisekunden. */
  dauerMs: number;
}

/**
 * Ab welcher Deckkraft ein Punkt als sichtbar gilt.
 *
 * GIF kennt keine Halbdurchsichtigkeit: Ein Punkt ist da oder nicht. Die
 * Schwelle liegt bei der Hälfte und nicht bei eins, weil ein weicher Rand
 * sonst vollständig verschwände und der Sticker eine Stufe kleiner wirkte.
 */
const DECKUNG_SCHWELLE = 128;

/* ---------- Farbtafel ---------- */

interface Kasten {
  /** Die Farben in diesem Kasten, als 0xRRGGBB. */
  farben: number[];
  /** Wie oft jede vorkommt – in derselben Reihenfolge. */
  haeufig: number[];
}

/** Die längste Seite eines Kastens und ihr Spannungsbereich. */
function laengsteSeite(kasten: Kasten): { kanal: number; spanne: number } {
  let beste = { kanal: 0, spanne: -1 };
  for (let kanal = 0; kanal < 3; kanal += 1) {
    let klein = 255;
    let gross = 0;
    for (const farbe of kasten.farben) {
      const wert = (farbe >> (16 - kanal * 8)) & 0xff;
      if (wert < klein) klein = wert;
      if (wert > gross) gross = wert;
    }
    const spanne = gross - klein;
    if (spanne > beste.spanne) beste = { kanal, spanne };
  }
  return beste;
}

/**
 * Die Farbtafel nach dem Median-Schnitt.
 *
 * # Warum Median-Schnitt und nicht „die häufigsten 255“
 *
 * Weil das Häufige nicht das Wichtige ist. Ein Sticker ist zu neun Zehnteln
 * Fläche und Kontur; die häufigsten 255 Farben wären 255 Abstufungen desselben
 * Hintergrunds, und das Gesicht darauf bekäme keine einzige. Der
 * Median-Schnitt teilt statt zu zählen: Er legt den Farbraum immer wieder an
 * seiner längsten Seite in zwei Hälften, bis es genug Kästen sind, und nimmt
 * aus jedem den Durchschnitt. Kleine, aber weit entfernte Farbgruppen behalten
 * so ihren eigenen Platz.
 *
 * Gewichtet wird dabei nach Häufigkeit – ein Kasten, in dem ein einzelner
 * Ausreisser steckt, soll nicht denselben Platz bekommen wie die Fläche
 * daneben.
 */
export function farbtafel(teilbilder: Teilbild[], plaetze: number): number[] {
  const zaehler = new Map<number, number>();
  for (const teil of teilbilder) {
    const d = teil.daten.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < DECKUNG_SCHWELLE) continue;
      /*
       * Auf fünf Bit je Kanal gerundet, bevor gezählt wird.
       *
       * Ohne das hat ein Foto von 512 × 512 gut zweihunderttausend
       * verschiedene Farben, und der Median-Schnitt sortiert sie bei jedem
       * Schnitt neu – das sind Sekunden. Mit 32 Stufen je Kanal bleiben
       * höchstens 32 768 Einträge, und der Unterschied ist bei 255
       * Tafelplätzen ohnehin nicht zu sehen.
       */
      const r = d[i] & 0xf8;
      const g = d[i + 1] & 0xf8;
      const b = d[i + 2] & 0xf8;
      const schluessel = (r << 16) | (g << 8) | b;
      zaehler.set(schluessel, (zaehler.get(schluessel) ?? 0) + 1);
    }
  }
  if (zaehler.size === 0) return [0x000000];

  let kaesten: Kasten[] = [{ farben: [...zaehler.keys()], haeufig: [...zaehler.values()] }];
  while (kaesten.length < plaetze) {
    // Den Kasten mit der längsten Seite teilen – nicht den grössten: Ein
    // Kasten mit vielen, aber sehr ähnlichen Farben braucht keinen Schnitt.
    let ziel = -1;
    let beste = 0;
    for (let i = 0; i < kaesten.length; i += 1) {
      if (kaesten[i].farben.length < 2) continue;
      const seite = laengsteSeite(kaesten[i]);
      if (seite.spanne > beste) {
        beste = seite.spanne;
        ziel = i;
      }
    }
    if (ziel < 0) break;

    const kasten = kaesten[ziel];
    const { kanal } = laengsteSeite(kasten);
    const reihen = kasten.farben
      .map((farbe, i) => ({ farbe, haeufig: kasten.haeufig[i] }))
      .sort(
        (a, b) => ((a.farbe >> (16 - kanal * 8)) & 0xff) - ((b.farbe >> (16 - kanal * 8)) & 0xff),
      );
    // Geteilt wird dort, wo die HÄUFIGKEIT zur Hälfte aufgebraucht ist, nicht
    // in der Mitte der Liste: Sonst bekäme eine grosse Fläche denselben Platz
    // wie eine Handvoll Ausreisser.
    const gesamt = reihen.reduce((summe, r) => summe + r.haeufig, 0);
    let bisher = 0;
    let schnitt = 1;
    for (let i = 0; i < reihen.length - 1; i += 1) {
      bisher += reihen[i].haeufig;
      if (bisher * 2 >= gesamt) {
        schnitt = i + 1;
        break;
      }
      schnitt = i + 2;
    }
    /*
     * Und beide Hälften müssen wirklich etwas enthalten.
     *
     * Ohne diese Zeile landete der Schnitt bei einer Fläche, die fast nur aus
     * EINER Farbe besteht, hinter dem letzten Eintrag: Die rechte Hälfte war
     * leer, wurde weiter geteilt und ergab lauter leere Kästen. Nachgemessen
     * kam aus einer Tafel von sechzehn Plätzen genau eine Farbe heraus und
     * fünfzehnmal Schwarz – und der rote Fleck im Bild verschwand.
     */
    schnitt = Math.min(reihen.length - 1, Math.max(1, schnitt));
    const links = reihen.slice(0, schnitt);
    const rechts = reihen.slice(schnitt);
    kaesten = [
      ...kaesten.slice(0, ziel),
      { farben: links.map((r) => r.farbe), haeufig: links.map((r) => r.haeufig) },
      { farben: rechts.map((r) => r.farbe), haeufig: rechts.map((r) => r.haeufig) },
      ...kaesten.slice(ziel + 1),
    ];
  }

  return kaesten.map((kasten) => {
    let r = 0;
    let g = 0;
    let b = 0;
    let summe = 0;
    for (let i = 0; i < kasten.farben.length; i += 1) {
      const gewicht = kasten.haeufig[i];
      r += ((kasten.farben[i] >> 16) & 0xff) * gewicht;
      g += ((kasten.farben[i] >> 8) & 0xff) * gewicht;
      b += (kasten.farben[i] & 0xff) * gewicht;
      summe += gewicht;
    }
    if (summe === 0) return 0;
    return (Math.round(r / summe) << 16) | (Math.round(g / summe) << 8) | Math.round(b / summe);
  });
}

/** Der Tafelplatz, der dieser Farbe am nächsten liegt. */
export function naechsterPlatz(tafel: number[], r: number, g: number, b: number): number {
  let beste = 0;
  let abstand = Infinity;
  for (let i = 0; i < tafel.length; i += 1) {
    const dr = ((tafel[i] >> 16) & 0xff) - r;
    const dg = ((tafel[i] >> 8) & 0xff) - g;
    const db = (tafel[i] & 0xff) - b;
    /*
     * Gewichtet nach Empfindlichkeit des Auges und nicht als reiner
     * euklidischer Abstand: Ein Fehler im Grün fällt gut fünfmal stärker auf
     * als derselbe Fehler im Blau. Ungewichtet verschiebt sich bei einem
     * Hautton die Farbe sichtbar ins Grüne.
     */
    const d = 3 * dr * dr + 6 * dg * dg + db * db;
    if (d < abstand) {
      abstand = d;
      beste = i;
    }
  }
  return beste;
}

/* ---------- Ein wachsender Bytepuffer ---------- */

/**
 * Bytes sammeln, ohne sie einzeln zu verpacken.
 *
 * Ein `number[]` wäre kürzer und für einen Sticker mit zehn Teilbildern auch
 * gut genug. Für ein GIF aus einem Video ist er es nicht: Bei 150 Bildern
 * kommen gut zehn Millionen Bytes zusammen, und die liegen in einem
 * JavaScript-Feld als je acht Byte – achtzig Megabyte für zehn. Auf einem
 * Telefon ist das der Unterschied zwischen „dauert" und „die Seite wurde neu
 * geladen".
 *
 * Verdoppelt wird beim Wachsen, nicht um einen festen Betrag: Sonst kostet
 * das Umkopieren quadratisch, und genau das sollte der Puffer ja verhindern.
 */
export class Bytepuffer {
  private daten: Uint8Array;
  private laenge = 0;

  constructor(anfang = 1 << 16) {
    this.daten = new Uint8Array(anfang);
  }

  private platzSchaffen(zusatz: number): void {
    if (this.laenge + zusatz <= this.daten.length) return;
    let groesse = this.daten.length;
    while (groesse < this.laenge + zusatz) groesse *= 2;
    const neu = new Uint8Array(groesse);
    neu.set(this.daten.subarray(0, this.laenge));
    this.daten = neu;
  }

  byte(wert: number): void {
    this.platzSchaffen(1);
    this.daten[this.laenge] = wert;
    this.laenge += 1;
  }

  bytes(...werte: number[]): void {
    this.platzSchaffen(werte.length);
    for (const wert of werte) {
      this.daten[this.laenge] = wert;
      this.laenge += 1;
    }
  }

  /** Ein ganzes Feld anhängen – ohne Umweg über einzelne Aufrufe. */
  feld(werte: Uint8Array): void {
    this.platzSchaffen(werte.length);
    this.daten.set(werte, this.laenge);
    this.laenge += werte.length;
  }

  /** Eine Zahl in zwei Bytes, kleinstes zuerst – so will es das Format. */
  zahl16(wert: number): void {
    this.bytes(wert & 0xff, (wert >> 8) & 0xff);
  }

  text(wort: string): void {
    for (const zeichen of wort) this.byte(zeichen.charCodeAt(0));
  }

  get groesse(): number {
    return this.laenge;
  }

  /**
   * Der fertige Inhalt.
   *
   * `slice` und nicht `subarray`: Eine Ansicht hielte den ganzen – womöglich
   * doppelt so grossen – Puffer am Leben, solange die Datei existiert.
   */
  fertig(): Uint8Array {
    return this.daten.slice(0, this.laenge);
  }
}

/* ---------- LZW ---------- */

/**
 * Die Platznummern nach GIF-LZW packen.
 *
 * Das Verfahren steht in der Spezifikation von 1989 und ist seit 2004
 * patentfrei. Es baut ein Wörterbuch aus schon gesehenen Folgen; die
 * Codebreite wächst mit ihm von `mindest + 1` bis 12 Bit, und bei 4096
 * Einträgen wird mit dem Löschcode von vorn begonnen.
 *
 * Gepackt wird von der NIEDRIGSTEN Bitstelle aufwärts – andersherum liest
 * kein GIF-Leser der Welt es zurück, und man sieht es erst am fertigen Bild.
 */
export function lzwPacken(indizes: Uint8Array, mindestBreite: number): Uint8Array {
  const loeschen = 1 << mindestBreite;
  const ende = loeschen + 1;
  let breite = mindestBreite + 1;
  let naechster = ende + 1;

  const raus = new Bytepuffer(Math.max(1024, indizes.length));
  let sammler = 0;
  let bits = 0;
  const schreiben = (wert: number) => {
    sammler |= wert << bits;
    bits += breite;
    while (bits >= 8) {
      raus.byte(sammler & 0xff);
      sammler >>= 8;
      bits -= 8;
    }
  };

  /*
   * Das Wörterbuch als Karte über `(praefix << 8) | zeichen`.
   *
   * Ein Baum aus Objekten wäre lesbarer und deutlich langsamer: Bei 512 × 512
   * und zwanzig Teilbildern sind das fünf Millionen Nachschläge.
   */
  let woerter = new Map<number, number>();
  schreiben(loeschen);
  if (indizes.length === 0) {
    schreiben(ende);
    if (bits > 0) raus.byte(sammler & 0xff);
    return inBloecke(raus.fertig());
  }

  let praefix = indizes[0];
  for (let i = 1; i < indizes.length; i += 1) {
    const zeichen = indizes[i];
    const schluessel = (praefix << 8) | zeichen;
    const gefunden = woerter.get(schluessel);
    if (gefunden !== undefined) {
      praefix = gefunden;
      continue;
    }
    schreiben(praefix);
    if (naechster < 4096) {
      woerter.set(schluessel, naechster);
      naechster += 1;
      if (naechster > 1 << breite && breite < 12) breite += 1;
    } else {
      /*
       * Voll: löschen und von vorn. Der Löschcode MUSS mit der aktuellen
       * Breite geschrieben werden und die Breite erst danach zurückgesetzt –
       * andersherum liest der Empfänger ab hier Unsinn.
       */
      schreiben(loeschen);
      woerter = new Map();
      breite = mindestBreite + 1;
      naechster = ende + 1;
    }
    praefix = zeichen;
  }
  schreiben(praefix);
  schreiben(ende);
  if (bits > 0) raus.byte(sammler & 0xff);
  return inBloecke(raus.fertig());
}

/**
 * Die gepackten Bytes in Unterblöcke von höchstens 255 zerlegen.
 *
 * Das verlangt das Format: Vor jedem Stück steht seine Länge in einem Byte,
 * und eine Null beendet die Kette.
 */
function inBloecke(bytes: Uint8Array): Uint8Array {
  // Die Grösse steht vorher fest: je Block ein Längenbyte, am Ende eine Null.
  const bloecke = Math.ceil(bytes.length / 255);
  const raus = new Uint8Array(bytes.length + bloecke + 1);
  let at = 0;
  for (let von = 0; von < bytes.length; von += 255) {
    const laenge = Math.min(255, bytes.length - von);
    raus[at] = laenge;
    raus.set(bytes.subarray(von, von + laenge), at + 1);
    at += laenge + 1;
  }
  raus[at] = 0;
  return raus;
}

/* ---------- Die Datei ---------- */

export interface GifOptionen {
  /** Wie oft es läuft. 0 heisst endlos – und das ist für einen Sticker richtig. */
  wiederholungen?: number;
  /** Wie viele Farben die Tafel hat, ohne den durchsichtigen Platz. */
  farben?: number;
}

/**
 * Aus Teilbildern eine GIF-Datei – Teilbild für Teilbild.
 *
 * # Warum ein Generator und nicht einfach eine Funktion
 *
 * Weil das Schreiben bei einem Sticker mit zehn Teilbildern in einem
 * Wimpernschlag erledigt ist und bei einem GIF aus einem Video Sekunden
 * dauert – gemessen 2866 ms für fünfzig Bilder à 512 × 512. Sekunden in einem
 * Rutsch heisst: Die Oberfläche steht, der Abbrechen-Knopf reagiert nicht,
 * und Android zeigt „Die Seite reagiert nicht".
 *
 * Ein Generator gibt nach jedem Teilbild ab. Wer es eilig hat, dreht ihn
 * sofort durch (`gifSchreiben`); wer eine Oberfläche hat, lässt zwischendurch
 * los (`gifSchreibenSchrittweise`). Beide schreiben BYTEGLEICH dasselbe, weil
 * es derselbe Code ist.
 *
 * Alle Teilbilder müssen dieselbe Grösse haben – das prüft dieser Generator,
 * statt eine Datei zu schreiben, die kein Leser mag.
 */
export function* gifLauf(
  teilbilder: Teilbild[],
  optionen: GifOptionen = {},
): Generator<number, Uint8Array, void> {
  if (teilbilder.length === 0) throw new Error('Ein GIF ohne Teilbilder gibt es nicht');
  const breite = teilbilder[0].daten.width;
  const hoehe = teilbilder[0].daten.height;
  for (const teil of teilbilder) {
    if (teil.daten.width !== breite || teil.daten.height !== hoehe) {
      throw new Error('Alle Teilbilder müssen gleich gross sein');
    }
  }

  /*
   * Ein Platz bleibt für „durchsichtig“ frei.
   *
   * GIF hat keinen Alphakanal; es hat einen TAFELPLATZ, der als durchsichtig
   * gilt. Der letzte wird dafür genommen, damit die Farben bei 0 anfangen und
   * die Tafel sich lesen lässt.
   */
  const farbzahl = Math.max(2, Math.min(255, optionen.farben ?? 255));
  const tafel = farbtafel(teilbilder, farbzahl);
  const durchsichtig = tafel.length;
  const tafelBits = Math.max(1, Math.ceil(Math.log2(Math.max(2, tafel.length + 1))));
  const tafelPlaetze = 1 << tafelBits;

  const puffer = new Bytepuffer();
  const zahl16 = (wert: number) => puffer.zahl16(wert);

  // Kopf
  puffer.text('GIF89a');
  // Logical Screen Descriptor
  zahl16(breite);
  zahl16(hoehe);
  // Globale Tafel vorhanden (0x80), Farbtiefe (egal), Tafelgrösse
  puffer.byte(0x80 | ((tafelBits - 1) & 0x07));
  puffer.bytes(0, 0); // Hintergrundfarbe, dann Seitenverhältnis: keins

  // Die Tafel, auf die volle Zweierpotenz aufgefüllt.
  for (let i = 0; i < tafelPlaetze; i += 1) {
    const farbe = i < tafel.length ? tafel[i] : 0;
    puffer.bytes((farbe >> 16) & 0xff, (farbe >> 8) & 0xff, farbe & 0xff);
  }

  /*
   * Der Schleifenvermerk – eine Erweiterung von Netscape aus dem Jahr 1995,
   * die nie in der Spezifikation stand und ohne die jedes GIF genau einmal
   * läuft.
   */
  puffer.bytes(0x21, 0xff, 11);
  puffer.text('NETSCAPE2.0');
  puffer.bytes(3, 1);
  zahl16(optionen.wiederholungen ?? 0);
  puffer.byte(0);

  const mindestBreite = Math.max(2, tafelBits);
  /*
   * Ein Zwischenspeicher für den Weg von einer Farbe zu ihrem Tafelplatz: In
   * einem Sticker kommen dieselben paar tausend Farben millionenfach vor, und
   * `naechsterPlatz` läuft für jede über die ganze Tafel.
   *
   * Er steht ABSICHTLICH vor der Schleife und nicht darin. Das ist erlaubt,
   * weil `naechsterPlatz` nur an der Tafel hängt – und die wird oben einmal
   * für alle Teilbilder gebaut und danach nicht mehr angefasst. Es lohnt sich,
   * weil zwei aufeinanderfolgende Teilbilder fast dieselben Farben zeigen; pro
   * Teilbild neu anzufangen hiesse, jede davon erneut gegen die ganze Tafel zu
   * messen. Nachgemessen an 50 Teilbildern à 512×512: 9754 ms gegen 2866 ms,
   * und die Ausgabe ist Byte für Byte dieselbe.
   */
  const gemerkt = new Map<number, number>();
  for (let nummer = 0; nummer < teilbilder.length; nummer += 1) {
    const teil = teilbilder[nummer];
    const d = teil.daten.data;
    const indizes = new Uint8Array(breite * hoehe);
    /*
     * Ein Deckel gegen den Speicher. Bei einem Sticker mit ein paar Teilbildern
     * greift er nie; ein GIF aus einem Video kann aber hunderte Teilbilder
     * haben und dabei nach und nach den halben Farbraum einsammeln.
     */
    if (gemerkt.size > 500_000) gemerkt.clear();
    for (let i = 0, p = 0; i < d.length; i += 4, p += 1) {
      if (d[i + 3] < DECKUNG_SCHWELLE) {
        indizes[p] = durchsichtig;
        continue;
      }
      const schluessel = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
      let platz = gemerkt.get(schluessel);
      if (platz === undefined) {
        platz = naechsterPlatz(tafel, d[i], d[i + 1], d[i + 2]);
        gemerkt.set(schluessel, platz);
      }
      indizes[p] = platz;
    }

    // Graphic Control Extension: Standzeit und durchsichtiger Platz.
    puffer.bytes(0x21, 0xf9, 4);
    /*
     * Entsorgungsart 2 („auf den Hintergrund zurücksetzen“) und
     * durchsichtiger Platz an.
     *
     * Ohne die 2 bleibt jedes Teilbild stehen und das nächste wird darüber
     * gemalt – wo der Sticker durchsichtig ist, sähe man dann das
     * vorhergehende Teilbild durchscheinen. Bei einer Figur, die sich bewegt,
     * zieht sie damit eine Spur hinter sich her.
     */
    puffer.byte((2 << 2) | 0x01);
    // Die Standzeit zählt in Hundertstelsekunden. Mindestens zwei: Bei null
    // oder eins rechnen etliche Leser auf zehn hoch, und die Bewegung wird
    // langsamer statt schneller.
    zahl16(Math.max(2, Math.round(teil.dauerMs / 10)));
    puffer.bytes(durchsichtig, 0);

    // Image Descriptor – volle Fläche, keine eigene Tafel.
    puffer.byte(0x2c);
    zahl16(0);
    zahl16(0);
    zahl16(breite);
    zahl16(hoehe);
    puffer.byte(0);

    puffer.byte(mindestBreite);
    puffer.feld(lzwPacken(indizes, mindestBreite));
    yield nummer;
  }

  puffer.byte(0x3b);
  return puffer.fertig();
}

/**
 * Der bequeme Weg: alles auf einmal.
 *
 * Für Sticker – dort sind es eine Handvoll Teilbilder, und ein `await` wäre
 * nur Umstand.
 */
export function gifSchreiben(teilbilder: Teilbild[], optionen: GifOptionen = {}): Uint8Array {
  const lauf = gifLauf(teilbilder, optionen);
  let schritt = lauf.next();
  while (!schritt.done) schritt = lauf.next();
  return schritt.value;
}

export interface SchrittOptionen extends GifOptionen {
  /** Anteil 0…1 und ein Satz, den man zeigen kann. */
  fortschritt?: (anteil: number, text: string) => void;
  abbruch?: AbortSignal;
}

/**
 * Der geduldige Weg: nach jedem Teilbild einmal loslassen.
 *
 * # Warum `setTimeout` und nicht `await Promise.resolve()`
 *
 * Weil ein aufgelöstes Versprechen eine MIKROaufgabe ist. Die läuft noch vor
 * dem nächsten Bildaufbau – die Oberfläche käme also gar nicht dran, und der
 * Abbrechen-Knopf bliebe genauso tot wie ohne. Erst eine gewöhnliche Aufgabe
 * lässt den Browser dazwischen zeichnen.
 */
export async function gifSchreibenSchrittweise(
  teilbilder: Teilbild[],
  optionen: SchrittOptionen = {},
): Promise<Uint8Array> {
  if (optionen.abbruch?.aborted) throw new AbbruchError();
  const gesamt = teilbilder.length;
  const lauf = gifLauf(teilbilder, optionen);
  let schritt = lauf.next();
  while (!schritt.done) {
    if (optionen.abbruch?.aborted) {
      // Den Generator sauber beenden, damit seine Puffer freigegeben werden.
      lauf.return(new Uint8Array());
      throw new AbbruchError();
    }
    const fertig = schritt.value + 1;
    optionen.fortschritt?.(fertig / gesamt, `GIF: Bild ${fertig} von ${gesamt}`);
    await new Promise((weiter) => setTimeout(weiter, 0));
    schritt = lauf.next();
  }
  return schritt.value;
}
