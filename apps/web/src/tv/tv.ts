/**
 * Das Blatt, das auf dem Fernseher läuft.
 *
 * # Der Ablauf
 *
 * 1. Beim Öffnen holt es sich eine Sitzung: einen CODE, den es gross anzeigt,
 *    und ein GEHEIMNIS, das es behält und nie zeigt.
 * 2. Es fragt im Sekundentakt nach der Fassungsnummer. Das ist eine winzige
 *    Antwort; die Liste selbst – bei einem Urlaubsordner leicht ein Megabyte –
 *    wird erst geholt, wenn die Nummer sich bewegt hat.
 * 3. Am Telefon tippt jemand den Code ein und wählt eine Sammlung. Ab da läuft
 *    die Diashow, und dasselbe Telefon ist die Fernbedienung.
 *
 * # Warum hier kein React steht
 *
 * Weil der Browser am anderen Ende selten ein aktueller ist. Dieses Blatt
 * kommt mit dem aus, was jeder Browser seit ungefähr 2017 kann: `fetch`,
 * Klassenlisten, `<video>`. Keine Bibliothek, kein Zustandsspeicher, keine
 * Weiche.
 *
 * # Warum zwei Bildelemente
 *
 * Für die Überblendung. Ein einziges `<img>`, dessen `src` man tauscht, wird
 * beim Wechsel für einen Augenblick LEER – der Browser verwirft das alte Bild,
 * bevor das neue da ist. Auf einem Fernseher sieht man dieses Blitzen
 * deutlich. Mit zweien liegt das neue Bild schon fertig darunter, und erst
 * dann wird geblendet.
 */

import { reihenfolge } from './mischen.js';

const API = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');
const WURZEL = `${API}/api/v1/tv/sitzungen`;

/** Wie oft nach dem Stand gefragt wird. */
const TAKT_MS = 2000;
interface Stueck {
  id: string;
  art: string;
  mime: string;
  url: string;
  name?: string | null;
  dauerMs?: number | null;
  vorschau?: string | null;
}

interface Programm {
  fassung: number;
  modus: string;
  saat: number;
  sekunden: number;
  stelle: number;
  pausiert: boolean;
  stuecke: Stueck[];
}

const blatt = document.getElementById('blatt') as HTMLElement;
const anmeldung = document.getElementById('anmeldung') as HTMLElement;
const buehne = document.getElementById('buehne') as HTMLElement;
const codeFeld = document.getElementById('code') as HTMLElement;
const fehlerFeld = document.getElementById('fehler') as HTMLElement;
const hinweisFeld = document.getElementById('hinweis') as HTMLElement;
const bildA = document.getElementById('bildA') as HTMLImageElement;
const bildB = document.getElementById('bildB') as HTMLImageElement;
const film = document.getElementById('film') as HTMLVideoElement;

let code = '';
let geheim = '';
let fassung = -1;
let programm: Programm | null = null;
let folge: number[] = [];
let stelle = 0;
let pausiert = false;
let vorn: HTMLImageElement = bildA;
let uhr: number | null = null;

function fehler(text: string): void {
  fehlerFeld.textContent = text;
  fehlerFeld.hidden = text.length === 0;
}

function hinweis(text: string): void {
  hinweisFeld.textContent = text;
  hinweisFeld.hidden = text.length === 0;
}

/**
 * Eine Antwort holen und als JSON lesen.
 *
 * Wirft bei allem, was nicht 2xx ist. Ein Fernseher steht oft an einer
 * wackligen Verbindung; der Aufrufer fängt und versucht es beim nächsten Takt
 * wieder, statt mit einer Fehlerseite stehenzubleiben.
 */
async function holen(pfad: string, art = 'GET'): Promise<Record<string, unknown>> {
  const antwort = await fetch(pfad, { method: art });
  if (!antwort.ok) throw new Error(String(antwort.status));
  return (await antwort.json()) as Record<string, unknown>;
}

