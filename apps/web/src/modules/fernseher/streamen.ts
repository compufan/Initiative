/**
 * Ein Video vom Telefon auf den Fernseher schicken – ohne Lizenz, ohne SDK.
 *
 * # Was hier benutzt wird, und warum gerade das
 *
 * Zwei eingebaute Wege, die die Browser mitbringen:
 *
 *   * **Remote Playback API** (`video.remote.prompt()`). Chrome und Edge,
 *     auf Android wie auf dem Rechner, und Safari seit iOS 13.4 bzw. macOS
 *     10.15.4. Der Browser zeigt SEINE Geräteliste – in Chrome Chromecast und
 *     Google TV, in Safari AirPlay – und schickt die Adresse dorthin.
 *   * **AirPlay-Wähler** (`webkitShowPlaybackTargetPicker`). Die ältere
 *     WebKit-Schnittstelle für dieselbe Sache. Sie braucht keine Kopfdaten
 *     des Videos und springt deshalb dort ein, wo `prompt()` in WebKit noch
 *     ablehnen würde (siehe `geraeteWaehlen`).
 *
 * Hier stand einmal, die Remote Playback API gebe es in Safari nicht. Das war
 * falsch – Safari hat `video.remote` seit iOS 13.4, und deshalb lief auf dem
 * iPhone ohnehin immer dieser Zweig.
 *
 * # Warum NICHT das Google-Cast-SDK
 *
 * Es könnte mehr – Fotos, Warteschlangen – und es kostet auch nichts. Es
 * kostet etwas anderes: `cast_sender.js` liegt auf gstatic.com. Es wird
 * deshalb nur nach ausdrücklicher Zustimmung geladen (siehe `cast.ts`); dieser
 * Weg hier braucht keine.
 *
 * # Warum die Adresse getauscht wird
 *
 * Der Fernseher holt die Datei SELBST. Er schickt dabei weder den
 * `Authorization`-Kopf noch den Medien-Keks – beide gehören zum Browser, und
 * der Fernseher ist ein anderes Gerät. Die gewöhnliche Adresse ergäbe dort
 * also eine 401 und ein schwarzes Bild. Deshalb bekommt das Video eine
 * Adresse mit Eintrittskarte (`api.media.fernsehticket`).
 *
 * # Warum die Karte VOR dem Tipp eingesetzt wird – und was das kostet
 *
 * Bis hierher wurde erst NACH dem Tipp getauscht: Karte holen (Netz),
 * Adresse setzen, bis zu zweieinhalb Sekunden auf die Kopfdaten warten, dann
 * `prompt()`. Das ging an zwei Stellen schief:
 *
 *   * **Der Fingertipp war verbraucht.** `prompt()` verlangt eine frische
 *     Nutzeraktivierung. WebKit trägt sie über `fetch` nur kurz weiter und
 *     über ein Medienereignis gar nicht – auf dem iPhone ging die AirPlay-
 *     Liste deshalb nie auf (`InvalidAccessError`). Chrome gibt rund fünf
 *     Sekunden, und nach dem Tausch ist die Dauer dort erst einmal `NaN`; die
 *     Liste ist dann leer, und `prompt()` bricht wortlos ab.
 *   * **Die eingebauten Knöpfe hatten nie eine Karte.** Chrome blendet in der
 *     Videosteuerung sein eigenes Cast-Symbol ein, Safari den AirPlay-Knopf.
 *     Beide schicken die Adresse, die gerade im Element steht – ohne Karte,
 *     also 401. Gerade diese Knöpfe kennt jeder.
 *
 * Deshalb steht die Karte jetzt schon im Element, BEVOR jemand tippt, und im
 * Klick wird nur noch die Liste geöffnet – synchron, im selben Takt wie der
 * Finger. Eingesetzt wird sie in genau zwei Fällen:
 *
 *   1. **Der Browser meldet einen Fernseher in Reichweite** (`geraeteBeobachten`
 *      sagt `ja`) und das Video war schon einmal im Bild. Dann zeigen Chrome
 *      und Safari ihren eigenen Knopf, und der muss funktionieren. „Im Bild",
 *      damit ein langer Chat nicht für jedes Video auf einmal eine Karte holt
 *      (siehe `FernsehKnopf`).
 *   2. **Jemand öffnet „Auf den Fernseher" für dieses Video** – das Blatt
 *      bereitet vor, während es aufgeht.
 *
 * Der Preis ist ehrlich zu nennen: Wo ein Fernseher in Reichweite ist, steht
 * in jeder Videoblase eine Adresse, die ohne Anmeldung eine Datei öffnet.
 * Sie gilt nur für DIESE Datei und DIESE Person, sie läuft nach sechs Stunden
 * ab (vorher tauscht `FernsehKnopf` sie zurück), und der Server prüft beim
 * Abholen weiterhin, ob die Person die Datei noch sehen darf. Wer die Adresse
 * aus der Seite kopiert – „Videoadresse kopieren" im Kontextmenü –, kann sie
 * sechs Stunden lang weitergeben. Das ist dieselbe Adresse, die ein
 * Chromecast ohnehin bekommen hätte; sie steht nur früher da. Ohne Fernseher
 * in Reichweite und ohne Tipp auf „Auf den Fernseher" bleibt alles, wie es
 * war: keine Karte im Dokument.
 */

