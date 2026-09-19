/**
 * Eine WAV-Datei schreiben – damit bearbeiteter Ton wieder eine Datei wird.
 *
 * # Warum von Hand und warum überhaupt
 *
 * Aus demselben Grund, aus dem in `stickers/gif.ts` ein GIF von Hand entsteht:
 * Der Browser kann Ton LESEN und nicht SCHREIBEN. `decodeAudioData` macht aus
 * jeder Datei Zahlen, und `OfflineAudioContext` rechnet damit schneller als in
 * Echtzeit – aber am Ende steht ein `AudioBuffer` im Speicher und keine Datei,
 * die sich verschicken liesse. Es gibt kein `audioBuffer.toBlob()`.
 *
 * Der naheliegende Ausweg wäre `MediaRecorder` an einem
 * `MediaStreamAudioDestinationNode`. Der liefert kleine Opus-Dateien und läuft
 * zwangsläufig in ECHTZEIT: Eine Sprachnachricht von fünf Minuten kostete fünf
 * Minuten Warten. Für einen Sticker von drei Sekunden ginge das; für eine
 * Sprachnachricht nicht, und zwei Wege für dieselbe Sache sind einer zu viel.
 *
 * Bleibt, die Datei selbst zu schreiben. Bei WAV ist das ein Kopf von
 * vierundvierzig Bytes und danach die Zahlen. Das Format ist von 1991,
 * vollständig beschrieben und patentfrei – lineares PCM ist keine Erfindung,
 * sondern das Abtasten selbst.
 *
 * # Was das Format kostet
 *
 * Es packt nicht. Mono bei 24 kHz sind 48 kB je Sekunde, eine Sprachnachricht
 * von fünf Minuten also rund 14 MB. Das liegt unter der Grenze von 50 MB
 * (`apps/api/src/constants.rs`), ist aber viel Mobilfunkvolumen.
 *
 * Daraus folgt eine Regel, die ausserhalb dieser Datei gilt und hier trotzdem
 * stehen muss, weil sie sonst niemand findet: **Neu geschrieben wird nur, wenn
 * wirklich etwas geändert wurde.** Wer eine Sprachnachricht aufnimmt und nichts
 * daran tut, schickt den Originalblob – aus 400 kB Opus würden sonst 14 MB.
 */

/** Wie viele Abtastwerte je Sekunde eine bearbeitete Datei bekommt. */
export const ZIEL_RATE = 24_000;

/**
 * Float32-Kanäle als WAV.
 *
 * Sechzehn Bit und nicht zweiunddreissig: Der Unterschied ist bei Sprache aus
 * einem Telefonlautsprecher nicht zu hören und verdoppelt die Datei.
 */
