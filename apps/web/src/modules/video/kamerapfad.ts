import {
  LAGE_RUHE,
  bewegung,
  lageKehren,
  lageRobust,
  lageVerketten,
  type Grau,
  type Lage,
} from './verfolgung.js';

/**
 * Die Bewegung der KAMERA von Quellbild zu Quellbild – einmal gerechnet,
 * von allen geteilt, die an der Szene kleben statt an einem Gegenstand.
 *
 * Wer das braucht:
 * - Formen einer reinen Formmaske (Verlauf, Ellipse, Pinsel): Sie stehen in
 *   der Szene und wandern mit der Kamera (`SpurQuelle.lage`).
 * - Die Tiefe: Zwischen zwei Schlüsselbildern wird die Karte mit der Kamera
 *   gezogen (`SpurQuelle.tiefe`).
 *
 * # Was gespeichert wird
 *
 * Je Bild k der SCHRITT von k−1 nach k – fünf Zahlen (`s, w, tx, ty,
 * sicher`, in Graupunkten), dazu ob er bekannt ist. Nie eine aufgelaufene
 * Kette: Die entsteht erst beim Fragen, aus den Schritten, und nur über
 * lückenlos bekannte Strecken. So kann jeder Schritt einzeln dazukommen –
 * in beliebiger Reihenfolge, aus verschiedenen Fenstern verschiedener
 * Masken –, ohne dass etwas umgerechnet werden muss.
 *
 * # Warum mit Vorsummen
 *
 * Weil die Bahn einer Formmaske für jedes Filmbild fragt: sechshundert
 * Fragen, jede über bis zu sechshundert Schritte. Stattdessen hält der Pfad
 * je Bild die Lage bis zum Anfang seiner lückenlosen Strecke; eine Frage ist
 * dann eine Verkettung, gleich wie weit die beiden Bilder auseinander
 * liegen. Neu gerechnet wird das nur, wenn ein Schritt dazukam, einmal für
 * alle.
 *
 * Die Richtung wie überall (`lageVerketten`): Ein Schritt bildet Bild k auf
 * Bild k−1 ab, `lage(a, k)` bildet Bild k auf Bild a ab – dieselbe Richtung
 * wie `seitAnker` in `videoBauen.ts`, und genau das, was `formTeilZiehen`
 * braucht, um eine Form von a nach k zu bringen.
 */
export class Kamerapfad {
  private schritte = new Float32Array(0);
  private bekannt = new Uint8Array(0);
  private faktorWert = 1;
  /** Je Bild die Lage bis zum Anfang seiner Strecke – `null`, wenn neu zu rechnen. */
  private praefix: Float64Array | null = null;
  private strecke: Int32Array | null = null;
  /** Steigt mit jedem neuen Schritt. */
  version = 0;

  /** Wie viele Bildpunkte ein Graupunkt ist – aus dem ersten gemessenen Schritt. */
  get faktor(): number {
    return this.faktorWert;
  }

  get bytes(): number {
    return this.schritte.byteLength + this.bekannt.byteLength + (this.praefix?.byteLength ?? 0);
  }

  /** Ist der Schritt von k−1 nach k bekannt? */
  schrittBekannt(k: number): boolean {
    return k >= 0 && k < this.bekannt.length && this.bekannt[k] === 1;
  }

  /**
   * Den Schritt von k−1 nach k eintragen – einmal. Ein schon bekannter
   * bleibt, wie er ist: Sonst änderte sich unter einer schon gezeichneten
   * Form nachträglich die Lage, und ihre Marke im Merkzettel stimmte nicht
   * mehr.
   */
  schrittSetzen(k: number, lage: Lage, faktor: number): void {
    if (k <= 0 || this.schrittBekannt(k)) return;
    this.platz(k + 1);
    const at = k * 5;
    this.schritte[at] = lage.s;
    this.schritte[at + 1] = lage.w;
    this.schritte[at + 2] = lage.tx;
    this.schritte[at + 3] = lage.ty;
    this.schritte[at + 4] = lage.sicher;
    this.bekannt[k] = 1;
    this.faktorWert = faktor;
    this.praefix = null;
    this.version += 1;
  }

  /**
   * Die Kamerabewegung, die Bild k auf Bild a abbildet – `null`, wenn
   * zwischen beiden ein Schritt noch nicht bekannt ist.
   */
  lage(a: number, k: number): Lage | null {
    if (a === k) return LAGE_RUHE;
    if (a < 0 || k < 0 || a >= this.bekannt.length || k >= this.bekannt.length) return null;
    this.vorsummen();
    const strecke = this.strecke as Int32Array;
    if (strecke[a] !== strecke[k]) return null;
    return lageVerketten(this.praefixAn(k), lageKehren(this.praefixAn(a)));
  }

  private praefixAn(k: number): Lage {
    const p = this.praefix as Float64Array;
    const at = k * 5;
    return { s: p[at], w: p[at + 1], tx: p[at + 2], ty: p[at + 3], sicher: p[at + 4] };
  }

  private vorsummen(): void {
    if (this.praefix && this.strecke) return;
    const n = this.bekannt.length;
    const praefix = new Float64Array(n * 5);
    const strecke = new Int32Array(n);
    let vorher: Lage = LAGE_RUHE;
    for (let k = 0; k < n; k += 1) {
      let hier: Lage;
      if (k > 0 && this.bekannt[k] === 1) {
        const at = k * 5;
        const schritt: Lage = {
          s: this.schritte[at],
          w: this.schritte[at + 1],
          tx: this.schritte[at + 2],
          ty: this.schritte[at + 3],
          sicher: this.schritte[at + 4],
        };
        // Der Schritt zuerst, die aufgelaufene Kette danach – siehe `lageVerketten`.
        hier = lageVerketten(schritt, vorher);
        strecke[k] = strecke[k - 1];
      } else {
        hier = LAGE_RUHE;
        strecke[k] = k;
      }
      const at = k * 5;
      praefix[at] = hier.s;
      praefix[at + 1] = hier.w;
      praefix[at + 2] = hier.tx;
      praefix[at + 3] = hier.ty;
      praefix[at + 4] = hier.sicher;
      vorher = hier;
    }
    this.praefix = praefix;
    this.strecke = strecke;
  }

  private platz(n: number): void {
    if (n <= this.bekannt.length) return;
    let neu = Math.max(64, this.bekannt.length * 2);
    while (neu < n) neu *= 2;
    const schritte = new Float32Array(neu * 5);
    schritte.set(this.schritte);
    const bekannt = new Uint8Array(neu);
    bekannt.set(this.bekannt);
    this.schritte = schritte;
    this.bekannt = bekannt;
    this.praefix = null;
    this.strecke = null;
  }
}

/**
 * Einen Schritt messen: die Kamerabewegung, die `nachher` auf `vorher`
 * abbildet.
 *
 * `lageRobust` und nicht `lageSchaetzen`, wie im Filmbau: Ruhende Blöcke mit
 * Struktur stimmen für den Stillstand, und ein Gegenstand, der durchs Bild
 * läuft, zieht die „Kamera" nicht mit. Findet sich keine Mehrheit, ist der
 * Schritt die Ruhe – lieber eine Form, die einen Schritt lang steht, als
 * eine, die auf einen Zufall springt.
 */
export function schrittMessen(
  vorher: Grau,
  nachher: Grau,
  bildBreite: number,
): { lage: Lage; faktor: number } {
  const feld = bewegung(vorher, nachher, bildBreite);
  return { lage: lageRobust(feld)?.lage ?? LAGE_RUHE, faktor: feld.faktor };
}