import { api } from '../../lib/api.js';

/** Die WebKit-Zusätze, die in `lib.dom` fehlen. */
interface WebkitVideo extends HTMLVideoElement {
  webkitShowPlaybackTargetPicker?: () => void;
  webkitCurrentPlaybackTargetIsWireless?: boolean;
}

/** Ab diesem `readyState` stehen die Kopfdaten (Dauer, Grösse) fest. */
const HAVE_METADATA = 1;

/** Welcher der beiden Wege an diesem Gerät zur Verfügung steht. */
export type Weg = 'remote' | 'airplay' | null;

/**
 * Der Weg, den dieses Element gehen kann.
 *
 * Reihenfolge mit Absicht: Wo es beide gibt (Safari), ist die Remote Playback
 * API die bessere Wahl, weil sie den Zustand meldet (verbunden, getrennt) und
 * der alte AirPlay-Wähler nur eine Liste öffnet.
 */
export function wegFuer(video: HTMLVideoElement | null | undefined): Weg {
  if (!video) return null;
  if (typeof (video as WebkitVideo).remote?.prompt === 'function') return 'remote';
  if (typeof (video as WebkitVideo).webkitShowPlaybackTargetPicker === 'function') return 'airplay';
  return null;
}

/** Ob dieses Element aus WebKit stammt (Safari, jeder Browser auf dem iPhone). */
function istWebkit(video: HTMLVideoElement): boolean {
  return typeof (video as WebkitVideo).webkitShowPlaybackTargetPicker === 'function';
}

/**
 * Was der Browser über Fernseher in Reichweite weiss.
 *
 * `unbekannt` ist ein eigener Fall und kein `nein`: Manche Browser setzen die
 * Beobachtung nicht um (Chrome auf schwachen Android-Geräten wirft dann
 * `NotSupportedError`), obwohl `prompt()` daneben tadellos arbeitet.
 */
export type Verfuegbarkeit = 'ja' | 'nein' | 'unbekannt';

/**
 * Ist überhaupt ein Gerät in Reichweite?
 *
 * Meldet `nein`, bis der Browser etwas gefunden hat, und ruft danach erneut.
 * Der Rückgabewert hängt die Überwachung wieder ab.
 *
 * # Der Sonderfall, der hier wichtig ist
 *
 * `watchAvailability` ist an einigen Stellen nicht umgesetzt und wirft dann
 * `NotSupportedError` – obwohl `prompt()` daneben tadellos arbeitet. Das
 * heisst `unbekannt`, nicht `nein`: Der Knopf bleibt, aber die Karte wird
 * nicht vorsorglich eingesetzt (sonst bekäme jede Videoblase auf jedem
 * solchen Gerät eine, auch ganz ohne Fernseher).
 *
 * # Und die 15 Sekunden
 *
 * Chrome beobachtet bei Videos bis 15 Sekunden gar nicht erst – „zu kurz, um
 * gestreamt zu werden". Hier kommt dann dauerhaft `nein`. Das Blatt „Auf den
 * Fernseher" sagt es dazu (`kurzFuerChrome`).
 */
