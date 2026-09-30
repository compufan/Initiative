import { AbbruchError } from '../stickers/engines/index.js';
import { filmMarke, type NeueDaten } from './bildweise.js';
import { schrittMessen, type Kamerapfad } from './kamerapfad.js';
import type { LeseOptionen, Lesung, Prioritaet } from './leserDienst.js';
import { fensterTeilen, type Lauf, type Richtung, type TippPunkte } from './masken.js';
import { Spur, type Punkt } from './objektFolge.js';
import { bildMitte } from './raster.js';
import { metaMessen, rleDekodieren, rleKodieren } from './rle.js';
import type { Kette, KettenEintrag, Pass, Randzustand, Vorrat } from './spurVorrat.js';
import {
  bildGlaetten,
  grauMass,
  maskenKasten,
  type Grau,
  type MaskenKasten,
} from './verfolgung.js';

/**
 * EIN Fenster der Verfolgung im Hintergrund rechnen – lesen, verfolgen,
 * glätten, ablegen.
 *
 * Der `Verfolger` (`verfolger.ts`) entscheidet, WAS als Nächstes dran ist;
 * hier steht, WIE ein Stück davon gerechnet wird, und wo es weitergeht
 * (`inhaltFensterSuchen`, `kameraFensterSuchen`, `tiefenFensterSuchen`).
 * Ohne React, ohne Browser: Leser, Modelle und Tor kommen von aussen, und
 * die Prüfungen setzen Ersatz ein.
 *
 * # Drei Arten von Fenstern
 *
 * - **Inhalt** (Netz, Tipp): eine Spur (`objektFolge.ts`) über die Bilder des
 *   Fensters, Modell nur an Schlüsselbildern, geglättet und als Lauflängen
 *   in der Kette abgelegt. Am Ende ein Rand, an dem das nächste Fenster
 *   ansetzt, als liefe die Spur ohne Pause.
 * - **Kamera** (reine Formmasken): nur Graustufen und die Schritte des
 *   Kamerapfads.
 * - **Tiefe**: Tiefenkarten an Schlüsselbildern, dazu die Kameraschritte,
 *   mit denen die Karte dazwischen gezogen wird.
 *
 * # Die Reihenfolge der Arbeit in einem Fenster
 *
 * 1. **Lesen**, IMMER aufsteigend – auch für ein Fenster, das rückwärts
 *    verfolgt. Ein Sprung nach vorn dekodiert ab dem letzten Bild weiter, ein
 *    Sprung zurück ab dem letzten Schlüsselbild des Videos; aufsteigend
 *    gelesen kostet ein Fenster gemessen einen Bruchteil. Graustufen kommen
 *    aus dem Vorrat, wenn sie dort liegen; volle Bilder nur an
 *    Schlüsselbildern, deren Modellergebnis nicht schon im Netzvorrat liegt.
 * 2. **Verfolgen**: Schritt für Schritt, und zwischen zwei Schritten das Tor
 *    (Anwender wischt, Wiedergabe läuft) und eine Atempause für die Seite.
 *    An jedem Schlüsselbild darf der Verfolger unterbrechen: Dann endet das
 *    Fenster DORT, mit allem, was bis dahin feststeht.
 * 3. **Glätten und Ablegen**, Bild für Bild mit Atempause dazwischen: Nur
 *    Bilder, die der Film zeigt; Brückenbilder bekommen keine Maske. Das
 *    Randbild, an dem angesetzt wurde, wird mit seinem Nachbarn aus dem
 *    vorigen Fenster neu geglättet (Nahtglättung) – im vorigen hatte es nur
 *    einen Nachbarn.
 * 4. **Rand**: der Stand der Spur am letzten Schlüsselbild, seine rohe Maske
 *    und die seines Nachbarn, als Lauflängen.
 *
 * Ein Abbruch mitten im Fenster legt NICHTS ab: Der Rand des vorigen
 * Fensters bleibt der letzte, und das nächste setzt dort wieder an.
 */

/** So lange darf ein Gegenstand fehlen und wird dort wiedergefunden, wo er zu erwarten ist. */
export const WIEDER_MS = 2000;

