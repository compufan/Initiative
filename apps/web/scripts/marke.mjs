#!/usr/bin/env node
// Macht aus EINEM Bild den ganzen Satz an App-Symbolen.
//
// # Warum es diese Datei gibt
//
// Damit das Zeichen der Gruppe an genau einer Stelle im Repository liegt.
// Vorher lagen zwei WebP-Dateien (1x und 2x) ohne nachvollziehbare Herkunft
// daneben, und die Symbole der App zeigten noch einen Blitz aus einer Zeit,
// in der es kein Logo gab – zwei Zeichen für eine Gruppe.
//
// Jetzt gilt: `public/marke/logo.png` ist die Quelle. Wer das Logo austauschen
// will, legt eine neue Datei an diese Stelle und ruft
// `pnpm --filter @initiative/web marke` auf. Alles andere entsteht daraus.
//
// # Warum die Symbole NICHT im Repository liegen
//
// Weil sie sonst die zweite Quelle wären – und zwar eine, die still veraltet.
// Wer das Logo tauscht und den Aufruf vergisst, hätte ein neues Logo im
// Hintergrund und ein altes auf dem Startbildschirm, ohne dass irgendetwas
// meckert. Die Symbole entstehen deshalb beim Bauen (`prebuild`) und beim
// Entwickeln (`dev`) und stehen in `.gitignore`.
//
// # Warum ohne Abhängigkeiten
//
// Weil dieses Projekt PNG von Hand schreibt (siehe unten) und es sich damit
// eine Bildbibliothek spart, die bei jedem Klonen mitkommt und jedes Jahr
// eine Sicherheitslücke hat. Der Decoder hier ist dreissig Zeilen, der
// Encoder vierzig, und beide können genau das, was gebraucht wird.
import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------------------------ Marke */

/**
 * Der Untergrund der Kachel.
 *
 * Dieselbe Farbe wie `--bg` des dunklen Themas (`tokens.css`), nicht Schwarz:
 * Das Logo wurde auf Schwarz entworfen, und eine schwarze Kachel neben den
 * anderen Symbolen auf einem Startbildschirm sieht aus wie ein Loch. Ein sehr
 * dunkles Blau liest sich als Fläche und lässt das Rot des Herzens leuchten.
 */
const KACHEL = [0x0b, 0x10, 0x20];

/** Eckenrundung der Kachel, als Anteil der Kantenlänge. */
const RUNDUNG = 0.22;

/**
 * Wie viel der Kachel das Logo einnimmt.
 *
 * 0,80 lässt einen Rand, der auf jedem Startbildschirm als Rand gelesen wird.
 * Ohne ihn klebt das Logo an der Kante, und bei runden Masken schneidet die
 * Plattform in die Schrift.
 */
const ANTEIL = 0.8;

/**
 * Und wie viel bei einer maskierbaren Kachel.
 *
 * Android darf davon alles ausserhalb des inneren Kreises (80 % der Kante)
 * abschneiden. Das Logo muss also in diesen Kreis passen – nicht in das
 * Quadrat.
 */
const ANTEIL_MASKIERBAR = 0.62;

/** Wie fein die Kanten der Kachel abgetastet werden: 4 × 4 Proben je Punkt. */
const PROBEN = 4;

/* ------------------------------------------------------- Hintergrundfassung */

