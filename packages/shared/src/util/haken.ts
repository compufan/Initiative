/**
 * Lesehäkchen: ✓ gesendet, ✓✓ zugestellt, ✓✓ (blau) gelesen.
 *
 * Eine reine Funktion, damit Oberfläche und Test dieselbe Regel lesen.
 *
 * - **Gesendet**: Der Server hat die Nachricht (sie hat eine echte Kennung).
 * - **Zugestellt**: Bei JEDEM anderen, der sie sehen darf, ist sie auf
 *   mindestens einem Gerät angekommen. Gelesen zählt als zugestellt.
 * - **Gelesen**: Jeder andere hat sie gelesen – in Gruppen also erst, wenn
 *   alle gelesen haben (wie bei WhatsApp).
 *
 * Wer die Nachricht nicht sehen darf (später dazugekommen, Verlauf
 * verborgen), zählt nicht mit; sonst bliebe eine alte Nachricht für immer
 * grau, weil ein Neuzugang sie nie lesen kann.
 *
 * Kennungen sind UUIDv7, also zeitlich sortiert: „Stand ≥ Kennung“ heisst
 * „bis hierhin gelesen bzw. empfangen“.
 */

export type Haken = 'wartet' | 'gesendet' | 'zugestellt' | 'gelesen';

export interface MitgliedStand {
  userId: string;
  /** Ab wann dieses Mitglied den Verlauf sieht; `null`: von Anfang an. */
  siehtAb?: string | null;
  gelesen: string | null;
  zugestellt: string | null;
}

export interface HakenNachricht {
  id: string;
  senderId: string | null;
  createdAt: string;
  pending?: boolean;
  failed?: boolean;
}

export function hakenFuer(
  nachricht: HakenNachricht,
  ich: string,
  staende: readonly MitgliedStand[],
  optionen: { lesebestaetigungen: boolean } = { lesebestaetigungen: true },
): Haken {
  if (nachricht.pending || nachricht.failed || nachricht.id.startsWith('local:')) return 'wartet';
  const zeit = Date.parse(nachricht.createdAt);
  const andere = staende.filter(
    (stand) =>
      stand.userId !== ich &&
      (!stand.siehtAb || Number.isNaN(zeit) || zeit >= Date.parse(stand.siehtAb)),
  );
  if (andere.length === 0) return 'gesendet';
  const erreicht = (stand: string | null) => stand !== null && stand >= nachricht.id;
  const alleGelesen = andere.every((stand) => erreicht(stand.gelesen));
  if (alleGelesen && optionen.lesebestaetigungen) return 'gelesen';
  const alleZugestellt = andere.every(
    (stand) => erreicht(stand.gelesen) || erreicht(stand.zugestellt),
  );
  return alleZugestellt ? 'zugestellt' : 'gesendet';
}

/** Was eine Vorlesehilfe zu den Häkchen sagt. */
export function hakenText(haken: Haken): string {
  switch (haken) {
    case 'wartet':
      return 'wird gesendet';
    case 'gesendet':
      return 'gesendet';
    case 'zugestellt':
      return 'zugestellt';
    case 'gelesen':
      return 'gelesen';
  }
}
