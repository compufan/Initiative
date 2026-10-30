import type { AttachmentDto } from '@initiative/shared';

/**
 * Hochladen in Stücken – fortsetzbar, für Dateien bis in die Gigabytes.
 *
 * # Warum
 *
 * Der alte Weg schickt eine Datei in EINER Anfrage. Bei einem Video von
 * zwei Gigabyte heisst jeder Wackler im Mobilfunk: alles von vorn – und der
 * Server hielte die ganze Datei im Arbeitsspeicher. Hier geht die Datei in
 * Stücken zu 8 MiB (`LIMITS.stueckGroesse`), zwei bis drei gleichzeitig. Ein
 * abgerissenes Stück wird mit wachsender Pause wiederholt; reisst das Netz
 * ganz ab, merkt sich die Outbox die Sitzungskennung und macht nach dem
 * Wiederkommen (oder Neuladen) dort weiter, wo der Server steht.
 *
 * # Aufbau
 *
 * Die Rechnerei (welche Stücke fehlen, wie lange warten, wie lange noch) ist
 * reine Funktion und ohne Netz prüfbar (`stueckUpload.test.ts`). Das Netz
 * kommt über `StueckTransport` herein – in der App `apiTransport` in
 * `lib/upload.ts`, im Test eine Attrappe.
 *
 * Die Server-Seite steht in `apps/api/src/modules/stuecke.rs`.
 */

/** Was der Server über eine Sitzung sagt. */
export interface StueckStand {
  sitzungId: string;
  attachmentId: string;
  groesse: number;
  stueckGroesse: number;
  anzahl: number;
  empfangen: number[];
  empfangenBytes: number;
  status: 'offen' | 'abschluss' | 'fertig';
  ablaufAt: string;
}

export interface StueckMetadaten {
  width?: number;
  height?: number;
  durationMs?: number;
  waveform?: number[];
  previewDataUrl?: string;
}

/** Ein Fehler mit HTTP-Status; 0 heisst „kein Netz / keine Antwort". */
export interface MitStatus {
  status: number;
}

export interface StueckTransport {
  anlegen(eingabe: {
    kind: string;
    mime: string;
    size: number;
    fileName?: string;
    sha256?: string;
  }): Promise<StueckStand>;
  /** `null`, wenn es die Sitzung nicht (mehr) gibt. */
  stand(sitzungId: string): Promise<StueckStand | null>;
  /** `sha256`: Hex-Prüfsumme dieses Stücks (Kopfzeile `X-Stueck-Sha256`), falls berechenbar. */
  senden(
    sitzungId: string,
    start: number,
    stueck: Blob,
    gesamt: number,
    signal?: AbortSignal,
    sha256?: string,
  ): Promise<void>;
  abschliessen(
    sitzungId: string,
    metadaten: StueckMetadaten,
  ): Promise<AttachmentDto & { sha256?: string }>;
  abbrechen(sitzungId: string): Promise<void>;
}

export interface Fortschritt {
  geladen: number;
  gesamt: number;
  /** Geschätzte Restzeit in Sekunden, `null` solange es keine Rate gibt. */
  restSek: number | null;
}

/**
 * SHA-256 (Hex) eines Stücks per WebCrypto.
 *
 * Pro 8-MiB-Stück und nicht über die ganze Datei: `crypto.subtle.digest`
 * kennt keinen Strom, eine 4-GiB-Datei müsste dafür ganz in den
 * Arbeitsspeicher. Der Server prüft jedes Stück beim Empfang gegen diese
 * Summe und bucht es erst dann – so ist die Übertragung Ende zu Ende
 * gesichert. `undefined`, wo WebCrypto fehlt (unsicherer Kontext, uralter
 * Browser): Dann geht das Stück ohne Summe, wie bei älteren Servern.
 */
export async function stueckSha256(stueck: Blob): Promise<string | undefined> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return undefined;
  try {
    const summe = new Uint8Array(await subtle.digest('SHA-256', await stueck.arrayBuffer()));
    return Array.from(summe, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return undefined;
  }
}

/* ---------------- reine Rechnerei ---------------- */

/** Wie viele Stücke eine Datei hat. */
export function stueckAnzahl(groesse: number, stueckGroesse: number): number {
  return Math.max(0, Math.ceil(groesse / stueckGroesse));
}

/** Byte-Bereich eines Stückes, `ende` ausschliesslich. */
export function stueckBereich(
  nr: number,
  groesse: number,
  stueckGroesse: number,
): { start: number; ende: number } {
  const start = nr * stueckGroesse;
  return { start, ende: Math.min(groesse, start + stueckGroesse) };
}

/** Die Stücke, die noch fehlen – aufsteigend, damit der Anfang zuerst steht. */
export function offeneStuecke(
  groesse: number,
  stueckGroesse: number,
  empfangen: Iterable<number>,
): number[] {
  const da = new Set(empfangen);
  const offen: number[] = [];
  for (let nr = 0; nr < stueckAnzahl(groesse, stueckGroesse); nr += 1) {
    if (!da.has(nr)) offen.push(nr);
  }
  return offen;
}