/*
 * Warum das Logo für den Hintergrund umgerechnet wird, statt es nur zu
 * schleiern.
 *
 * Der Anwender schrieb: „Lasse das Schwarz des Logos mit dem Schwarz des
 * Hintergrunds matchen und sich die farbigen elemente abheben."
 *
 * Der erste Teil ist schon erfüllt und war es immer: Gemessen an
 * `logo.png` sind 65,3 % aller Punkte VOLLSTÄNDIG durchsichtig, und von der
 * sichtbaren Fläche sind 0,08 % dunkler als der Grund `#0b1020`. Die
 * schwarzen Bänder im Herzen sind Löcher, keine Farbe – dort steht der
 * Hintergrund selbst, punktgenau.
 *
 * Der zweite Teil war dagegen nicht erfüllt, und der Grund ist der Schleier:
 * eine volle Lage Hintergrundfarbe ÜBER dem Bild, die jeden Punkt
 * gleichmässig zum Grund zieht. Gemessen auf „dezent" (90 %) landete das
 * kräftigste Rot bei rgb(35,15,29) – Abstand 15 vom Grund im Median –, das
 * Weiss dagegen bei Abstand 39. Das Weiss war also zweieinhalbmal so laut wie
 * das Rot; genau umgekehrt zur Bitte. Und das Rot wurde dabei nicht blass,
 * sondern braungrau: Sein Blaukanal SINKT von 32 auf 30.
 *
 * Den Schleier einfach zu senken hilft nicht, weil er beide gleich behandelt:
 * Das Weiss zöge mit und würde zur lautesten Fläche der App. Die Trennung
 * muss deshalb nach SÄTTIGUNG erfolgen, nicht nach Helligkeit – und das kann
 * CSS nicht je Bildpunkt. Also wird es hier vorgerechnet.
 *
 * Gemessen mit dieser Fassung bei Schleier 60 %: Rot im Median auf Abstand
 * 81, Neutrales auf 47. Das Rot führt jetzt, und der Kontrast von `--text`
 * über der hellsten Stelle liegt bei 10,7 – AAA verlangt 7.
 */

/**
 * Wie viel Deckung ein völlig UNBUNTER Punkt behält.
 *
 * Nicht null: Die weissen Bänder und der Schriftzug sind Teil der Zeichnung,
 * sie sollen nur nicht mehr lauter sein als das Herz. Dreissig Prozent sind
 * gemessen der Wert, bei dem sie als Struktur lesbar bleiben und das Rot
 * trotzdem klar führt.
 */
export const NEUTRAL_ANTEIL = 0.3;

/** Ab welcher Sättigung ein Punkt als „farbig" gilt und aufgehellt wird. */
export const SATT_AB = 0.35;

/**
 * Wie stark ein farbiger Punkt aufgehellt wird.
 *
 * Gemessen an der Medianentfernung der farbigen Punkte vom Grund (Schleier
 * 60 %): ohne Hebung 57, bei 1,2 dann 69, bei 1,4 dann 81, bei 1,6 dann 88,
 * bei 1,8 dann 90. Der Gewinn läuft also aus, und jede weitere Stufe kostet
 * Zeichnung: Unter den farbigen Punkten reicht die Helligkeit von 48 bis 255
 * – das Herz ist von dunklem Weinrot bis hellem Rot schattiert. Wer sie auf
 * volle Helligkeit zieht, presst diese ganze Spanne auf einen Wert und
 * bekommt ein flaches Plakatrot statt einer Zeichnung.
 */
export const HEBUNG = 1.4;

/** Sättigung nach HSV: wie weit ein Punkt von Grau entfernt ist. */
function saettigung(r, g, b) {
  const max = Math.max(r, g, b);
  if (max === 0) return 0;
  return (max - Math.min(r, g, b)) / max;
}

/**
 * Das Logo als Hintergrundbild: Farbiges lauter, Unbuntes leiser.
 *
 * Nimmt und liefert RGBA. Ein durchsichtiger Punkt bleibt durchsichtig – die
 * Löcher im Herzen sind der Grund, warum das Schwarz schon heute passt, und
 * sie dürfen nicht zufällig zu Farbe werden.
 */
export function hintergrundfassung(logo) {
  const punkte = new Uint8Array(logo.punkte.length);
  for (let i = 0; i < punkte.length; i += 4) {
    const alpha = logo.punkte[i + 3];
    if (alpha === 0) continue;
    const r = logo.punkte[i];
    const g = logo.punkte[i + 1];
    const b = logo.punkte[i + 2];
    const satt = saettigung(r, g, b);
    const max = Math.max(r, g, b);
    // Die Hebung gilt NUR für farbige Punkte. Ein neutraler soll leiser
    // werden, nicht heller – sonst hebt sie genau das an, was zurücktreten
    // soll.
    const faktor = satt >= SATT_AB && max > 0 ? Math.min(255, max * HEBUNG) / max : 1;
    punkte[i] = Math.min(255, Math.round(r * faktor));
    punkte[i + 1] = Math.min(255, Math.round(g * faktor));
    punkte[i + 2] = Math.min(255, Math.round(b * faktor));
    punkte[i + 3] = Math.round(alpha * (NEUTRAL_ANTEIL + (1 - NEUTRAL_ANTEIL) * satt));
  }
  return punkte;
}

