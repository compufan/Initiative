/**
 * Welche Zeitpunkte aus einem Video ein GIF oder ein Film werden.
 *
 * Reines Rechnen, kein Video, kein Browser – deshalb prüfbar. Die Stellen, an
 * denen es wirklich klemmt, sind nämlich alle arithmetisch: die Standzeit, die
 * Zahl der Bilder und die Grösse der fertigen Datei.
 *
 * # Warum GIF nicht jede Bildrate bekommt
 *
 * Weil GIF die Standzeit in HUNDERTSTELSEKUNDEN zählt und sonst nichts. Bei 30
 * Bildern je Sekunde wären das 3,33 Hundertstel; gerundet auf 3 laufen die
 * Bilder mit 33,3 statt 30 je Sekunde, und über zehn Sekunden hat das GIF
 * knapp eine halbe Sekunde Vorsprung vor dem Ton, den es nicht hat, und vor
 * dem Video, aus dem es stammt. Angeboten werden deshalb nur Raten, die
 * aufgehen – und weil `gifSchreiben` die Standzeit bei zwei Hundertsteln
 * abfängt, liegt die schnellste angebotene Rate bei 25.
 *
 * # Warum der FILM ein eigenes Zeitraster hat
 *
 * Weil das Raster oben eine GIF-Regel ist und für WebM schlicht falsch.
 * `videoSchreiben` schreibt die Zeitstempel in MIKROsekunden als
 * `1000 / bildrate` (siehe `schreiben.ts`), ohne jede Rasterung. Wer mit
 * `dauerJeBildMs` abtastet und damit schreibt, holt bei 60 Bildern je Sekunde
 * die Bilder im Abstand von 20 ms und behauptet danach 16,67 ms: Der Film
 * läuft um den Faktor 1,2 zu schnell. Bei 30 wäre es umgekehrt – 30 statt
 * 33,33 ms, also 11 Prozent zu langsam. Beides lautlos.
 *
 * Nachgemessen ist das der Grund, warum es hier zwei Listen und zwei
 * Schrittweiten gibt und keine gemeinsame mit einem Sonderfall. Die heutigen
 * GIF-Raten 5, 10, 12,5, 20 und 25 gehen im Zehnmillisekunden-Raster alle
 * exakt auf; deshalb ist der Fehler nie aufgefallen.
 *
 * # Warum der Film in die BILDMITTE abtastet
 *
 * Weil ein Sprung genau auf die Bildgrenze danebengeht. Gemessen gegen eine
 * echte Quelle mit 60 Bildern je Sekunde: 140 Sprünge exakt auf
 * i × 16,667 ms lieferten nur 93 verschiedene Bilder und 47 direkte
 * Wiederholungen; ein Sprung in die Mitte (+8,33 ms) lieferte 140 von 140.
 * Bei 10 und 25 Bildern je Sekunde fällt das nie auf, und darum behält der
 * GIF-Weg seinen Abtastpunkt auf der Grenze.
 */

/** Eine wählbare Bildrate samt dem, was sie in Hundertsteln bedeutet. */
export interface Bildrate {
  /** Bilder je Sekunde. */
  readonly rate: number;
  /** Was auf dem Knopf steht. */
  readonly titel: string;
  /** Ein Satz, der bei der Wahl hilft. */
  readonly beschreibung: string;
}

export const BILDRATEN: readonly Bildrate[] = [
  { rate: 5, titel: '5/s', beschreibung: 'Ruckelig, aber winzig. Gut für lange Ausschnitte.' },
  { rate: 10, titel: '10/s', beschreibung: 'Der übliche Kompromiss.' },
  { rate: 12.5, titel: '12,5/s', beschreibung: 'Etwas flüssiger, kaum grösser.' },
  { rate: 20, titel: '20/s', beschreibung: 'Flüssig. Jedes Bild kostet Platz.' },
  { rate: 25, titel: '25/s', beschreibung: 'So schnell, wie GIF es kann.' },
] as const;

export const BILDRATE_VORGABE = 10;

/**
 * Die Bildraten für einen FILM.
 *
 * Eigene Liste, weil die Grenze bei 25 eine GIF-Grenze ist und keine
 * Videogrenze – siehe Kopf. 24 steht dabei, weil Kinomaterial so kommt; 50
 * und 60, weil ein Telefon heute so aufnimmt.
 */