/** Bytes der schon empfangenen Stücke. */
export function empfangeneBytes(
  groesse: number,
  stueckGroesse: number,
  empfangen: Iterable<number>,
): number {
  let summe = 0;
  for (const nr of new Set(empfangen)) {
    const { start, ende } = stueckBereich(nr, groesse, stueckGroesse);
    if (start < groesse) summe += ende - start;
  }
  return summe;
}

/**
 * Wie lange vor dem nächsten Versuch gewartet wird.
 *
 * Verdoppelnd ab einer Sekunde, gedeckelt bei dreissig, mit Streuung: Kommen
 * drei parallele Stücke gleichzeitig aus einem Funkloch, sollen sie nicht im
 * selben Augenblick wieder anklopfen.
 */
export function wartezeitMs(versuch: number, zufall: () => number = Math.random): number {
  const basis = Math.min(30_000, 1000 * 2 ** Math.max(0, versuch - 1));
  return Math.round(basis * (0.75 + 0.5 * zufall()));
}

/** Lohnt ein neuer Versuch? Netz weg, Zeitüberschreitung, Überlast – ja. */
export function wiederholbar(fehler: unknown): boolean {
  if (fehler instanceof DOMException && fehler.name === 'AbortError') return false;
  const status = (fehler as Partial<MitStatus> | null)?.status;
  if (typeof status !== 'number') return true;
  if (status === 0) return true;
  // 507 heisst „Platte voll" – das wird durch Warten nicht besser.
  if (status === 507) return false;
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Gleitende Übertragungsrate für die Restzeit.
 *
 * Die Stücke kommen ruckweise (alle 8 MiB eine Meldung), also nicht
 * Momentaufnahmen nehmen, sondern über die letzten Meldungen mitteln – sonst
 * springt „noch 2 min" im Sekundentakt auf „noch 9 min" und zurück.
 */
export class Rate {
  private proben: { zeit: number; bytes: number }[] = [];

  constructor(private readonly fensterMs = 20_000) {}

  melden(bytes: number, zeit: number): void {
    this.proben.push({ zeit, bytes });
    while (this.proben.length > 2 && zeit - this.proben[0].zeit > this.fensterMs) {
      this.proben.shift();
    }
  }

  /** Bytes je Sekunde, `null` ohne genug Messpunkte. */
  bytesProSekunde(): number | null {
    if (this.proben.length < 2) return null;
    const erste = this.proben[0];
    const letzte = this.proben[this.proben.length - 1];
    const dauer = (letzte.zeit - erste.zeit) / 1000;
    if (dauer <= 0) return null;
    return (letzte.bytes - erste.bytes) / dauer;
  }
}

export function restSekunden(gesamt: number, geladen: number, rate: number | null): number | null {
  if (!rate || rate <= 0) return null;
  return Math.max(0, Math.ceil((gesamt - geladen) / rate));
}

/** „noch 3 min" – für die Blase. */
export function restzeitText(sek: number | null): string {
  if (sek == null) return '';
  if (sek < 60) return 'noch weniger als 1 min';
  if (sek < 3600) return `noch ${Math.ceil(sek / 60)} min`;
  const std = Math.floor(sek / 3600);
  const min = Math.ceil((sek % 3600) / 60);
  return min > 0 ? `noch ${std} h ${min} min` : `noch ${std} h`;
}

/* ---------------- Ablauf ---------------- */

export interface StueckUploadOptionen {
  datei: Blob;
  kind: string;
  mime: string;
  fileName?: string;
  metadaten: StueckMetadaten;
  transport: StueckTransport;
  /** Eine Sitzung von früher – dann wird fortgesetzt statt neu angelegt. */
  sitzungId?: string | null;
  /** Wird gerufen, sobald eine (neue) Sitzung feststeht – zum Merken. */
  onSitzung?: (sitzungId: string) => void | Promise<void>;
  onFortschritt?: (fortschritt: Fortschritt) => void;
  signal?: AbortSignal;
  /** Wie viele Stücke gleichzeitig unterwegs sind (Vorgabe 3). */
  parallel?: number;
  /** Versuche je Stück, bevor aufgegeben wird (Vorgabe 6, ≈ 1 min Warten). */
  maxVersuche?: number;
  /** Prüfsumme je Stück (Vorgabe: WebCrypto); zum Prüfen austauschbar. */
  stueckSumme?: (stueck: Blob) => Promise<string | undefined>;
  /** Zum Prüfen austauschbar. */
  schlafen?: (ms: number, signal?: AbortSignal) => Promise<void>;
  jetzt?: () => number;
}

function abbruchFehler(): DOMException {
  return new DOMException('Upload abgebrochen', 'AbortError');
}

export function schlafenMitAbbruch(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abbruchFehler());
      return;
    }
    const zeit = setTimeout(() => {
      signal?.removeEventListener('abort', weg);
      resolve();
    }, ms);
    const weg = () => {
      clearTimeout(zeit);
      reject(abbruchFehler());
    };
    signal?.addEventListener('abort', weg, { once: true });
  });
}

