import type { BildDoc } from '../bild/doc.js';
import { kannTeilen, type Stueck } from './ausschnitt.js';
import { istFormTeil, istInhaltsTeil } from './bildweise.js';
import { bildIndex, quellBilder } from './raster.js';

/**
 * Die Abschnitte eines Films – jeder mit seiner EIGENEN Bearbeitung.
 *
 * # Warum je Abschnitt ein Dokument
 *
 * Weil „schneiden, während man bearbeitet" genau das heisst: Ein Film wird
 * an einer Stelle geteilt, und ab dort sieht er anders aus. Wärmer, dunkler,
 * mit einer Person freigestellt, die im ersten Teil noch gar nicht im Bild
 * war. Eine Bearbeitung für den ganzen Film kann das nicht, und eine mit
 * Zeitangaben an jedem Bereich (so stand es hier vorher) machte aus einer
 * einfachen Frage – „was gilt HIER?" – eine Rechnung über Zeiträume, die
 * niemand in der Oberfläche nachvollziehen konnte.
 *
 * Es ist dasselbe Modell wie in jedem Schnittprogramm: Der Film ist eine
 * Reihe von Abschnitten, jeder zeigt ein Stück des Quellvideos und trägt
 * seine eigene Farbkorrektur. Wer teilt, bekommt zwei Hälften mit DERSELBEN
 * Bearbeitung – geteilt zu haben ändert nichts am Ergebnis, erst das
 * Bearbeiten einer Hälfte tut es.
 *
 * # Das Stellbild
 *
 * Eingestellt wird an einem Standbild, und für alles, was aus dem
 * Bildinhalt gerechnet ist (Freistellen, Tiefe, Antippen), heisst das: Die
 * Maske gehört zu GENAU diesem Bild. `standMs` hält fest, welches es war;
 * beim Filmbau beginnt die Verfolgung dort und läuft von da aus rückwärts
 * zum Anfang und vorwärts zum Ende des Abschnitts.
 *
 * Das Stellbild liegt immer IM Abschnitt. Fällt es durch Teilen oder
 * Kürzen heraus, meldet die Funktion hier eine `Verlegung`: Die Masken
 * müssen an ein Bild im Abschnitt mitgenommen werden, und das rechnet
 * `verlegen.ts` – nicht diese Datei, die bleibt reine Arithmetik.
 *
 * # Die Kanten liegen auf dem Raster
 *
 * Jede Kante, die hier entsteht, ist ein Vielfaches der Schrittweite `s` –
 * beim Teilen, Kürzen, Hinzufügen und nach einem Wechsel der Bildrate
 * (`rasterNeu`). Warum, steht in `raster.ts`: Nur dann ist Bild i eines
 * Abschnitts genau Rasterbild `von/s + i`, und Editor, Vorschau, Verfolgung
 * und Filmbau sehen an derselben Stelle dasselbe Bild.
 *
 * Gerechnet wird dafür in ganzen Bildern und erst am Ende mal `s`. So ist
 * eine Kante immer genau `k · s` – auch bei 41,666… ms, wo eine Rechnung in
 * Millisekunden (`a · s − b · s`) um ein paar Billionstel danebenläge.
 */

export interface Abschnitt extends Stueck {
  /** Bleibt über Teilen, Kürzen und Verschieben gleich – der Schlüssel in der Oberfläche. */
  readonly id: string;
  /** Die Bearbeitung dieses Abschnitts; `null` heisst unbearbeitet. */
  readonly doc: BildDoc | null;
  /** Das Bild im Quellvideo, an dem eingestellt wird – siehe oben. */
  readonly standMs: number;
  /**
   * Zu welchem Bild die Masken im Dokument GERADE gehören, falls das nicht
   * das Stellbild ist – solange sie noch mitgenommen werden müssen.
   *
   * Ein eigenes Feld und nicht bloss eine Aufgabe in einer Warteschlange:
   * Wird ein Abschnitt zweimal hintereinander gekürzt, bevor die erste
   * Mitnahme fertig ist, gehören die Masken immer noch zum ALLERERSTEN
   * Bild. Von dort muss die Verfolgung loslaufen, nicht vom Zwischenstand.
   */
  readonly teileMs?: number;
}

