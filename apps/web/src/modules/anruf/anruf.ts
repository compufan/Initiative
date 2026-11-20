/**
 * 1:1-Anrufe per WebRTC – die Steuerung auf dem Gerät.
 *
 * Signalisierung über die vorhandene Echtzeit-Leitung (`anruf.*`); der Server
 * leitet nur zwischen den beiden Mitgliedern eines Direktchats weiter und
 * führt den Zustand (`apps/api/src/services/anrufe.rs`). Die SDPs holt das
 * Gegenüber über `GET /anrufe/{id}` (der Bus trägt keine grossen Ereignisse).
 *
 * Welche Zustände es gibt und was worauf folgt, steht rein in
 * `klingelZustand.ts`; hier hängen nur die Nebenwirkungen daran.
 */
import { create } from 'zustand';
import { uuidv7, type AnrufDto, type IceKonfigDto } from '@initiative/shared';
import { request } from '../../lib/api.js';
import { realtime } from '../../lib/realtime.js';
import { klingeltonAn, klingeltonAus } from './klingelton.js';
import {
  RUHE,
  istBelegt,
  qualitaet,
  uebergang,
  type AnrufZustand,
  type EndeGrund,
  type Ereignis,
} from './klingelZustand.js';

export interface AnrufStore extends AnrufZustand {
  lokal: MediaStream | null;
  entfernt: MediaStream | null;
  stumm: boolean;
  kameraAus: boolean;
  frontKamera: boolean;
  /** Ausgabegerät für den Ton (nur wo `setSinkId` geht). */
  lautsprecher: boolean;
  qualitaet: 'gut' | 'mittel' | 'schlecht' | null;
  /** Die ICE-Verbindung wackelt („getrennt“, sucht neu). */
  wackelt: boolean;
}

export const useAnruf = create<AnrufStore>(() => ({
  ...RUHE,
  lokal: null,
  entfernt: null,
  stumm: false,
  kameraAus: false,
  frontKamera: true,
  lautsprecher: false,
  qualitaet: null,
  wackelt: false,
}));

const api = {
  ice: () => request<IceKonfigDto>('GET', '/anrufe/ice'),
  anruf: (id: string) => request<AnrufDto>('GET', `/anrufe/${id}`),
};

let verbindung: RTCPeerConnection | null = null;
/** ICE-Kandidaten, die vor der Verbindung (oder der Gegenbeschreibung) kamen. */
let gepuffert: RTCIceCandidateInit[] = [];
let eigeneLeitung: string | null = null;
let statistik: number | null = null;
let zeitlimit: number | null = null;
let aufraeumen: number | null = null;

function zustand(): AnrufStore {
  return useAnruf.getState();
}

/** Ein Ereignis in die Maschine geben und die Folgen anstossen. */
function melden(ereignis: Ereignis): void {
  const vorher = zustand();
  const nachher = uebergang(vorher, ereignis);
  if (nachher === vorher) return;
  useAnruf.setState(nachher);
  folgen(vorher, nachher);
}

function folgen(vorher: AnrufZustand, nachher: AnrufZustand): void {
  if (vorher.phase === nachher.phase) return;
  // Klingeln: nur in den beiden Klingel-Phasen.
  if (nachher.phase === 'klingelt_ein') klingeltonAn('eingehend');
  else if (nachher.phase === 'klingelt_aus') klingeltonAn('ausgehend');
  else klingeltonAus();

  if (nachher.phase === 'vorbei') {
    abbauen();
    if (aufraeumen !== null) window.clearTimeout(aufraeumen);
    aufraeumen = window.setTimeout(() => melden({ typ: 'aufraeumen' }), 2500);
  }
  if (nachher.phase === 'verbunden') statistikStarten();
}

function abbauen(): void {
  if (zeitlimit !== null) window.clearTimeout(zeitlimit);
  zeitlimit = null;
  if (statistik !== null) window.clearInterval(statistik);
  statistik = null;
  gepuffert = [];
  try {
    verbindung?.close();
  } catch {
    /* schon zu */
  }
  verbindung = null;
  zustand()
    .lokal?.getTracks()
    .forEach((spur) => spur.stop());
  useAnruf.setState({
    lokal: null,
    entfernt: null,
    stumm: false,
    kameraAus: false,
    frontKamera: true,
    qualitaet: null,
    wackelt: false,
  });
}

