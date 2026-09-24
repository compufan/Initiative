import {
  BEREICHE_MAX,
  type Bereich,
  type Bereichston,
  type BildDoc,
  type Maskenteil,
} from '../bild/doc.js';
import { lageRuht, punktVor, type Lage } from './verfolgung.js';

/**
 * Ein Bilddokument über einen ganzen Film hinweg.
 *
 * # Das Problem in einem Satz
 *
 * Fast alles in einem `BildDoc` gilt für jedes Bild gleich – Zuschnitt,
 * Drehung, Belichtung, Farbe, Striche, Schriftzüge, Verläufe. Drei Arten von
 * Maskenteilen tun das NICHT, weil sie aus dem Bildinhalt gerechnet sind:
 * `netz` (was ein Modell gefunden hat), `tiefe` (wie weit was entfernt ist)
 * und `tipp` (was farblich an einer angetippten Stelle hängt).
 *
 * Wer sie unverändert über alle Bilder legt, bekommt eine Maske, die auf
 * Bild 1 sitzt und danach neben dem Motiv liegt – und das sieht nicht nach
 * einem Fehler aus, sondern nach einem schlecht gemachten Effekt.
 *
 * # Der Weg hier
 *
 * `inhaltsTeile` sagt, welche Teile je Bild neu gebraucht werden. Der
 * Aufrufer rechnet sie – mit Schlüsselbildern und `verfolgung.ts`, wie beim
 * GIF – und `docFuerBild` setzt sie wieder ein. Das Dokument bleibt dabei
 * unberührt: Es wird eine neue Fassung gebaut, keine bestehende verändert.
 *
 * Reine Rechnerei über Objekte, also ohne Browser prüfbar – und das ist hier
 * nicht nebensächlich: Ein Teil, das beim Einsetzen die falsche Kennung
 * bekommt, fällt beim Ansehen als „der Effekt wirkt nicht" auf, ohne zu
 * verraten, warum.
 */

/** Die Arten, die aus dem BILDINHALT kommen und deshalb je Bild neu müssen. */
export type InhaltsArt = 'netz' | 'tiefe' | 'tipp';

export interface InhaltsTeil {
  /** Zu welchem Bereich es gehört – gebraucht zum Wiedereinsetzen. */
  readonly bereich: string;
  readonly teil: Maskenteil;
  readonly art: InhaltsArt;
  /**
   * Wie beim `Bereich`, aus dem dieses Teil stammt – siehe dort.
   *
   * Mitgeführt, weil `folgeTeile.ts` genau hier entscheidet, ab welchem
   * Schlüsselbild dieses EINE Teil verfolgt wird: Ein Bereich, der erst ab
   * der Hälfte des Films gilt, hat am Stückanfang nichts Verlässliches zu
   * zeigen, und `sammlung[stueckAnker]` wäre für IHN eine leere oder
   * zufällige Vorlage statt einer echten.
   */
  readonly zeitraum?: { vonMs: number; bisMs: number | null };
}

export function istInhaltsTeil(teil: Maskenteil): boolean {
  return teil.art === 'netz' || teil.art === 'tiefe' || teil.art === 'tipp';
}

/**
 * Ob ein Bereich mit diesem Zeitraum an einer gegebenen Stelle im Film gilt.
 *
 * Ohne Zeitraum gilt er immer – der Normalfall, unverändert seit es keine
 * Zeitraumangabe gab. `bisMs: null` heisst offen: bis zum Ende, oder bis ihn
 * ein späterer, eigener Bereich ablöst (den anzulegen ist Sache der
 * Oberfläche, nicht dieser Funktion – sie kennt nur EINEN Bereich zur Zeit).
 */
export function zeitraumAktiv(
  zeitraum: { vonMs: number; bisMs: number | null } | undefined,
  zeitMs: number,
): boolean {
  if (!zeitraum) return true;
  if (zeitMs < zeitraum.vonMs) return false;
  return zeitraum.bisMs === null || zeitMs < zeitraum.bisMs;
}

