import { LIMITS, type AttachmentKind } from '@initiative/shared';

/**
 * Die Upload-Grenzen, die der Server WIRKLICH durchsetzt.
 *
 * # Warum nicht einfach `LIMITS`
 *
 * `UPLOAD_MAX_BYTES` ist auf dem Server einstellbar. Die Konstanten im
 * gemeinsamen Paket kennen nur die Vorgabe (4 GiB). Bei einem Server mit
 * 1 GiB liesse die App sonst eine 3-GiB-Datei zu, lüde sie hoch – und würde
 * erst beim Anlegen der Sitzung abgewiesen (oder, bei einem ungeduldigen
 * Nutzer, nie bemerkt, warum). Der Server liefert die Zahlen unter
 * `GET /media/grenzen`; hier werden sie einmal je Sitzung geholt.
 *
 * # Rückfall
 *
 * Offline, älterer Server (404) oder Fehler: es gelten die Konstanten aus
 * `LIMITS`. Das ist die schwächere Prüfung, aber nie eine falsche in die
 * unsichere Richtung – der Server entscheidet ohnehin endgültig.
 */
export interface UploadGrenzen {
  maxUploadBytes: Record<AttachmentKind, number>;
  direktUploadMax: Record<AttachmentKind, number>;
  stueckGroesse: number;
}

/** Was der Server unter `/media/grenzen` antwortet. */
export type GrenzenAntwort = Partial<{
  maxUploadBytes: Partial<Record<AttachmentKind, number>>;
  direktUploadMax: Partial<Record<AttachmentKind, number>>;
  stueckGroesse: number;
}>;

export function vorgabeGrenzen(): UploadGrenzen {
  return {
    maxUploadBytes: { ...LIMITS.maxUploadBytes },
    direktUploadMax: { ...LIMITS.direktUploadMax },
    stueckGroesse: LIMITS.stueckGroesse,
  };
}

function zahlOderVorgabe(wert: unknown, vorgabe: number): number {
  return typeof wert === 'number' && Number.isFinite(wert) && wert > 0 ? wert : vorgabe;
}

/** Eine Serverantwort mit den Vorgaben auffüllen – fehlende oder kaputte Felder fallen zurück. */
export function grenzenAusAntwort(antwort: GrenzenAntwort | null | undefined): UploadGrenzen {
  const vorgabe = vorgabeGrenzen();
  if (!antwort || typeof antwort !== 'object') return vorgabe;
  const fuellen = (
    quelle: Partial<Record<AttachmentKind, number>> | undefined,
    basis: Record<AttachmentKind, number>,
  ): Record<AttachmentKind, number> => {
    const ergebnis = { ...basis };
    for (const art of Object.keys(basis) as AttachmentKind[]) {
      ergebnis[art] = zahlOderVorgabe(quelle?.[art], basis[art]);
    }
    return ergebnis;
  };
  return {
    maxUploadBytes: fuellen(antwort.maxUploadBytes, vorgabe.maxUploadBytes),
    direktUploadMax: fuellen(antwort.direktUploadMax, vorgabe.direktUploadMax),
    stueckGroesse: zahlOderVorgabe(antwort.stueckGroesse, vorgabe.stueckGroesse),
  };
}

let aktuell: UploadGrenzen = vorgabeGrenzen();
let geladen = false;
let laufend: Promise<void> | null = null;

/** Die jetzt geltenden Grenzen (synchron: Server, sobald geladen, sonst Vorgabe). */
export function uploadGrenzen(): UploadGrenzen {
  return aktuell;
}

export function maxUploadBytesFuer(art: AttachmentKind): number {
  return aktuell.maxUploadBytes[art];
}

export function direktMaxFuer(art: AttachmentKind): number {
  return aktuell.direktUploadMax[art];
}

/**
 * Einmal je Sitzung vom Server holen. Mehrfache Aufrufe teilen sich eine
 * Anfrage; nach Erfolg tut ein weiterer Aufruf nichts. Ein Fehler wird NICHT
 * gemerkt – der nächste Aufruf (etwa beim nächsten Upload) versucht es erneut.
 */
export function grenzenLaden(holen: () => Promise<GrenzenAntwort>): Promise<void> {
  if (geladen) return Promise.resolve();
  laufend ??= holen()
    .then((antwort) => {
      aktuell = grenzenAusAntwort(antwort);
      geladen = true;
    })
    .catch(() => {
      /* offline oder älterer Server – es bleibt bei den Konstanten */
    })
    .finally(() => {
      laufend = null;
    });
  return laufend;
}

/** Beim Abmelden: das nächste Konto fragt neu (anderer Server ist denkbar). */
export function grenzenZuruecksetzen(): void {
  aktuell = vorgabeGrenzen();
  geladen = false;
  laufend = null;
}
