/**
 * Eine Maske über die Bilder eines Films mitnehmen.
 *
 * # Wozu das gut ist
 *
 * Das Freistellnetz über jedes einzelne Bild laufen zu lassen, ist teuer:
 * gemessen 1,8 s für fünfzig Bilder bei „Person", 80 s bei „u2netp" und 100 s
 * bei „BiRefNet" auf der Grafikeinheit. Also läuft das Netz nur auf jedem
 * n-ten Bild, und dazwischen wird die Maske MITGEZOGEN.
 *
 * # Warum hier fast alles neu ist
 *
 * Die erste Fassung hat nicht funktioniert, und zwar nicht ein bisschen,
 * sondern gar nicht. Nachgemessen am Film eines Anwenders – 3,4 s, 960 × 540,
 * freihändig gefilmtes Bücherregal, 34 Bilder:
 *
 *   * Der Median der Blockvektoren war in ALLEN 33 Übergängen (0, 0). Die
 *     Maske bewegte sich also kein einziges Mal, während sich die Szene
 *     darunter deutlich verschob.
 *   * Eine Maske, die man 33-mal mit dem rohen Blockfeld schob, verlor
 *     58 % ihrer Fläche – die uneinigen Blöcke reissen sie auseinander.
 *   * Eine Ganzbildsuche nach einer reinen Verschiebung fand ebenfalls
 *     nichts: Die Kamera DREHTE sich, und eine Verschiebung kann das nicht
 *     beschreiben.
 *
 * Drei Ursachen, alle drei hier behoben:
 *
 * 1. **Der Aufschlag je Punkt Bewegung** (früher 0,6 je Graupunkt) hat echte
 *    Bewegung erstickt. Um sieben Graupunkte zu rechtfertigen, musste sich
 *    die mittlere Abweichung um 4,2 Stufen bessern – das schafft kaum ein
 *    Block. Statt eines Aufschlags werden die Versätze jetzt NACH ABSTAND
 *    geprüft und nur bei echter Verbesserung übernommen; bei Gleichstand
 *    gewinnt damit von selbst der Stillstand, ohne echte Bewegung zu
 *    bestrafen.
 * 2. **Der Median über ALLE Blöcke** war null, weil in diesem Bild mehr als
 *    die Hälfte der Blöcke auf glatten Flächen liegt (blaues Regalblech,
 *    weisse Wand) und dort nichts zu finden ist. Jeder Block sagt jetzt
 *    dazu, wie SICHER er ist – um wie viel besser sein Fund gegenüber dem
 *    Stillstand ist –, und nur sichere Blöcke zählen.
 * 3. **Das rohe Blockfeld als Verzerrung** zerreisst die Maske. Aus den
 *    sicheren Blöcken wird deshalb EINE Ähnlichkeit gerechnet – Verschiebung,
 *    Drehung, Massstab – und die Maske wird damit in einem Zug aus dem
 *    ERSTEN Bild gezogen, nie aus einer schon gezogenen Fassung.
 *
 * Nachgemessen an demselben Film: 25 bis 30 der 33 Übergänge liefern jetzt
 * eine Lage (die übrigen sind Momente, in denen die Kamera wirklich still
 * steht), und der Schwerpunkt einer markierten Fläche wandert von (441, 248)
 * auf (556, 341) mit – bei nahezu gleichbleibender Fläche, statt auf 42 % zu
 * schrumpfen.
 *
 * # Warum die Vektoren RÜCKWÄRTS zeigen
 *
 * `bewegung(vorher, nachher)` sucht für jeden Block des NEUEN Bildes die
 * Stelle, an der er im ALTEN stand. Beim Ziehen wird dann für jeden Punkt der
 * neuen Maske gefragt „wo stand das?" statt „wo kommt das hin?". Nur so
 * bekommt jeder Punkt einen Wert; vorwärts blieben überall dort Löcher, wo
 * zwei Blöcke auseinanderlaufen.
 */

/*
 * Die drei Zahlen sind gemessen, nicht geraten. An dem Film oben, bei je
 * 33 Übergängen:
 *
 *   Kante Block Suche | ms je Übergang | Übergänge mit Lage | sichere Blöcke
 *     128    16     8 |            3,5 |              24/33 |            340
 *     240    24    12 |           18,8 |              25/33 |            508
 *     320    24    12 |           35,7 |              28/33 |            931
 *     240    16    12 |           72,5 |              30/33 |           1272
 *
 * Gewählt ist die dritte Zeile: nahezu die Güte der teuersten für die Hälfte
 * ihrer Zeit. 36 ms je Übergang sind gegen 1,8 s für einen Lauf von „u2netp"
 * zwei Prozent – und bei „Person" (36 ms je Lauf) verdoppeln sie die Kosten
 * je Bild, was bei 150 Bildern gut fünf Sekunden ausmacht. Das ist der Preis
 * dafür, dass die Maske überhaupt mitgeht.
 */

