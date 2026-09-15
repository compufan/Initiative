/**
 * Entfaltung: die Unschärfe zurückrechnen, statt Kanten zu betonen.
 *
 * # Der Unterschied zur Unschärfemaske
 *
 * Eine Unschärfemaske (`schaerfe.ts`) betont, was noch da ist. Sie kann
 * nichts zurückholen, was verschmiert wurde – sie macht den Verlauf steiler
 * und den Rest lauter. Deshalb rettet sie kein verwackeltes Bild.
 *
 * Eine Entfaltung fragt etwas anderes: Welches scharfe Bild, durch DIESE
 * Unschärfe geschickt, ergäbe das, was hier liegt? Das ist eine Umkehrung,
 * und sie holt echte Struktur zurück – solange die Unschärfe bekannt und
 * nicht zu gross ist.
 *
 * # Warum Richardson-Lucy und nicht ein Netz
 *
 * Weil es für dieses Problem besser ist und nebenbei nichts kostet.
 *
 * Gerechnet: Ein Modell wie Real-ESRGAN kostet bei zwölf Megapunkten rund
 * 430 Billionen Rechenschritte – auf einer Telefon-Grafikeinheit zwischen
 * achtzehn und sechsunddreissig MINUTEN für ein Bild. Diese Entfaltung
 * kostet bei einem Verwacklungsstreifen von 25 Punkten und 30 Durchgängen
 * rund 36 Milliarden – unter einer Sekunde, in voller Auflösung, ohne
 * Kacheln, ohne Download.
 *
 * Und sie erfindet nichts. Ein Netz hat in seinem Training nie eine Unschärfe
 * gesehen, die grösser ist als ein paar Punkte (Real-ESRGAN: `blur_sigma` bis
 * 3, Ausschnitte von 256 Punkten); bei einem 25 Punkte langen Streifen in
 * einem 4000 Punkte breiten Foto malt es die Textur hin, die es gelernt hat.
 * Das ist der Mechanismus hinter Wachshaut und erfundenen Poren, und es ist
 * keine Einstellungssache, sondern die Bauart.
 *
 * Richardson (1972) und Lucy (1974) sind über fünfzig Jahre alt und
 * Allgemeingut – auf das Verfahren kann niemand ein Patent haben.
 *
 * # Die Grenze, die in der Oberfläche stehen muss
 *
 * Entfaltet wird NICHT BLIND: Die Punktbildfunktion kommt vom Anwender, nicht
 * aus dem Bild. Das ist erstens ehrlicher (er sieht den Streifen ja) und
 * zweitens patentfrei – die blinde Kernschätzung aus Gradientenstatistik ist
 * belastet (US 7 616 826 B2, 2021 erloschen, aber mit Nachbarn).
 *
 * # Was hier noch fehlt: die Grafikeinheit
 *
 * Diese Fassung rechnet auf dem Prozessor und ist damit für ein Telefonfoto
 * zu langsam – 36 Milliarden Rechenschritte in JavaScript sind über eine
 * Minute auf dem Hauptstrang. Sie ist der Prüfmassstab und der Weg für kleine
 * Bilder; die Oberfläche braucht eine Fassung auf der Grafikeinheit.
 *
 * Die ist nicht bloss eine Übersetzung, und daran ist der erste Versuch
 * gescheitert: Richardson-Lucy braucht drei Arbeitstexturen gleichzeitig
 * (Schätzung, Verhältnis, neue Schätzung – die neue darf nicht dieselbe sein,
 * aus der gelesen wird) plus das beobachtete Bild. Nachgerechnet sind das bei
 * zwölf Megapunkten in RGBA16F 366 MB und in RGBA32F 732 MB. Auf einem
 * Telefon fällt der Reiter dabei aus dem Speicher.
 *
 * Es braucht also KACHELN mit Überlappung – mindestens so breit wie der Kern,
 * sonst steht an jeder Kachelgrenze eine Naht. Das ist ein eigenes Stück
 * Arbeit und wird als solches gebaut, nicht nebenbei.
 *
 * # Und: Stark Verwackeltes bleibt verloren. Wo die Bewegung eine Kante über
 * fünfzig Punkte gezogen hat, ist die Information physikalisch weg. Jedes
 * Verfahren, das dort trotzdem ein scharfes Bild zeigt, hat es ERFUNDEN.
 */

