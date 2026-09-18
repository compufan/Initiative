/**
 * Der Gesprächsverlauf auf dem Fernseher.
 *
 * # Warum das hier steht und nicht aus der App kommt
 *
 * Weil der Browser am anderen Ende selten ein aktueller ist – derselbe Grund,
 * aus dem `tv.ts` ohne React auskommt. `MessageBubble.tsx` und
 * `TextBubble.tsx` wiederzuverwenden wäre der naheliegende erste Gedanke und
 * die teuerste Falle: Sie ziehen React, den Wegweiser und die halbe App mit
 * sich, und ein Fernseher von 2016 lädt dieses Bündel nicht.
 *
 * Also neuer, schlichter Code. Er ist kürzer als die Diashow daneben.
 *
 * # Warum hier von Hand gebaut wird und nicht mit `innerHTML`
 *
 * Weil hier FREMDER Text steht. Eine Nachricht ist das, was jemand getippt
 * hat, und in einer Gruppe kann das jeder sein. `innerHTML` machte aus
 * `<img onerror=…>` in einer Nachricht ausführbaren Code auf einem Gerät, das
 * keine Adresszeile hat, an der man es merken würde. `textContent` kann das
 * nicht – es gibt keine Zeichenfolge, die daraus etwas anderes macht als
 * Text.
 */

/** Eine Nachricht, wie sie vom Server kommt. */
export interface ChatNachricht {
  id: string;
  art: string;
  text: string | null;
  absender: string | null;
  eigen: boolean;
  zeit: string;
  bearbeitet: boolean;
  bilder: { id: string; art: string; url: string }[];
}

export interface ChatProgramm {
  art: 'chat';
  marke: string;
  titel: string;
  stelle: number;
  anzahl: number;
  proSeite: number;
  nachrichten: ChatNachricht[];
}

/**
 * Die Uhrzeit einer Nachricht.
 *
 * Nur Stunde und Minute, solange sie von heute ist – auf einem Fernseher im
 * Wohnzimmer ist „14:20" die Auskunft, die jemand sucht, und
 * „18.09.2026, 14:20:33" die, die er überliest. Ist sie älter, kommt der Tag
 * dazu: „gestern 14:20" wäre sonst nicht von heute zu unterscheiden.
 */
export function uhrzeit(roh: string, jetzt = new Date()): string {
  const zeit = new Date(roh);
  if (Number.isNaN(zeit.getTime())) return '';
  const uhr = zeit.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const gleicherTag =
    zeit.getFullYear() === jetzt.getFullYear() &&
    zeit.getMonth() === jetzt.getMonth() &&
    zeit.getDate() === jetzt.getDate();
  if (gleicherTag) return uhr;
  const tag = zeit.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
  return `${tag} ${uhr}`;
}

/**
 * Was in der Zeile steht, wenn kein Text da ist.
 *
 * Eine Nachricht kann ein Foto ohne Wort sein, eine Umfrage, eine Ausgabe. Für
 * einen Fernseher ist die ehrliche Antwort ein kurzes Wort dafür und nicht
 * eine leere Zeile: Eine leere Zeile sieht aus wie ein Fehler.
 */
export function ersatztext(nachricht: ChatNachricht): string {
  if (nachricht.bilder.length > 0) {
    const video = nachricht.bilder.some((b) => b.art === 'video');
    if (nachricht.bilder.length > 1) return `${nachricht.bilder.length} Dateien`;
    return video ? 'Video' : 'Foto';
  }
  switch (nachricht.art) {
    case 'poll':
      return 'Umfrage';
    case 'expense':
      return 'Ausgabe';
    case 'event':
      return 'Termin';
    case 'system':
      return '';
    default:
      return 'Anhang';
  }
}

/**
 * Eine Nachricht als Zeile.
 *
 * `document.createElement` und `textContent` durchgehend – siehe der Kopf
 * dieser Datei.
 */
function zeileBauen(nachricht: ChatNachricht): HTMLLIElement {
  const zeile = document.createElement('li');
  zeile.className = nachricht.eigen ? 'verlauf-zeile ist-eigen' : 'verlauf-zeile';

  const kopf = document.createElement('div');
  kopf.className = 'verlauf-wer';
  const name = document.createElement('span');
  name.className = 'verlauf-name';
  name.textContent = nachricht.absender ?? 'Jemand';
  const zeit = document.createElement('span');
  zeit.className = 'verlauf-zeit';
  zeit.textContent = uhrzeit(nachricht.zeit);
  kopf.append(name, zeit);
  if (nachricht.bearbeitet) {
    const bearbeitet = document.createElement('span');
    bearbeitet.className = 'verlauf-zeit';
    bearbeitet.textContent = 'bearbeitet';
    kopf.append(bearbeitet);
  }

  const blase = document.createElement('div');
  blase.className = 'verlauf-blase';

  /*
   * Bilder ZUERST, Text darunter – wie in der App.
   *
   * Nur das erste Bild: Auf zwölf Zeilen ist für eine Galerie kein Platz, und
   * eine Nachricht mit acht Fotos würde die anderen elf vom Schirm drängen.
   * Wie viele es sind, sagt der Ersatztext.
   */
  const erstes = nachricht.bilder.find((b) => b.art === 'image');
  if (erstes) {
    const bild = document.createElement('img');
    bild.className = 'verlauf-bild';
    bild.src = erstes.url;
    bild.alt = '';
    // Ein Bild, das nicht kommt, soll keine leere Lücke reissen. Der
    // Ersatztext darunter sagt ohnehin, dass ein Foto dabei war.
    bild.onerror = () => bild.remove();
    blase.append(bild);
  }

  const text = (nachricht.text ?? '').trim();
  const satz = text.length > 0 ? text : ersatztext(nachricht);
  if (satz.length > 0) {
    const absatz = document.createElement('p');
    absatz.className = text.length > 0 ? 'verlauf-text' : 'verlauf-text ist-ersatz';
    absatz.textContent = satz;
    blase.append(absatz);
  }

  zeile.append(kopf, blase);
  return zeile;
}

/** Die Seitenangabe – nur, wenn es etwas zu blättern gibt. */
export function seitentext(stelle: number, anzahl: number, proSeite: number): string {
  const seiten = Math.max(1, Math.ceil(anzahl / Math.max(1, proSeite)));
  if (seiten <= 1) return '';
  // Von hinten gezählt: Stelle 0 ist die jüngste Seite, also die letzte.
  return `${seiten - stelle} von ${seiten}`;
}

/** Den Verlauf in die Liste schreiben. */
export function verlaufZeichnen(
  liste: HTMLElement,
  titelFeld: HTMLElement,
  seiteFeld: HTMLElement,
  programm: ChatProgramm,
): void {
  titelFeld.textContent = programm.titel;
  seiteFeld.textContent = seitentext(programm.stelle, programm.anzahl, programm.proSeite);
  liste.replaceChildren(...programm.nachrichten.map(zeileBauen));
  /*
   * Ans Ende springen.
   *
   * Die jüngste Nachricht steht unten, und sie ist die, auf die alle schauen.
   * Bei einer Seite, die ohnehin passt, tut das nichts; bei einer mit einem
   * langen Text hält es das Neueste im Bild.
   */
  liste.scrollTop = liste.scrollHeight;
}