export function geraeteBeobachten(
  video: HTMLVideoElement,
  melden: (da: Verfuegbarkeit) => void,
): () => void {
  const weg = wegFuer(video);
  if (weg === null) {
    melden('nein');
    return () => undefined;
  }

  if (weg === 'airplay') {
    const beiAenderung = (ereignis: Event) => {
      const wert = (ereignis as Event & { availability?: string }).availability;
      melden(wert === 'available' ? 'ja' : 'nein');
    };
    video.addEventListener('webkitplaybacktargetavailabilitychanged', beiAenderung);
    return () => video.removeEventListener('webkitplaybacktargetavailabilitychanged', beiAenderung);
  }

  let gilt = true;
  let nummer: number | null = null;
  video.remote
    .watchAvailability((da) => {
      if (gilt) melden(da ? 'ja' : 'nein');
    })
    .then((id) => {
      if (gilt) nummer = id;
      else void video.remote.cancelWatchAvailability(id).catch(() => undefined);
    })
    .catch(() => {
      // Siehe oben: nicht umgesetzt heisst nicht „kein Gerät".
      if (gilt) melden('unbekannt');
    });

  return () => {
    gilt = false;
    if (nummer !== null) void video.remote.cancelWatchAvailability(nummer).catch(() => undefined);
  };
}

/**
 * Verbunden oder nicht – über beide Wege, die WebKit und Chrome melden.
 *
 * Safari meldet eine AirPlay-Verbindung, die über SEINEN eingebauten Knopf
 * zustande kam, nur über das alte WebKit-Ereignis; eine über `prompt()` über
 * `remote`. Beide zu hören kostet nichts und lässt keinen Fall aus.
 */
export function verbindungBeobachten(
  video: HTMLVideoElement,
  melden: (verbunden: boolean) => void,
): () => void {
  const abmelden: Array<() => void> = [];
  const remote = (video as WebkitVideo).remote;
  if (remote && typeof remote.addEventListener === 'function') {
    const an = () => melden(true);
    const aus = () => melden(false);
    remote.addEventListener('connect', an);
    remote.addEventListener('disconnect', aus);
    abmelden.push(() => {
      remote.removeEventListener('connect', an);
      remote.removeEventListener('disconnect', aus);
    });
    if (remote.state === 'connected') melden(true);
  }
  if ('webkitCurrentPlaybackTargetIsWireless' in video) {
    const wechsel = () =>
      melden(Boolean((video as WebkitVideo).webkitCurrentPlaybackTargetIsWireless));
    video.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', wechsel);
    abmelden.push(() =>
      video.removeEventListener('webkitcurrentplaybacktargetiswirelesschanged', wechsel),
    );
  }
  return () => abmelden.forEach((ab) => ab());
}

/**
 * Wie lange eine vorbereitete Karte im Telefon stehen bleibt.
 *
 * Fünf Stunden, eine weniger als die Karte gilt. Danach nimmt `FernsehKnopf`
 * sie wieder heraus – sonst liefe im Chat eine Adresse, deren Karte gleich
 * abläuft, und das Video wäre beim nächsten Abspielen kaputt.
 */
export const KARTE_IM_TELEFON_MS = 5 * 60 * 60 * 1000;

interface Vorbereitung {
  /** Die Adresse ohne Karte – so, wie sie vorher im Element stand. */
  alteQuelle: string;
  /** Die Adresse mit Karte, sobald sie eingesetzt ist. */
  kartenQuelle: string | null;
  /**
   * Wann die Karte eingesetzt wurde – `null`, solange sie noch unterwegs ist.
   *
   * Steht HIER und nicht beim Knopf, der sie bestellt hat. Das Blatt „Auf den
   * Fernseher" bestellt sie auch, und wurde es geschlossen, bevor die Karte
   * kam, erfuhr der Knopf nie davon: Die Karte stand im Element, aber keine
   * Uhr nahm sie nach fünf Stunden wieder heraus. Jetzt fragt der Knopf hier
   * nach (`vorbereitetSeit`) und hört auf `KARTE_GEWECHSELT`.
   */
  eingesetztUm: number | null;
  versprechen: Promise<void>;
}