/** Die Unschärfe, die zurückgerechnet werden soll. */
export type Punktbild =
  | {
      /** Fehlfokus: Die Linse zeichnet einen Punkt als SCHEIBE. */
      art: 'scheibe';
      /** Der Radius der Scheibe, in Bildpunkten. */
      radius: number;
    }
  | {
      /** Verwacklung: Die Kamera hat sich bewegt, ein Punkt wird zur LINIE. */
      art: 'linie';
      /** Die Länge des Streifens, in Bildpunkten. */
      laenge: number;
      /** Seine Richtung, in Grad. 0 ist waagerecht. */
      winkel: number;
    };

export interface Kern {
  werte: Float32Array;
  breite: number;
  hoehe: number;
  /** Die Mitte – bei ungerader Kante genau der mittlere Punkt. */
  mx: number;
  my: number;
}

/** Wie gross ein Kern höchstens wird. Darüber lohnt die Entfaltung nicht mehr. */
export const KERN_MAX = 81;

/**
 * Die Punktbildfunktion als Feld – normiert auf die Summe eins.
 *
 * # Warum normiert
 *
 * Die Faltung mit ihr darf die HELLIGKEIT nicht ändern. Summierte der Kern
 * auf 1,2, würde jeder Durchgang das Bild um zwanzig Prozent aufhellen, und
 * nach dreissig Durchgängen wäre es weiss. Richardson-Lucy setzt das
 * ausserdem voraus: Das Verfahren erhält die Lichtmenge, und das tut es nur
 * mit einem normierten Kern.
 *
 * # Warum weiche Ränder
 *
 * Eine Scheibe mit harter Kante ist ein Treppenmuster, und ein Treppenmuster
 * hat Frequenzen, die in der echten Unschärfe nicht vorkommen. Die Entfaltung
 * versucht sie trotzdem umzukehren – und legt dabei ein feines Gitter über
 * das Bild. Deshalb wird über jeden Randpunkt anteilig gemittelt.
 */
export function punktbildBauen(p: Punktbild): Kern {
  const radius = p.art === 'scheibe' ? p.radius : p.laenge / 2;
  // Ungerade Kante, damit die Mitte ein Punkt ist und kein Spalt.
  const kante = Math.min(KERN_MAX, Math.max(3, Math.ceil(radius) * 2 + 3) | 1);
  const mitte = (kante - 1) / 2;
  const werte = new Float32Array(kante * kante);

  /*
   * Jeder Punkt wird in 4 × 4 Unterpunkten abgetastet.
   *
   * Nicht aus Genauigkeitsfimmel: Ein Kern von drei Punkten Kante, bei dem
   * nur die Mitte gesetzt ist, ist etwas ganz anderes als eine Scheibe von
   * anderthalb Punkten Radius – und der Unterschied entscheidet, ob die
   * Entfaltung die Unschärfe trifft oder eine andere umkehrt.
   */
  const UNTER = 4;
  if (p.art === 'scheibe') {
    const r = Math.max(0.5, p.radius);
    for (let y = 0; y < kante; y += 1) {
      for (let x = 0; x < kante; x += 1) {
        let treffer = 0;
        for (let sy = 0; sy < UNTER; sy += 1) {
          for (let sx = 0; sx < UNTER; sx += 1) {
            const px = x - mitte + (sx + 0.5) / UNTER - 0.5;
            const py = y - mitte + (sy + 0.5) / UNTER - 0.5;
            if (px * px + py * py <= r * r) treffer += 1;
          }
        }
        werte[y * kante + x] = treffer / (UNTER * UNTER);
      }
    }
  } else {
    const halb = Math.max(0.5, p.laenge / 2);
    const bogen = (p.winkel * Math.PI) / 180;
    const dx = Math.cos(bogen);
    const dy = Math.sin(bogen);
    for (let y = 0; y < kante; y += 1) {
      for (let x = 0; x < kante; x += 1) {
        let treffer = 0;
        for (let sy = 0; sy < UNTER; sy += 1) {
          for (let sx = 0; sx < UNTER; sx += 1) {
            const px = x - mitte + (sx + 0.5) / UNTER - 0.5;
            const py = y - mitte + (sy + 0.5) / UNTER - 0.5;
            // Abstand zur Strecke: längs darf es bis `halb` gehen, quer
            // höchstens einen halben Punkt – der Streifen ist dünn.
            const laengs = px * dx + py * dy;
            const quer = -px * dy + py * dx;
            if (Math.abs(laengs) <= halb && Math.abs(quer) <= 0.5) treffer += 1;
          }
        }
        werte[y * kante + x] = treffer / (UNTER * UNTER);
      }
    }
  }

  let summe = 0;
  for (const wert of werte) summe += wert;
  /*
   * Ein leerer Kern kann vorkommen – etwa eine Linie mit Länge null, die
   * durch keinen Unterpunkt läuft. Dann steht in der Mitte eine Eins, und
   * die Entfaltung wird zur Selbstabbildung: nichts tun ist die richtige
   * Antwort auf „keine Unschärfe“.
   */
  if (summe <= 0) {
    werte[mitte * kante + mitte] = 1;
    summe = 1;
  }
  for (let i = 0; i < werte.length; i += 1) werte[i] /= summe;
  return { werte, breite: kante, hoehe: kante, mx: mitte, my: mitte };
}