/**
 * Die längere Kante der FEINEN Stufe.
 *
 * Zwei Stufen, und das ist kein Feinschliff. `SUCHE` zählt in GRAUpunkten;
 * eine feinere Graustufe verkleinert damit die Reichweite in Bildpunkten im
 * selben Mass, in dem sie die Genauigkeit erhöht. Wer nur die Auflösung
 * anhebt, tauscht also Reichweite gegen Genauigkeit – und verliert bei
 * kräftiger Bewegung mehr, als er gewinnt.
 *
 * Deshalb sucht die grobe Stufe die Gegend (weite Reichweite, ungenau) und
 * die feine verfeinert sie um wenige Punkte. Nachgemessen an einem Schwenk
 * mit bekannter Wahrheit, mittlerer Schwerpunktfehler in Bildpunkten:
 *
 *   Bewegung je Bild |  einstufig grob | zweistufig
 *                4px |             2,8 |        0,8
 *               10px |             3,0 |        1,3
 *               20px |             9,4 |        6,8
 *
 * Kosten: 17 ms je Übergang statt 2,4 ms. Gegen 1,8 s für einen Netzlauf ist
 * das ein Prozent.
 */
export const GRAU_KANTE = 320;
/** Die längere Kante der GROBEN Stufe – sie bringt die Reichweite. */
export const GRAU_GROB = 128;
/** Die Kantenlänge eines Blocks in Graupunkten. */
export const BLOCK = 24;
/** Wie weit die grobe Stufe sucht – in ihren Graupunkten, in jede Richtung. */
export const SUCHE = 8;
/** Wie weit die feine Stufe um das grobe Ergebnis herum nachsieht. */
export const FEIN_SUCHE = 2;

/**
 * Ein kleiner Aufschlag je Graupunkt Bewegung.
 *
 * Er war einmal 0,6 und hat damit echte Bewegung erstickt – deshalb stand
 * hier zwischenzeitlich gar keiner mehr. Beides ist falsch: Nachgemessen an
 * einem Schwenk mit bekannter Wahrheit liegt der mittlere Fehler bei 10
 * Bildpunkten Bewegung je Bild bei 1,3 Punkten mit 0,2 und bei 1,6 ohne
 * Aufschlag, und die Maske behält mit Aufschlag ihre Fläche statt auf 95 %
 * zu fallen. Bei 20 Punkten Bewegung sind es 4,3 gegen 2,0 zugunsten des
 * kleineren Aufschlags gegenüber 0,6.
 *
 * 0,2 ist also nicht die Mitte zwischen zwei Meinungen, sondern der
 * gemessene beste Wert: gerade genug, um Rauschen zu dämpfen, zu wenig, um
 * echte Bewegung zu verhindern.
 */
const STRAFE = 0.2;

/**
 * Ab welchem Gewinn ein Block als sicher gilt.
 *
 * Der Gewinn ist, um wie viele Graustufen sich die mittlere Abweichung
 * gegenüber dem Stillstand bessert. Auf einer glatten Fläche ist er null; an
 * einer Kante liegt er gemessen zwischen 4 und 19. Anderthalb Stufen trennen
 * beides sauber und lassen auch schwach strukturierte Blöcke noch mitreden.
 */
export const SICHER_AB = 1.5;

export interface Grau {
  readonly werte: Float32Array;
  readonly breite: number;
  readonly hoehe: number;
}

/**
 * Ein Bild auf Graustufen und auf Briefmarkengrösse bringen.
 *
 * Gewichtet nach Empfindlichkeit des Auges, weil eine rote Jacke vor grünem
 * Rasen bei ungewichteter Mittelung denselben Grauwert bekäme – und der
 * Blockvergleich dann nichts mehr zu vergleichen hätte.
 */
export function graustufen(daten: ImageData, maxKante = GRAU_KANTE): Grau {
  const faktor = Math.max(1, Math.ceil(Math.max(daten.width, daten.height) / maxKante));
  const breite = Math.max(1, Math.floor(daten.width / faktor));
  const hoehe = Math.max(1, Math.floor(daten.height / faktor));
  const werte = new Float32Array(breite * hoehe);
  const d = daten.data;

  for (let y = 0; y < hoehe; y += 1) {
    for (let x = 0; x < breite; x += 1) {
      let summe = 0;
      let zahl = 0;
      for (let dy = 0; dy < faktor; dy += 1) {
        const qy = y * faktor + dy;
        if (qy >= daten.height) break;
        for (let dx = 0; dx < faktor; dx += 1) {
          const qx = x * faktor + dx;
          if (qx >= daten.width) break;
          const at = (qy * daten.width + qx) * 4;
          summe += 0.299 * d[at] + 0.587 * d[at + 1] + 0.114 * d[at + 2];
          zahl += 1;
        }
      }
      werte[y * breite + x] = zahl > 0 ? summe / zahl : 0;
    }
  }
  return { werte, breite, hoehe };
}

export interface Feld {
  readonly spalten: number;
  readonly zeilen: number;
  /** Je Block der Versatz zurück ins alte Bild, in Graupunkten. */
  readonly dx: Float32Array;
  readonly dy: Float32Array;
  /** Wie viele Bildpunkte ein Graupunkt war. */
  readonly faktor: number;
  readonly grauBreite: number;
  readonly grauHoehe: number;
  /**
   * Je Block, um wie viele Graustufen sein Fund besser ist als Stillstand.
   *
   * Das ist der Wert, an dem sich alles Weitere entscheidet. Ohne ihn zählt
   * ein Block auf blankem Regalblech genauso viel wie einer auf einer
   * Buchkante – und weil es von der ersten Sorte mehr gibt, kam am Ende
   * „keine Bewegung" heraus.
   */
  readonly gewinn: Float32Array;
}