/**
 * Alle Teile, die je Bild neu gerechnet werden müssen.
 *
 * Auch die aus ABGESCHALTETEN Bereichen bleiben draussen: Ein Bereich, dessen
 * Haken weg ist, wirkt nicht, und ein Netzlauf je Bild für nichts wären bei
 * fünfzig Bildern anderthalb Minuten geschenkt.
 *
 * ZEITLICH begrenzte Bereiche bleiben dagegen DRIN, auch für Bilder VOR ihrem
 * Zeitraum: Diese Liste ist EINE Liste für den ganzen Film, kein Bild-für-Bild-
 * Plan – `folgeTeile.ts` rechnet und verfolgt jedes Teil über alle Bilder
 * gleich, und wählt für JEDES Teil erst dort seinen eigenen Anker (siehe
 * `teilAnker`), wo dessen Zeitraum anfängt. `docFuerBild` blendet das Teil für
 * die Bilder ausserhalb seines Zeitraums am Ende wieder aus – siehe dort.
 */
export function inhaltsTeile(doc: BildDoc): InhaltsTeil[] {
  const raus: InhaltsTeil[] = [];
  for (const bereich of doc.bereiche) {
    if (!bereich.aktiv) continue;
    for (const teil of bereich.teile) {
      if (istInhaltsTeil(teil)) {
        raus.push({
          bereich: bereich.id,
          teil,
          art: teil.art as InhaltsArt,
          zeitraum: bereich.zeitraum,
        });
      }
    }
  }
  return raus;
}

/** Braucht dieses Dokument überhaupt Arbeit je Bild? */
export function brauchtBildweise(doc: BildDoc): boolean {
  return inhaltsTeile(doc).length > 0;
}

/* ---------- Was an Bildkoordinaten klebt ---------- */

/**
 * Die Arten, die eine FORM beschreiben statt eines Bildinhalts.
 *
 * Ein Verlauf, eine Ellipse, ein Pinselstrich – sie kommen nicht aus dem
 * Bild, sie stehen darin. Genau das war das Problem: Sie standen darin und
 * blieben stehen, während die Szene darunter wegwanderte. Am Film eines
 * Anwenders nachvollzogen – die Abdunklung sass nach zwei Sekunden auf einer
 * ganz anderen Stelle des Regals als am Anfang.
 *
 * Verschoben wird nicht die gerasterte Maske, sondern ihre STÜTZPUNKTE. Der
 * Unterschied ist nicht klein: Eine Maske, die man Bild für Bild neu abtastet,
 * franst aus; ein Verlauf, dessen beide Enden mitwandern, wird auf jedem Bild
 * frisch und scharf gerechnet. Nebenbei greift dadurch auch der
 * Maskenzwischenspeicher richtig, denn `teilSchluessel` in `bild/maske.ts`
 * führt genau diese Koordinaten mit.
 */
export function istFormTeil(teil: Maskenteil): boolean {
  return teil.art === 'verlauf' || teil.art === 'radial' || teil.art === 'pinsel';
}

/** Hat das Dokument Bereiche, die an Bildkoordinaten kleben? */
export function hatFormTeile(doc: BildDoc): boolean {
  return doc.bereiche.some((bereich) => bereich.aktiv && bereich.teile.some(istFormTeil));
}

/**
 * Ein Formteil an die Lage eines späteren Bildes anpassen.
 *
 * `lage` beschreibt den Weg vom ersten Bild zu diesem; `punktVor` rechnet
 * einen Punkt in dieselbe Richtung.
 */
function formTeilZiehen(teil: Maskenteil, lage: Lage, faktor: number): Maskenteil {
  const zieh = (x: number, y: number) => punktVor(lage, faktor, x, y);
  if (teil.art === 'verlauf') {
    const von = zieh(teil.von.x, teil.von.y);
    const bis = zieh(teil.bis.x, teil.bis.y);
    return { ...teil, von, bis };
  }
  if (teil.art === 'radial') {
    const mitte = zieh(teil.mitte.x, teil.mitte.y);
    /*
     * Die Halbachsen wachsen mit dem Massstab, der Winkel dreht mit.
     *
     * Ohne das bliebe eine Ellipse gleich gross, während das Motiv näher
     * kommt – und gleich ausgerichtet, während die Kamera verkantet. Der
     * Massstab steckt in `s` und `w` als deren Betrag.
     */
    const massstab = Math.hypot(lage.s, lage.w) || 1;
    return {
      ...teil,
      mitte,
      rx: teil.rx / massstab,
      ry: teil.ry / massstab,
      winkel: teil.winkel - Math.atan2(lage.w, lage.s),
    };
  }
  if (teil.art === 'pinsel') {
    const massstab = Math.hypot(lage.s, lage.w) || 1;
    return {
      ...teil,
      striche: teil.striche.map((strich) => {
        const punkte = new Array<number>(strich.punkte.length);
        for (let i = 0; i + 1 < strich.punkte.length; i += 2) {
          const gezogen = zieh(strich.punkte[i], strich.punkte[i + 1]);
          punkte[i] = gezogen.x;
          punkte[i + 1] = gezogen.y;
        }
        return { ...strich, punkte, breite: strich.breite / massstab };
      }),
    };
  }
  return teil;
}

