/**
 * Das Blatt, das auf dem Fernseher läuft.
 *
 * # Der Ablauf
 *
 * 1. Beim Öffnen holt es sich eine Sitzung: einen CODE, den es gross anzeigt,
 *    und ein GEHEIMNIS, das es behält und nie zeigt.
 * 2. Es fragt alle zwei Sekunden nach dem Stand. Das ist eine winzige
 *    Antwort; die Liste selbst – bei einem Urlaubsordner leicht ein Megabyte –
 *    wird erst geholt, wenn sich ihr Inhalt geändert haben kann
 *    (`listeNeuHolen` in `ablauf.ts`). Blättert nur jemand oder hält an,
 *    genügen Stelle und Pause aus dem Stand.
 * 3. Am Telefon tippt jemand den Code ein und wählt eine Sammlung. Ab da läuft
 *    die Diashow, und dasselbe Telefon ist die Fernbedienung.
 * 4. Schaltet das Blatt selbst weiter, meldet es die neue Stelle zurück –
 *    damit „Weiter" am Telefon von hier aus rechnet und nicht vom Anfang.
 *
 * # Warum hier kein React steht
 *
 * Weil der Browser am anderen Ende selten ein aktueller ist. Dieses Blatt
 * kommt mit dem aus, was ein Fernseher von 2019 kann (Chromium 63): `fetch`,
 * Klassenlisten, `<video>`. Keine Bibliothek, kein Zustandsspeicher, keine
 * Weiche.
 *
 * Hier stand einmal „seit ungefähr 2017" – und das stimmte nicht. Gebaut
 * wurde für ES2022, und der Verkleinerer machte aus jedem `a != null ? a : b`
 * wieder ein `a ?? b`, das erst Chromium 80 versteht; dazu `replaceChildren`
 * (86) und `inset` im Stilblatt (87). Samsung-Geräte von 2020 bis 2022 und LG
 * webOS 5/6 blieben beim „…" stehen oder zeigten eine Bühne ohne Grösse. Der
 * Bau senkt das Blatt jetzt eigens ab (`scripts/fernsehblatt.ts`), und was
 * sich nicht absenken lässt – Bibliotheksaufrufe –, ist hier von Hand
 * ersetzt (`leeren`).
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
import { leeren, verlaufZeichnen, type ChatProgramm } from './chat.js';
import { imKreis, kartenAlt, listeNeuHolen, tasteDeuten } from './ablauf.js';

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
  art?: string;
  marke: string;
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
const tonFeld = document.getElementById('ton') as HTMLElement;
const bildA = document.getElementById('bildA') as HTMLImageElement;
const bildB = document.getElementById('bildB') as HTMLImageElement;
const film = document.getElementById('film') as HTMLVideoElement;
const verlauf = document.getElementById('verlauf') as HTMLElement;
const verlaufListe = document.getElementById('verlauf-liste') as HTMLElement;
const verlaufTitel = document.getElementById('verlauf-titel') as HTMLElement;
const verlaufSeite = document.getElementById('verlauf-seite') as HTMLElement;

let code = '';
let geheim = '';
/*
 * Woran der Fernseher merkt, dass sich etwas getan hat.
 *
 * Eine Zeichenkette und keine Zahl – und das ist der Unterschied zwischen
 * Diashow und Chat. Bei einer Diashow ist es die Fassungsnummer der Sitzung;
 * die steigt, wenn jemand am Telefon blättert. Bei einem Chat steckt darin
 * zusätzlich ein Abdruck der sichtbaren Nachrichten, denn eine NEUE Nachricht
 * ändert die Sitzung nicht. Ohne das bliebe der Fernseher auf dem Stand vom
 * Einstellen stehen – lautlos, ohne Fehler.
 *
 * Verglichen wird nur auf Gleichheit, nie auf grösser. Deshalb darf hier auch
 * etwas stehen, das keine Ordnung hat.
 */
