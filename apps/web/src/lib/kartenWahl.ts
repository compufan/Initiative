import { useState, useSyncExternalStore } from 'react';
import {
  KARTEN_APPS,
  plattformErkennen,
  type KartenApp,
  type KartenAppKey,
  type Plattform,
} from './karten.js';

/**
 * Welche Karten-App dieses Gerät beim Tippen auf eine Adresse öffnet.
 *
 * # Warum je Gerät und nicht am Konto
 *
 * Die Karten-App hängt am Gerät: Auf dem iPhone ist es Apple Karten, auf dem
 * Android-Tablet Google Maps. Wer beides hat, will nicht dieselbe Wahl auf
 * beiden – und Apple Karten gibt es auf Android gar nicht. Deshalb steht sie
 * in `localStorage` (wie Theme und Freistell-Qualität) und geht nie an den
 * Server. Ein fehlender Eintrag heisst „jedes Mal fragen“.
 */

const KEY = 'initiative.karten-app';

const SCHLUESSEL = new Set<string>(KARTEN_APPS.map((app) => app.key));

function istSchluessel(wert: unknown): wert is KartenAppKey {
  return typeof wert === 'string' && SCHLUESSEL.has(wert);
}

/*
 * Rückfall, wenn der Speicher nicht mitspielt (privates Fenster, gesperrt):
 * Dann gilt die Wahl bis zum Neuladen aus dieser Variablen. Eine Wahl, die
 * beim nächsten Tipp vergessen ist, wäre schlimmer als eine, die nur bis zum
 * Neuladen hält.
 */
let imSpeicher: KartenAppKey | null = null;
/** Ein Schreiben ist gescheitert: Ab dann gilt die Variable, nicht der Speicher. */
let nurImModul = false;

const beobachter = new Set<() => void>();

function benachrichtigen(): void {
  for (const aufruf of [...beobachter]) aufruf();
}

/** Die gemerkte Wahl oder `null` („jedes Mal fragen“). Unbekannte Werte zählen nicht. */
export function leseKartenApp(): KartenAppKey | null {
  if (nurImModul) return imSpeicher;
  try {
    const wert = localStorage.getItem(KEY);
    return istSchluessel(wert) ? wert : null;
  } catch {
    return imSpeicher;
  }
}

/** Wahl merken; `null` löscht sie. Gilt sofort in allen Ansichten dieses Fensters. */
export function schreibeKartenApp(key: KartenAppKey | null): void {
  imSpeicher = key;
  try {
    if (key === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, key);
    nurImModul = false;
  } catch {
    nurImModul = true;
  }
  benachrichtigen();
}

/**
 * Die gemerkte App – aber nur, wenn sie auf dieser Plattform angeboten wird.
 *
 * Ein Eintrag aus einem anderen Gerät (Profil-Export, geteilter Browser) kann
 * auf diesem keinen Sinn haben: `geo:` auf dem Mac tut nichts. Dann öffnet
 * sich wieder das Blatt, statt ins Leere zu führen.
 */
export function gemerkteApp(
  plattform: Plattform,
  key: KartenAppKey | null = leseKartenApp(),
): KartenApp | null {
  if (!key) return null;
  const app = KARTEN_APPS.find((eintrag) => eintrag.key === key);
  return app && app.plattformen.includes(plattform) ? app : null;
}

/* ---------- React ---------- */

/** Für `useSyncExternalStore` – und die Tests. Gibt die Abmeldung zurück. */
export function kartenAppBeobachten(aufruf: () => void): () => void {
  beobachter.add(aufruf);
  // Ein zweites Fenster desselben Browsers meldet seine Änderung als
  // `storage`-Ereignis; im selben Fenster übernimmt `benachrichtigen`.
  const beiSpeicher = (ereignis: StorageEvent) => {
    if (ereignis.key === null || ereignis.key === KEY) aufruf();
  };
  if (typeof window !== 'undefined') window.addEventListener('storage', beiSpeicher);
  return () => {
    beobachter.delete(aufruf);
    if (typeof window !== 'undefined') window.removeEventListener('storage', beiSpeicher);
  };
}

/** Die gemerkte Wahl, live: ändert sie sich irgendwo, rechnet jede Ansicht neu. */
export function useKartenApp(): KartenAppKey | null {
  return useSyncExternalStore(kartenAppBeobachten, leseKartenApp, () => null);
}

/** Die Plattform dieses Geräts, einmal je Ansicht bestimmt. */
export function usePlattform(): Plattform {
  const [plattform] = useState(() => plattformErkennen());
  return plattform;
}

/** Die gemerkte App für dieses Gerät, live – oder `null`, wenn das Blatt aufgehen soll. */
export function useGemerkteApp(): KartenApp | null {
  const key = useKartenApp();
  const plattform = usePlattform();
  return gemerkteApp(plattform, key);
}