/**
 * Dasselbe Dokument, aber mit den Formen dort, wo das Motiv inzwischen ist.
 *
 * Getrennt von `docFuerBild`, weil es etwas anderes tut: Dort werden fertig
 * gerechnete Masken EINGESETZT, hier werden Stützpunkte VERSCHOBEN. Beides
 * hintereinander ergibt das Dokument für ein Bild.
 *
 * `lage` gilt hier für ALLE Formteile gleich, gerechnet seit Bild 0 – anders
 * als bei Netz und Tipp (siehe `teilAnker` in `folgeTeile.ts`) bekommt ein
 * zeitlich begrenzter FORM-Bereich noch keinen eigenen Anker. Für einen
 * Verlauf, eine Ellipse oder einen Pinselstrich, der erst später im Film
 * angelegt wird, kann seine Stützpunktlage deshalb leicht daneben liegen,
 * wenn sich die Kamera zwischen Bild 0 und seinem eigenen Anfang merklich
 * bewegt hat – `docFuerBild` blendet ihn trotzdem zur richtigen Zeit ein und
 * aus, nur seine Position ist in diesem Fall nicht auf den Bildpunkt genau.
 * Absichtlich nicht behoben: Anders als Netz und Tipp hat ein Formteil kein
 * Schlüsselbild, an dem sich „sein eigener Anfang" günstig festmachen liesse
 * – jedes Bild wird ohnehin neu gerechnet –, und das wäre eine eigene,
 * grössere Änderung.
 */
export function docMitLage(doc: BildDoc, lage: Lage, faktor: number): BildDoc {
  if (lageRuht(lage)) return doc;
  let getauscht = false;
  const bereiche = doc.bereiche.map((bereich) => {
    if (!bereich.aktiv || !bereich.teile.some(istFormTeil)) return bereich;
    getauscht = true;
    return {
      ...bereich,
      teile: bereich.teile.map((teil) =>
        istFormTeil(teil) ? formTeilZiehen(teil, lage, faktor) : teil,
      ),
    };
  });
  return getauscht ? { ...doc, bereiche } : doc;
}

/**
 * Die neu gerechneten Daten für EIN Bild, nach Teilkennung abgelegt.
 *
 * `alpha` für `netz` und `tipp`, `karte` für `tiefe` – beide sind
 * `width * height` Bytes, und die Masse stehen daneben, weil die Rechengrösse
 * eine andere sein darf als die des Originalteils.
 */
export interface NeueDaten {
  readonly breite: number;
  readonly hoehe: number;
  readonly werte: Uint8Array;
}

/**
 * Dasselbe Dokument, aber mit den Masken dieses Bildes.
 *
 * Teile, für die nichts geliefert wurde, bleiben unverändert stehen. Das ist
 * Absicht und kein Durchrutschen: Wenn das Netz auf Bild 23 nichts gefunden
 * hat, ist die zuletzt gültige Maske ein deutlich besseres Ergebnis als gar
 * keine – die Wirkung bliebe sonst für ein einzelnes Bild aus, und genau das
 * sieht man als Zucken.
 *
 * `zeitMs` entscheidet zusätzlich, ob ein ZEITLICH begrenzter Bereich an
 * dieser Stelle überhaupt aktiv ist – siehe `zeitraumAktiv`. Das ist die
 * einzige Stelle, an der ein Zeitraum wirklich etwas AUSBLENDET; überall
 * sonst (Verfolgung, Modellauf) läuft ein zeitlich begrenzter Bereich über
 * den ganzen Film mit, siehe `inhaltsTeile`.
 */