let marke = '';
let programm: Programm | null = null;
let folge: number[] = [];
let stelle = 0;
let pausiert = false;
let vorn: HTMLImageElement = bildA;
let uhr: number | null = null;
/** Wann die Liste zuletzt geholt wurde – für das Erneuern der Karten. */
let geholtUm = 0;
/**
 * Welches Stück gerade auf dem Schirm steht, nach seiner Kennung.
 *
 * Die ADRESSE taugt dafür nicht: Sie trägt eine Karte, und jede neu geholte
 * Liste hat neue Karten. Wer an der Adresse misst, hält dasselbe Video nach
 * jedem Holen für ein anderes – und genau so fing es nach „Pause" von vorn an.
 */
let gezeigt: string | null = null;
/** Läuft gerade eine Meldung der Stelle? Dann wartet der Takt auf sie. */
let meldungLaeuft = false;
/** Läuft gerade eine Abfrage? Zwei überholen sich sonst auf langsamen Netzen. */
let fragtGerade = false;

/**
 * Darf das Video mit Ton laufen?
 *
 * # Warum es stumm anfängt
 *
 * Ohne Fingertipp – oder hier: ohne Tastendruck – verweigert jeder Browser das
 * Abspielen MIT Ton. Auf einem Fernseher tippt niemand; lieber ein laufendes
 * Video ohne Ton als ein stehendes mit.
 *
 * # Warum ein Druck auf OK genügt
 *
 * Ein Tastendruck ist eine Nutzeraktivierung, genau wie ein Fingertipp. Danach
 * darf die Seite Ton abspielen. Die Videos liefen trotzdem immer stumm – es
 * gab schlicht keinen Weg zum Ton. Jetzt steht „OK drücken für Ton" im Bild,
 * und der erste OK schaltet ihn ein.
 *
 * Gemerkt wird das für die Sitzung des Blatts (`sessionStorage`), nicht für
 * immer: Wer morgen den Fernseher einschaltet, soll nicht von einem Video mit
 * voller Lautstärke überrascht werden, das er gestern freigegeben hat. Und
 * nach einem Neuladen gilt die Aktivierung ohnehin nicht mehr – dann versucht
 * das Blatt es mit Ton und fällt still auf stumm zurück, samt Hinweis.
 */
let tonAn = gemerkt('tv-ton') === 'an';

function gemerkt(schluessel: string): string | null {
  try {
    return sessionStorage.getItem(schluessel);
  } catch {
    return null;
  }
}

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
  /*
   * Solange die eigene Meldung unterwegs ist, wird nicht gefragt.
   *
   * Sonst kann ein Stand, der VOR der Meldung gelesen wurde, die gerade
   * weitergeschaltete Stelle wieder zurücksetzen – das Blatt spränge dann ein
   * Bild zurück, sobald jemand am Telefon „Pause" drückt.
   */
  if (meldungLaeuft || fragtGerade) return;
  fragtGerade = true;
  try {
    await nachsehenJetzt();
  } finally {
    fragtGerade = false;
  }
}

async function nachsehenJetzt(): Promise<void> {
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
    /*
     * „Nicht verbunden" heisst bei einem Chat auch: Die Frist ist um.
     *
     * Ein Chat fällt nach einer halben Stunde ohne Lebenszeichen vom Schirm –
     * ein Fernseher im Wohnzimmer soll Nachrichten nicht stundenlang in ein
     * leeres Zimmer zeigen. Der Server meldet das als `verbunden: false`, und
     * hier muss dafür keine zweite Regel stehen: Der Fernseher zeigt wieder
     * seinen Code, und ein neues Programm läuft sofort.
     */
    zeigeAnmeldung();
    marke = '';
    return;
  }
  const neueMarke = String(stand.marke ?? '');
  const jetzt = Date.now();
  if (programm && kartenAlt(geholtUm, jetzt)) {
    // Nichts geändert, aber die Karten werden alt – siehe KARTEN_ERNEUERN_MS.
    await programmHolen();
    return;
  }
  if (neueMarke === marke) return;
  const kopf = programm
    ? { saat: programm.saat, modus: programm.modus, stueckzahl: programm.stuecke.length }
    : null;
  if (programm && !listeNeuHolen(stand, kopf, geholtUm, jetzt)) {
    /*
     * Nur Stelle, Pause oder Tempo haben sich bewegt – die Liste ist dieselbe.
     * Dann bleibt jedes Element, wie es ist: Ein laufendes Video wird
     * angehalten statt neu geladen.
     */
    marke = neueMarke;
    if (typeof stand.sekunden === 'number') programm.sekunden = stand.sekunden;
    uebernehmen(Number(stand.stelle) || 0, Boolean(stand.pausiert), false);
    return;
  }
  await programmHolen();
}