/** Ab so vielen Bytes Lauflängen gilt eine Maske als verrauscht – siehe `ablegbar`. */
export const RAUSCHEN_AB = 48 * 1024;

/**
 * Eine Maske so, wie sie abgelegt wird: als Lauflängen – und, wenn sie sich
 * so nicht klein machen lässt, vorher gröber gestuft.
 *
 * # Warum
 *
 * Nachgemessen bei 960 × 540 (`messung.test.ts`): Eine weiche Scheibe kommt
 * mit der Rundung aus `rle.ts` (ab 250 → 255, bis 5 → 0) auf 6,6 KB. Eine
 * Zuversichtsmaske, wie ein Freisteller sie liefern kann – innen 235 … 255,
 * aussen 0 … 12, beides verrauscht –, bleibt bei 497 KB, fast ihrer vollen
 * Grösse: Jeder Punkt beginnt einen neuen Lauf. Sechshundert Filmbilder
 * davon wären 290 MB, das Doppelte des ganzen Budgets.
 *
 * Nur für SOLCHE Masken wird gröber gestuft: bis 16 → 0, ab 232 → 255,
 * dazwischen auf Achtel. Das ist höchstens ein Zehntel der Wirkung am
 * äussersten Saum und im Innern – und im Innern ist es Rauschen, das im Film
 * ohnehin nur flimmerte. Dieselbe verrauschte Maske, geglättet und so
 * gestuft: 9,7 KB, und die Verfolgung kostet je Bild 20 statt 47 ms, weil
 * das Packen nicht mehr jeden Punkt einzeln schreibt. Eine Maske, die sich
 * ordentlich packen lässt, bleibt Bit für Bit, wie sie war.
 */
export function ablegbar(maske: Uint8Array): {
  readonly rle: Uint8Array;
  readonly maske: Uint8Array;
} {
  const rle = rleKodieren(maske);
  if (rle.length <= RAUSCHEN_AB) return { rle, maske };
  const grob = new Uint8Array(maske.length);
  for (let i = 0; i < maske.length; i += 1) {
    const wert = maske[i];
    grob[i] = wert <= 16 ? 0 : wert >= 232 ? 255 : (wert + 4) & ~7;
  }
  return { rle: rleKodieren(grob), maske: grob };
}

/** Was ein Fenster vom Leser braucht – der `Leserdienst`, in den Prüfungen ein Ersatz. */
export interface FensterLeser {
  holen(ms: number, prioritaet: Prioritaet, optionen?: LeseOptionen): Promise<Lesung>;
}

/** Das Tor: wartet, solange der Anwender wischt oder die Wiedergabe läuft. */
export interface Tor {
  /** `ruheNachZugMs`: so lange muss der letzte Zug schon vorbei sein (BiRefNet, Person). */
  offen(ruheNachZugMs?: number): Promise<void>;
}

/** Die Zähler für den Prüfhaken `window.__verfolger`. */
export interface Zaehler {
  /** Aufträge an den Leser. */
  lesen: number;
  /** Echte Modelläufe – ohne Treffer im Netzvorrat. */
  laeufe: number;
  /** Gerechnete Fenster. */
  fenster: number;
}

export interface Umgebung {
  readonly leser: FensterLeser;
  readonly vorrat: Vorrat;
  /** Die Schrittweite des Rasters. */
  readonly s: number;
  /** Die Rechengrösse. */
  readonly b: number;
  readonly h: number;
  readonly tor?: Tor;
  readonly abbruch?: AbortSignal;
  /** Wird an jedem Schlüsselbild gefragt: Soll das Fenster hier enden? */
  readonly unterbrechen?: () => boolean;
  readonly zaehler?: Zaehler;
  /** Die Atempause zwischen zwei Schritten – ohne Angabe `luftholen`. */
  readonly luft?: () => Promise<void>;
}

/** Wo ein Inhaltsfenster ansetzt. */
export type FensterStart =
  | {
      /** Am Anfang des Laufs: dem Anker, oder einem Neustart jenseits eines Szenenschnitts. */
      readonly art: 'anker';
      /** Die Maske dort – `null`: erst rechnen (Neustart, `neuRechnen`). */
      readonly maske: Uint8Array | null;
      readonly punkte: readonly Punkt[] | null;
    }
  | { readonly art: 'rand'; readonly zustand: Randzustand };

