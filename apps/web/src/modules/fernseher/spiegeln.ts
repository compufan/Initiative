/**
 * Das Telefon auf den Fernseher spiegeln – was die App dazu weiss und sagt.
 *
 * # Warum es diesen dritten Weg gibt
 *
 * Die beiden anderen haben Lücken, die sich nicht schliessen lassen:
 *
 *   * **Mit einem Tipp** (Chromecast, AirPlay) geht nur, wo der Fernseher
 *     Google Cast oder AirPlay EMPFANGEN kann und das Telefon den passenden
 *     Browser hat. Ein Android-Telefon an einem älteren Samsung oder LG findet
 *     nichts, ein iPhone an einem Chromecast ebenso wenig.
 *   * **Der Code am Fernseher** braucht einen Browser im Fernseher. Apple TV,
 *     Chromecast, Google TV und Roku haben keinen.
 *
 * Genau diese Geräte erreicht aber die Bildschirmspiegelung des TELEFONS:
 * Smart View (Samsung, Miracast), „Übertragen" und Google Home (Cast),
 * AirPlay-Bildschirmsynchronisierung (iPhone). Die App kann sie weder
 * starten noch erkennen – keine Web-Schnittstelle meldet eine laufende
 * Spiegelung. Was die App kann: eine Ansicht zeigen, die auf dem Fernseher gut
 * aussieht (`Fernsehansicht`), und erklären, wie man die Spiegelung startet.
 * Beides steht hier bzw. in `SpiegelSheet`.
 *
 * # Warum die Anleitung für ALLE Geräte dasteht
 *
 * Die Erkennung ist unsicher: Chrome gibt in der Kennung seit 2023 kein
 * Telefonmodell mehr heraus („Android 14; K"), und wer am Laptop liest, will
 * vielleicht das Telefon daneben einrichten. Die eigene Anleitung steht oben
 * und aufgeklappt, alle anderen darunter.
 */

export type Plattform =
  'samsung' | 'pixel' | 'android' | 'iphone' | 'ipad' | 'mac' | 'windows' | 'andere';

/**
 * Welche Plattform – aus Kennung, Berührungspunkten und (wo vorhanden)
 * dem Modell aus `navigator.userAgentData`.
 *
 * `beruehrungspunkte` braucht es für das iPad: Seit iPadOS 13 gibt es sich
 * als „Macintosh" aus. Ein Mac hat keinen Touchscreen, ein iPad fünf Punkte.
 *
 * `modell` braucht es für Android: Chrome kürzt die Kennung auf „K", das
 * Modell („SM-S911B", „Pixel 8") gibt es nur noch auf Nachfrage über
 * `userAgentData.getHighEntropyValues`.
 */
export function plattformAus(ua: string, beruehrungspunkte = 0, modell = ''): Plattform {
  if (/iPhone|iPod/.test(ua)) return 'iphone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && beruehrungspunkte > 1)) return 'ipad';
  if (/Android/.test(ua)) {
    const alles = `${ua} ${modell}`;
    if (/SamsungBrowser|SM-[A-Z0-9]|Galaxy|Samsung/i.test(alles)) return 'samsung';
    if (/Pixel/.test(alles)) return 'pixel';
    return 'android';
  }
  if (/Windows/.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/.test(ua)) return 'mac';
  return 'andere';
}

/** Die Plattform dieses Geräts – mit dem Modell, wo der Browser es verrät. */
export async function plattformErmitteln(): Promise<Plattform> {
  if (typeof navigator === 'undefined') return 'andere';
  const ua = navigator.userAgent;
  const punkte = navigator.maxTouchPoints || 0;
  const daten = (
    navigator as Navigator & {
      userAgentData?: { getHighEntropyValues?: (h: string[]) => Promise<{ model?: string }> };
    }
  ).userAgentData;
  let modell = '';
  if (daten?.getHighEntropyValues && /Android/.test(ua)) {
    try {
      modell = (await daten.getHighEntropyValues(['model'])).model ?? '';
    } catch {
      /* Dann ohne Modell – die Anleitung für „andere Android" passt auch. */
    }
  }
  return plattformAus(ua, punkte, modell);
}

