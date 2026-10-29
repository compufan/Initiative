import {
  LIMITS,
  erinnerungenBisBeginn,
  type ErinnernDto,
  type RsvpStatus,
} from '@initiative/shared';

/**
 * Erinnern an ausstehende Antworten – alles, was die Oberfläche dazu rechnet
 * und formuliert, ohne React: Die Vorgaben, die Sätze, die Prüfung, was beim
 * Speichern gesendet wird.
 *
 * Die Grenzen stehen im Server (`services/erinnern.rs`) und im gemeinsamen
 * Paket; hier werden sie nur vorab gezeigt, entschieden wird dort.
 */

/** Die Fristen zur Auswahl, in Stunden. Andere Werte gehen über „Eigene Dauer“. */
export const FRIST_VORGABEN = [24, 48, 72, 168] as const;
/** Wie oft insgesamt zur Auswahl; `null` heisst „bis zum Termin“. */
export const ANZAHL_VORGABEN: readonly (number | null)[] = [1, 2, 3, 5, null];

/** Was beim Einschalten gilt: nach zwei Tagen, dreimal. */
export const ERINNERN_STANDARD: ErinnernDto = { nachStunden: 48, anzahl: 3 };

function pluralisiert(zahl: number, eins: string, viele: string): string {
  return `${zahl} ${zahl === 1 ? eins : viele}`;
}

/** „nach …“: 24 → „1 Tag“, 48 → „2 Tagen“ (Dativ), 168 → „1 Woche“, 36 → „36 Stunden“. */
export function fristText(stunden: number): string {
  if (stunden % 168 === 0) {
    const wochen = stunden / 168;
    return pluralisiert(wochen, 'Woche', 'Wochen');
  }
  if (stunden % 24 === 0) {
    const tage = stunden / 24;
    return tage === 1 ? '1 Tag' : `${tage} Tagen`;
  }
  return `${stunden} Stunden`;
}

/** Dieselbe Frist als Auswahltext ohne Dativ: „2 Tage“. */
export function fristKurz(stunden: number): string {
  if (stunden % 168 === 0) return pluralisiert(stunden / 168, 'Woche', 'Wochen');
  if (stunden % 24 === 0) return pluralisiert(stunden / 24, 'Tag', 'Tage');
  return `${stunden} Stunden`;
}

export function anzahlText(anzahl: number | null): string {
  if (anzahl === null) return `bis zum Termin (höchstens ${LIMITS.erinnernAnzahlMax}-mal)`;
  return anzahl === 1 ? 'einmal' : `bis zu ${anzahl}-mal`;
}

/** „nach 2 Tagen, bis zu 3-mal“ */
export function erinnernText(erinnern: ErinnernDto): string {
  return `nach ${fristText(erinnern.nachStunden)}, ${anzahlText(erinnern.anzahl)}`;
}

/** Der Fehlertext zur Eingabe – dieselben Grenzen wie der Server; `null`: in Ordnung. */
export function erinnernPruefen(nachStunden: number, anzahl: number | null): string | null {
  if (!Number.isInteger(nachStunden)) return 'Bitte eine ganze Zahl von Stunden.';
  if (nachStunden < LIMITS.erinnernNachStdMin) {
    return `Mindestens ${LIMITS.erinnernNachStdMin} Stunden.`;
  }
  if (nachStunden > LIMITS.erinnernNachStdMax) {
    return `Höchstens ${LIMITS.erinnernNachStdMax} Stunden (${LIMITS.erinnernNachStdMax / 24} Tage).`;
  }
  if (anzahl !== null && (!Number.isInteger(anzahl) || anzahl < 1))
    return 'Mindestens eine Erinnerung.';
  if (anzahl !== null && anzahl > LIMITS.erinnernAnzahlMax) {
    return `Höchstens ${LIMITS.erinnernAnzahlMax} Erinnerungen.`;
  }
  return null;
}