/**
 * Hängt am Dokument etwas, das zu EINEM Bild gehört – Freistellen, Tiefe,
 * Antippen?
 *
 * Auch in abgeschalteten Bereichen: Wer einen Bereich später wieder
 * einschaltet, bekäme sonst die Maske eines Bildes, das längst woanders
 * liegt.
 */
export function hatInhaltsTeile(doc: BildDoc | null | undefined): boolean {
  return Boolean(doc?.bereiche.some((bereich) => bereich.teile.some(istInhaltsTeil)));
}

/**
 * Hängt am Dokument irgendetwas, das zu EINEM Bild gehört – eine Maske aus
 * dem Bildinhalt ODER eine Form, die an eine Stelle darin gezeichnet ist?
 *
 * Auch die Formen: Ein Verlauf, eine Ellipse, ein Pinselstrich steht in
 * Punkten des Stellbildes, und beim Filmbau wandert er von DORT aus mit der
 * Kamera. Rückt das Stellbild, ohne dass die Form mitgenommen wird, liegt
 * sie auf einmal an derselben Stelle eines anderen Bildes – bei einem
 * Schwenk also woanders in der Szene.
 */
export function haengtAmBild(doc: BildDoc | null | undefined): boolean {
  return Boolean(
    doc?.bereiche.some((bereich) =>
      bereich.teile.some((teil) => istInhaltsTeil(teil) || istFormTeil(teil)),
    ),
  );
}

/** Muss an diesem Abschnitt noch etwas mitgenommen werden? */
export function mussVerlegen(abschnitt: Abschnitt): boolean {
  return (
    abschnitt.teileMs !== undefined &&
    abschnitt.teileMs !== abschnitt.standMs &&
    haengtAmBild(abschnitt.doc)
  );
}

/**
 * Eine Verlegung eintragen: Das Stellbild ist schon versetzt (das tun die
 * Funktionen unten), hier wird vermerkt, wo die Masken noch stehen – und
 * zwar der ÄLTESTE offene Stand, siehe `teileMs`.
 */
export function verlegungVermerken(
  abschnitte: readonly Abschnitt[],
  verlegung: Verlegung | null,
): readonly Abschnitt[] {
  if (!verlegung) return abschnitte;
  return abschnitte.map((abschnitt) => {
    if (abschnitt.id !== verlegung.id || !haengtAmBild(abschnitt.doc)) return abschnitt;
    const teileMs = abschnitt.teileMs ?? verlegung.vonMs;
    if (teileMs === abschnitt.standMs) {
      const { teileMs: _weg, ...ohne } = abschnitt;
      return ohne;
    }
    return { ...abschnitt, teileMs };
  });
}

/** Ein Abschnitt, dessen Masken an ein anderes Bild mitgenommen werden müssen. */
export interface Verlegung {
  readonly id: string;
  /** Das Bild, zu dem die Masken im Dokument gehören. */
  readonly vonMs: number;
  /** Das neue Stellbild. */
  readonly nachMs: number;
}

let zaehler = 0;
/** Eine neue Kennung – eindeutig in dieser Sitzung, mehr braucht es nicht. */
export function abschnittKennung(): string {
  zaehler += 1;
  return `a${Date.now().toString(36)}${zaehler.toString(36)}`;
}

function dauer(stueck: Stueck): number {
  return Math.max(0, stueck.bisMs - stueck.vonMs);
}

/** Wie lang der Film aus diesen Abschnitten ist. */
export function filmDauerMs(abschnitte: readonly Stueck[]): number {
  return abschnitte.reduce((summe, stueck) => summe + dauer(stueck), 0);
}

/** Wo im Film ein Abschnitt anfängt. */
export function filmAnfangMs(abschnitte: readonly Stueck[], nummer: number): number {
  let start = 0;
  for (let i = 0; i < nummer && i < abschnitte.length; i += 1) start += dauer(abschnitte[i]);
  return start;
}

