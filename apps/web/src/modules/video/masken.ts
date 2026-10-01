import {
  BEREICHE_MAX,
  docUnberuehrt,
  neuesDoc,
  wirksamerZuschnitt,
  type Bereich,
  type Bereichston,
  type BildDoc,
  type Maskenteil,
  type Zuschnitt,
} from '../bild/doc.js';
import { filmMarke, formTeilZiehen, type NeueDaten } from './bildweise.js';
import { MAX_BILDER_FILM } from './einstellungen.js';
import { BytesLru } from './lru.js';
import { einrasten, type Punkt } from './objektFolge.js';
import { bildBereich, bildIndex, bildMitte, filmZuBild } from './raster.js';
import { META_LEER, metaLeer, metaMessen, type MaskenMeta } from './rle.js';
import type { Abschnitt } from './schnitt.js';
import { punktVor, type Lage } from './verfolgung.js';

/**
 * Masken für den ganzen Film – als Spuren über die Quellbilder, nicht als
 * Teil eines Abschnitts.
 *
 * Reine Rechnung über Objekte, ohne Video, ohne Modell, ohne React. Was
 * gerechnet werden muss (die Spuren), liefert eine `SpurQuelle` – im Betrieb
 * der `Verfolger` (`verfolger.ts`), in den Tests ein Stapel Karten.
 *
 * # API im Überblick (für die Anbindung in S4/S5)
 *
 * Ausführlicher, mit Aufrufstellen: `masken-api.md` beim Lead.
 *
 * Typen
 * - `Maske` – eine Maske des Films: Name, Schalter, Regler (`anpassung`),
 *   `geltung`, `farbe` (0 … `MASKEN_MAX − 1`) und `teile: SpurTeil[]` in
 *   Wirkreihenfolge. `id` ist zugleich die `Bereich.id` im Editor.
 * - `SpurTeil` – ein Maskenteil über den Film: `id` (= `Maskenteil.id` im
 *   Editor) und `anker: Anker[]`, nach k sortiert, mindestens einer.
 * - `Anker` – wo das Teil eingestellt wurde: `k`, `teil` (genau das
 *   `Maskenteil`, das der Editor dort lieferte) und `id` – der Schlüssel
 *   seiner Ketten in der Verfolgung. Eine Kette läuft vom Anker aus bis zum
 *   Nachbaranker (`ankerKetten`).
 * - `Geltung` – `ganz` | `stuecke` (Quellbereiche `KBereich`, halboffen,
 *   sortiert, disjunkt) | `abschnitte` (lebt mit den Abschnitten mit).
 * - `Bezug` { abschnitte, s } – was eine Geltung zum Auflösen braucht;
 *   `Rahmen` = `Bezug` + Rechengrösse { b, h }.
 * - `SpurQuelle` – was die Verfolgung liefern muss: `kette`, `maske`,
 *   `lage`, `tiefe` (synchron; der `Verfolger` implementiert sie).
 *
 * Zusammensetzen (Editor, Vorschau, Filmbau)
 * - `bildDocAn(clipDoc, masken, quelle, k, art, rahmen, speicher?)` →
 *   `Zusammensetzung` { doc, k, enthalten, fehlend, jenseits, veraltet,
 *   grob, ueberzaehlig }. `art`: `'editor'` (Anker, fein, grob; Tipps mit
 *   Punkten) | `'vorschau'` (dazu Veraltetes und Ersatz) | `'bild'`
 *   (Filmbau: nur fertig, sonst Fehler – auch bei mehr als `BEREICHE_MAX`
 *   Masken; abgeschaltete Masken fehlen). `jenseits`: Masken ohne Daten an
 *   einem Bild hinter der Obergrenze des Films (`imFilm`) – dort wird nie
 *   verfolgt.
 * - `filmStandAn(maske, k, quelle, rahmen)` → `'fein' | 'grob' | 'offen'`:
 *   dieselbe Regel wie `'bild'`, ohne zu bauen – für Fortschritt und
 *   `spurenFertig`.
 * - `Kompositspeicher` – nach Bytes begrenzter Merkzettel für die Teile;
 *   derselbe Stand gibt dasselbe Feld zurück (wichtig für den
 *   Maskenzwischenspeicher im Renderer).
 *
 * Editor zurück in die Masken
 * - `editorAenderung(neu, gezeigt, masken, geloescht, bezug)` → `Routung`
 *   { clipDoc (ohne Bereiche), masken, geloescht, neu, abgelehnt? }. Gibt
 *   bei einer Änderung ohne Wirkung dieselben Objekte zurück.
 *   `gezeigt: Gezeigt` = { k, z, vorSitzung } vom Laden des Bildes.
 * - `bereichePlatz(masken, gezeigt, bezug)` → { max, grund? } für
 *   `bereicheMax` und `bereicheGrund` des BildEditors.
 *
 * Geltung (Bahn, Chips, Griffe)
 * - `giltAn(geltung, k, bezug)`, `geltungStuecke`, `geltungLeer`,
 *   `geltungAbHier`, `geltungBisHier`, `geltungNurAbschnitt`, `griffLage`,
 *   `griffZiehen`, `grenzeVerletzt` (höchstens `BEREICHE_MAX` je Bild,
 *   `MASKEN_MAX` im Film – auch nach Kürzen, Verlängern, Hinzufügen von
 *   Abschnitten zu fragen), `zuvielAn` (wo es doch mehr sind),
 *   `maskeTrennen`, `ankerEntfernen`.
 * - `geltungNachTeilen(masken, altId, neueId)` – nach ✂ PFLICHT: „Nur
 *   Abschnitt n" gilt danach in beiden Hälften.
 *
 * Bahnen
 * - `bahnZustand(abschnitte, maske, quelle, s, mass, px, umfangMs)` → ein
 *   `BAHN`-Wert je Bildpunktspalte; `zustandAn`, `sichtbarAn` je Bild.
 *   Baut dafür keine Masken, Tiefen oder Formen (billig je Neuzeichnen).
 *
 * Verfolgung (für `verfolger.ts`)
 * - `kettenBedarf(maske, F, bezug)` → je Kette `Kettenbedarf`;
 *   `kettenAuftrag(bedarf, { K, fenster, kGrob })` → `kettenPlan(auftrag)`;
 *   `kettenSchluessel`, `jenseitsFuer`, `maskenZiele`.
 *
 * Übergänge
 * - `bereicheUmwandeln` (alte Bereiche in den Abschnittsdokumenten →
 *   Masken), `maskenUmrastern` (neue Bildrate).
 *
 * # Warum die Masken den Abschnitt verlassen
 *
 * Weil eine Maske einem GEGENSTAND folgt und nicht einem Abschnitt. Wer
 * eine Person freistellt und den Film danach dreimal teilt, meint immer noch
 * dieselbe Person – und bekam vorher drei Kopien der Maske, jede mit ihrem
 * eigenen Stellbild, jede beim Filmbau neu verfolgt. Als Spur über die
 * Quellbilder wird sie EINMAL gerechnet, und Teilen, Kürzen, Umstellen und
 * Löschen kosten nichts: Die Spur weiss, was an Quellbild k zu sehen ist,
 * gleich wo k im Film steht.
 *
 * # Warum jedes Teil eigene Anker hat
 *
 * Weil ein Nachbessern sonst alles neu rechnete. Ein Minus-Tipp an Bild 80
 * ist eine Änderung an EINEM Teil; hinge der Anker an der ganzen Maske,
 * liefe auch das unberührte Motiv-Teil (zwei Sekunden je Schlüsselbild)
 * noch einmal über den ganzen Film. Und mehrere Anker je Teil, weil ein
 * Gegenstand, der das Bild verlässt und wiederkommt, nur mit einem zweiten
 * Tipp dort wiedergefunden wird – ohne die richtigen Bilder VOR dem
 * Austritt zu verlieren (siehe „Anwesenheit gewinnt" bei `bildDocAn`).
 */

/* ---------- Grenzen ---------- */

/**
 * Höchstens so viele Masken im ganzen Film.
 *
 * Die Grafikeinheit kann vier je BILD (`BEREICHE_MAX`, siehe `bild/doc.ts`),
 * nicht vier je Film. Acht im Film heisst: Wer in jedem von vier Abschnitten
 * eine andere Person freistellt, hat noch Platz – vorher ging das, weil
 * jeder Abschnitt seine eigenen vier hatte. Mehr als acht Bahnen wären auf
 * einem Telefon nicht mehr zu unterscheiden.
 */
export const MASKEN_MAX = 8;

/**
 * So viele Bilder darf die Spur ohne Modellprüfung überbrücken – danach
 * gilt die Lücke als Szenenschnitt.
 *
 * Zwei Sekunden bei 24 Bildern je Sekunde. Über eine Lücke hinweg schiebt
 * die Spur die Maske nur mit der Suche nach dem Gegenstand, ohne dass ein
 * Modell sie bestätigt; das trägt über ein paar Dutzend Bilder, aber nicht
 * über eine Minute herausgeschnittenen Film. Dahinter lieber ehrlich
 * „verloren" als eine Maske auf dem falschen Gegenstand.
 */
export const BRUECKE_MAX = 48;

/** Über so viele Bilder wird zwischen zwei Ankern überblendet. */
export const UEBERBLENDUNG = 4;

/** Ab diesem Anteil der Bildfläche gilt eine Maske als sichtbar. */
export const SICHTBAR_AB = 0.002;

/** So viele gelöschte Masken hält der Router für ein Rückgängig bereit. */
export const GELOESCHT_MAX = 8;

/* ---------- Die Typen ---------- */

/** Ein Bereich von Quellbildern, halboffen: `[vonK, bisK)`. */
export interface KBereich {
  readonly vonK: number;
  readonly bisK: number;
}

/**
 * Wo im Film eine Maske gilt.
 *
 * - `ganz`: überall.
 * - `stuecke`: in diesen Quellbildern – sortiert, disjunkt, nicht leer.
 *   „Ab hier" und „Bis hier" legen sie in FILMreihenfolge an (siehe
 *   `geltungAbHier`), gespeichert werden Quellbilder.
 * - `abschnitte`: in den Bildern, die diese Abschnitte GERADE zeigen – wird
 *   ein Abschnitt verlängert, gilt sie am neuen Stück mit; wird er gelöscht,
 *   gilt sie dort nirgends mehr. So wirkt „Nur Abschnitt 2" wie das frühere
 *   Freistellen je Abschnitt.
 */
export type Geltung =
  | { readonly art: 'ganz' }
  | { readonly art: 'stuecke'; readonly stuecke: readonly KBereich[] }
  | { readonly art: 'abschnitte'; readonly ids: readonly string[] };

export interface Anker {
  /** Einmal vergeben, nie geändert – der Schlüssel der Ketten dieses Ankers. */
  readonly id: string;
  /** Das Quellbild, an dem eingestellt wurde. */
  readonly k: number;
  /** Genau das Teil, das der Editor dort lieferte (Rechengrösse). */
  readonly teil: Maskenteil;
  /**
   * Die Maske an `k` muss neu gerechnet werden – Toleranz, Verfahren oder
   * „mit Netz" wurden an einem ANDEREN Anker desselben Teils geändert. Dann
   * gilt am Anker, was die Kette an `k` liefert, nicht `teil.alpha`.
   */
  readonly neuRechnen?: true;
}

export interface SpurTeil {
  /** Die `Maskenteil.id` im Editor – nach „Hier trennen" eine andere als `anker[i].teil.id`. */
  readonly id: string;
  /** Mindestens einer, nach `k` sortiert, je `k` höchstens einer. */
  readonly anker: readonly Anker[];
}

export interface Maske {
  /** Die `Bereich.id` im Editor. */
  readonly id: string;
  readonly name: string;
  readonly aktiv: boolean;
  readonly anpassung: Bereichston;
  readonly geltung: Geltung;
  /** Die letzte eingeschränkte Geltung – für den Wechsel „Ganzer Film" ↔ „Zeitraum". */
  readonly zuletzt?: Exclude<Geltung, { readonly art: 'ganz' }>;
  /** 0 … `MASKEN_MAX − 1` – die Farbe der Bahn. */
  readonly farbe: number;
  /** In Wirkreihenfolge, wie `Bereich.teile`. */
  readonly teile: readonly SpurTeil[];
}

/** Was es braucht, um eine Geltung aufzulösen. */
export interface Bezug {
  readonly abschnitte: readonly Abschnitt[];
  /** Die Schrittweite des Rasters, `1000 / bildrate`. */
  readonly s: number;
}

/** Dazu die Rechengrösse – für alles, was Masken baut oder vermisst. */
export interface Rahmen extends Bezug {
  readonly b: number;
  readonly h: number;
  /** Die Obergrenze des Films in Bildern – ohne Angabe `MAX_BILDER_FILM`. */
  readonly maxBilder?: number;
}

/* ---------- Kennungen ---------- */

let zaehler = 0;
function kennung(vorsatz: string): string {
  zaehler += 1;
  return `${vorsatz}${Date.now().toString(36)}${zaehler.toString(36)}`;
}

/** Eine neue Ankerkennung – eindeutig in dieser Sitzung. */
export function ankerKennung(): string {
  return kennung('k');
}

/** Eine neue Maskenkennung – „m…", damit sie nie einer `Bereich.id` des Editors („b…") gleicht. */
export function maskenKennung(): string {
  return kennung('m');
}

/** Eine neue Teilkennung – „s…" (Spur), aus demselben Grund. */
export function teilKennung(): string {
  return kennung('s');
}

/**
 * Der Anker für ein Teil an Bild k – für dasselbe Teilobjekt immer derselbe.
 *
 * # Warum je Objekt gemerkt
 *
 * Weil der Editor jede Änderung meldet, auch die nächste an einem anderen
 * Regler, und dabei das schon geänderte Teil wieder mitschickt. Bekäme es
 * jedes Mal einen neuen Anker, begänne seine Verfolgung bei jedem
 * Reglerschritt von vorn. Und ein Rückgängig im Editor bringt das Objekt von
 * vorher zurück – und damit den Anker, dessen Kette schon gerechnet ist.
 */
const ankerJeTeil = new WeakMap<Maskenteil, Anker>();
export function ankerFuer(k: number, teil: Maskenteil): Anker {
  const alt = ankerJeTeil.get(teil);
  if (alt && alt.k === k) return alt;
  const neu: Anker = { id: ankerKennung(), k, teil };
  ankerJeTeil.set(teil, neu);
  return neu;
}

/** Einen Anker einsetzen: ersetzt den an derselben Stelle, sonst einsortiert. */
export function ankerSetzen(anker: readonly Anker[], neu: Anker): readonly Anker[] {
  const raus = anker.filter((a) => a.k !== neu.k);
  raus.push(neu);
  raus.sort((a, b) => a.k - b.k);
  return raus;
}

/* ---------- Geltung ---------- */

const GANZ: readonly KBereich[] = [
  { vonK: Number.NEGATIVE_INFINITY, bisK: Number.POSITIVE_INFINITY },
];

/** Sortiert, verschmilzt Überlappendes und Angrenzendes, lässt Leeres weg. */
export function stueckeNormal(stuecke: readonly KBereich[]): KBereich[] {
  const sortiert = stuecke
    .filter((st) => st.bisK > st.vonK)
    .slice()
    .sort((a, b) => a.vonK - b.vonK);
  const raus: KBereich[] = [];
  for (const st of sortiert) {
    const letzt = raus[raus.length - 1];
    if (letzt && st.vonK <= letzt.bisK) {
      if (st.bisK > letzt.bisK) raus[raus.length - 1] = { vonK: letzt.vonK, bisK: st.bisK };
    } else {
      raus.push({ vonK: st.vonK, bisK: st.bisK });
    }
  }
  return raus;
}

/** Die Schnittmenge zweier normaler Listen. */
export function stueckeSchnitt(a: readonly KBereich[], b: readonly KBereich[]): KBereich[] {
  const raus: KBereich[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const von = Math.max(a[i].vonK, b[j].vonK);
    const bis = Math.min(a[i].bisK, b[j].bisK);
    if (bis > von) raus.push({ vonK: von, bisK: bis });
    if (a[i].bisK < b[j].bisK) i += 1;
    else j += 1;
  }
  return raus;
}

/** `a` ohne `b` – beide normal. */
export function stueckeOhne(a: readonly KBereich[], b: readonly KBereich[]): KBereich[] {
  const raus: KBereich[] = [];
  for (const st of a) {
    let von = st.vonK;
    for (const weg of b) {
      if (weg.bisK <= von || weg.vonK >= st.bisK) continue;
      if (weg.vonK > von) raus.push({ vonK: von, bisK: weg.vonK });
      von = Math.max(von, weg.bisK);
    }
    if (von < st.bisK) raus.push({ vonK: von, bisK: st.bisK });
  }
  return raus;
}

function stueckeEnthalten(stuecke: readonly KBereich[], k: number): boolean {
  let lo = 0;
  let hi = stuecke.length - 1;
  while (lo <= hi) {
    const mitte = (lo + hi) >> 1;
    const st = stuecke[mitte];
    if (k < st.vonK) hi = mitte - 1;
    else if (k >= st.bisK) lo = mitte + 1;
    else return true;
  }
  return false;
}

function abschnittBereich(abschnitt: Abschnitt, s: number): KBereich {
  const { k0, k1 } = bildBereich(abschnitt, s);
  return { vonK: k0, bisK: k1 };
}