async function programmHolen(): Promise<void> {
  try {
    const roh = await holen(`${WURZEL}/${code}/programm?geheim=${encodeURIComponent(geheim)}`);
    if (roh.art === 'chat') {
      const chat = roh as unknown as ChatProgramm;
      programm = null;
      marke = chat.marke;
      zeigeVerlauf();
      verlaufZeichnen(verlaufListe, verlaufTitel, verlaufSeite, chat);
      return;
    }
    const neu = roh as unknown as Programm;
    if (!neu.stuecke || neu.stuecke.length === 0) {
      zeigeAnmeldung();
      return;
    }
    const wechsel =
      !programm ||
      neu.saat !== programm.saat ||
      neu.modus !== programm.modus ||
      neu.stuecke.length !== programm.stuecke.length;
    programm = neu;
    marke = neu.marke;
    geholtUm = Date.now();
    if (wechsel) folge = reihenfolge(neu.stuecke.length, neu.modus, neu.saat);
    uebernehmen(neu.stelle, neu.pausiert, wechsel);
  } catch {
    /* Beim nächsten Takt noch einmal. */
  }
}

/**
 * Stelle und Pause übernehmen – und nur dann neu abspielen, wenn sich das
 * STÜCK geändert hat.
 *
 * Das ist die Stelle, an der „Pause startet das Video von vorn" behoben ist.
 * Vorher lief hier bei jedem Griff an die Fernbedienung `spielen()`, und das
 * setzt `film.src` neu. Jetzt gilt: Steht dasselbe Stück noch auf dem Schirm,
 * wird es angehalten oder fortgesetzt, am selben Element, an derselben Stelle.
 */
function uebernehmen(neueStelle: number, neuPausiert: boolean, wechsel: boolean): void {
  const warPausiert = pausiert;
  stelle = Math.max(0, Math.min(neueStelle, folge.length - 1));
  pausiert = neuPausiert;
  zeigeBuehne();
  const jetzt = aktuell();
  if (!wechsel && jetzt && gezeigt === jetzt.id) {
    if (pausiert) {
      anhalten();
      if (!film.hidden) film.pause();
    } else if (warPausiert) {
      if (!film.hidden) abspielen();
      else zeitAn();
    }
    return;
  }
  spielen();
}

function zeigeAnmeldung(): void {
  if (!buehne.hidden) {
    film.pause();
    film.removeAttribute('src');
    film.load();
  }
  programm = null;
  gezeigt = null;
  tonHinweis(false);
  anmeldung.hidden = false;
  buehne.hidden = true;
  verlauf.hidden = true;
  /*
   * Die Liste leeren, nicht nur verstecken.
   *
   * Ein `hidden`-Abschnitt voller Nachrichten ist immer noch ein Abschnitt
   * voller Nachrichten: Er steht im Quelltext, er steht im Speicher, und die
   * nächste Bildschirmaufnahme eines Fernsehers, der zu früh aufwacht, hätte
   * ihn. Auf einem Gerät, das im Wohnzimmer steht, ist das kein theoretischer
   * Einwand.
   */
  leeren(verlaufListe);
  verlaufTitel.textContent = '';
  blatt.className = 'warten';
  anhalten();
}