export interface InhaltsFenster {
  readonly art: 'inhalt';
  readonly kette: Kette;
  readonly richtung: Richtung;
  readonly pass: Pass;
  /** Die Bilder in Laufrichtung, Schritt ±1; `pfad[0]` ist der Rand, an dem angesetzt wird. */
  readonly pfad: readonly number[];
  /** Was abgelegt wird: die Ziele des Laufs (`Lauf.ziele`). */
  readonly ziele: ReadonlySet<number>;
  /** Die Schlüsselbilder dieses Passes; Anfang und Ende des Fensters kommen von selbst dazu. */
  readonly schluessel: ReadonlySet<number>;
  /** Wo der Lauf beginnt – dessen Maske taugt als Nachbar beim Glätten, auch wenn sie kein Ziel ist. */
  readonly laufStart: number;
  readonly start: FensterStart;
  /** Ein Tipp: Punkte werden mit abgelegt, und ohne Punkte ist die Kette „verloren". */
  readonly tipp: boolean;
  /** Siehe `SpurAuftrag.wiederBilder` – nur Motiv und BiRefNet. */
  readonly wiederBilder?: number;
  /** Braucht das Modell an k das volle Bild? Nein, wenn sein Ergebnis schon im Netzvorrat liegt. */
  readonly brauchtBild: (k: number) => boolean;
  readonly rechnen: (
    k: number,
    bild: ImageData | null,
    punkte: readonly Punkt[] | null,
    abbruch?: AbortSignal,
  ) => Promise<Uint8Array>;
  /** So lange muss der letzte Zug vorbei sein, bevor das Modell rechnet. */
  readonly ruheVorModellMs?: number;
}

export interface KameraFenster {
  readonly art: 'kamera';
  /** Aufeinanderfolgende Quellbilder, deren Schritte gebraucht werden. */
  readonly pfad: readonly number[];
}

export interface TiefenFenster {
  readonly art: 'tiefe';
  /** Aufeinanderfolgende Quellbilder, aufsteigend. */
  readonly pfad: readonly number[];
  /** An welchen Bildern eine Karte gebraucht wird. */
  readonly schluessel: ReadonlySet<number>;
  /** Die Karte in der Grösse, die das Netz liefert – hier wird sie auf Graugrösse gebracht. */
  readonly tiefeRechnen: (k: number, bild: ImageData, abbruch?: AbortSignal) => Promise<NeueDaten>;
  readonly ruheVorModellMs?: number;
}

export type Fenster = InhaltsFenster | KameraFenster | TiefenFenster;

export interface Fensterergebnis {
  /** Das letzte Quellbild, bis zu dem das Fenster fertig ist. */
  readonly bis: number;
  /** Endete es vor seinem Ende, weil der Verfolger unterbrach? */
  readonly unterbrochen: boolean;
  /** Wie viele Bilder, Schritte oder Karten abgelegt wurden. */
  readonly gespeichert: number;
}

/**
 * Der Seite Luft lassen: `scheduler.yield`, wo es das gibt (dann kommen
 * wartende Eingaben zuerst dran), sonst ein Makrotask.
 */
export function luftholen(): Promise<void> {
  const planer = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (planer?.yield) return planer.yield();
  return new Promise((weiter) => setTimeout(weiter, 0));
}

function abbruchPruefen(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AbbruchError();
}

export async function fensterRechnen(fenster: Fenster, u: Umgebung): Promise<Fensterergebnis> {
  abbruchPruefen(u.abbruch);
  const ergebnis =
    fenster.art === 'inhalt'
      ? await inhaltRechnen(fenster, u)
      : fenster.art === 'kamera'
        ? await kameraRechnen(fenster, u)
        : await tiefeRechnen(fenster, u);
  if (u.zaehler) u.zaehler.fenster += 1;
  return ergebnis;
}

/* ---------- Lesen ---------- */

interface Bedarf {
  readonly k: number;
  readonly grau: boolean;
  readonly voll: boolean;
}

interface Gelesen {
  readonly grau: Map<number, Grau>;
  readonly voll: Map<number, ImageData>;
}