/**
 * Die Geltung als Quellbereiche – sortiert und disjunkt.
 *
 * `ganz` wird zu EINEM unendlichen Bereich; wer daraus endliche Grenzen
 * braucht, schneidet mit dem Film (siehe `geltungAbHier`).
 */
export function geltungStuecke(geltung: Geltung, bezug: Bezug): readonly KBereich[] {
  if (geltung.art === 'ganz') return GANZ;
  if (geltung.art === 'stuecke') return geltung.stuecke;
  return stueckeNormal(
    bezug.abschnitte
      .filter((abschnitt) => geltung.ids.includes(abschnitt.id))
      .map((abschnitt) => abschnittBereich(abschnitt, bezug.s)),
  );
}

/** Gilt die Maske an Quellbild k? Halboffen, wie alles hier. */
export function giltAn(geltung: Geltung, k: number, bezug: Bezug): boolean {
  if (geltung.art === 'ganz') return true;
  if (geltung.art === 'stuecke') return stueckeEnthalten(geltung.stuecke, k);
  for (const abschnitt of bezug.abschnitte) {
    if (!geltung.ids.includes(abschnitt.id)) continue;
    const { k0, k1 } = bildBereich(abschnitt, bezug.s);
    if (k >= k0 && k < k1) return true;
  }
  return false;
}

/**
 * Gilt die Maske nirgends mehr? Etwa „Nur Abschnitt 2", nachdem Abschnitt 2
 * gelöscht wurde – dann braucht die Bahn einen Hinweis statt eines leeren
 * Streifens.
 */
export function geltungLeer(geltung: Geltung, bezug: Bezug): boolean {
  return geltung.art !== 'ganz' && geltungStuecke(geltung, bezug).length === 0;
}

/** „Nur Abschnitt n". */
export function geltungNurAbschnitt(id: string): Geltung {
  return { art: 'abschnitte', ids: [id] };
}

/**
 * Nach dem Teilen eines Abschnitts (✂): Wo eine Maske in `altId` galt, gilt
 * sie danach auch in `neueId` – der Hälfte, die `abschnittTeilen` die neue
 * Kennung gab. Dieselbe Liste, wenn keine Maske betroffen ist.
 *
 * # Warum das der Aufrufer tun muss
 *
 * Weil „Nur Abschnitt 2" nach Kennung auflöst und eine der beiden Hälften
 * eine neue bekommt (welche, hängt am Stellbild). Ohne diesen Schritt galt
 * die Maske nach dem Teilen nur noch in der einen Hälfte – ohne Hinweis und
 * auch im Film. Vorher, mit Masken je Abschnitt, behielten beide Hälften
 * sie; und eine Geltung, die dem Abschnitt folgt, soll ihm auch durch das
 * Teilen folgen. `useSchnitt.teilen` ruft das mit derselben Kennung, die es
 * `abschnittTeilen` gibt.
 */
export function geltungNachTeilen(
  masken: readonly Maske[],
  altId: string,
  neueId: string,
): readonly Maske[] {
  const dazu = <G extends Geltung>(g: G): G =>
    g.art === 'abschnitte' && g.ids.includes(altId) && !g.ids.includes(neueId)
      ? ({ ...g, ids: [...g.ids, neueId] } as G)
      : g;
  let geaendert = false;
  const neu = masken.map((maske) => {
    const geltung = dazu(maske.geltung);
    const zuletzt = maske.zuletzt ? dazu(maske.zuletzt) : undefined;
    if (geltung === maske.geltung && zuletzt === maske.zuletzt) return maske;
    geaendert = true;
    return { ...maske, geltung, ...(zuletzt ? { zuletzt } : {}) };
  });
  return geaendert ? neu : masken;
}

/* ---------- Stellen im Film ---------- */

/**
 * Zeigt der Film Quellbild k – an einer Stelle vor seiner Obergrenze? Genau
 * die Bilder, die `F` enthält (`filmRaster(…).menge`), ohne F zu bauen.
 *
 * Wo nicht, wird auch nie verfolgt: Eine Maske, der dort Daten fehlen, wird
 * nicht „noch verfolgt" – sie ist dort „nicht im Film" (siehe
 * `Zusammensetzung.jenseits`).
 */
export function imFilm(k: number, bezug: Bezug, maxBilder = MAX_BILDER_FILM): boolean {
  let stelle = 0;
  for (const abschnitt of bezug.abschnitte) {
    if (stelle >= maxBilder) return false;
    const { k0, k1 } = bildBereich(abschnitt, bezug.s);
    if (k >= k0 && k < k1 && stelle + (k - k0) < maxBilder) return true;
    stelle += k1 - k0;
  }
  return false;
}

/**
 * Die Bilder des Films durchgezählt: Abschnitt n zeigt die Stellen
 * `anfang[n] …`, und dort die Rasterbilder `k0[n] … k1[n] − 1`.
 */
interface Stellen {
  readonly anfang: readonly number[];
  readonly k0: readonly number[];
  readonly k1: readonly number[];
  readonly gesamt: number;
}

function stellenVon(bezug: Bezug): Stellen {
  const anfang: number[] = [];
  const k0: number[] = [];
  const k1: number[] = [];
  let gesamt = 0;
  for (const abschnitt of bezug.abschnitte) {
    const bereich = bildBereich(abschnitt, bezug.s);
    anfang.push(gesamt);
    k0.push(bereich.k0);
    k1.push(bereich.k1);
    gesamt += bereich.k1 - bereich.k0;
  }
  return { anfang, k0, k1, gesamt };
}

/** Die Quellbilder der Filmstellen `von … bis` (einschliesslich), in Filmreihenfolge gesammelt. */
function filmStrecke(stellen: Stellen, von: number, bis: number): KBereich[] {
  const raus: KBereich[] = [];
  for (let n = 0; n < stellen.anfang.length; n += 1) {
    const erste = stellen.anfang[n];
    const letzte = erste + stellen.k1[n] - stellen.k0[n] - 1;
    const lo = Math.max(von, erste);
    const hi = Math.min(bis, letzte);
    if (hi < lo) continue;
    raus.push({ vonK: stellen.k0[n] + lo - erste, bisK: stellen.k0[n] + hi - erste + 1 });
  }
  return stueckeNormal(raus);
}

/** Die erste (oder letzte) Filmstelle, an der die Geltung greift – `null`, wenn keine. */
function randStelle(
  geltung: Geltung,
  bezug: Bezug,
  stellen: Stellen,
  ende: boolean,
): number | null {
  const stuecke = geltungStuecke(geltung, bezug);
  const reihe = stellen.anfang.map((_, n) => n);
  if (ende) reihe.reverse();
  for (const n of reihe) {
    const drin = stueckeSchnitt(stuecke, [{ vonK: stellen.k0[n], bisK: stellen.k1[n] }]);
    if (drin.length === 0) continue;
    const k = ende ? drin[drin.length - 1].bisK - 1 : drin[0].vonK;
    return stellen.anfang[n] + k - stellen.k0[n];
  }
  return null;
}

function stelleAn(bezug: Bezug, stellen: Stellen, filmMs: number): number | null {
  const ort = filmZuBild(bezug.abschnitte, filmMs, bezug.s);
  if (!ort) return null;
  return stellen.anfang[ort.nummer] + ort.k - stellen.k0[ort.nummer];
}

/**
 * „Ab hier": von der Wiedergabestelle bis dahin, wo die Maske im FILM
 * zuletzt gilt – bei `ganz` bis zum Filmende.
 *
 * # Warum in Filmreihenfolge
 *
 * Weil der Anwender den Film sieht und nicht die Quelle. Steht Abschnitt B
 * (Quelle 60 – 65 s) vor Abschnitt A (0 – 5 s) und der Kopf in B, heisst
 * „ab hier" auch A – obwohl A in der Quelle VOR dem Kopf liegt. Ein einziger
 * Quellbereich hätte A verloren, und die Bahn zeigte ein Loch, das zu „ab
 * hier" nicht passt. Gespeichert wird trotzdem in Quellbildern: die
 * Vereinigung dessen, was diese Filmstellen zeigen.
 *
 * Endet die Maske vor dem Kopf, bleibt wenigstens sein Bild – wie bei zwei
 * übereinandergeschobenen Griffen.
 */
export function geltungAbHier(geltung: Geltung, bezug: Bezug, filmMs: number): Geltung {
  const stellen = stellenVon(bezug);
  const hier = stelleAn(bezug, stellen, filmMs);
  if (hier === null) return geltung;
  let ende =
    geltung.art === 'ganz' ? stellen.gesamt - 1 : randStelle(geltung, bezug, stellen, true);
  if (ende === null || ende < hier) ende = hier;
  return { art: 'stuecke', stuecke: filmStrecke(stellen, hier, ende) };
}

/** „Bis hier": von dort, wo die Maske im Film zuerst gilt, bis einschliesslich zum Kopf. */
export function geltungBisHier(geltung: Geltung, bezug: Bezug, filmMs: number): Geltung {
  const stellen = stellenVon(bezug);
  const hier = stelleAn(bezug, stellen, filmMs);
  if (hier === null) return geltung;
  let anfang = geltung.art === 'ganz' ? 0 : randStelle(geltung, bezug, stellen, false);
  if (anfang === null || anfang > hier) anfang = hier;
  return { art: 'stuecke', stuecke: filmStrecke(stellen, anfang, hier) };
}

/* ---------- Wie viele Masken an einem Bild ---------- */

/**
 * Die meisten Masken, die an EINEM Quellbild zugleich gelten – und wo.
 *
 * Gezählt werden auch abgeschaltete: Der Editor zeigt sie an ihrem Bild mit
 * (sonst liesse sich der Haken nicht wieder setzen), und er fasst
 * höchstens `BEREICHE_MAX` Bereiche. Eine Grenze nur für die
 * eingeschalteten liesse einen Haken zu, der dann nicht wirken dürfte.
 *
 * Gezählt wird über alle Quellbilder, nicht nur über die des Films: Wer
 * einen Abschnitt später verlängert, holte sonst über eine Maske mit
 * `ganz` oder `stuecke` eine fünfte ins Bild.
 *
 * Für `abschnitte` hilft das nicht: Diese Geltung WÄCHST mit ihrem
 * Abschnitt, und ein Verlängern ist für solche Masken eine Änderung der
 * Geltung. `grenzeVerletzt` gehört deshalb auch hinter jedes Kürzen,
 * Verlängern und Hinzufügen von Abschnitten (siehe `masken-api.md`) – und
 * `bildDocAn` wirft im Filmbau, falls es doch einmal mehr als
 * `BEREICHE_MAX` wären, statt still eine wegzulassen.
 */
export function hoechstJeBild(
  masken: readonly Maske[],
  bezug: Bezug,
): { anzahl: number; k: number } {
  const ereignisse: [number, number][] = [];
  for (const maske of masken) {
    for (const st of geltungStuecke(maske.geltung, bezug)) {
      ereignisse.push([st.vonK, 1], [st.bisK, -1]);
    }
  }
  // Halboffen: An derselben Stelle endet erst das Alte, dann beginnt das Neue.
  ereignisse.sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] < b[0] ? -1 : 1));
  let jetzt = 0;
  let anzahl = 0;
  let k = 0;
  for (const [stelle, schritt] of ereignisse) {
    jetzt += schritt;
    if (jetzt > anzahl) {
      anzahl = jetzt;
      k = Number.isFinite(stelle) ? stelle : 0;
    }
  }
  return { anzahl, k };
}

/**
 * Warum diese Masken so nicht gehen – oder `null`.
 *
 * Ein ganzer Satz, weil er als Hinweis erscheint: nach einer abgelehnten
 * Geltung in der Bahn, nach einer abgelehnten neuen Maske im Editor.
 */
export function grenzeVerletzt(masken: readonly Maske[], bezug: Bezug): string | null {
  if (masken.length > MASKEN_MAX) {
    return `Höchstens ${MASKEN_MAX} Masken im ganzen Film – lösch eine, wenn du eine neue brauchst.`;
  }
  const { anzahl, k } = hoechstJeBild(masken, bezug);
  if (anzahl > BEREICHE_MAX) {
    return (
      `Bei ${quellZeitText(bildMitte(k, bezug.s))} wirkten dann ${anzahl} Masken – an einem Bild ` +
      `gehen höchstens ${BEREICHE_MAX}. Grenz eine in der Zeitleiste ein oder lösch sie.`
    );
  }
  return null;
}

/**
 * Wo mehr als `BEREICHE_MAX` Masken zugleich gelten – als Quellbereiche,
 * sortiert. Für die Bahn: Dort fehlt dem Editor und dem Film eine Maske,
 * und das soll man sehen, bevor der Filmbau daran scheitert.
 */
export function zuvielAn(masken: readonly Maske[], bezug: Bezug): KBereich[] {
  const ereignisse: [number, number][] = [];
  for (const maske of masken) {
    for (const st of geltungStuecke(maske.geltung, bezug)) {
      ereignisse.push([st.vonK, 1], [st.bisK, -1]);
    }
  }
  ereignisse.sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] < b[0] ? -1 : 1));
  const raus: KBereich[] = [];
  let jetzt = 0;
  let seit: number | null = null;
  for (const [stelle, schritt] of ereignisse) {
    jetzt += schritt;
    if (jetzt > BEREICHE_MAX && seit === null) seit = stelle;
    else if (jetzt <= BEREICHE_MAX && seit !== null) {
      if (stelle > seit) raus.push({ vonK: seit, bisK: stelle });
      seit = null;
    }
  }
  return stueckeNormal(raus);
}

/**
 * Wie viele Bereiche der Editor an diesem Bild haben darf – `bereicheMax`
 * – und, wenn keiner mehr dazukommen darf, warum (`bereicheGrund`).
 *
 * Eine neue Maske gilt im ganzen Film. Sie darf also nur entstehen, wenn im
 * Film noch Platz ist UND an keinem Bild schon `BEREICHE_MAX` Masken gelten
 * – auch an einem, das der Editor gerade nicht zeigt.
 *
 * Mit `masken` nach jeder Routung neu zu rufen, mit demselben `gezeigt`:
 * Gezählt wird, was der Editor JETZT hat – das Ausgegebene und was er in
 * dieser Sitzung angelegt hat. Nur das Ausgegebene zu zählen, nähme ihm
 * nach jeder neuen Maske einen Platz zu viel.
 */
export function bereichePlatz(
  masken: readonly Maske[],
  gezeigt: Gezeigt,
  bezug: Bezug,
): { max: number; grund?: string } {
  const { imEditor, frei, imFilm } = platzZaehlen(masken, gezeigt, bezug);
  const z = gezeigt.z;
  if (frei > 0 || imEditor >= BEREICHE_MAX) {
    return { max: Math.min(BEREICHE_MAX, imEditor + frei) };
  }
  const warten =
    z.fehlend.length > 0
      ? `${z.fehlend.length === 1 ? 'Eine Maske wirkt' : `${z.fehlend.length} Masken wirken`} hier noch nicht – sie werden verfolgt. `
      : '';
  const draussen =
    z.jenseits.length > 0
      ? `${z.jenseits.length === 1 ? 'Eine Maske fehlt' : `${z.jenseits.length} Masken fehlen`} hier – das Bild liegt hinter dem Ende des Films. `
      : '';
  const grund =
    imFilm <= 0
      ? `${MASKEN_MAX} Masken im Film – mehr gehen nicht. In der Zeitleiste eine löschen.`
      : `An einer Stelle im Film wirken schon ${BEREICHE_MAX} Masken – eine neue gälte auch dort. In der Zeitleiste eine eingrenzen oder löschen.`;
  return { max: imEditor, grund: warten + draussen + grund };
}

/** Die Zahlen hinter `bereichePlatz` und `bereichNeuMoeglich`. */
function platzZaehlen(
  masken: readonly Maske[],
  gezeigt: Gezeigt,
  bezug: Bezug,
): { imEditor: number; frei: number; imFilm: number } {
  const vorher = new Set(gezeigt.vorSitzung.map((maske) => maske.id));
  const imEditor = masken.filter(
    (maske) => gezeigt.z.enthalten.has(maske.id) || imEditorAngelegt(maske, gezeigt.k, vorher),
  ).length;
  const imFilm = MASKEN_MAX - masken.length;
  const anEinemBild = BEREICHE_MAX - hoechstJeBild(masken, bezug).anzahl;
  return { imEditor, frei: Math.max(0, Math.min(imFilm, anEinemBild)), imFilm };
}

/**
 * Darf der Editor an diesem Bild noch einen Bereich anlegen?
 *
 * Für den Knopf „＋ Bereich" in der Zeitleiste: Er soll fehlen, wo der
 * Editor ihn nicht erfüllen könnte, statt eine Absage zu bringen.
 */
export function bereichNeuMoeglich(
  masken: readonly Maske[],
  gezeigt: Gezeigt,
  bezug: Bezug,
): boolean {
  const { imEditor, frei } = platzZaehlen(masken, gezeigt, bezug);
  return frei > 0 && imEditor < BEREICHE_MAX;
}

/**
 * Von wo bis wo im FILM eine Geltung gilt – oder `null`, wenn nirgends.
 *
 * Nur die äusseren Enden: Hat die Geltung mehrere Stücke, steht dazwischen
 * eine Lücke, die ein Satz wie „von 1,6 s bis 3,6 s" nicht abbildet. Er ist
 * für den Hinweis gedacht, wo man hinspringen kann, nicht für die Bahn.
 */
