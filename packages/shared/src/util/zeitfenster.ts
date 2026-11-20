/**
 * Zeitfenster und Fristen der Nachrichtenfunktionen – dieselben Zahlen wie im
 * Server (`LIMITS`). Die Oberfläche bietet nur an, was der Server annimmt; er
 * entscheidet trotzdem selbst.
 */
import { LIMITS } from '../constants.js';

const MINUTE = 60_000;

function zeit(iso: string): number {
  const wert = Date.parse(iso);
  return Number.isNaN(wert) ? 0 : wert;
}

/** Lässt sich eine Nachricht von `geschrieben` jetzt noch bearbeiten? */
export function bearbeitenMoeglich(geschrieben: string, jetzt = Date.now()): boolean {
  return jetzt - zeit(geschrieben) <= LIMITS.bearbeitenFensterMin * MINUTE;
}

/** Wie viele ganze Minuten bleiben zum Bearbeiten (0, wenn vorbei)? */
export function bearbeitenRestMinuten(geschrieben: string, jetzt = Date.now()): number {
  const rest = zeit(geschrieben) + LIMITS.bearbeitenFensterMin * MINUTE - jetzt;
  return rest > 0 ? Math.ceil(rest / MINUTE) : 0;
}

/** Geht „Für alle löschen“ noch? Moderation (Admin einer Gruppe) ohne Frist. */
export function fuerAlleLoeschenMoeglich(
  geschrieben: string,
  moderiert: boolean,
  jetzt = Date.now(),
): boolean {
  return moderiert || jetzt - zeit(geschrieben) <= LIMITS.loeschenFensterStd * 60 * MINUTE;
}

/** Ist eine selbstlöschende Nachricht schon abgelaufen? */
export function abgelaufen(expiresAt: string | null | undefined, jetzt = Date.now()): boolean {
  return expiresAt != null && zeit(expiresAt) <= jetzt;
}

/** „24 Stunden“, „7 Tage“, „90 Tage“ – oder „Aus“. */
export function selbstloeschenText(sekunden: number | null | undefined): string {
  if (!sekunden) return 'Aus';
  if (sekunden === 86_400) return '24 Stunden';
  if (sekunden % 86_400 === 0) return `${sekunden / 86_400} Tage`;
  return `${Math.round(sekunden / 3600)} Stunden`;
}

/** Läuft eine Live-Freigabe noch (Ende nicht erreicht, nicht beendet)? */
export function liveLaeuft(
  live: { bis?: string; beendet?: string } | null | undefined,
  jetzt = Date.now(),
): boolean {
  return live?.bis != null && live.beendet == null && zeit(live.bis) > jetzt;
}

/** „noch 12 min“ für eine laufende Live-Freigabe. */
export function liveRestText(live: { bis?: string }, jetzt = Date.now()): string {
  const minuten = Math.max(0, Math.ceil((zeit(live.bis ?? '') - jetzt) / MINUTE));
  return minuten >= 60 ? `noch ${Math.floor(minuten / 60)} h ${minuten % 60} min` : `noch ${minuten} min`;
}
