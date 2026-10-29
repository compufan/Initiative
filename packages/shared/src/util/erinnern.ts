import { LIMITS } from '../constants.js';

/**
 * Wie viele Erinnerungen bis zum Beginn des Termins noch passen.
 *
 * Die Vorschau im Terminblatt („Bis zum Beginn passen 2 Erinnerungen“) und der
 * Erinnerungsdienst im Server müssen dasselbe rechnen; beide laufen gegen
 * `testdaten/erinnern.json` (`erinnern.test.ts`, `apps/api/tests/erinnern.rs`).
 *
 * Die k-te Erinnerung kommt bei `ab + k × Abstand`, solange das nicht später
 * als zwei Stunden vor dem Beginn liegt – die Grenze selbst zählt noch mit.
 * Bei ganztägigen Terminen ist der Beginn zwölf Stunden vor dem gespeicherten
 * Zeitpunkt (der Editor legt sie auf 12:00 Ortszeit; der Server kennt keine
 * Zeitzone). Mehr als zehn gibt es nie, auch bei „bis zum Termin“.
 */
export function erinnerungenBisBeginn(eingabe: {
  /** Ab wann gerechnet wird: Einladung bzw. Einstellung. */
  ab: Date | string;
  /** Der gespeicherte Beginn des Termins. */
  beginn: Date | string;
  ganztaegig: boolean;
  nachStunden: number;
  /** `null`: bis zum Termin. */
  anzahl: number | null;
}): number {
  const STUNDE = 3_600_000;
  const ab = new Date(eingabe.ab).getTime();
  const beginn = new Date(eingabe.beginn).getTime() - (eingabe.ganztaegig ? 12 * STUNDE : 0);
  const spaetestens = beginn - LIMITS.erinnernReserveStd * STUNDE;
  const abstand = eingabe.nachStunden * STUNDE;
  const hoechstens = Math.min(eingabe.anzahl ?? LIMITS.erinnernAnzahlMax, LIMITS.erinnernAnzahlMax);
  if (!(abstand > 0) || !Number.isFinite(ab) || !Number.isFinite(spaetestens)) return 0;
  let anzahl = 0;
  while (anzahl < hoechstens && ab + (anzahl + 1) * abstand <= spaetestens) anzahl += 1;
  return anzahl;
}