function gleich(a: ErinnernDto | null, b: ErinnernDto | null): boolean {
  if (a === null || b === null) return a === b;
  return a.nachStunden === b.nachStunden && a.anzahl === b.anzahl;
}

/**
 * Was beim Speichern gesendet wird – nur bei einem Unterschied.
 *
 * Ein Termin, an dem nur der Titel geändert wird, schickt die Einstellung nicht
 * mit: Der Server startet die Uhr bei jedem Unterschied neu, und eine
 * unveränderte Einstellung soll sie nicht anfassen. `undefined` heisst: Feld
 * weglassen; `null`: ausschalten.
 */
export function erinnernBody(
  bisher: ErinnernDto | null,
  jetzt: ErinnernDto | null,
  neuerTermin: boolean,
): { erinnern: ErinnernDto | null } | Record<string, never> {
  if (neuerTermin) return jetzt ? { erinnern: jetzt } : {};
  return gleich(bisher, jetzt) ? {} : { erinnern: jetzt };
}

/**
 * Der Hinweis zur Wirkung, live aus Beginn und Einstellung. `ab` ist der
 * Zeitpunkt, ab dem gerechnet wird – für einen neuen Termin „jetzt“.
 */
export function wirkungsHinweis(eingabe: {
  erinnern: ErinnernDto;
  ab: Date;
  beginn: Date | null;
  ganztaegig: boolean;
  wiederholt: boolean;
}): string[] {
  const zeilen: string[] = [];
  if (eingabe.beginn) {
    const passen = erinnerungenBisBeginn({
      ab: eingabe.ab,
      beginn: eingabe.beginn,
      ganztaegig: eingabe.ganztaegig,
      nachStunden: eingabe.erinnern.nachStunden,
      anzahl: eingabe.erinnern.anzahl,
    });
    zeilen.push(
      passen === 0
        ? 'Der Termin beginnt vor der ersten Erinnerung – es wird keine gesendet.'
        : `Bis zum Beginn ${passen === 1 ? 'passt 1 Erinnerung' : `passen ${passen} Erinnerungen`}.`,
    );
  }
  if (eingabe.wiederholt) zeilen.push('Bei Wiederholungen gilt der erste Termin der Serie.');
  if (eingabe.ganztaegig) {
    zeilen.push(
      `Ganztägig: Die letzte Erinnerung kommt spätestens ${LIMITS.erinnernReserveStd} Stunden vor Beginn des Tages.`,
    );
  }
  return zeilen;
}

const ANTWORT: Record<RsvpStatus, string> = {
  yes: 'Zugesagt',
  no: 'Abgesagt',
  maybe: 'Vielleicht',
  pending: 'Offen',
};

/**
 * Die Kopfzeile der Erinnerungskarte – je Betrachter und Zustand.
 *
 * Nicht gespeichert, sondern hier formuliert: Ein gespeichertes „Du hast noch
 * nicht geantwortet“ würde nach der Antwort lügen. Die Karte sagt in jedem
 * Zustand, dass sie automatisch kam – sie ist keine Nachricht des Erstellers.
 */
export function erinnerungsZeile(eingabe: {
  ichBinErsteller: boolean;
  /** Wem die Erinnerung galt – für den Ersteller. */
  partner: string;
  /** Meine Antwort (für den Empfänger). */
  status: RsvpStatus | null;
  titel: string;
  nummer: number;
}): { kopf: string; text: string | null } {
  const zaehler = eingabe.nummer > 1 ? ` · ${eingabe.nummer}.` : '';
  if (eingabe.ichBinErsteller) {
    return { kopf: `Automatische Erinnerung an ${eingabe.partner}${zaehler}`, text: null };
  }
  const offen = eingabe.status === null || eingabe.status === 'pending';
  return {
    kopf: `Automatische Erinnerung${zaehler}`,
    text: offen
      ? `Du hast noch nicht auf „${eingabe.titel}“ geantwortet.`
      : `Deine Antwort: ${ANTWORT[eingabe.status!]}.`,
  };
}
