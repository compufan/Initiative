/**
 * Ein Rezept: die Bearbeitung als Anweisung statt als Kopie.
 *
 * # Wozu
 *
 * Wer heute ein Foto bearbeitet und verschickt, schickt ein plattgerechnetes
 * Ergebnis. Beim Empfänger ist die Bearbeitung dann Teil der Bildpunkte –
 * nicht zurückzunehmen, nicht weiterzudrehen, und beim nächsten Weitergeben
 * ein zweites Mal komprimiert.
 *
 * Ein Rezept dreht das um: Es reist das UNBERÜHRTE Bild, und daneben eine
 * kleine Datei, die sagt, was damit zu tun ist. Der Empfänger sieht dasselbe
 * Ergebnis, kann aber das Original ansehen und die Regler weiterschieben.
 * `BildDoc` liegt dafür schon in Originalpunkten bereit – das Dokument ist das
 * Rezept, es fehlte nur der Weg nach draussen.
 *
 * Dieselbe Datei dient dem Entwurf, der ein Schliessen überlebt: Was sich
 * verschicken lässt, lässt sich auch ablegen. Deshalb trennt diese Datei
 * sauber zwischen ZWEI Fragen, die oft verwechselt werden:
 *
 *   * `docNachRoh` / `docAusRoh` – wie ein Dokument zu Text wird und zurück.
 *     Vollständig, auch Striche und Schriftzüge, denn ein Entwurf muss alles
 *     behalten.
 *   * `rezeptHindernis` – ob eine Bearbeitung VERSCHICKT werden darf.
 *
 * # Warum nicht jede Bearbeitung ein Rezept sein darf
 *
 * Weil beim Rezept das Original mitreist.
 *
 * Wer ein Kennzeichen verpixelt, ein fremdes Gesicht weichzeichnet, einen
 * Mülleimer wegstempelt, eine Hausnummer wegschneidet oder einen Balken darüber
 * malt, tut das, damit es FORT ist. Ein Rezept schickte das Entfernte mit und
 * gäbe dem Empfänger einen Knopf, es zurückzuholen. Das wäre die
 * schlimmstmögliche Auslegung von „das Original bleibt erhalten“.
 *
 * Deshalb fällt die Entscheidung nicht im Dialog, sondern an der Regel:
 * `rezeptHindernis` lässt ein Rezept nur durch, wenn die Bearbeitung
 * DEUTEND ist – Licht, Farbe, Bereiche, Tiefenschärfe, Vierteldrehung,
 * Spiegelung. Alles, was Bildinhalt entfernt oder verdeckt, schliesst das
 * Rezept aus, und die Rückgabe sagt in einem Satz, was es war. Wer trotzdem
 * senden will, schickt die Kopie – so wie bisher.
 *
 * Zuschnitt und Neigung stehen ausdrücklich auf der Sperrliste. Eine Neigung
 * schneidet die Ecken weg, ein Zuschnitt sowieso; beides sieht nach Gestaltung
 * aus und ist oft genau das Gegenteil.
 *
 * # Was in der Datei steht
 *
 * JSON, danach gzip. Die Masken der Netz- und Tiefenteile sind Rasterfelder
 * von bis zu 1536 Punkten Kante; als Base64 in JSON wären das Megabytes, doch
 * ein Rasterfeld ist glatt und lässt sich hervorragend packen. Nachgemessen
 * an 1152 × 864 – 995 328 Bytes roh:
 *
 *     Freistellmaske (aussen 0, innen 255, weiche Kante)   25 412 B
 *     Tiefenkarte (Verlauf über die ganze Fläche)            2 872 B
 *
 * Base64 vor gzip ist dabei nicht ideal – gzip über die rohen Bytes käme
 * weiter. Es bleibt trotzdem: Eine Datei von 25 kB neben einem Foto von
 * mehreren Megabyte fällt nicht ins Gewicht, und dafür bleibt das Format
 * lesbarer Text, den man sich ansehen kann.
 *
 * Beim LESEN ist die Datei fremde Eingabe. Sie kommt von einem anderen Gerät
 * und kann alles behaupten: eine Maske mit vier Milliarden Punkten, zehntausend
 * Pinselstriche, `NaN` als Belichtung. `docAusRoh` glaubt deshalb nichts,
 * sondern klemmt jede Zahl, begrenzt jede Liste und lehnt ein zu grosses Raster
 * ab. Und `rezeptLesen` begrenzt schon VOR dem Entpacken, weil sonst eine
 * Datei von 30 kB zu einem Gigabyte im Arbeitsspeicher werden könnte.
 */