function senden(ereignis: Parameters<typeof realtime.send>[0]): boolean {
  return realtime.send(ereignis);
}

async function medienHolen(video: boolean, vorne = true): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: video
      ? {
          facingMode: vorne ? 'user' : 'environment',
          width: { ideal: 1280 },
          height: { ideal: 720 },
        }
      : false,
  });
}

async function verbindungBauen(anrufId: string): Promise<RTCPeerConnection> {
  let iceServers: RTCIceServer[] = [];
  try {
    iceServers = (await api.ice()).iceServers as RTCIceServer[];
  } catch {
    // Ohne ICE-Server geht es noch im selben Netz.
  }
  const pc = new RTCPeerConnection({ iceServers });
  pc.onicecandidate = (ereignis) => {
    if (!ereignis.candidate) return;
    senden({ type: 'anruf.ice', payload: { anrufId, candidate: ereignis.candidate.toJSON() } });
  };
  pc.ontrack = (ereignis) => {
    const strom = ereignis.streams[0] ?? new MediaStream([ereignis.track]);
    useAnruf.setState({ entfernt: strom });
  };
  pc.onconnectionstatechange = () => {
    const lage = pc.connectionState;
    if (lage === 'connected') {
      useAnruf.setState({ wackelt: false });
      melden({ typ: 'verbunden', anrufId, jetzt: Date.now() });
    } else if (lage === 'disconnected') {
      useAnruf.setState({ wackelt: true });
    } else if (lage === 'failed') {
      senden({ type: 'anruf.ende', payload: { anrufId } });
      melden({ typ: 'ende', anrufId, grund: 'getrennt' });
    }
  };
  verbindung = pc;
  return pc;
}

async function gepuffertAnwenden(): Promise<void> {
  const pc = verbindung;
  if (!pc || !pc.remoteDescription) return;
  const liste = gepuffert;
  gepuffert = [];
  for (const kandidat of liste) {
    try {
      await pc.addIceCandidate(kandidat);
    } catch {
      /* ein unbrauchbarer Kandidat hält die anderen nicht auf */
    }
  }
}

function statistikStarten(): void {
  if (statistik !== null) window.clearInterval(statistik);
  let vorher: { verloren: number; empfangen: number } | null = null;
  statistik = window.setInterval(async () => {
    const pc = verbindung;
    if (!pc) return;
    try {
      const bericht = await pc.getStats();
      let rtt: number | null = null;
      let verloren = 0;
      let empfangen = 0;
      bericht.forEach((eintrag: RTCStats & Record<string, unknown>) => {
        if (eintrag.type === 'candidate-pair' && eintrag.state === 'succeeded') {
          const wert = eintrag.currentRoundTripTime;
          if (typeof wert === 'number') rtt = wert * 1000;
        }
        if (eintrag.type === 'inbound-rtp') {
          verloren += Number(eintrag.packetsLost ?? 0);
          empfangen += Number(eintrag.packetsReceived ?? 0);
        }
      });
      let anteil: number | null = null;
      if (vorher) {
        const v = verloren - vorher.verloren;
        const e = empfangen - vorher.empfangen;
        anteil = v + e > 0 ? Math.max(0, v) / (v + e) : 0;
      }
      vorher = { verloren, empfangen };
      useAnruf.setState({ qualitaet: qualitaet(rtt, anteil) });
    } catch {
      /* Statistik ist ein Zusatz */
    }
  }, 2000);
}

