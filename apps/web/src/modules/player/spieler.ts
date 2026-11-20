/**
 * Der globale Sprachnachrichten-Spieler.
 *
 * # Warum global
 *
 * Bisher hatte jede Sprachblase ihr eigenes `<audio>`. Verliess man den Chat,
 * verschwand die Blase – und mit ihr der Ton, mitten im Satz. Hier gibt es
 * genau EIN Audio-Element für die ganze App, ausserhalb von React. Die Blasen
 * zeigen nur an und steuern; spielen tut dieser Spieler, auch wenn man längst
 * in einem anderen Chat oder in den Einstellungen ist. Die Mini-Leiste
 * (`MiniSpieler`) hält Pause, Weiter, Geschwindigkeit und Schliessen bereit.
 *
 * # Sperrbildschirm
 *
 * `navigator.mediaSession` trägt Titel (Absender) und Album (Chat) auf den
 * Sperrbildschirm und in die Steuerung von Kopfhörern und Uhr. Wo es das
 * nicht gibt, fehlt nur diese Anzeige.
 *
 * # iOS – ehrlich
 *
 * Safari spielt nur nach einer Berührung. Die nächste Sprachnachricht kommt
 * aus demselben Element (`src` wechseln im `ended`), das lässt Safari
 * meistens durchgehen – nicht immer, wenn das Telefon gesperrt ist. In einer
 * installierten PWA hört der Ton beim Sperren je nach iOS-Stand auf; im
 * Safari-Tab läuft er weiter. Siehe `docs/FEATURES.md`.
 */
import { create } from 'zustand';
import { mediaSrc, claimPlayback } from '../media/helpers.js';
import { useChat } from '../../state/chat.js';
import { useSession } from '../../state/session.js';
import { conversationTitle, senderName } from '../messenger/helpers.js';
import {
  fortsetzenBei,
  naechsteGeschwindigkeit,
  naechsteSprachnachricht,
  standMerken,
  type Staende,
  type Titel,
} from './warteschlange.js';

const STAENDE_SCHLUESSEL = 'initiative.spieler.staende';
const TEMPO_SCHLUESSEL = 'initiative.spieler.tempo';

function lesen<T>(schluessel: string, rueckfall: T): T {
  try {
    const roh = localStorage.getItem(schluessel);
    return roh ? (JSON.parse(roh) as T) : rueckfall;
  } catch {
    return rueckfall;
  }
}

function schreiben(schluessel: string, wert: unknown): void {
  try {
    localStorage.setItem(schluessel, JSON.stringify(wert));
  } catch {
    /* Ohne Speicher wird eben nichts gemerkt. */
  }
}

export interface SpielerZustand {
  titel: Titel | null;
  spielt: boolean;
  position: number;
  dauer: number;
  tempo: number;
}

export const useSpieler = create<SpielerZustand>(() => ({
  titel: null,
  spielt: false,
  position: 0,
  dauer: 0,
  tempo: lesen(TEMPO_SCHLUESSEL, 1),
}));

/** Absender und Chat für Leiste und Sperrbildschirm. */
export function namenFuer(
  conversationId: string,
  senderId: string | null,
): { absender: string; chat: string } {
  const myId = useSession.getState().user?.id ?? '';
  const chat = useChat.getState().conversations.find((item) => item.id === conversationId) ?? null;
  return {
    absender: senderId === myId ? 'Du' : senderName(chat, senderId),
    chat: chat ? conversationTitle(chat, myId) : 'Chat',
  };
}

let element: HTMLAudioElement | null = null;
let staende: Staende = lesen<Staende>(STAENDE_SCHLUESSEL, {});
let zuletztGemerkt = 0;

function audio(): HTMLAudioElement {
  if (element) return element;
  const neu = new Audio();
  neu.preload = 'metadata';
  neu.addEventListener('play', () => useSpieler.setState({ spielt: true }));
  neu.addEventListener('pause', () => {
    useSpieler.setState({ spielt: false });
    merken(true);
  });
  neu.addEventListener('loadedmetadata', () => {
    const dauer = Number.isFinite(neu.duration) && neu.duration > 0 ? neu.duration : null;
    if (dauer) useSpieler.setState({ dauer });
    sitzungsLage();
  });
  neu.addEventListener('timeupdate', () => {
    useSpieler.setState({ position: neu.currentTime });
    merken(false);
    sitzungsLage();
  });
  neu.addEventListener('ended', () => {
    const titel = useSpieler.getState().titel;
    if (titel) {
      staende = standMerken(staende, titel.attachment.id, 0, 0);
      schreiben(STAENDE_SCHLUESSEL, staende);
    }
    void weiter();
  });
  neu.addEventListener('error', () => useSpieler.setState({ spielt: false }));
  element = neu;
  return neu;
}

function merken(sofort: boolean): void {
  const { titel, dauer } = useSpieler.getState();
  if (!titel || !element) return;
  const jetzt = Date.now();
  if (!sofort && jetzt - zuletztGemerkt < 2000) return;
  zuletztGemerkt = jetzt;
  staende = standMerken(staende, titel.attachment.id, element.currentTime, dauer);
  schreiben(STAENDE_SCHLUESSEL, staende);
}

function sitzungsLage(): void {
  const sitzung = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined;
  if (!sitzung || !element || typeof sitzung.setPositionState !== 'function') return;
  const dauer = element.duration;
  if (!Number.isFinite(dauer) || dauer <= 0) return;
  try {
    sitzung.setPositionState({
      duration: dauer,
      playbackRate: element.playbackRate,
      position: Math.min(dauer, element.currentTime),
    });
  } catch {
    /* Ältere Browser kennen nur Teile davon. */
  }
}

