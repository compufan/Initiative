/**
 * Die Entscheidungen des Fernsehblatts – ohne DOM, damit sie sich prüfen lassen.
 *
 * # Warum das aus `tv.ts` herausgezogen ist
 *
 * `tv.ts` ist ein Skript mit Wirkung beim Laden: Es sucht Elemente, meldet
 * sich beim Server an und startet einen Takt. In einer Prüfung ohne Browser
 * lässt es sich nicht einmal importieren. Die Fragen, an denen die Fehler
 * dieses Blatts hingen – „muss die Liste neu geholt werden?", „ist das noch
 * dasselbe Stück?", „welche Taste war das?" –, sind aber reine Rechnungen.
 * Hier stehen sie für sich und haben ihre Prüfung in `ablauf.test.ts`.
 *
 * # Warum hier nichts Neueres als 2017 steht
 *
 * Der Bau senkt das Fernsehblatt ohnehin auf Chromium 63 ab
 * (`scripts/fernsehblatt.ts`). Aber was eine Bibliothek des Browsers ist und
 * keine Schreibweise – `replaceChildren`, `Promise.finally` –, kann der Bau
 * nicht nachrüsten. Deshalb benutzt diese Datei nur, was ein Fernseher von
 * 2019 kennt.
 */

/**
 * Nach wie vielen Millisekunden das Blatt die Liste von sich aus neu holt.
 *
 * Eine Karte gilt sechs Stunden (`auth::fernsehticket`). Das Blatt holte die
 * Liste aber nur, wenn jemand am Telefon etwas änderte – eine Diashow, die
 * niemand anfasst, lief nach sechs Stunden in lauter 401. Fünf Stunden lassen
 * eine Stunde Luft für das Video, das gerade noch mit der alten Karte läuft.
 */
export const KARTEN_ERNEUERN_MS = 5 * 60 * 60 * 1000;

/** Sind die Karten der geholten Liste so alt, dass sie erneuert werden müssen? */
export function kartenAlt(geholtUm: number, jetzt: number): boolean {
  return jetzt - geholtUm >= KARTEN_ERNEUERN_MS;
}

/** Was vom Stand hier gebraucht wird – so, wie er vom Server kommt. */
export interface StandAuskunft {
  art?: unknown;
  saat?: unknown;
  modus?: unknown;
  stueckzahl?: unknown;
}

/** Was vom laufenden Programm hier gebraucht wird. */
export interface ProgrammKopf {
  saat: number;
  modus: string;
  stueckzahl: number;
}

/**
 * Muss die Liste neu geholt werden – oder genügt, was im Stand steht?
 *
 * # Warum das die Frage ist, an der „Pause startet von vorn" hing
 *
 * Jeder Griff an die Fernbedienung erhöht die Fassung. Das Blatt holte dann
 * die ganze Liste neu – mit frischen Karten, also mit NEUEN Adressen für jedes
 * Stück – und spielte das aktuelle Stück ab. Bei einem Video heisst eine neue
 * Adresse: Es lädt neu und beginnt bei null. Pause zeigte das Video wieder am
 * Anfang, „Weiter" spielte es von vorn.
 *
 * Neu geholt wird jetzt nur, wenn sich die LISTE geändert haben kann: andere
 * Saat (jedes Einstellen und jeder Wechsel auf „Gemischt" würfelt neu),
 * anderer Modus, andere Stückzahl – oder die Karten werden alt. Ein Stand
 * ohne Saat kommt von einem älteren Server; dann wird wie früher geholt.
 */
export function listeNeuHolen(
  stand: StandAuskunft,
  programm: ProgrammKopf | null,
  geholtUm: number,
  jetzt: number,
): boolean {
  if (!programm) return true;
  if (kartenAlt(geholtUm, jetzt)) return true;
  if (stand.art !== undefined && stand.art !== 'diashow') return true;
  if (typeof stand.saat !== 'number') return true;
  return (
    stand.saat !== programm.saat ||
    stand.modus !== programm.modus ||
    stand.stueckzahl !== programm.stueckzahl
  );
}

/** Eine Stelle im Kreis – auch rückwärts über den Anfang hinaus. */
export function imKreis(stelle: number, anzahl: number): number {
  if (!(anzahl > 0)) return 0;
  return ((stelle % anzahl) + anzahl) % anzahl;
}

/**
 * Was eine Taste der Fernbedienung bedeutet – oder `null`.
 *
 * `ok` schaltet um (Ton, dann Pause/Weiter). `abspielen` und `anhalten` tun
 * genau das, was draufsteht – siehe `tasteDeuten`.
 */
export type TastenSinn = 'weiter' | 'zurueck' | 'ok' | 'abspielen' | 'anhalten';

/**
 * Eine Taste deuten – über `key` und, wo der fehlt, über `keyCode`.
 *
 * # Warum beides
 *
 * Neuere Browser melden `key` („ArrowRight", „Enter"). Ältere Fernseher
 * melden bei manchen Tasten nur „Unidentified" und den alten Zahlencode. Die
 * OK-Taste ist fast überall 13, wie Enter; die Pfeile 37 und 39. 10252 ist
 * „Abspielen/Pause" auf Samsung-Geräten, 415 und 19 sind Abspielen und Pause
 * einzeln (LG und viele andere).
 *
 * # Warum Abspielen und Pause NICHT umschalten
 *
 * Hier wurden 415 und 19 als `ok` gedeutet, also als Umschalter. Wer bei
 * laufender Diashow „Abspielen" drückte, hielt sie damit an; „Pause" bei
 * angehaltener Schau setzte sie fort; und bei einem stummen Video schaltete
 * „Pause" den Ton ein, statt anzuhalten. Eine Taste, die das Gegenteil ihrer
 * Beschriftung tut, ist schlimmer als eine, die nichts tut. Umschalten dürfen
 * nur die Tasten, die dafür gebaut sind: OK, Enter, Leertaste und die
 * kombinierte Abspielen/Pause-Taste.
 */