/** Eine Anleitung für eine Gerätefamilie. */
export interface Anleitung {
  id: 'samsung' | 'android' | 'pixel' | 'iphone' | 'mac' | 'windows';
  titel: string;
  schritte: string[];
  /** Wohin es spiegeln kann – damit niemand an der falschen Stelle sucht. */
  ziele: string;
  hinweis?: string;
}

/**
 * Die Anleitungen – kurz, mit den Namen, die auf dem Gerät wirklich stehen.
 *
 * Die Menünamen unterscheiden sich je Hersteller, und keine Anleitung darf
 * etwas versprechen, das nur für einen gilt. Wo es mehrere Namen gibt, stehen
 * alle da.
 */
export const ANLEITUNGEN: readonly Anleitung[] = [
  {
    id: 'samsung',
    titel: 'Samsung Galaxy – „Smart View"',
    schritte: [
      'Vom oberen Rand zweimal nach unten wischen (Schnelleinstellungen).',
      'Auf „Smart View" tippen. Fehlt die Kachel: über ✎ bzw. „+" hinzufügen.',
      'Den Fernseher wählen und „Jetzt starten" tippen.',
      'Beim ersten Mal am Fernseher mit der Fernbedienung „Zulassen" wählen.',
    ],
    ziele:
      'Samsung-Fernseher, LG, Philips, Fire TV, Roku und andere mit Bildschirmspiegelung (Miracast).',
    hinweis:
      'Schwarze Balken links und rechts? In Smart View unter „Seitenverhältnis des Telefons" „Vollbild auf verbundenem Gerät" wählen.',
  },
  {
    id: 'android',
    titel: 'Andere Android-Telefone – „Übertragen", „Screen Cast", „Bildschirm übertragen"',
    schritte: [
      'Vom oberen Rand zweimal nach unten wischen (Schnelleinstellungen).',
      'Je nach Hersteller heisst die Kachel „Übertragen", „Screen Cast", „Wireless Display", „Smart View" oder „Bildschirm übertragen" – antippen.',
      'Den Fernseher wählen. Er muss eingeschaltet und im selben WLAN sein.',
      'Keine passende Kachel? In der App „Google Home" den Fernseher bzw. Chromecast wählen und „Bildschirm übertragen" tippen (ab Android 8).',
    ],
    ziele:
      'Je nach Telefon Miracast-Fernseher (Samsung, LG, Fire TV, Roku …) oder Chromecast und Google TV.',
    hinweis:
      'Beim Fire TV zuerst am Fernseher „Bildschirmspiegelung aktivieren" wählen (Home-Taste lange drücken › Spiegeln).',
  },
  {
    id: 'pixel',
    titel: 'Google Pixel – „Bildschirm übertragen"',
    schritte: [
      'Vom oberen Rand zweimal nach unten wischen und „Bildschirm übertragen" antippen.',
      'Den Chromecast oder Fernseher mit Google TV wählen.',
      'Wenn gefragt: „Eine App" – diese App – statt des ganzen Bildschirms. Dann bleiben Statusleiste und Mitteilungen auf dem Telefon.',
    ],
    ziele:
      'Nur Chromecast und Fernseher mit Google Cast (Google TV, Android TV, einige Samsung und LG ab 2023/24).',
    hinweis:
      'Ein Pixel kann kein Miracast. An einem Samsung, LG, Fire TV oder Roku ohne Google Cast bleibt der Code am Fernseher.',
  },
  {
    id: 'iphone',
    titel: 'iPhone und iPad – „Bildschirmsynchronisierung"',
    schritte: [
      /*
       * Beide Gesten, weil es beide Geräte gibt: Oben rechts gilt nur für
       * iPhones mit Face ID und für jedes iPad. Auf einem iPhone mit
       * Home-Taste – das SE bekommt weiter aktuelle Systeme – öffnet dieselbe
       * Geste die Mitteilungszentrale, und der Schritt führte ins Leere.
       */
      'Das Kontrollzentrum öffnen: oben rechts nach unten wischen – bei einem iPhone mit Home-Taste vom unteren Rand nach oben.',
      'Auf „Bildschirmsynchronisierung" tippen (zwei übereinanderliegende Rechtecke).',
      'Apple TV oder den Fernseher wählen. Erscheint dort ein Code, ihn auf dem iPhone eingeben.',
      'Die Ausrichtungssperre ausschalten und das Gerät quer halten.',
    ],
    ziele:
      'Apple TV und Fernseher mit AirPlay (viele Samsung, LG, Sony ab 2018, Roku mit AirPlay).',
    hinweis:
      'Mit Fire TV und Chromecast geht es nicht – dort bleibt der Code am Fernseher bzw. nichts.',
  },
  {
    id: 'mac',
    titel: 'Mac – „Bildschirmsynchronisierung"',
    schritte: [
      'Im Kontrollzentrum (oben rechts in der Menüleiste) „Bildschirmsynchronisierung" wählen.',
      'Apple TV oder den AirPlay-Fernseher wählen.',
      'Diese Seite im Vollbild öffnen und „Fernsehansicht starten".',
    ],
    ziele: 'Apple TV und Fernseher mit AirPlay.',
  },
  {
    id: 'windows',
    titel: 'Windows – „Projizieren" (Windows-Taste + K)',
    schritte: [
      'Windows-Taste + K drücken und den Fernseher wählen (Miracast).',
      'Mit Windows-Taste + P „Duplizieren" wählen – oder „Erweitern" und das Fenster mit der Fernsehansicht auf den Fernseher ziehen.',
    ],
    ziele: 'Fernseher und Sticks mit Bildschirmspiegelung (Miracast): Samsung, LG, Fire TV, Roku …',
  },
];