export function docFuerBild(
  doc: BildDoc,
  daten: ReadonlyMap<string, NeueDaten>,
  zeitMs: number,
): BildDoc {
  if (daten.size === 0 && !doc.bereiche.some((bereich) => bereich.zeitraum)) return doc;

  let etwasGetauscht = false;
  const bereiche = doc.bereiche.map((bereich) => {
    let teileGetauscht = false;
    const teile = bereich.teile.map((teil) => {
      const neu = daten.get(teil.id);
      if (!neu) return teil;
      teileGetauscht = true;
      if (teil.art === 'tiefe') {
        return { ...teil, breite: neu.breite, hoehe: neu.hoehe, karte: neu.werte };
      }
      if (teil.art === 'netz' || teil.art === 'tipp') {
        /*
         * Die Marke wird MITGEZÄHLT und nicht übernommen.
         *
         * Sie ist die Ersatzidentität der Maske – ein Zwischenspeicher kann
         * einen `Uint8Array` nicht in einen Schlüssel schreiben und merkt
         * sich deshalb die Marke. Bliebe sie gleich, lieferte der
         * Zwischenspeicher für Bild 2 die gerasterte Maske von Bild 1, und
         * zwar ohne jede Fehlermeldung: Der Effekt klebte am ersten Bild
         * fest, obwohl hier alles richtig eingesetzt wurde.
         */
        return {
          ...teil,
          breite: neu.breite,
          hoehe: neu.hoehe,
          alpha: neu.werte,
          marke: naechsteMarke(),
        };
      }
      return teil;
    });
    const aktiv = bereich.aktiv && zeitraumAktiv(bereich.zeitraum, zeitMs);
    if (!teileGetauscht && aktiv === bereich.aktiv) return bereich;
    etwasGetauscht = true;
    return { ...bereich, aktiv, teile: teileGetauscht ? teile : bereich.teile };
  });

  return etwasGetauscht ? { ...doc, bereiche } : doc;
}

/**
 * Ein fortlaufender Zähler für Maskenmarken.
 *
 * Eigener Zähler und nicht der aus `netzMaske.ts`: Der liegt in einem Modul,
 * das ein Modell in den Modulgraphen zöge. Dass beide Zähler dieselben Zahlen
 * vergeben können, ist unschädlich – verglichen wird eine Marke immer nur mit
 * der vorigen Marke DESSELBEN Teils.
 */
let zaehler = 1;
function naechsteMarke(): number {
  zaehler += 1;
  return zaehler;
}

/* ---------- „Ab hier neu einstellen" ---------- */

function bereichstonGleich(a: Bereichston, b: Bereichston): boolean {
  return (Object.keys(a) as (keyof Bereichston)[]).every(
    (schluessel) => a[schluessel] === b[schluessel],
  );
}

/**
 * Ob ein Bereich zwischen `alt` und `neu` UNVERÄNDERT geblieben ist.
 *
 * `teile` wird per REFERENZ verglichen, nicht per Wert: `docKopie` (in
 * `doc.ts`, vom Fotoeditor beim Öffnen benutzt) übernimmt ein unangetastetes
 * Teile-Feld immer als dasselbe Objekt – genau darauf ist auch der
 * Maskenzwischenspeicher angewiesen. Nur `anpassung` bekommt bei JEDEM
 * Öffnen eine neue, wertgleiche Kopie, deshalb dort ein Feldvergleich statt
 * `===`.
 */
function bereichUnveraendert(a: Bereich, b: Bereich): boolean {
  return (
    a.teile === b.teile &&
    a.aktiv === b.aktiv &&
    a.name === b.name &&
    bereichstonGleich(a.anpassung, b.anpassung)
  );
}

function neueBereichId(): string {
  return `b${Date.now().toString(36)}${Math.round(Math.random() * 1e6).toString(36)}`;
}