/* ------------------------------------------------------------ PNG: Pruefsumme */

const CRC_TABELLE = (() => {
  const tabelle = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tabelle[n] = c;
  }
  return tabelle;
})();

function crc32(bytes) {
  let crc = -1;
  for (let i = 0; i < bytes.length; i += 1)
    crc = CRC_TABELLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/* -------------------------------------------------------------- PNG: lesen */

/**
 * Liest ein PNG mit acht Bit je Kanal, ohne Verschachtelung.
 *
 * Absichtlich kein vollständiger Decoder: Paletten, sechzehn Bit und Adam7
 * kommen in einer Logodatei nicht vor, und jede weitere Zeile wäre Code, den
 * niemand je ausführt. Was nicht passt, wird mit einem Satz abgelehnt, den
 * man lesen kann – nicht mit einem Bild, das schief aussieht.
 */
export function pngLesen(bytes) {
  const kopf = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < kopf.length; i += 1) {
    if (bytes[i] !== kopf[i]) throw new Error('Das ist kein PNG.');
  }

  let breite = 0;
  let hoehe = 0;
  let kanaele = 0;
  const teile = [];

  for (let at = 8; at + 8 <= bytes.length;) {
    const laenge = bytes.readUInt32BE(at);
    const art = bytes.toString('latin1', at + 4, at + 8);
    const daten = bytes.subarray(at + 8, at + 8 + laenge);
    if (art === 'IHDR') {
      breite = daten.readUInt32BE(0);
      hoehe = daten.readUInt32BE(4);
      const bittiefe = daten[8];
      const farbtyp = daten[9];
      const verschachtelt = daten[12];
      if (bittiefe !== 8 || verschachtelt !== 0) {
        throw new Error('Nur acht Bit je Kanal und ohne Verschachtelung. Speichere das Logo so.');
      }
      kanaele = { 0: 1, 2: 3, 4: 2, 6: 4 }[farbtyp];
      if (!kanaele) throw new Error(`Farbtyp ${farbtyp} wird hier nicht gelesen.`);
    } else if (art === 'IDAT') {
      teile.push(daten);
    } else if (art === 'IEND') {
      break;
    }
    at += 12 + laenge;
  }

  const roh = inflateSync(Buffer.concat(teile));
  const schritt = breite * kanaele;
  const punkte = new Uint8Array(breite * hoehe * 4);
  const zeile = new Uint8Array(schritt);
  const davor = new Uint8Array(schritt);

  for (let y = 0; y < hoehe; y += 1) {
    const an = y * (schritt + 1);
    const filter = roh[an];
    /*
     * Die fünf Filter aus der PNG-Spezifikation.
     *
     * Sie rechnen mit dem Punkt LINKS und dem Punkt DARÜBER – „links" heisst
     * dabei einen ganzen Punkt weiter, nicht ein Byte. Genau daran scheitert
     * jeder erste Versuch: Bei RGBA sind das vier Bytes, und wer eines nimmt,
     * bekommt ein Bild, das aussieht wie durch Wasser betrachtet.
     */
    for (let i = 0; i < schritt; i += 1) {
      const x = roh[an + 1 + i];
      const a = i >= kanaele ? zeile[i - kanaele] : 0;
      const b = davor[i];
      const c = i >= kanaele ? davor[i - kanaele] : 0;
      let wert;
      switch (filter) {
        case 0:
          wert = x;
          break;
        case 1:
          wert = x + a;
          break;
        case 2:
          wert = x + b;
          break;
        case 3:
          wert = x + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          wert = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`Unbekannter Zeilenfilter ${filter}.`);
      }
      zeile[i] = wert & 0xff;
    }

    for (let x = 0; x < breite; x += 1) {
      const von = x * kanaele;
      const nach = (y * breite + x) * 4;
      if (kanaele >= 3) {
        punkte[nach] = zeile[von];
        punkte[nach + 1] = zeile[von + 1];
        punkte[nach + 2] = zeile[von + 2];
        punkte[nach + 3] = kanaele === 4 ? zeile[von + 3] : 255;
      } else {
        punkte[nach] = zeile[von];
        punkte[nach + 1] = zeile[von];
        punkte[nach + 2] = zeile[von];
        punkte[nach + 3] = kanaele === 2 ? zeile[von + 1] : 255;
      }
    }
    davor.set(zeile);
  }

  return { breite, hoehe, punkte };
}