/**
 * Dieses Ereignis feuert am Element, wenn eine Karte eingesetzt oder
 * herausgenommen wurde – egal, wer sie bestellt hat.
 */
export const KARTE_GEWECHSELT = 'fernsehkarte';

function wechselMelden(video: HTMLVideoElement): void {
  if (typeof video.dispatchEvent === 'function') video.dispatchEvent(new Event(KARTE_GEWECHSELT));
}

/**
 * Gehört dieser Eintrag noch zu dem, was im Element steht?
 *
 * Nicht mehr, sobald das Element eine andere Adresse bekommen hat – im
 * Dateibetrachter etwa, wo „Weiter ›" dasselbe `<video>` behalten und nur
 * seine Adresse tauschen kann. Der Eintrag von Datei A blieb dann an dem
 * Element hängen, das inzwischen Datei B zeigte: B bekam keine Karte, und
 * ein späteres Zurücktauschen setzte A wieder ein – der Betrachter hiess
 * „b-video.webm" und spielte A.
 */
function giltNoch(eintrag: Vorbereitung, video: HTMLVideoElement): boolean {
  return eintrag.kartenQuelle === null
    ? adresse(video) === eintrag.alteQuelle
    : video.src === eintrag.kartenQuelle;
}

/**
 * Was das Element gerade zeigen soll. `src` vor `currentSrc`, weil `src` das
 * ist, was die Blase gesetzt hat – `currentSrc` hinkt nach einem Wechsel
 * hinterher, bis der Browser lädt.
 */
function adresse(video: HTMLVideoElement): string {
  return video.src || video.currentSrc;
}

/*
 * Je Element höchstens eine Vorbereitung – der Knopf an der Blase und das
 * Blatt „Auf den Fernseher" teilen sie sich. Eine `WeakMap`, damit ein
 * Element, das mit seiner Chatblase verschwindet, nichts festhält.
 */
const vorbereitungen = new WeakMap<HTMLVideoElement, Vorbereitung>();

/**
 * Die Karte holen und die Adresse im Element tauschen – vor jedem Tipp.
 *
 * Mehrfach aufrufbar: Wer schon eine hat, bekommt dasselbe Versprechen.
 */
export function karteEinsetzen(video: HTMLVideoElement, attachmentId: string): Promise<void> {
  const da = vorbereitungen.get(video);
  if (da && giltNoch(da, video)) return da.versprechen;

  /*
   * Die alte Adresse kommt IMMER aus dem Element, nie aus einem vorigen
   * Eintrag: Der kann zu einer anderen Datei gehören (siehe `giltNoch`).
   */
  const eintrag: Vorbereitung = {
    alteQuelle: adresse(video),
    kartenQuelle: null,
    eingesetztUm: null,
    versprechen: Promise.resolve(),
  };
  eintrag.versprechen = api.media.fernsehticket(attachmentId).then((karte) => {
    // Überholt – jemand hat inzwischen zurückgetauscht oder neu angefangen.
    if (vorbereitungen.get(video) !== eintrag) return;
    // Das Element zeigt inzwischen eine andere Datei – die Karte gehört nicht mehr dazu.
    if (adresse(video) !== eintrag.alteQuelle) {
      vorbereitungen.delete(video);
      return;
    }
    quelleTauschen(video, karte.url);
    eintrag.kartenQuelle = video.src;
    eintrag.eingesetztUm = Date.now();
    wechselMelden(video);
  });
  eintrag.versprechen.catch(() => {
    if (vorbereitungen.get(video) === eintrag) vorbereitungen.delete(video);
  });
  vorbereitungen.set(video, eintrag);
  return eintrag.versprechen;
}