function sitzungEinrichten(titel: Titel): void {
  const sitzung = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined;
  if (!sitzung) return;
  try {
    if (typeof MediaMetadata !== 'undefined') {
      sitzung.metadata = new MediaMetadata({
        title: titel.absender,
        artist: titel.chat,
        album: 'Sprachnachricht · Initiative',
        artwork: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
      });
    }
    const handler: [MediaSessionAction, MediaSessionActionHandler | null][] = [
      ['play', () => void fortsetzen()],
      ['pause', () => pausieren()],
      ['stop', () => schliessen()],
      ['seekbackward', (details) => springen(-(details.seekOffset ?? 10), true)],
      ['seekforward', (details) => springen(details.seekOffset ?? 10, true)],
      ['seekto', (details) => details.seekTime != null && springen(details.seekTime)],
      ['nexttrack', () => void weiter()],
    ];
    for (const [aktion, tun] of handler) {
      try {
        sitzung.setActionHandler(aktion, tun);
      } catch {
        /* Nicht jede Aktion gibt es überall. */
      }
    }
  } catch {
    /* Die Sperrbildschirm-Anzeige ist ein Zusatz. */
  }
}

/** Eine Sprachnachricht abspielen (oder die laufende pausieren/fortsetzen). */
export async function abspielen(titel: Titel): Promise<void> {
  const el = audio();
  const jetzt = useSpieler.getState().titel;
  if (jetzt?.attachment.id === titel.attachment.id) {
    if (el.paused) await fortsetzen();
    else pausieren();
    return;
  }
  merken(true);
  const dauer = (titel.attachment.durationMs ?? 0) / 1000;
  useSpieler.setState({ titel, position: 0, dauer, spielt: false });
  el.src = mediaSrc(titel.attachment);
  const ab = fortsetzenBei(staende, titel.attachment.id, dauer);
  if (ab > 0) {
    try {
      el.currentTime = ab;
    } catch {
      /* Manche Browser springen erst nach den Metadaten. */
      el.addEventListener('loadedmetadata', () => (el.currentTime = ab), { once: true });
    }
  }
  sitzungEinrichten(titel);
  await fortsetzen();
}

export async function fortsetzen(): Promise<void> {
  const el = audio();
  if (!useSpieler.getState().titel) return;
  claimPlayback(el);
  el.playbackRate = useSpieler.getState().tempo;
  try {
    await el.play();
    if (navigator.mediaSession) navigator.mediaSession.playbackState = 'playing';
  } catch (fehler) {
    useSpieler.setState({ spielt: false });
    throw fehler;
  }
}

export function pausieren(): void {
  element?.pause();
  if (typeof navigator !== 'undefined' && navigator.mediaSession) {
    navigator.mediaSession.playbackState = 'paused';
  }
}

export function umschalten(): void {
  if (!element || element.paused) void fortsetzen().catch(() => {});
  else pausieren();
}

/** Springen: absolut (Sekunden) oder relativ (`relativ = true`). */
export function springen(sekunden: number, relativ = false): void {
  const el = element;
  if (!el) return;
  const dauer = Number.isFinite(el.duration) ? el.duration : useSpieler.getState().dauer;
  const ziel = relativ ? el.currentTime + sekunden : sekunden;
  el.currentTime = Math.max(0, dauer > 0 ? Math.min(dauer, ziel) : ziel);
  useSpieler.setState({ position: el.currentTime });
}

export function tempoWechseln(): void {
  const tempo = naechsteGeschwindigkeit(useSpieler.getState().tempo);
  useSpieler.setState({ tempo });
  schreiben(TEMPO_SCHLUESSEL, tempo);
  if (element) element.playbackRate = tempo;
}

/** Die nächste Sprachnachricht aus demselben Chat – oder Ende. */
export async function weiter(): Promise<void> {
  const titel = useSpieler.getState().titel;
  if (!titel) return;
  const verlauf = useChat.getState().messages[titel.conversationId] ?? [];
  const naechste = naechsteSprachnachricht(verlauf, titel.messageId);
  const anhang = naechste?.attachments.find((item) => item.kind === 'audio');
  if (!naechste || !anhang) {
    useSpieler.setState({ spielt: false, position: 0 });
    if (element) element.currentTime = 0;
    return;
  }
  await abspielen({
    conversationId: titel.conversationId,
    messageId: naechste.id,
    attachment: anhang,
    ...namenFuer(titel.conversationId, naechste.senderId),
  }).catch(() => {
    // iOS lässt das Weiterspielen ohne Berührung nicht immer zu – dann steht
    // die nächste in der Leiste bereit, ein Tipp genügt.
    useSpieler.setState({ spielt: false });
  });
}

export function schliessen(): void {
  merken(true);
  if (element) {
    element.pause();
    element.removeAttribute('src');
    element.load();
  }
  useSpieler.setState({ titel: null, spielt: false, position: 0, dauer: 0 });
  if (typeof navigator !== 'undefined' && navigator.mediaSession) {
    navigator.mediaSession.metadata = null;
    navigator.mediaSession.playbackState = 'none';
  }
}

/** Nur für Tests: den Zustand zurücksetzen. */
export function _zuruecksetzen(): void {
  element = null;
  staende = {};
  useSpieler.setState({ titel: null, spielt: false, position: 0, dauer: 0, tempo: 1 });
}
