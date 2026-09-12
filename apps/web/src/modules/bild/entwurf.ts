/**
 * Der Entwurf, der ein Schliessen überlebt.
 *
 * # Wovon hier die Rede ist
 *
 * Der Fotoeditor fragt inzwischen nach, bevor er eine Bearbeitung wegwirft.
 * Das hilft gegen den falschen Fingertipp – aber nicht gegen den abgestürzten
 * Browser, den geschlossenen Tab, das Telefon, das die Seite aus dem Speicher
 * wirft, während man kurz in eine Nachricht schaut. Genau dort ging die Arbeit
 * bisher verloren, und zwar ohne dass irgendjemand gefragt worden wäre.
 *
 * Ein Entwurf liegt deshalb schon vor dem Schliessen: Er wird beim Arbeiten
 * fortgeschrieben, nicht beim Verlassen.
 *
 * # Was NICHT gespeichert wird
 *
 * Das Bild. Ein Foto von zwölf Megapunkten wäre um Grössenordnungen mehr als
 * alles andere, was diese App im Gerät ablegt, und es liegt ohnehin schon da
 * – als Anhang auf dem Server oder als Datei im Gerät. Gespeichert wird nur
 * die ANWEISUNG, in derselben Form, die auch ein Rezept verschickt.
 *
 * Daraus folgt die einzige echte Frage dieser Datei: Woran erkennt man
 * wieder, dass DIESES Bild zu jenem Entwurf gehört?
 *
 * # Die Kennung
 *
 * Nicht die Anhangkennung: Dasselbe Bild kommt über drei Wege herein – als
 * Anhang aus dem Chat, als Datei aus der Auswahl, als frische Aufnahme –, und
 * nur einer davon hat eine Kennung. Nicht der Dateiname: „IMG_0042.jpg" gibt
 * es in jedem Telefon der Welt.
 *
 * Also der Inhalt. `crypto.subtle` rechnet SHA-256 über die Bytes, und das
 * ist eindeutig genug für diesen Zweck. Wo es das nicht gibt – eine Seite
 * ohne sicheren Kontext –, tritt eine einfache Streuung über eine Stichprobe
 * an seine Stelle. Sie kann kollidieren; deshalb steht in jedem Entwurf
 * zusätzlich, zu welchen MASSEN er gehört, und ein Entwurf, dessen Masse
 * nicht passen, gilt nicht. Und gefragt wird sowieso, bevor etwas angewandt
 * wird.
 */

import { docUnberuehrt, type BildDoc } from './doc.js';
import { docAusRoh, docNachRoh } from './rezept.js';
import { entwurfLesen, entwurfLoeschen, entwurfSchreiben } from '../../lib/db.js';

/**
 * Wieviele Bytes die Ersatzstreuung anfasst.
 *
 * Eine Stichprobe und nicht die ganze Datei: Bei zwanzig Megabyte liefe die
 * Schleife spürbar, und zwar auf dem Hauptstrang, direkt bevor der Editor
 * aufgehen soll. Anfang, Mitte und Ende zusammen mit der Gesamtlänge
 * unterscheiden zwei Fotos zuverlässig; zwei Fassungen DESSELBEN Fotos
 * unterscheiden sie womöglich nicht – und genau die sollen auch denselben
 * Entwurf bekommen.
 */
const STICHPROBE = 64 * 1024;

function hex(puffer: ArrayBuffer): string {
  const bytes = new Uint8Array(puffer);
  let raus = '';
  for (let i = 0; i < bytes.length; i += 1) raus += bytes[i].toString(16).padStart(2, '0');
  return raus;
}