/** Steht die Adresse mit Karte gerade im Element? */
export function istVorbereitet(video: HTMLVideoElement | null | undefined): boolean {
  if (!video) return false;
  const eintrag = vorbereitungen.get(video);
  return Boolean(eintrag?.kartenQuelle && video.src === eintrag.kartenQuelle);
}

/** Seit wann die Karte im Element steht – `null`, wenn keine drin ist. */
export function vorbereitetSeit(video: HTMLVideoElement | null | undefined): number | null {
  if (!video || !istVorbereitet(video)) return null;
  return vorbereitungen.get(video)?.eingesetztUm ?? null;
}

/** Die alte Adresse zurück – ohne Karte, wie vor dem Vorbereiten. */
export function karteEntfernen(video: HTMLVideoElement): void {
  const eintrag = vorbereitungen.get(video);
  if (!eintrag) return;
  vorbereitungen.delete(video);
  if (eintrag.kartenQuelle && video.src === eintrag.kartenQuelle && eintrag.alteQuelle) {
    quelleTauschen(video, eintrag.alteQuelle);
    wechselMelden(video);
  }
}

/**
 * Die Adresse tauschen, ohne dass jemand es merkt.
 *
 * Ein Tausch setzt das Element zurück: Stelle null, angehalten, kein Bild.
 * Wer bei Minute zwölf zuschaut, während ein Fernseher auftaucht, soll bei
 * Minute zwölf weiterschauen – also Stelle und Abspielen mitnehmen. Und wer
 * noch gar nicht abgespielt hat, soll wieder das scharfe erste Bild sehen
 * statt der unscharfen Vorschau darunter: `standbildHolen` merkt sich im
 * Element, dass es fertig ist, und muss das für die neue Adresse vergessen.
 */
function quelleTauschen(video: HTMLVideoElement, adresse: string): void {
  const stelle = video.currentTime;
  const lief = !video.paused && !video.ended;
  video.src = adresse;
  if (!(stelle > 0) && !lief) {
    delete video.dataset.standbild;
    return;
  }
  video.addEventListener(
    'loadedmetadata',
    () => {
      try {
        if (stelle > 0) video.currentTime = stelle;
      } catch {
        /* Dann eben von vorn. */
      }
      if (lief) void video.play().catch(() => undefined);
    },
    { once: true },
  );
}

/**
 * Die Geräteliste öffnen – AUSSCHLIESSLICH synchron aus einem Klick heraus.
 *
 * Kein `await` davor, nichts Asynchrones: Der Aufruf muss im selben Takt wie
 * der Finger geschehen, sonst gilt die Aktivierung nicht mehr (siehe Kopf
 * dieser Datei). Die Karte muss deshalb vorher eingesetzt sein.
 *
 * Zwei Fälle werden VOR dem Aufruf abgefangen, weil sie sonst still scheitern:
 *
 *   * **WebKit ohne Kopfdaten.** Safaris `prompt()` lehnt dann mit
 *     `NotSupportedError` ab, was vorher als „Dieser Browser kann nicht
 *     streamen" erschien – falsch. Der alte AirPlay-Wähler braucht keine
 *     Kopfdaten, also springt er hier ein.
 *   * **Chrome ohne Kopfdaten.** Die Geräteliste ist dann leer, und
 *     `prompt()` bricht mit „The prompt was dismissed." ab – als hätte jemand
 *     die Liste geschlossen. Dann lieber ehrlich: Das Video lädt noch.
 */
export function geraeteWaehlen(video: HTMLVideoElement): Promise<void> {
  const weg = wegFuer(video);
  if (weg === null) return Promise.reject(fehlerNamens('NotSupportedError'));
  if (istWebkit(video) && (weg === 'airplay' || video.readyState < HAVE_METADATA)) {
    (video as WebkitVideo).webkitShowPlaybackTargetPicker?.();
    return Promise.resolve();
  }
  if (video.readyState < HAVE_METADATA) return Promise.reject(fehlerNamens('NochNichtBereit'));
  return video.remote.prompt();
}

function fehlerNamens(name: string): Error {
  return Object.assign(new Error(''), { name });
}