export function geltungImFilm(
  geltung: Geltung,
  bezug: Bezug,
): { vonMs: number; bisMs: number } | null {
  const stuecke = geltungStuecke(geltung, bezug);
  let von = Infinity;
  let bis = -Infinity;
  let start = 0;
  for (const abschnitt of bezug.abschnitte) {
    const { k0, k1 } = bildBereich(abschnitt, bezug.s);
    for (const st of stueckeSchnitt([{ vonK: k0, bisK: k1 }], stuecke)) {
      von = Math.min(von, start + (st.vonK - k0) * bezug.s);
      bis = Math.max(bis, start + (st.bisK - k0) * bezug.s);
    }
    start += Math.max(0, abschnitt.bisMs - abschnitt.vonMs);
  }
  return von < bis ? { vonMs: von, bisMs: bis } : null;
}

/* ---------- Ketten: was die Verfolgung rechnet ---------- */

/** Die Grenzen einer Kette: vom Anker bis vor den Nachbaranker. */
export interface KettenGrenze {
  readonly anker: Anker;
  /** Kleinstes Bild, das die Kette rückwärts erreicht, einschliesslich. */
  readonly lo: number;
  /** Grösstes Bild, das sie vorwärts erreicht, einschliesslich. */
  readonly hi: number;
}

/**
 * Je Anker eine Kette, begrenzt durch die Nachbaranker desselben Teils.
 *
 * Zwischen zwei Ankern laufen BEIDE Ketten – die eine vorwärts, die andere
 * rückwärts –, und das Zusammensetzen entscheidet je Bild (siehe
 * `bildDocAn`). Ein neuer Anker dazwischen kürzt die Ketten seiner
 * Nachbarn nur; was sie schon gerechnet haben, bleibt gültig.
 */
export function ankerKetten(teil: SpurTeil): KettenGrenze[] {
  return teil.anker.map((anker, i) => ({
    anker,
    lo: i > 0 ? teil.anker[i - 1].k + 1 : Number.NEGATIVE_INFINITY,
    hi: i < teil.anker.length - 1 ? teil.anker[i + 1].k - 1 : Number.POSITIVE_INFINITY,
  }));
}

/**
 * Der Schlüssel einer Kette im Vorrat der Verfolgung.
 *
 * OHNE Masken- und Teilkennung: „Hier trennen" und ein Rückgängig im Editor
 * teilen sich so die schon gerechneten Ketten. Mit Raster, Rechengrösse und
 * Schlüsselabstand: Ändert sich eines davon, gilt nichts Gerechnetes mehr.
 */
export function kettenSchluessel(anker: Anker, s: number, b: number, h: number, K: number): string {
  return `${anker.id}|${s}|${b}x${h}|K${K}`;
}

/**
 * Was jenseits eines Szenenschnitts mit einem Teil geschieht.
 *
 * - `neustart`: „Person" nimmt dort die frische Maske ohne Vergleich – wie
 *   an einem Anker. Eine andere Person ist immer noch „Person".
 * - `verloren`: Antippen, Motiv, BiRefNet – die Spur weiss nicht, welcher
 *   Gegenstand es jenseits wäre. Die Bahn sagt „hier neu antippen".
 * - `vorlaeufig`: Formen bleiben an ihren Ankerkoordinaten.
 * - `null`: Tiefe hat keine Kette, sie gehört zur Szene.
 */
export type Jenseits = 'neustart' | 'verloren' | 'vorlaeufig';

export function jenseitsFuer(teil: Maskenteil): Jenseits | null {
  if (teil.art === 'tiefe') return null;
  if (teil.art === 'netz') return teil.netz === 'person' ? 'neustart' : 'verloren';
  if (teil.art === 'tipp') return 'verloren';
  return 'vorlaeufig';
}

/** `Z`: die Filmbilder `F`, an denen die Maske gilt – aufsteigend. */
export function maskenZiele(maske: Maske, F: readonly number[], bezug: Bezug): number[] {
  if (maske.geltung.art === 'ganz') return F.slice();
  return F.filter((k) => giltAn(maske.geltung, k, bezug));
}

export interface Kettenbedarf {
  readonly maske: Maske;
  readonly teil: SpurTeil;
  readonly grenze: KettenGrenze;
  /**
   * - `inhalt`: eine Spur mit Modell an den Schlüsselbildern (Netz, Tipp);
   *   liefert `SpurQuelle.kette`/`maske`.
   * - `kamera`: nur Graustufen und Kamerapfad, kein Modell (Formen einer
   *   reinen Formmaske); liefert `SpurQuelle.lage(anker.k, k)`.
   */
  readonly art: 'inhalt' | 'kamera';
  /** `Z ∩ [lo, hi]`. */
  readonly ziele: readonly number[];
  readonly jenseits: Jenseits;
}

/**
 * Alle Ketten, die eine Maske braucht – je Inhaltsteil je Anker, dazu je
 * Formteil je Anker, wenn die Maske NUR aus Formen besteht.
 *
 * Es fehlen mit Absicht:
 * - Tiefe: Ihre Karten sind geteilt und hängen an keinem Anker (siehe
 *   `SpurQuelle.tiefe`).
 * - Formen in einer Maske mit Inhalt: Sie folgen dem Inhalt, und dessen
 *   Kette wird ohnehin gerechnet (siehe `formAufloesen`).
 *
 * # Die Ankerbilder der Formen sind Ziele des Leitteils
 *
 * Eine Form in einer Maske mit Inhalt fragt den Inhalt an ZWEI Bildern: an
 * k, und am Bild, an dem sie gemalt wurde – um den Weg des Schwerpunkts
 * dazwischen. Das zweite liegt oft nicht in `Z`: Der Abschnitt wurde danach
 * gekürzt, die Geltung eingegrenzt, oder der Inhalt wurde zwischen seinem
 * Anker und dem der Form neu angetippt, und die neue Kette hatte das Bild
 * nie als Ziel. Ohne es fehlte die ganze Maske an JEDEM Bild – und der
 * Fortschritt, der Formen in solchen Masken nicht fragte, meldete trotzdem
 * „fertig", bis der Filmbau scheiterte. Deshalb stehen diese Bilder in den
 * Zielen der Kette, die sie abdeckt: gerechnet und abgelegt, nur gezeigt
 * werden sie nie (sie sind kein Bild des Films).
 */
export function kettenBedarf(maske: Maske, F: readonly number[], bezug: Bezug): Kettenbedarf[] {
  const ziele = maskenZiele(maske, F, bezug);
  const leit = leitTeil(maske);
  const raus: Kettenbedarf[] = [];
  for (const teil of maske.teile) {
    const basis = teil.anker[0].teil;
    const jenseits = jenseitsFuer(basis);
    if (!jenseits) continue;
    const art = basis.art === 'netz' || basis.art === 'tipp' ? 'inhalt' : 'kamera';
    if (art === 'kamera' && leit) continue;
    const teilZiele = teil === leit ? formAnkerDazu(maske, ziele) : ziele;
    for (const grenze of ankerKetten(teil)) {
      raus.push({
        maske,
        teil,
        grenze,
        art,
        ziele: teilZiele.filter((k) => k >= grenze.lo && k <= grenze.hi),
        jenseits,
      });
    }
  }
  return raus;
}

/** `ziele` samt den Ankerbildern aller Formteile der Maske – aufsteigend, ohne Doppelte. */
function formAnkerDazu(maske: Maske, ziele: readonly number[]): readonly number[] {
  const dazu: number[] = [];
  for (const teil of maske.teile) {
    const art = teil.anker[0].teil.art;
    if (art !== 'verlauf' && art !== 'radial' && art !== 'pinsel') continue;
    for (const anker of teil.anker) dazu.push(anker.k);
  }
  if (dazu.length === 0) return ziele;
  return [...new Set([...ziele, ...dazu])].sort((a, b) => a - b);
}

/** Ein Stück Pfad, das in einem Zug gerechnet wird: `pfad[von] … pfad[bis]`. */
export interface Fenster {
  /** Der Rand, an dem es anschliesst – am Anfang der Start des Laufs. */
  readonly von: number;
  /** Ein Schlüsselbild oder das Ende des Pfads. */
  readonly bis: number;
}

/** Ein zusammenhängender Lauf der Spur in einer Richtung. */
export interface Lauf {
  /** Wo er beginnt: der Anker – oder bei `neustart` das erste Bild jenseits eines Schnitts. */
  readonly start: number;
  readonly neustart: boolean;
  /**
   * Braucht der Start selbst einen Modellauf? Bei einem Neustart und bei
   * einem Anker mit `neuRechnen` – sonst ist seine Maske die des Ankers.
   */
  readonly startRechnen: boolean;
  /** Jedes Quellbild vom Start bis zum letzten Ziel, in Laufrichtung, Schritt ±1. */
  readonly pfad: readonly number[];
  /**
   * Die Bilder, deren Masken gespeichert werden, in Laufrichtung. Den Start
   * nur, wenn er gerechnet wird und ein Ziel ist – beim Anker mit
   * `neuRechnen` nur vorwärts: Dort sucht das Zusammensetzen seine Maske
   * (siehe `SpurQuelle.kette`).
   */
  readonly ziele: readonly number[];
  /**
   * Die Schlüsselbilder im Feinpass, in Laufrichtung, der Start zuerst. Am
   * Start läuft ein Modell nur mit `startRechnen`. Meist Ziele; dazu
   * Prüfbilder in langen Filmstrecken ohne Ziel (siehe `kettenPlan`), die
   * nicht abgelegt werden.
   */
  readonly schluessel: readonly number[];
  /** Die im Grobpass – eine Teilmenge von `schluessel`. Leer ohne Grobpass. */
  readonly grob: readonly number[];
  readonly fenster: readonly Fenster[];
  readonly grobFenster: readonly Fenster[];
}

export interface Richtungsplan {
  readonly laeufe: readonly Lauf[];
  /**
   * Ziele jenseits eines Szenenschnitts, die NICHT gerechnet werden – dort
   * gilt `verloren` (Inhalt) oder `vorlaeufig` (Formen).
   */
  readonly ohne: readonly number[];
}

export interface KettenPlan {
  readonly anker: number;
  readonly vor: Richtungsplan;
  readonly rueck: Richtungsplan;
}

export interface KettenAuftrag {
  readonly anker: number;
  /** Der Anker hat `neuRechnen`: Seine Maske wird am Start erst gerechnet. */
  readonly ankerNeu?: boolean;
  /** Grenzen einschliesslich – ohne Angabe unbegrenzt (siehe `ankerKetten`). */
  readonly lo?: number;
  readonly hi?: number;
  /** `Z`: aufsteigend, ohne Doppelte. */
  readonly ziele: readonly number[];
  /**
   * `F`: die Bilder des Films, aufsteigend – woran ein Szenenschnitt gemessen
   * wird (siehe `kettenPlan`). Ohne Angabe gelten die Ziele als Film.
   */
  readonly film?: readonly number[];
  readonly K: number;
  /** `K_grob` – ohne Angabe kein Grobpass. */
  readonly kGrob?: number;
  /** Pfadbilder je Fenster, siehe `fensterGroesse`. */
  readonly fenster: number;
  readonly jenseits: Jenseits;
}

/**
 * Der Auftrag für `kettenPlan` aus einem `Kettenbedarf`.
 *
 * Eigens, damit der Verfolger `neuRechnen` nicht vergessen kann: Ohne
 * `ankerNeu` gälte am Anker seine alte Maske, obwohl ihre Toleranz oder ihr
 * Verfahren an einem anderen Anker geändert wurde.
 */
export function kettenAuftrag(
  bedarf: Kettenbedarf,
  schritte: {
    readonly K: number;
    readonly fenster: number;
    readonly kGrob?: number;
    /** `F` – siehe `KettenAuftrag.film`. */
    readonly film?: readonly number[];
  },
): KettenAuftrag {
  const { grenze } = bedarf;
  return {
    anker: grenze.anker.k,
    ...(grenze.anker.neuRechnen ? { ankerNeu: true } : {}),
    ...(Number.isFinite(grenze.lo) ? { lo: grenze.lo } : {}),
    ...(Number.isFinite(grenze.hi) ? { hi: grenze.hi } : {}),
    ziele: bedarf.ziele,
    ...(schritte.film ? { film: schritte.film } : {}),
    K: schritte.K,
    ...(schritte.kGrob ? { kGrob: schritte.kGrob } : {}),
    fenster: schritte.fenster,
    jenseits: bedarf.jenseits,
  };
}

/**
 * Welche Bilder eine Kette liest, wo ein Modell läuft und wie sie in Fenster
 * zerfällt.
 *
 * Der Pfad läuft vom Anker in beide Richtungen, BILD FÜR BILD bis zum
 * äussersten Ziel: Die Spur sucht den Gegenstand von einem Bild zum nächsten
 * und braucht dafür jedes. Bilder auf dem Pfad, die kein Ziel sind (ausserhalb
 * des Films oder der Geltung), sind Brücken: gelesen, verfolgt, aber weder
 * durch ein Modell geprüft noch gespeichert.
 *
 * Schlüssel sind die Ziele im Abstand `K` vom Start, der erste und letzte
 * jedes zusammenhängenden Laufs von Zielen (dort beginnt oder endet eine
 * Brücke, und die Maske dort soll geprüft sein) und der Start selbst.
 *
 * Eine Lücke im FILM über `BRUECKE_MAX` Bilder ist ein Szenenschnitt: Die
 * Kette endet davor, und was dahinter liegt, bestimmt `jenseits`.
 *
 * # Gemessen am Film, nicht an den Zielen
 *
 * Ein Szenenschnitt ist, wo der Film einen Sprung in der Quelle macht –
 * dort kann dahinter alles anders aussehen. Bilder, die der Film zeigt, an
 * denen die Maske aber nicht gilt, sind kein Sprung: Die Quelle läuft dort
 * so weiter, wie der Anwender sie sieht. Gemessen an den Zielen war schon
 * ein „Ab hier" zwei Sekunden hinter dem Anker ein Schnitt – und alles schon
 * Gerechnete dahinter hiess auf einmal „hier neu antippen".
 *
 * Über eine lange solche Strecke (mehr als `BRUECKE_MAX`) schiebt die Spur
 * die Maske aber nicht blind: Dort liegen Prüfbilder im Abstand `K` (im
 * Grobpass `K_grob`) – Schlüsselbilder mit Modellauf, die nicht abgelegt
 * werden. Anders als eine Brücke durch Herausgeschnittenes KANN man sie
 * prüfen, und über eine Minute ohne Prüfung glitte die Maske weg.
 */
export function kettenPlan(auftrag: KettenAuftrag): KettenPlan {
  const lo = auftrag.lo ?? Number.NEGATIVE_INFINITY;
  const hi = auftrag.hi ?? Number.POSITIVE_INFINITY;
  const a = auftrag.anker;
  const ankerIstZiel = auftrag.ziele.includes(a);
  const vor = auftrag.ziele.filter((k) => k > a && k <= hi);
  const rueck = auftrag.ziele.filter((k) => k < a && k >= lo).reverse();
  const film = auftrag.film ?? auftrag.ziele;
  return {
    anker: a,
    vor: richtungPlanen(auftrag, vor, 1, ankerIstZiel, film),
    rueck: richtungPlanen(auftrag, rueck, -1, ankerIstZiel, film),
  };
}

/** Die erste Stelle in der aufsteigenden Liste mit einem Wert ≥ `k`. */
function untereGrenze(liste: readonly number[], k: number): number {
  let lo = 0;
  let hi = liste.length;
  while (lo < hi) {
    const mitte = (lo + hi) >> 1;
    if (liste[mitte] < k) lo = mitte + 1;
    else hi = mitte;
  }
  return lo;
}

/**
 * Die längste Folge von Bildern echt zwischen `a` und `b`, die NICHT im Film
 * sind – über Filmbilder hinweg wird nicht gezählt.
 */
function laengsteFilmluecke(a: number, b: number, film: readonly number[]): number {
  const von = Math.min(a, b);
  const bis = Math.max(a, b);
  let vorher = von;
  let laengste = 0;
  for (let i = untereGrenze(film, von + 1); i < film.length && film[i] < bis; i += 1) {
    laengste = Math.max(laengste, film[i] - vorher - 1);
    vorher = film[i];
  }
  return Math.max(laengste, bis - vorher - 1);
}

function richtungPlanen(
  auftrag: KettenAuftrag,
  ziele: readonly number[],
  d: 1 | -1,
  ankerIstZiel: boolean,
  film: readonly number[],
): Richtungsplan {
  const laeufe: Lauf[] = [];
  const ohne: number[] = [];
  let start = auftrag.anker;
  let neustart = false;
  let startIstZiel = ankerIstZiel;
  /*
   * Ein Anker mit `neuRechnen` speichert seine eigene, neu gerechnete Maske
   * – vorwärts, dort fragt das Zusammensetzen. Er beginnt den Lauf deshalb
   * schon als Ziel: Auch wenn dahinter nichts mehr kommt, entsteht ein Lauf,
   * der ihn rechnet.
   */
  let gesammelt: number[] = d > 0 && auftrag.ankerNeu && ankerIstZiel ? [start] : [];
  let vorher = start;
  let abgerissen = false;
  const abschliessen = () => {
    if (gesammelt.length > 0) {
      laeufe.push(laufBauen(auftrag, start, neustart, startIstZiel, gesammelt, d, film));
    }
    gesammelt = [];
  };
  for (const ziel of ziele) {
    if (abgerissen) {
      ohne.push(ziel);
      continue;
    }
    if (laengsteFilmluecke(vorher, ziel, film) > BRUECKE_MAX) {
      abschliessen();
      if (auftrag.jenseits === 'neustart') {
        start = ziel;
        neustart = true;
        startIstZiel = true;
        gesammelt = [ziel];
        vorher = ziel;
        continue;
      }
      abgerissen = true;
      ohne.push(ziel);
      continue;
    }
    gesammelt.push(ziel);
    vorher = ziel;
  }
  abschliessen();
  return { laeufe, ohne };
}

