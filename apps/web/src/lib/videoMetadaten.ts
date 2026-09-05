/**
 * Metadaten aus einem Video entfernen – ohne es neu zu kodieren.
 *
 * # Worum es geht
 *
 * Fotos werden vor dem Senden über eine Leinwand neu gerechnet; dabei fallen
 * EXIF-Daten weg, einschliesslich des Aufnahmeorts. Videos gingen bisher
 * unverändert auf den Server – mit allem, was die Kamera hineingeschrieben
 * hat. Ein iPhone schreibt die GPS-Koordinaten als `©xyz` in `moov/udta`,
 * Android als `loci`. Wer ein Urlaubsvideo verschickt, verschickt damit den
 * Ort, an dem er stand.
 *
 * # Warum nicht neu kodieren
 *
 * Weil das Minuten dauert, Qualität kostet und auf einem Telefon den Akku
 * frisst. Ein MP4 ist ein Baum aus „Boxen“ (ftyp, moov, mdat …), und die
 * Metadaten stehen in eigenen Boxen. Man muss also nur diese Boxen los
 * werden, nicht das Video.
 *
 * # Die Falle: Verschieben ist verboten
 *
 * In `stco` bzw. `co64` stehen ABSOLUTE Dateipositionen der Videodaten. Wer
 * eine Box herausschneidet, verschiebt alles dahinter – und sämtliche
 * Positionen zeigen daneben. Das Video ist danach unabspielbar oder zeigt
 * Müll. Genau daran scheitern die meisten selbstgebauten „MP4-Cleaner“.
 *
 * Deshalb wird hier NICHTS entfernt. Jede Box behält ihre Länge und ihren
 * Platz; sie bekommt nur den Typ `free` und einen mit Nullen überschriebenen
 * Inhalt. `free` heisst im Format ausdrücklich „überspringen“ – jeder
 * Abspieler tut das. Die Datei bleibt Byte für Byte gleich lang, kein Offset
 * verschiebt sich, und die Daten selbst sind wirklich weg.
 *
 * Nur umbenennen würde NICHT genügen: Die Koordinaten stünden dann immer noch
 * in der Datei, nur unbeachtet. Genullt wird deshalb immer.
 */

/** Eine Box im Datei-Baum. */
export interface Box {
  /** Vier Zeichen, etwa `moov`. */
  typ: string;
  /** Position des Längenfelds, also der Anfang der Box. */
  start: number;
  /** Position des ersten Inhaltsbytes. */
  inhalt: number;
  /** Position hinter der Box. */
  ende: number;
}

/** Was überschrieben werden soll: ein Bereich und der neue Typ. */
export interface Aenderung {
  /** Anfang der Box (Längenfeld). */
  start: number;
  ende: number;
}

const TEXT = new TextDecoder('latin1');

/**
 * Liest die Boxen eines Abschnitts.
 *
 * `daten` ist ein Ausschnitt der Datei, `versatz` seine Position darin – so
 * stimmen die zurückgegebenen Positionen mit der ganzen Datei überein.
 *
 * Gibt eine leere Liste zurück, wenn der Abschnitt kein sinnvoller Baum ist.
 * Das ist Absicht: Ein unbekanntes Format soll hier nicht zu einem Fehler
 * führen, sondern dazu, dass nichts angefasst wird.
 */
export function boxenLesen(daten: Uint8Array, versatz = 0): Box[] {
  const sicht = new DataView(daten.buffer, daten.byteOffset, daten.byteLength);
  const boxen: Box[] = [];
  let at = 0;
  while (at + 8 <= daten.length) {
    let groesse = sicht.getUint32(at);
    const typ = TEXT.decode(daten.subarray(at + 4, at + 8));
    let inhalt = at + 8;
    if (groesse === 1) {
      // Grosse Box: 64-Bit-Länge hinter dem Typ. Kommt bei Videos über 4 GB
      // vor, und `mdat` ist genau die Box, die das erreicht.
      if (at + 16 > daten.length) break;
      const gross = sicht.getBigUint64(at + 8);
      if (gross > BigInt(Number.MAX_SAFE_INTEGER)) break;
      groesse = Number(gross);
      inhalt = at + 16;
    } else if (groesse === 0) {
      // „Bis zum Dateiende“ – erlaubt, aber nur für die letzte Box.
      groesse = daten.length - at;
    }
    if (groesse < 8 || at + groesse > daten.length) break;
    // Ein Typ muss aus druckbaren Zeichen bestehen. Sonst lesen wir keine
    // Boxen mehr, sondern Videodaten, die zufällig so aussehen.
    if (!/^[\x20-\x7e]{4}$/.test(typ)) break;
    boxen.push({
      typ,
      start: versatz + at,
      inhalt: versatz + inhalt,
      ende: versatz + at + groesse,
    });
    at += groesse;
  }
  return boxen;
}

/** Boxen, die Metadaten tragen und ersatzlos genullt werden können. */
const METADATEN = new Set(['udta', 'meta', 'uuid']);