/* ------------------------------------------------------------ PNG: schreiben */

function block(art, daten) {
  const aus = Buffer.alloc(daten.length + 12);
  aus.writeUInt32BE(daten.length, 0);
  aus.write(art, 4, 'latin1');
  daten.copy(aus, 8);
  aus.writeUInt32BE(crc32(aus.subarray(4, 8 + daten.length)), 8 + daten.length);
  return aus;
}

/**
 * Schreibt RGBA-Punkte als PNG. Ohne `alpha` fällt der vierte Kanal weg.
 *
 * `hoehe` nur für Bilder, die nicht quadratisch sind. Die Symbole sind es
 * immer; die Hintergrundfassung hat dagegen die Masse des Logos, und wer
 * eines mit anderem Seitenverhältnis einlegt, bekäme sonst ein PNG, dessen
 * Kopf etwas anderes behauptet als seine Daten.
 */
export function pngSchreiben(punkte, kante, { alpha = true, hoehe = kante } = {}) {
  const kanaele = alpha ? 4 : 3;
  const schritt = kante * kanaele;
  const roh = Buffer.alloc((schritt + 1) * hoehe);

  for (let y = 0; y < hoehe; y += 1) {
    const an = y * (schritt + 1);
    roh[an] = 0; // Filter 0: keiner. Die Flächen packt zlib ohnehin gut.
    for (let x = 0; x < kante; x += 1) {
      const von = (y * kante + x) * 4;
      const nach = an + 1 + x * kanaele;
      roh[nach] = punkte[von];
      roh[nach + 1] = punkte[von + 1];
      roh[nach + 2] = punkte[von + 2];
      if (alpha) roh[nach + 3] = punkte[von + 3];
    }
  }

  const kopf = Buffer.alloc(13);
  kopf.writeUInt32BE(kante, 0);
  kopf.writeUInt32BE(hoehe, 4);
  kopf[8] = 8;
  kopf[9] = alpha ? 6 : 2;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    block('IHDR', kopf),
    block('IDAT', deflateSync(roh, { level: 9 })),
    block('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------- Verkleinern */

/**
 * Verkleinert ein Bild durch Flächenmittelung.
 *
 * # Warum mit vormultipliziertem Alpha
 *
 * Weil sonst dunkle Fransen entstehen. An der Kante des Logos steht ein
 * durchsichtiger Punkt, dessen Farbwerte nichts bedeuten – wer sie gleich
 * gewichtet mitmittelt, zieht den Mittelwert dorthin. Bei einem Logo auf
 * schwarzem Grund heisst das: ein grauer Saum um jede Kante, der bei jedem
 * Verkleinerungsschritt breiter wird.
 *
 * # Warum Flächenmittelung und nicht etwas Feineres
 *
 * Hier wird immer VERKLEINERT, oft um den Faktor vier oder mehr. Dabei ist
 * die Flächenmittelung nicht der Kompromiss, sondern das Richtige: Jeder
 * Punkt der Vorlage geht genau einmal und mit seinem Flächenanteil ein. Ein
 * Lanczos-Kern brächte hier nur Überschwinger an den harten Kanten.
 */
export function verkleinern(quelle, breite, hoehe, ziel) {
  const aus = new Uint8Array(ziel * ziel * 4);
  const xSkala = breite / ziel;
  const ySkala = hoehe / ziel;

  for (let y = 0; y < ziel; y += 1) {
    const y0 = y * ySkala;
    const y1 = (y + 1) * ySkala;
    for (let x = 0; x < ziel; x += 1) {
      const x0 = x * xSkala;
      const x1 = (x + 1) * xSkala;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let gewicht = 0;

      for (let sy = Math.floor(y0); sy < Math.min(hoehe, Math.ceil(y1)); sy += 1) {
        const hy = Math.min(y1, sy + 1) - Math.max(y0, sy);
        if (hy <= 0) continue;
        for (let sx = Math.floor(x0); sx < Math.min(breite, Math.ceil(x1)); sx += 1) {
          const hx = Math.min(x1, sx + 1) - Math.max(x0, sx);
          if (hx <= 0) continue;
          const w = hx * hy;
          const an = (sy * breite + sx) * 4;
          const al = quelle[an + 3] / 255;
          r += quelle[an] * al * w;
          g += quelle[an + 1] * al * w;
          b += quelle[an + 2] * al * w;
          a += quelle[an + 3] * w;
          gewicht += w;
        }
      }

      const nach = (y * ziel + x) * 4;
      if (gewicht <= 0 || a <= 0) continue;
      // Zurück in nicht vormultiplizierte Werte – so erwartet es PNG.
      const mittelAlpha = a / gewicht;
      const teiler = mittelAlpha / 255;
      aus[nach] = Math.min(255, Math.round(r / gewicht / teiler));
      aus[nach + 1] = Math.min(255, Math.round(g / gewicht / teiler));
      aus[nach + 2] = Math.min(255, Math.round(b / gewicht / teiler));
      aus[nach + 3] = Math.round(mittelAlpha);
    }
  }
  return aus;
}

/* ------------------------------------------------------------------ Kachel */

/** Abstand zum abgerundeten Quadrat, das die Fläche füllt – innen negativ. */
function kachelAbstand(x, y, kante) {
  const halb = kante / 2;
  const radius = kante * RUNDUNG;
  const qx = Math.abs(x - halb) - (halb - radius);
  const qy = Math.abs(y - halb) - (halb - radius);
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - radius;
}

/** Deckung einer Probe: eine Rampe von genau einer Probenbreite. */
function deckung(abstand) {
  return Math.min(1, Math.max(0, 0.5 - abstand * PROBEN));
}

/**
 * Zeichnet ein Symbol.
 *
 * `kachel: false` heisst randlos (maskierbar und iOS – dort legt die
 * Plattform ihre eigene Maske darüber), `nurUmriss` liefert die weisse
 * Silhouette für die Android-Statusleiste.
 */
export function symbol(logo, { kante, kachel = true, anteil = ANTEIL, nurUmriss = false }) {
  const punkte = new Uint8Array(kante * kante * 4);
  const innen = Math.max(1, Math.round(kante * anteil));
  const klein = verkleinern(logo.punkte, logo.breite, logo.hoehe, innen);
  const versatz = Math.round((kante - innen) / 2);

  /*
   * Erst der Untergrund, dann das Logo darüber.
   *
   * Der Untergrund wird mit 4 × 4 Proben je Punkt abgetastet, weil seine
   * Rundung sonst treppt – bei 192 Punkten Kante sieht man jede Stufe. Das
   * Logo braucht das nicht: Es ist beim Verkleinern schon gemittelt worden.
   */
  if (!nurUmriss) {
    const proben = PROBEN * PROBEN;
    const schritt = 1 / PROBEN;
    for (let y = 0; y < kante; y += 1) {
      for (let x = 0; x < kante; x += 1) {
        let deck = 1;
        if (kachel) {
          let summe = 0;
          for (let sy = 0; sy < PROBEN; sy += 1) {
            for (let sx = 0; sx < PROBEN; sx += 1) {
              summe += deckung(
                kachelAbstand(x + (sx + 0.5) * schritt, y + (sy + 0.5) * schritt, kante),
              );
            }
          }
          deck = summe / proben;
        }
        const an = (y * kante + x) * 4;
        punkte[an] = KACHEL[0];
        punkte[an + 1] = KACHEL[1];
        punkte[an + 2] = KACHEL[2];
        punkte[an + 3] = Math.round(deck * 255);
      }
    }
  }

  for (let y = 0; y < innen; y += 1) {
    const zy = y + versatz;
    if (zy < 0 || zy >= kante) continue;
    for (let x = 0; x < innen; x += 1) {
      const zx = x + versatz;
      if (zx < 0 || zx >= kante) continue;
      const von = (y * innen + x) * 4;
      const nach = (zy * kante + zx) * 4;
      const oben = klein[von + 3] / 255;
      if (oben <= 0) continue;

      if (nurUmriss) {
        /*
         * Die Statusleiste färbt dieses Bild selbst ein und wertet nur den
         * Alphakanal aus. Was hier an Farbe steht, ist damit gleichgültig –
         * weiss ist die Farbe, die in der Vorschau eines Entwicklers das
         * Gleiche zeigt wie auf dem Gerät.
         */
        punkte[nach] = 255;
        punkte[nach + 1] = 255;
        punkte[nach + 2] = 255;
        punkte[nach + 3] = klein[von + 3];
        continue;
      }

      const unten = punkte[nach + 3] / 255;
      const alpha = oben + unten * (1 - oben);
      if (alpha <= 0) continue;
      const anteilUnten = (unten * (1 - oben)) / alpha;
      for (let k = 0; k < 3; k += 1) {
        punkte[nach + k] = Math.round(
          (klein[von + k] * oben) / alpha + punkte[nach + k] * anteilUnten,
        );
      }
      punkte[nach + 3] = Math.round(alpha * 255);
    }
  }

  return punkte;
}

/* -------------------------------------------------------------------- Lauf */

export const AUFTRAEGE = [
  // Die gewöhnlichen Symbole: die abgerundete Kachel IST der Rand.
  { datei: 'icon-192.png', kante: 192 },
  { datei: 'icon-512.png', kante: 512 },
  // Maskierbar: randlos, das Logo klein genug für eine runde Maske.
  { datei: 'maskable-192.png', kante: 192, kachel: false, anteil: ANTEIL_MASKIERBAR },
  { datei: 'maskable-512.png', kante: 512, kachel: false, anteil: ANTEIL_MASKIERBAR },
  // iOS rundet selbst und will keinen Alphakanal.
  { datei: 'apple-touch-icon.png', kante: 180, kachel: false, alpha: false },
  // Die Lasche im Browser. Kein SVG mehr: Das Logo ist eine Zeichnung, kein
  // Pfad – ein SVG daraus wäre ein PNG in einer SVG-Hülle.
  { datei: 'favicon-32.png', kante: 32 },
  { datei: 'favicon-64.png', kante: 64 },
  // Android-Statusleiste: weisse Silhouette auf durchsichtig, sonst nichts.
  { datei: 'badge-96.png', kante: 96, nurUmriss: true, anteil: 0.94 },
];

export const QUELLE = fileURLToPath(new URL('../public/marke/logo.png', import.meta.url));
const ZIELE = fileURLToPath(new URL('../public/icons/', import.meta.url));
/**
 * Die vorgerechnete Hintergrundfassung.
 *
 * Liegt neben der Quelle und NICHT im Repository – sie ist ein Bauergebnis
 * wie die Symbole. Die eine Quelle bleibt `logo.png`; wer das Logo tauscht,
 * tauscht diese eine Datei und ruft `marke` auf.
 */
export const HINTERGRUND = fileURLToPath(
  new URL('../public/marke/hintergrund.png', import.meta.url),
);

/**
 * Wohin die Zuordnung „Rolle → fertige Adresse" geschrieben wird.
 *
 * NICHT nach `public/`. Alles dort wird ausgeliefert, und `/icons/*` bekommt
 * nach dem Umbau ein Jahr Unveränderlichkeit – ausgerechnet die einzige
 * Datei mit festem Namen hätte dann genau den Fehler, den die Kennungen
 * abschaffen sollen, nur eine Ebene höher. Sie ist eine reine Baueingabe und
 * gehört neben den Bausatz.
 */
export const KARTE = fileURLToPath(new URL('../.marke/symbole.json', import.meta.url));

/**
 * Die Inhaltskennung im Dateinamen.
 *
 * # Warum es sie gibt
 *
 * Weil ein neues Logo sonst neue Bytes unter derselben Adresse ergibt, und
 * daran scheitert der Austausch: Caddy gibt `/icons/*` mit Cache-Dauer
 * heraus, Chrome prüft das Manifest höchstens einmal am Tag und holt die
 * WebAPK nur dann neu, wenn sich darin etwas GEÄNDERT hat. Da alle Adressen
 * gleich bleiben, sieht Chrome keinen Grund. Mit einer Kennung im Namen ist
 * die Änderung im Manifest unübersehbar.
 *
 * Gehasht wird die fertige PNG-Datei und nicht die Quelle samt Parametern:
 * So wechselt die Adresse GENAU dann, wenn sich der Inhalt wirklich
 * unterscheidet – auch bei einer Änderung an der Zeichenroutine, und eben
 * nicht bei einer umformulierten Zeile darüber.
 */
export function kennung(bytes) {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 8);
}

/** `icon-192.png` + `3f2a1b9c` → `icon-192.3f2a1b9c.png`. */
export function mitKennung(datei, marke) {
  const punkt = datei.lastIndexOf('.');
  return `${datei.slice(0, punkt)}.${marke}${datei.slice(punkt)}`;
}

export function alleSymbole() {
  const logo = pngLesen(readFileSync(QUELLE));
  /*
   * Das Verzeichnis wird geleert, nicht ergänzt.
   *
   * Jede Kennung legt eine neue Datei an; ohne diese Zeile sammelte sich
   * nach dem dritten Logowechsel ein Friedhof alter Symbole an, die niemand
   * mehr anfordert und die trotzdem mit ausgeliefert werden.
   */
  rmSync(ZIELE, { recursive: true, force: true });
  mkdirSync(ZIELE, { recursive: true });
  const geschrieben = [];
  const karte = {};
  for (const { datei, kante, kachel, anteil, nurUmriss, alpha } of AUFTRAEGE) {
    const punkte = symbol(logo, { kante, kachel, anteil, nurUmriss });
    const png = pngSchreiben(punkte, kante, { alpha });
    const name = mitKennung(datei, kennung(png));
    writeFileSync(join(ZIELE, name), png);
    karte[datei] = `/icons/${name}`;
    geschrieben.push([name, `${kante}x${kante}`, png.length]);
  }

  mkdirSync(fileURLToPath(new URL('../.marke/', import.meta.url)), { recursive: true });
  writeFileSync(KARTE, `${JSON.stringify(karte, null, 2)}\n`);

  const hintergrund = pngSchreiben(hintergrundfassung(logo), logo.breite, {
    hoehe: logo.hoehe,
  });
  writeFileSync(HINTERGRUND, hintergrund);
  geschrieben.push(['marke/hintergrund.png', `${logo.breite}x${logo.hoehe}`, hintergrund.length]);
  return geschrieben;
}

/*
 * Nur laufen, wenn jemand diese Datei AUFRUFT – nicht, wenn sie jemand liest.
 *
 * Ohne diese Zeile legte schon ein `import` aus einem Test die Symbole neu an,
 * und der Test bestünde dann auch dann, wenn die Zeichenroutine kaputt ist: Er
 * prüfte ja sein eigenes Ergebnis von eben.
 */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const geschrieben = alleSymbole();
  for (const [datei, masse, bytes] of geschrieben) {
    console.log(`${datei.padEnd(22)} ${masse.padEnd(9)} ${(bytes / 1024).toFixed(1)} kB`);
  }
  console.log(`\n${geschrieben.length} Dateien aus ${QUELLE}`);
}