async function anmelden(): Promise<void> {
  try {
    const antwort = await holen(WURZEL, 'POST');
    code = String(antwort.code ?? '');
    geheim = String(antwort.geheim ?? '');
    codeFeld.textContent = code;
    fehler('');
    /*
     * Der Code darf einen Neustart des Blatts überleben.
     *
     * Ein Fernseher lädt die Seite gern von selbst neu – beim Aufwachen, beim
     * Zurückspringen aus einer anderen App. Ohne das hier stünde danach ein
     * anderer Code da, und wer gerade am Telefon tippt, tippte ins Leere.
     *
     * `sessionStorage` und nicht `localStorage`: Am nächsten Tag soll eine
     * neue Sitzung her, und der Speicher eines Fernsehers wird selten
     * aufgeräumt. Wo es ihn gar nicht gibt, geht es ohne – dann kostet ein
     * Neuladen eben einen neuen Code.
     */
    try {
      sessionStorage.setItem('tv-sitzung', JSON.stringify({ code, geheim }));
    } catch {
      /* Ohne Speicher eben ohne. */
    }
  } catch {
    fehler('Keine Verbindung zum Server. Es wird weiter versucht …');
  }
}

/** Eine gemerkte Sitzung wieder aufnehmen – oder `false`, wenn es keine gibt. */
function wiederaufnehmen(): boolean {
  try {
    const roh = sessionStorage.getItem('tv-sitzung');
    if (!roh) return false;
    const gemerkt = JSON.parse(roh) as { code?: string; geheim?: string };
    if (!gemerkt.code || !gemerkt.geheim) return false;
    code = gemerkt.code;
    geheim = gemerkt.geheim;
    codeFeld.textContent = code;
    return true;
  } catch {
    return false;
  }
}

/** Der Taktgeber: fragt nach dem Stand und holt die Liste, wenn nötig. */
async function nachsehen(): Promise<void> {
  if (!code || !geheim) return;
  let stand: Record<string, unknown>;
  try {
    stand = await holen(`${WURZEL}/${code}/stand?geheim=${encodeURIComponent(geheim)}`);
    fehler('');
  } catch (ausfall) {
    /*
     * 404 heisst: Die Sitzung ist abgelaufen oder weggeräumt. Dann eine neue
     * holen, statt bis in alle Ewigkeit gegen eine Wand zu fragen.
     */
    if (ausfall instanceof Error && ausfall.message === '404') {
      try {
        sessionStorage.removeItem('tv-sitzung');
      } catch {
        /* egal */
      }
      await anmelden();
    } else {
      fehler('Keine Verbindung zum Server. Es wird weiter versucht …');
    }
    return;
  }

  if (!stand.verbunden) {
    zeigeAnmeldung();
    fassung = -1;
    return;
  }
  if (Number(stand.fassung) !== fassung) {
    await programmHolen();
  }
}

async function programmHolen(): Promise<void> {
  try {
    const neu = (await holen(
      `${WURZEL}/${code}/programm?geheim=${encodeURIComponent(geheim)}`,
    )) as unknown as Programm;
    if (!neu.stuecke || neu.stuecke.length === 0) {
      zeigeAnmeldung();
      return;
    }
    const wechsel = !programm || neu.saat !== programm.saat || neu.modus !== programm.modus;
    programm = neu;
    fassung = neu.fassung;
    if (wechsel) folge = reihenfolge(neu.stuecke.length, neu.modus, neu.saat);
    stelle = Math.max(0, Math.min(neu.stelle, folge.length - 1));
    pausiert = neu.pausiert;
    zeigeBuehne();
    spielen();
  } catch {
    /* Beim nächsten Takt noch einmal. */
  }
}

function zeigeAnmeldung(): void {
  if (!buehne.hidden) {
    film.pause();
    film.removeAttribute('src');
    film.load();
  }
  programm = null;
  anmeldung.hidden = false;
  buehne.hidden = true;
  blatt.className = 'warten';
  anhalten();
}

function zeigeBuehne(): void {
  anmeldung.hidden = true;
  buehne.hidden = false;
  blatt.className = 'spielt';
}

function anhalten(): void {
  if (uhr !== null) {
    clearTimeout(uhr);
    uhr = null;
  }
}

/** Das Stück an der aktuellen Stelle – durch die Mischung hindurch. */
function aktuell(): Stueck | null {
  if (!programm || folge.length === 0) return null;
  const at = folge[((stelle % folge.length) + folge.length) % folge.length];
  return programm.stuecke[at] ?? null;
}