/**
 * Findet die zu nullenden Bereiche in einem `moov`-Abschnitt.
 *
 * `moov` ist der einzige Ort, an dem Metadaten stehen, die uns hier
 * interessieren – und der einzige, den wir gefahrlos anfassen können. In
 * `mdat` liegt das Video, in `stbl` liegen die Positionstabellen.
 *
 * `uuid` gehört dazu, weil Hersteller dort ihre eigenen Felder ablegen; Apple
 * und GoPro schreiben Aufnahmeort und Gerätekennung teils dorthin.
 */
export function metadatenBereiche(moovDaten: Uint8Array, moovVersatz: number): Aenderung[] {
  const treffer: Aenderung[] = [];
  const gehen = (daten: Uint8Array, versatz: number, tiefe: number) => {
    // Drei Ebenen reichen: moov/trak/mdia. Tiefer stehen nur noch die
    // Tabellen, und die fassen wir ohnehin nicht an.
    if (tiefe > 3) return;
    for (const box of boxenLesen(daten, versatz)) {
      if (METADATEN.has(box.typ)) {
        treffer.push({ start: box.start, ende: box.ende });
        continue;
      }
      // Nur in Behälterboxen absteigen. `trak` und `mdia` können eigene
      // `udta` enthalten – dort steht bei manchen Kameras die Spur-Notiz.
      if (box.typ === 'trak' || box.typ === 'mdia' || box.typ === 'minf') {
        const von = box.inhalt - versatz;
        const bis = box.ende - versatz;
        if (von >= 0 && bis <= daten.length) {
          gehen(daten.subarray(von, bis), box.inhalt, tiefe + 1);
        }
      }
    }
  };
  gehen(moovDaten, moovVersatz, 0);
  return treffer;
}

/** Ein `free`-Kopf der angegebenen Länge, Inhalt Nullen. */
export function freiBox(laenge: number): Uint8Array {
  const aus = new Uint8Array(laenge);
  new DataView(aus.buffer).setUint32(0, laenge);
  aus[4] = 0x66; // f
  aus[5] = 0x72; // r
  aus[6] = 0x65; // e
  aus[7] = 0x65; // e
  return aus;
}

/** Ein Kopfstück lesen, ohne die ganze Datei anzufassen. */
async function stueck(datei: Blob, von: number, bis: number): Promise<Uint8Array> {
  return new Uint8Array(await datei.slice(von, bis).arrayBuffer());
}

/**
 * Nullt die Zeitstempel in einer Kopfbox an Ort und Stelle.
 *
 * `mvhd`, `tkhd` und `mdhd` tragen Erstellungs- und Änderungszeit als
 * Sekunden seit 1904 – auf die Sekunde genau der Moment der Aufnahme.
 * Nachgemessen an einer Browser-Aufnahme: 3871491607, also
 * 2026-09-05T22:20:07Z. Das ist bei einer Aufnahme im Browser der einzige
 * Rest, weil dort weder `udta` noch `meta` entsteht.
 *
 * Die Lage hängt an der Version im ersten Byte hinter dem Kopf: Version 0
 * hat zwei 4-Byte-Felder, Version 1 zwei 8-Byte-Felder. Alles danach –
 * Zeitskala, Dauer, und bei `tkhd` die Drehmatrix – bleibt unberührt.
 */
function zeitenNullen(daten: Uint8Array, inhalt: number): void {
  const version = daten[inhalt];
  const breite = version === 1 ? 8 : 4;
  const bis = inhalt + 4 + breite * 2;
  if (bis > daten.length) return;
  daten.fill(0, inhalt + 4, bis);
}

const ZEITBOXEN = new Set(['mvhd', 'tkhd', 'mdhd']);

/** Findet die Zeitboxen unter `moov`, bis drei Ebenen tief. */
function zeitBereiche(daten: Uint8Array, tiefe = 0): Box[] {
  if (tiefe > 3) return [];
  const treffer: Box[] = [];
  for (const box of boxenLesen(daten)) {
    if (ZEITBOXEN.has(box.typ)) treffer.push(box);
    else if (box.typ === 'trak' || box.typ === 'mdia') {
      for (const tiefer of zeitBereiche(daten.subarray(box.inhalt, box.ende), tiefe + 1)) {
        treffer.push({
          typ: tiefer.typ,
          start: box.inhalt + tiefer.start,
          inhalt: box.inhalt + tiefer.inhalt,
          ende: box.inhalt + tiefer.ende,
        });
      }
    }
  }
  return treffer;
}

/** Was ein Lauf gefunden und getan hat – für Protokoll und Test. */
export interface Befund {
  /** Ob überhaupt etwas geändert wurde. */
  geaendert: boolean;
  /** Wie viele Metadatenboxen genullt wurden. */
  boxen: number;
  /** Wie viele Zeitstempel genullt wurden. */
  zeiten: number;
  /** Warum nichts getan wurde, falls nichts getan wurde. */
  grund?: string;
}

