/**
 * 1:1-Anrufe (WebRTC). Signalisierung über die Echtzeit-Leitung, Server:
 * `apps/api/src/services/anrufe.rs`.
 *
 * Die Sitzungsbeschreibungen (SDP) reisen vom Gerät zum Server im Ereignis,
 * vom Server zum Gegenüber aber NICHT – über den Postgres-Bus dürfte ein
 * Ereignis nur ~8000 Bytes haben. Das Gegenüber holt sie mit
 * `GET /anrufe/{id}`.
 */
export type AnrufStatus =
  'klingelt' | 'verbunden' | 'beendet' | 'verpasst' | 'abgelehnt' | 'besetzt';

export interface AnrufDto {
  id: string;
  conversationId: string;
  anruferId: string | null;
  angerufenerId: string | null;
  video: boolean;
  status: AnrufStatus;
  begonnenAt: string;
  angenommenAt: string | null;
  beendetAt: string | null;
  nachrichtId: string | null;
  angebotSdp: string | null;
  antwortSdp: string | null;
}

export interface IceKonfigDto {
  iceServers: { urls: string[] | string; username?: string; credential?: string }[];
  gueltigBis: string | null;
  klingelnS: number;
}

/** So lange klingelt es (Server: `KLINGELN`). */
export const ANRUF_KLINGELN_MS = 45_000;

/** Gerät → Server. */
export type AnrufClientEreignis =
  | {
      type: 'anruf.angebot';
      payload: { anrufId: string; conversationId: string; video: boolean; sdp: string };
    }
  | { type: 'anruf.antwort'; payload: { anrufId: string; sdp: string } }
  | { type: 'anruf.ice'; payload: { anrufId: string; candidate: RTCIceCandidateInitLike } }
  | { type: 'anruf.ende'; payload: { anrufId: string } }
  | { type: 'anruf.abgelehnt'; payload: { anrufId: string } };

/** Server → Gerät. */
export type AnrufServerEreignis =
  | {
      type: 'anruf.angebot';
      payload: {
        anrufId: string;
        conversationId: string;
        von: string;
        video: boolean;
        begonnenAt: string;
      };
    }
  | { type: 'anruf.antwort'; payload: { anrufId: string } }
  /** Ein Gerät des Angerufenen hat angenommen – die anderen hören auf zu klingeln. */
  | { type: 'anruf.angenommen'; payload: { anrufId: string; verbindung: string } }
  | { type: 'anruf.ice'; payload: { anrufId: string; candidate: RTCIceCandidateInitLike } }
  | {
      type: 'anruf.ende';
      payload: {
        anrufId: string;
        grund: 'aufgelegt' | 'abgebrochen' | 'abgelehnt' | 'zeitlimit' | 'getrennt';
        status: AnrufStatus;
      };
    }
  | { type: 'anruf.abgelehnt'; payload: { anrufId: string } }
  | { type: 'anruf.besetzt'; payload: { anrufId: string } }
  | {
      type: 'anruf.fehler';
      payload: { anrufId: string | null; grund: string; text: string };
    };

/** Wie `RTCIceCandidateInit` – ohne DOM-Typen im gemeinsamen Paket. */
export interface RTCIceCandidateInitLike {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

/** „3:12“ bzw. „1:02:03“ – wie die Systemzeile des Servers. */
export function anrufDauer(sekunden: number): string {
  const s = Math.max(0, Math.floor(sekunden));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`;
}
