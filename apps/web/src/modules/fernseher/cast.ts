/**
 * Google Cast – der Weg mit einem Fingertipp.
 *
 * # Warum jetzt doch, nachdem es einmal abgelehnt war
 *
 * Beim ersten Mal war die Frage „umsonst?" nicht belastbar beantwortet, und
 * die Antwort schien Nein zu heissen. Sie ist nachgeschlagen worden und
 * lautet Ja: Die Google Cast SDK Additional Developer Terms gewähren in §2.1
 * eine „limited, worldwide, **royalty-free** … license". Es gibt keine
 * Gebühr, keine Umsatzschwelle, keine Nicht-kommerziell-Klausel. Die einzige
 * Zahlung im ganzen Umfeld sind einmalig fünf Dollar für ein Entwicklerkonto –
 * und die braucht nur, wer einen EIGENEN Empfänger veröffentlicht. Mit dem
 * Standard-Empfänger (`CC1AD845`) braucht es das nicht.
 *
 * Geblieben ist der eine Preis, der nicht in Geld anfällt: `cast_sender.js`
 * liegt auf gstatic.com. Deshalb steht dieses Modul unter einer Bedingung –
 * siehe unten.
 *
 * # Was die Bedingungen von uns VERLANGEN
 *
 * Das sind Pflichten, keine Empfehlungen, und sie stehen deshalb hier oben:
 *
 *   * **§5.1 – der offizielle Knopf.** „must use the cast button available in
 *     the Get Started guide", auf oberster Ebene, nicht in einem Klappmenü,
 *     auf jeder Seite mit castbarem Inhalt. Ein eigenes Symbol wäre ein
 *     Verstoss. Deshalb rendert `CastKnopf` das echte
 *     `<google-cast-launcher>` und malt kein eigenes.
 *   * **§3.4.8 – kein Auto-Cast.** Es wird nur auf ausdrückliche Handlung
 *     gestreamt, nie von selbst.
 *   * **§3.4.6 – Steuerung nur über das SDK.** Kein eigener Steuerkanal am
 *     SDK vorbei.
 *
 * # Die Bedingung, unter der überhaupt geladen wird
 *
 * In der Datenschutzerklärung dieser App steht: „Die Seite lädt nichts von
 * fremden Servern." Dieser Satz soll wahr bleiben, solange niemand etwas
 * anderes will. Deshalb wird `cast_sender.js` NICHT beim Start geladen,
 * sondern erst, wenn jemand das Streamen einmal ausdrücklich einschaltet.
 * Diese Entscheidung merkt sich das Gerät.
 *
 * Damit ist die Übermittlung an Google (IP-Adresse, Browserkennung, je nach
 * Referrer-Regel die Adresse der Seite) vom Menschen ausgelöst und nicht von
 * uns – und der Satz oben behält seine Gültigkeit für alle, die den Knopf nie
 * drücken.
 *
 * # Was Cast NICHT kann, und wo deshalb das TV-Blatt bleibt
 *
 *   * **Chrome und Edge, sonst nichts.** Safari und Firefox haben keine
 *     Cast-Unterstützung.
 *   * **Die Geräteliste gehört dem Browser.** Das SDK gibt sie nicht heraus –
 *     Chrome zeigt seinen eigenen Wähler. Wir können nur wissen, OB Geräte da
 *     sind, und ihn öffnen.
 *   * **Bilder höchstens 1280 × 720.** Der Standard-Empfänger rechnet alles
 *     Grössere herunter; deshalb wird gleich die passende Miniatur geschickt.
 *   * **Keine Standzeit je Bild.** Der Standard-Empfänger kennt kein „zeig
 *     dieses Bild acht Sekunden lang". Eine Diashow muss deshalb vom Telefon
 *     getaktet werden und läuft nur, solange die App offen ist.
 *   * **Der Gerätewähler braucht eine FRISCHE Fingerbewegung.** `requestSession()`
 *     aus einem `.then()` heraus tut nichts – die Geste ist dann verbraucht,
 *     und Chrome lässt die Liste gar nicht erst aufgehen. Deshalb gibt es
 *     hier keine Funktion, die „zustimmen und verbinden" in einem Schritt
 *     erledigt; es gibt sie nicht, weil es sie nicht geben kann. Verbunden
 *     wird über den echten `<google-cast-launcher>`, und das ist ohnehin das,
 *     was §5.1 verlangt.
 *     (Zweite Falle derselben Stelle, falls sie je gebraucht wird:
 *     `requestSession()` erfüllt sich mit `null`, wenn es geklappt hat, und
 *     LEHNT AB mit einer Fehlerkennung als Zeichenkette, wenn nicht. Wer auf
 *     einen Wert prüft, statt zu fangen, hält den Erfolg für einen Fehlschlag.)
 *
 * Das TV-Blatt unter `/tv` hat keine dieser Grenzen und bleibt deshalb
 * daneben stehen – für jeden Fernseher ohne Cast, für Safari, und für eine
 * Diashow, die weiterlaufen soll, wenn das Telefon in der Tasche steckt.
 */