function laufBauen(
  auftrag: KettenAuftrag,
  start: number,
  neustart: boolean,
  startIstZiel: boolean,
  ziele: readonly number[],
  d: 1 | -1,
  film: readonly number[],
): Lauf {
  const letztes = ziele[ziele.length - 1];
  const pfad: number[] = [];
  for (let k = start; d > 0 ? k <= letztes : k >= letztes; k += d) pfad.push(k);
  const zielMenge = new Set(ziele);
  const istZiel = (k: number) => zielMenge.has(k) || (k === start && startIstZiel);
  const randBild = (k: number) => !istZiel(k - d) || !istZiel(k + d);
  /*
   * Filmbilder in einer langen Strecke ohne Ziel – dort wird geprüft, nicht
   * abgelegt (siehe `kettenPlan`). In Laufrichtung, wie der Pfad.
   */
  const filmMenge = new Set(film);
  const pruefbar: number[] = [];
  let strecke: number[] = [];
  const streckeZu = () => {
    if (strecke.length > BRUECKE_MAX) pruefbar.push(...strecke.filter((k) => filmMenge.has(k)));
    strecke = [];
  };
  for (const k of pfad) {
    if (istZiel(k)) streckeZu();
    else strecke.push(k);
  }
  streckeZu();
  const schluesselFuer = (abstand: number) => {
    const raus = [start];
    for (const k of ziele) {
      if (k === start) continue;
      if (Math.abs(k - start) % abstand === 0 || randBild(k)) raus.push(k);
    }
    for (const k of pruefbar) if (Math.abs(k - start) % abstand === 0) raus.push(k);
    return raus.sort((x, y) => (x - y) * d);
  };
  const schluessel = schluesselFuer(auftrag.K);
  const grob = auftrag.kGrob ? schluesselFuer(auftrag.kGrob) : [];
  return {
    start,
    neustart,
    startRechnen: neustart || (auftrag.ankerNeu === true && start === auftrag.anker),
    pfad,
    // Den Start enthalten sie nur, wo er gerechnet wird – siehe `richtungPlanen`.
    ziele,
    schluessel,
    grob,
    fenster: fensterTeilen(pfad, new Set(schluessel), auftrag.fenster),
    grobFenster: grob.length > 0 ? fensterTeilen(pfad, new Set(grob), auftrag.fenster) : [],
  };
}

/**
 * Den Pfad in Fenster teilen, die auf Schlüsselbildern enden.
 *
 * So lang wie möglich, aber nicht länger als `groesse` – ausser, bis zum
 * nächsten Schlüssel ist es weiter (eine lange Brücke): Dann reicht das
 * Fenster bis dorthin. Eine Brücke liegt so immer in EINEM Fenster, und kein
 * Fenster endet auf einem Bild, an dem die Maske nur geschoben wäre.
 */
export function fensterTeilen(
  pfad: readonly number[],
  schluessel: ReadonlySet<number>,
  groesse: number,
): Fenster[] {
  // Ein Lauf aus nur seinem Start (ein Neustart, ein neu zu rechnender Anker
  // ohne Weiteres dahinter) braucht trotzdem ein Fenster – sonst rechnete ihn
  // niemand, und das Bild bliebe für immer offen.
  if (pfad.length === 1) return [{ von: 0, bis: 0 }];
  const raus: Fenster[] = [];
  let von = 0;
  while (von < pfad.length - 1) {
    let bis = -1;
    for (let i = von + 1; i < pfad.length; i += 1) {
      if (!schluessel.has(pfad[i]) && i !== pfad.length - 1) continue;
      if (i - von > groesse) {
        if (bis < 0) bis = i;
        break;
      }
      bis = i;
    }
    raus.push({ von, bis });
    von = bis;
  }
  return raus;
}

/* ---------- Was die Verfolgung liefert ---------- */

/** Wie fertig gespeicherte Daten sind. */
export type Guete = 'fein' | 'grob' | 'veraltet';
export type Richtung = 'vor' | 'rueck';

/** Die angetippten Punkte am nächsten Schlüsselbild – samt dem Schwerpunkt der Maske dort. */
export interface TippPunkte {
  readonly liste: readonly Punkt[];
  readonly mx: number;
  readonly my: number;
}

/**
 * Was die Verfolgung über EINE Kette an EINEM Bild weiss.
 *
 * - `offen`: noch nicht gerechnet.
 * - `verloren`: jenseits eines Szenenschnitts (oder die Punkte eines Tipps
 *   sind weg) – es wird dort nichts mehr gerechnet.
 * - sonst Daten: `fein` (endgültig), `grob` (Grobpass), `veraltet` (aus
 *   einer ersetzten Kette, nur für die Vorschau). Eine leere Maske ist ein
 *   Ergebnis (`meta.flaeche` < 1), kein Fehlen.
 */
export type KettenBild =
  | { readonly stand: 'offen' }
  | { readonly stand: 'verloren' }
  | {
      readonly stand: Guete;
      readonly meta: MaskenMeta;
      /**
       * Die Ersatzidentität der gespeicherten Maske (`filmMarke()`) – neu,
       * sobald sie überschrieben wird, etwa grob durch fein.
       */
      readonly marke: number;
      /** Nur Tipp: die Punkte am nächsten Schlüsselbild zwischen Anker und k. */
      readonly punkte?: TippPunkte;
    };

/**
 * Die Kamerabewegung von Bild a nach Bild k.
 *
 * `lage` bildet Bild k auf Bild a ab – dieselbe Richtung wie `seitAnker` in
 * `videoBauen.ts` –, und `formTeilZiehen(teil, lage, faktor)` bringt ein
 * Formteil von a nach k. `vorlaeufig`: ein Szenenschnitt dazwischen, es gibt
 * keine Bewegung; die Form bleibt an ihren Ankerkoordinaten.
 */
export type LageAntwort =
  | { readonly stand: 'offen' }
  | { readonly stand: 'vorlaeufig' }
  | { readonly stand: 'fein'; readonly lage: Lage; readonly faktor: number };

/** Die Tiefenkarte an Bild k – in ihrer eigenen Grösse (`NeueDaten`). */
export type TiefenBild =
  | { readonly stand: 'offen' }
  | { readonly stand: Guete; readonly daten: NeueDaten; readonly marke: number };

/**
 * Was das Zusammensetzen von der Verfolgung braucht – im Betrieb der
 * `Verfolger`.
 *
 * Alle Aufrufe sind SYNCHRON und billig bis auf `maske` (packt aus). Zwei
 * Aufrufe im selben Zug müssen zueinander passen: `maske` liefert die Maske
 * zu der Marke, die `kette` eben gemeldet hat.
 */
export interface SpurQuelle {
  /**
   * Die Kette von `anker` in `richtung` an Bild k. Für einen Anker mit
   * `neuRechnen` fragt das Zusammensetzen an seinem eigenen Bild mit
   * `'vor'` – dort liegt dann die neu gerechnete Maske.
   */
  kette(anker: Anker, richtung: Richtung, k: number): KettenBild;
  /** Die Maske dazu in Rechengrösse – `null`, wenn es keine (mehr) gibt. */
  maske(anker: Anker, richtung: Richtung, k: number): Uint8Array | null;
  lage(a: number, k: number): LageAntwort;
  tiefe(k: number): TiefenBild;
}

/* ---------- Zusammensetzen ---------- */

/**
 * Für wen zusammengesetzt wird.
 *
 * | art        | nimmt                                                       |
 * | ---------- | ----------------------------------------------------------- |
 * | `editor`   | Anker, fein, grob; Tipps bekommen Punkte an Bildern ohne Anker |
 * | `vorschau` | dazu veraltet und halbe Daten; Formen ohne Kamera am Anker  |
 * | `bild`     | nur Anker und fein – sonst Fehler; abgeschaltete Masken fehlen |
 *
 * `verloren` (leere Maske) und `vorlaeufig` (Form am Anker) sind endgültig
 * und gelten überall.
 */
export type Art = 'editor' | 'vorschau' | 'bild';

/**
 * Intern kommt die Bahn dazu: Sie zeigt Veraltetes (gestreift) wie die
 * Vorschau, nimmt aber KEINEN Ersatz – keine halben Daten zwischen zwei
 * Ankern, keine Form am Anker ohne Kamera. Wo nichts gerechnet ist, soll sie
 * „offen" sagen und nicht „sichtbar, etwas alt".
 */
type Sicht = Art | 'bahn';

/**
 * Ob eine Sicht Daten dieses Stands nimmt.
 *
 * `offen` nimmt niemand. `veraltet` nur Vorschau und Bahn: Der Editor zeigt
 * nie eine Maske aus einer ersetzten Kette (wer daran weiterarbeitete,
 * verankerte das Alte neu), und der Filmbau wartet auf fertige Daten.
 */
function nimmt(sicht: Sicht, stand: Teilstand): boolean {
  if (stand === 'offen') return false;
  if (stand === 'veraltet') return sicht === 'vorschau' || sicht === 'bahn';
  return true;
}

/** Wie fertig ein zusammengesetztes Teil ist. */
export type Teilstand = 'anker' | Guete | 'vorlaeufig' | 'verloren' | 'offen';

export interface Zusammensetzung {
  readonly doc: BildDoc;
  readonly k: number;
  /**
   * Je ausgegebener Maske GENAU das Teilefeld, das im Dokument steht – der
   * Router erkennt daran, was der Editor unverändert zurückgibt.
   */
  readonly enthalten: ReadonlyMap<string, readonly Maskenteil[]>;
  /** Masken, die hier gelten, deren Daten aber noch fehlen – sie fehlen im Dokument. */
  readonly fehlend: readonly string[];
  /**
   * Masken, denen hier Daten fehlen, die aber auch nie kommen: Das Bild liegt
   * hinter der Obergrenze des Films (`imFilm`), dort wird nicht verfolgt.
   * Sie fehlen im Dokument wie die aus `fehlend`, aber „wird noch verfolgt"
   * wäre gelogen – die Zeile sagt „nicht im Film".
   */
  readonly jenseits: readonly string[];
  /** Masken, die mit veralteten Daten im Dokument stehen (nur Vorschau). */
  readonly veraltet: readonly string[];
  /** Masken, die hier erst grob verfolgt sind. */
  readonly grob: readonly string[];
  /**
   * Masken jenseits von `BEREICHE_MAX` an diesem Bild – nach Maskenreihenfolge
   * die hinteren. Kommt nur vor, wenn eine Geltung `abschnitte` mit ihrem
   * Abschnitt gewachsen ist, ohne dass `grenzeVerletzt` gefragt wurde; im
   * Filmbau ein Fehler (siehe `bildDocAn`), für die Bahn `zuvielAn`.
   */
  readonly ueberzaehlig: readonly string[];
}

/**
 * Der Merkzettel für zusammengesetzte Teile – nach Bytes begrenzt.
 *
 * Derselbe Stand (dieselben Anker, dieselben gespeicherten Masken, dieselbe
 * Kamera) gibt dasselbe Teilefeld zurück. Daran hängt der Renderer: Seine
 * Maskenzwischenspeicher (`bild/maskenSpeicher.ts`) erkennen ein Feld an
 * seiner Identität, und beim Hin- und Herwischen wird so keine Maske zweimal
 * gerastert.
 */
export class Kompositspeicher {
  private readonly lru: BytesLru<string, readonly Maskenteil[]>;

  constructor(maxBytes = 16 * 1024 * 1024) {
    this.lru = new BytesLru(maxBytes);
  }

  holen(schluessel: string): readonly Maskenteil[] | undefined {
    return this.lru.holen(schluessel);
  }

  ablegen(schluessel: string, teile: readonly Maskenteil[], bytes: number): void {
    this.lru.ablegen(schluessel, teile, bytes);
  }

  leeren(): void {
    this.lru.leeren();
  }

  get bytes(): number {
    return this.lru.bytes;
  }
}

/** Eine fortlaufende Nummer je Objekt – für die Schlüssel des Merkzettels. */
const nummern = new WeakMap<object, number>();
let nummernZaehler = 0;
function objektNummer(objekt: object): number {
  let nummer = nummern.get(objekt);
  if (nummer === undefined) {
    nummernZaehler += 1;
    nummer = nummernZaehler;
    nummern.set(objekt, nummer);
  }
  return nummer;
}

/**
 * Das Teil eines Ankers mit der Kennung seines Spurteils.
 *
 * Nach „Hier trennen" teilen sich zwei Masken dieselben Anker, aber jede hat
 * ihre eigenen Teilkennungen. Ginge das Ankerteil unverändert hinaus, sähe
 * der Router beim Bearbeiten der zweiten Maske die Kennung der ersten. Im
 * Normalfall stimmen beide überein, und es geht das Ankerteil SELBST hinaus
 * – dasselbe Objekt, das der Editor dort geliefert hat.
 */
const kopien = new WeakMap<Maskenteil, Map<string, Maskenteil>>();
function teilMitId(teil: Maskenteil, id: string): Maskenteil {
  if (teil.id === id) return teil;
  let jeId = kopien.get(teil);
  if (!jeId) {
    jeId = new Map();
    kopien.set(teil, jeId);
  }
  let kopie = jeId.get(id);
  if (!kopie) {
    kopie = { ...teil, id };
    jeId.set(id, kopie);
  }
  return kopie;
}

const metaJeTeil = new WeakMap<Maskenteil, MaskenMeta>();
/** Die Messwerte der Maske eines Ankerteils – einmal je Objekt gerechnet. */
function metaVonTeil(teil: Maskenteil): MaskenMeta {
  if (teil.art !== 'netz' && teil.art !== 'tipp') return META_LEER;
  let meta = metaJeTeil.get(teil);
  if (!meta) {
    meta = metaMessen(teil.alpha, teil.breite, teil.hoehe);
    metaJeTeil.set(teil, meta);
  }
  return meta;
}

/** Eine leere Maske je Grösse – geteilt und nie beschrieben. */
const leere = new Map<number, { werte: Uint8Array; marke: number }>();
function leereMaske(laenge: number): { werte: Uint8Array; marke: number } {
  let eintrag = leere.get(laenge);
  if (!eintrag) {
    eintrag = { werte: new Uint8Array(laenge), marke: filmMarke() };
    leere.set(laenge, eintrag);
  }
  return eintrag;
}

interface Kontext {
  readonly quelle: SpurQuelle;
  readonly art: Sicht;
  readonly rahmen: Rahmen;
  readonly k: number;
  /** Aufgelöste Leitteile je `id@k` – ein Formteil fragt sein Leitteil an zwei Bildern. */
  readonly leit: Map<string, Aufloesung>;
}

/** Ein Teil an Bild k: wie fertig, woran erkennbar, und wie es gebaut wird. */
interface Aufloesung {
  readonly stand: Teilstand;
  /** Gleich genau dann, wenn `bauen` dasselbe liefert – der Schlüssel im Merkzettel. */
  readonly zeichen: string;
  /** Nur Inhaltsteile: die Messwerte der Maske an k. */
  readonly meta?: MaskenMeta;
  /**
   * Nur Formteile: wo sie an k etwas bewirken – billig, OHNE das Teil zu
   * bauen (siehe `formKastenAn`). `null`: nirgends.
   */
  readonly kasten?: () => Kasten | null;
  readonly bauen: () => { teil: Maskenteil; bytes: number };
}

const OFFEN: Aufloesung = {
  stand: 'offen',
  zeichen: 'offen',
  bauen: () => {
    throw new Error('Ein offenes Teil wird nicht gebaut');
  },
};

/** Schlechter ist grösser. */
const RANG: Record<Teilstand, number> = {
  anker: 0,
  fein: 1,
  vorlaeufig: 2,
  verloren: 2,
  grob: 3,
  veraltet: 4,
  offen: 5,
};

function schlechter(a: Teilstand, b: Teilstand): Teilstand {
  return RANG[b] > RANG[a] ? b : a;
}

function teilAufloesen(maske: Maske, teil: SpurTeil, kx: Kontext): Aufloesung {
  const art = teil.anker[0].teil.art;
  if (art === 'netz' || art === 'tipp') return inhaltAufloesen(teil, kx);
  if (art === 'tiefe') return tiefeAufloesen(teil, kx);
  return formAufloesen(maske, teil, kx);
}

/** Der Anker, der an k am nächsten liegt – bei Gleichstand der frühere. */
function naechsterAnker(anker: readonly Anker[], k: number): Anker {
  let bester = anker[0];
  for (const a of anker) {
    if (Math.abs(a.k - k) < Math.abs(bester.k - k)) bester = a;
  }
  return bester;
}

interface Seite {
  readonly anker: Anker;
  readonly richtung: Richtung;
  readonly bild: Extract<KettenBild, { meta: MaskenMeta }>;
}

