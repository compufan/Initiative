/**
 * Feste Werte des Bildeditors, die auch ausserhalb von ihm gebraucht werden.
 *
 * WARUM eine eigene Datei: Die Bildblase, die Sammlungen und das Senden eines
 * Rezepts brauchen genau diese drei Werte – und sonst nichts vom Editor.
 * Stünden sie nur in `doc.ts` und `rezept.ts`, zöge jeder dieser Importe die
 * Rechenkette des Editors (Ton, Masken, Schärfe …) ins Start-Stück der App.
 * `doc.ts` und `rezept.ts` reichen sie unverändert weiter; die Werte gibt es
 * also nur einmal.
 */

/** Die längste Kante, die beim Speichern herauskommt. */
export const MAX_KANTE = 2560;

/** Der Dateiname, unter dem ein Rezept an der Nachricht hängt. */
export const REZEPT_DATEINAME = 'rezept.json.gz';

/** Der Typ, unter dem es hochgeladen wird – `file` erlaubt jeden. */
export const REZEPT_MIME = 'application/gzip';