import { api } from '../../lib/api.js';

/** Der Standard-Empfänger von Google. Ohne Registrierung nutzbar. */
const STANDARD_EMPFAENGER = 'CC1AD845';

/**
 * Wer einen eigenen Empfänger registriert hat, trägt seine Kennung hier ein.
 *
 * Das lohnt sich (einmalig fünf Dollar): Ein eigener Empfänger ist eine
 * eigene Webseite auf dem Fernseher – damit fällt die Grenze von 1280 × 720
 * für Bilder weg, das „Playing Default Media Receiver"-Schild verschwindet,
 * und die Diashow könnte auf dem GERÄT laufen statt im Telefon.
 */
const EMPFAENGER = import.meta.env.VITE_CAST_APP_ID || STANDARD_EMPFAENGER;

const LADER = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';

/** Wo die Entscheidung „ja, mit Google" gemerkt wird. */
export const ERLAUBNIS_SCHLUESSEL = 'initiative.cast-erlaubt';

/* ---------- Die Typen, die das SDK mitbringt und nicht beschreibt ---------- */

interface CastMediaInfo {
  contentId: string;
  contentType: string;
  contentUrl?: string;
  streamType?: string;
  metadata?: unknown;
}
interface CastSession {
  loadMedia(anfrage: unknown): Promise<string | null | undefined>;
  endSession(stoppen: boolean): void;
  getCastDevice?: () => { friendlyName?: string } | null;
}
interface CastContext {
  setOptions(o: Record<string, unknown>): void;
  getCastState(): string;
  getCurrentSession(): CastSession | null;
  requestSession(): Promise<unknown>;
  addEventListener(art: string, hoerer: (e: { castState?: string }) => void): void;
  removeEventListener(art: string, hoerer: (e: { castState?: string }) => void): void;
}
interface CastGlobal {
  framework: {
    CastContext: { getInstance(): CastContext };
    CastContextEventType: { CAST_STATE_CHANGED: string };
    CastState: Record<string, string>;
  };
}
interface ChromeGlobal {
  cast: {
    AutoJoinPolicy: Record<string, string>;
    ErrorCode: Record<string, string>;
    media: {
      DEFAULT_MEDIA_RECEIVER_APP_ID: string;
      MediaInfo: new (id: string, typ: string) => CastMediaInfo;
      LoadRequest: new (info: CastMediaInfo) => Record<string, unknown>;
      StreamType: Record<string, string>;
      GenericMediaMetadata: new () => Record<string, unknown>;
      PhotoMediaMetadata: new () => Record<string, unknown>;
    };
  };
}

type MitCast = typeof globalThis & {
  cast?: CastGlobal;
  chrome?: ChromeGlobal;
  __onGCastApiAvailable?: (da: boolean, grund?: string) => void;
};

function welt(): MitCast {
  return globalThis as MitCast;
}

/* ---------- Erlaubnis ---------- */

/** Hat jemand auf diesem Gerät das Streamen über Google eingeschaltet? */
export function castErlaubt(): boolean {
  try {
    return localStorage.getItem(ERLAUBNIS_SCHLUESSEL) === 'ja';
  } catch {
    return false;
  }
}