/**
 * Entfernt die Metadaten aus einem MP4/MOV – ohne neu zu kodieren.
 *
 * Gibt die Datei unverändert zurück, wenn das Format nicht sicher zu
 * behandeln ist. Das ist Absicht: Ein Video, das nicht mehr abspielt, ist
 * schlimmer als eines mit Zusatzdaten, und der Anwender kann das eine
 * bemerken und das andere nicht.
 *
 * # Was NICHT behandelt wird
 *
 * WebM und Matroska. Die Aufnahme im Browser erzeugt zwar WebM, aber ohne
 * Ortsangabe: Nachgemessen enthält ein Chromium-Mitschnitt in `Info` nur
 * TimestampScale, MuxingApp und WritingApp („Chrome“) – kein DateUTC, keine
 * SegmentUID, keine Tags. Der Weg mit Ortsdaten ist die Kamerarolle, und die
 * liefert MP4 oder MOV. Für WebM gäbe es mit dem Void-Element (0xEC) dasselbe
 * Mittel; gebaut ist es nicht, weil es hier nichts zu entfernen gibt.
 */
export async function videoBereinigen(datei: Blob): Promise<{ datei: Blob; befund: Befund }> {
  const unveraendert = (grund: string) => ({
    datei,
    befund: { geaendert: false, boxen: 0, zeiten: 0, grund },
  });

  if (datei.size < 16) return unveraendert('zu klein für einen Boxbaum');

  /*
   * Den Baum lesen, ohne die Datei zu laden.
   *
   * Ein Video aus der Kamerarolle hat leicht 200 MB; die in den
   * Arbeitsspeicher zu ziehen, ist auf einem Telefon ein Absturz. Jede Box
   * nennt aber ihre eigene Länge – es genügt also, je 16 Byte am Anfang
   * jeder Box zu lesen und weiterzuspringen.
   */
  let at = 0;
  let moov: Box | null = null;
  let schritte = 0;
  while (at + 8 <= datei.size && schritte < 1000) {
    schritte += 1;
    const kopf = await stueck(datei, at, Math.min(at + 16, datei.size));
    const boxen = boxenLesen(kopf, at);
    if (boxen.length === 0) {
      // Der Kopf allein reicht nicht, wenn die Box länger ist als das Stück.
      // `boxenLesen` bricht dann ab – wir lesen die Länge deshalb selbst.
      if (kopf.length < 8) return unveraendert('unlesbarer Boxkopf');
      const sicht = new DataView(kopf.buffer, kopf.byteOffset, kopf.byteLength);
      let groesse = sicht.getUint32(0);
      const typ = new TextDecoder('latin1').decode(kopf.subarray(4, 8));
      if (!/^[\x20-\x7e]{4}$/.test(typ)) return unveraendert('kein MP4/MOV');
      if (groesse === 1) {
        if (kopf.length < 16) return unveraendert('unlesbarer Boxkopf');
        const gross = sicht.getBigUint64(8);
        if (gross > BigInt(Number.MAX_SAFE_INTEGER)) return unveraendert('Box zu gross');
        groesse = Number(gross);
        if (typ === 'moov') moov = { typ, start: at, inhalt: at + 16, ende: at + groesse };
      } else if (groesse === 0) {
        groesse = datei.size - at;
        if (typ === 'moov') moov = { typ, start: at, inhalt: at + 8, ende: at + groesse };
      } else if (typ === 'moov') {
        moov = { typ, start: at, inhalt: at + 8, ende: at + groesse };
      }
      if (groesse < 8) return unveraendert('unsinnige Boxlänge');
      at += groesse;
      if (moov) break;
      continue;
    }
    const box = boxen[0];
    if (box.typ === 'moov') {
      moov = box;
      break;
    }
    at = box.ende;
  }

  if (!moov) return unveraendert('kein moov gefunden');
  if (moov.ende - moov.start > 64 * 1024 * 1024) return unveraendert('moov unerwartet gross');

  const moovDaten = await stueck(datei, moov.start, moov.ende);
  const inhaltAb = moov.inhalt - moov.start;
  const kern = moovDaten.subarray(inhaltAb);

  const bereiche = metadatenBereiche(kern, inhaltAb);
  const zeiten = zeitBereiche(kern);

  if (bereiche.length === 0 && zeiten.length === 0) {
    return unveraendert('nichts zu entfernen');
  }

  /*
   * Ueberschreiben, nicht herausschneiden.
   *
   * `moovDaten` bleibt exakt so lang, wie es war. Damit verschiebt sich mdat
   * nicht, und jeder absolute Versatz in stco, co64 und tfra bleibt gueltig.
   */
  for (const bereich of bereiche) {
    moovDaten.set(freiBox(bereich.ende - bereich.start), bereich.start);
  }
  for (const box of zeiten) {
    zeitenNullen(moovDaten, inhaltAb + box.inhalt);
  }

  return {
    datei: new Blob(
      [datei.slice(0, moov.start), new Uint8Array(moovDaten), datei.slice(moov.ende)],
      {
        type: datei.type,
      },
    ),
    befund: { geaendert: true, boxen: bereiche.length, zeiten: zeiten.length },
  };
}
