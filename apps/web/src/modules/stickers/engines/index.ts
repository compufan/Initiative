/**
 * Die Sammelstelle aller Freistell-Verfahren.
 *
 * Hier – und nur hier – wird entschieden, welches Verfahren gerade laufen
 * darf. Die schweren Verfahren werden per `import()` nachgeladen, damit weder
 * ihr Code noch ihr Modell im normalen Startpaket liegt: Wer nie einen
 * Sticker baut, lädt davon nichts.
 */

import { isEngineEnabled } from './settings.js';
import { ENGINE_INFO, type EngineInfo, type EngineKey } from './types.js';
import { runtimeSupported } from './runtime.js';

export type { EngineKey, EngineInfo } from './types.js';
export { ENGINE_INFO, downloadHint, firstUseMb } from './types.js';
export { readEngineSettings, writeEngineSetting, isEngineEnabled } from './settings.js';

export interface MaskRequest {
  image: ImageData;
  /** Der angetippte Punkt in Bildkoordinaten, falls es einen gibt. */
  seed?: { x: number; y: number };
  /**
   * Alle angetippten Punkte mit Vorzeichen, in Bildkoordinaten.
   *
   * Nur „Antippen mit Netz“ wertet das aus – dessen Netz nimmt beliebig viele
   * Punkte entgegen, und ein Minus-Tipp ist die einzige Art, „das nicht“ zu
   * sagen. Die anderen Verfahren brauchen hoechstens `seed`.
   */
  seeds?: { x: number; y: number; dazu: boolean }[];
  /**
   * Wird waehrend eines laengeren Ladens gerufen: Anteil 0…1 und ein Satz,
   * den man zeigen kann. Bei knapp 94 MB ist das kein Schmuck – ohne
   * Rueckmeldung steht der Anwender vor einem Knopf, der nichts tut.
   */
  fortschritt?: (anteil: number, text: string) => void;
  /**
   * Abbruch – für alles, was Minuten dauern kann.
   *
   * „Hohe Qualität“ zieht beim ersten Mal 78 MB und rechnet danach auf der
   * Grafikeinheit. Wer versehentlich darauf tippt, sass bis eben fest: Es gab
   * keinen Weg zurück, und auch das Schliessen des Studios half nicht, weil
   * der Arbeiter samt Modell weiterlief.
   *
   * Der Abbruch kann nicht überall sofort greifen – ein laufender
   * Modelldurchlauf im Arbeiter lässt sich nur beenden, indem man den
   * Arbeiter wegwirft; genau das tut `releaseEngines`. Was er zuverlässig
   * tut: den Download abbrechen und das Ergebnis verwerfen, statt es in eine
   * Oberfläche zu schreiben, die längst weitergezogen ist.
   */
  abbruch?: AbortSignal;
  /**
   * Wer rechnen lässt – siehe `modellReihe`. Ohne Angabe `'vorn'`: der
   * Anwender wartet. `'hinten'` ist die Verfolgung von Masken im
   * Hintergrund; sie lässt jedem Aufruf aus dem Editor den Vortritt.
   */
  vorrang?: Vorrang;
}

/** Wurde abgebrochen? Dann keine Fehlermeldung, sondern Stille. */
export class AbbruchError extends Error {
  constructor() {
    super('Abgebrochen');
    this.name = 'AbbruchError';
  }
}

function abbruchPruefen(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AbbruchError();
}

