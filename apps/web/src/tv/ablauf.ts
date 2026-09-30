/**
 * Die Entscheidungen des Fernsehblatts – ohne DOM, damit sie sich prüfen lassen.
 *
 * # Warum das aus `tv.ts` herausgezogen ist
 *
 * `tv.ts` ist ein Skript mit Wirkung beim Laden: Es sucht Elemente, meldet
 * sich beim Server an und startet einen Takt. In einer Prüfung ohne Browser
 * lässt es sich nicht einmal importieren. Die Fragen, an denen die Fehler
 * dieses Blatts hingen – „muss die Liste neu geholt werden?", „ist das noch
 * dasselbe Stück?", „welche Taste war das?" –, sind aber reine Rechnungen.
 * Hier stehen sie für sich und haben ihre Prüfung in `ablauf.test.ts`.
 *
 * # Warum hier nichts Neueres als 2017 steht
 *
 * Der Bau senkt das Fernsehblatt ohnehin auf Chromium 63 ab
 * (`scripts/fernsehblatt.ts`). Aber was eine Bibliothek des Browsers ist und
 * keine Schreibweise – `replaceChildren`, `Promise.finally` –, kann der Bau
 * nicht nachrüsten. Deshalb benutzt diese Datei nur, was ein Fernseher von
 * 2019 kennt.
 */

/**
 * Nach wie vielen Millisekunden das Blatt die Liste von sich aus neu holt.
 *
 * Eine Karte gilt sechs Stunden (`auth::fernsehticket`). Das Blatt holte die
 * Liste aber nur, wenn jemand am Telefon etwas änderte – eine Diashow, die
 * niemand anfasst, lief nach sechs Stunden in lauter 401. Fünf Stunden lassen
 * eine Stunde Luft für das Video, das gerade noch mit der alten Karte läuft.
 */
export const KARTEN_ERNEUERN_MS = 5 * 60 * 60 * 1000;

/** Sind die Karten der geholten Liste so alt, dass sie erneuert werden müssen? */
export function kartenAlt(geholtUm: number, jetzt: number): boolean {
  return jetzt - geholtUm >= KARTEN_ERNEUERN_MS;
}

/** Was vom Stand hier gebraucht wird – so, wie er vom Server kommt. */
export interface StandAuskunft {
  art?: unknown;
  saat?: unknown;
  modus?: unknown;
  stueckzahl?: unknown;
}

/** Was vom laufenden Programm hier gebraucht wird. */
export interface ProgrammKopf {
  saat: number;
  modus: string;
  stueckzahl: number;
}

/**
 * Muss die Liste neu geholt werden – oder genügt, was im Stand steht?
 *
 * # Warum das die Frage ist, an der „Pause startet von vorn" hing
 *
 * Jeder Griff an die Fernbedienung erhöht die Fassung. Das Blatt holte dann
 * die ganze Liste neu – mit frischen Karten, also mit NEUEN Adressen für jedes
 * Stück – und spielte das aktuelle Stück ab. Bei einem Video heisst eine neue
 * Adresse: Es lädt neu und beginnt bei null. Pause zeigte das Video wieder am
 * Anfang, „Weiter" spielte es von vorn.
 *
 * Neu geholt wird jetzt nur, wenn sich die LISTE geändert haben kann: andere
 * Saat (jedes Einstellen und jeder Wechsel auf „Gemischt" würfelt neu),
 * anderer Modus, andere Stückzahl – oder die Karten werden alt. Ein Stand
 * ohne Saat kommt von einem älteren Server; dann wird wie früher geholt.
 */
export function listeNeuHolen(
  stand: StandAuskunft,
  programm: ProgrammKopf | null,
  geholtUm: number,
  jetzt: number,
): boolean {
  if (!programm) return true;
  if (kartenAlt(geholtUm, jetzt)) return true;
  if (stand.art !== undefined && stand.art !== 'diashow') return true;
  if (typeof stand.saat !== 'number') return true;
  return (
    stand.saat !== programm.saat ||
    stand.modus !== programm.modus ||
    stand.stueckzahl !== programm.stueckzahl
  );
}

/** Eine Stelle im Kreis – auch rückwärts über den Anfang hinaus. */
export function imKreis(stelle: number, anzahl: number): number {
  if (!(anzahl > 0)) return 0;
  return ((stelle % anzahl) + anzahl) % anzahl;
}

/** Was eine Taste der Fernbedienung bedeutet – oder `null`. */
export type TastenSinn = 'weiter' | 'zurueck' | 'ok';

/**
 * Eine Taste deuten – über `key` und, wo der fehlt, über `keyCode`.
 *
 * # Warum beides
 *
 * Neuere Browser melden `key` („ArrowRight", „Enter"). Ältere Fernseher
 * melden bei manchen Tasten nur „Unidentified" und den alten Zahlencode. Die
 * OK-Taste ist fast überall 13, wie Enter; die Pfeile 37 und 39. 10252 ist
 * „Abspielen/Pause" auf Samsung-Geräten, 415 und 19 sind Abspielen und Pause
 * einzeln (LG und viele andere).
 */
export function tasteDeuten(
  key: string | undefined,
  keyCode: number | undefined,
): TastenSinn | null {
  switch (key) {
    case 'ArrowRight':
    case 'MediaTrackNext':
      return 'weiter';
    case 'ArrowLeft':
    case 'MediaTrackPrevious':
      return 'zurueck';
    case ' ':
    case 'Enter':
    case 'MediaPlayPause':
      return 'ok';
    default:
      break;
  }
  switch (keyCode) {
    case 39:
    case 10233:
      return 'weiter';
    case 37:
    case 10232:
      return 'zurueck';
    case 13:
    case 32:
    case 10252:
    case 415:
    case 19:
      return 'ok';
    default:
      return null;
  }
}
