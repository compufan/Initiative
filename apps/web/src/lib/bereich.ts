/**
 * Einen `Range`-Kopf auswerten – für den Service Worker.
 *
 * # Warum es das braucht
 *
 * Der Medienspeicher des Arbeiters legt ganze Antworten ab (Status 200). Die
 * Cache-API vergleicht beim Nachschlagen aber nur die Adresse und ignoriert
 * den `Range`-Kopf. Eine Teilanfrage – jedes Vorspulen in einem Video, und in
 * WebKit sogar das blosse Abspielen – bekam damit die GANZE Datei mit Status
 * 200 zurück. Safari verlangt für Medien eine 206 und bricht sonst ab: Das
 * Video blieb schwarz, obwohl die Datei vollständig im Gerät lag.
 *
 * Ausgelagert und ohne Browser prüfbar, weil hier die Fehler sitzen: das
 * Suffix (`bytes=-500`), das offene Ende (`bytes=100-`) und die Grenzfälle an
 * Anfang und Ende der Datei.
 */
export interface Teilbereich {
  start: number;
  /** Einschliesslich – wie in `Content-Range`. */
  ende: number;
}

/**
 * `null` heisst: nicht erfüllbar oder nicht verstanden – dann gehört die
 * ganze Datei ausgeliefert (200), nicht ein geratener Ausschnitt.
 *
 * Mehrfachbereiche (`bytes=0-99,200-299`) werden ausdrücklich nicht
 * unterstützt: Sie bräuchten eine mehrteilige Antwort, und kein Browser
 * schickt sie für Medien.
 */
export function bereichLesen(kopf: string | null, gesamt: number): Teilbereich | null {
  if (!kopf || gesamt <= 0) return null;
  const wert = kopf.trim().toLowerCase();
  if (!wert.startsWith('bytes=')) return null;
  const spanne = wert.slice(6);
  if (spanne.includes(',')) return null;

  const strich = spanne.indexOf('-');
  if (strich < 0) return null;
  const vorne = spanne.slice(0, strich).trim();
  const hinten = spanne.slice(strich + 1).trim();

  // `bytes=-500`: die letzten 500 Byte.
  if (vorne === '') {
    const laenge = Number.parseInt(hinten, 10);
    if (!Number.isFinite(laenge) || laenge <= 0) return null;
    return { start: Math.max(0, gesamt - laenge), ende: gesamt - 1 };
  }

  const start = Number.parseInt(vorne, 10);
  if (!Number.isFinite(start) || start < 0) return null;
  // Ein Anfang hinter dem Dateiende ist nicht erfüllbar.
  if (start >= gesamt) return null;

  if (hinten === '') return { start, ende: gesamt - 1 };
  const ende = Number.parseInt(hinten, 10);
  if (!Number.isFinite(ende) || ende < start) return null;
  return { start, ende: Math.min(ende, gesamt - 1) };
}