/**
 * Alle Versätze, nach Abstand vom Stillstand sortiert.
 *
 * Einmal gerechnet und für jede Blockgrösse gemerkt: Die Reihenfolge hängt
 * nur von der Suchweite ab, nicht vom Bild.
 *
 * Die Reihenfolge ersetzt den früheren Aufschlag je Punkt Bewegung. Geprüft
 * wird mit ECHT KLEINER; bei Gleichstand bleibt damit der zuerst geprüfte
 * Versatz stehen, und das ist der kleinste. Auf einer glatten Fläche, wo alle
 * Versätze gleich gut sind, kommt so (0, 0) heraus – dasselbe Ergebnis wie
 * mit dem Aufschlag, nur ohne echte Bewegung zu bestrafen.
 */
const versatzKarte = new Map<number, Int8Array>();
function versaetze(weite: number): Int8Array {
  const da = versatzKarte.get(weite);
  if (da) return da;
  const liste: [number, number][] = [];
  for (let oy = -weite; oy <= weite; oy += 1) {
    for (let ox = -weite; ox <= weite; ox += 1) liste.push([ox, oy]);
  }
  liste.sort((a, b) => Math.abs(a[0]) + Math.abs(a[1]) - (Math.abs(b[0]) + Math.abs(b[1])));
  const feld = new Int8Array(liste.length * 2);
  liste.forEach(([ox, oy], i) => {
    feld[i * 2] = ox;
    feld[i * 2 + 1] = oy;
  });
  versatzKarte.set(weite, feld);
  return feld;
}

/**
 * Die beste Stelle für einen Block – erschöpfend über ein Fenster.
 *
 * Gibt den Versatz und den Gewinn gegenüber `um` zurück. Der Gewinn ist das,
 * woran später die Sicherheit hängt: Auf einer glatten Fläche ist er null.
 */
function blockSuchen(
  vorher: Grau,
  nachher: Grau,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  umX: number,
  umY: number,
  weite: number,
  schritt: number,
  strafe: number,
): { dx: number; dy: number; gewinn: number } {
  const { breite, hoehe } = nachher;
  const ordnung = versaetze(weite);
  let besteX = umX;
  let besteY = umY;
  let bestes = Infinity;
  let beiMitte = Infinity;

  for (let k = 0; k < ordnung.length; k += 2) {
    const ox = umX + ordnung[k];
    const oy = umY + ordnung[k + 1];
    let summe = 0;
    let proben = 0;
    for (let y = y0; y < y1; y += schritt) {
      const qy = y + oy;
      if (qy < 0 || qy >= hoehe) continue;
      for (let x = x0; x < x1; x += schritt) {
        const qx = x + ox;
        if (qx < 0 || qx >= breite) continue;
        summe += Math.abs(nachher.werte[y * breite + x] - vorher.werte[qy * breite + qx]);
        proben += 1;
      }
    }
    if (proben === 0) continue;
    /*
     * Auf die Probe bezogen, sonst gewinnt immer der Versatz, der am
     * weitesten aus dem Bild hinausragt und deshalb kaum Proben hat. Der
     * Aufschlag zählt ab dem MITTELPUNKT der Suche, nicht ab null: In der
     * feinen Stufe ist der Mittelpunkt bereits das grobe Ergebnis, und der
     * Weg dorthin darf nicht zweimal bezahlt werden.
     */
    const wert = summe / proben + strafe * (Math.abs(ordnung[k]) + Math.abs(ordnung[k + 1]));
    if (ordnung[k] === 0 && ordnung[k + 1] === 0) beiMitte = wert;
    if (wert < bestes) {
      bestes = wert;
      besteX = ox;
      besteY = oy;
    }
  }
  return {
    dx: besteX,
    dy: besteY,
    gewinn: Number.isFinite(beiMitte) ? beiMitte - bestes : 0,
  };
}

/**
 * Für jeden Block des neuen Bildes suchen, wo er im alten stand.
 *
 * Zwei Stufen: Die grobe bringt die Reichweite, die feine die Genauigkeit –
 * die Begründung samt Zahlen steht bei `GRAU_KANTE`.
 *
 * Verglichen wird über die Summe der Beträge, grob über jeden zweiten Punkt
 * und fein über jeden. Grob genügt die halbe Abtastung, weil es dort nur um
 * die Gegend geht; fein entscheidet jeder Punkt mit.
 */