function hatDaten(bild: KettenBild): bild is Seite['bild'] {
  return bild.stand !== 'offen' && bild.stand !== 'verloren';
}

/**
 * Ein Teil aus dem Bildinhalt (Netz, Tipp) an Bild k.
 *
 * # Anwesenheit gewinnt
 *
 * Zwischen zwei Ankern a < k < b liegen zwei Ketten: die von a vorwärts und
 * die von b rückwärts. Sehen beide den Gegenstand, gewinnt der nähere Anker,
 * mit vier Bildern Überblendung um die Mitte. Sieht ihn nur EINE, gilt sie –
 * gleich, wie weit ihr Anker weg ist.
 *
 * Das ist die einzige Regel, die den häufigsten Fall richtig macht: Ein
 * Gegenstand verlässt das Bild und kommt zurück, und der Anwender tippt ihn
 * beim Wiederkommen noch einmal an. Die Kette vom ersten Tipp sieht ihn bis
 * zum Austritt, die vom zweiten ab dem Wiedereintritt – und die Bilder VOR
 * dem Austritt bleiben richtig. Eine Mittelpunktregel schnitte sie ab, ein
 * Ersetzen des ersten Tipps verlöre sie ganz.
 */
function inhaltAufloesen(teil: SpurTeil, kx: Kontext): Aufloesung {
  const { k, quelle, rahmen } = kx;
  const hier = teil.anker.find((a) => a.k === k);
  if (hier && !hier.neuRechnen) {
    return {
      stand: 'anker',
      zeichen: `${teil.id}=A${objektNummer(hier.teil)}`,
      meta: metaVonTeil(hier.teil),
      bauen: () => ({ teil: teilMitId(hier.teil, teil.id), bytes: 0 }),
    };
  }
  let vorher: Anker | undefined = hier;
  let nachher: Anker | undefined;
  if (!hier) {
    for (const a of teil.anker) {
      if (a.k < k) vorher = a;
      else if (a.k > k) {
        nachher = a;
        break;
      }
    }
  }
  const bildA = vorher ? quelle.kette(vorher, 'vor', k) : null;
  const bildB = nachher ? quelle.kette(nachher, 'rueck', k) : null;
  const basis = naechsterAnker(teil.anker, k).teil;
  const laenge = rahmen.b * rahmen.h;

  // Was fehlt, fehlt – die Vorschau nimmt dann die andere Seite, als veraltet.
  const offenA = bildA?.stand === 'offen';
  const offenB = bildB?.stand === 'offen';
  if (offenA || offenB) {
    const andere = offenA ? bildB : bildA;
    if (kx.art !== 'vorschau' || !andere || !hatDaten(andere)) return OFFEN;
  }
  const seiteA: Seite | null =
    vorher && bildA && hatDaten(bildA) ? { anker: vorher, richtung: 'vor', bild: bildA } : null;
  const seiteB: Seite | null =
    nachher && bildB && hatDaten(bildB) ? { anker: nachher, richtung: 'rueck', bild: bildB } : null;
  let stand: Teilstand = offenA || offenB ? 'veraltet' : 'fein';
  if (seiteA) stand = schlechter(stand, seiteA.bild.stand);
  if (seiteB) stand = schlechter(stand, seiteB.bild.stand);

  const daA = seiteA !== null && !metaLeer(seiteA.bild.meta);
  const daB = seiteB !== null && !metaLeer(seiteB.bild.meta);

  if (!daA && !daB) {
    // Keine Seite sieht den Gegenstand. Hat auch keine gerechnet, ist er verloren.
    const verloren = !seiteA && !seiteB;
    const leer = leereMaske(laenge);
    return {
      stand: verloren ? 'verloren' : stand,
      zeichen: `${teil.id}=L${objektNummer(basis)}`,
      meta: META_LEER,
      bauen: () => ({
        teil: inhaltsTeil(basis, teil.id, leer.werte, leer.marke, kx, []),
        bytes: 0,
      }),
    };
  }

  // Wie weit Seite B an k schon gilt: 0 = nur A, 1 = nur B.
  let t = daA ? 0 : 1;
  if (daA && daB && vorher && nachher) {
    const mitte = (vorher.k + nachher.k) / 2;
    t = Math.min(1, Math.max(0, (k - mitte) / UEBERBLENDUNG + 0.5));
  }
  const naeher = (t < 0.5 ? seiteA : seiteB) as Seite;
  if (t <= 0 || t >= 1) {
    const seite = naeher;
    return {
      stand,
      zeichen: `${teil.id}=M${seite.bild.marke}:${objektNummer(basis)}`,
      meta: seite.bild.meta,
      bauen: () => {
        const werte = quelle.maske(seite.anker, seite.richtung, k) ?? leereMaske(laenge).werte;
        return {
          teil: inhaltsTeil(
            basis,
            teil.id,
            werte,
            seite.bild.marke,
            kx,
            tippPunkte(seite, werte, kx),
          ),
          bytes: werte.length,
        };
      },
    };
  }
  const a = seiteA as Seite;
  const b = seiteB as Seite;
  return {
    stand,
    zeichen: `${teil.id}=X${a.bild.marke}/${b.bild.marke}/${t}:${objektNummer(basis)}`,
    meta: naeher.bild.meta,
    bauen: () => {
      const werteA = quelle.maske(a.anker, a.richtung, k) ?? leereMaske(laenge).werte;
      const werteB = quelle.maske(b.anker, b.richtung, k) ?? leereMaske(laenge).werte;
      const werte = new Uint8Array(werteA.length);
      const u = 1 - t;
      for (let i = 0; i < werte.length; i += 1) {
        werte[i] = Math.round(werteA[i] * u + werteB[i] * t);
      }
      return {
        teil: inhaltsTeil(basis, teil.id, werte, filmMarke(), kx, tippPunkte(naeher, werte, kx)),
        bytes: werte.length,
      };
    },
  };
}

/**
 * Die Punkte eines Tipps an einem Bild ohne Anker – nur für den Editor.
 *
 * Die des nächsten Schlüsselbildes, um den Weg des Schwerpunkts seitdem
 * verschoben und in die Maske eingerastet. Der Editor rechnet mit ihnen
 * weiter, wenn hier noch einmal getippt wird: Die Flutung nimmt ALLE Punkte,
 * und sie sollen auf dem Gegenstand liegen, nicht dort, wo er vor einer
 * Sekunde war.
 */
function tippPunkte(seite: Seite, werte: Uint8Array, kx: Kontext): Punkt[] | undefined {
  if (kx.art !== 'editor') return undefined;
  const quelle = seite.bild.punkte;
  const meta = seite.bild.meta;
  if (!quelle || metaLeer(meta)) return [];
  const dx = meta.mx - quelle.mx;
  const dy = meta.my - quelle.my;
  return quelle.liste.map((p) =>
    einrasten({ x: p.x + dx, y: p.y + dy }, werte, kx.rahmen.b, kx.rahmen.h, meta.flaeche),
  );
}

/** Ein Netz- oder Tippteil mit den Daten eines Bildes. */
function inhaltsTeil(
  basis: Maskenteil,
  id: string,
  werte: Uint8Array,
  marke: number,
  kx: Kontext,
  punkte: readonly Punkt[] | undefined,
): Maskenteil {
  const { b, h } = kx.rahmen;
  if (basis.art === 'tipp') {
    return {
      ...basis,
      id,
      breite: b,
      hoehe: h,
      alpha: werte,
      marke,
      ...(punkte && kx.art === 'editor' ? { punkte } : {}),
    };
  }
  if (basis.art === 'netz') return { ...basis, id, breite: b, hoehe: h, alpha: werte, marke };
  return teilMitId(basis, id);
}

/** Tiefe: am Anker seine Karte, sonst die geteilte der Szene. */
function tiefeAufloesen(teil: SpurTeil, kx: Kontext): Aufloesung {
  const hier = teil.anker.find((a) => a.k === kx.k);
  if (hier) {
    return {
      stand: 'anker',
      zeichen: `${teil.id}=A${objektNummer(hier.teil)}`,
      bauen: () => ({ teil: teilMitId(hier.teil, teil.id), bytes: 0 }),
    };
  }
  const bild = kx.quelle.tiefe(kx.k);
  if (bild.stand === 'offen') return OFFEN;
  const basis = naechsterAnker(teil.anker, kx.k).teil;
  return {
    stand: bild.stand,
    zeichen: `${teil.id}=T${bild.marke}:${objektNummer(basis)}`,
    bauen: () => {
      const teilNeu: Maskenteil =
        basis.art === 'tiefe'
          ? {
              ...basis,
              id: teil.id,
              breite: bild.daten.breite,
              hoehe: bild.daten.hoehe,
              karte: bild.daten.werte,
              marke: bild.marke,
            }
          : teilMitId(basis, teil.id);
      return { teil: teilNeu, bytes: bild.daten.werte.length };
    },
  };
}

/**
 * Das Teil, dem die Formen einer Maske folgen: das erste Netz- oder
 * Tippteil, das HINZUFÜGT – sonst irgendeines. `null` für reine Formmasken
 * und für Tiefe (die beschreibt die Szene, keinen Gegenstand).
 */
function leitTeil(maske: Maske): SpurTeil | null {
  const inhalt = maske.teile.filter((teil) => {
    const art = teil.anker[0].teil.art;
    return art === 'netz' || art === 'tipp';
  });
  return inhalt.find((teil) => teil.anker[0].teil.modus === 'dazu') ?? inhalt[0] ?? null;
}

function leitAn(teil: SpurTeil, kx: Kontext, k: number): Aufloesung {
  const schluessel = `${teil.id}@${k}`;
  let aufl = kx.leit.get(schluessel);
  if (!aufl) {
    aufl = inhaltAufloesen(teil, { ...kx, k });
    kx.leit.set(schluessel, aufl);
  }
  return aufl;
}

/** Ein Formteil, das an diesem Bild nichts bewirkt – oder `null`, wenn es das nicht gibt. */
function verstecken(teil: Maskenteil): Maskenteil | null {
  if (teil.umkehren) return null;
  if (teil.art === 'pinsel') return { ...teil, striche: [] };
  if (teil.art === 'radial') return { ...teil, mitte: { x: -1e6, y: -1e6 } };
  return null;
}

/**
 * Eine Form (Verlauf, Ellipse, Pinsel) an Bild k.
 *
 * # Wem sie folgt
 *
 * In einer Maske MIT Inhaltsteil folgt sie dem Inhalt: um den Weg seines
 * Schwerpunkts zwischen dem Ankerbild der Form und k. Wer mit dem Pinsel
 * einen Arm zur „Person" hinzufügt, will ihn an der Person – nicht an der
 * Stelle der Szene, an der die Person einmal stand. Ist der Inhalt an k
 * nicht im Bild, verschwinden Pinsel und Ellipse mit ihm (die Maske soll
 * verschwinden, wenn ihr Gegenstand verschwindet); ein Verlauf lässt sich
 * nicht verstecken und bleibt am Anker.
 *
 * In einer reinen Formmaske folgt sie der Kamera – dort steht sie IN der
 * Szene, wie ein Verlauf über dem Himmel.
 *
 * Mehrere Anker: Es gilt der nähere, ohne Überblendung – eine Form hat keine
 * Maske, die man mischen könnte.
 *
 * # Warum nie die Kamera, wenn die Maske Inhalt hat
 *
 * War am Ankerbild der Form vom Inhalt nichts zu sehen (jemand malt die
 * Person von Hand, wo das Modell sie nicht fand), gibt es keinen Weg, dem sie
 * folgen könnte. Sie bleibt dann, wo sie gezeichnet wurde. Der Kamera zu
 * folgen wäre auch eine Antwort – aber dafür müsste für JEDE Maske mit
 * Inhalt und Pinsel der Kamerapfad über den ganzen Film gerechnet werden
 * (auf einem Telefon 50 – 150 ms je Bild, bei „Person" mehr als die
 * Verfolgung selbst), nur für diesen seltenen Fall. `kettenBedarf` verlangt
 * den Kamerapfad deshalb nur für reine Formmasken, und hier wird er nie
 * gefragt, wo er nicht bestellt ist.
 */
function formAufloesen(maske: Maske, teil: SpurTeil, kx: Kontext): Aufloesung {
  const { k } = kx;
  const hier = teil.anker.find((a) => a.k === k);
  if (hier) {
    return {
      stand: 'anker',
      zeichen: `${teil.id}=A${objektNummer(hier.teil)}`,
      kasten: () => formKastenAn(hier.teil, null, 1),
      bauen: () => ({ teil: teilMitId(hier.teil, teil.id), bytes: 0 }),
    };
  }
  const anker = naechsterAnker(teil.anker, k);
  const nummer = objektNummer(anker.teil);
  const amAnker = (stand: Teilstand): Aufloesung => ({
    stand,
    zeichen: `${teil.id}=R${nummer}`,
    kasten: () => formKastenAn(anker.teil, null, 1),
    bauen: () => ({ teil: teilMitId(anker.teil, teil.id), bytes: 0 }),
  });

  const leit = leitTeil(maske);
  if (leit) {
    const dort = leitAn(leit, kx, anker.k);
    if (dort.stand === 'offen') return kx.art === 'vorschau' ? amAnker('veraltet') : OFFEN;
    // Am eigenen Anker oder verloren: Was dort (nicht) zu sehen war, steht fest.
    const standDort: Teilstand =
      dort.stand === 'anker' || dort.stand === 'verloren' ? 'fein' : dort.stand;
    const metaDort = dort.meta ?? META_LEER;
    // Nichts, dem sie folgen könnte – siehe oben.
    if (metaLeer(metaDort)) return amAnker(standDort);
    const jetzt = leitAn(leit, kx, k);
    if (jetzt.stand === 'offen') return kx.art === 'vorschau' ? amAnker('veraltet') : OFFEN;
    const stand = schlechter(jetzt.stand === 'anker' ? 'fein' : jetzt.stand, standDort);
    const metaJetzt = jetzt.meta ?? META_LEER;
    if (metaLeer(metaJetzt)) {
      const weg = verstecken(anker.teil);
      if (!weg) return amAnker(stand);
      return {
        stand,
        zeichen: `${teil.id}=W${nummer}`,
        kasten: () => null,
        bauen: () => ({ teil: { ...weg, id: teil.id }, bytes: 0 }),
      };
    }
    const dx = metaJetzt.mx - metaDort.mx;
    const dy = metaJetzt.my - metaDort.my;
    const lage: Lage = { s: 1, w: 0, tx: -dx, ty: -dy, sicher: 1 };
    return {
      stand,
      zeichen: `${teil.id}=V${nummer}:${dx},${dy}`,
      kasten: () => formKastenAn(anker.teil, lage, 1),
      bauen: () => ({ teil: { ...formTeilZiehen(anker.teil, lage, 1), id: teil.id }, bytes: 0 }),
    };
  }

  const antwort = kx.quelle.lage(anker.k, k);
  if (antwort.stand === 'offen') return kx.art === 'vorschau' ? amAnker('veraltet') : OFFEN;
  if (antwort.stand === 'vorlaeufig') return amAnker('vorlaeufig');
  const { lage, faktor } = antwort;
  return {
    stand: 'fein',
    zeichen: `${teil.id}=K${nummer}:${lage.s},${lage.w},${lage.tx},${lage.ty},${faktor}`,
    kasten: () => formKastenAn(anker.teil, lage, faktor),
    bauen: () => ({ teil: { ...formTeilZiehen(anker.teil, lage, faktor), id: teil.id }, bytes: 0 }),
  };
}

/** „0:03,20" – wie `zeitText` in der Zeitleiste, ohne sie hierher zu ziehen. */
function quellZeitText(ms: number): string {
  const gesamt = Math.max(0, ms);
  const minuten = Math.floor(gesamt / 60_000);
  const sekunden = Math.floor((gesamt % 60_000) / 1000);
  const hundertstel = Math.floor((gesamt % 1000) / 10);
  return `${minuten}:${String(sekunden).padStart(2, '0')},${String(hundertstel).padStart(2, '0')}`;
}

/**
 * Das Dokument für Quellbild k: das des Abschnitts plus die Masken, die dort
 * gelten.
 *
 * - Die Bereiche von `clipDoc` zählen NICHT – Masken leben hier.
 * - Eine Maske steht nur ganz im Dokument oder gar nicht: Fehlt einem ihrer
 *   Teile etwas, das `art` nicht nimmt, landet sie in `fehlend` (beim
 *   Filmbau: Fehler). Eine halbe Maske sähe aus wie eine falsche.
 * - Höchstens `BEREICHE_MAX` Masken. Gelten doch mehr (eine Geltung
 *   `abschnitte` wuchs mit ihrem Abschnitt), fallen in Editor und Vorschau
 *   die hinteren weg (`ueberzaehlig`); der Filmbau WIRFT – ein Film, dem
 *   still eine Maske fehlt, die die Bahn als geltend zeigt, wäre schlimmer
 *   als eine Meldung.
 * - Fehlen einer Maske Daten an einem Bild, das der Film gar nicht zeigt
 *   (hinter seiner Obergrenze), steht sie in `jenseits` statt in `fehlend`.
 * - Abgeschaltete Masken stehen im Dokument (der Haken im Editor soll gehen);
 *   nur beim Filmbau fehlen sie – dort wirken sie ohnehin nicht, und ihre
 *   Verfolgung wird nicht abgewartet.
 */