import {
  BEREICHE_MAX,
  neuesDoc,
  type Bereich,
  type Bereichston,
  type BildDoc,
  type Drehung,
  type Malstrich,
  type Maskenmodus,
  type Maskenteil,
  type Pinselstrich,
  type Schriftzug,
} from './doc.js';
import { naechsteMarke } from './maske.js';
import { FARB_NEUTRAL, NEUTRAL, istNeutral, type Anpassung, type Farbanpassung } from './ton.js';

/** Die Fassung des Formats. Steht in jeder Datei und wird beim Lesen geprüft. */
export const REZEPT_FASSUNG = 1;

/** Der Dateiname, unter dem ein Rezept an der Nachricht hängt. */
export const REZEPT_DATEINAME = 'rezept.json.gz';

/** Der Typ, unter dem es hochgeladen wird – `file` erlaubt jeden. */
export const REZEPT_MIME = 'application/gzip';

/**
 * Die Grenzen, an denen eine fremde Datei abprallt.
 *
 * Sie sind grosszügig gegenüber allem, was der Editor selbst erzeugen kann,
 * und knapp gegenüber allem darüber. Ein echtes Dokument hat vier Bereiche mit
 * je einer Handvoll Teilen; wer zehntausend schickt, will nichts Gutes.
 */
export const REZEPT_GRENZEN = {
  /** Die Datei, wie sie ankommt – gepackt. */
  dateiBytes: 8 * 1024 * 1024,
  /** Und entpackt. Ohne diese Grenze wäre eine Zip-Bombe möglich. */
  textBytes: 64 * 1024 * 1024,
  bereiche: BEREICHE_MAX,
  teileJeBereich: 12,
  /** Rasterpunkte eines Netz- oder Tiefenteils – 1536 × 1536. */
  rasterPunkte: 1536 * 1536,
  /** Wieviele Rasterteile ein Dokument insgesamt tragen darf. */
  rasterTeile: 8,
  pinselstriche: 400,
  /** Zahlen je Strich, also halb so viele Punkte. */
  strichZahlen: 40_000,
  striche: 400,
  texte: 40,
  textZeichen: 500,
} as const;

/* ---------- Zahlen, denen man nicht glaubt ---------- */

function zahl(wert: unknown, min: number, max: number, ersatz: number): number {
  const v = typeof wert === 'number' ? wert : Number(wert);
  if (!Number.isFinite(v)) return ersatz;
  return Math.min(max, Math.max(min, v));
}

function jaNein(wert: unknown): boolean {
  return wert === true;
}

function text(wert: unknown, max: number): string {
  return typeof wert === 'string' ? wert.slice(0, max) : '';
}

function liste(wert: unknown, max: number): unknown[] {
  return Array.isArray(wert) ? wert.slice(0, max) : [];
}

/* ---------- Rasterfelder ---------- */

/**
 * `Uint8Array` → Base64, in Häppchen.
 *
 * `String.fromCharCode(...feld)` wäre eine Zeile und stürzt ab: Bei einer
 * Maske von 1152 × 864 wären das eine Million Argumente auf einmal, und der
 * Aufrufstapel des Browsers endet weit darunter. Nachgemessen reisst es
 * zwischen 60 000 und 250 000, je nach Browser – also genau in der Grösse, in
 * der es auf dem Entwicklungsrechner gutgeht und auf dem Telefon nicht.
 */
function nachBase64(feld: Uint8Array): string {
  const HAEPPCHEN = 0x8000;
  let roh = '';
  for (let i = 0; i < feld.length; i += HAEPPCHEN) {
    roh += String.fromCharCode(...feld.subarray(i, i + HAEPPCHEN));
  }
  return btoa(roh);
}