/** Der Verlauf tritt an die Stelle der Bühne – immer genau einer von beiden. */
function zeigeVerlauf(): void {
  if (!buehne.hidden) {
    film.pause();
    film.removeAttribute('src');
    film.load();
  }
  gezeigt = null;
  tonHinweis(false);
  anhalten();
  anmeldung.hidden = true;
  buehne.hidden = true;
  verlauf.hidden = false;
  blatt.className = 'liest';
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

/**
 * Einen Schritt weiter oder zurück – vom Blatt selbst oder von den Tasten.
 *
 * Und danach MELDEN. Der Server erfuhr vom eigenen Weiterschalten nie etwas,
 * und die Fernbedienung am Telefon rechnete „weiter" von einer Stelle aus, die
 * längst vorbei war: Nach ein paar Minuten Schau sprang ein Druck auf „Weiter"
 * zurück an den Anfang.
 */
function schritt(richtung: number): void {
  if (!programm || folge.length === 0) return;
  stelle = imKreis(stelle + richtung, folge.length);
  spielen();
  melden();
}

function weiter(): void {
  schritt(1);
}

/**
 * Die Stelle an den Server melden – still, ohne auf eine Antwort zu bestehen.
 *
 * Geht die Meldung verloren, rechnet die Fernbedienung beim nächsten Druck
 * eben von der vorigen Stelle aus. Das ist der alte Zustand, kein neuer
 * Fehler; einen Fernseher mit einer Fehlermeldung anzuhalten, weil eine
 * Auskunft nicht ankam, wäre schlimmer.
 *
 * Kein `finally` am Versprechen: Das kennt Chromium erst ab 63, und genau
 * dort liegt die Grenze dieses Blatts.
 */
function melden(): void {
  if (!code || !geheim || !programm) return;
  meldungLaeuft = true;
  const fertig = () => {
    meldungLaeuft = false;
  };
  fetch(`${WURZEL}/${code}/stelle?geheim=${encodeURIComponent(geheim)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stelle, pausiert }),
  }).then(fertig, fertig);
}

/** Das Video abspielen – mit Ton, wenn er erlaubt ist, sonst stumm mit Hinweis. */
function abspielen(): void {
  const versuch = film.play();
  if (!versuch || typeof versuch.catch !== 'function') return;
  versuch.catch((grund: unknown) => {
    // Ein neues Stück hat das alte abgelöst – kein Fehler, nur überholt.
    if (grund instanceof Error && grund.name === 'AbortError') return;
    if (!film.muted) {
      /*
       * Mit Ton ging es nicht – typischerweise nach einem Neuladen, wenn die
       * Aktivierung weg ist, der gemerkte Wunsch aber noch steht. Dann stumm
       * weiter und wieder um OK bitten, statt stehenzubleiben.
       */
      film.muted = true;
      tonHinweis(true);
      const zweiter = film.play();
      if (zweiter && typeof zweiter.catch === 'function') {
        zweiter.catch(() => hinweis('Das Video lässt sich hier nicht abspielen.'));
      }
      return;
    }
    hinweis('Das Video lässt sich hier nicht abspielen.');
  });
}

/** „OK drücken für Ton" – nur, solange wirklich ein Video stumm läuft. */
function tonHinweis(zeigen: boolean): void {
  tonFeld.hidden = !zeigen;
}

/** Der erste OK bei einem stummen Video: Ton an, und das für die Sitzung. */
function tonEinschalten(): void {
  tonAn = true;
  try {
    sessionStorage.setItem('tv-ton', 'an');
  } catch {
    /* Dann gilt es nur bis zum Neuladen. */
  }
  film.muted = false;
  tonHinweis(false);
  if (!pausiert && film.paused) abspielen();
}

/** Die Standzeit eines Bildes starten – ausser die Schau ist angehalten. */
function zeitAn(): void {
  anhalten();
  if (pausiert) return;
  uhr = window.setTimeout(weiter, (programm ? programm.sekunden : 6) * 1000);
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
  gezeigt = stueck.id;

  if (stueck.art === 'video') {
    bildA.classList.remove('sichtbar');
    bildB.classList.remove('sichtbar');
    film.hidden = false;
    film.src = stueck.url;
    film.currentTime = 0;
    /*
     * Stumm, bis jemand OK gedrückt hat – siehe `tonAn`. Der Hinweis steht
     * nur da, solange es wirklich stumm ist; wer den Ton schon freigegeben
     * hat, soll nicht bei jedem Video wieder dazu aufgefordert werden.
     */
    film.muted = !tonAn;
    tonHinweis(film.muted);
    const fertig = () => {
      film.removeEventListener('ended', fertig);
      if (!pausiert) weiter();
    };
    film.addEventListener('ended', fertig);
    if (!pausiert) abspielen();
    return;
  }

  tonHinweis(false);
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
  /*
   * Genau EINMAL tauschen – auch wenn das Bild schon im Zwischenspeicher liegt.
   *
   * Hier lief der Tausch zweimal, wenn die Adresse schon einmal geladen war:
   * einmal von Hand (unten), und dann noch einmal durch das echte
   * `load`-Ereignis, das Chromium auch für ein Bild aus dem Speicher schickt.
   * Beim zweiten Mal war `vorn` schon das neue Bild – und es nahm sich selbst
   * die Sichtbarkeit. Beide Bilder unsichtbar, der Fernseher schwarz.
   *
   * Das traf jede Diashow in der zweiten Runde (dieselben Adressen wie in der
   * ersten) und jeden Sprung zurück. Seit die Liste nach „Pause" nicht mehr
   * mit neuen Adressen geholt wird, trat es noch öfter auf – ein Browsertest
   * (`fernsehwege.spec.ts`) hat es so gefunden. Deshalb hängt sich der
   * Tausch nach dem ersten Mal selbst ab.
   */
  const zeigen = () => {
    hinten.onload = null;
    hinten.onerror = null;
    hinten.classList.add('sichtbar');
    if (vorn !== hinten) vorn.classList.remove('sichtbar');
    vorn = hinten;
    zeitAn();
  };
  hinten.onload = zeigen;
  hinten.onerror = () => {
    hinten.onload = null;
    hinten.onerror = null;
    hinweis('Dieses Bild liess sich nicht laden.');
    zeitAn();
  };
  hinten.src = stueck.url;
  // Ist es schon im Zwischenspeicher, kommt `onload` in manchen Browsern nicht
  // mehr – dann von Hand.
  if (hinten.complete && hinten.naturalWidth > 0) zeigen();
}

/** Auf dem Fernseher gibt es keine Maus – aber fast immer Pfeiltasten. */
function tasten(): void {
  window.addEventListener('keydown', (ereignis) => {
    if (!programm) return;
    const sinn = tasteDeuten(ereignis.key, ereignis.keyCode);
    if (sinn === 'weiter') schritt(1);
    if (sinn === 'zurueck') schritt(-1);
    if (sinn !== 'ok') return;
    /*
     * Der erste OK bei einem stummen Video gehört dem Ton, nicht der Pause.
     *
     * Beides auf dieselbe Taste zu legen ist Absicht: Mehr als OK und die
     * Pfeile hat eine Fernbedienung nicht verlässlich. Wer ein stummes Video
     * sieht und OK drückt, will den Ton – das Video anzuhalten wäre die
     * Antwort auf eine Frage, die niemand gestellt hat.
     */
    if (!film.hidden && film.muted) {
      tonEinschalten();
      return;
    }
    pausiert = !pausiert;
    if (pausiert) {
      anhalten();
      if (!film.hidden) film.pause();
    } else if (!film.hidden) {
      // Weiter an derselben Stelle – nicht von vorn (siehe `uebernehmen`).
      abspielen();
    } else {
      zeitAn();
    }
    melden();
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