/**
 * Faltung eines Kanals mit einem Kern – am Rand gespiegelt.
 *
 * Gespiegelt und nicht mit Null aufgefüllt: Null heisst „hier ist es
 * stockdunkel“, und die Entfaltung sieht am Bildrand dann eine Kante, die es
 * nicht gibt. Sie versucht, diese Kante scharfzurechnen, und legt einen
 * hellen Saum um das ganze Bild.
 *
 * `umgekehrt` dreht den Kern um seine Mitte – das ist die Faltung mit dem
 * gespiegelten Kern, die Richardson-Lucy im Rückweg braucht.
 */
export function falten(
  ein: Float32Array,
  aus: Float32Array,
  breite: number,
  hoehe: number,
  kern: Kern,
  umgekehrt = false,
): void {
  const { werte, breite: kb, hoehe: kh, mx, my } = kern;
  for (let y = 0; y < hoehe; y += 1) {
    for (let x = 0; x < breite; x += 1) {
      let summe = 0;
      for (let ky = 0; ky < kh; ky += 1) {
        for (let kx = 0; kx < kb; kx += 1) {
          const g = werte[umgekehrt ? (kh - 1 - ky) * kb + (kb - 1 - kx) : ky * kb + kx];
          if (g === 0) continue;
          let px = x + kx - mx;
          let py = y + ky - my;
          // Spiegeln statt klemmen: Klemmen zieht den Randpunkt in die
          // Länge und erzeugt dort einen Streifen.
          if (px < 0) px = -px;
          if (py < 0) py = -py;
          if (px >= breite) px = 2 * breite - 2 - px;
          if (py >= hoehe) py = 2 * hoehe - 2 - py;
          if (px < 0) px = 0;
          if (py < 0) py = 0;
          summe += ein[py * breite + px] * g;
        }
      }
      aus[y * breite + x] = summe;
    }
  }
}