/** Welche Anleitung zu welcher Plattform gehört. */
const ZU_ANLEITUNG: Record<Plattform, Anleitung['id'] | null> = {
  samsung: 'samsung',
  pixel: 'pixel',
  android: 'android',
  iphone: 'iphone',
  ipad: 'iphone',
  mac: 'mac',
  windows: 'windows',
  andere: null,
};

/**
 * Alle Anleitungen, die eigene zuerst.
 *
 * Nie weniger als alle: Die Erkennung kann irren, und ein Irrtum darf keine
 * Anleitung verschwinden lassen – nur ihre Reihenfolge ändern.
 */
export function spiegelAnleitungen(plattform: Plattform): {
  eigene: Anleitung | null;
  andere: Anleitung[];
} {
  const id = ZU_ANLEITUNG[plattform];
  const eigene = ANLEITUNGEN.find((a) => a.id === id) ?? null;
  return { eigene, andere: ANLEITUNGEN.filter((a) => a !== eigene) };
}

/**
 * Was vor dem Spiegeln abzuschalten ist – je Plattform der konkrete Weg.
 *
 * # Warum das eine Pflicht ist und kein Tipp
 *
 * Gespiegelt wird ALLES, was das Telefon zeigt – auch Mitteilungen. Bei einem
 * Messenger heisst das: Vorschauen aus anderen Chats stehen gross im
 * Wohnzimmer. Apple schreibt ausdrücklich, dass Mitteilungen beim
 * Bildschirmsynchronisieren standardmässig ERLAUBT sind; bei Smart View
 * erscheinen sie ebenfalls. Die App kann nur ihre eigenen Hinweise
 * unterdrücken (das tut die Fernsehansicht), nicht die des Telefons.
 */
export function mitteilungenAbschalten(plattform: Plattform): string {
  switch (plattform) {
    case 'iphone':
    case 'ipad':
      return 'Einstellungen › Mitteilungen › Bildschirmfreigabe: „Mitteilungen erlauben" ausschalten (ist sonst an) – oder im Kontrollzentrum „Nicht stören" einschalten.';
    case 'mac':
      return 'Im Kontrollzentrum „Nicht stören" einschalten.';
    case 'pixel':
      return '„Eine App" übertragen statt des ganzen Bildschirms – oder in den Schnelleinstellungen „Bitte nicht stören" einschalten.';
    case 'windows':
      return 'Im Info-Center „Nicht stören" einschalten.';
    default:
      return 'In den Schnelleinstellungen „Nicht stören" bzw. „Bitte nicht stören" einschalten.';
  }
}