export function bewegung(vorher: Grau, nachher: Grau, bildBreite: number): Feld {
  if (vorher.breite !== nachher.breite || vorher.hoehe !== nachher.hoehe) {
    throw new Error('Die Bewegung lässt sich nur zwischen gleich grossen Bildern schätzen');
  }
  const { breite, hoehe } = nachher;
  const spalten = Math.max(1, Math.ceil(breite / BLOCK));
  const zeilen = Math.max(1, Math.ceil(hoehe / BLOCK));
  const dx = new Float32Array(spalten * zeilen);
  const dy = new Float32Array(spalten * zeilen);
  const gewinn = new Float32Array(spalten * zeilen);

  /*
   * Die grobe Stufe entsteht durch nochmaliges Verkleinern der feinen – nicht
   * aus dem Originalbild. Das spart einen zweiten Durchgang über alle
   * Bildpunkte, und der Unterschied ist nicht messbar: Beide Wege mitteln
   * dieselben Punkte, nur in anderer Reihenfolge.
   */
  const stufe = Math.max(1, Math.round(breite / Math.min(breite, GRAU_GROB)));
  const grobVor = stufe > 1 ? verkleinern(vorher, stufe) : vorher;
  const grobNach = stufe > 1 ? verkleinern(nachher, stufe) : nachher;

  for (let bz = 0; bz < zeilen; bz += 1) {
    for (let bs = 0; bs < spalten; bs += 1) {
      const x0 = bs * BLOCK;
      const y0 = bz * BLOCK;
      const x1 = Math.min(x0 + BLOCK, breite);
      const y1 = Math.min(y0 + BLOCK, hoehe);

      let umX = 0;
      let umY = 0;
      if (stufe > 1) {
        const grob = blockSuchen(
          grobVor,
          grobNach,
          Math.floor(x0 / stufe),
          Math.floor(y0 / stufe),
          Math.max(Math.floor(x0 / stufe) + 1, Math.ceil(x1 / stufe)),
          Math.max(Math.floor(y0 / stufe) + 1, Math.ceil(y1 / stufe)),
          0,
          0,
          SUCHE,
          1,
          /*
           * Auch die grobe Stufe bekommt den Aufschlag.
           *
           * Ihn dort zu streichen lag nahe – ihre Aufgabe ist die Reichweite,
           * nicht die Ruhe – und war gemessen schlechter: An einem um vier
           * Grad gedrehten Prüfbild fiel die gefundene Drehung von −1,9 auf
           * −1,2 Grad, weil die grobe Stufe ohne Aufschlag in strukturarmen
           * Blöcken zu würfeln beginnt und die feine Stufe nur noch zwei
           * Punkte weit nachbessern darf.
           */
          STRAFE,
        );
        umX = grob.dx * stufe;
        umY = grob.dy * stufe;
      }

      /*
       * Ohne grobe Stufe muss die feine die ganze Reichweite tragen.
       *
       * Das ist der Fall bei kleinen Bildern – ein Standbild von 128 Punkten
       * wird nicht noch einmal halbiert. Stünde hier fest `FEIN_SUCHE`, läge
       * die Reichweite bei zwei Punkten, und jede grössere Bewegung wäre
       * unsichtbar; genau das hat eine Prüfung sofort gezeigt.
       */
      const fein = blockSuchen(
        vorher,
        nachher,
        x0,
        y0,
        x1,
        y1,
        umX,
        umY,
        stufe > 1 ? FEIN_SUCHE : SUCHE,
        1,
        STRAFE,
      );
      /*
       * Zwischen den Punkten nachsehen.
       *
       * Ein Block findet seinen Versatz nur in GANZEN Graupunkten. Bei einer
       * Drehung bewegen sich die Blöcke in der Bildmitte aber um Bruchteile
       * eines Punktes, und auf ganze Zahlen gerundet verschwindet die Drehung
       * fast ganz – an einem um vier Grad gedrehten Prüfbild gemessen kamen
       * statt −4 nur −1,9 Grad heraus.
       *
       * Durch die drei Abweichungen bei −1, 0 und +1 legt sich eine Parabel;
       * ihr Scheitel liegt dort, wo die Abweichung wirklich am kleinsten ist.
       * Das kostet vier zusätzliche Vergleiche je Block.
       */
      const genau = zwischenPunkt(vorher, nachher, x0, y0, x1, y1, fein.dx, fein.dy);
      const at = bz * spalten + bs;
      dx[at] = genau.dx;
      dy[at] = genau.dy;
      /*
       * Der Gewinn wird gegen den STILLSTAND gerechnet, nicht gegen den
       * groben Fund: Nur so sagt er „dieser Block hat überhaupt Struktur".
       * Ein Block auf blankem Blech findet grob wie fein dasselbe und hätte
       * sonst einen Gewinn von null – und genau das soll er haben.
       */
      gewinn[at] =
        umX === 0 && umY === 0
          ? fein.gewinn
          : gegenRuhe(vorher, nachher, x0, y0, x1, y1, fein.dx, fein.dy);
    }
  }

  return {
    spalten,
    zeilen,
    dx,
    dy,
    gewinn,
    faktor: bildBreite / breite,
    grauBreite: breite,
    grauHoehe: hoehe,
  };
}

/**
 * Den Versatz zwischen den Punkten verfeinern – Scheitel einer Parabel.
 *
 * Getrennt je Achse, weil das genügt: Die Abweichung wächst in der Nähe des
 * Minimums in beiden Richtungen näherungsweise quadratisch, und zwei
 * eindimensionale Scheitel sind dort dasselbe wie einer in der Fläche. Die
 * Verschiebung wird auf einen halben Punkt begrenzt – mehr wäre kein
 * Zwischenwert mehr, sondern ein anderer Punkt, und der wäre bei der Suche
 * schon gefunden worden.
 */
