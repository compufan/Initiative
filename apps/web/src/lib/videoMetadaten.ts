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