export const FILM_BILDRATEN: readonly Bildrate[] = [
  { rate: 10, titel: '10/s', beschreibung: 'Sparsam. Sichtbar ruckelig.' },
  { rate: 15, titel: '15/s', beschreibung: 'Halbe Fernsehrate. Klein und noch erträglich.' },
  { rate: 24, titel: '24/s', beschreibung: 'Kino. Die übliche Rate für Gedrehtes.' },
  { rate: 25, titel: '25/s', beschreibung: 'Fernsehen in Europa.' },
  { rate: 30, titel: '30/s', beschreibung: 'Was die meisten Telefone aufnehmen.' },
  { rate: 50, titel: '50/s', beschreibung: 'Flüssig – und doppelt so schwer wie 25.' },
  { rate: 60, titel: '60/s', beschreibung: 'Das Höchste. Nur sinnvoll, wenn die Quelle das hat.' },
] as const;

/**
 * 25 und nicht 10 wie beim GIF.
 *
 * Ein GIF von zehn Bildern je Sekunde ist eine bewusste Sparmassnahme – es
 * geht in ein Gespräch und soll klein sein. Ein FILM mit zehn Bildern je
 * Sekunde sieht einfach kaputt aus, und niemand wählt das absichtlich.
 */
export const FILM_BILDRATE_VORGABE = 25;

/**
 * Der Zeitschritt für einen Film – ungerastert.
 *
 * Genau die Zahl, mit der `videoSchreiben` die Zeitstempel schreibt. Jede
 * andere hier ergäbe einen Film, der schneller oder langsamer läuft, als er
 * behauptet.
 */
export function filmSchrittMs(bildrate: number): number {
  return 1000 / Math.max(1, bildrate);
}

/**
 * Die Standzeit eines Bildes in Millisekunden.
 *
 * Immer ein Vielfaches von zehn – siehe oben. `Math.round` steht trotzdem da,
 * weil 1000 / 12.5 in Gleitkomma nicht zwingend auf 80,0 fällt.
 */
export function dauerJeBildMs(bildrate: number): number {
  return Math.max(20, Math.round(1000 / bildrate / 10) * 10);
}

export interface Ausschnitt {
  /** Die Zeitpunkte in Millisekunden, an denen ein Bild geholt wird. */
  readonly zeitpunkte: readonly number[];
  /** Der Abstand zweier Bilder – beim GIF zugleich ihre Standzeit. */
  readonly schrittMs: number;
  /**
   * Wie viel am Ende wegfällt, weil die Obergrenze erreicht war. Null, wenn
   * der ganze gewählte Bereich hineinpasst.
   */
  readonly gekuerztMs: number;
  /**
   * An welchen Stellen ein neues Stück anfängt – immer ohne die Null.
   *
   * Leer, solange es nur ein Stück gibt. Wer schneidet, braucht diese Zahlen
   * weiter hinten: Über eine Schnittkante hinweg ist jede Bewegungsschätzung
   * Unfug, und ein Abspieler erwartet dort ein Schlüsselbild.
   */
  readonly schnitte: readonly number[];
}

/** Ein Stück Film: von wann bis wann. */
export interface Stueck {
  readonly vonMs: number;
  readonly bisMs: number;
}

export interface AbtastAuftrag {
  readonly stuecke: readonly Stueck[];
  readonly schrittMs: number;
  readonly maxBilder: number;
  /**
   * In die Bildmitte springen statt auf die Bildgrenze.
   *
   * Nur für den Film – warum, steht im Kopf dieser Datei.
   */
  readonly mitte?: boolean;
}

/**
 * Die Zeitpunkte für eine Reihe von Stücken.
 *
 * `maxBilder` schneidet HINTEN ab und dünnt nicht aus: Ein Film mit jedem
 * zweiten Bild bei voller Standzeit liefe in Zeitlupe, einer mit halber
 * Standzeit doppelt so schnell. Beides ist schlechter als ein kürzerer
 * Ausschnitt, den der Anwender sieht und selbst verschieben kann.
 *
 * Gekürzt wird über die Stücke hinweg und nicht je Stück: Wer drei Stücke
 * wählt und die Grenze reisst, verliert das Ende – nicht aus jedem Stück ein
 * Stückchen.
 */