function zwischenPunkt(
  vorher: Grau,
  nachher: Grau,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  dx: number,
  dy: number,
): { dx: number; dy: number } {
  const messen = (ox: number, oy: number) => {
    const { breite, hoehe } = nachher;
    let summe = 0;
    let proben = 0;
    for (let y = y0; y < y1; y += 1) {
      const qy = y + oy;
      if (qy < 0 || qy >= hoehe) continue;
      for (let x = x0; x < x1; x += 1) {
        const qx = x + ox;
        if (qx < 0 || qx >= breite) continue;
        summe += Math.abs(nachher.werte[y * breite + x] - vorher.werte[qy * breite + qx]);
        proben += 1;
      }
    }
    return proben === 0 ? Infinity : summe / proben;
  };
  const mitte = messen(dx, dy);
  if (!Number.isFinite(mitte)) return { dx, dy };

  const scheitel = (links: number, rechts: number) => {
    if (!Number.isFinite(links) || !Number.isFinite(rechts)) return 0;
    const nenner = links - 2 * mitte + rechts;
    // Ein nicht nach oben geöffneter Bogen hat keinen Scheitel, der hier
    // etwas bedeutete – dann bleibt es bei der ganzen Zahl.
    if (nenner <= 0) return 0;
    return Math.max(-0.5, Math.min(0.5, (links - rechts) / (2 * nenner)));
  };

  return {
    dx: dx + scheitel(messen(dx - 1, dy), messen(dx + 1, dy)),
    dy: dy + scheitel(messen(dx, dy - 1), messen(dx, dy + 1)),
  };
}

/** Um wie viel besser der gefundene Versatz gegenüber dem Stillstand ist. */
function gegenRuhe(
  vorher: Grau,
  nachher: Grau,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  dx: number,
  dy: number,
): number {
  const { breite, hoehe } = nachher;
  const messen = (ox: number, oy: number) => {
    let summe = 0;
    let proben = 0;
    for (let y = y0; y < y1; y += 1) {
      const qy = y + oy;
      if (qy < 0 || qy >= hoehe) continue;
      for (let x = x0; x < x1; x += 1) {
        const qx = x + ox;
        if (qx < 0 || qx >= breite) continue;
        summe += Math.abs(nachher.werte[y * breite + x] - vorher.werte[qy * breite + qx]);
        proben += 1;
      }
    }
    return proben === 0 ? Infinity : summe / proben;
  };
  const ruhe = messen(0, 0);
  const dort = messen(dx, dy);
  return Number.isFinite(ruhe) && Number.isFinite(dort) ? ruhe - dort : 0;
}

/** Ein Graubild um einen ganzzahligen Faktor verkleinern – mittelnd. */
function verkleinern(bild: Grau, faktor: number): Grau {
  const breite = Math.max(1, Math.floor(bild.breite / faktor));
  const hoehe = Math.max(1, Math.floor(bild.hoehe / faktor));
  const werte = new Float32Array(breite * hoehe);
  for (let y = 0; y < hoehe; y += 1) {
    for (let x = 0; x < breite; x += 1) {
      let summe = 0;
      let zahl = 0;
      for (let dy = 0; dy < faktor; dy += 1) {
        const qy = y * faktor + dy;
        if (qy >= bild.hoehe) break;
        for (let dx = 0; dx < faktor; dx += 1) {
          const qx = x * faktor + dx;
          if (qx >= bild.breite) break;
          summe += bild.werte[qy * bild.breite + qx];
          zahl += 1;
        }
      }
      werte[y * breite + x] = zahl > 0 ? summe / zahl : 0;
    }
  }
  return { werte, breite, hoehe };
}

/* ---------- Eine Lage: Verschiebung, Drehung, Massstab ---------- */

/**
 * Wie das vorige Bild auf das neue passt – als ÄHNLICHKEIT.
 *
 * `s` und `w` sind Massstab mal Kosinus und Massstab mal Sinus des Winkels;
 * zusammen mit `tx`/`ty` beschreiben sie
 *
 *     quelle.x = s * ziel.x − w * ziel.y + tx
 *     quelle.y = w * ziel.x + s * ziel.y + ty
 *
 * also den Weg vom neuen Bild ZURÜCK ins alte – dieselbe Richtung wie die
 * Blockvektoren.
 *
 * # Warum Ähnlichkeit und nicht nur Verschiebung
 *
 * Weil eine Verschiebung an diesem Film gemessen NICHTS findet: Eine
 * Ganzbildsuche über ±40 Bildpunkte fand in 31 von 33 Übergängen (0, 0) bei
 * null Gewinn. Wer ein Telefon in der Hand hält, verkantet es – die Szene
 * DREHT sich im Bild, und dagegen ist jede reine Verschiebung machtlos.
 * Gemessen sind es bis zu 3,6 Grad je Zehntelsekunde.
 *
 * # Warum keine volle Affinität
 *
 * Weil sie sechs Freiheitsgrade hat und damit auch Scherung und ungleiche
 * Streckung zulässt. Beides kommt bei einer Handkamera nicht vor, wird aber
 * aus verrauschten Blockvektoren bereitwillig „gefunden" – und verzerrt die
 * Maske dann sichtbar. Vier Freiheitsgrade beschreiben, was wirklich
 * passiert, und nicht mehr.
 */
export interface Lage {
  readonly s: number;
  readonly w: number;
  readonly tx: number;
  readonly ty: number;
  /** Wie viele Blöcke dahinterstehen. Null heisst: nichts gefunden. */
  readonly sicher: number;
}