export function castErlauben(an: boolean): void {
  try {
    if (an) localStorage.setItem(ERLAUBNIS_SCHLUESSEL, 'ja');
    else localStorage.removeItem(ERLAUBNIS_SCHLUESSEL);
  } catch {
    /* Ohne Speicher gilt es eben nur für diesen Besuch. */
  }
  if (!an) {
    /*
     * Erst trennen, dann vergessen.
     *
     * Ohne diese Zeile lief eine Diashow auf dem Fernseher einfach weiter –
     * und zugleich verschwand der einzige Knopf, über den man sie hätte
     * beenden können (`<google-cast-launcher>` gibt es nur, solange das
     * Streamen eingeschaltet ist). Auch ein Neuladen half nicht: `castLaden`
     * steigt bei fehlender Erlaubnis sofort aus, das SDK kommt gar nicht
     * mehr, die Sitzung bleibt unerreichbar. Der Fernseher im Wohnzimmer
     * stand dann bis zum Ausschalten auf dem letzten Bild.
     */
    castTrennen();
    ladeVersprechen = null;
  }
  horcher.forEach((melden) => melden());
}

/**
 * Eine laufende Cast-Sitzung beenden.
 *
 * `endSession(true)` heisst: auch den Empfänger anhalten, nicht nur die
 * Verbindung lösen. Alles andere liesse das letzte Bild stehen.
 *
 * Still, wenn nichts läuft oder das SDK gar nicht da ist – der Aufrufer ist
 * ein Schalter in den Einstellungen, und der soll nicht wissen müssen,
 * worauf er gerade verzichtet.
 */
export function castTrennen(): void {
  try {
    const g = welt();
    if (!g.cast?.framework) return;
    g.cast.framework.CastContext.getInstance().getCurrentSession()?.endSession(true);
  } catch {
    /* Ein Widerruf darf an einer Sitzung nicht scheitern, die es nicht gibt. */
  }
}

/**
 * Wer erfahren will, wenn sich die Erlaubnis ändert.
 *
 * # Warum das eine gemeinsame Quelle braucht
 *
 * Es gibt diesen Knopf mehr als einmal auf dem Bildschirm, und zwar
 * gleichzeitig: In einer Sammlung sitzt einer in der Werkzeugleiste, und
 * öffnet man ein Foto, kommt der Betrachter mit einem zweiten darüber – die
 * Leiste dahinter bleibt montiert.
 *
 * Wer die Erlaubnis in jeder Instanz einzeln in einem `useState`-Anfangswert
 * festhält, hat danach zwei verschiedene Wahrheiten: Die Zustimmung im
 * Betrachter erreicht die Leiste dahinter nicht, und beim Schliessen des
 * Betrachters fragt sie ein zweites Mal dasselbe. Deshalb hier ein Abo statt
 * eines Anfangswerts.
 *
 * `storage` kommt dazu, weil der Widerruf in den Einstellungen auch aus einer
 * anderen Lasche stammen kann. Das Ereignis feuert ausdrücklich nur in den
 * ANDEREN Laschen – der eigene Weg läuft über `horcher`.
 */
const horcher = new Set<() => void>();

export function castErlaubnisBeobachten(melden: () => void): () => void {
  horcher.add(melden);
  const ausFremderLasche = (e: StorageEvent) => {
    if (e.key === null || e.key === ERLAUBNIS_SCHLUESSEL) melden();
  };
  window.addEventListener('storage', ausFremderLasche);
  return () => {
    horcher.delete(melden);
    window.removeEventListener('storage', ausFremderLasche);
  };
}

/**
 * Kann dieser Browser überhaupt casten – und wenn nein, warum nicht?
 *
 * Hier stand einmal ein blosses `castMoeglich(): boolean`, und daran ist die
 * Oberfläche gescheitert: Ein Nein ohne Grund ergibt eine Leerstelle, und eine
 * Leerstelle liest sich als Fehler der App. Der Grund – denn „geht nicht" ist drei verschiedene Sachen.
 *
 * Ein blosses Ja/Nein war hier zu wenig. Der häufigste Fall in der Praxis ist
 * der mittlere, und er sieht für den Anwender aus wie ein Fehler der App:
 *
 *   * `geht` – Chromium auf https oder localhost.
 *   * `kein-sicherer-kontext` – dieselbe App über `http://192.168.x.x`, also
 *     jedes Telefon, das den Entwicklungsserver im WLAN aufruft. Die
 *     Presentation API ist dort abgeschaltet. Der Browser KÖNNTE casten, die
 *     Adresse verbietet es. Das ist eine Auskunft wert, keine Leerstelle.
 *   * `browser-kann-nicht` – Safari, Firefox, und jedes iPhone: Auf iOS
 *     schreibt Apple die WebKit-Engine vor, also kann dort auch Chrome nicht
 *     casten. Hier hilft nur ein anderer Weg.
 */