/**
 * Eine Stelle im FILM als Abschnitt und Stelle im QUELLvideo.
 *
 * Halboffen: Die Grenze zwischen zwei Abschnitten gehört dem späteren –
 * dort fängt er an. Hinter dem Ende steht das Ende des letzten.
 */
export function filmZuQuelle(
  abschnitte: readonly Stueck[],
  filmMs: number,
): { nummer: number; quelleMs: number } | null {
  if (abschnitte.length === 0) return null;
  let start = 0;
  for (let i = 0; i < abschnitte.length; i += 1) {
    const laenge = dauer(abschnitte[i]);
    if (filmMs < start + laenge) {
      return { nummer: i, quelleMs: abschnitte[i].vonMs + Math.max(0, filmMs - start) };
    }
    start += laenge;
  }
  const letzter = abschnitte.length - 1;
  return { nummer: letzter, quelleMs: abschnitte[letzter].bisMs };
}

/** Eine Stelle im Quellvideo, gesehen in einem bestimmten Abschnitt, als Stelle im Film. */
export function quelleZuFilm(
  abschnitte: readonly Stueck[],
  nummer: number,
  quelleMs: number,
): number {
  const stueck = abschnitte[nummer];
  if (!stueck) return filmDauerMs(abschnitte);
  const innen = Math.min(dauer(stueck), Math.max(0, quelleMs - stueck.vonMs));
  return filmAnfangMs(abschnitte, nummer) + innen;
}

/**
 * Das Bild im Raster des Films, das `ms` am nächsten liegt.
 *
 * Dasselbe Raster wie `abtasten` mit `mitte`: Bild i liegt bei
 * `von + (i + ½) · schritt`. Ein Stellbild auf diesem Raster IST später ein
 * Bild des Films – nicht eines daneben, an dem die Maske um ein Bild
 * verrutscht wäre.
 */
export function standImRaster(stueck: Stueck, ms: number, schrittMs: number): number {
  const schritt = Math.max(1, schrittMs);
  const anzahl = Math.max(1, Math.round(dauer(stueck) / schritt));
  const i = Math.min(anzahl - 1, Math.max(0, Math.round((ms - stueck.vonMs) / schritt - 0.5)));
  return stueck.vonMs + (i + 0.5) * schritt;
}

/**
 * Liegt das Stellbild in seinem Abschnitt?
 *
 * Das Ende zählt mit: Bei einer Länge von zweieinhalb Bildern rundet
 * `abtasten` auf drei, und das dritte liegt genau auf dem Ende – es ist ein
 * Bild des Films und damit ein gültiges Stellbild.
 */
export function standDrin(abschnitt: Abschnitt): boolean {
  return abschnitt.standMs >= abschnitt.vonMs && abschnitt.standMs <= abschnitt.bisMs;
}

/**
 * Einen Abschnitt an einer Stelle im Quellvideo teilen.
 *
 * Beide Hälften behalten DASSELBE Dokument. Die Hälfte, in der das
 * Stellbild liegt, behält es; die andere bekommt das nächstgelegene Bild in
 * ihr als Stellbild – und eine Verlegung, falls ihr Dokument Masken trägt
 * (das entscheidet der Aufrufer).
 *
 * `null`, wenn die Stelle nicht echt dazwischen liegt – siehe `kannTeilen`.
 *
 * # Geprüft wird die Stelle, geteilt wird auf dem Raster
 *
 * Die Prüfung ist dieselbe wie die, mit der die Zeitleiste den Knopf ✂
 * freigibt (`kannTeilen` mit einem gerundeten Bild Abstand) – und zwar mit
 * der UNgerundeten Stelle. Erst danach kommt die Stelle aufs Raster und,
 * falls sie zu nah an einer Kante läge, um ein Bild nach innen. Prüfte man
 * die gerundete Stelle, wäre der Knopf an einer Stelle frei, an der das
 * Teilen dann nichts täte (bei 24 Bildern je Sekunde liegt 1043 ms im Bild
 * ab 1041,67 ms – ein Bild von einer Kante bei 1000 ms, aber weniger als die
 * gerundeten 42 ms).
 *
 * # Aufs Raster: an den ANFANG des Bildes, in dem die Stelle liegt
 *
 * Nicht an die nächste Kante. Die Stelle ist die Wiedergabestelle, und die
 * steht fast immer mitten in einem Bild – beim Öffnen des Editors genau auf
 * der Mitte des Stellbilds. Auf die nächste Kante gerundet, lag der Schnitt
 * in der Hälfte der Fälle HINTER ihr: Die Wiedergabestelle stand danach in
 * der vorderen Hälfte, gewählt wurde aber die hintere, und am Stellbild
 * geteilt behielt die falsche Hälfte Kennung und Stellbild. Am Anfang des
 * Bildes unter ihr beginnt dieses Bild die hintere Hälfte – wie vor dem
 * Raster, als genau an der Stelle geteilt wurde.
 */