export function abtasten(auftrag: AbtastAuftrag): Ausschnitt {
  const schritt = auftrag.schrittMs;
  const versatz = auftrag.mitte ? schritt / 2 : 0;
  /** Der zuletzt abgetastete Zeitpunkt – für die Frage, ob eine Naht vorliegt. */
  let letzter: number | null = null;
  const liste: number[] = [];
  const schnitte: number[] = [];
  let gewuenscht = 0;

  for (const stueck of auftrag.stuecke) {
    const von = Math.max(0, stueck.vonMs);
    const bis = Math.max(von, stueck.bisMs);
    /*
     * Eine NAHTLOSE Grenze ist kein Schnitt.
     *
     * Der Knopf „Stück hinzufügen" legt das neue Stück dort an, wo das
     * aktive aufhört – das ist der Normalfall und nicht der Sonderfall.
     * Dort läuft die Szene weiter; ein gemeldeter Schnitt setzte aber die
     * Lage auf die Ruhe zurück (`folgeTeile`), und ein Verlauf oder
     * Pinselstrich spränge mitten in einer durchgehenden Einstellung an
     * seine Ausgangsstelle. Ein erzwungenes Schlüsselbild wäre dort
     * harmlos; das Zurücksetzen der Bewegung ist es nicht.
     */
    const naht = letzter !== null && Math.abs(von + versatz - (letzter + schritt)) <= schritt / 2;
    /*
     * Gerundet und nicht abgeschnitten: Wer bei 10 Bildern je Sekunde 950 ms
     * wählt, bekommt zehn Bilder und damit eine runde Sekunde. Abgeschnitten
     * wären es neun, und das letzte Zehntel des Ausschnitts – oft die Pointe –
     * fiele weg, ohne dass irgendwo stünde, warum.
     */
    const will = Math.max(1, Math.round((bis - von) / schritt));
    gewuenscht += will;
    const frei = Math.max(0, auftrag.maxBilder - liste.length);
    const anzahl = Math.min(will, frei);
    if (anzahl === 0) continue;
    if (liste.length > 0 && !naht) schnitte.push(liste.length);
    for (let i = 0; i < anzahl; i += 1) liste.push(von + i * schritt + versatz);
    letzter = liste[liste.length - 1];
  }

  /*
   * Auch ein leerer Plan gibt EIN Bild zurück.
   *
   * Wer die beiden Griffe übereinanderschiebt, bekommt ein Standbild und
   * keine Fehlermeldung – ein GIF ohne Teilbilder wirft in `gifSchreiben`,
   * und ein Video ohne Bilder in `videoSchreiben`.
   */
  if (liste.length === 0) {
    const erst = auftrag.stuecke[0];
    liste.push(erst ? Math.max(0, erst.vonMs) + versatz : versatz);
    gewuenscht = Math.max(gewuenscht, 1);
  }

  return {
    zeitpunkte: liste,
    schrittMs: schritt,
    gekuerztMs: (gewuenscht - liste.length) * schritt,
    schnitte,
  };
}

/**
 * Die Zeitpunkte für EIN Stück im GIF-Raster.
 *
 * Bleibt, weil der GIF-Weg genau das braucht und sich nichts daran ändern
 * soll: Standzeit in Hundertsteln, Abtastpunkt auf der Bildgrenze.
 */
export function zeitpunkte(
  vonMs: number,
  bisMs: number,
  bildrate: number,
  maxBilder: number,
): Ausschnitt {
  return abtasten({
    stuecke: [{ vonMs, bisMs }],
    schrittMs: dauerJeBildMs(bildrate),
    maxBilder,
  });
}

/** Die Zeitpunkte für einen Film – ungerastert und in die Bildmitte. */
export function filmZeitpunkte(
  stuecke: readonly Stueck[],
  bildrate: number,
  maxBilder: number,
): Ausschnitt {
  return abtasten({
    stuecke,
    schrittMs: filmSchrittMs(bildrate),
    maxBilder,
    mitte: true,
  });
}

/* ---------- Was es am Ende wiegt ---------- */

/*
 * Die beiden Zahlen stammen aus einer Messung, nicht aus einer Formel.
 *
 * Fünfzig Bilder à 512 × 512 aus einem echten Video, durch `gifSchreiben`:
 * als Vollbild 6 505 995 Byte, freigestellt 916 000 Byte. Das sind 130 120
 * bzw. 18 320 Byte je Bild. Freigestellt ist es so viel kleiner, weil die
 * durchsichtige Fläche EIN Tafelplatz ist und LZW eine lange Reihe desselben
 * Platzes fast umsonst packt.
 *
 * Eine Schätzung bleibt eine Schätzung: Ein bewegtes Muster über das ganze
 * Bild wiegt mehr, eine ruhige Einstellung weniger. Sie steht in der
 * Oberfläche als „rund", und die harte Grenze zieht am Ende die fertige Datei.
 */
const JE_BILD_VOLL = 130_120;
const JE_BILD_FREI = 18_320;
const GEMESSEN_KANTE = 512;

export function groesseSchaetzenB(bilder: number, kante: number, freigestellt: boolean): number {
  const anteil = (kante * kante) / (GEMESSEN_KANTE * GEMESSEN_KANTE);
  return Math.round(bilder * (freigestellt ? JE_BILD_FREI : JE_BILD_VOLL) * anteil);
}

/** „rund 1,4 MB" – eine Zahl, die man auf einem Knopf lesen kann. */
export function groesseText(bytes: number): string {
  if (bytes < 900_000) return `rund ${Math.max(1, Math.round(bytes / 1000))} kB`;
  return `rund ${(bytes / 1_000_000).toFixed(1).replace('.', ',')} MB`;
}