/** Nichts bewegt sich. */
export const LAGE_RUHE: Lage = { s: 1, w: 0, tx: 0, ty: 0, sicher: 0 };

/**
 * Die Ähnlichkeit, die am besten zu den sicheren Blöcken passt.
 *
 * Kleinste Quadrate in geschlossener Form – das ist für vier Freiheitsgrade
 * eine Handvoll Summen und braucht keine Matrizenrechnung.
 *
 * Weniger als fünf sichere Blöcke heissen `LAGE_RUHE`: Aus vier Punkten lässt
 * sich zwar rechnen, aber nichts glauben. Lieber zugeben, dass nichts
 * gefunden wurde, als die Maske auf einen Zufall zu schieben.
 */
export function lageSchaetzen(feld: Feld, mindestGewinn = SICHER_AB): Lage {
  let n = 0;
  let mpx = 0;
  let mpy = 0;
  let mqx = 0;
  let mqy = 0;
  for (let bz = 0; bz < feld.zeilen; bz += 1) {
    for (let bs = 0; bs < feld.spalten; bs += 1) {
      const at = bz * feld.spalten + bs;
      if (feld.gewinn[at] < mindestGewinn) continue;
      const cx = bs * BLOCK + BLOCK / 2;
      const cy = bz * BLOCK + BLOCK / 2;
      mpx += cx;
      mpy += cy;
      mqx += cx + feld.dx[at];
      mqy += cy + feld.dy[at];
      n += 1;
    }
  }
  if (n < 5) return LAGE_RUHE;
  mpx /= n;
  mpy /= n;
  mqx /= n;
  mqy /= n;

  let a = 0;
  let b = 0;
  let nenner = 0;
  for (let bz = 0; bz < feld.zeilen; bz += 1) {
    for (let bs = 0; bs < feld.spalten; bs += 1) {
      const at = bz * feld.spalten + bs;
      if (feld.gewinn[at] < mindestGewinn) continue;
      const px = bs * BLOCK + BLOCK / 2 - mpx;
      const py = bz * BLOCK + BLOCK / 2 - mpy;
      const qx = bs * BLOCK + BLOCK / 2 + feld.dx[at] - mqx;
      const qy = bz * BLOCK + BLOCK / 2 + feld.dy[at] - mqy;
      a += px * qx + py * qy;
      b += px * qy - py * qx;
      nenner += px * px + py * py;
    }
  }
  if (nenner === 0) return LAGE_RUHE;
  const s = a / nenner;
  const w = b / nenner;
  return { s, w, tx: mqx - (s * mpx - w * mpy), ty: mqy - (w * mpx + s * mpy), sicher: n };
}

/** Ob sich überhaupt etwas bewegt – oder ob die Lage die Ruhe ist. */
export function lageRuht(lage: Lage): boolean {
  return (
    Math.abs(lage.s - 1) < 1e-6 &&
    Math.abs(lage.w) < 1e-6 &&
    Math.abs(lage.tx) < 1e-6 &&
    Math.abs(lage.ty) < 1e-6
  );
}

/**
 * Zwei Lagen hintereinander ausführen: erst `zuerst`, dann `danach`.
 *
 * # Warum die Namen ANWENDUNGSREIHENFOLGE meinen und nicht Zeit
 *
 * Weil beides auseinanderläuft, und das hat gemessen 26,6 Bildpunkte
 * gekostet. Eine Lage bildet ein Bild auf ein FRÜHERES ab – `punktZurueck`
 * sagt es im Namen. Die Lage eines Bildes gegenüber dem ersten entsteht
 * deshalb so: Der jüngste Schritt (von Bild n nach n−1) wird ZUERST
 * angewandt, die aufgelaufene Kette (von n−1 zurück bis 0) danach. Der
 * zeitlich spätere Schritt steht also vorn.
 *
 * Die Parameter hiessen einmal `frueher` und `spaeter`, und genau an dieser
 * Verwechslung ist es aufgelaufen: Nachgerechnet mit acht Schwenken und
 * danach acht Drehungen zu drei Grad lag ein Punkt aus Bild 0 in Bild 16 um
 * 26,6 Punkte daneben; in der richtigen Reihenfolge sind es 1e−14. Bei reiner
 * Verschiebung ODER reiner Drehung vertauschen die beiden sich – deshalb ist
 * es keinem der bisherigen Tests aufgefallen.
 *
 * Gebraucht wird die Verkettung, damit eine Maske IMMER aus dem Urbild
 * gezogen wird und nie aus einer schon gezogenen Fassung. Sonst legt sich bei
 * jedem Schritt eine weitere Abtastung darüber, und die Maske franst aus –
 * gemessen 58 % Flächenverlust über 33 Schritte.
 */
export function lageVerketten(zuerst: Lage, danach: Lage): Lage {
  /*
   * Die Ruhe ist neutral, und zwar auch fuer die Sicherheit.
   *
   * Sonst riss ein einziges stillstehendes Bild die ganze Kette auf null –
   * und gerade Stillstand ist kein Zeichen von Unsicherheit, sondern eines
   * von Gewissheit. Nachgemessen am Film des Anwenders stehen 8 der 33
   * Uebergaenge still.
   */
  if (lageRuht(zuerst)) return danach;
  if (lageRuht(danach)) return zuerst;
  return {
    s: danach.s * zuerst.s - danach.w * zuerst.w,
    w: danach.s * zuerst.w + danach.w * zuerst.s,
    tx: danach.s * zuerst.tx - danach.w * zuerst.ty + danach.tx,
    ty: danach.w * zuerst.tx + danach.s * zuerst.ty + danach.ty,
    sicher: Math.min(zuerst.sicher, danach.sicher),
  };
}