export function abschnittTeilen(
  abschnitte: readonly Abschnitt[],
  nummer: number,
  beiMs: number,
  schrittMs: number,
  neueId = abschnittKennung(),
): { abschnitte: readonly Abschnitt[]; verlegung: Verlegung } | null {
  const alt = abschnitte[nummer];
  const mindest = Math.max(1, Math.round(schrittMs));
  if (!alt || !kannTeilen(alt, beiMs, mindest)) return null;
  const s = schrittMs;
  // Mindestens ein ganzes Bild auf jeder Seite – auch bei Kanten, die (nach
  // einem Wechsel der Bildrate) noch nicht auf dem Raster liegen.
  const kMin = Math.ceil((alt.vonMs + s) / s - 1e-6);
  const kMax = Math.floor((alt.bisMs - s) / s + 1e-6);
  if (kMin > kMax) return null;
  const bei = Math.min(kMax, Math.max(kMin, bildIndex(beiMs, s))) * s;
  /*
   * Die Kennung bleibt bei der Hälfte mit dem Stellbild. Daran hängt im
   * Editor, ob er neu aufgebaut wird – wer dort teilt, arbeitet an genau
   * dieser Hälfte weiter und soll seinen Rückgängig-Verlauf behalten.
   */
  const vorneBleibt = alt.standMs < bei;
  const vorn: Abschnitt = { ...alt, id: vorneBleibt ? alt.id : neueId, bisMs: bei };
  const hinten: Abschnitt = { ...alt, id: vorneBleibt ? neueId : alt.id, vonMs: bei };
  let verlegung: Verlegung;
  let neuVorn = vorn;
  let neuHinten = hinten;
  if (vorneBleibt) {
    const stand = standImRaster(hinten, hinten.vonMs, schrittMs);
    neuHinten = { ...hinten, standMs: stand };
    verlegung = { id: hinten.id, vonMs: alt.standMs, nachMs: stand };
  } else {
    const stand = standImRaster(vorn, vorn.bisMs, schrittMs);
    neuVorn = { ...vorn, standMs: stand };
    verlegung = { id: vorn.id, vonMs: alt.standMs, nachMs: stand };
  }
  return {
    abschnitte: [
      ...abschnitte.slice(0, nummer),
      neuVorn,
      neuHinten,
      ...abschnitte.slice(nummer + 1),
    ],
    verlegung,
  };
}

/**
 * Anfang und Ende eines Abschnitts neu setzen.
 *
 * Mindestens ein Bild lang und nie über das Quellvideo hinaus. Fällt das
 * Stellbild dabei heraus, rückt es an das nächste Bild im Abschnitt, und
 * die Verlegung sagt, von wo nach wo.
 *
 * Beide Kanten landen auf dem Raster. Das Ende höchstens bei
 * `quellBilder · s` – ABgerundet, siehe `quellBilder`: Auf die nächste Kante
 * gerundet, läge es bis zu einem halben Bild hinter dem Ende der Quelle, und
 * die Mitte des letzten Bildes genau auf dem Ende.
 */