export function bildDocAn(
  clipDoc: BildDoc | null,
  masken: readonly Maske[],
  quelle: SpurQuelle,
  k: number,
  art: Art,
  rahmen: Rahmen,
  speicher?: Kompositspeicher,
): Zusammensetzung {
  const grund = clipDoc ?? neuesDoc(rahmen.b, rahmen.h);
  const bereiche: Bereich[] = [];
  const enthalten = new Map<string, readonly Maskenteil[]>();
  const fehlend: string[] = [];
  const jenseits: string[] = [];
  const veraltet: string[] = [];
  const grob: string[] = [];
  const ueberzaehlig: string[] = [];
  let drin: boolean | null = null;
  for (const maske of masken) {
    if (art === 'bild' && !maske.aktiv) continue;
    if (!giltAn(maske.geltung, k, rahmen)) continue;
    if (bereiche.length >= BEREICHE_MAX) {
      if (art === 'bild') {
        const anzahl = masken.filter((m) => m.aktiv && giltAn(m.geltung, k, rahmen)).length;
        throw new Error(
          `Bei ${quellZeitText(bildMitte(k, rahmen.s))} wirken ${anzahl} Masken – an einem Bild ` +
            `gehen höchstens ${BEREICHE_MAX}. Grenz eine in der Zeitleiste ein oder lösch sie.`,
        );
      }
      ueberzaehlig.push(maske.id);
      continue;
    }
    const kx: Kontext = { quelle, art, rahmen, k, leit: new Map() };
    const teile = maske.teile.map((teil) => teilAufloesen(maske, teil, kx));
    const staende = teile.map((teil) => teil.stand);
    const fehlt = staende.some((stand) => !nimmt(art, stand));
    if (art === 'bild' && (fehlt || staende.includes('grob'))) {
      throw new Error(
        `Die Maske ‚${maske.name}' ist bei ${quellZeitText(bildMitte(k, rahmen.s))} noch nicht fertig.`,
      );
    }
    if (fehlt) {
      drin ??= imFilm(k, rahmen, rahmen.maxBilder);
      (drin ? fehlend : jenseits).push(maske.id);
      continue;
    }
    if (staende.includes('veraltet')) veraltet.push(maske.id);
    else if (staende.includes('grob')) grob.push(maske.id);

    const zeichen = `${maske.id}|${k}|${art}|${teile.map((teil) => teil.zeichen).join(';')}`;
    let fertig = speicher?.holen(zeichen);
    if (!fertig) {
      let bytes = 256;
      fertig = teile.map((teil) => {
        const gebaut = teil.bauen();
        bytes += gebaut.bytes;
        return gebaut.teil;
      });
      speicher?.ablegen(zeichen, fertig, bytes);
    }
    enthalten.set(maske.id, fertig);
    bereiche.push({
      id: maske.id,
      name: maske.name,
      aktiv: maske.aktiv,
      anpassung: { ...maske.anpassung },
      teile: fertig,
    });
  }
  return {
    doc: { ...grund, bereiche },
    k,
    enthalten,
    fehlend,
    jenseits,
    veraltet,
    grob,
    ueberzaehlig,
  };
}

/* ---------- Bahnen ---------- */

/**
 * Was eine Bahn an einer Stelle zeigt – als Zahl, und die höhere gewinnt,
 * wenn mehrere Bilder in dieselbe Bildpunktspalte fallen.
 *
 * - `aus`: gilt dort nicht.
 * - `jenseits`: gilt, aber das Bild liegt hinter `MAX_BILDER_FILM` – „nicht
 *   im Film".
 * - `leer`: gerechnet, und der Gegenstand ist nicht im Bild (oder nicht im
 *   Zuschnitt).
 * - `verloren`: die Spur ist abgerissen (Szenenschnitt) – „hier neu antippen".
 * - `veraltet`, `grob`, `vorlaeufig`: sichtbar, aber noch nicht endgültig.
 * - `sichtbar`: sichtbar, fertig.
 * - `offen`: wird noch verfolgt.
 */
export const BAHN = {
  aus: 0,
  jenseits: 1,
  leer: 2,
  verloren: 3,
  veraltet: 4,
  grob: 5,
  vorlaeufig: 6,
  sichtbar: 7,
  offen: 8,
} as const;
export type BahnWert = (typeof BAHN)[keyof typeof BAHN];

/** Ein Kasten in Bildpunkten, einschliesslich. */
interface Kasten {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

function kastenImZuschnitt(kasten: Kasten | null, zuschnitt: Zuschnitt): boolean {
  if (!kasten || kasten.x1 < kasten.x0 || kasten.y1 < kasten.y0) return false;
  return (
    kasten.x0 < zuschnitt.x + zuschnitt.w &&
    kasten.x1 >= zuschnitt.x &&
    kasten.y0 < zuschnitt.y + zuschnitt.h &&
    kasten.y1 >= zuschnitt.y
  );
}

const kastenJeTeil = new WeakMap<Maskenteil, { kasten: Kasten | null }>();

/**
 * Wo ein Formteil an Bild k etwas bewirkt: sein Kasten am Anker – EINMAL je
 * Teilobjekt gemessen –, mit der Lage dorthin gezogen.
 *
 * # Warum nicht das Teil bauen und messen
 *
 * Weil die Bahn das für jedes Filmbild fragt, bei jedem Neuzeichnen. Ein
 * Pinsel mit 20 000 Punkten zu ziehen und zu vermessen kostete je Bahn eine
 * halbe Sekunde; seine vier Ecken zu ziehen kostet nichts. Für einen
 * gedrehten Kasten ist das Ergebnis etwas grösser als der wahre – für „trifft
 * er den Zuschnitt?" eine Näherung auf der sicheren Seite.
 */
function formKastenAn(teil: Maskenteil, lage: Lage | null, faktor: number): Kasten | null {
  let gemerkt = kastenJeTeil.get(teil);
  if (!gemerkt) {
    gemerkt = { kasten: formKasten(teil) };
    kastenJeTeil.set(teil, gemerkt);
  }
  const k = gemerkt.kasten;
  if (!k || !lage) return k;
  if (teil.art === 'radial') return formKasten(formTeilZiehen(teil, lage, faktor));
  const ecken = [
    punktVor(lage, faktor, k.x0, k.y0),
    punktVor(lage, faktor, k.x1, k.y0),
    punktVor(lage, faktor, k.x0, k.y1),
    punktVor(lage, faktor, k.x1, k.y1),
  ];
  return {
    x0: Math.min(...ecken.map((p) => p.x)),
    y0: Math.min(...ecken.map((p) => p.y)),
    x1: Math.max(...ecken.map((p) => p.x)),
    y1: Math.max(...ecken.map((p) => p.y)),
  };
}

function formKasten(teil: Maskenteil): Kasten | null {
  if (teil.art === 'radial') {
    const c = Math.cos(teil.winkel);
    const s = Math.sin(teil.winkel);
    const hx = Math.hypot(teil.rx * c, teil.ry * s);
    const hy = Math.hypot(teil.rx * s, teil.ry * c);
    return {
      x0: teil.mitte.x - hx,
      y0: teil.mitte.y - hy,
      x1: teil.mitte.x + hx,
      y1: teil.mitte.y + hy,
    };
  }
  if (teil.art === 'pinsel') {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const strich of teil.striche) {
      if (strich.abziehen) continue;
      const r = strich.breite / 2;
      for (let i = 0; i + 1 < strich.punkte.length; i += 2) {
        x0 = Math.min(x0, strich.punkte[i] - r);
        x1 = Math.max(x1, strich.punkte[i] + r);
        y0 = Math.min(y0, strich.punkte[i + 1] - r);
        y1 = Math.max(y1, strich.punkte[i + 1] + r);
      }
    }
    return x1 >= x0 ? { x0, y0, x1, y1 } : null;
  }
  return null;
}

/**
 * Was die Bahn von Maske `maske` an Quellbild k im Abschnitt mit `clipDoc`
 * zeigt.
 *
 * Sichtbar ist die Vereinigung der Teile, die hinzufügen oder schneiden
 * (`dazu`, `nur`); abziehende Teile zählen nicht – eine bewusste Näherung,
 * die ohne Rastern auskommt. Ein Inhaltsteil ist sichtbar, wenn es mehr als
 * `SICHTBAR_AB` des Bildes deckt UND sein Kasten den Zuschnitt des
 * Abschnitts trifft: Auch wer den Gegenstand wegschneidet, sieht ihn nicht.
 * Verlauf, Tiefe und alles Umgekehrte gelten als sichtbar.
 */
export function zustandAn(
  maske: Maske,
  k: number,
  clipDoc: BildDoc | null,
  quelle: SpurQuelle,
  rahmen: Rahmen,
): BahnWert {
  if (!giltAn(maske.geltung, k, rahmen)) return BAHN.aus;
  const kx: Kontext = { quelle, art: 'bahn', rahmen, k, leit: new Map() };
  const teile = maske.teile.map((teil) => teilAufloesen(maske, teil, kx));
  if (teile.some((teil) => !nimmt('bahn', teil.stand))) {
    // Hinter der Obergrenze wird nie verfolgt – „offen" hiesse dort: für immer.
    return imFilm(k, rahmen, rahmen.maxBilder) ? BAHN.offen : BAHN.jenseits;
  }
  const zuschnitt = wirksamerZuschnitt(clipDoc ?? neuesDoc(rahmen.b, rahmen.h), rahmen.b, rahmen.h);
  const mindest = SICHTBAR_AB * rahmen.b * rahmen.h;
  let sichtbar = false;
  let verloren = false;
  let stand = 'anker' as Teilstand;
  for (let i = 0; i < maske.teile.length; i += 1) {
    const aufl = teile[i];
    if (aufl.stand === 'verloren') verloren = true;
    else stand = schlechter(stand, aufl.stand);
    const basis = maske.teile[i].anker[0].teil;
    if (basis.modus === 'weg' || sichtbar) continue;
    if (basis.umkehren || basis.art === 'verlauf' || basis.art === 'tiefe') {
      sichtbar = true;
    } else if (basis.art === 'netz' || basis.art === 'tipp') {
      const meta = aufl.meta ?? META_LEER;
      sichtbar = meta.flaeche >= mindest && kastenImZuschnitt(meta, zuschnitt);
    } else if (aufl.stand !== 'verloren') {
      sichtbar = kastenImZuschnitt(aufl.kasten ? aufl.kasten() : null, zuschnitt);
    }
  }
  if (sichtbar) {
    if (stand === 'veraltet') return BAHN.veraltet;
    if (stand === 'grob') return BAHN.grob;
    if (stand === 'vorlaeufig') return BAHN.vorlaeufig;
    return BAHN.sichtbar;
  }
  return verloren ? BAHN.verloren : BAHN.leer;
}

/**
 * Wie weit eine Maske an Bild k für den FILMBAU ist: `fein` (dort geht
 * `bildDocAn(…, 'bild')`), `grob` (erst grob) oder `offen`.
 *
 * Für den Fortschritt des Verfolgers und `spurenFertig`. Dieselbe Auflösung
 * wie beim Zusammensetzen, nur ohne etwas zu bauen – eine eigene Regel im
 * Verfolger war genau das Problem: Sie fragte Formen in Masken mit Inhalt
 * nicht, meldete „fertig", und danach warf der Filmbau an jedem Bild.
 */
export function filmStandAn(
  maske: Maske,
  k: number,
  quelle: SpurQuelle,
  rahmen: Rahmen,
): 'fein' | 'grob' | 'offen' {
  const kx: Kontext = { quelle, art: 'bild', rahmen, k, leit: new Map() };
  let raus: 'fein' | 'grob' | 'offen' = 'fein';
  for (const teil of maske.teile) {
    const stand = teilAufloesen(maske, teil, kx).stand;
    if (stand === 'offen' || stand === 'veraltet') return 'offen';
    if (stand === 'grob') raus = 'grob';
  }
  return raus;
}

/** Ist die Maske an Bild k im Abschnitt zu sehen – gleich wie fertig? */
export function sichtbarAn(
  maske: Maske,
  k: number,
  clipDoc: BildDoc | null,
  quelle: SpurQuelle,
  rahmen: Rahmen,
): boolean {
  const wert = zustandAn(maske, k, clipDoc, quelle, rahmen);
  return wert >= BAHN.veraltet && wert <= BAHN.sichtbar;
}

/**
 * Eine Bahn: je Bildpunktspalte ein `BAHN`-Wert.
 *
 * Die Spalten decken die Filmzeit `0 … umfangMs` ab, mit demselben Massstab
 * wie die Abschnitte darüber. Jedes Filmbild wird dort eingetragen, wo es im
 * Film steht – ein Quellbild, das zweimal im Film vorkommt, zweimal, und mit
 * dem Zuschnitt seines jeweiligen Abschnitts. Fallen mehrere Bilder in eine
 * Spalte, gewinnt der höchste Wert (offen vor sichtbar vor leer).
 */
export function bahnZustand(
  abschnitte: readonly Abschnitt[],
  maske: Maske,
  quelle: SpurQuelle,
  s: number,
  mass: { readonly b: number; readonly h: number },
  px: number,
  umfangMs: number,
  maxBilder = MAX_BILDER_FILM,
): Uint8Array {
  const spalten = Math.max(0, Math.floor(px));
  const raus = new Uint8Array(spalten);
  if (spalten === 0 || umfangMs <= 0) return raus;
  const rahmen: Rahmen = { abschnitte, s, b: mass.b, h: mass.h, maxBilder };
  const msJeSpalte = umfangMs / spalten;
  let stelle = 0;
  let filmStart = 0;
  for (const abschnitt of abschnitte) {
    const { k0, k1 } = bildBereich(abschnitt, s);
    const laenge = Math.max(0, abschnitt.bisMs - abschnitt.vonMs);
    for (let k = k0; k < k1; k += 1) {
      const a = filmStart + (k - k0) * s;
      const e = Math.min(filmStart + laenge, a + s);
      let wert: BahnWert = BAHN.aus;
      if (giltAn(maske.geltung, k, rahmen)) {
        wert =
          stelle >= maxBilder ? BAHN.jenseits : zustandAn(maske, k, abschnitt.doc, quelle, rahmen);
      }
      stelle += 1;
      if (wert === BAHN.aus) continue;
      const von = Math.max(0, Math.floor(a / msJeSpalte));
      const bis = Math.min(spalten - 1, Math.max(von, Math.ceil(e / msJeSpalte) - 1));
      for (let spalte = von; spalte <= bis; spalte += 1) {
        if (wert > raus[spalte]) raus[spalte] = wert;
      }
    }
    filmStart += laenge;
  }
  return raus;
}

/* ---------- Griffe ---------- */

/**
 * Ein Griff der gewählten Bahn – oder, wenn seine Grenze in keinem
 * Abschnitt liegt, nur ein Hinweis ◂ / ▸ („reicht über den Film hinaus").
 */
export interface Griff {
  /** Welches Stück von `geltungStuecke`. */
  readonly stueck: number;
  readonly art: 'anfang' | 'ende';
  /** Der Abschnitt, in dem er sitzt (und auf den er beim Ziehen begrenzt ist). */
  readonly nummer: number;
  /** Wo er im Film sitzt: die linke Kante von `vonK` bzw. die rechte von `bisK − 1`. */
  readonly filmMs: number;
  /** `false`: nur der Hinweis, kein Griff. */
  readonly frei: boolean;
}

function filmAnfangVon(abschnitte: readonly Abschnitt[], nummer: number): number {
  let start = 0;
  for (let i = 0; i < nummer; i += 1)
    start += Math.max(0, abschnitte[i].bisMs - abschnitte[i].vonMs);
  return start;
}

/**
 * Wo die Griffe der gewählten Bahn sitzen.
 *
 * Ein Anfangsgriff sitzt im ERSTEN Abschnitt (in Filmreihenfolge), der
 * `vonK` zeigt, ein Endgriff im ersten, der `bisK − 1` zeigt. `ganz` hat
 * keine Griffe, ein Stück ohne ein einziges Bild im Film auch nicht.
 *
 * Kommt eine Grenze in keinem Abschnitt vor, gibt es statt des Griffs nur
 * einen Hinweis ◂ / ▸ („reicht über den Film hinaus"). Er steht dort, wo das
 * Stück im Film am weitesten in die Richtung reicht, in die es darüber
 * hinausgeht: der Anfangshinweis vor dem kleinsten Quellbild, das der Film
 * vom Stück zeigt, der Endhinweis hinter dem grössten. Bei umgestellten
 * Abschnitten ist das nicht der erste Abschnitt, in dem das Stück vorkommt.
 */