function ausBase64(wert: unknown): Uint8Array | null {
  if (typeof wert !== 'string') return null;
  try {
    const roh = atob(wert);
    const feld = new Uint8Array(roh.length);
    for (let i = 0; i < roh.length; i += 1) feld[i] = roh.charCodeAt(i);
    return feld;
  } catch {
    // Kein gültiges Base64 – ein Teil weniger, kein Absturz.
    return null;
  }
}

/* ---------- Die Rohform ---------- */

/** Ein Dokument als reines JSON – das, was in der Datei steht. */
export interface RohDoc {
  drehung: number;
  neigung: number;
  spiegel: boolean;
  zuschnitt: { x: number; y: number; w: number; h: number };
  striche: unknown[];
  texte: unknown[];
  anpassung: Record<string, number>;
  bereiche: unknown[];
}

export interface RezeptDatei {
  v: number;
  /** Die Grösse des Originals – das Bezugssystem aller Punkte im Dokument. */
  breite: number;
  hoehe: number;
  doc: RohDoc;
}

const FARB_SCHLUESSEL = Object.keys(FARB_NEUTRAL) as (keyof Farbanpassung)[];
const TON_SCHLUESSEL = Object.keys(NEUTRAL) as (keyof Anpassung)[];

function anpassungNachRoh(a: Farbanpassung, schluessel: readonly string[]): Record<string, number> {
  const raus: Record<string, number> = {};
  for (const k of schluessel) {
    const v = (a as unknown as Record<string, number>)[k];
    if (Number.isFinite(v)) raus[k] = v;
  }
  return raus;
}

/**
 * Die Regler zurück – jeder für sich geklemmt.
 *
 * Die Grenzen sind die der Regler im Editor, mit einer Ausnahme: `belichtung`
 * geht dort bis ±3, und genau so weit auch hier. Wer ±300 schickt, bekommt ±3.
 */
function anpassungAusRoh<T>(roh: unknown, neutral: T, schluessel: readonly string[]): T {
  const quelle = (roh ?? {}) as Record<string, unknown>;
  const raus = { ...neutral } as unknown as Record<string, number>;
  for (const k of schluessel) {
    const grenze = k === 'belichtung' ? 3 : 1;
    raus[k] = zahl(quelle[k], -grenze, grenze, raus[k] ?? 0);
  }
  return raus as unknown as T;
}

function strichNachRoh(s: Malstrich): unknown {
  return {
    farbe: s.farbe,
    breite: s.breite,
    /*
     * `slice` und nicht die Liste selbst.
     *
     * Die Rohform ist reines JSON und wird weitergereicht – in eine Datei, in
     * den Entwurfsspeicher. Bliebe hier die LEBENDE Liste des Dokuments
     * stehen, änderte der nächste Pinselstrich rückwirkend etwas, das längst
     * abgelegt sein sollte. `JSON.stringify` gleich danach würde das
     * verdecken; jeder andere Weg nicht.
     */
    punkte: s.punkte.slice(),
    art: s.art ?? 'farbe',
    quelle: s.quelle ? { x: s.quelle.x, y: s.quelle.y } : undefined,
  };
}

const STRICH_ARTEN = new Set(['farbe', 'pixel', 'weich', 'klon']);

function strichAusRoh(roh: unknown, breite: number, hoehe: number): Malstrich | null {
  if (!roh || typeof roh !== 'object') return null;
  const q = roh as Record<string, unknown>;
  const punkte = liste(q.punkte, REZEPT_GRENZEN.strichZahlen);
  if (punkte.length < 2) return null;
  const kante = Math.max(breite, hoehe);
  const art = typeof q.art === 'string' && STRICH_ARTEN.has(q.art) ? q.art : 'farbe';
  const strich: Malstrich = {
    // Eine Farbe wird nie ausgewertet, nur als Füllstil gesetzt – trotzdem
    // gekürzt, damit kein Dokument mit einem Kilobyte Farbstring wächst.
    farbe: text(q.farbe, 64) || '#ffffff',
    breite: zahl(q.breite, 0, kante, 8),
    punkte: punkte.map((p) => zahl(p, -4 * kante, 4 * kante, 0)),
    art: art as Malstrich['art'],
  };
  if (q.quelle && typeof q.quelle === 'object') {
    const quelle = q.quelle as Record<string, unknown>;
    strich.quelle = {
      x: zahl(quelle.x, -4 * kante, 4 * kante, 0),
      y: zahl(quelle.y, -4 * kante, 4 * kante, 0),
    };
  }
  return strich;
}