export function abschnittKuerzen(
  abschnitte: readonly Abschnitt[],
  nummer: number,
  vonMs: number,
  bisMs: number,
  quelleMs: number,
  schrittMs: number,
): { abschnitte: readonly Abschnitt[]; verlegung: Verlegung | null } {
  const alt = abschnitte[nummer];
  if (!alt) return { abschnitte, verlegung: null };
  const s = schrittMs;
  const kEnde = quellBilder(quelleMs, s);
  const kVon = Math.max(0, Math.min(Math.round(vonMs / s), kEnde - 1));
  const kBis = Math.min(kEnde, Math.max(Math.round(bisMs / s), kVon + 1));
  let neu: Abschnitt = { ...alt, vonMs: kVon * s, bisMs: kBis * s };
  let verlegung: Verlegung | null = null;
  if (!standDrin(neu)) {
    const stand = standImRaster(neu, alt.standMs, schrittMs);
    verlegung = { id: alt.id, vonMs: alt.standMs, nachMs: stand };
    neu = { ...neu, standMs: stand };
  }
  return {
    abschnitte: abschnitte.map((eintrag, i) => (i === nummer ? neu : eintrag)),
    verlegung,
  };
}

/**
 * Alle Kanten auf das Raster einer (neuen) Bildrate legen.
 *
 * Für den Wechsel der Bildrate: Die Kanten lagen auf dem alten Raster und
 * rücken auf das nächste des neuen – höchstens ein halbes Bild. Jeder
 * Abschnitt bleibt mindestens ein Bild lang und im Quellvideo. Unveränderte
 * Abschnitte bleiben dieselben Objekte, und ohne jede Änderung kommt
 * dieselbe Liste zurück – sonst rechnete alles, was an ihr hängt, für nichts
 * neu.
 *
 * Das Stellbild bleibt, wo es ist, solange es im Abschnitt liegt. Fällt es
 * durch das Rücken heraus, wandert es an das nächste Bild – mit einer
 * Verlegung wie beim Kürzen.
 */
export function rasterNeu(
  abschnitte: readonly Abschnitt[],
  schrittMs: number,
  quelleMs: number,
): { abschnitte: readonly Abschnitt[]; verlegungen: readonly Verlegung[] } {
  const s = schrittMs;
  // Ohne bekannte Länge (noch nicht geladen) wird nur gerastert, nicht geklemmt.
  const kEnde = quelleMs > 0 ? quellBilder(quelleMs, s) : Number.POSITIVE_INFINITY;
  const verlegungen: Verlegung[] = [];
  let geaendert = false;
  const neu = abschnitte.map((alt) => {
    const kVon = Math.max(0, Math.min(Math.round(alt.vonMs / s), kEnde - 1));
    const kBis = Math.min(kEnde, Math.max(Math.round(alt.bisMs / s), kVon + 1));
    // Schon auf dem Raster, bis auf Gleitkommareste: `30 · (1000/30)` ist
    // nicht genau 1000, und 1000 bleibt deshalb 1000.
    if (Math.abs(alt.vonMs - kVon * s) < 1e-6 && Math.abs(alt.bisMs - kBis * s) < 1e-6) return alt;
    geaendert = true;
    let eintrag: Abschnitt = { ...alt, vonMs: kVon * s, bisMs: kBis * s };
    if (!standDrin(eintrag)) {
      const stand = standImRaster(eintrag, alt.standMs, s);
      verlegungen.push({ id: alt.id, vonMs: alt.standMs, nachMs: stand });
      eintrag = { ...eintrag, standMs: stand };
    }
    return eintrag;
  });
  return { abschnitte: geaendert ? neu : abschnitte, verlegungen };
}