export function griffLage(geltung: Geltung, bezug: Bezug): Griff[] {
  if (geltung.art === 'ganz') return [];
  const { abschnitte, s } = bezug;
  const bereiche = abschnitte.map((abschnitt) => bildBereich(abschnitt, s));
  const anfaenge = abschnitte.map((_, n) => filmAnfangVon(abschnitte, n));
  /** Wo im Film die linke Kante von Quellbild k in Abschnitt n steht. */
  const kante = (n: number, k: number) => anfaenge[n] + (k - bereiche[n].k0) * s;
  const raus: Griff[] = [];
  geltungStuecke(geltung, bezug).forEach((st, stueck) => {
    const zeigt = (k: number) => bereiche.findIndex((b) => k >= b.k0 && k < b.k1);
    /** Das kleinste und das grösste Quellbild des Stücks, das der Film zeigt – und wo. */
    let unten: { n: number; k: number } | null = null;
    let oben: { n: number; k: number } | null = null;
    for (let n = 0; n < bereiche.length; n += 1) {
      const von = Math.max(st.vonK, bereiche[n].k0);
      const bis = Math.min(st.bisK, bereiche[n].k1) - 1;
      if (bis < von) continue;
      if (!unten || von < unten.k) unten = { n, k: von };
      if (!oben || bis > oben.k) oben = { n, k: bis };
    }
    if (!unten || !oben) return;
    const an = zeigt(st.vonK);
    raus.push(
      an >= 0
        ? { stueck, art: 'anfang', nummer: an, filmMs: kante(an, st.vonK), frei: true }
        : { stueck, art: 'anfang', nummer: unten.n, filmMs: kante(unten.n, unten.k), frei: false },
    );
    const en = zeigt(st.bisK - 1);
    raus.push(
      en >= 0
        ? { stueck, art: 'ende', nummer: en, filmMs: kante(en, st.bisK), frei: true }
        : { stueck, art: 'ende', nummer: oben.n, filmMs: kante(oben.n, oben.k + 1), frei: false },
    );
  });
  return raus;
}

/**
 * Einen Griff an eine Filmstelle ziehen – begrenzt auf SEINEN Abschnitt.
 *
 * Der Finger darf über den Abschnitt hinaus; der Griff bleibt an dessen
 * Kante stehen, wie bei den Griffen der Abschnitte. Ein Stück bleibt
 * mindestens ein Bild lang; wächst es in ein Nachbarstück hinein,
 * verschmelzen beide.
 */
export function griffZiehen(geltung: Geltung, griff: Griff, filmMs: number, bezug: Bezug): Geltung {
  if (geltung.art === 'ganz' || !griff.frei) return geltung;
  const stuecke = geltungStuecke(geltung, bezug).slice();
  const st = stuecke[griff.stueck];
  const abschnitt = bezug.abschnitte[griff.nummer];
  if (!st || !abschnitt) return geltung;
  const { k0, k1 } = bildBereich(abschnitt, bezug.s);
  const laenge = Math.max(0, abschnitt.bisMs - abschnitt.vonMs);
  const innen = Math.min(
    laenge,
    Math.max(0, filmMs - filmAnfangVon(bezug.abschnitte, griff.nummer)),
  );
  const k = k0 + Math.round(innen / bezug.s);
  stuecke[griff.stueck] =
    griff.art === 'anfang'
      ? { vonK: Math.min(Math.max(k0, k), Math.min(k1, st.bisK) - 1), bisK: st.bisK }
      : { vonK: st.vonK, bisK: Math.max(Math.min(k1, k), Math.max(k0, st.vonK) + 1) };
  return { art: 'stuecke', stuecke: stueckeNormal(stuecke) };
}

/* ---------- Vom Editor zurück in die Masken ---------- */

/**
 * Welche Felder eines Teils woran hängen.
 *
 * - `lokal`: gilt an DIESEM Bild – die Änderung wird ein Anker hier.
 * - `global`: gilt für das ganze Teil – wird in jeden Anker geschrieben,
 *   ohne neue Verfolgung (Weichheit, Fokus, Modus rechnen nichts neu).
 * - `neu`: ändert, WIE gerechnet wird – der Anker hier wird neu, und alle
 *   anderen bekommen `neuRechnen`.
 *
 * Ein Feld, das hier fehlt, gilt als lokal: Lieber einmal zu viel verfolgt
 * als eine Änderung, die an keinem anderen Bild ankommt.
 */
type Feldart = 'lokal' | 'global' | 'neu';
const FELDER: Record<Maskenteil['art'], Readonly<Record<string, Feldart>>> = {
  verlauf: { von: 'lokal', bis: 'lokal' },
  radial: { mitte: 'lokal', rx: 'lokal', ry: 'lokal', winkel: 'lokal', weichheit: 'global' },
  pinsel: { striche: 'lokal' },
  netz: { alpha: 'lokal', marke: 'lokal', breite: 'lokal', hoehe: 'lokal', netz: 'neu' },
  tipp: {
    punkte: 'lokal',
    alpha: 'lokal',
    marke: 'lokal',
    breite: 'lokal',
    hoehe: 'lokal',
    toleranz: 'neu',
    mitNetz: 'neu',
  },
  tiefe: {
    karte: 'lokal',
    marke: 'lokal',
    breite: 'lokal',
    hoehe: 'lokal',
    fokus: 'global',
    spanne: 'global',
  },
};
const ALLE_GLOBAL: Readonly<Record<string, Feldart>> = { modus: 'global', umkehren: 'global' };

export function feldArt(art: Maskenteil['art'], feld: string): Feldart {
  return ALLE_GLOBAL[feld] ?? FELDER[art][feld] ?? 'lokal';
}

function gleich(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (
    a !== null &&
    b !== null &&
    typeof a === 'object' &&
    typeof b === 'object' &&
    !Array.isArray(a) &&
    !ArrayBuffer.isView(a)
  ) {
    const pa = a as Record<string, unknown>;
    const pb = b as Record<string, unknown>;
    const schluessel = new Set([...Object.keys(pa), ...Object.keys(pb)]);
    for (const s of schluessel) if (!Object.is(pa[s], pb[s])) return false;
    return true;
  }
  return false;
}

/** Welche Arten von Feldern sich zwischen zwei Fassungen eines Teils unterscheiden. */
export function teilUnterschied(
  alt: Maskenteil,
  neu: Maskenteil,
): { lokal: boolean; global: boolean; neu: boolean } {
  const raus = { lokal: false, global: false, neu: false };
  const a = alt as unknown as Record<string, unknown>;
  const b = neu as unknown as Record<string, unknown>;
  for (const feld of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (feld === 'id' || feld === 'art' || gleich(a[feld], b[feld])) continue;
    raus[feldArt(neu.art, feld)] = true;
  }
  return raus;
}

/**
 * Globale (und `neu`-)Felder eines Teils in einen Anker schreiben – je Paar
 * gemerkt, damit die nächste Meldung des Editors dieselben Anker ergibt.
 *
 * - `global`: gleiche Kennung, nur die Felder – nichts wird neu verfolgt.
 * - `neu`: neue Kennung und `neuRechnen` – die Maske dort gilt nicht mehr.
 * - `hier`: der Anker am Bild des Editors bekommt dessen Teil SELBST (bei
 *   einer rein globalen Änderung unterscheidet es sich nur darin).
 */
const uebernommen = new WeakMap<Anker, { von: Maskenteil; art: string; zu: Anker }>();
function feldUebernehmen(anker: Anker, von: Maskenteil, art: 'global' | 'neu' | 'hier'): Anker {
  const gemerkt = uebernommen.get(anker);
  if (gemerkt && gemerkt.von === von && gemerkt.art === art) return gemerkt.zu;
  let zu: Anker;
  if (art === 'hier') {
    zu = { ...anker, teil: von };
    /*
     * Auch für `ankerFuer` merken: Kommt dasselbe Teilobjekt später wieder
     * (ein Rückgängig im Editor, nachdem hier noch einmal lokal geändert
     * wurde), ist es derselbe Anker – mit derselben Kennung und Kette.
     */
    if (!ankerJeTeil.has(von)) ankerJeTeil.set(von, zu);
  } else {
    const quelle = von as unknown as Record<string, unknown>;
    const teil = { ...anker.teil } as unknown as Record<string, unknown>;
    for (const [feld, wert] of Object.entries(quelle)) {
      const feldart = feldArt(von.art, feld);
      if (feldart === 'global' || (art === 'neu' && feldart === 'neu')) teil[feld] = wert;
    }
    zu =
      art === 'neu'
        ? { id: ankerKennung(), k: anker.k, teil: teil as unknown as Maskenteil, neuRechnen: true }
        : { ...anker, teil: teil as unknown as Maskenteil };
  }
  uebernommen.set(anker, { von, art, zu });
  return zu;
}

function ankerGleich(a: readonly Anker[], b: readonly Anker[]): boolean {
  return a.length === b.length && a.every((anker, i) => anker === b[i]);
}

function anpassungGleich(a: Bereichston, b: Bereichston): boolean {
  return gleich(a, b);
}

/** Was der Editor an Bild k gezeigt bekam. */
export interface Gezeigt {
  readonly k: number;
  readonly z: Zusammensetzung;
  /** Die Masken, wie sie beim Zusammensetzen waren – dorthin führt ein Rückgängig. */
  readonly vorSitzung: readonly Maske[];
}

/**
 * Hat der Editor diese Maske in der laufenden Sitzung an Bild k angelegt?
 *
 * Solche Masken „gehören" dem Editor wie die ausgegebenen: Fehlen sie in
 * seiner nächsten Meldung, hat er sie gelöscht. Erkannt werden sie daran,
 * dass es sie vor der Sitzung nicht gab und dass jedes Teil genau EINEN
 * Weg hat – Anker an k, mit dem Teil des Editors selbst (gleiche Kennung).
 *
 * # Warum nicht einfach „nicht in `vorSitzung`"
 *
 * Weil auch die Zeitleiste Masken anlegt, während der Editor offen ist:
 * „Hier trennen" macht aus einer zwei. Die zweite gab es vor der Sitzung
 * nicht, und bis der Editor neu geladen hat, fehlt sie in seinen Meldungen.
 * Als „nicht in `vorSitzung`" gezählt, löschte die nächste Reglerbewegung
 * sie wieder. Ihre Teile tragen aber neue Kennungen über den alten Ankern –
 * daran scheitert sie hier.
 */
function imEditorAngelegt(maske: Maske, k: number, vorher: ReadonlySet<string>): boolean {
  if (vorher.has(maske.id)) return false;
  return maske.teile.every((teil) =>
    teil.anker.every((anker) => anker.k === k && anker.teil.id === teil.id),
  );
}

export interface Routung {
  /** Das Dokument des Abschnitts – ohne Bereiche, die leben in den Masken. */
  readonly clipDoc: BildDoc;
  /** Dieselbe Liste, wenn sich an den Masken nichts geändert hat. */
  readonly masken: readonly Maske[];
  /** Dieselbe Tabelle, wenn nichts gelöscht oder zurückgeholt wurde. */
  readonly geloescht: ReadonlyMap<string, Maske>;
  /** Neu angelegte Masken – die letzte wird in der Zeitleiste gewählt. */
  readonly neu: readonly string[];
  /** Warum die Maskenänderung abgelehnt wurde; `masken` und `geloescht` sind dann die alten. */
  readonly abgelehnt?: string;
}

/**
 * Eine Änderung aus dem Editor auf die Masken des Films verteilen.
 *
 * Für jeden Bereich im neuen Dokument:
 * - **ausgegeben** (in `z.enthalten`): Name, Schalter und Regler übernehmen.
 *   Ist das Teilefeld dasselbe wie ausgegeben, bleiben die Teile, wie sie
 *   sind. Sonst je Teil:
 *   - dasselbe Objekt wie ausgegeben → das Spurteil von VOR der Sitzung
 *     (ein Rückgängig im Editor holt so auch die alten Anker zurück, deren
 *     Ketten noch gerechnet vorliegen);
 *   - neue Kennung → ein neues Spurteil mit einem Anker hier;
 *   - geändert → nach `FELDER`: lokal wird ein Anker hier (eingesetzt oder
 *     ersetzt), global geht in alle Anker, `neu` beides plus `neuRechnen`.
 * - **in dieser Sitzung neu angelegt** (nicht in `vorSitzung`, aber in
 *   `masken`): wie beim Anlegen, mit denselben Ankern je Teilobjekt.
 * - **gelöscht** (in `geloescht`): kommt zurück, mit Geltung und Ankern.
 * - **unbekannt**: eine neue Maske – `ganz`, freie Farbe, eindeutiger Name.
 *
 * Eine ausgegebene Maske, die im neuen Dokument fehlt, ist gelöscht – im
 * ganzen Film – und landet in `geloescht`. Masken, die gar nicht ausgegeben
 * waren (gelten hier nicht, noch nicht verfolgt), bleiben unberührt; sie
 * fehlen im Editor, aber sie sind nicht gelöscht.
 *
 * Die erste Meldung nach dem Laden ist eine Kopie des Startdokuments
 * (`docKopie` reicht die Teilefelder durch) – sie ändert nichts und gibt
 * dieselben Objekte zurück.
 */
export function editorAenderung(
  neu: BildDoc,
  gezeigt: Gezeigt,
  masken: readonly Maske[],
  geloescht: ReadonlyMap<string, Maske>,
  bezug: Bezug,
): Routung {
  const { k, z, vorSitzung } = gezeigt;
  const clipDoc: BildDoc = { ...neu, bereiche: [] };
  const aktuell = new Map(masken.map((maske) => [maske.id, maske]));
  const vorher = new Map(vorSitzung.map((maske) => [maske.id, maske]));
  const vorherIds = new Set(vorher.keys());
  /** Was der Editor an diesem Bild „besitzt" – nur das kann er löschen. */
  const besessen = (maske: Maske) =>
    z.enthalten.has(maske.id) || imEditorAngelegt(maske, k, vorherIds);
  const imDoc = new Set(neu.bereiche.map((bereich) => bereich.id));
  const neuGeloescht = new Map(geloescht);
  const angelegt: string[] = [];
  /** Die Masken, die der Editor an diesem Bild „besitzt" – in der Reihenfolge des Dokuments. */
  const geordnet: Maske[] = [];
  /** Davon die zurückgeholten und neuen: Sie haben keinen Platz in der alten Liste. */
  const ohnePlatz = new Set<string>();

  for (const bereich of neu.bereiche) {
    const ausgegeben = z.enthalten.get(bereich.id);
    if (ausgegeben) {
      const basis = aktuell.get(bereich.id) ?? geloescht.get(bereich.id) ?? vorher.get(bereich.id);
      if (!basis) continue;
      if (!aktuell.has(bereich.id)) ohnePlatz.add(bereich.id);
      neuGeloescht.delete(bereich.id);
      const vorTeile = new Map((vorher.get(bereich.id) ?? basis).teile.map((t) => [t.id, t]));
      const jetztTeile = new Map(basis.teile.map((t) => [t.id, t]));
      const teile =
        bereich.teile === ausgegeben
          ? (vorher.get(bereich.id) ?? basis).teile
          : bereich.teile.map((teil) => teilRouten(teil, ausgegeben, vorTeile, jetztTeile, k));
      geordnet.push(maskeFortschreiben(basis, bereich, teile, [...aktuell.values(), ...geordnet]));
    } else if (aktuell.has(bereich.id) && besessen(aktuell.get(bereich.id) as Maske)) {
      /*
       * In dieser Sitzung angelegt: Die Anker hängen am Teilobjekt, bleiben
       * also stabil – und eine rein globale Änderung (Umkehren, Modus)
       * behält den Anker, den das Teil schon hat, samt seiner Kette.
       */
      const basis = aktuell.get(bereich.id) as Maske;
      const jetztTeile = new Map(basis.teile.map((t) => [t.id, t]));
      const teile = bereich.teile.map((teil) => {
        const jetzt = jetztTeile.get(teil.id);
        const global = jetzt ? nurGlobal(jetzt, teil, k) : null;
        return global ?? { id: teil.id, anker: [ankerFuer(k, teil)] };
      });
      geordnet.push(maskeFortschreiben(basis, bereich, teile, [...aktuell.values(), ...geordnet]));
    } else if (geloescht.has(bereich.id) && !aktuell.has(bereich.id)) {
      const alt = geloescht.get(bereich.id) as Maske;
      neuGeloescht.delete(bereich.id);
      ohnePlatz.add(bereich.id);
      geordnet.push(
        maskeFortschreiben(alt, bereich, alt.teile, [...aktuell.values(), ...geordnet]),
      );
    } else if (aktuell.has(bereich.id)) {
      // Eine Kennung, die es gibt, die aber hier nicht ausgegeben war – das
      // darf nicht vorkommen. Lieber ablehnen und neu laden als raten.
      return {
        clipDoc,
        masken,
        geloescht,
        neu: [],
        abgelehnt: 'Die Masken passten nicht mehr zum Bild – es wird neu geladen.',
      };
    } else {
      const vergeben = [...aktuell.values(), ...geordnet];
      const maske: Maske = {
        id: bereich.id,
        name: eindeutigerName(bereich.name, vergeben),
        aktiv: bereich.aktiv,
        anpassung: { ...bereich.anpassung },
        geltung: { art: 'ganz' },
        farbe: freieFarbe(vergeben),
        teile: bereich.teile.map((teil) => ({ id: teil.id, anker: [ankerFuer(k, teil)] })),
      };
      angelegt.push(maske.id);
      ohnePlatz.add(maske.id);
      geordnet.push(maske);
    }
  }

  // Ausgegeben oder hier angelegt, aber nicht mehr im Dokument: gelöscht.
  for (const maske of masken) {
    if (besessen(maske) && !imDoc.has(maske.id)) {
      neuGeloescht.set(maske.id, maske);
      while (neuGeloescht.size > GELOESCHT_MAX) {
        neuGeloescht.delete(neuGeloescht.keys().next().value as string);
      }
    }
  }

  // Die Plätze der besessenen Masken in der alten Liste, in Dokumentreihenfolge neu belegt.
  const mitPlatz = geordnet.filter((maske) => !ohnePlatz.has(maske.id));
  let naechster = 0;
  const liste: Maske[] = [];
  for (const maske of masken) {
    if (!besessen(maske)) liste.push(maske);
    else if (imDoc.has(maske.id)) {
      liste.push(mitPlatz[naechster]);
      naechster += 1;
    }
  }
  /*
   * Zurückgeholte Masken an ihre alte Stelle – die Reihenfolge ist die, in
   * der sie wirken, und ein Rückgängig soll das Bild von vorher ergeben.
   * Neue ans Ende.
   */
  const alteStelle = new Map(vorSitzung.map((maske, i) => [maske.id, i]));
  for (const maske of geordnet) {
    if (!ohnePlatz.has(maske.id)) continue;
    const stelle = alteStelle.get(maske.id);
    if (stelle === undefined) liste.push(maske);
    else liste.splice(Math.min(stelle, liste.length), 0, maske);
  }

  const gleichGeblieben =
    liste.length === masken.length && liste.every((maske, i) => maske === masken[i]);
  const ergebnis = gleichGeblieben ? masken : liste;
  const geloeschtGleich =
    neuGeloescht.size === geloescht.size &&
    [...neuGeloescht].every(([id, maske]) => geloescht.get(id) === maske);

  if (ohnePlatz.size > 0) {
    const grund = grenzeVerletzt(ergebnis, bezug);
    if (grund) return { clipDoc, masken, geloescht, neu: [], abgelehnt: grund };
  }
  return {
    clipDoc,
    masken: ergebnis,
    geloescht: geloeschtGleich ? geloescht : neuGeloescht,
    neu: angelegt,
  };
}