export type CastGrund = 'geht' | 'kein-sicherer-kontext' | 'browser-kann-nicht';

export function castGrund(): CastGrund {
  if (typeof window === 'undefined') return 'browser-kann-nicht';
  const presentation = typeof (navigator as Navigator & { presentation?: unknown }).presentation;
  if (!window.isSecureContext) {
    /*
     * Ohne sicheren Kontext ist die Presentation API gar nicht erst
     * vorhanden – die Unterscheidung „Browser kann nicht" gegen „Adresse
     * erlaubt es nicht" lässt sich hier also nicht am Objekt festmachen. Sie
     * lässt sich aber am Browser festmachen, und zwar an der einen
     * Eigenschaft, die alle Chromium-Browser haben und sonst niemand.
     */
    const chromium =
      /Chrome|Chromium|Edg|OPR/.test(navigator.userAgent) &&
      !/OS X.*Version\//.test(navigator.userAgent);
    const apfel = /iPhone|iPad|iPod/.test(navigator.userAgent);
    return chromium && !apfel ? 'kein-sicherer-kontext' : 'browser-kann-nicht';
  }
  return presentation !== 'undefined' ? 'geht' : 'browser-kann-nicht';
}

/* ---------- Laden ---------- */

let ladeVersprechen: Promise<CastContext | null> | null = null;

/**
 * Das SDK holen und einrichten – genau einmal je Seitenaufruf.
 *
 * Gibt `null` zurück, wenn es hier nicht geht. Wirft nicht: Ein Browser ohne
 * Cast ist kein Fehler, sondern ein Browser ohne Cast.
 */
export function castLaden(): Promise<CastContext | null> {
  if (ladeVersprechen) return ladeVersprechen;
  if (castGrund() !== 'geht' || !castErlaubt()) return Promise.resolve(null);

  ladeVersprechen = new Promise<CastContext | null>((fertig) => {
    const g = welt();
    if (g.cast?.framework) {
      fertig(einrichten());
      return;
    }
    /*
     * Der Rückruf MUSS stehen, bevor das Skript da ist – das Skript ruft ihn
     * beim Laden selbst auf. Andersherum verpasst man ihn und wartet für
     * immer.
     */
    let erledigt = false;
    g.__onGCastApiAvailable = (da: boolean) => {
      if (erledigt) return;
      erledigt = true;
      fertig(da ? einrichten() : null);
    };
    const skript = document.createElement('script');
    skript.src = LADER;
    skript.async = true;
    skript.onerror = () => {
      if (erledigt) return;
      erledigt = true;
      fertig(null);
    };
    document.head.appendChild(skript);
    /*
     * Und eine Frist. Ohne Netz meldet sich weder `onerror` noch der Rückruf
     * zuverlässig, und der Knopf drehte sich bis in alle Ewigkeit.
     */
    setTimeout(() => {
      if (erledigt) return;
      erledigt = true;
      fertig(welt().cast?.framework ? einrichten() : null);
    }, 8000);
  });
  return ladeVersprechen;
}

function einrichten(): CastContext | null {
  const g = welt();
  if (!g.cast?.framework || !g.chrome?.cast) return null;
  const ctx = g.cast.framework.CastContext.getInstance();
  ctx.setOptions({
    receiverApplicationId: EMPFAENGER,
    /*
     * `ORIGIN_SCOPED`: Eine laufende Sitzung wird von jeder Lasche dieser App
     * wieder aufgenommen – aber von keiner fremden Seite. `PAGE_SCOPED` wäre
     * enger und hiesse: Wer im Chat auf den Fernseher schickt und dann zu den
     * Dateien wechselt, verliert die Verbindung.
     */
    autoJoinPolicy: g.chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
    language: 'de-DE',
    resumeSavedSession: true,
  });
  return ctx;
}