async function lesen(bedarf: readonly Bedarf[], u: Umgebung): Promise<Gelesen> {
  const grau = new Map<number, Grau>();
  const voll = new Map<number, ImageData>();
  const aufsteigend = [...bedarf].sort((a, b) => a.k - b.k);
  for (const { k, grau: mitGrau, voll: mitVoll } of aufsteigend) {
    abbruchPruefen(u.abbruch);
    await u.tor?.offen();
    abbruchPruefen(u.abbruch);
    let g = mitGrau ? u.vorrat.grau.holen(k) : undefined;
    const grauLesen = mitGrau && !g;
    if (grauLesen || mitVoll) {
      const lesung = await u.leser.holen(bildMitte(k, u.s), 'hinten', {
        grau: grauLesen,
        voll: mitVoll,
        abbruch: u.abbruch,
      });
      if (u.zaehler) u.zaehler.lesen += 1;
      if (grauLesen && lesung.grau) g = u.vorrat.grau.ablegen(k, lesung.grau);
      if (mitVoll && lesung.voll) voll.set(k, lesung.voll);
    }
    if (g) grau.set(k, g);
  }
  return { grau, voll };
}

/* ---------- Inhalt ---------- */

interface Roh {
  readonly maske: Uint8Array;
  readonly mitte: { readonly x: number; readonly y: number } | null;
  readonly kasten: MaskenKasten | null;
}