export function tasteDeuten(
  key: string | undefined,
  keyCode: number | undefined,
): TastenSinn | null {
  switch (key) {
    case 'ArrowRight':
    case 'MediaTrackNext':
      return 'weiter';
    case 'ArrowLeft':
    case 'MediaTrackPrevious':
      return 'zurueck';
    case ' ':
    case 'Enter':
    case 'MediaPlayPause':
      return 'ok';
    case 'MediaPlay':
      return 'abspielen';
    case 'MediaPause':
    case 'Pause':
      return 'anhalten';
    default:
      break;
  }
  switch (keyCode) {
    case 39:
    case 10233:
      return 'weiter';
    case 37:
    case 10232:
      return 'zurueck';
    case 13:
    case 32:
    case 10252:
      return 'ok';
    case 415:
      return 'abspielen';
    case 19:
      return 'anhalten';
    default:
      return null;
  }
}

/**
 * Was ein Tipp auf den Schirm bedeutet – nach der Stelle, an der er landet.
 *
 * # Warum es das auf einem Fernseher überhaupt braucht
 *
 * Das Blatt hörte nur auf Tasten. „Der Fernseher" ist aber oft keiner: ein
 * Tablet, ein zweites Telefon, ein Rechner mit Maus – und auch am Fernseher
 * kommt OK im Zeigermodus (LG Magic Remote, der Mauszeiger im Samsung-
 * Browser) als Klick an, nicht als Enter. Dort blieben Videos für immer
 * stumm, und „OK drücken für Ton" liess sich nicht befolgen. Ein Tipp ist
 * eine Nutzeraktivierung wie ein Tastendruck; er darf also dasselbe.
 *
 * # Warum die Ränder blättern
 *
 * Wer keine Pfeiltasten hat, hat sonst keinen Weg zum nächsten Bild. Das
 * äussere Viertel links und rechts blättert – so, wie Bildbetrachter es
 * gewohnt sind –, die breite Mitte ist OK. Die Mitte breit, weil ein Tipp
 * auf „Ton" oder „Pause" der häufigere ist und ein versehentliches
 * Weiterblättern mehr stört als ein versehentliches Anhalten.
 */
export function tippDeuten(x: number, breite: number): TastenSinn {
  if (!(breite > 0)) return 'ok';
  if (x < breite * 0.25) return 'zurueck';
  if (x > breite * 0.75) return 'weiter';
  return 'ok';
}

/** Was das Blatt daraufhin tut. */
export type Handlung = 'weiter' | 'zurueck' | 'ton' | 'anhalten' | 'fortsetzen';

/**
 * Aus Taste (oder Tipp) und Lage wird eine Handlung.
 *
 * `videoStumm` heisst: Ein Video steht im Bild, es läuft (oder liefe) stumm,
 * und es ist nicht kaputt. Dann gehört der erste OK dem Ton, nicht der Pause
 * – wer ein stummes Video sieht und OK drückt, will den Ton. Bei einem Video,
 * das sich gar nicht abspielen lässt, stünde „OK für Ton" dagegen für nichts;
 * dort hält OK an wie bei einem Bild.
 */
export function handlungFuer(
  sinn: TastenSinn | null,
  lage: { videoStumm: boolean; pausiert: boolean },
): Handlung | null {
  switch (sinn) {
    case 'weiter':
      return 'weiter';
    case 'zurueck':
      return 'zurueck';
    case 'ok':
      if (lage.videoStumm) return 'ton';
      return lage.pausiert ? 'fortsetzen' : 'anhalten';
    case 'abspielen':
      return lage.pausiert ? 'fortsetzen' : null;
    case 'anhalten':
      return lage.pausiert ? null : 'anhalten';
    default:
      return null;
  }
}

/**
 * Soll der Fernseher nach einem Tipp gleich noch einen Tastendruck deuten?
 *
 * Nein, wenn beide zu DERSELBEN Betätigung gehören. Ob eine LG Magic Remote
 * im Zeigermodus beim Druck auf OK nur einen Klick schickt oder dazu noch
 * Enter, ist nicht belegt – geprüft ist es an keinem Gerät. Käme beides, fiele
 * OK zweimal: erst Ton an, gleich darauf Pause. Ein Klick innerhalb dieser
 * Spanne nach einer Taste – oder eine Taste nach einem Klick – gilt deshalb als
 * dieselbe Betätigung. Zwei Tipps hintereinander bleiben zwei.
 */
export const DOPPELT_MS = 350;

export function doppelteEingabe(vorigeUm: number, jetzt: number): boolean {
  return jetzt - vorigeUm >= 0 && jetzt - vorigeUm < DOPPELT_MS;
}

/**
 * Wie lange ein Video, das sich nicht abspielen lässt, mit seinem Hinweis
 * stehen bleibt, bevor die Schau weitergeht.
 *
 * Es gab keinen Rückfall: Ein Format, das der Fernseher nicht kann (HEVC aus
 * dem iPhone auf einem älteren Samsung, VP9-WebM auf LG), oder eine
 * abgelaufene Karte hielten die Diashow auf Schwarz an, bis jemand am Telefon
 * „Weiter" drückte. Lang genug, um den Satz zu lesen; kurz genug, dass es
 * nicht wie ein Absturz aussieht.
 */
export const KAPUTT_WEITER_MS = 4000;