/** Jemanden im Direktchat anrufen. */
export async function anrufen(
  conversationId: string,
  gegenueber: string,
  video: boolean,
): Promise<void> {
  if (istBelegt(zustand())) return;
  const anrufId = uuidv7();
  melden({ typ: 'anrufen', anrufId, conversationId, gegenueber, video });
  try {
    const lokal = await medienHolen(video);
    if (zustand().anrufId !== anrufId) {
      lokal.getTracks().forEach((spur) => spur.stop());
      return;
    }
    useAnruf.setState({ lokal });
    const pc = await verbindungBauen(anrufId);
    lokal.getTracks().forEach((spur) => pc.addTrack(spur, lokal));
    const angebot = await pc.createOffer();
    await pc.setLocalDescription(angebot);
    const ok = senden({
      type: 'anruf.angebot',
      payload: { anrufId, conversationId, video, sdp: angebot.sdp ?? '' },
    });
    if (!ok) {
      melden({ typ: 'ende', anrufId, grund: 'fehler', hinweis: 'Keine Verbindung zum Server' });
      return;
    }
    melden({ typ: 'gesendet', anrufId });
    // Rückfall, falls das Ende vom Server nicht ankommt.
    zeitlimit = window.setTimeout(() => {
      if (zustand().anrufId === anrufId && zustand().phase === 'klingelt_aus') {
        senden({ type: 'anruf.ende', payload: { anrufId } });
        melden({ typ: 'ende', anrufId, grund: 'zeitlimit' });
      }
    }, 50_000);
  } catch (fehler) {
    const name = fehler instanceof Error ? fehler.name : '';
    melden({
      typ: 'ende',
      anrufId,
      grund: 'fehler',
      hinweis:
        name === 'NotAllowedError'
          ? 'Mikrofon/Kamera nicht erlaubt'
          : 'Mikrofon oder Kamera nicht verfügbar',
    });
  }
}

/** Den klingelnden Anruf annehmen. */
export async function annehmen(): Promise<void> {
  const jetzt = zustand();
  if (jetzt.phase !== 'klingelt_ein' || !jetzt.anrufId) return;
  const anrufId = jetzt.anrufId;
  melden({ typ: 'annehmen', anrufId });
  try {
    const [daten, lokal] = await Promise.all([api.anruf(anrufId), medienHolen(jetzt.video)]);
    if (zustand().anrufId !== anrufId || zustand().phase !== 'verbindet') {
      lokal.getTracks().forEach((spur) => spur.stop());
      return;
    }
    if (!daten.angebotSdp || daten.status !== 'klingelt') {
      lokal.getTracks().forEach((spur) => spur.stop());
      melden({ typ: 'ende', anrufId, grund: 'abgebrochen' });
      return;
    }
    useAnruf.setState({ lokal });
    const pc = await verbindungBauen(anrufId);
    await pc.setRemoteDescription({ type: 'offer', sdp: daten.angebotSdp });
    lokal.getTracks().forEach((spur) => pc.addTrack(spur, lokal));
    const antwort = await pc.createAnswer();
    await pc.setLocalDescription(antwort);
    await gepuffertAnwenden();
    senden({ type: 'anruf.antwort', payload: { anrufId, sdp: antwort.sdp ?? '' } });
  } catch (fehler) {
    senden({ type: 'anruf.ende', payload: { anrufId } });
    const name = fehler instanceof Error ? fehler.name : '';
    melden({
      typ: 'ende',
      anrufId,
      grund: 'fehler',
      hinweis: name === 'NotAllowedError' ? 'Mikrofon/Kamera nicht erlaubt' : undefined,
    });
  }
}

export function ablehnen(): void {
  const { anrufId, phase } = zustand();
  if (!anrufId || phase !== 'klingelt_ein') return;
  senden({ type: 'anruf.abgelehnt', payload: { anrufId } });
  melden({ typ: 'ende', anrufId, grund: 'abgelehnt' });
}

export function auflegen(): void {
  const { anrufId, phase, richtung } = zustand();
  if (!anrufId || !istBelegt(zustand())) return;
  senden({ type: 'anruf.ende', payload: { anrufId } });
  const grund: EndeGrund =
    phase === 'verbunden' || phase === 'verbindet'
      ? 'aufgelegt'
      : richtung === 'aus'
        ? 'abgebrochen'
        : 'abgelehnt';
  melden({ typ: 'ende', anrufId, grund });
}

export function stummSchalten(): void {
  const stumm = !zustand().stumm;
  zustand()
    .lokal?.getAudioTracks()
    .forEach((spur) => (spur.enabled = !stumm));
  useAnruf.setState({ stumm });
}

export function kameraSchalten(): void {
  const kameraAus = !zustand().kameraAus;
  zustand()
    .lokal?.getVideoTracks()
    .forEach((spur) => (spur.enabled = !kameraAus));
  useAnruf.setState({ kameraAus });
}