async function inhaltRechnen(f: InhaltsFenster, u: Umgebung): Promise<Fensterergebnis> {
  const { b, h } = u;
  const luft = u.luft ?? luftholen;
  const pfad = f.pfad;
  const d = pfad.length > 1 && pfad[1] < pfad[0] ? -1 : 1;
  const anfang = pfad[0];
  const ende = pfad[pfad.length - 1];
  const kMin = Math.min(anfang, ende);
  const kMax = Math.max(anfang, ende);
  const lokal = (k: number) => k - kMin;
  const startRechnen = f.start.art === 'anker' && f.start.maske === null;
  const schluessel = new Set<number>([anfang, ende]);
  for (const k of pfad) if (f.schluessel.has(k)) schluessel.add(k);

  const gelesen = await lesen(
    pfad.map((k) => ({
      k,
      grau: true,
      voll: schluessel.has(k) && (k !== anfang || startRechnen) && f.brauchtBild(k),
    })),
    u,
  );
  const grau: Grau[] = [];
  for (let k = kMin; k <= kMax; k += 1) {
    const g = gelesen.grau.get(k);
    if (!g) throw new Error(`Für Bild ${k} kamen keine Graustufen`);
    grau.push(g);
  }

  const rand = f.start.art === 'rand' ? f.start.zustand : null;
  const ankerMaske = rand
    ? rleDekodieren(rand.roh, b * h)
    : f.start.art === 'anker'
      ? f.start.maske
      : null;
  const punkte = rand ? rand.punkte : f.start.art === 'anker' ? f.start.punkte : null;
  const spur = new Spur({
    grau,
    breite: b,
    hoehe: h,
    von: 0,
    bis: kMax - kMin,
    anker: lokal(anfang),
    schluessel: [...schluessel].map(lokal),
    punkte: punkte ? [...punkte] : null,
    ...(ankerMaske ? { ankerMaske } : {}),
    ...(rand ? { fortsetzung: rand.rand } : {}),
    ...(f.wiederBilder !== undefined ? { wiederBilder: f.wiederBilder } : {}),
    rechnen: async (i, gezogen) => {
      const k = kMin + i;
      abbruchPruefen(u.abbruch);
      await u.tor?.offen(f.ruheVorModellMs ?? 0);
      abbruchPruefen(u.abbruch);
      return f.rechnen(k, gelesen.voll.get(k) ?? null, gezogen, u.abbruch);
    },
  });

  /* ---------- Verfolgen, unterbrechbar an jedem Schlüsselbild ---------- */

  const startLokal = lokal(anfang);
  let letzter = startLokal;
  let schritte = 0;
  let unterbrochen = false;
  for (let ziel = spur.naechstes(); ziel !== null; ziel = spur.naechstes()) {
    abbruchPruefen(u.abbruch);
    await u.tor?.offen();
    abbruchPruefen(u.abbruch);
    await spur.schritt();
    letzter = ziel;
    schritte += 1;
    await luft();
    abbruchPruefen(u.abbruch);
    if (ziel !== startLokal && spur.naechstes() !== null && u.unterbrechen?.()) {
      unterbrochen = true;
      break;
    }
  }

  /* ---------- Glätten und ablegen, Bild für Bild ---------- */

  const endeK = kMin + letzter;
  const lo = Math.min(anfang, endeK);
  const hi = Math.max(anfang, endeK);
  const zwischen = new Map<number, Roh>();
  const rohAn = (k: number): Roh => {
    let roh = zwischen.get(k);
    if (!roh) {
      const bild = spur.maskeBild(lokal(k));
      roh = { maske: bild.maske, mitte: bild.mitte, kasten: maskenKasten(bild.maske, b, h) };
      zwischen.set(k, roh);
    }
    return roh;
  };
  const innen = rand?.innen ?? null;
  let innenRoh: Roh | null = null;
  const nachbar = (k: number): Roh | null => {
    if (innen && k === innen.k) {
      if (!innenRoh) {
        const maske = rleDekodieren(innen.roh, b * h);
        innenRoh = { maske, mitte: innen.mitte, kasten: maskenKasten(maske, b, h) };
      }
      return innenRoh;
    }
    if (k < lo || k > hi) return null;
    if (!f.ziele.has(k) && k !== f.laufStart) return null;
    return rohAn(k);
  };
  // Die Schlüsselbilder, die gerechnet sind – in Laufrichtung, für die Punkte eines Tipps.
  const gerechnet = [...schluessel].filter((k) => k >= lo && k <= hi).sort((a, c) => (a - c) * d);
  const leitSchluessel = (k: number): number => {
    let g = anfang;
    for (const s of gerechnet) {
      if ((s - k) * d > 0) break;
      g = s;
    }
    return g;
  };

  let gespeichert = 0;
  for (let k = lo; k <= hi; k += 1) {
    if (!f.ziele.has(k)) continue;
    abbruchPruefen(u.abbruch);
    const mitte = rohAn(k);
    const vor = nachbar(k - 1);
    const nach = nachbar(k + 1);
    const glatt = bildGlaetten(
      mitte,
      vor
        ? {
            maske: vor.maske,
            kasten: vor.kasten,
            dx: vor.mitte && mitte.mitte ? Math.round(mitte.mitte.x - vor.mitte.x) : 0,
            dy: vor.mitte && mitte.mitte ? Math.round(mitte.mitte.y - vor.mitte.y) : 0,
          }
        : null,
      nach
        ? {
            maske: nach.maske,
            kasten: nach.kasten,
            dx: nach.mitte && mitte.mitte ? -Math.round(nach.mitte.x - mitte.mitte.x) : 0,
            dy: nach.mitte && mitte.mitte ? -Math.round(nach.mitte.y - mitte.mitte.y) : 0,
          }
        : null,
      b,
      h,
    );
    let tipp: TippPunkte | undefined;
    let verloren = false;
    if (f.tipp) {
      const g = leitSchluessel(k);
      const liste = spur.punkteAn(lokal(g));
      if (liste && liste.length === 0) verloren = true;
      else if (liste) {
        const m = spur.maskeBild(lokal(g)).mitte;
        tipp = { liste, mx: m?.x ?? 0, my: m?.y ?? 0 };
      }
    }
    let eintrag: KettenEintrag;
    if (verloren) eintrag = { verloren: true, guete: f.pass };
    else {
      const abgelegt = ablegbar(glatt);
      eintrag = {
        rle: abgelegt.rle,
        meta: metaMessen(abgelegt.maske, b, h),
        marke: filmMarke(),
        guete: f.pass,
        ...(tipp ? { punkte: tipp } : {}),
      };
    }
    if (f.kette.ablegen(k, eintrag)) gespeichert += 1;
    zwischen.delete(k - 2);
    await luft();
  }

  /* ---------- Der Rand, an dem das nächste Fenster ansetzt ---------- */

  if (schritte > 0 && !(rand && endeK === anfang)) {
    const stand = spur.randAn(letzter);
    if (stand) {
      const innenK = endeK - d;
      const innenGilt =
        innenK >= lo && innenK <= hi && (f.ziele.has(innenK) || innenK === f.laufStart);
      const endeMitte = spur.maskeBild(letzter).mitte;
      f.kette.randAblegen(f.richtung, f.pass, {
        k: endeK,
        rand: stand,
        roh: ablegbar(spur.maskeAn(letzter)).rle,
        mitte: endeMitte ? { x: endeMitte.x, y: endeMitte.y } : null,
        punkte: spur.punkteAn(letzter),
        innen: innenGilt
          ? {
              k: innenK,
              roh: ablegbar(rohAn(innenK).maske).rle,
              mitte: rohAn(innenK).mitte,
            }
          : null,
      });
    }
  }
  return { bis: endeK, unterbrochen, gespeichert };
}