/**
 * Unter dieser Zeit ist eine abgelehnte Geräteliste kein Mensch gewesen.
 *
 * Chrome meldet „Liste geschlossen" und „gar keine Liste gezeigt" mit
 * demselben Fehler (`NotAllowedError`, „The prompt was dismissed."). Einen
 * Unterschied gibt es trotzdem: Niemand schliesst eine Liste in einer
 * Viertelsekunde, die er gerade erst gesehen hat. Was so schnell
 * zurückkommt, hat der Browser selbst abgebrochen – kein Gerät in der
 * Liste, ein zu kurzes Video. Das verdient einen Satz statt Stille.
 */
export const STILLER_ABBRUCH_MS = 400;

/** Was nach einem Tipp zu sagen ist – und ob die anderen Wege gezeigt werden sollen. */
export interface StreamAuskunft {
  /** Leer heisst: nichts sagen – etwa, weil jemand die Liste geschlossen hat. */
  text: string;
  /** Soll das Blatt mit Code-Weg und Spiegelung aufgehen? */
  andereWege: boolean;
}

/** Was beim Streamen schiefgehen kann, in Worten statt in Fehlernamen. */
export function streamFehler(fehler: unknown, dauerMs = Number.POSITIVE_INFINITY): StreamAuskunft {
  const name = fehler instanceof Error ? fehler.name : '';
  switch (name) {
    case 'NotFoundError':
      return {
        text: 'Kein Fernseher gefunden. Er muss eingeschaltet und im selben WLAN sein – und Google Cast oder AirPlay verstehen.',
        andereWege: true,
      };
    case 'NotAllowedError':
      if (dauerMs < STILLER_ABBRUCH_MS) {
        return {
          text: 'Der Browser hat keinen Fernseher angeboten.',
          andereWege: true,
        };
      }
      // Die Geräteliste wurde geschlossen – eine Entscheidung, kein Fehler.
      return { text: '', andereWege: false };
    case 'InvalidAccessError':
      /*
       * Der Fingertipp kam beim Browser nicht als solcher an. Seit die Liste
       * synchron im Klick aufgeht, sollte das nicht mehr vorkommen – falls
       * doch, hilft ein zweiter Tipp, und der rohe Fehlertext hülfe nicht.
       */
      return {
        text: 'Der Browser hat den Tipp nicht angenommen. Bitte noch einmal auf 📺 tippen.',
        andereWege: false,
      };
    case 'InvalidStateError':
      return { text: 'Die Verbindung wird gerade schon aufgebaut.', andereWege: false };
    case 'NochNichtBereit':
      return {
        text: 'Das Video lädt noch – gleich noch einmal tippen.',
        andereWege: false,
      };
    case 'NotSupportedError':
      return {
        text: 'Dieses Video lässt sich von hier aus nicht direkt streamen.',
        andereWege: true,
      };
    default:
      return {
        text:
          fehler instanceof Error && fehler.message
            ? fehler.message
            : 'Das Streamen hat nicht geklappt.',
        andereWege: true,
      };
  }
}

/**
 * Bietet Chrome dieses Video überhaupt zum Streamen an?
 *
 * Nein, wenn es 15 Sekunden oder kürzer ist: Chromium schaltet die Suche nach
 * Geräten dann ab („zu kurz, um gestreamt zu werden"), und das eigene
 * Cast-Symbol in der Videosteuerung fehlt ebenso. Viele Chat-Videos sind so
 * kurz. Safari kennt diese Grenze nicht.
 */
export function kurzFuerChrome(dauerSekunden: number, webkit: boolean): boolean {
  return !webkit && Number.isFinite(dauerSekunden) && dauerSekunden > 0 && dauerSekunden <= 15;
}

/** Dasselbe für ein Element – mit der Dauer aus den Kopfdaten oder aus dem Anhang. */
export function kurzesVideoInChrome(
  video: HTMLVideoElement | null,
  dauerMsAusAnhang: number | null | undefined,
): boolean {
  if (!video) return false;
  const aus = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : NaN;
  const dauer = Number.isNaN(aus) ? (dauerMsAusAnhang ?? 0) / 1000 : aus;
  return kurzFuerChrome(dauer, istWebkit(video));
}