async function streuung(blob: Blob): Promise<string> {
  const stuecke: Blob[] = [
    blob.slice(0, STICHPROBE),
    blob.slice(
      Math.max(0, Math.floor(blob.size / 2) - STICHPROBE / 2),
      Math.floor(blob.size / 2) + STICHPROBE / 2,
    ),
    blob.slice(Math.max(0, blob.size - STICHPROBE)),
  ];
  const bytes = new Uint8Array(await new Blob(stuecke).arrayBuffer());
  // FNV-1a, 32 Bit. Keine kryptographische Aussage – nur „verschiedene Bytes
  // ergeben verschiedene Zahlen", und das reicht neben der Länge.
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/**
 * Die Kennung eines Bildes für den Entwurfsspeicher.
 *
 * Die Grösse steht immer mit drin – auch neben SHA-256. Sie kostet nichts und
 * schliesst die ganze Klasse von Fehlern aus, in der eine Streuung zwei
 * verschiedene Dateien zusammenwirft.
 */
export async function bildKennung(blob: Blob): Promise<string> {
  try {
    if (crypto?.subtle) {
      const summe = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
      return `${blob.size}-${hex(summe).slice(0, 24)}`;
    }
  } catch {
    // Kein sicherer Kontext, kein Speicher für den Puffer – beides endet hier.
  }
  return `${blob.size}-f${await streuung(blob)}`;
}

/** Der Entwurf, wie er aus dem Speicher kommt – schon geprüft und übersetzt. */
export interface Entwurfsfund {
  doc: BildDoc;
  stand: number;
}

/**
 * Den Entwurf zu diesem Bild holen – oder `null`.
 *
 * `null` heisst in jedem Fall „einfach neu anfangen": kein Entwurf da, falsche
 * Masse, ein Entwurf, der gar nichts enthält. Der letzte Fall ist nicht
 * theoretisch: Wer den Editor aufmacht, nichts tut und wieder schliesst, hätte
 * sonst beim nächsten Mal eine Frage zu beantworten, hinter der nichts steht.
 */
export async function entwurfHolen(
  kennung: string,
  breite: number,
  hoehe: number,
): Promise<Entwurfsfund | null> {
  const roh = await entwurfLesen(kennung);
  if (!roh) return null;
  if (roh.breite !== breite || roh.hoehe !== hoehe) return null;
  const doc = docAusRoh(roh.doc, breite, hoehe);
  if (docUnberuehrt(doc, breite, hoehe)) return null;
  return { doc, stand: roh.stand };
}

/**
 * Den Entwurf fortschreiben – oder ihn wegräumen, wenn nichts mehr da ist.
 *
 * Das Wegräumen gehört ausdrücklich hierher und nicht nur ans Verwerfen: Wer
 * eine Bearbeitung Schritt für Schritt zurücknimmt, bis das Bild wieder
 * unberührt ist, hat sie nicht mehr – und bekäme beim nächsten Aufmachen sonst
 * die Frage nach einem Entwurf, der aus nichts besteht.
 */
export async function entwurfSichern(
  kennung: string,
  doc: BildDoc,
  breite: number,
  hoehe: number,
  name: string | null,
): Promise<void> {
  if (docUnberuehrt(doc, breite, hoehe)) {
    await entwurfLoeschen(kennung);
    return;
  }
  await entwurfSchreiben({
    id: kennung,
    // `docNachRoh` gibt reines JSON und teilt kein Feld mehr mit dem
    // lebenden Dokument – eine zusätzliche Kopie wäre nur Arbeit.
    doc: docNachRoh(doc),
    breite,
    hoehe,
    stand: Date.now(),
    name,
  });
}

export { entwurfLoeschen };

/** „vor 3 Minuten", „vor 2 Stunden", „gestern" – für die Frage im Editor. */
export function entwurfAlter(stand: number, jetzt = Date.now()): string {
  const sekunden = Math.max(0, Math.round((jetzt - stand) / 1000));
  if (sekunden < 90) return 'von gerade eben';
  const minuten = Math.round(sekunden / 60);
  if (minuten < 60) return `von vor ${minuten} Minuten`;
  const stunden = Math.round(minuten / 60);
  if (stunden < 24) return `von vor ${stunden} ${stunden === 1 ? 'Stunde' : 'Stunden'}`;
  const tage = Math.round(stunden / 24);
  if (tage === 1) return 'von gestern';
  return `von vor ${tage} Tagen`;
}
