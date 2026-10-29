/**
 * Links in Karten-Apps – ohne Schlüssel, ohne Kosten, ohne eigene Karte.
 *
 * # Warum es das so gibt
 *
 * Ein Ort im Termin soll sich in der Karten-App öffnen, die DER JEWEILIGE
 * Eingeladene benutzt. Dafür braucht es keine Geokodierung und keine
 * Kacheln von einem fremden Server: Jede dieser Apps nimmt eine Adresse als
 * Text in einem Link entgegen und sucht sie selbst. Wir bauen nur den Link.
 *
 * Nichts davon läuft vor dem Tippen. Es entsteht ein String; erst wenn jemand
 * ihn antippt, geht die Adresse an die gewählte App – und nur dann.
 *
 * # Was hier die Sicherheit trägt
 *
 * Alles Veränderliche geht über EINE Funktion in eine Adresse: `kodiere`.
 * Hosts, Pfade und Parameternamen sind Konstanten, Koordinaten sind geprüfte
 * Zahlen. Eingabe wie `javascript:`, `"><script>`, `%00`, `&api=2` oder
 * `~adr.` bleibt dadurch Text in genau einem Parameterwert und wird nie zu
 * einem weiteren Parameter, einem Fragment oder einem Wegpunkt.
 *
 * Die Formen der Adressen stehen ausschliesslich hier, mit je einem Test mit
 * festem Wert. Drittanbieter ändern ihre Links ab und zu; dann ist es EINE
 * Stelle und ein roter Test, nicht eine Suche durch die Oberfläche.
 */

export type KartenAppKey = 'system' | 'apple' | 'google' | 'osm' | 'waze' | 'bing';
export type Plattform = 'ios' | 'android' | 'mac' | 'andere';
export type Modus = 'karte' | 'route';
/** Was an die Karten-App geht: ein Suchtext oder ein Punkt. */
export type Ziel = { art: 'text'; text: string } | { art: 'punkt'; breite: number; laenge: number };

export interface KartenApp {
  key: KartenAppKey;
  name: string;
  /** Eine Zeile unter dem Namen im Auswahlblatt – ehrlich über das, was passiert. */
  hinweis: string;
  plattformen: Plattform[];
  /**
   * Für `target="_blank"`: nur die https-Formen. `geo:` ist ein Schema, das
   * das Betriebssystem an eine App übergibt; ein leeres Fenster daneben
   * bliebe offen stehen.
   */
  imBrowser: boolean;
}

const ALLE_PLATTFORMEN: Plattform[] = ['ios', 'android', 'mac', 'andere'];

/*
 * Keine weiteren Apps, mit Absicht: HERE WeGo hat keinen belegten Text-Link,
 * und die eigenen Schemata von Organic Maps oder Magic Earth sind je Gerät
 * unzuverlässig (auf iOS ohne installierte App ein Fehler). Auf Android
 * erscheinen sie in der Auswahl der Standard-Karten-App, das genügt. Logos
 * gibt es ebenfalls nicht: Markenzeichen, und der Name genügt.
 */
export const KARTEN_APPS: readonly KartenApp[] = [
  {
    key: 'system',
    name: 'Standard-Karten-App',
    hinweis: 'Öffnet die Karten-App deines Geräts, bei mehreren fragt Android nach',
    plattformen: ['android'],
    imBrowser: false,
  },
  {
    key: 'apple',
    name: 'Apple Karten',
    hinweis: 'Öffnet Karten',
    // Auf Android oder Linux ist die Webkarte von Apple je nach Browser
    // lückenhaft – dort wird sie gar nicht erst angeboten.
    plattformen: ['ios', 'mac'],
    imBrowser: true,
  },
  {
    key: 'google',
    name: 'Google Maps',
    hinweis: 'Öffnet die App, falls vorhanden, sonst den Browser',
    plattformen: ALLE_PLATTFORMEN,
    imBrowser: true,
  },
  {
    key: 'osm',
    name: 'OpenStreetMap',
    hinweis: 'Im Browser, ohne Konto',
    plattformen: ALLE_PLATTFORMEN,
    imBrowser: true,
  },
  {
    key: 'waze',
    name: 'Waze',
    hinweis: 'Öffnet die App, falls vorhanden, sonst den Browser. „Route“ startet die Zielführung',
    plattformen: ALLE_PLATTFORMEN,
    imBrowser: true,
  },
  {
    key: 'bing',
    name: 'Bing Karten',
    hinweis: 'Im Browser',
    plattformen: ALLE_PLATTFORMEN,
    imBrowser: true,
  },
];