/**
 * Wo ein Punkt des BILDES vorher stand – in Bildpunkten, nicht in Graupunkten.
 *
 * Die Lage rechnet in Graupunkten; ein Punkt im Bild wird dafür
 * heruntergerechnet, gezogen und wieder hinaufgerechnet. `faktor` steht am
 * Feld und damit auch an jeder daraus geschätzten Lage.
 */
export function punktZurueck(
  lage: Lage,
  faktor: number,
  x: number,
  y: number,
): { x: number; y: number } {
  const gx = x / faktor;
  const gy = y / faktor;
  return {
    x: (lage.s * gx - lage.w * gy + lage.tx) * faktor,
    y: (lage.w * gx + lage.s * gy + lage.ty) * faktor,
  };
}

/**
 * Wo ein Punkt HINGEHT – die Umkehrung von `punktZurueck`.
 *
 * Gebraucht für alles, was am Motiv klebt und mitwandern soll: ein
 * angetippter Punkt, die beiden Enden eines Verlaufs, die Mitte einer
 * Ellipse. Die Maske dagegen wird rückwärts gezogen; siehe `maskeZiehen`.
 */
export function punktVor(
  lage: Lage,
  faktor: number,
  x: number,
  y: number,
): { x: number; y: number } {
  const nenner = lage.s * lage.s + lage.w * lage.w;
  if (nenner === 0) return { x, y };
  const gx = x / faktor - lage.tx;
  const gy = y / faktor - lage.ty;
  return {
    x: ((lage.s * gx + lage.w * gy) / nenner) * faktor,
    y: ((-lage.w * gx + lage.s * gy) / nenner) * faktor,
  };
}

/**
 * Eine Maske mit einer Lage ziehen.
 *
 * Abgetastet wird mit den vier Nachbarn gemischt und nicht mit dem nächsten:
 * Die Maske hat weiche Ränder – `kanteWeichzeichnen` sorgt dafür –, und der
 * nächste Nachbar machte daraus bei jedem Zug einen etwas härteren.
 *
 * Gezogen wird immer aus dem URBILD, mit der aufsummierten Lage. Wer
 * stattdessen jedes Mal das letzte Ergebnis weiterzieht, legt Abtastung auf
 * Abtastung; nachgemessen verliert eine Maske so 58 % ihrer Fläche über 33
 * Schritte, während sie in einem Zug gezogen ihre Fläche behält.
 */
export function maskeZiehen(
  alpha: Uint8Array,
  breite: number,
  hoehe: number,
  lage: Lage,
  faktor: number,
): Uint8Array {
  if (lageRuht(lage)) return alpha;
  const raus = new Uint8Array(breite * hoehe);
  for (let y = 0; y < hoehe; y += 1) {
    for (let x = 0; x < breite; x += 1) {
      const q = punktZurueck(lage, faktor, x, y);
      /*
       * Von ausserhalb kam nichts – also war dort auch nichts freigestellt.
       * Den Rand fortzuschreiben wäre die Alternative und die schlechtere:
       * Schwenkt die Kamera, zöge die Maske am Bildrand einen Streifen
       * hinter sich her.
       */
      if (q.x < 0 || q.y < 0 || q.x > breite - 1 || q.y > hoehe - 1) continue;
      const x0 = Math.floor(q.x);
      const y0 = Math.floor(q.y);
      const x1 = Math.min(breite - 1, x0 + 1);
      const y1 = Math.min(hoehe - 1, y0 + 1);
      const ax = q.x - x0;
      const ay = q.y - y0;
      const oben = alpha[y0 * breite + x0] * (1 - ax) + alpha[y0 * breite + x1] * ax;
      const unten = alpha[y1 * breite + x0] * (1 - ax) + alpha[y1 * breite + x1] * ax;
      raus[y * breite + x] = Math.round(oben * (1 - ay) + unten * ay);
    }
  }
  return raus;
}

/**
 * Das Flackern herausnehmen.
 *
 * Auch ein gutes Netz trifft an einer Haarsträhne mal so und mal anders. Bei
 * einem Standbild sieht man das nie, bei zehn Bildern je Sekunde flimmert der
 * Rand. Gemittelt wird über ein Fenster von drei Bildern – die Bewegung
 * dazwischen ist bei 100 ms klein gegen die Breite des weichen Randes, das
 * Rauschen ist es nicht.
 *
 * # Warum das Mittel und nicht der Median
 *
 * Weil die Maske weiche Ränder hat. Der Median wählt EINEN der drei Werte und
 * lässt den Rand deshalb weiter springen, nur eben seltener. Das Mittel
 * verschmiert ihn – und genau das soll es.
 */