/**
 * Was eine „ab hier neu einstellen"-Sitzung im Fotoeditor ergeben hat, in
 * zeitlich begrenzte Bereiche einsortieren.
 *
 * `alt` ist das Dokument, mit dem der Editor geöffnet wurde, `neu`, was er
 * zurückgegeben hat – beide aus demselben Aufruf, dazwischen darf nichts
 * anderes am Dokument geändert worden sein. `abMs` ist die Stelle, an der
 * die Sitzung angesetzt hat (die Wiedergabestelle beim Öffnen).
 *
 * Für jeden Bereich, der in BEIDEN steht (gleiche `id`):
 * - unverändert → bleibt die ALTE Fassung, nicht irgendeine wertgleiche neue
 *   – sonst kostete jede „ab hier"-Sitzung den Maskenzwischenspeicher für
 *   jeden Bereich, den niemand angefasst hat.
 * - verändert, und zur Zeit `abMs` schon aktiv → wird GETEILT: Die alte
 *   Fassung bleibt bis `abMs` gültig (ihr `zeitraum.bisMs` wird auf `abMs`
 *   gekappt), die neue Fassung gilt AB `abMs` (eine frische Kennung, offener
 *   Zeitraum). Das ist wörtlich „bis der Bereich verändert wird": Wer einen
 *   schon laufenden Bereich in einer späteren Sitzung anfasst, beendet damit
 *   die alte Fassung genau dort und lässt die neue ab dort weiterlaufen.
 * - verändert, aber zur Zeit `abMs` NICHT aktiv (noch nicht begonnen, oder
 *   schon vorbei) → wird als Ganzes übernommen, ohne den Zeitraum
 *   anzufassen: Wer einen Bereich ausserhalb seines eigenen Fensters
 *   bearbeitet, meint offensichtlich die ganze Zeitspanne, nicht nur den
 *   Rest ab `abMs`.
 *
 * Ein Bereich, der nur in `neu` steht, ist in dieser Sitzung neu angelegt
 * und bekommt einen offenen Zeitraum ab `abMs`. Ein Bereich, der nur in
 * `alt` stand, wurde gelöscht und bleibt es.
 *
 * Ein Teilen kostet einen ZUSÄTZLICHEN Bereich, und `BEREICHE_MAX` ist eine
 * harte Grenze – `tonGpu.ts` reserviert dafür genau so viele Plätze auf der
 * Grafikeinheit, ein Bereich darüber hinaus würde dort schlicht nicht mehr
 * gezeichnet. `BildEditor` verhindert das beim ANLEGEN eines Bereichs, kennt
 * aber kein Teilen; die Prüfung steht deshalb hier: Reicht der Platz nicht
 * für alle nötigen Teilungen, bleiben die spätesten unverändert (siehe
 * `frei`) – lieber ein Bereich, der über seine ganze bisherige Zeitspanne
 * die neue Form annimmt, als einer, der auf der Grafikeinheit verschwindet.
 */
export function bereicheAbUebernehmen(alt: BildDoc, neu: BildDoc, abMs: number): BildDoc {
  const altNachId = new Map(alt.bereiche.map((bereich) => [bereich.id, bereich]));
  const bereiche: Bereich[] = [];
  // Jeder Eintrag aus `neu.bereiche` braucht mindestens einen Platz; `frei`
  // ist der Rest, der für ZUSÄTZLICHE (geteilte) Bereiche übrig bleibt.
  let frei = BEREICHE_MAX - neu.bereiche.length;
  for (const nachher of neu.bereiche) {
    const vorher = altNachId.get(nachher.id);
    if (!vorher) {
      bereiche.push({ ...nachher, zeitraum: { vonMs: abMs, bisMs: null } });
      continue;
    }
    if (bereichUnveraendert(vorher, nachher)) {
      bereiche.push(vorher);
      continue;
    }
    if (zeitraumAktiv(vorher.zeitraum, abMs) && frei > 0) {
      frei -= 1;
      bereiche.push({ ...vorher, zeitraum: { vonMs: vorher.zeitraum?.vonMs ?? 0, bisMs: abMs } });
      bereiche.push({ ...nachher, id: neueBereichId(), zeitraum: { vonMs: abMs, bisMs: null } });
      continue;
    }
    bereiche.push(nachher);
  }
  return { ...neu, bereiche };
}
