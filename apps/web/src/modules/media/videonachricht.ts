/**
 * Videonachricht im Kreis – was sie ausmacht, ohne DOM.
 *
 * Gekennzeichnet über `metadata.module.videonachricht` – den Platz, den das
 * gemeinsame Schema für Module freihält (`MessageMetadata.module`) und den
 * der Server unverändert durchreicht. Ein eigener Schlüssel auf oberster
 * Ebene hätte die Positivliste des Servers für Client-Angaben gebraucht.
 */
import type { MessageDto } from '@initiative/shared';

export const VIDEONACHRICHT_MAX_MS = 60_000;
/** Kantenlänge des quadratischen Videos. */
export const VIDEONACHRICHT_KANTE = 480;

export interface VideonachrichtInfo {
  dauerMs: number;
}

export function istVideonachricht(message: Pick<MessageDto, 'type' | 'metadata'>): boolean {
  const modul = message.metadata?.module as { videonachricht?: unknown } | undefined;
  return (
    message.type === 'video' &&
    typeof modul?.videonachricht === 'object' &&
    modul.videonachricht !== null
  );
}

export function videonachrichtMetadaten(dauerMs: number): { module: Record<string, unknown> } {
  return {
    module: { videonachricht: { dauerMs: Math.round(dauerMs) } satisfies VideonachrichtInfo },
  };
}

/**
 * Der mittlere quadratische Ausschnitt eines Bildes (Quelle `breite × hoehe`),
 * wie ihn `drawImage` braucht: [sx, sy, kante].
 */
export function mittigesQuadrat(breite: number, hoehe: number): [number, number, number] {
  const kante = Math.min(breite, hoehe);
  return [Math.round((breite - kante) / 2), Math.round((hoehe - kante) / 2), kante];
}

/** Der Fortschrittsring: Länge des Strichs bei Anteil 0..1 auf einem Kreis mit Radius `r`. */
export function ringStrich(anteil: number, r: number): { umfang: number; versatz: number } {
  const umfang = 2 * Math.PI * r;
  const a = Math.min(1, Math.max(0, Number.isFinite(anteil) ? anteil : 0));
  return { umfang, versatz: umfang * (1 - a) };
}