/** Die Reihenfolge im Blatt: zuerst, was auf diesem Gerät am nächsten liegt. */
const REIHENFOLGE: Record<Plattform, KartenAppKey[]> = {
  android: ['system', 'google', 'osm', 'waze', 'bing'],
  ios: ['apple', 'google', 'waze', 'osm', 'bing'],
  mac: ['apple', 'google', 'osm', 'waze', 'bing'],
  andere: ['google', 'osm', 'bing', 'waze'],
};

/* ---------- Kodierung ---------- */

/*
 * Steuer- und Richtungszeichen: C0 (ohne Tabulator und Zeilenumbrüche, die
 * unten zu Leerzeichen werden), C1, Nullbreiten-Zeichen und
 * Links-nach-rechts-/Rechts-nach-links-Markierungen samt Überschreibungen und
 * Isolierungen, dazu das Byte-Order-Mark.
 *
 * Sie sind im Suchtext nie gewollt. Die Richtungszeichen können aber dem
 * Betrachter im Blatt eine andere Reihenfolge vorspiegeln, als an die App
 * geht – deshalb raus, bevor irgendetwas angezeigt oder kodiert wird.
 */
const STEUERZEICHEN = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g;

/**
 * Surrogatpaare bleiben, einzelne Hälften nicht: Ein verwaistes Surrogat (ein
 * abgeschnittenes Emoji) lässt `encodeURIComponent` mit einem `URIError`
 * abstürzen. Ohne Rückwärtssuche geschrieben – dieses Modul wird beim Start
 * der App geladen, und ein Syntaxfehler dort träfe die ganze Seite.
 */
const SURROGATE = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g;

/** So viel Text geht höchstens an eine Karten-App (Google Maps: 2048 Zeichen je Adresse). */
export const MAX_ZIELTEXT = 300;

/** Der Text, wie er angezeigt, kopiert und kodiert wird. */
export function bereinige(text: string): string {
  const sauber = String(text)
    .replace(STEUERZEICHEN, '')
    .replace(SURROGATE, (zeichen) => (zeichen.length === 2 ? zeichen : '�'))
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(sauber).slice(0, MAX_ZIELTEXT).join('').trim();
}

/**
 * `encodeURIComponent` PLUS die Zeichen, die es durchlässt und die in
 * Karten-Links etwas bedeuten: `!` `'` `(` `)` `*` und vor allem `~`, das bei
 * Bing Wegpunkte trennt. Sonst liesse sich über einen Ort mit `~adr.` ein
 * zweiter Wegpunkt einschleusen.
 */