export function wavSchreiben(kanaele: Float32Array<ArrayBufferLike>[], rate: number): Blob {
  if (kanaele.length === 0) throw new Error('Ohne Kanäle gibt es nichts zu schreiben.');
  const anzahl = kanaele.length;
  const laenge = kanaele[0].length;
  const datenBytes = laenge * anzahl * 2;
  const puffer = new ArrayBuffer(44 + datenBytes);
  const sicht = new DataView(puffer);

  const text = (at: number, wort: string) => {
    for (let i = 0; i < wort.length; i += 1) sicht.setUint8(at + i, wort.charCodeAt(i));
  };

  /*
   * Der Kopf. Alle Zahlen stehen KLEINENDIG – RIFF kommt von Intel, anders als
   * PNG und GIF, die grossendig zählen. Wer hier die Reihenfolge verwechselt,
   * bekommt eine Datei, die jeder Abspieler ablehnt; das ist die gnädige
   * Variante des Fehlers.
   */
  text(0, 'RIFF');
  sicht.setUint32(4, 36 + datenBytes, true); // Dateigrösse ohne die ersten acht Bytes
  text(8, 'WAVE');
  text(12, 'fmt ');
  sicht.setUint32(16, 16, true); // Länge dieses Abschnitts
  sicht.setUint16(20, 1, true); // 1 = lineares PCM, unkomprimiert
  sicht.setUint16(22, anzahl, true);
  sicht.setUint32(24, rate, true);
  sicht.setUint32(28, rate * anzahl * 2, true); // Bytes je Sekunde
  sicht.setUint16(32, anzahl * 2, true); // Bytes je Abtastzeitpunkt
  sicht.setUint16(34, 16, true); // Bit je Wert
  text(36, 'data');
  sicht.setUint32(40, datenBytes, true);

  /*
   * Die Werte, Zeitpunkt für Zeitpunkt verschränkt (links, rechts, links …).
   *
   * Geklemmt wird VOR der Umrechnung. Die Web Audio API lässt Werte über 1
   * zu – ein Kompressor am Ende der Kette hält sie klein, aber verlassen darf
   * man sich darauf nicht. Ohne Klemmung liefe `setInt16` über und aus dem
   * lautesten Ton würde der leiseste: ein Knacken an genau der Stelle, an der
   * es am meisten stört.
   *
   * Und 0x7fff, nicht 0x8000: Bei genau +1 wäre 32768 einen Schritt zu gross
   * für Int16.
   */
  let at = 44;
  for (let i = 0; i < laenge; i += 1) {
    for (let k = 0; k < anzahl; k += 1) {
      const wert = Math.max(-1, Math.min(1, kanaele[k][i] ?? 0));
      sicht.setInt16(at, Math.round(wert * 0x7fff), true);
      at += 2;
    }
  }

  return new Blob([puffer], { type: 'audio/wav' });
}

/**
 * Alle Kanäle zu einem mischen.
 *
 * Nicht aus Sparsamkeit, sondern wegen des Speichers: Fünf Minuten Stereo bei
 * 48 kHz sind rund 115 MB Float32. Auf einem älteren Telefon stirbt die Seite
 * daran, und zwar beim Dekodieren, bevor irgendetwas zu sehen war. Gemischt
 * wird deshalb sofort, und der Originalpuffer darf danach fallen.
 *
 * Für Sprache und Sticker verliert das nichts: Beides ist ohnehin einkanalig
 * aufgenommen, und die Effekte hier rechnen nicht im Raum.
 */
export function nachMono(kanaele: Float32Array<ArrayBufferLike>[]): Float32Array<ArrayBufferLike> {
  if (kanaele.length === 1) return kanaele[0];
  const laenge = kanaele[0].length;
  const aus = new Float32Array(laenge);
  for (const kanal of kanaele) {
    for (let i = 0; i < laenge; i += 1) aus[i] += kanal[i];
  }
  for (let i = 0; i < laenge; i += 1) aus[i] /= kanaele.length;
  return aus;
}

/**
 * Die Abtastrate senken, durch Mittelung über das Fenster.
 *
 * # Warum Mittelung und nicht jeden n-ten Wert nehmen
 *
 * Weil das Weglassen von Werten Töne erfindet, die es nicht gab. Alles
 * oberhalb der halben neuen Rate klappt beim Abtasten nach UNTEN um und
 * erscheint als tieferer Ton – bei Sprache als metallisches Zischen, das man
 * nicht mehr wegbekommt. Ein Mittel über das Fenster ist ein Tiefpass, grob
 * zwar, aber an der richtigen Stelle: vor dem Abtasten statt danach.
 *
 * Wird nicht verkleinert, kommt der Eingang unverändert zurück.
 */
export function dezimieren(
  werte: Float32Array<ArrayBufferLike>,
  vonRate: number,
  zuRate: number,
): Float32Array<ArrayBufferLike> {
  if (zuRate >= vonRate) return werte;
  const faktor = vonRate / zuRate;
  const laenge = Math.floor(werte.length / faktor);
  const aus = new Float32Array(laenge);
  for (let i = 0; i < laenge; i += 1) {
    const von = i * faktor;
    const bis = Math.min(werte.length, (i + 1) * faktor);
    let summe = 0;
    let anzahl = 0;
    for (let j = Math.floor(von); j < bis; j += 1) {
      summe += werte[j];
      anzahl += 1;
    }
    aus[i] = anzahl > 0 ? summe / anzahl : 0;
  }
  return aus;
}
