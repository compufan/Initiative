import type { BildDoc, Maskenteil } from '../bild/doc.js';

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
 */
export function docFuerBild(doc: BildDoc, daten: ReadonlyMap<string, NeueDaten>): BildDoc {
  if (daten.size === 0) return doc;

  let etwasGetauscht = false;
  const bereiche = doc.bereiche.map((bereich) => {
    let teileGetauscht = false;
    const teile = bereich.teile.map((teil) => {
      const neu = daten.get(teil.id);
      if (!neu) return teil;
      teileGetauscht = true;
      etwasGetauscht = true;
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
    return teileGetauscht ? { ...bereich, teile } : bereich;
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