function textAusRoh(roh: unknown, breite: number, hoehe: number): Schriftzug | null {
  if (!roh || typeof roh !== 'object') return null;
  const q = roh as Record<string, unknown>;
  const kante = Math.max(breite, hoehe);
  return {
    id: text(q.id, 64) || `t${naechsteMarke()}`,
    text: text(q.text, REZEPT_GRENZEN.textZeichen),
    x: zahl(q.x, -4 * kante, 4 * kante, 0),
    y: zahl(q.y, -4 * kante, 4 * kante, 0),
    groesse: zahl(q.groesse, 1, kante, 32),
    farbe: text(q.farbe, 64) || '#ffffff',
    kontur: typeof q.kontur === 'string' ? q.kontur.slice(0, 64) : null,
    schrift: text(q.schrift, 64) || 'system',
    fett: jaNein(q.fett),
  };
}

const MODI = new Set<Maskenmodus>(['dazu', 'weg', 'nur']);
const NETZE = new Set(['person', 'object', 'birefnet']);

function teilNachRoh(teil: Maskenteil): unknown {
  const kopf = { id: teil.id, modus: teil.modus, umkehren: teil.umkehren };
  switch (teil.art) {
    case 'verlauf':
      return { ...kopf, art: 'verlauf', von: { ...teil.von }, bis: { ...teil.bis } };
    case 'radial':
      return {
        ...kopf,
        art: 'radial',
        mitte: { ...teil.mitte },
        rx: teil.rx,
        ry: teil.ry,
        winkel: teil.winkel,
        weichheit: teil.weichheit,
      };
    case 'pinsel':
      return {
        ...kopf,
        art: 'pinsel',
        striche: teil.striche.map((s) => ({
          punkte: s.punkte.slice(),
          breite: s.breite,
          haerte: s.haerte,
          abziehen: s.abziehen,
        })),
      };
    case 'netz':
      return {
        ...kopf,
        art: 'netz',
        netz: teil.netz,
        breite: teil.breite,
        hoehe: teil.hoehe,
        alpha: nachBase64(teil.alpha),
      };
    case 'tiefe':
      return {
        ...kopf,
        art: 'tiefe',
        breite: teil.breite,
        hoehe: teil.hoehe,
        karte: nachBase64(teil.karte),
        fokus: teil.fokus,
        spanne: teil.spanne,
      };
    default:
      return null;
  }
}

/** Zählt die Rasterteile mit, damit acht Masken nicht zu achtzig werden. */
interface Zaehlwerk {
  raster: number;
}

function punkt(roh: unknown, kante: number): { x: number; y: number } {
  const q = (roh ?? {}) as Record<string, unknown>;
  return { x: zahl(q.x, -4 * kante, 4 * kante, 0), y: zahl(q.y, -4 * kante, 4 * kante, 0) };
}

function rasterAusRoh(
  q: Record<string, unknown>,
  schluessel: string,
  zaehler: Zaehlwerk,
): { breite: number; hoehe: number; feld: Uint8Array } | null {
  if (zaehler.raster >= REZEPT_GRENZEN.rasterTeile) return null;
  const breite = Math.round(zahl(q.breite, 0, 4096, 0));
  const hoehe = Math.round(zahl(q.hoehe, 0, 4096, 0));
  if (breite <= 0 || hoehe <= 0) return null;
  if (breite * hoehe > REZEPT_GRENZEN.rasterPunkte) return null;
  const feld = ausBase64(q[schluessel]);
  /*
   * Die Länge muss GENAU passen, nicht „mindestens“.
   *
   * Ein zu kurzes Feld wäre der gefährlichere Fall: Jeder Leser rechnet
   * `y * breite + x` und läse hinter dem Ende – in JavaScript kein Absturz,
   * sondern `undefined`, das stumm zu `NaN` und dann zu 0 wird. Die Maske
   * sähe aus, als hätte sie unten einen schwarzen Rand, und niemand käme auf
   * die Idee, die Datei zu verdächtigen.
   */
  if (!feld || feld.length !== breite * hoehe) return null;
  zaehler.raster += 1;
  return { breite, hoehe, feld };
}