/**
 * Der Zustand, wie ihn die Oberfläche braucht.
 *
 * `aus` heisst „das SDK ist noch nicht da" und ist ein Durchgangszustand.
 * `fehlgeschlagen` ist das Ende der Fahnenstange: Das Skript kam nicht – kein
 * Netz, ein Blocker, oder die Frist von acht Sekunden ist abgelaufen. Beides
 * auseinanderzuhalten ist der Unterschied zwischen „einen Moment noch" und
 * einem Ladehinweis, der für immer stehen bleibt.
 */
export type CastZustand =
  'aus' | 'fehlgeschlagen' | 'keine-geraete' | 'bereit' | 'verbindet' | 'verbunden';

export function zustandAus(roh: string | undefined): CastZustand {
  switch (roh) {
    case 'NO_DEVICES_AVAILABLE':
      return 'keine-geraete';
    case 'NOT_CONNECTED':
      return 'bereit';
    case 'CONNECTING':
      return 'verbindet';
    case 'CONNECTED':
      return 'verbunden';
    default:
      return 'aus';
  }
}

/**
 * Den Zustand beobachten. Gibt zurück, wie man wieder aufhört.
 */
export function castBeobachten(ctx: CastContext, melden: (z: CastZustand) => void): () => void {
  const g = welt();
  const art = g.cast?.framework.CastContextEventType.CAST_STATE_CHANGED ?? 'caststatechanged';
  const hoerer = (e: { castState?: string }) => melden(zustandAus(e.castState));
  ctx.addEventListener(art, hoerer);
  melden(zustandAus(ctx.getCastState()));
  return () => ctx.removeEventListener(art, hoerer);
}

/** Fehlerkennungen des SDK in Sätze, die man jemandem zeigen kann. */
export function castFehlertext(kennung: unknown): string {
  switch (String(kennung).toLowerCase()) {
    case 'cancel':
      return '';
    case 'timeout':
      return 'Der Fernseher hat nicht geantwortet.';
    case 'receiver_unavailable':
      return 'Kein Fernseher gefunden. Er muss im selben WLAN sein und eingeschaltet.';
    case 'session_error':
      return 'Die Verbindung zum Fernseher ist abgebrochen.';
    case 'channel_error':
      return 'Die Verbindung zum Fernseher wurde unterbrochen.';
    case 'load_failed':
      return 'Der Fernseher konnte die Datei nicht laden.';
    case 'extension_missing':
    case 'api_not_initialized':
      return 'Dieser Browser kann nicht auf einen Chromecast streamen.';
    default:
      return 'Das Streamen hat nicht geklappt.';
  }
}

/* ---------- Was gezeigt wird ---------- */

/** Ein Stück, wie es auf den Fernseher geht. */
export interface CastStueck {
  url: string;
  mime: string;
  titel: string;
  bild: boolean;
}

/**
 * Eine Eintrittskarte holen und daraus die Adresse bauen, die der Fernseher
 * abrufen kann.
 *
 * Bei einem FOTO wird nicht das Original geschickt, sondern das Miniaturbild
 * in Fernsehgrösse. Der Standard-Empfänger zeigt Bilder ohnehin höchstens mit
 * 1280 × 720 und rechnet alles Grössere herunter – ein Foto von zwölf
 * Megapunkten wären dreissig Megabyte durchs WLAN, damit das Gerät sie auf ein
 * Zwanzigstel zusammenrechnet.
 */
export async function stueckFuer(attachmentId: string): Promise<CastStueck> {
  const karte = await api.media.fernsehticket(attachmentId);
  const bild = karte.art === 'image' || karte.mime.startsWith('image/');
  const titel = karte.name ?? '';
  if (!bild) {
    return { url: karte.url, mime: karte.mime, titel, bild: false };
  }
  const feld = karte.feld ?? 'tv';
  return {
    url: `${karte.basis}/miniatur?kante=1280&${feld}=${encodeURIComponent(karte.karte)}`,
    // Der Miniaturweg gibt immer ein JPEG heraus – siehe `services/miniatur.rs`.
    mime: 'image/jpeg',
    titel,
    bild: true,
  };
}