export function kodiere(text: string): string {
  return encodeURIComponent(bereinige(text)).replace(
    /[!'()*~]/g,
    (zeichen) => `%${zeichen.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/* ---------- Koordinaten ---------- */

export function punktGueltig(breite: number, laenge: number): boolean {
  return (
    Number.isFinite(breite) &&
    Number.isFinite(laenge) &&
    Math.abs(breite) <= 90 &&
    Math.abs(laenge) <= 180
  );
}

/** Mit Punkt, höchstens sechs Nachkommastellen (gut zehn Zentimeter), nie landesabhängig. */
function zahl(wert: number): string {
  return String(Number(wert.toFixed(6)));
}

function punktPaar(breite: number, laenge: number): string {
  if (!punktGueltig(breite, laenge)) {
    throw new RangeError('Koordinate ausserhalb des gültigen Bereichs');
  }
  return `${zahl(breite)},${zahl(laenge)}`;
}

/** Was im Blatt steht und beim „Adresse kopieren“ in die Zwischenablage geht. */
export function zielText(ziel: Ziel): string {
  if (ziel.art === 'text') return bereinige(ziel.text);
  return punktPaar(ziel.breite, ziel.laenge).replace(',', ', ');
}

/* ---------- Adressen der Apps ---------- */

/*
 * Rückfall für Apple Karten in einer iOS-Startbildschirm-App: Kommt die
 * Übergabe an die App dort nicht an, ist `maps://` die Form, die sie sicher
 * trifft. Eine Konstante, damit der Wechsel eine Zeile ist.
 */
const APPLE = 'https://maps.apple.com/';
const GOOGLE_SUCHE = 'https://www.google.com/maps/search/?api=1&query=';
const GOOGLE_ROUTE = 'https://www.google.com/maps/dir/?api=1&destination=';
const OSM = 'https://www.openstreetmap.org/';
const WAZE = 'https://waze.com/ul?';
const BING = 'https://bing.com/maps/default.aspx?';

/** Die Adresse, die die App für „Karte zeigen“ öffnet. */
export function karteUrl(app: KartenAppKey, ziel: Ziel): string {
  if (ziel.art === 'punkt') {
    const paar = punktPaar(ziel.breite, ziel.laenge);
    const breite = zahl(ziel.breite);
    const laenge = zahl(ziel.laenge);
    switch (app) {
      case 'system':
        return `geo:${paar}?q=${kodiere(paar)}`;
      case 'apple':
        return `${APPLE}?ll=${kodiere(paar)}&q=${kodiere(paar)}`;
      case 'google':
        return `${GOOGLE_SUCHE}${kodiere(paar)}`;
      case 'osm':
        return `${OSM}?mlat=${breite}&mlon=${laenge}#map=17/${breite}/${laenge}`;
      case 'waze':
        return `${WAZE}ll=${kodiere(paar)}`;
      case 'bing':
        return `${BING}cp=${breite}~${laenge}&lvl=17&sp=point.${breite}_${laenge}_Ort`;
    }
  }
  const text = kodiere(ziel.text);
  switch (app) {
    case 'system':
      return `geo:0,0?q=${text}`;
    case 'apple':
      return `${APPLE}?q=${text}`;
    case 'google':
      return `${GOOGLE_SUCHE}${text}`;
    case 'osm':
      return `${OSM}search?query=${text}`;
    case 'waze':
      return `${WAZE}q=${text}`;
    case 'bing':
      return `${BING}where1=${text}`;
  }
}

/**
 * Die Adresse für „Route hierher“ – oder `null`, wenn die App das per Link
 * nicht kann. Dann wird sie im Blatt ausgeblendet.
 *
 * - `geo:` kennt keine Route.
 * - OpenStreetMap nimmt als Ziel der Route nur Koordinaten verlässlich; ob
 *   Freitext dort geht, ist nicht belegt. Bei Text wird sie nicht angeboten,
 *   statt eine Route ins Leere zu versprechen.
 */
export function routeUrl(app: KartenAppKey, ziel: Ziel): string | null {
  if (ziel.art === 'punkt') {
    const paar = punktPaar(ziel.breite, ziel.laenge);
    const breite = zahl(ziel.breite);
    const laenge = zahl(ziel.laenge);
    switch (app) {
      case 'system':
        return null;
      case 'apple':
        return `${APPLE}?daddr=${kodiere(paar)}`;
      case 'google':
        return `${GOOGLE_ROUTE}${kodiere(paar)}`;
      case 'osm':
        return `${OSM}directions?route=%3B${kodiere(paar)}`;
      case 'waze':
        return `${WAZE}ll=${kodiere(paar)}&navigate=yes`;
      case 'bing':
        return `${BING}rtp=~pos.${breite}_${laenge}`;
    }
  }
  const text = kodiere(ziel.text);
  switch (app) {
    case 'system':
    case 'osm':
      return null;
    case 'apple':
      return `${APPLE}?daddr=${text}`;
    case 'google':
      return `${GOOGLE_ROUTE}${text}`;
    case 'waze':
      return `${WAZE}q=${text}&navigate=yes`;
    case 'bing':
      return `${BING}rtp=~adr.${text}`;
  }
}

/** Die Adresse für den gewählten Modus; `null` heisst: in diesem Modus nicht angeboten. */
export function urlFuer(app: KartenAppKey, modus: Modus, ziel: Ziel): string | null {
  return modus === 'route' ? routeUrl(app, ziel) : karteUrl(app, ziel);
}

/* ---------- Plattform ---------- */

export interface Umgebung {
  userAgent: string;
  plattform: string;
  touchPunkte: number;
}

function aktuelleUmgebung(): Umgebung {
  if (typeof navigator === 'undefined') return { userAgent: '', plattform: '', touchPunkte: 0 };
  return {
    userAgent: navigator.userAgent ?? '',
    plattform: navigator.platform ?? '',
    touchPunkte: navigator.maxTouchPoints ?? 0,
  };
}

/**
 * Auf welchem Gerät läuft die App – nur so genau, wie die Auswahl es braucht.
 *
 * iPadOS meldet sich seit Version 13 als Mac. Der Unterschied zu einem echten
 * Mac ist der Touchscreen: ein Mac hat keine Berührungspunkte, ein iPad fünf.
 */
export function plattformErkennen(umgebung: Umgebung = aktuelleUmgebung()): Plattform {
  const { userAgent, plattform, touchPunkte } = umgebung;
  if (/Android/i.test(userAgent)) return 'android';
  if (/iPhone|iPad|iPod/i.test(userAgent)) return 'ios';
  if (/Mac/i.test(plattform || userAgent)) return touchPunkte > 1 ? 'ios' : 'mac';
  return 'andere';
}

/** Die Apps für dieses Gerät und diesen Modus, in der Reihenfolge des Blatts. */
export function appsFuer(plattform: Plattform, modus: Modus, ziel: Ziel): KartenApp[] {
  return REIHENFOLGE[plattform]
    .map((key) => KARTEN_APPS.find((app) => app.key === key))
    .filter((app): app is KartenApp => app !== undefined && app.plattformen.includes(plattform))
    .filter((app) => modus === 'karte' || routeUrl(app.key, ziel) !== null);
}