function teilAusRoh(
  roh: unknown,
  breite: number,
  hoehe: number,
  zaehler: Zaehlwerk,
): Maskenteil | null {
  if (!roh || typeof roh !== 'object') return null;
  const q = roh as Record<string, unknown>;
  const kante = Math.max(breite, hoehe);
  const kopf = {
    id: text(q.id, 64) || `m${naechsteMarke()}`,
    modus: (MODI.has(q.modus as Maskenmodus) ? q.modus : 'dazu') as Maskenmodus,
    umkehren: jaNein(q.umkehren),
  };

  switch (q.art) {
    case 'verlauf':
      return { ...kopf, art: 'verlauf', von: punkt(q.von, kante), bis: punkt(q.bis, kante) };
    case 'radial':
      return {
        ...kopf,
        art: 'radial',
        mitte: punkt(q.mitte, kante),
        rx: zahl(q.rx, 0, 4 * kante, 1),
        ry: zahl(q.ry, 0, 4 * kante, 1),
        winkel: zahl(q.winkel, -Math.PI * 4, Math.PI * 4, 0),
        weichheit: zahl(q.weichheit, 0.02, 1, 0.5),
      };
    case 'pinsel': {
      const striche: Pinselstrich[] = [];
      for (const s of liste(q.striche, REZEPT_GRENZEN.pinselstriche)) {
        if (!s || typeof s !== 'object') continue;
        const sq = s as Record<string, unknown>;
        const punkte = liste(sq.punkte, REZEPT_GRENZEN.strichZahlen);
        if (punkte.length < 2) continue;
        striche.push({
          punkte: punkte.map((p) => zahl(p, -4 * kante, 4 * kante, 0)),
          breite: zahl(sq.breite, 1, kante, 40),
          haerte: zahl(sq.haerte, 0, 1, 0.5),
          abziehen: jaNein(sq.abziehen),
        });
      }
      return { ...kopf, art: 'pinsel', striche };
    }
    case 'netz': {
      const raster = rasterAusRoh(q, 'alpha', zaehler);
      if (!raster) return null;
      return {
        ...kopf,
        art: 'netz',
        netz: (NETZE.has(q.netz as string) ? q.netz : 'object') as 'person' | 'object' | 'birefnet',
        breite: raster.breite,
        hoehe: raster.hoehe,
        alpha: raster.feld,
        marke: naechsteMarke(),
      };
    }
    case 'tiefe': {
      const raster = rasterAusRoh(q, 'karte', zaehler);
      if (!raster) return null;
      return {
        ...kopf,
        art: 'tiefe',
        breite: raster.breite,
        hoehe: raster.hoehe,
        karte: raster.feld,
        fokus: zahl(q.fokus, 0, 1, 0.5),
        spanne: zahl(q.spanne, 0.02, 1, 0.3),
        marke: naechsteMarke(),
      };
    }
    default:
      return null;
  }
}

function bereichNachRoh(b: Bereich): unknown {
  return {
    id: b.id,
    name: b.name,
    aktiv: b.aktiv,
    teile: b.teile.map(teilNachRoh).filter((t) => t !== null),
    anpassung: {
      ...anpassungNachRoh(b.anpassung, FARB_SCHLUESSEL),
      unschaerfe: b.anpassung.unschaerfe,
    },
  };
}

function bereichAusRoh(
  roh: unknown,
  breite: number,
  hoehe: number,
  zaehler: Zaehlwerk,
): Bereich | null {
  if (!roh || typeof roh !== 'object') return null;
  const q = roh as Record<string, unknown>;
  const teile: Maskenteil[] = [];
  for (const t of liste(q.teile, REZEPT_GRENZEN.teileJeBereich)) {
    const teil = teilAusRoh(t, breite, hoehe, zaehler);
    if (teil) teile.push(teil);
  }
  const farben = anpassungAusRoh<Farbanpassung>(q.anpassung, FARB_NEUTRAL, FARB_SCHLUESSEL);
  const anpassung: Bereichston = {
    ...farben,
    unschaerfe: zahl((q.anpassung as Record<string, unknown> | undefined)?.unschaerfe, 0, 1, 0),
  };
  return {
    id: text(q.id, 64) || `b${naechsteMarke()}`,
    name: text(q.name, 64) || 'Bereich',
    aktiv: q.aktiv !== false,
    teile,
    anpassung,
  };
}

