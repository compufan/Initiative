import { NEUTRAL, type Anpassung } from './ton.js';

/**
 * Vorlagen – benannte Reglerstellungen, kein eigener Rechenweg.
 *
 * Eine Vorlage ist ein vollständiges `Anpassung`-Objekt. Sie fügt der Rechnung
 * nichts hinzu; sie stellt nur die Regler, die es ohnehin gibt. Das ist die
 * ganze Idee und der Grund, warum weder der Schattierer noch der
 * Prozessorpfad noch die Farbtabelle davon etwas mitbekommen.
 *
 * # Zur Rechtsfrage: Filmsimulationen
 *
 * Der Anwender hat ausdrücklich gefragt, ob Filmlooks möglich sind, ohne
 * Lizenzkosten zu zahlen. Drei Dinge sind dabei zu trennen:
 *
 * **Die Namen.** „Velvia“, „Portra“, „Tri-X“, „Kodachrome“ sind eingetragene
 * Marken. Die Schranke in § 23 Abs. 1 Nr. 3 MarkenG deckt das Verweisen auf
 * fremde Ware *als die des Inhabers* – ein Knopf, der „Velvia“ heisst,
 * verweist nicht auf Fujis Film, er benennt unser Erzeugnis. Dazu verlangt
 * § 23 Abs. 2 „anständige Gepflogenheiten“, und die enden dort, wo der Ruf
 * einer bekannten Marke ausgenutzt wird – der Ruf IST hier der einzige Grund
 * für den Namen. Also: keine Markennamen. Die Vorlagen unten heissen deshalb
 * nach dem, was sie tun.
 *
 * **Der Look selbst.** Frei. Eine Farbkurve ist ein Verfahren, kein Werk.
 *
 * **Fremde LUT-Dateien.** Nicht frei. Neben dem strittigen Urheberrecht steht
 * in der EU das Datenbankherstellerrecht (§ 87a UrhG) auf einer Tabelle mit
 * zehntausenden Einträgen, und darüber die Lizenz, die man beim Herunterladen
 * angenommen hat. Eine Sammlung von Film-LUTs unter CC0 oder MIT mit
 * belegbarer Herkunft war nicht zu finden – die Suche danach ist ergebnislos
 * geblieben, und das ist ein Ergebnis.
 *
 * Der sichere Weg, den diese Datei geht: eigene Kurven, eigene beschreibende
 * Namen. Die Messkurven in technischen Datenblättern darf man dabei lesen –
 * Zahlen sind Tatsachen, geschützt ist das PDF.
 */
export interface Vorlage {
  id: string;
  name: string;
  /** Ein Satz, der sagt, wofür sie taugt – nicht, wie sie heisst. */
  beschreibung: string;
  anpassung: Anpassung;
}

function bau(teil: Partial<Anpassung>): Anpassung {
  return { ...NEUTRAL, ...teil };
}

/**
 * Die Vorlagen.
 *
 * Jede Zahl ist durchgerechnet, nicht geschätzt. Wo eine Beschreibung etwas
 * verspricht, steht dahinter eine Messung – ein früherer Entwurf hatte eine
 * Vorlage „mehr Biss“ genannt, die nachgerechnet die Tonwertspanne um 1,6 %
 * änderte und in Wahrheit nur die Farbe anhob. So etwas ist schlimmer als
 * keine Vorlage: Es lehrt den Anwender, den Namen nicht zu glauben.
 */
