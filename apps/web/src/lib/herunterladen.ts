/**
 * Etwas auf dem Gerät speichern – an einer Stelle für die ganze App.
 *
 * Klingt nach drei Zeilen, ist es auch – nur an drei verschiedenen Stellen
 * dreimal *unterschiedlich* falsch. Deshalb hier einmal richtig:
 *
 * **Die Adresse zu früh freigeben.** `URL.revokeObjectURL` direkt nach dem
 * Klick sieht sauber aus, ist aber ein Wettlauf: Der Browser hat den Download
 * dann noch gar nicht begonnen, und in Safari kommt eine leere Datei heraus.
 * Also erst nach einer Weile freigeben.
 *
 * **Die installierte App auf dem iPhone.** Dort führt ein `download`-Verweis
 * oft ins Leere: kein Fehler, keine Datei, nichts. Der Weg, der dort
 * funktioniert, ist das Teilen-Blatt – und das ist für den Anwender ohnehin
 * das Vertraute („Bild sichern“, „In Dateien sichern“). Nur dort wird es
 * benutzt; auf dem Rechner wäre ein Teilen-Dialog statt eines Downloads eine
 * Zumutung.
 *
 * **Der Klick, der keiner mehr ist.** `navigator.share` verlangt eine frische
 * Nutzerhandlung. Wer vorher lange rechnet und dann teilt, bekommt eine
 * Ablehnung. Die Aufrufer sollen deshalb möglichst kurz vor dem Teilen fertig
 * sein – und wenn es doch schiefgeht, fällt es hier auf den Verweis zurück,
 * statt kommentarlos nichts zu tun.
 */

/** Wie lange die Blob-Adresse stehen bleibt, bevor sie freigegeben wird. */
const FREIGABE_NACH_MS = 60_000;

export type Ablage = 'geladen' | 'geteilt' | 'abgebrochen';

export interface Umgebung {
  userAgent: string;
  /** `navigator.platform` – veraltet, aber der einzige Weg, iPadOS zu erkennen. */
  platform: string;
  maxTouchPoints: number;
  /** `navigator.standalone`, nur auf Apple-Geräten vorhanden. */
  standalone: boolean;
  /** Ob `(display-mode: standalone)` zutrifft. */
  alsApp: boolean;
}

/**
 * Ob die App gerade als installierte App auf einem iPhone oder iPad läuft.
 *
 * Als reine Funktion, damit sie prüfbar ist: Der iPadOS-Fall ist genau die
 * Art Sonderregel, die man einmal falsch schreibt und dann nie wieder ansieht.
 * Ein iPad meldet sich seit Jahren als „Macintosh“ und ist nur am Touch-Zähler
 * von einem echten Mac zu unterscheiden.
 */
export function istInstalliertesApple(umgebung: Umgebung): boolean {
  const apple =
    /iP(hone|ad|od)/.test(umgebung.userAgent) ||
    (umgebung.platform === 'MacIntel' && umgebung.maxTouchPoints > 1);
  if (!apple) return false;
  return umgebung.standalone || umgebung.alsApp;
}

function umgebungLesen(): Umgebung | null {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return null;
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
    standalone: (navigator as Navigator & { standalone?: boolean }).standalone === true,
    alsApp: window.matchMedia?.('(display-mode: standalone)').matches === true,
  };
}

function ueberVerweis(blob: Blob, name: string): Ablage {
  const url = URL.createObjectURL(blob);
  const verweis = document.createElement('a');
  verweis.href = url;
  verweis.download = name;
  verweis.rel = 'noopener';
  // Angehängt, nicht nur erzeugt: Firefox ignoriert einen Klick auf ein
  // Element, das nicht im Dokument steht.
  document.body.append(verweis);
  verweis.click();
  verweis.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), FREIGABE_NACH_MS);
  return 'geladen';
}

/**
 * Speichert `blob` unter `name` auf dem Gerät.
 *
 * Gibt zurück, welcher Weg genommen wurde – `abgebrochen`, wenn der Anwender
 * das Teilen-Blatt weggewischt hat. Das ist kein Fehler und soll auch nicht
 * als solcher gemeldet werden.
 */
export async function herunterladen(blob: Blob, name: string): Promise<Ablage> {
  const umgebung = umgebungLesen();
  if (umgebung && istInstalliertesApple(umgebung) && typeof navigator.share === 'function') {
    try {
      const datei = new File([blob], name, { type: blob.type || 'application/octet-stream' });
      if (navigator.canShare?.({ files: [datei] })) {
        await navigator.share({ files: [datei] });
        return 'geteilt';
      }
    } catch (fehler) {
      // Weggewischt ist eine Antwort, kein Fehler – dann nicht noch einen
      // Download hinterherschieben, den niemand wollte.
      if (fehler instanceof DOMException && fehler.name === 'AbortError') return 'abgebrochen';
      // Alles andere: der gewöhnliche Weg ist besser als gar nichts.
    }
  }
  return ueberVerweis(blob, name);
}

/** Dasselbe für etwas, das erst noch geholt werden muss. */
export async function herunterladenVonUrl(url: string, name: string): Promise<Ablage> {
  const antwort = await fetch(url, { credentials: 'include' });
  if (!antwort.ok) throw new Error(`Konnte nicht geladen werden (${antwort.status})`);
  return await herunterladen(await antwort.blob(), name);
}