/** Wiederholt `arbeit`, solange der Fehler danach aussieht, dass Warten hilft. */
async function mitWiederholung<T>(
  arbeit: () => Promise<T>,
  maxVersuche: number,
  schlafen: NonNullable<StueckUploadOptionen['schlafen']>,
  signal?: AbortSignal,
  nochmal: (fehler: unknown) => boolean = wiederholbar,
): Promise<T> {
  for (let versuch = 1; ; versuch += 1) {
    if (signal?.aborted) throw abbruchFehler();
    try {
      return await arbeit();
    } catch (fehler) {
      if (signal?.aborted) throw abbruchFehler();
      if (!nochmal(fehler) || versuch >= maxVersuche) throw fehler;
      await schlafen(wartezeitMs(versuch), signal);
    }
  }
}

/**
 * Lädt eine Datei in Stücken hoch und gibt den fertigen Anhang zurück.
 *
 * Wirft der Ablauf mit einem Fehler, der `wiederholbar` ist (Netz weg), darf
 * der Aufrufer es später mit derselben `sitzungId` wieder versuchen – der
 * Server weiss, welche Stücke schon da sind.
 */
export async function stueckweiseHochladen(
  opt: StueckUploadOptionen,
): Promise<AttachmentDto & { sha256?: string }> {
  const {
    datei,
    transport,
    signal,
    parallel = 3,
    maxVersuche = 6,
    schlafen = schlafenMitAbbruch,
    jetzt = () => Date.now(),
    stueckSumme = stueckSha256,
  } = opt;
  const gesamt = datei.size;

  // 1. Fortsetzen, wenn es eine passende Sitzung gibt.
  let stand: StueckStand | null = null;
  if (opt.sitzungId) {
    stand = await mitWiederholung(
      () => transport.stand(opt.sitzungId as string),
      maxVersuche,
      schlafen,
      signal,
    );
    if (stand && stand.groesse !== gesamt) {
      // Eine andere Datei (etwa nach dem erneuten Auswählen) – die alte
      // Sitzung ist wertlos.
      await transport.abbrechen(stand.sitzungId).catch(() => {});
      stand = null;
    }
  }
  if (!stand) {
    stand = await mitWiederholung(
      () =>
        transport.anlegen({
          kind: opt.kind,
          mime: opt.mime,
          size: gesamt,
          fileName: opt.fileName,
        }),
      maxVersuche,
      schlafen,
      signal,
    );
    await opt.onSitzung?.(stand.sitzungId);
  }
  const sitzungId = stand.sitzungId;
  const stueckGroesse = stand.stueckGroesse;

  // 2. Die fehlenden Stücke, `parallel` gleichzeitig.
  let geladen = empfangeneBytes(gesamt, stueckGroesse, stand.empfangen);
  const rate = new Rate();
  rate.melden(geladen, jetzt());
  const melden = () =>
    opt.onFortschritt?.({
      geladen,
      gesamt,
      restSek: restSekunden(gesamt, geladen, rate.bytesProSekunde()),
    });
  melden();

  if (stand.status !== 'fertig') {
    const warteschlange = offeneStuecke(gesamt, stueckGroesse, stand.empfangen);
    let fehler: unknown = null;
    const arbeiter = async () => {
      while (warteschlange.length > 0 && !fehler) {
        const nr = warteschlange.shift() as number;
        const { start, ende } = stueckBereich(nr, gesamt, stueckGroesse);
        try {
          const teil = datei.slice(start, ende);
          // Einmal je Stück gerechnet; die Wiederholungen schicken dieselbe
          // Summe mit. Stimmt sie am Server nicht (422: beim Übertragen
          // verändert), geht dasselbe Stück noch einmal.
          const summe = await stueckSumme(teil);
          await mitWiederholung(
            () => transport.senden(sitzungId, start, teil, gesamt, signal, summe),
            maxVersuche,
            schlafen,
            signal,
            (f) => wiederholbar(f) || (f as Partial<MitStatus>)?.status === 422,
          );
        } catch (ausfall) {
          fehler ??= ausfall;
          return;
        }
        geladen += ende - start;
        rate.melden(geladen, jetzt());
        melden();
      }
    };
    await Promise.all(
      Array.from({ length: Math.max(1, Math.min(parallel, warteschlange.length)) }, arbeiter),
    );
    if (fehler) throw fehler;
  }

  // 3. Abschliessen. Ein 409 heisst hier „läuft schon" oder „es fehlt noch
  // etwas" – beim ersten warten, beim zweiten ist es ein echter Fehler, den
  // der nächste Durchgang über den Stand neu aufrollt.
  return mitWiederholung(
    () => transport.abschliessen(sitzungId, opt.metadaten),
    maxVersuche,
    schlafen,
    signal,
    (fehler) => wiederholbar(fehler) || (fehler as Partial<MitStatus>)?.status === 409,
  );
}