/** Was beim Freistellen schiefgehen kann – mit einem Satz, den man zeigen kann. */
export class EngineError extends Error {
  constructor(
    message: string,
    readonly engine: EngineKey,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

/**
 * Ein Sonderfall von `EngineError`: nicht das Verfahren ist kaputt, es hat
 * schlicht nichts gefunden.
 *
 * Der Unterschied zählt für jeden, der ein Verfahren wiederholt aufruft – ein
 * Video etwa, Schlüsselbild für Schlüsselbild. Ist das Gerät zu schwach oder
 * das Modell abgeschaltet, gilt das für JEDEN Aufruf gleich, und weiterlaufen
 * hiesse, denselben Fehler fünfzig Mal zu ignorieren. Wurde dagegen nur an
 * DIESER Stelle nichts gefunden – das angetippte Ding ist aus dem Bild
 * gelaufen –, kann der nächste Aufruf wieder etwas finden.
 */
export class NichtsGefunden extends EngineError {
  constructor(message: string, engine: EngineKey) {
    super(message, engine);
    this.name = 'NichtsGefunden';
  }
}

export function engineInfo(key: EngineKey): EngineInfo {
  const info = ENGINE_INFO.find((entry) => entry.key === key);
  if (!info) throw new Error(`Unbekanntes Verfahren: ${key}`);
  return info;
}

/**
 * Ob das Verfahren gerade benutzt werden darf: eingeschaltet **und** vom
 * Gerät unterstützt.
 */
export function engineAvailable(key: EngineKey): boolean {
  if (key === 'tap') return true;
  if (!isEngineEnabled(key)) return false;
  return runtimeSupported();
}

/**
 * Rechnet die Maske aus.
 *
 * Fehler kommen als `EngineError` zurück – mit einem Satz, der dem Anwender
 * sagt, was er stattdessen tun kann. Das Studio fällt dann auf „Antippen“
 * zurück, statt nur „Fehler“ anzuzeigen.
 */
export async function runEngine(key: EngineKey, request: MaskRequest): Promise<Uint8Array> {
  if (key === 'tap') {
    throw new EngineError('„Antippen“ läuft direkt im Editor, nicht über ein Modell.', key);
  }
  if (key === 'tiefe') {
    // Kein Freisteller: Das Tiefenmodell liefert eine Entfernung je
    // Bildpunkt und keine Silhouette. Es läuft über `bild/tiefeNetz.ts` und
    // teilt sich mit den Freistellern nur die Verwaltung – Schalter,
    // Downloadgrösse, Laufzeit.
    throw new EngineError(
      '„Tiefenschärfe“ läuft über den Foto-Editor, nicht über diese Liste.',
      key,
    );
  }
  if (!engineAvailable(key)) {
    throw new EngineError(
      `„${engineInfo(key).label}“ ist auf diesem Gerät abgeschaltet. Du kannst es in den Einstellungen einschalten.`,
      key,
    );
  }

  abbruchPruefen(request.abbruch);

  try {
    const maske = await modellReihe(request.vorrang ?? 'vorn', () => rechnen(key, request), {
      verfahren: key,
      abbruch: request.abbruch,
    });
    /*
     * Nach dem Lauf noch einmal fragen.
     *
     * Ein Modelldurchlauf lässt sich nicht mitten im Rechnen anhalten. Was
     * sich verhindern lässt: dass ein Ergebnis, auf das niemand mehr wartet,
     * in eine Oberfläche geschrieben wird, die inzwischen etwas anderes
     * zeigt – oder in ein Dokument, das der Anwender längst verworfen hat.
     */
    abbruchPruefen(request.abbruch);
    return maske;
  } catch (error) {
    if (error instanceof AbbruchError) throw error;
    if (error instanceof EngineError) throw error;
    const grund = error instanceof Error ? error.message : 'Unbekannter Fehler';
    throw new EngineError(grund, key);
  }
}

async function rechnen(key: EngineKey, request: MaskRequest): Promise<Uint8Array> {
  switch (key) {
    case 'person': {
      const { personMask } = await import('./person.js');
      return await personMask(request.image);
    }
    case 'face': {
      const { faceMask } = await import('./face.js');
      return await faceMask(request.image, request.seed);
    }
    case 'tippen': {
      const { tippenMask } = await import('./tippen.js');
      return await tippenMask(request.image, request.seeds ?? [], request.fortschritt);
    }
    case 'object': {
      const { objectMask } = await import('./object.js');
      return await objectMask(request.image, request.fortschritt, request.abbruch);
    }
    case 'birefnet': {
      const { birefnetMask } = await import('./birefnet.js');
      return await birefnetMask(request.image, request.fortschritt, request.abbruch);
    }
    default:
      throw new EngineError('Unbekanntes Verfahren.', key);
  }
}

/**
 * Gibt belegten Speicher wieder frei.
 *
 * Wird beim Schliessen des Studios aufgerufen. Auf einem Handy ist das kein
 * Luxus: die Laufzeit belegt zweistellige Megabyte, und iOS beendet Seiten,
 * die zu viel halten, kommentarlos.
 */
export async function releaseEngines(): Promise<void> {
  // Die Module selbst sind ein paar Kilobyte Code; das Modell laden sie erst
  // beim Rechnen. Das Aufräumen zieht also nichts herunter.
  await Promise.all([
    import('./person.js').then((m) => m.releasePerson()).catch(() => {}),
    import('./face.js').then((m) => m.releaseFace()).catch(() => {}),
    import('./object.js').then((m) => m.releaseObject()).catch(() => {}),
    import('./tippen.js').then((m) => m.releaseTippen()).catch(() => {}),
    import('./birefnet.js').then((m) => m.releaseBirefnet()).catch(() => {}),
  ]);
}

/* ---------- Die Reihe: wer wann ein Modell rechnen lässt ---------- */

/**
 * Wer rechnen lässt: `'vorn'` der Anwender, der auf das Ergebnis wartet,
 * `'hinten'` die Verfolgung von Masken im Hintergrund (`video/verfolger.ts`).
 */
export type Vorrang = 'vorn' | 'hinten';

/**
 * Die Verfahren mit einer SCHWEREN Sitzung: ein Modell von zweistelligen
 * Megabyte im Speicher, dazu die Laufzeit – BiRefNet auf der Grafikeinheit,
 * die Tiefe mit 230 MB je Sitzung. Zwei davon zugleich sind auf einem
 * Telefon der Unterschied, bei dem Safari den Reiter neu lädt.
 */
export const SCHWERE_VERFAHREN: ReadonlySet<EngineKey> = new Set([
  'object',
  'birefnet',
  'tippen',
  'tiefe',
]);

/** So lange darf eine schwere Sitzung der Verfolgung ungenutzt offen bleiben. */
export const FREIGABE_NACH_MS = 20_000;

interface Reihenplatz {
  readonly vorrang: Vorrang;
  readonly verfahren?: EngineKey;
  readonly starten: () => void;
}

const reihe: Reihenplatz[] = [];
let laufenVorn = 0;
let laufenHinten = 0;
/**
 * Welche Verfahren gerade rechnen ODER in der Reihe warten – eine Sitzung in
 * Gebrauch wird nie freigegeben.
 *
 * # Warum auch die Wartenden
 *
 * Weil ein wartender Auftrag seine Sitzung schon in der Hand hat: Die
 * Verfolgung holt ihre Tiefensitzung und reiht erst DANN `karteFuer` ein.
 * Zählten nur die laufenden, gab ein Editor-Lauf eines anderen schweren
 * Verfahrens (oder der Zeitgeber nach 20 s) die Sitzung frei, während ihr
 * Auftrag noch wartete – und der rechnete danach auf einer geschlossenen
 * Sitzung („invalid session id"), und die Tiefe war für die Sitzung
 * verloren.
 */
const inGebrauch = new Map<EngineKey, number>();

/**
 * Verfahren, deren Sitzung ein Einzelstück je Modul ist – Editor und
 * Verfolgung rechnen auf DERSELBEN. Die Tiefe gehört nicht dazu: Sie hat
 * eine Sitzung je Aufrufer (`bild/tiefeNetz.ts`).
 */
const GETEILTE_SITZUNG: ReadonlySet<EngineKey> = new Set(['object', 'birefnet', 'tippen']);
/**
 * Die schwere Sitzung, die die Verfolgung zuletzt geöffnet hat, samt dem
 * Zeitgeber, der sie nach `FREIGABE_NACH_MS` wieder schliesst.
 */
let hintenSchwer: { verfahren: EngineKey; zeitgeber: ReturnType<typeof setTimeout> | null } | null =
  null;
/** Wie eine Sitzung freigegeben wird – je Verfahren, siehe `sitzungFreigeberSetzen`. */
const freigeber = new Map<EngineKey, () => Promise<void> | void>([
  ['object', () => import('./object.js').then((m) => m.releaseObject())],
  ['birefnet', () => import('./birefnet.js').then((m) => m.releaseBirefnet())],
  ['tippen', () => import('./tippen.js').then((m) => m.releaseTippen())],
]);

/**
 * Wie die Sitzung eines Verfahrens freigegeben wird, das nicht als
 * Modul-Einzelstück lebt – die Tiefe hat eine Sitzung je Aufrufer
 * (`bild/tiefeNetz.ts`). Die Verfolgung meldet ihre hier an, solange sie
 * offen ist, und mit `null` wieder ab.
 */
export function sitzungFreigeberSetzen(
  verfahren: EngineKey,
  freigabe: (() => Promise<void> | void) | null,
): void {
  if (freigabe) freigeber.set(verfahren, freigabe);
  else freigeber.delete(verfahren);
}

/** Was in der Reihe los ist – für die Prüfungen und die Anzeige. */
export function modellReiheStand(): { vorn: number; hinten: number; wartend: number } {
  return { vorn: laufenVorn, hinten: laufenHinten, wartend: reihe.length };
}

async function freigeben(verfahren: EngineKey): Promise<void> {
  try {
    await freigeber.get(verfahren)?.();
  } catch {
    // Freigeben ist Aufräumen – ein Fehler dabei hält niemanden auf.
  }
}

/**
 * Die Sitzung der Verfolgung freigeben, wenn jetzt ein ANDERES schweres
 * Verfahren an die Reihe kommt – höchstens eine schwere Sitzung zugleich.
 * Nie eine, mit der gerade gerechnet wird.
 */
async function schwereWechseln(verfahren: EngineKey | undefined): Promise<void> {
  const alt = hintenSchwer;
  if (!alt || !verfahren || !SCHWERE_VERFAHREN.has(verfahren) || alt.verfahren === verfahren) {
    return;
  }
  if ((inGebrauch.get(alt.verfahren) ?? 0) > 0) return;
  if (alt.zeitgeber) clearTimeout(alt.zeitgeber);
  hintenSchwer = null;
  await freigeben(alt.verfahren);
}

function nachDemLauf(platz: Reihenplatz): void {
  const verfahren = platz.verfahren;
  if (!verfahren || !SCHWERE_VERFAHREN.has(verfahren)) return;
  if (platz.vorrang === 'vorn') {
    /*
     * Der Anwender benutzt dieselbe Sitzung: Ab jetzt gehört sie dem
     * Editor, und wann sie geht, entscheidet er (`releaseEngines`) – wie
     * vor der Verfolgung.
     *
     * Nur für Einzelstücke je Modul. Ein Tiefenlauf des Editors rechnet auf
     * SEINER Sitzung; die der Verfolgung blieb sonst verwaist offen – ohne
     * Zeitgeber, und kein Wechsel gab sie mehr frei: zwei schwere Sitzungen,
     * 230 MB davon für nichts.
     */
    if (hintenSchwer?.verfahren === verfahren && GETEILTE_SITZUNG.has(verfahren)) {
      if (hintenSchwer.zeitgeber) clearTimeout(hintenSchwer.zeitgeber);
      hintenSchwer = null;
    }
    return;
  }
  if (hintenSchwer?.zeitgeber) clearTimeout(hintenSchwer.zeitgeber);
  const eintrag: { verfahren: EngineKey; zeitgeber: ReturnType<typeof setTimeout> | null } = {
    verfahren,
    zeitgeber: null,
  };
  const pruefen = () => {
    if (hintenSchwer !== eintrag) return;
    /*
     * Noch in Gebrauch (ein Auftrag wartet in der Reihe): später noch
     * einmal fragen. Nicht einfach aufgeben – wird der Wartende
     * abgebrochen, bevor er rechnet, käme sonst nie wieder jemand, und die
     * Sitzung bliebe offen.
     */
    if ((inGebrauch.get(verfahren) ?? 0) > 0) {
      eintrag.zeitgeber = setTimeout(pruefen, FREIGABE_NACH_MS);
      return;
    }
    hintenSchwer = null;
    void freigeben(verfahren);
  };
  eintrag.zeitgeber = setTimeout(pruefen, FREIGABE_NACH_MS);
  hintenSchwer = eintrag;
}

function pumpen(): void {
  for (;;) {
    const vorn = reihe.findIndex((platz) => platz.vorrang === 'vorn');
    if (vorn >= 0) {
      // Der Editor wartet höchstens auf EINEN laufenden Lauf der Verfolgung.
      if (laufenHinten > 0) return;
      reihe.splice(vorn, 1)[0].starten();
      continue;
    }
    if (reihe.length === 0 || laufenVorn > 0 || laufenHinten > 0) return;
    (reihe.shift() as Reihenplatz).starten();
    return;
  }
}

/**
 * Ein Modell rechnen lassen – eingereiht.
 *
 * # Warum eine Reihe
 *
 * Weil die Sitzungen Einzelstücke je Modul sind (`object.ts`, `person.ts`,
 * die ORT-Laufzeit) und `runEngine` bisher nichts ordnete. Solange nur der
 * Anwender rechnen liess, war das gleichgültig. Mit der Verfolgung im
 * Hintergrund liefen sonst zwei Modelläufe auf derselben Sitzung
 * gegeneinander, und ein Tipp im Editor wartete hinter einer Minute
 * Verfolgung.
 *
 * # Die Regeln
 *
 * - `'hinten'` rechnet allein: nur, wenn gerade nichts rechnet und kein
 *   `'vorn'` wartet. Einer zur Zeit.
 * - `'vorn'` überholt jedes wartende `'hinten'` und wartet höchstens auf
 *   den EINEN Lauf der Verfolgung, der schon rechnet (ein laufender
 *   Modellauf lässt sich nicht anhalten; bei BiRefNet rund zwei Sekunden).
 *   Mehrere `'vorn'` laufen nebeneinander wie bisher – die Reihe ordnet nur
 *   die Verfolgung ein und ändert am Editor nichts.
 * - Höchstens EINE schwere Sitzung der Verfolgung: Kommt ein anderes
 *   schweres Verfahren an die Reihe, wird die bisherige zuerst
 *   freigegeben, und nach `FREIGABE_NACH_MS` ohne Lauf ohnehin.
 *
 * Ein Abbruch, solange der Auftrag noch wartet, nimmt ihn aus der Reihe.
 */
export function modellReihe<T>(
  vorrang: Vorrang,
  arbeit: () => Promise<T>,
  optionen: { readonly verfahren?: EngineKey; readonly abbruch?: AbortSignal } = {},
): Promise<T> {
  const { verfahren, abbruch } = optionen;
  if (abbruch?.aborted) return Promise.reject(new AbbruchError());
  return new Promise<T>((erfuellen, ablehnen) => {
    const freiMelden = () => {
      if (verfahren) inGebrauch.set(verfahren, (inGebrauch.get(verfahren) ?? 1) - 1);
    };
    const aufgeben = () => {
      const stelle = reihe.indexOf(platz);
      if (stelle < 0) return;
      reihe.splice(stelle, 1);
      freiMelden();
      ablehnen(new AbbruchError());
      pumpen();
    };
    const platz: Reihenplatz = {
      vorrang,
      verfahren,
      starten: () => {
        abbruch?.removeEventListener('abort', aufgeben);
        if (vorrang === 'vorn') laufenVorn += 1;
        else laufenHinten += 1;
        void (async () => {
          try {
            await schwereWechseln(verfahren);
            erfuellen(await arbeit());
          } catch (fehler) {
            ablehnen(fehler);
          } finally {
            if (vorrang === 'vorn') laufenVorn -= 1;
            else laufenHinten -= 1;
            freiMelden();
            nachDemLauf(platz);
            pumpen();
          }
        })();
      },
    };
    abbruch?.addEventListener('abort', aufgeben, { once: true });
    // Schon beim Einreihen in Gebrauch – siehe `inGebrauch`.
    if (verfahren) inGebrauch.set(verfahren, (inGebrauch.get(verfahren) ?? 0) + 1);
    reihe.push(platz);
    pumpen();
  });
}