function weiter(): void {
  if (!programm || folge.length === 0) return;
  stelle = (stelle + 1) % folge.length;
  spielen();
}

/**
 * Das aktuelle Stück zeigen.
 *
 * Ein Bild bekommt eine feste Standzeit. Ein Video läuft, so lange es läuft –
 * und erst sein Ende schaltet weiter. Ein Video nach sechs Sekunden
 * abzuschneiden, weil das die Diashow-Zeit ist, wäre die schlechtere
 * Voreinstellung.
 */
function spielen(): void {
  anhalten();
  const stueck = aktuell();
  if (!stueck || !programm) return;
  hinweis('');

  if (stueck.art === 'video') {
    bildA.classList.remove('sichtbar');
    bildB.classList.remove('sichtbar');
    film.hidden = false;
    film.src = stueck.url;
    film.currentTime = 0;
    /*
     * Stumm, und das ist eine Entscheidung: Ohne `muted` verweigert jeder
     * Browser das Abspielen ohne Fingertipp – und auf einem Fernseher gibt es
     * keinen. Lieber ein laufendes Video ohne Ton als ein stehendes mit.
     */
    film.muted = true;
    const fertig = () => {
      film.removeEventListener('ended', fertig);
      if (!pausiert) weiter();
    };
    film.addEventListener('ended', fertig);
    if (!pausiert) {
      const versuch = film.play();
      if (versuch && typeof versuch.catch === 'function') {
        versuch.catch(() => hinweis('Das Video lässt sich hier nicht abspielen.'));
      }
    }
    return;
  }

  film.pause();
  film.hidden = true;
  /*
   * Erst laden, dann blenden.
   *
   * Der Tausch geschieht im `onload` des HINTEREN Bildes. Andersherum –
   * blenden und dann laden – sähe man auf einer langsamen Verbindung als
   * leere Fläche, und genau davor sollen die zwei Elemente schützen.
   */
  const hinten = vorn === bildA ? bildB : bildA;
  const zeitAn = () => {
    if (pausiert) return;
    uhr = window.setTimeout(weiter, (programm?.sekunden ?? 6) * 1000);
  };
  hinten.onload = () => {
    hinten.classList.add('sichtbar');
    vorn.classList.remove('sichtbar');
    vorn = hinten;
    zeitAn();
  };
  hinten.onerror = () => {
    hinweis('Dieses Bild liess sich nicht laden.');
    zeitAn();
  };
  hinten.src = stueck.url;
  // Ist es schon im Zwischenspeicher, kommt `onload` in manchen Browsern nicht
  // mehr – dann von Hand.
  if (hinten.complete && hinten.naturalWidth > 0) hinten.onload(new Event('load'));
}

/** Auf dem Fernseher gibt es keine Maus – aber fast immer Pfeiltasten. */
function tasten(): void {
  window.addEventListener('keydown', (ereignis) => {
    if (!programm) return;
    if (ereignis.key === 'ArrowRight' || ereignis.key === 'MediaTrackNext') weiter();
    if (ereignis.key === 'ArrowLeft' || ereignis.key === 'MediaTrackPrevious') {
      stelle = (stelle - 1 + folge.length) % folge.length;
      spielen();
    }
    if (ereignis.key === ' ' || ereignis.key === 'Enter' || ereignis.key === 'MediaPlayPause') {
      pausiert = !pausiert;
      if (pausiert) {
        anhalten();
        film.pause();
      } else {
        spielen();
      }
    }
  });
}

async function los(): Promise<void> {
  tasten();
  if (!wiederaufnehmen()) await anmelden();
  await nachsehen();
  window.setInterval(() => void nachsehen(), TAKT_MS);
  /*
   * Den Bildschirm wachhalten, wo es geht.
   *
   * Eine Diashow ohne Fingertipp gilt jedem Gerät als Untätigkeit, und nach
   * zehn Minuten geht der Bildschirmschoner an. `wakeLock` gibt es nicht
   * überall – wo nicht, bleibt es beim Versuch.
   */
  const wach = (
    navigator as Navigator & { wakeLock?: { request: (art: string) => Promise<unknown> } }
  ).wakeLock;
  if (wach) {
    try {
      await wach.request('screen');
    } catch {
      /* Dann eben nicht. */
    }
  }
}

void los();