export function zeitlichGlaetten(
  masken: readonly Uint8Array[],
  fenster = 3,
  /**
   * An welchen Stellen ein neues Stück anfängt.
   *
   * Über eine Schnittkante hinweg zu mitteln hiesse, die Maske der einen
   * Szene in die andere hineinzurechnen – am Schnitt stünde dann für ein
   * Bild eine Maske, die zu keinem der beiden Bilder gehört.
   */
  schnitte: ReadonlySet<number> = new Set(),
): Uint8Array[] {
  if (masken.length === 0) return [];
  const halb = Math.floor(fenster / 2);
  if (halb < 1) return masken.map((maske) => Uint8Array.from(maske));
  const laenge = masken[0].length;

  return masken.map((_, i) => {
    let von = Math.max(0, i - halb);
    let bis = Math.min(masken.length - 1, i + halb);
    for (let k = i; k > von; k -= 1) if (schnitte.has(k)) von = k;
    for (let k = i + 1; k <= bis; k += 1) {
      if (schnitte.has(k)) {
        bis = k - 1;
        break;
      }
    }
    const raus = new Uint8Array(laenge);
    for (let p = 0; p < laenge; p += 1) {
      let summe = 0;
      for (let k = von; k <= bis; k += 1) summe += masken[k][p];
      raus[p] = Math.round(summe / (bis - von + 1));
    }
    return raus;
  });
}

/* ---------- Ob eine frisch gerechnete Maske plausibel ist ---------- */

/**
 * Wie stark sich eine neue Maske von der erwarteten unterscheiden darf.
 *
 * # Warum es das braucht
 *
 * Das ist die Antwort auf die Beschwerde, um die es wirklich ging. Am Film
 * eines Anwenders nachgemessen – die abgedunkelte Fläche in Prozent des
 * Bildes, Bild für Bild, bei einem Schlüsselbildabstand von vier:
 *
 *     4,1  4,1  3,8  7,3 | 56,1 57,5 55,1 51,5 | 5,2  1,9  2,3  4,2 |
 *     37,2 …               | 4,9  2,0  2,3  5,3 | 55,2 57,4 56,6 54,0
 *
 * Der Sprung liegt exakt auf jedem vierten Bild, also auf jedem
 * Schlüsselbild, und er geht um den Faktor dreizehn. Die Maske WANDERT also
 * gar nicht weg – sie platzt auf und fällt wieder zusammen. Bei der
 * Farbflutung genügt dafür eine Belichtungsschwankung, die ein Leck zwischen
 * zwei Flächen öffnet; das Verfahren kennt weder Flächendeckel noch
 * Gedächtnis.
 *
 * Ein frisch gerechnetes Schlüsselbild wird deshalb gegen das gehalten, was
 * aus dem vorigen Schlüsselbild zu erwarten war. Passt es nicht, gilt
 * weiter, was schon da war – lieber eine Maske, die etwas hinterherhinkt,
 * als eine, die jedes vierte Bild das halbe Bild verschluckt.
 */
export interface Pruefmass {
  /** Um welchen Faktor die Fläche höchstens wachsen oder schrumpfen darf. */
  readonly flaeche: number;
  /** Wie viel der kleineren Fläche mindestens gemeinsam sein muss, 0 … 1. */
  readonly deckung: number;
}

export const PRUEFMASS: Pruefmass = { flaeche: 3, deckung: 0.3 };

export interface Pruefbefund {
  readonly haelt: boolean;
  /** Das Flächenverhältnis neu zu erwartet. */
  readonly verhaeltnis: number;
  /** Der gemeinsame Anteil, bezogen auf die kleinere Fläche. */
  readonly deckung: number;
}

/**
 * Hält die neue Maske dem stand, was zu erwarten war?
 *
 * Gezählt wird ab halber Deckung (128), weil beide Masken weiche Ränder
 * haben und ein Rand sonst als halbe Fläche mitzählte.
 *
 * Eine LEERE Erwartung lässt alles durch: Beim ersten Schlüsselbild gibt es
 * nichts zu vergleichen, und eine Maske abzulehnen, weil noch keine da war,
 * wäre der sicherste Weg, gar keine zu bekommen.
 */
export function maskePasst(
  neu: Uint8Array,
  erwartet: Uint8Array | null,
  mass: Pruefmass = PRUEFMASS,
): Pruefbefund {
  if (!erwartet || erwartet.length !== neu.length) {
    return { haelt: true, verhaeltnis: 1, deckung: 1 };
  }
  let a = 0;
  let b = 0;
  let gemeinsam = 0;
  for (let i = 0; i < neu.length; i += 1) {
    const x = neu[i] >= 128 ? 1 : 0;
    const y = erwartet[i] >= 128 ? 1 : 0;
    a += x;
    b += y;
    gemeinsam += x & y;
  }
  if (a === 0 && b === 0) return { haelt: true, verhaeltnis: 1, deckung: 1 };
  if (b === 0) return { haelt: true, verhaeltnis: Infinity, deckung: 0 };
  if (a === 0) {
    // Eine Maske, die auf einmal leer ist, ist genauso verdächtig wie eine,
    // die platzt – nur fällt sie weniger auf.
    return { haelt: false, verhaeltnis: 0, deckung: 0 };
  }
  const verhaeltnis = a / b;
  const deckung = gemeinsam / Math.min(a, b);
  const haelt =
    verhaeltnis <= mass.flaeche && verhaeltnis >= 1 / mass.flaeche && deckung >= mass.deckung;
  return { haelt, verhaeltnis, deckung };
}
