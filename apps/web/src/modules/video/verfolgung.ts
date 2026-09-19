/**
 * Eine Maske von einem Bild zum nächsten mitnehmen.
 *
 * # Wozu das gut ist
 *
 * Das Freistellnetz über jedes einzelne Bild laufen zu lassen, ist teuer:
 * gemessen 1,8 s für fünfzig Bilder bei „Person", 80 s bei „u2netp" und 100 s
 * bei „BiRefNet" auf der Grafikeinheit. Also läuft das Netz nur auf jedem
 * n-ten Bild, und dazwischen wird die Maske GESCHOBEN.
 *
 * Was das Schieben kostet, ist nachgemessen: bei 384 × 216 rund 8 ms je
 * Übergang, bei 512 × 512 rund 14 ms – zusammengesetzt aus Graustufen,
 * Blocksuche und dem Abtasten der Maske, wovon das Abtasten der grösste Teil
 * ist. Gegen 1,6 s für einen Lauf von „u2netp" ist das unter einem Prozent.
 * Deshalb wird hier auch nichts weiter optimiert: Es lohnt sich nicht.
 *
 * # Warum blockweise und nicht ein Versatz fürs ganze Bild
 *
 * Weil sich in einem Video von Menschen fast nie das ganze Bild gleich bewegt.
 * Ein Versatz fürs ganze Bild beschreibt entweder den Schwenk der Kamera oder
 * die Person, nie beides – und die Maske sitzt dann um genau den Unterschied
 * daneben. Blockweise beschreibt beides zugleich.
 *
 * # Warum die Vektoren RÜCKWÄRTS zeigen
 *
 * `bewegung(vorher, nachher)` sucht für jeden Block des NEUEN Bildes die
 * Stelle, an der er im ALTEN stand. Beim Schieben wird dann für jeden Punkt
 * der neuen Maske gefragt „wo stand das?" statt „wo kommt das hin?". Nur so
 * bekommt jeder Punkt einen Wert; vorwärts blieben überall dort Löcher, wo
 * zwei Blöcke auseinanderlaufen.
 */

/** Die längere Kante, auf der gerechnet wird. */
export const GRAU_KANTE = 128;
/** Die Kantenlänge eines Blocks in Graupunkten. */
export const BLOCK = 16;
/** Wie weit gesucht wird – in Graupunkten, in jede Richtung. */
export const SUCHE = 8;

/**
 * Ein kleiner Aufschlag für jeden Punkt Bewegung.
 *
 * Ohne ihn zeigt jeder Block einer glatten Fläche – Himmel, Wand, Tischplatte
 * – irgendwohin: Dort ist die Abweichung für JEDEN Versatz null, und
 * gewonnen hat, was zuerst geprüft wurde. Die Maske zappelte dann in
 * Gegenden, in denen sich nichts bewegt. Der Aufschlag ist klein genug, um
 * echte Bewegung nicht zu unterdrücken, und gross genug, um bei Gleichstand
 * den Stillstand zu wählen.
 */
const STRAFE = 0.6;

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
}

/**
 * Für jeden Block des neuen Bildes suchen, wo er im alten stand.
 *
 * Verglichen wird über die Summe der Beträge und nur über JEDEN ZWEITEN Punkt
 * in beide Richtungen. Das viertelt die Arbeit, und es kostet nichts: Ein
 * Block von 16 × 16 hat auch mit 64 Proben genug Struktur, um die richtige
 * Stelle zu finden – die falsche wird von 64 Proben genauso deutlich
 * verworfen wie von 256.
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

  for (let bz = 0; bz < zeilen; bz += 1) {
    for (let bs = 0; bs < spalten; bs += 1) {
      const x0 = bs * BLOCK;
      const y0 = bz * BLOCK;
      const x1 = Math.min(x0 + BLOCK, breite);
      const y1 = Math.min(y0 + BLOCK, hoehe);

      let besteX = 0;
      let besteY = 0;
      let bestes = Infinity;
      for (let oy = -SUCHE; oy <= SUCHE; oy += 1) {
        for (let ox = -SUCHE; ox <= SUCHE; ox += 1) {
          let summe = 0;
          let proben = 0;
          for (let y = y0; y < y1; y += 2) {
            const qy = y + oy;
            if (qy < 0 || qy >= hoehe) continue;
            for (let x = x0; x < x1; x += 2) {
              const qx = x + ox;
              if (qx < 0 || qx >= breite) continue;
              summe += Math.abs(nachher.werte[y * breite + x] - vorher.werte[qy * breite + qx]);
              proben += 1;
            }
          }
          if (proben === 0) continue;
          // Auf die Probe bezogen, sonst gewinnt immer der Versatz, der am
          // weitesten aus dem Bild hinausragt und deshalb kaum Proben hat.
          const wert = summe / proben + STRAFE * (Math.abs(ox) + Math.abs(oy));
          if (wert < bestes) {
            bestes = wert;
            besteX = ox;
            besteY = oy;
          }
        }
      }
      dx[bz * spalten + bs] = besteX;
      dy[bz * spalten + bs] = besteY;
    }
  }

  return {
    spalten,
    zeilen,
    dx,
    dy,
    faktor: bildBreite / breite,
    grauBreite: breite,
    grauHoehe: hoehe,
  };
}

/**
 * Den Versatz an einer beliebigen Stelle – zwischen den Blockmitten geglättet.
 *
 * Ohne diese Glättung springt der Versatz an jeder Blockgrenze, und die
 * geschobene Maske bekommt ein Karomuster aus Treppenstufen genau dort, wo der
 * Rand verläuft. Mit ihr läuft er weich über die Mitten hinweg.
 */