/** Das Dokument als reines JSON-Gebilde – verlustfrei, auch Striche und Text. */
export function docNachRoh(doc: BildDoc): RohDoc {
  return {
    drehung: doc.drehung,
    neigung: doc.neigung,
    spiegel: doc.spiegel,
    zuschnitt: { ...doc.zuschnitt },
    striche: doc.striche.map(strichNachRoh),
    texte: doc.texte.map((t) => ({ ...t })),
    anpassung: anpassungNachRoh(doc.anpassung, TON_SCHLUESSEL),
    bereiche: doc.bereiche.map(bereichNachRoh),
  };
}

/**
 * Und zurück – aus fremder Eingabe.
 *
 * `breite`/`hoehe` sind die Masse des Bildes, an dem das Dokument hängt, und
 * sie kommen vom AUFRUFER, nicht aus der Datei: Der Zuschnitt wird gegen sie
 * geklemmt, und wer beides aus derselben Quelle nähme, könnte sich einen
 * Zuschnitt weit ausserhalb des Bildes erlauben.
 */
export function docAusRoh(roh: unknown, breite: number, hoehe: number): BildDoc {
  const doc = neuesDoc(breite, hoehe);
  if (!roh || typeof roh !== 'object') return doc;
  const q = roh as Record<string, unknown>;
  const zaehler: Zaehlwerk = { raster: 0 };

  // Auf ein Vielfaches von 90 runden, nicht klemmen: 45 wäre sonst als 45
  // stehengeblieben, und `Drehung` verspricht eine von vier Lagen.
  const drehung = Math.round(zahl(q.drehung, 0, 270, 0) / 90) * 90;
  doc.drehung = (((drehung % 360) + 360) % 360) as Drehung;
  doc.neigung = zahl(q.neigung, -45, 45, 0);
  doc.spiegel = jaNein(q.spiegel);

  const zq = (q.zuschnitt ?? {}) as Record<string, unknown>;
  const x = zahl(zq.x, 0, Math.max(0, breite - 1), 0);
  const y = zahl(zq.y, 0, Math.max(0, hoehe - 1), 0);
  doc.zuschnitt = {
    x,
    y,
    w: zahl(zq.w, 1, Math.max(1, breite - x), breite - x),
    h: zahl(zq.h, 1, Math.max(1, hoehe - y), hoehe - y),
  };

  for (const s of liste(q.striche, REZEPT_GRENZEN.striche)) {
    const strich = strichAusRoh(s, breite, hoehe);
    if (strich) doc.striche.push(strich);
  }
  for (const t of liste(q.texte, REZEPT_GRENZEN.texte)) {
    const schrift = textAusRoh(t, breite, hoehe);
    if (schrift) doc.texte.push(schrift);
  }
  doc.anpassung = anpassungAusRoh<Anpassung>(q.anpassung, NEUTRAL, TON_SCHLUESSEL);
  for (const b of liste(q.bereiche, REZEPT_GRENZEN.bereiche)) {
    const bereich = bereichAusRoh(b, breite, hoehe, zaehler);
    if (bereich) doc.bereiche.push(bereich);
  }
  return doc;
}

/* ---------- Darf das raus? ---------- */

/**
 * Warum diese Bearbeitung kein Rezept sein darf – oder `null`, wenn sie es
 * darf.
 *
 * Die Rückgabe ist der Satz, der im Editor steht. Sie ist mit Absicht kein
 * Wahrheitswert: „Geht nicht" ohne Grund lässt den Anwender raten, und raten
 * heisst hier, die Kopie zu schicken, ohne zu wissen, warum.
 */
export function rezeptHindernis(doc: BildDoc, breite: number, hoehe: number): string | null {
  if (doc.striche.length > 0) {
    return 'Striche, Verpixelungen und Stempel entfernen Bildinhalt. Ein Rezept würde das Original mitschicken – und damit auch das Entfernte.';
  }
  if (doc.texte.some((t) => t.text.trim().length > 0)) {
    return 'Ein Schriftzug deckt etwas zu. Ein Rezept würde das Original mitschicken, und der Empfänger könnte darunter schauen.';
  }
  if (doc.neigung !== 0) {
    return 'Das Geraderichten schneidet die Ecken weg. Ein Rezept würde sie mitschicken.';
  }
  const z = doc.zuschnitt;
  if (z.x > 0 || z.y > 0 || z.w < breite || z.h < hoehe) {
    return 'Der Zuschnitt lässt etwas weg. Ein Rezept würde das Weggeschnittene mitschicken.';
  }
  return null;
}