/**
 * Unterscheidet sich `teil` vom Anker, den das Spurteil JETZT an Bild k hat,
 * nur in globalen Feldern? Dann das Spurteil mit diesem Anker (gleiche
 * Kennung, das Teil des Editors) und den globalen Feldern in allen anderen –
 * sonst `null`.
 *
 * # Warum gegen den Anker von jetzt und nicht gegen das Ausgegebene
 *
 * Weil in einer Sitzung eine Änderung auf die andere folgt. Wer ein Motiv
 * antippt (ein Anker hier) und danach „Umkehren" drückt, schickt ein Teil,
 * das sich vom AUSGEGEBENEN lokal UND global unterscheidet – verglichen damit
 * wäre es ein neuer Anker, und die ganze Verfolgung begänne von vorn, für
 * einen Schalter, der nichts neu rechnet. Vom Anker, den der Tipp gesetzt
 * hat, unterscheidet es sich nur im Schalter.
 */
function nurGlobal(jetzt: SpurTeil, teil: Maskenteil, k: number): SpurTeil | null {
  const hier = jetzt.anker.find((a) => a.k === k);
  if (!hier) return null;
  const unterschied = teilUnterschied(hier.teil, teil);
  if (unterschied.lokal || unterschied.neu) return null;
  // Dasselbe wie der Anker hier (vielleicht als Kopie): nichts zu tun.
  if (!unterschied.global) return jetzt;
  return {
    id: teil.id,
    anker: jetzt.anker.map((a) =>
      a === hier ? feldUebernehmen(a, teil, 'hier') : feldUebernehmen(a, teil, 'global'),
    ),
  };
}

/** Ein Teil aus dem Editor auf sein Spurteil abbilden – siehe `editorAenderung`. */
function teilRouten(
  teil: Maskenteil,
  ausgegeben: readonly Maskenteil[],
  vorTeile: ReadonlyMap<string, SpurTeil>,
  jetztTeile: ReadonlyMap<string, SpurTeil>,
  k: number,
): SpurTeil {
  const damals = ausgegeben.find((t) => t.id === teil.id);
  const spur = vorTeile.get(teil.id);
  if (!damals || !spur) {
    const jetzt = jetztTeile.get(teil.id);
    return (jetzt && nurGlobal(jetzt, teil, k)) ?? { id: teil.id, anker: [ankerFuer(k, teil)] };
  }
  if (damals === teil) return spur;
  // Schon ein Anker hier (aus dieser Sitzung oder von vorher): siehe `nurGlobal`.
  const jetzt = jetztTeile.get(teil.id);
  const global = jetzt ? nurGlobal(jetzt, teil, k) : null;
  if (global) return global;
  const unterschied = teilUnterschied(damals, teil);
  if (!unterschied.lokal && !unterschied.global && !unterschied.neu) return spur;
  let anker = spur.anker;
  if (unterschied.global || unterschied.neu) {
    const art = unterschied.neu ? 'neu' : 'global';
    anker = anker.map((a) => (a.k === k ? a : feldUebernehmen(a, teil, art)));
  }
  if (unterschied.lokal || unterschied.neu) {
    anker = ankerSetzen(anker, ankerFuer(k, teil));
  } else {
    // Nur global: Ein Anker HIER bekommt das Teil des Editors, behält aber seine Kennung.
    anker = anker.map((a) => (a.k === k ? feldUebernehmen(a, teil, 'hier') : a));
  }
  return { id: teil.id, anker };
}

/**
 * Eine Maske mit Name, Schalter, Reglern und Teilen aus dem Editor – und
 * dasselbe Objekt, wenn sich nichts davon unterscheidet.
 */
function maskeFortschreiben(
  basis: Maske,
  bereich: Bereich,
  teile: readonly SpurTeil[],
  andere: readonly Maske[],
): Maske {
  const alteTeile = new Map(basis.teile.map((t) => [t.id, t]));
  /*
   * Ein Name, den der Router eindeutig gemacht hat („Motiv 2"), steht im
   * Editor weiter als „Motiv" – bis zum nächsten Laden. Ohne diesen Schritt
   * spränge er bei jeder Meldung zurück.
   */
  const name =
    bereich.name === basis.name
      ? basis.name
      : eindeutigerName(
          bereich.name,
          andere.filter((maske) => maske.id !== basis.id),
        );
  const stabil = teile.map((teil) => {
    const alt = alteTeile.get(teil.id);
    return alt && ankerGleich(alt.anker, teil.anker) ? alt : teil;
  });
  const teileGleich =
    stabil.length === basis.teile.length && stabil.every((teil, i) => teil === basis.teile[i]);
  const anpassung = anpassungGleich(basis.anpassung, bereich.anpassung)
    ? basis.anpassung
    : { ...bereich.anpassung };
  if (
    teileGleich &&
    basis.name === name &&
    basis.aktiv === bereich.aktiv &&
    anpassung === basis.anpassung
  ) {
    return basis;
  }
  return {
    ...basis,
    name,
    aktiv: bereich.aktiv,
    anpassung,
    teile: teileGleich ? basis.teile : stabil,
  };
}

/** Die kleinste Farbe, die noch keine Maske hat. */
export function freieFarbe(masken: readonly Maske[]): number {
  const belegt = new Set(masken.map((maske) => maske.farbe));
  for (let farbe = 0; farbe < MASKEN_MAX; farbe += 1) if (!belegt.has(farbe)) return farbe;
  return masken.length % MASKEN_MAX;
}

/**
 * „Motiv", „Motiv 2", „Motiv 3" – damit zwei Bahnen nicht gleich heissen.
 *
 * Eine Zahl am Ende wird weitergezählt statt noch eine anzuhängen: „Bereich 2"
 * wird „Bereich 3", nicht „Bereich 2 2" – so hiess die zweite Hälfte nach
 * „Hier trennen", und aus zwei Namen wurde ein Rätsel.
 */
export function eindeutigerName(name: string, masken: readonly Maske[]): string {
  const belegt = new Set(masken.map((maske) => maske.name));
  if (!belegt.has(name)) return name;
  const mitZahl = /^(.*\S)\s+(\d+)$/.exec(name);
  const stamm = mitZahl ? mitZahl[1] : name;
  for (let n = mitZahl ? Number(mitZahl[2]) + 1 : 2; ; n += 1) {
    const versuch = `${stamm} ${n}`;
    if (!belegt.has(versuch)) return versuch;
  }
}

/* ---------- Werkzeuge der Bahn ---------- */

/**
 * „Hier trennen": aus einer Maske zwei – vor der Wiedergabestelle und ab
 * ihr, in Filmreihenfolge.
 *
 * Beide behalten DIESELBEN Anker: Nichts wird neu verfolgt, die Ketten sind
 * dieselben (ihr Schlüssel enthält keine Maskenkennung). Die zweite bekommt
 * neue Teilkennungen – sonst hielte der Router eine Änderung an ihr für eine
 * an der ersten. So lassen sich dieselbe Person vorn und hinten verschieden
 * einstellen.
 *
 * Ein Quellbild, das vor UND hinter der Stelle im Film steht, gehört der
 * zweiten – zwei Masken mit denselben Ankern an einem Bild wirkten doppelt.
 */
export function maskeTrennen(
  masken: readonly Maske[],
  id: string,
  bezug: Bezug,
  filmMs: number,
  neueId = maskenKennung(),
): { masken: readonly Maske[]; neu: string } | { abgelehnt: string } {
  const stelle = masken.findIndex((maske) => maske.id === id);
  const maske = masken[stelle];
  if (!maske) return { abgelehnt: 'Diese Maske gibt es nicht mehr.' };
  if (masken.length >= MASKEN_MAX) {
    return {
      abgelehnt: `Höchstens ${MASKEN_MAX} Masken im ganzen Film – zum Trennen erst eine löschen.`,
    };
  }
  const stellen = stellenVon(bezug);
  const hier = stelleAn(bezug, stellen, filmMs);
  if (hier === null) return { abgelehnt: 'Hier ist kein Film.' };
  const alle = geltungStuecke(maske.geltung, bezug);
  const hinten = stueckeSchnitt(alle, filmStrecke(stellen, hier, stellen.gesamt - 1));
  const vorn = stueckeOhne(stueckeSchnitt(alle, filmStrecke(stellen, 0, hier - 1)), hinten);
  if (vorn.length === 0 || hinten.length === 0) {
    return { abgelehnt: 'Hier gibt es nichts zu trennen – die Maske gilt nur auf einer Seite.' };
  }
  const erste: Maske = { ...maske, geltung: { art: 'stuecke', stuecke: vorn } };
  const zweite: Maske = {
    ...maske,
    id: neueId,
    name: eindeutigerName(maske.name, masken),
    farbe: freieFarbe(masken),
    geltung: { art: 'stuecke', stuecke: hinten },
    teile: maske.teile.map((teil) => ({ id: teilKennung(), anker: teil.anker })),
  };
  return {
    masken: [...masken.slice(0, stelle), erste, zweite, ...masken.slice(stelle + 1)],
    neu: neueId,
  };
}

/**
 * Die Anker an Bild k aus einer Maske nehmen – nur bei Teilen, die danach
 * noch einen haben. Die Nachbarn rechnen dann von ihrem gespeicherten Rand
 * aus weiter.
 */
export function ankerEntfernen(
  masken: readonly Maske[],
  maskeId: string,
  k: number,
): readonly Maske[] {
  let geaendert = false;
  const neu = masken.map((maske) => {
    if (maske.id !== maskeId) return maske;
    let teileGeaendert = false;
    const teile = maske.teile.map((teil) => {
      if (teil.anker.length < 2 || !teil.anker.some((a) => a.k === k)) return teil;
      teileGeaendert = true;
      return { ...teil, anker: teil.anker.filter((a) => a.k !== k) };
    });
    if (!teileGeaendert) return maske;
    geaendert = true;
    return { ...maske, teile };
  });
  return geaendert ? neu : masken;
}

/* ---------- Übergänge ---------- */

/**
 * Bereiche, die noch in Abschnittsdokumenten stehen, zu Masken machen.
 *
 * Für eine Sitzung, die über die Umstellung hinweg lebt, und für jeden, der
 * noch Dokumente mit Bereichen hereinreicht. Jeder Bereich wird eine Maske
 * mit der Geltung „nur diese Abschnitte" – genau das, was er vorher
 * bedeutete. Ihre Anker stehen an dem Bild, zu dem die Masken gehören
 * (`teileMs`, sonst das Stellbild).
 *
 * Zusammengefasst wird nach DOKUMENT, nicht nach Abschnitt: Die beiden
 * Hälften eines geteilten Abschnitts tragen dasselbe Dokument und damit
 * dieselben Bereichskennungen. Je Abschnitt umgewandelt, entstünden zwei
 * Masken mit derselben Kennung. So wird es EINE Maske für beide Hälften.
 * Kommt eine Kennung trotzdem zweimal vor (eine Hälfte wurde danach eigens
 * bearbeitet), bekommt die zweite eine neue.
 *
 * Was nicht mehr passt (`MASKEN_MAX`, `BEREICHE_MAX` je Bild), fällt weg und
 * wird gezählt – der Aufrufer sagt es an.
 */
export function bereicheUmwandeln(
  abschnitte: readonly Abschnitt[],
  masken: readonly Maske[],
  s: number,
  mass?: { readonly b: number; readonly h: number },
): { abschnitte: readonly Abschnitt[]; masken: readonly Maske[]; verworfen: number } {
  if (!abschnitte.some((abschnitt) => (abschnitt.doc?.bereiche.length ?? 0) > 0)) {
    return { abschnitte, masken, verworfen: 0 };
  }
  const gruppen = new Map<BildDoc, Abschnitt[]>();
  for (const abschnitt of abschnitte) {
    const doc = abschnitt.doc;
    if (!doc || doc.bereiche.length === 0) continue;
    const gruppe = gruppen.get(doc);
    if (gruppe) gruppe.push(abschnitt);
    else gruppen.set(doc, [abschnitt]);
  }
  const bezug: Bezug = { abschnitte, s };
  let liste: Maske[] = masken.slice();
  let verworfen = 0;
  const ersatz = new Map<BildDoc, BildDoc | null>();
  for (const [doc, gruppe] of gruppen) {
    const k = bildIndex(gruppe[0].teileMs ?? gruppe[0].standMs, s);
    const geltung: Geltung = { art: 'abschnitte', ids: gruppe.map((abschnitt) => abschnitt.id) };
    for (const bereich of doc.bereiche) {
      /*
       * Eine schon vergebene Kennung: Eine Hälfte wurde nach dem Teilen eigens
       * bearbeitet und trägt dieselben Bereichs- und oft dieselben
       * Teilobjekte. Dann bekommt die zweite Maske neue Kennungen für sich UND
       * für ihre Teile – wie nach „Hier trennen", damit der Router eine
       * Änderung an ihr nie der ersten zuordnet.
       */
      const doppelt = liste.some((maske) => maske.id === bereich.id);
      const maske: Maske = {
        id: doppelt ? maskenKennung() : bereich.id,
        name: eindeutigerName(bereich.name, liste),
        aktiv: bereich.aktiv,
        anpassung: { ...bereich.anpassung },
        geltung,
        farbe: freieFarbe(liste),
        teile: bereich.teile.map((teil) => ({
          id: doppelt ? teilKennung() : teil.id,
          anker: [ankerFuer(k, teil)],
        })),
      };
      const versuch = [...liste, maske];
      if (grenzeVerletzt(versuch, bezug)) verworfen += 1;
      else liste = versuch;
    }
    const ohne: BildDoc = { ...doc, bereiche: [] };
    ersatz.set(doc, mass && docUnberuehrt(ohne, mass.b, mass.h) ? null : ohne);
  }
  const neuAbschnitte = abschnitte.map((abschnitt) => {
    if (!abschnitt.doc || !ersatz.has(abschnitt.doc)) return abschnitt;
    const { teileMs: _weg, ...ohne } = abschnitt;
    return { ...ohne, doc: ersatz.get(abschnitt.doc) ?? null };
  });
  return { abschnitte: neuAbschnitte, masken: liste, verworfen };
}

/**
 * Die Masken auf das Raster einer neuen Bildrate legen.
 *
 * Ein Anker wandert auf das Bild, das seine alte Mitte enthält; Grenzen von
 * Stücken auf die nächste Kante. Die Ankerkennungen bleiben – die Ketten
 * werden trotzdem neu gerechnet, weil ihr Schlüssel die Schrittweite
 * enthält.
 */
export function maskenUmrastern(
  masken: readonly Maske[],
  sAlt: number,
  sNeu: number,
): readonly Maske[] {
  if (sAlt === sNeu) return masken;
  const kNeu = (k: number) => bildIndex(bildMitte(k, sAlt), sNeu);
  const grenze = (k: number) => (Number.isFinite(k) ? Math.round((k * sAlt) / sNeu) : k);
  const geltungNeu = <G extends Geltung>(g: G): G =>
    g.art === 'stuecke'
      ? ({
          ...g,
          stuecke: stueckeNormal(
            g.stuecke.map((st) => ({
              vonK: grenze(st.vonK),
              bisK: Math.max(grenze(st.vonK) + 1, grenze(st.bisK)),
            })),
          ),
        } as G)
      : g;
  return masken.map((maske) => ({
    ...maske,
    geltung: geltungNeu(maske.geltung),
    ...(maske.zuletzt ? { zuletzt: geltungNeu(maske.zuletzt) } : {}),
    teile: maske.teile.map((teil) => {
      const anker: Anker[] = [];
      for (const a of teil.anker) {
        const k = kNeu(a.k);
        // Zwei Anker, die auf dasselbe Bild fallen: Der spätere gewinnt.
        if (anker.length > 0 && anker[anker.length - 1].k === k) anker.pop();
        anker.push({ ...a, k });
      }
      return { ...teil, anker };
    }),
  }));
}