/** Vorne/hinten: neue Videospur holen und in der Verbindung austauschen. */
export async function kameraWechseln(): Promise<void> {
  const { lokal, frontKamera } = zustand();
  const pc = verbindung;
  if (!lokal || !pc) return;
  try {
    const neu = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: frontKamera ? 'environment' : 'user' },
    });
    const spur = neu.getVideoTracks()[0];
    if (!spur) return;
    const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
    await sender?.replaceTrack(spur);
    lokal.getVideoTracks().forEach((alt) => {
      alt.stop();
      lokal.removeTrack(alt);
    });
    lokal.addTrack(spur);
    spur.enabled = !zustand().kameraAus;
    useAnruf.setState({ frontKamera: !frontKamera, lokal: new MediaStream(lokal.getTracks()) });
  } catch {
    /* Eine zweite Kamera gibt es nicht überall. */
  }
}

/** Kann dieser Browser das Ausgabegerät wählen? */
export function lautsprecherWaehlbar(): boolean {
  return typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
}

export function lautsprecherUmschalten(): void {
  useAnruf.setState({ lautsprecher: !zustand().lautsprecher });
}

/* ---------- Echtzeit ------------------------------------------------------ */

async function angebotErhalten(p: {
  anrufId: string;
  conversationId: string;
  von: string;
  video: boolean;
}): Promise<void> {
  melden({ typ: 'angebot', ...p });
}

/** Ein Anruf, der klingelte, bevor die App offen war (aus der Mitteilung). */
export async function nachholen(anrufId: string): Promise<void> {
  if (istBelegt(zustand())) return;
  try {
    const daten = await api.anruf(anrufId);
    if (daten.status !== 'klingelt' || !daten.anruferId) return;
    await angebotErhalten({
      anrufId,
      conversationId: daten.conversationId,
      von: daten.anruferId,
      video: daten.video,
    });
  } catch {
    /* vorbei oder nicht meiner */
  }
}

export function verdrahten(): () => void {
  const aus = [
    realtime.on('hello', (p) => {
      eigeneLeitung = p.connectionId;
    }),
    realtime.on('anruf.angebot', (p) => void angebotErhalten(p)),
    realtime.on('anruf.antwort', async (p) => {
      const pc = verbindung;
      if (!pc || zustand().anrufId !== p.anrufId) return;
      try {
        const daten = await api.anruf(p.anrufId);
        if (!daten.antwortSdp) return;
        await pc.setRemoteDescription({ type: 'answer', sdp: daten.antwortSdp });
        if (zeitlimit !== null) window.clearTimeout(zeitlimit);
        zeitlimit = null;
        melden({ typ: 'antwort', anrufId: p.anrufId });
        await gepuffertAnwenden();
      } catch {
        senden({ type: 'anruf.ende', payload: { anrufId: p.anrufId } });
        melden({ typ: 'ende', anrufId: p.anrufId, grund: 'fehler' });
      }
    }),
    realtime.on('anruf.angenommen', (p) => {
      if (p.verbindung === eigeneLeitung) return;
      melden({ typ: 'angenommen_anderswo', anrufId: p.anrufId });
    }),
    realtime.on('anruf.ice', async (p) => {
      if (zustand().anrufId !== p.anrufId) return;
      const pc = verbindung;
      if (!pc || !pc.remoteDescription) {
        gepuffert.push(p.candidate as RTCIceCandidateInit);
        return;
      }
      try {
        await pc.addIceCandidate(p.candidate as RTCIceCandidateInit);
      } catch {
        /* siehe gepuffertAnwenden */
      }
    }),
    realtime.on('anruf.ende', (p) => {
      melden({ typ: 'ende', anrufId: p.anrufId, grund: p.grund });
    }),
    realtime.on('anruf.abgelehnt', (p) => {
      melden({ typ: 'ende', anrufId: p.anrufId, grund: 'abgelehnt' });
    }),
    realtime.on('anruf.besetzt', (p) => {
      melden({ typ: 'ende', anrufId: p.anrufId, grund: 'besetzt' });
    }),
    realtime.on('anruf.fehler', (p) => {
      if (p.anrufId && p.anrufId !== zustand().anrufId) return;
      melden({ typ: 'ende', anrufId: p.anrufId, grund: 'fehler', hinweis: p.text });
    }),
  ];
  // Wer die Seite schliesst, legt auf – sonst klingelt es drüben weiter.
  const weg = () => {
    if (istBelegt(zustand())) auflegen();
  };
  window.addEventListener('pagehide', weg);
  return () => {
    aus.forEach((abmelden) => abmelden());
    window.removeEventListener('pagehide', weg);
    weg();
  };
}