/* ---------- Kamera ---------- */

/** Die Schritte k−1 → k im Pfad, die der Kamerapfad noch nicht kennt. */
function fehlendeSchritte(pfad: readonly number[], kamera: Kamerapfad): number[] {
  const aufsteigend = [...pfad].sort((a, b) => a - b);
  const raus: number[] = [];
  for (let i = 1; i < aufsteigend.length; i += 1) {
    const k = aufsteigend[i];
    if (k === aufsteigend[i - 1] + 1 && !kamera.schrittBekannt(k)) raus.push(k);
  }
  return raus;
}

async function schritteRechnen(
  schritte: readonly number[],
  grau: ReadonlyMap<number, Grau>,
  u: Umgebung,
): Promise<void> {
  const luft = u.luft ?? luftholen;
  for (const k of schritte) {
    abbruchPruefen(u.abbruch);
    await u.tor?.offen();
    abbruchPruefen(u.abbruch);
    const vorher = grau.get(k - 1);
    const nachher = grau.get(k);
    if (!vorher || !nachher) throw new Error(`Für den Schritt nach Bild ${k} fehlen Graustufen`);
    const { lage, faktor } = schrittMessen(vorher, nachher, u.b);
    u.vorrat.kamera.schrittSetzen(k, lage, faktor);
    await luft();
  }
}

async function kameraRechnen(f: KameraFenster, u: Umgebung): Promise<Fensterergebnis> {
  const schritte = fehlendeSchritte(f.pfad, u.vorrat.kamera);
  const noetig = new Set<number>();
  for (const k of schritte) {
    noetig.add(k - 1);
    noetig.add(k);
  }
  const gelesen = await lesen(
    [...noetig].map((k) => ({ k, grau: true, voll: false })),
    u,
  );
  await schritteRechnen(schritte, gelesen.grau, u);
  return { bis: Math.max(...f.pfad), unterbrochen: false, gespeichert: schritte.length };
}

/* ---------- Tiefe ---------- */

/**
 * Eine Karte auf eine andere Grösse bringen – bilinear, auf die Mitten der
 * Punkte bezogen (wie `tiefeAnwenden` in `bild/tiefe.ts`), damit die Karte
 * beim Verkleinern nicht um einen halben Punkt wandert.
 */
export function karteUmrechnen(daten: NeueDaten, breite: number, hoehe: number): NeueDaten {
  if (daten.breite === breite && daten.hoehe === hoehe) return daten;
  const werte = new Uint8Array(breite * hoehe);
  const { breite: qb, hoehe: qh, werte: q } = daten;
  for (let y = 0; y < hoehe; y += 1) {
    const qy = Math.min(qh - 1, Math.max(0, ((y + 0.5) / hoehe) * qh - 0.5));
    const y0 = Math.floor(qy);
    const y1 = Math.min(qh - 1, y0 + 1);
    const fy = qy - y0;
    for (let x = 0; x < breite; x += 1) {
      const qx = Math.min(qb - 1, Math.max(0, ((x + 0.5) / breite) * qb - 0.5));
      const x0 = Math.floor(qx);
      const x1 = Math.min(qb - 1, x0 + 1);
      const fx = qx - x0;
      const oben = q[y0 * qb + x0] + (q[y0 * qb + x1] - q[y0 * qb + x0]) * fx;
      const unten = q[y1 * qb + x0] + (q[y1 * qb + x1] - q[y1 * qb + x0]) * fx;
      werte[y * breite + x] = Math.round(oben + (unten - oben) * fy);
    }
  }
  return { breite, hoehe, werte };
}