/** Ein einzelnes Stück auf den Fernseher schicken. */
export async function abspielen(sitzung: CastSession, stueck: CastStueck): Promise<void> {
  const g = welt();
  if (!g.chrome?.cast) throw new Error('Cast ist nicht bereit.');
  const medien = g.chrome.cast.media;
  const info = new medien.MediaInfo(stueck.url, stueck.mime);
  info.streamType = medien.StreamType.BUFFERED;
  const beschreibung = stueck.bild
    ? new medien.PhotoMediaMetadata()
    : new medien.GenericMediaMetadata();
  (beschreibung as { title?: string }).title = stueck.titel;
  info.metadata = beschreibung;

  const anfrage = new medien.LoadRequest(info);
  anfrage.autoplay = true;
  const fehler = await sitzung.loadMedia(anfrage);
  if (fehler) throw new Error(castFehlertext(fehler));
}

/**
 * Eine Diashow, getaktet vom Telefon.
 *
 * # Warum nicht die Warteschlange des SDK
 *
 * Weil sie für Bilder nicht tut, was man erwartet. Ein `QueueItem` kennt
 * `autoplay`, `startTime`, `preloadTime` und `playbackDuration` – und keines
 * davon ist eine STANDZEIT. Für ein Video ergeben sie Sinn (Einsprungpunkt,
 * Vorladen); für ein Bild gibt es keine Dauer, an der sie sich festmachen
 * könnten. Der Standard-Empfänger lädt ein Bild und lässt es stehen, bis
 * etwas anderes kommt. Eine Bild-Warteschlange läuft dort also gar nicht
 * durch.
 *
 * Also taktet das Telefon: Bild laden, warten, nächstes laden. Der Preis
 * steht in der Oberfläche – die Diashow läuft, solange die App offen ist.
 *
 * # Warum die Mischung von aussen kommt
 *
 * Damit sie dieselbe ist wie auf dem TV-Blatt (`tv/mischen.ts`): gerechnet
 * aus einer Saat, nicht gewürfelt. Zwei Wege, die „gemischt" verschieden
 * verstehen, wären zwei Fehlerquellen statt einer Einstellung.
 */
export class Diashow {
  private uhr: number | null = null;
  private laufend = false;
  private stelle = 0;

  constructor(
    private readonly sitzung: CastSession,
    private readonly folge: string[],
    private readonly sekunden: number,
    private readonly melden?: (stelle: number, gesamt: number, fehler?: string) => void,
  ) {}

  async starten(): Promise<void> {
    this.laufend = true;
    this.stelle = 0;
    await this.zeigen();
  }

  weiter(schritt = 1): void {
    if (this.folge.length === 0) return;
    this.stelle =
      (((this.stelle + schritt) % this.folge.length) + this.folge.length) % this.folge.length;
    void this.zeigen();
  }

  anhalten(): void {
    this.laufend = false;
    if (this.uhr !== null) {
      clearTimeout(this.uhr);
      this.uhr = null;
    }
  }

  private async zeigen(): Promise<void> {
    if (this.uhr !== null) {
      clearTimeout(this.uhr);
      this.uhr = null;
    }
    const id = this.folge[this.stelle];
    if (!id) return;
    try {
      const stueck = await stueckFuer(id);
      await abspielen(this.sitzung, stueck);
      this.melden?.(this.stelle, this.folge.length);
      /*
       * Ein VIDEO in der Diashow bekommt keine Uhr: Es läuft, so lange es
       * läuft. Nach acht Sekunden abzuschneiden, weil das die Bildstandzeit
       * ist, wäre die schlechtere Voreinstellung.
       */
      if (!stueck.bild || !this.laufend) return;
      this.uhr = window.setTimeout(() => this.weiter(1), this.sekunden * 1000);
    } catch (fehler) {
      this.melden?.(this.stelle, this.folge.length, (fehler as Error)?.message);
      // Ein Bild, das nicht lädt, hält die Schau nicht an – sonst reicht eine
      // gelöschte Datei, und der Abend ist vorbei.
      if (this.laufend) {
        this.uhr = window.setTimeout(() => this.weiter(1), 1500);
      }
    }
  }
}