/** Ob überhaupt etwas da ist, das sich als Rezept lohnt. */
export function rezeptLohnt(doc: BildDoc): boolean {
  return !istNeutral(doc.anpassung) || doc.bereiche.length > 0 || doc.drehung !== 0 || doc.spiegel;
}

/* ---------- Datei hinein und heraus ---------- */

/** Ob dieser Browser packen und entpacken kann. Ohne das gibt es kein Rezept. */
export function rezeptMoeglich(): boolean {
  return (
    typeof CompressionStream === 'function' &&
    typeof DecompressionStream === 'function' &&
    typeof Blob === 'function'
  );
}

async function packen(text: string): Promise<Blob> {
  const roh = new Blob([text]);
  const strom = roh.stream().pipeThrough(new CompressionStream('gzip'));
  return await new Response(strom).blob();
}

/**
 * Entpacken mit Deckel.
 *
 * Der Deckel ist der Grund, warum hier von Hand über die Häppchen gelaufen
 * wird statt `new Response(strom).text()` zu rufen: Jenes läse erst alles und
 * fragte danach nach der Grösse – bei einer Datei, die sich tausendfach
 * aufbläst, wäre die Antwort dann schon im Arbeitsspeicher.
 */
async function entpacken(datei: Blob, deckel: number): Promise<string> {
  const strom = datei.stream().pipeThrough(new DecompressionStream('gzip'));
  const leser = strom.getReader();
  const teile: Uint8Array[] = [];
  let summe = 0;
  try {
    for (;;) {
      const { done, value } = await leser.read();
      if (done) break;
      if (!value) continue;
      summe += value.byteLength;
      if (summe > deckel) throw new Error('Das Rezept ist unerwartet gross');
      teile.push(value);
    }
  } finally {
    // Nicht erst beim Aufräumer: Ein offener Leser hält den Strom fest.
    void leser.cancel().catch(() => undefined);
  }
  const alles = new Uint8Array(summe);
  let at = 0;
  for (const teil of teile) {
    alles.set(teil, at);
    at += teil.byteLength;
  }
  return new TextDecoder().decode(alles);
}

/** Das Rezept als fertige, gepackte Datei. */
export async function rezeptSchreiben(doc: BildDoc, breite: number, hoehe: number): Promise<Blob> {
  const datei: RezeptDatei = {
    v: REZEPT_FASSUNG,
    breite: Math.round(breite),
    hoehe: Math.round(hoehe),
    doc: docNachRoh(doc),
  };
  return await packen(JSON.stringify(datei));
}

/**
 * Ein Rezept aus einer Datei – oder `null`, wenn daraus nichts zu holen ist.
 *
 * `null` und keine Ausnahme: Am Aufrufort steht eine Blase im Chat, und die
 * soll das Bild zeigen, wenn das Rezept unlesbar ist, statt einen roten
 * Fehler. Ein unbrauchbares Rezept heisst „unbearbeitet anzeigen", nicht
 * „Nachricht kaputt".
 */
export async function rezeptLesen(
  datei: Blob,
  breite: number,
  hoehe: number,
): Promise<BildDoc | null> {
  if (!rezeptMoeglich()) return null;
  if (datei.size > REZEPT_GRENZEN.dateiBytes) return null;
  try {
    const text = await entpacken(datei, REZEPT_GRENZEN.textBytes);
    const roh = JSON.parse(text) as unknown;
    if (!roh || typeof roh !== 'object') return null;
    const q = roh as Record<string, unknown>;
    // Eine unbekannte Fassung wird nicht geraten: Ein Feld, das später eine
    // andere Bedeutung bekommt, wäre still falsch statt laut fehlend.
    if (q.v !== REZEPT_FASSUNG) return null;
    return docAusRoh(q.doc, breite, hoehe);
  } catch {
    return null;
  }
}
