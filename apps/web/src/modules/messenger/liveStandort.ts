import { create } from 'zustand';
import { liveLaeuft } from '@initiative/shared';
import { api } from '../../lib/api.js';

/**
 * Live-Standort – „solange die App offen ist“.
 *
 * Es gibt im Web keinen verlässlichen Standort im Hintergrund, und eine
 * heimliche Ortung wollen wir auch nicht. Darum ehrlich und eng:
 *
 * * Die Freigabe läuft nur, solange diese Seite SICHTBAR ist. Geht die App in
 *   den Hintergrund oder wird geschlossen (`visibilitychange` → hidden,
 *   `pagehide`), endet sie – beim Server mit `standort/beenden`.
 * * Sie endet spätestens zur gewählten Zeit (15 oder 60 Minuten), die der
 *   Server beim Senden festgelegt hat.
 * * Aktualisiert wird höchstens alle `ABSTAND_MS` und nur, wenn sich etwas
 *   bewegt hat oder eine Minute vergangen ist – kein Strom für nichts.
 *
 * Die Steuerung bekommt ihre Umgebung (Ortung, Seite, Uhr, Server) als
 * Abhängigkeiten, damit sich das Ende ohne Browser prüfen lässt.
 */

export const ABSTAND_MS = 10_000;
const MINDESTENS_ALLE_MS = 60_000;
const BEWEGUNG_M = 10;

export interface LiveUmgebung {
  beobachten: (
    weiter: (punkt: { lat: number; lon: number; genauigkeit?: number }) => void,
    fehler: () => void,
  ) => number;
  aufhoeren: (id: number) => void;
  sichtbar: () => boolean;
  /** Meldet Sichtbarkeitswechsel und Schliessen; liefert das Abmelden. */
  beiVerlassen: (rueckruf: () => void) => () => void;
  jetzt: () => number;
  wecker: (rueckruf: () => void, ms: number) => number;
  weckerAus: (id: number) => void;
  senden: (id: string, punkt: { lat: number; lon: number; genauigkeit?: number }) => Promise<unknown>;
  beenden: (id: string) => Promise<unknown>;
}

/** Abstand zweier Punkte in Metern (Haversine) – genau genug für „bewegt“. */
export function abstandMeter(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const rad = (grad: number) => (grad * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

interface Lauf {
  messageId: string;
  bis: string;
  beobachtung: number;
  endeWecker: number;
  abmelden: () => void;
  zuletzt: { lat: number; lon: number; zeit: number } | null;
}

export function liveSteuerung(umgebung: LiveUmgebung) {
  const laeufe = new Map<string, Lauf>();
  const aenderung = new Set<() => void>();
  const melden = () => aenderung.forEach((f) => f());

  function beenden(messageId: string): void {
    const lauf = laeufe.get(messageId);
    if (!lauf) return;
    laeufe.delete(messageId);
    umgebung.aufhoeren(lauf.beobachtung);
    umgebung.weckerAus(lauf.endeWecker);
    lauf.abmelden();
    void umgebung.beenden(messageId).catch(() => {});
    melden();
  }

  function starten(messageId: string, bis: string): boolean {
    if (laeufe.has(messageId)) return true;
    if (!liveLaeuft({ bis }, umgebung.jetzt()) || !umgebung.sichtbar()) return false;
    const lauf: Lauf = {
      messageId,
      bis,
      beobachtung: 0,
      endeWecker: 0,
      abmelden: () => {},
      zuletzt: null,
    };
    laeufe.set(messageId, lauf);
    lauf.beobachtung = umgebung.beobachten(
      (punkt) => {
        const jetzt = umgebung.jetzt();
        if (!liveLaeuft({ bis }, jetzt)) {
          beenden(messageId);
          return;
        }
        const vorher = lauf.zuletzt;
        if (vorher) {
          if (jetzt - vorher.zeit < ABSTAND_MS) return;
          const bewegt = abstandMeter(vorher, punkt) >= BEWEGUNG_M;
          if (!bewegt && jetzt - vorher.zeit < MINDESTENS_ALLE_MS) return;
        }
        lauf.zuletzt = { lat: punkt.lat, lon: punkt.lon, zeit: jetzt };
        void umgebung.senden(messageId, punkt).catch(() => {
          // 410: anderswo beendet (zweites Gerät, Server-Ende) – auch hier aus.
          beenden(messageId);
        });
      },
      () => beenden(messageId),
    );
    lauf.endeWecker = umgebung.wecker(
      () => beenden(messageId),
      Math.max(0, Date.parse(bis) - umgebung.jetzt()),
    );
    lauf.abmelden = umgebung.beiVerlassen(() => {
      if (!umgebung.sichtbar()) beenden(messageId);
    });
    melden();
    return true;
  }

  return {
    starten,
    beenden,
    alleBeenden: () => [...laeufe.keys()].forEach(beenden),
    aktiv: () => [...laeufe.keys()],
    beiAenderung: (f: () => void) => {
      aenderung.add(f);
      return () => aenderung.delete(f);
    },
  };
}

/** Die Umgebung im Browser. */
function browserUmgebung(): LiveUmgebung {
  return {
    beobachten: (weiter, fehler) =>
      navigator.geolocation.watchPosition(
        (pos) =>
          weiter({
            lat: pos.coords.latitude,
            lon: pos.coords.longitude,
            genauigkeit: Math.round(pos.coords.accuracy),
          }),
        fehler,
        { enableHighAccuracy: true, maximumAge: 5_000, timeout: 30_000 },
      ),
    aufhoeren: (id) => navigator.geolocation.clearWatch(id),
    sichtbar: () => document.visibilityState === 'visible',
    beiVerlassen: (rueckruf) => {
      document.addEventListener('visibilitychange', rueckruf);
      window.addEventListener('pagehide', rueckruf);
      return () => {
        document.removeEventListener('visibilitychange', rueckruf);
        window.removeEventListener('pagehide', rueckruf);
      };
    },
    jetzt: () => Date.now(),
    wecker: (f, ms) => window.setTimeout(f, ms),
    weckerAus: (id) => window.clearTimeout(id),
    senden: (id, punkt) => api.messages.standortNachfuehren(id, punkt),
    beenden: (id) => api.messages.standortBeenden(id),
  };
}

let steuerung: ReturnType<typeof liveSteuerung> | null = null;

/** Welche Live-Freigaben auf DIESEM Gerät gerade laufen. */
export const useLiveAktiv = create<{ ids: string[] }>(() => ({ ids: [] }));

export function liveFreigabe(): ReturnType<typeof liveSteuerung> {
  if (!steuerung) {
    steuerung = liveSteuerung(browserUmgebung());
    const s = steuerung;
    s.beiAenderung(() => useLiveAktiv.setState({ ids: s.aktiv() }));
  }
  return steuerung;
}