/** Einen Abschnitt um eine Stelle nach vorn (−1) oder hinten (+1) schieben. */
export function abschnittVerschieben(
  abschnitte: readonly Abschnitt[],
  nummer: number,
  richtung: -1 | 1,
): readonly Abschnitt[] {
  const ziel = nummer + richtung;
  if (nummer < 0 || nummer >= abschnitte.length || ziel < 0 || ziel >= abschnitte.length) {
    return abschnitte;
  }
  const neu = abschnitte.slice();
  [neu[nummer], neu[ziel]] = [neu[ziel], neu[nummer]];
  return neu;
}

/** Einen Abschnitt herausnehmen – der letzte bleibt, ein Film ohne Bilder wäre keiner. */
export function abschnittEntfernen(
  abschnitte: readonly Abschnitt[],
  nummer: number,
): readonly Abschnitt[] {
  if (abschnitte.length <= 1 || nummer < 0 || nummer >= abschnitte.length) return abschnitte;
  return abschnitte.filter((_, i) => i !== nummer);
}

/**
 * Einen neuen Abschnitt hinter `nummer` anlegen.
 *
 * Er fängt dort an, wo der gewählte aufhört – wer einen weiteren Abschnitt
 * will, will fast immer die Stelle DANACH – und übernimmt dessen
 * Bearbeitung. Seine Masken gehören zu einem anderen Bild; das meldet die
 * Verlegung.
 *
 * Rund zwei Sekunden lang, mindestens eine Sekunde Platz vor dem Ende der
 * Quelle – gerechnet in ganzen Bildern, damit beide Kanten auf dem Raster
 * liegen.
 */
export function abschnittDazu(
  abschnitte: readonly Abschnitt[],
  nummer: number,
  quelleMs: number,
  schrittMs: number,
  neueId = abschnittKennung(),
): { abschnitte: readonly Abschnitt[]; neu: number; verlegung: Verlegung | null } {
  const vorlage = abschnitte[nummer] ?? abschnitte[abschnitte.length - 1];
  const s = schrittMs;
  const kEnde = quellBilder(quelleMs, s);
  const kPlatz = Math.max(1, Math.round(1000 / s));
  const kVon = Math.max(0, Math.min(Math.round((vorlage?.bisMs ?? 0) / s), kEnde - kPlatz));
  const kBis = Math.max(kVon + 1, Math.min(kEnde, kVon + Math.round(2000 / s)));
  const stueck = { vonMs: kVon * s, bisMs: kBis * s };
  const standMs = standImRaster(stueck, stueck.vonMs, schrittMs);
  const neu: Abschnitt = { ...stueck, id: neueId, doc: vorlage?.doc ?? null, standMs };
  const stelle = Math.min(abschnitte.length, Math.max(0, nummer + 1));
  return {
    abschnitte: [...abschnitte.slice(0, stelle), neu, ...abschnitte.slice(stelle)],
    neu: stelle,
    /*
     * Von dort, wo die Masken der Vorlage WIRKLICH gehören: Wartet die
     * Vorlage selbst noch auf ihre Mitnahme, ist das nicht ihr Stellbild.
     */
    verlegung: vorlage
      ? { id: neueId, vonMs: vorlage.teileMs ?? vorlage.standMs, nachMs: standMs }
      : null,
  };
}

/**
 * Der erste Abschnitt eines neuen Films: die Quelle von vorn bis `bisMs`,
 * auf dem Raster.
 *
 * Das Ende wird ABgerundet – `bisMs` ist schon auf die Länge der Quelle
 * begrenzt (`min(dauer, 5000)`), und aufgerundet läge die Kante bis zu einem
 * halben Bild dahinter; siehe `quellBilder`. Die Länge der Quelle selbst
 * steht hier bewusst NICHT: Das Blatt ruft das im selben Zug, in dem es sie
 * erst setzt, und bekäme sonst noch die alte (null).
 */
export function ersterAbschnitt(
  bisMs: number,
  schrittMs: number,
  neueId = abschnittKennung(),
): Abschnitt {
  const stueck = { vonMs: 0, bisMs: quellBilder(bisMs, schrittMs) * schrittMs };
  return { ...stueck, id: neueId, doc: null, standMs: standImRaster(stueck, 0, schrittMs) };
}