/**
 * Richardson-Lucy auf einen Kanal, in linearem Licht.
 *
 * # Das Verfahren in einer Zeile
 *
 *     s' = s · ( b / (s ⊛ k) ⊛ k̃ )
 *
 * `s` ist die Schätzung, `b` das beobachtete Bild, `k` die
 * Punktbildfunktion und `k̃` dieselbe, um ihre Mitte gedreht. Gestartet wird
 * mit `s = b`; jeder Durchgang vergleicht, was die aktuelle Schätzung durch
 * die Unschärfe ergäbe, mit dem, was wirklich da ist, und korrigiert
 * multiplikativ.
 *
 * Multiplikativ, und das ist der Grund, warum das Verfahren nicht entgleist:
 * Eine Schätzung kann nie negativ werden, und die Lichtmenge bleibt erhalten.
 * Ein Bild hat keine negative Helligkeit – ein Verfahren, das sie zulässt
 * (Wiener etwa), erzeugt an jeder Kante ein Klingeln.
 *
 * # Die Dämpfung
 *
 * Wo das Verhältnis nahe eins liegt, stimmt die Schätzung schon – der Rest
 * ist Rauschen. Ohne Dämpfung verstärkt jeder weitere Durchgang genau dieses
 * Rauschen, und nach dreissig Durchgängen ist ein glatter Himmel grieselig.
 * `daempfung` zieht Verhältnisse, die weniger als diesen Betrag von eins
 * abweichen, gegen eins zurück (nach Snyder und White).
 */
export function richardsonLucy(
  beobachtet: Float32Array,
  breite: number,
  hoehe: number,
  kern: Kern,
  iterationen: number,
  daempfung = 0,
): Float32Array {
  const n = breite * hoehe;
  let schaetzung = Float32Array.from(beobachtet);
  const gefaltet = new Float32Array(n);
  const verhaeltnis = new Float32Array(n);
  const rueck = new Float32Array(n);
  // Unter diesem Wert ist die Division nicht mehr sinnvoll – dort ist
  // ohnehin nichts.
  const WINZIG = 1e-6;

  for (let i = 0; i < iterationen; i += 1) {
    falten(schaetzung, gefaltet, breite, hoehe, kern, false);
    for (let k = 0; k < n; k += 1) {
      const unten = gefaltet[k];
      let v = unten > WINZIG ? beobachtet[k] / unten : 1;
      if (daempfung > 0) {
        /*
         * Weich gegen eins ziehen, nicht abschneiden: Ein harter Schnitt
         * erzeugt an der Schwelle eine sichtbare Grenze im Bild.
         */
        const ab = Math.abs(v - 1);
        if (ab < daempfung) {
          const t = ab / daempfung;
          v = 1 + (v - 1) * t * t;
        }
      }
      verhaeltnis[k] = v;
    }
    falten(verhaeltnis, rueck, breite, hoehe, kern, true);
    for (let k = 0; k < n; k += 1) {
      const neu = schaetzung[k] * rueck[k];
      // Nicht negativ und nicht unendlich – beides ist rechnerisch möglich
      // und im Bild eine Katastrophe.
      schaetzung[k] = neu > 0 && Number.isFinite(neu) ? neu : 0;
    }
  }
  return schaetzung;
}

/**
 * Das Ergebnis auf die Nachbarschaft der Quelle klemmen.
 *
 * Dieselbe Saumbegrenzung wie bei der Unschärfemaske, und aus demselben
 * Grund: Eine Entfaltung schiesst an harten Kanten über – das ist das
 * bekannte Klingeln. Innerhalb der Helligkeiten zu bleiben, die im Radius
 * wirklich vorkommen, nimmt ihm die Spitze, ohne die zurückgeholte Struktur
 * anzutasten.
 */
export function saumBegrenzen(
  ergebnis: Float32Array,
  quelle: Float32Array,
  breite: number,
  hoehe: number,
  radius: number,
): void {
  const r = Math.max(1, Math.round(radius));
  for (let y = 0; y < hoehe; y += 1) {
    for (let x = 0; x < breite; x += 1) {
      let kleinst = Infinity;
      let groesst = -Infinity;
      for (let dy = -r; dy <= r; dy += 1) {
        const py = Math.min(hoehe - 1, Math.max(0, y + dy));
        for (let dx = -r; dx <= r; dx += 1) {
          const px = Math.min(breite - 1, Math.max(0, x + dx));
          const wert = quelle[py * breite + px];
          if (wert < kleinst) kleinst = wert;
          if (wert > groesst) groesst = wert;
        }
      }
      const at = y * breite + x;
      ergebnis[at] = Math.min(groesst, Math.max(kleinst, ergebnis[at]));
    }
  }
}
