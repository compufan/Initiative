import type { BildDoc, Maskenteil } from '../bild/doc.js';
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
}

export function istInhaltsTeil(teil: Maskenteil): boolean {
  return teil.art === 'netz' || teil.art === 'tiefe' || teil.art === 'tipp';
}

/**
 * Alle Teile, die je Bild neu gerechnet werden müssen.
 *
 * Auch die aus ABGESCHALTETEN Bereichen bleiben draussen: Ein Bereich, dessen
 * Haken weg ist, wirkt nicht, und ein Netzlauf je Bild für nichts wären bei
 * fünfzig Bildern anderthalb Minuten geschenkt.
 */
export function inhaltsTeile(doc: BildDoc): InhaltsTeil[] {
  const raus: InhaltsTeil[] = [];
  for (const bereich of doc.bereiche) {
    if (!bereich.aktiv) continue;
    for (const teil of bereich.teile) {
      if (istInhaltsTeil(teil)) {
        raus.push({ bereich: bereich.id, teil, art: teil.art as InhaltsArt });
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
 * `lage` beschreibt den Weg vom STELLBILD des Abschnitts zu diesem Bild –
 * dort wurden die Formen gezeichnet (siehe `videoBauen.ts`).
 */
export function docMitLage(
  doc: BildDoc,
  lage: Lage,
  faktor: number,
  /**
   * Auch abgeschaltete Bereiche mitnehmen – wenn die Formen dauerhaft an ein
   * anderes Bild wandern (`verlegen.ts`). Beim Filmbau nicht: Was nicht
   * wirkt, muss dort auch nicht gezogen werden.
   */
  auchAbgeschaltete = false,
): BildDoc {
  if (lageRuht(lage)) return doc;
  let getauscht = false;
  const bereiche = doc.bereiche.map((bereich) => {
    if ((!bereich.aktiv && !auchAbgeschaltete) || !bereich.teile.some(istFormTeil)) return bereich;
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
 * `punkte` setzt bei einem Tipp auch die angetippten Stellen neu – für eine
 * Maske, die an ein anderes Bild mitgenommen wurde (`verlegen.ts`). Beim
 * Filmbau bleibt es leer: Dort zählen nur die Masken, und die Punkte im
 * Dokument sind die, von denen die Verfolgung ausgeht.
 */
export function docFuerBild(
  doc: BildDoc,
  daten: ReadonlyMap<string, NeueDaten>,
  punkte?: ReadonlyMap<string, readonly { x: number; y: number }[]>,
): BildDoc {
  if (daten.size === 0) return doc;

  let etwasGetauscht = false;
  const bereiche = doc.bereiche.map((bereich) => {
    let teileGetauscht = false;
    const teile = bereich.teile.map((teil) => {
      const neu = daten.get(teil.id);
      if (!neu) return teil;
      teileGetauscht = true;
      if (teil.art === 'tiefe') {
        /*
         * Auch hier eine NEUE Marke: Der Zwischenspeicher der Masken führt
         * die Karte nur über sie (`teilSchluessel` in `bild/maske.ts`). Mit
         * der alten Marke bekam jedes Bild des Films die Tiefenmaske des
         * ersten – und eine mitgenommene Tiefe zeigte im Editor die alte.
         */
        return {
          ...teil,
          breite: neu.breite,
          hoehe: neu.hoehe,
          karte: neu.werte,
          marke: naechsteMarke(),
        };
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
        const neuePunkte = teil.art === 'tipp' ? punkte?.get(teil.id) : undefined;
        return {
          ...teil,
          breite: neu.breite,
          hoehe: neu.hoehe,
          alpha: neu.werte,
          marke: naechsteMarke(),
          ...(neuePunkte ? { punkte: neuePunkte.map((p) => ({ x: p.x, y: p.y })) } : {}),
        };
      }
      return teil;
    });
    if (!teileGetauscht) return bereich;
    etwasGetauscht = true;
    return { ...bereich, teile };
  });

  return etwasGetauscht ? { ...doc, bereiche } : doc;
}

/**
 * Ein fortlaufender Zähler für Maskenmarken.
 *
 * Eigener Zähler und nicht der aus `netzMaske.ts`: Der liegt in einem Modul,
 * das ein Modell in den Modulgraphen zöge.
 *
 * Er beginnt weit oben, damit er dem Zähler in `bild/maske.ts` nie dieselbe
 * Zahl vergibt. Solange die Marken nur im Filmbau lebten, war das
 * gleichgültig; seit eine mitgenommene Maske (`verlegen.ts`) zurück in den
 * Editor geht, hielte dessen Zwischenspeicher bei gleicher Kennung und
 * zufällig gleicher Marke die alte Maske für die neue.
 */
let zaehler = 2 ** 30;
function naechsteMarke(): number {
  zaehler += 1;
  return zaehler;
}