async function tiefeRechnen(f: TiefenFenster, u: Umgebung): Promise<Fensterergebnis> {
  const schritte = fehlendeSchritte(f.pfad, u.vorrat.kamera);
  const karten = f.pfad.filter((k) => f.schluessel.has(k) && !u.vorrat.tiefe.hat(k));
  const noetig = new Map<number, Bedarf>();
  const dazu = (k: number, grau: boolean, voll: boolean) => {
    const alt = noetig.get(k);
    noetig.set(k, { k, grau: grau || (alt?.grau ?? false), voll: voll || (alt?.voll ?? false) });
  };
  for (const k of schritte) {
    dazu(k - 1, true, false);
    dazu(k, true, false);
  }
  for (const k of karten) dazu(k, false, true);
  const gelesen = await lesen([...noetig.values()], u);
  await schritteRechnen(schritte, gelesen.grau, u);

  const { b: gb, h: gh } = grauMass(u.b, u.h);
  let gespeichert = schritte.length;
  let unterbrochen = false;
  for (const [i, k] of karten.entries()) {
    abbruchPruefen(u.abbruch);
    await u.tor?.offen(f.ruheVorModellMs ?? 0);
    abbruchPruefen(u.abbruch);
    const bild = gelesen.voll.get(k);
    if (!bild) throw new Error(`Für die Tiefe an Bild ${k} fehlt das Bild`);
    const daten = await f.tiefeRechnen(k, bild, u.abbruch);
    abbruchPruefen(u.abbruch);
    u.vorrat.tiefe.ablegen(k, karteUmrechnen(daten, gb, gh));
    gespeichert += 1;
    if (i + 1 < karten.length && u.unterbrechen?.()) {
      unterbrochen = true;
      break;
    }
  }
  return { bis: Math.max(...f.pfad), unterbrochen, gespeichert };
}

/* ---------- Wo es weitergeht ---------- */

/** Das nächste Inhaltsfenster eines Laufs in einem Pass. */
export interface InhaltsFensterPlan {
  readonly pfad: readonly number[];
  /** `null`: am Anfang des Laufs ansetzen (Anker oder Neustart). */
  readonly rand: Randzustand | null;
}

/**
 * Wo ein Lauf in einem Pass weitermacht – oder `null`, wenn er fertig ist.
 *
 * Gesucht wird das erste Ziel (in Laufrichtung), das in diesem Pass noch
 * fehlt: im Grobpass jedes ohne Daten, im Feinpass jedes ohne feine. Von dort
 * zurück zum nächsten Rand, an dem ein Fenster dieses Passes endete – oder
 * zum Anfang des Laufs. So deckt dieselbe Regel alles ab:
 *
 * - die Verfolgung geht weiter, wo das letzte Fenster endete;
 * - der Film wird verlängert: weiter vom Rand am alten Ende;
 * - eine frühere Brücke wird Ziel (ein Abschnitt kam dazwischen): ein
 *   Lückenlauf vom letzten Rand davor, bis er auf Gerechnetes trifft;
 * - ein Fenster wurde abgebrochen: noch einmal ab demselben Rand.
 *
 * Nie ab einem Rand hinter dem fehlenden Ziel: Die Spur läuft nur vom Anker
 * weg.
 */
export function inhaltFensterSuchen(
  lauf: Lauf,
  pass: Pass,
  richtung: Richtung,
  kette: Kette,
  groesse: number,
): InhaltsFensterPlan | null {
  const pfad = lauf.pfad;
  const ziele = new Set(lauf.ziele);
  const fehlt = (k: number) => {
    const eintrag = kette.bild(k);
    if (!eintrag) return true;
    return pass === 'fein' && eintrag.guete !== 'fein';
  };
  const erstes = pfad.findIndex((k) => ziele.has(k) && fehlt(k));
  if (erstes < 0) return null;
  let von = 0;
  let rand: Randzustand | null = null;
  for (let i = erstes - 1; i >= 1; i -= 1) {
    const r = kette.rand(richtung, pass, pfad[i]);
    if (r) {
      von = i;
      rand = r;
      break;
    }
  }
  const rest = pfad.slice(von);
  const schluessel = new Set(pass === 'grob' ? lauf.grob : lauf.schluessel);
  const [fenster] = fensterTeilen(rest, schluessel, groesse);
  return { pfad: rest.slice(fenster.von, fenster.bis + 1), rand };
}