export const VORLAGEN: Vorlage[] = [
  {
    id: 'klar',
    name: 'Klar',
    beschreibung: 'Etwas mehr Tiefe und Farbe – der Allerweltsgriff.',
    anpassung: bau({ kontrast: 0.18, schwarz: 0.12, dynamik: 0.2, schaerfe: 0.15 }),
  },
  {
    id: 'weich',
    name: 'Weich',
    beschreibung: 'Angehobene Schatten, zurückgenommene Farbe – ruhig und hell.',
    anpassung: bau({ schwarz: -0.3, tiefen: 0.3, lichter: -0.1, saettigung: -0.2 }),
  },
  {
    id: 'abend',
    name: 'Abend',
    beschreibung: 'Wärmer und tiefer, mit dunklen Rändern – für spätes Licht.',
    anpassung: bau({ waerme: 0.35, belichtung: -0.15, kontrast: 0.15, vignette: 0.25 }),
  },
  {
    id: 'kuehl',
    name: 'Kühl',
    beschreibung: 'Blaustichig und klar – Schnee, Nebel, Beton.',
    anpassung: bau({ waerme: -0.35, toenung: -0.1, kontrast: 0.12, dynamik: 0.15 }),
  },
  {
    id: 'kraeftig',
    name: 'Kräftig',
    beschreibung: 'Satte Farben und harte Kanten – Landschaft bei gutem Licht.',
    anpassung: bau({
      saettigung: 0.3,
      dynamik: 0.25,
      kontrast: 0.22,
      schwarz: 0.18,
      schaerfe: 0.2,
    }),
  },
  {
    id: 'verblasst',
    name: 'Verblasst',
    beschreibung: 'Angehobenes Schwarz, blasse Farbe – wie ein Abzug, der lange lag.',
    anpassung: bau({ schwarz: -0.45, kontrast: -0.15, saettigung: -0.3, waerme: 0.12 }),
  },
  {
    /*
     * Schwarz-Weiss ohne Filter. `saettigung: -1` allein ergibt die
     * Rec.709-Helligkeit – eine rote Rose und ein blauer Himmel gleicher
     * Helligkeit landen beide auf 73 von 255, ununterscheidbar. Für ein
     * neutrales Grau ist das richtig; wer trennen will, nimmt eine der
     * beiden Filtervorlagen darunter.
     */
    id: 'sw',
    name: 'Schwarz-Weiss',
    beschreibung: 'Ohne Filter – jede Farbe nach ihrer Helligkeit.',
    anpassung: bau({ saettigung: -1, kontrast: 0.15, schwarz: 0.1 }),
  },
  {
    id: 'sw-gelb',
    name: 'S/W mit Gelbfilter',
    beschreibung: 'Himmel etwas dunkler, Haut freundlicher – der Alltagsfilter.',
    // Gemessen an Rose gegen Himmel gleicher Helligkeit: 48 Stufen Trennung
    // statt 0.
    anpassung: bau({ saettigung: -1, swRot: 0.4, swGruen: -0.35, kontrast: 0.15 }),
  },
  {
    id: 'sw-rot',
    name: 'S/W mit Rotfilter',
    beschreibung: 'Dramatischer Himmel, dunkles Laub – der harte Griff.',
    // Gemessen: 134 Stufen Trennung. Der klassische Landschaftsfilter.
    anpassung: bau({ saettigung: -1, swRot: 1, swGruen: -0.9, kontrast: 0.2, schwarz: 0.15 }),
  },
  {
    id: 'sw-gruen',
    name: 'S/W mit Grünfilter',
    beschreibung: 'Laub hell, Lippen dunkel – für Porträts im Grünen.',
    anpassung: bau({ saettigung: -1, swGruen: 0.5, swRot: -0.15, kontrast: 0.12 }),
  },
];

/**
 * Eine Vorlage mit einer Stärke – 0 ist unverändert, 1 ist ganz.
 *
 * Linear zwischen `NEUTRAL` und der Vorlage. Das geht, weil alle Regler bei
 * null nichts tun und in dieselbe Richtung stärker werden; ein Zwischenwert
 * ist deshalb auch eine sinnvolle Einstellung und nicht bloss ein
 * gemitteltes Bild.
 *
 * Wichtig für den Kanalmischer: Er hängt am Sättigungsregler und nicht an
 * einer Schwelle. Bei Stärke 0,5 ist das Bild halb entsättigt UND der Filter
 * halb wirksam – kein Sprung an der letzten Raste.
 */
export function vorlageAnwenden(vorlage: Vorlage, staerke: number): Anpassung {
  const t = staerke < 0 ? 0 : staerke > 1 ? 1 : staerke;
  const aus = { ...NEUTRAL };
  for (const schluessel of Object.keys(NEUTRAL) as (keyof Anpassung)[]) {
    const wert = vorlage.anpassung[schluessel] * t;
    /*
     * Minus null zu plus null glattziehen.
     *
     * `-0.3 * 0` ist in JavaScript `-0`. Rechnerisch ist das dasselbe, und
     * `istNeutral` prüft mit `===`, merkt also nichts. Aber `tonSchluessel`
     * baut einen String, und dort steht dann „saettigung:-0“ statt
     * „saettigung:0“ – ein anderer Schlüssel für denselben Zustand. Der
     * Merkzettel verfehlt seinen Eintrag, und das Bild wird neu gerechnet,
     * obwohl sich nichts geändert hat.
     */
    aus[schluessel] = wert === 0 ? 0 : wert;
  }
  return aus;
}