function versatzAn(feld: Feld, gx: number, gy: number): [number, number] {
  const fx = Math.min(feld.spalten - 1, Math.max(0, gx / BLOCK - 0.5));
  const fy = Math.min(feld.zeilen - 1, Math.max(0, gy / BLOCK - 0.5));
  const s0 = Math.floor(fx);
  const z0 = Math.floor(fy);
  const s1 = Math.min(feld.spalten - 1, s0 + 1);
  const z1 = Math.min(feld.zeilen - 1, z0 + 1);
  const ax = fx - s0;
  const ay = fy - z0;

  const mischen = (werte: Float32Array) => {
    const oben = werte[z0 * feld.spalten + s0] * (1 - ax) + werte[z0 * feld.spalten + s1] * ax;
    const unten = werte[z1 * feld.spalten + s0] * (1 - ax) + werte[z1 * feld.spalten + s1] * ax;
    return oben * (1 - ay) + unten * ay;
  };
  return [mischen(feld.dx), mischen(feld.dy)];
}

/**
 * Die Maske um das schieben, was sich bewegt hat.
 *
 * Abgetastet wird mit den vier Nachbarn gemischt und nicht mit dem nächsten:
 * Die Maske hat weiche Ränder – `kanteWeichzeichnen` sorgt dafür –, und der
 * nächste Nachbar macht aus einem weichen Rand bei jedem Schieben einen etwas
 * härteren. Nach drei Bildern wäre er eine Treppe.
 */
export function maskeSchieben(
  alpha: Uint8Array,
  breite: number,
  hoehe: number,
  feld: Feld,
): Uint8Array {
  const raus = new Uint8Array(breite * hoehe);
  const skala = breite / feld.grauBreite;

  for (let y = 0; y < hoehe; y += 1) {
    for (let x = 0; x < breite; x += 1) {
      const [vx, vy] = versatzAn(feld, x / skala, y / skala);
      const qx = x + vx * skala;
      const qy = y + vy * skala;
      if (qx < 0 || qy < 0 || qx > breite - 1 || qy > hoehe - 1) {
        /*
         * Von ausserhalb kam nichts – also war dort auch nichts freigestellt.
         * Den Rand fortzuschreiben wäre die Alternative und die schlechtere:
         * Schwenkt die Kamera, zöge die Maske am Bildrand einen Streifen
         * hinter sich her.
         */
        raus[y * breite + x] = 0;
        continue;
      }
      const x0 = Math.floor(qx);
      const y0 = Math.floor(qy);
      const x1 = Math.min(breite - 1, x0 + 1);
      const y1 = Math.min(hoehe - 1, y0 + 1);
      const ax = qx - x0;
      const ay = qy - y0;
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
export function zeitlichGlaetten(masken: readonly Uint8Array[], fenster = 3): Uint8Array[] {
  if (masken.length === 0) return [];
  const halb = Math.floor(fenster / 2);
  if (halb < 1) return masken.map((maske) => Uint8Array.from(maske));
  const laenge = masken[0].length;

  return masken.map((_, i) => {
    const von = Math.max(0, i - halb);
    const bis = Math.min(masken.length - 1, i + halb);
    const raus = new Uint8Array(laenge);
    for (let p = 0; p < laenge; p += 1) {
      let summe = 0;
      for (let k = von; k <= bis; k += 1) summe += masken[k][p];
      raus[p] = Math.round(summe / (bis - von + 1));
    }
    return raus;
  });
}
