/**
 * Stille am Anfang und am Ende finden.
 *
 * # Wofür
 *
 * Für den Knopf „Stille wegschneiden". Fast jede Aufnahme beginnt damit, dass
 * jemand den Knopf trifft und dann Luft holt, und endet damit, dass jemand zum
 * Knopf zurückgreift. Bei einer Sprachnachricht ist das lästig; bei einem
 * Sticker, der bei jedem Antippen klingt, ist es der Unterschied zwischen
 * „sitzt" und „kommt zu spät".
 *
 * # Warum RMS und nicht der Spitzenwert
 *
 * Weil ein einzelnes Knacken – ein Fingernagel am Mikrofon, ein Datenfehler –
 * den Spitzenwert auf eins zieht und die Messung damit erledigt. Der
 * quadratische Mittelwert über zwanzig Millisekunden fragt stattdessen, wie
 * viel ENERGIE in diesem Fenster steckt, und ein einzelner Ausreisser bewegt
 * ihn kaum.
 *
 * # Warum Perzentile und nicht Minimum und Maximum
 *
 * Aus demselben Grund, eine Ebene höher. Die Schwelle muss zwischen
 * „Grundrauschen" und „jemand spricht" liegen, und beide werden aus der
 * Aufnahme selbst geschätzt – eine feste Zahl wäre bei einem leisen Mikrofon
 * zu hoch und bei einem lauten zu niedrig. Das Minimum ist aber oft exakt
 * null (eine einzige stille Stelle genügt) und das Maximum ein Knacken. Das
 * zwanzigste und das fünfundneunzigste Perzentil beschreiben dasselbe, ohne
 * sich von einem einzelnen Fenster umwerfen zu lassen.
 *
 * # Warum das Ergebnis nur ein Vorschlag ist
 *
 * Nicht-gleichmässiges Rauschen – Strassenlärm, ein Lüfter, der anspringt –
 * hebt das geschätzte Grundrauschen an, und dann wird zu wenig geschnitten.
 * Deshalb setzt der Editor daraufhin seine Griffe, statt einfach zu schneiden:
 * Was hier herauskommt, lässt sich mit dem Finger überschreiben.
 */

/** Fensterlänge für die Energiemessung, in Sekunden. */
const FENSTER_S = 0.02;

/** Wie weit die Fenster überlappen: Sprung ist das halbe Fenster. */
const SPRUNG_S = 0.01;

/**
 * Wie viel VOR dem ersten lauten Fenster stehen bleibt.
 *
 * Achtzig Millisekunden. Ein „P" oder „T" beginnt mit einer Stille, in der
 * sich Druck aufbaut – schneidet man genau am Energieanstieg, fehlt der
 * Anlauf, und das Wort klingt, als hätte es jemand angestossen.
 */
const VORLAUF_S = 0.08;

/**
 * Und wie viel danach.
 *
 * Mehr als davor: Ein Satz endet oft mit einem Zischlaut, der leise ausläuft,
 * und ein hart abgeschnittenes „s" klingt nach einem Fehler in der Leitung.
 */
const NACHLAUF_S = 0.12;

/** Kürzer als das wird nicht geschnitten – sonst bleibt nichts übrig. */
const MINDESTENS_S = 0.25;

/** Die kleinste Schwelle, unter die nie gegangen wird. */
const BODEN = 0.0015;

export interface Grenzen {
  /** Anfang des Nutzsignals, in Sekunden. */
  beginn: number;
  /** Ende, in Sekunden. */
  ende: number;
  /** Ob überhaupt etwas zu schneiden war. */
  gefunden: boolean;
}

/** Ein Perzentil aus bereits sortierten Werten. */
function perzentil(sortiert: number[], anteil: number): number {
  if (sortiert.length === 0) return 0;
  const at = Math.min(sortiert.length - 1, Math.max(0, Math.round(anteil * (sortiert.length - 1))));
  return sortiert[at];
}

/**
 * Wo das Nutzsignal beginnt und endet.
 *
 * `werte` ist ein Kanal, `rate` seine Abtastrate. Gibt es nichts zu schneiden
 * oder bliebe zu wenig übrig, kommt der ganze Bereich zurück und
 * `gefunden: false` – der Aufrufer zeigt dann „hier ist keine Stille", statt
 * eine Aufnahme auf ein Viertel zusammenzustreichen.
 */
export function stilleGrenzen(werte: Float32Array<ArrayBufferLike>, rate: number): Grenzen {
  const ganz: Grenzen = { beginn: 0, ende: werte.length / rate, gefunden: false };
  const fenster = Math.max(1, Math.round(FENSTER_S * rate));
  const sprung = Math.max(1, Math.round(SPRUNG_S * rate));
  if (werte.length < fenster * 4) return ganz;

  const energie: number[] = [];
  for (let at = 0; at + fenster <= werte.length; at += sprung) {
    let summe = 0;
    for (let i = at; i < at + fenster; i += 1) summe += werte[i] * werte[i];
    energie.push(Math.sqrt(summe / fenster));
  }
  if (energie.length === 0) return ganz;

  const sortiert = [...energie].sort((a, b) => a - b);
  const grundrauschen = perzentil(sortiert, 0.2);
  const laut = perzentil(sortiert, 0.95);
  const schwelle = Math.max(grundrauschen * 3.2, laut * 0.06, BODEN);

  let erstes = -1;
  let letztes = -1;
  for (let i = 0; i < energie.length; i += 1) {
    if (energie[i] >= schwelle) {
      if (erstes < 0) erstes = i;
      letztes = i;
    }
  }
  // Nichts über der Schwelle: Die Aufnahme ist durchgehend leise. Dann ist der
  // Schnitt nicht „alles weg", sondern „nichts zu tun".
  if (erstes < 0) return ganz;

  const beginn = Math.max(0, (erstes * sprung) / rate - VORLAUF_S);
  const ende = Math.min(ganz.ende, ((letztes * sprung + fenster) / rate) + NACHLAUF_S);
  if (ende - beginn < MINDESTENS_S) return ganz;
  /*
   * Weniger als zwei Hundertstel Gewinn sind kein Schnitt, sondern ein Knopf,
   * der scheinbar nichts tut. Dann lieber ausdrücklich „nichts gefunden"
   * sagen – ein Knopf ohne Wirkung hält man für kaputt.
   */
  if (beginn < 0.02 && ganz.ende - ende < 0.02) return ganz;

  return { beginn, ende, gefunden: true };
}