/**
 * Das nächste Kamerafenster einer reinen Formmaske – oder `null`, wenn die
 * Lage vom Anker zu jedem Ziel bekannt ist. Es setzt am ersten Schritt an,
 * der entlang des Pfads noch fehlt.
 */
export function kameraFensterSuchen(
  lauf: Lauf,
  kamera: Kamerapfad,
  groesse: number,
): readonly number[] | null {
  const pfad = lauf.pfad;
  const ziele = new Set(lauf.ziele);
  const offen = pfad.findIndex((k) => ziele.has(k) && kamera.lage(lauf.start, k) === null);
  if (offen < 0) return null;
  let i = 1;
  while (i < pfad.length && kamera.schrittBekannt(Math.max(pfad[i - 1], pfad[i]))) i += 1;
  const von = Math.max(0, i - 1);
  return pfad.slice(von, Math.min(pfad.length, von + groesse + 1));
}

/** Ein zusammenhängendes Stück Quellbilder, über das die Tiefe gerechnet wird. */
export interface TiefenLauf {
  /** Aufsteigend, lückenlos. */
  readonly pfad: readonly number[];
  /** Die Filmbilder darin, die eine Tiefe brauchen. */
  readonly ziele: readonly number[];
}

/**
 * Wo die Tiefe gerechnet werden muss: je Ziel k die Karte am Schlüsselbild
 * `abstand · ⌊k / abstand⌋` davor und die Kamera von dort bis k. Die Karten
 * liegen auf einem festen Raster und nicht an einem Anker – so teilen sich
 * alle Tiefenteile aller Masken dieselben.
 */
export function tiefenLaeufe(ziele: readonly number[], abstand: number): TiefenLauf[] {
  const noetig = new Set<number>();
  for (const k of ziele) {
    for (let j = abstand * Math.floor(k / abstand); j <= k; j += 1) noetig.add(j);
  }
  const alle = [...noetig].sort((a, b) => a - b);
  const zielMenge = new Set(ziele);
  const raus: TiefenLauf[] = [];
  let pfad: number[] = [];
  for (const k of alle) {
    if (pfad.length > 0 && k !== pfad[pfad.length - 1] + 1) {
      raus.push({ pfad, ziele: pfad.filter((j) => zielMenge.has(j)) });
      pfad = [];
    }
    pfad.push(k);
  }
  if (pfad.length > 0) raus.push({ pfad, ziele: pfad.filter((j) => zielMenge.has(j)) });
  return raus;
}

/** Hat Bild k seine Tiefe – Karte am Schlüsselbild davor und die Kamera bis hierher? */
export function tiefeBereit(k: number, abstand: number, vorrat: Vorrat): boolean {
  const basis = abstand * Math.floor(k / abstand);
  if (!vorrat.tiefe.hat(basis)) return false;
  return basis === k || vorrat.kamera.lage(basis, k) !== null;
}

/** Das nächste Tiefenfenster – oder `null`, wenn jedes Ziel seine Tiefe hat. */
export function tiefenFensterSuchen(
  laeufe: readonly TiefenLauf[],
  abstand: number,
  vorrat: Vorrat,
  groesse: number,
): { readonly pfad: readonly number[]; readonly schluessel: ReadonlySet<number> } | null {
  for (const lauf of laeufe) {
    const fehlt = lauf.ziele.find((k) => !tiefeBereit(k, abstand, vorrat));
    if (fehlt === undefined) continue;
    const basis = abstand * Math.floor(fehlt / abstand);
    const von = Math.max(0, lauf.pfad.indexOf(basis));
    const rest = lauf.pfad.slice(von);
    const schluessel = new Set(rest.filter((k) => k % abstand === 0));
    const [fenster] = fensterTeilen(rest, schluessel, groesse);
    return { pfad: rest.slice(fenster.von, fenster.bis + 1), schluessel };
  }
  return null;
}
