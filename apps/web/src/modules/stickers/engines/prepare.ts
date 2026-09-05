/**
 * Das Quellbild so aufbereiten, dass ein Modell damit rechnen kann.
 *
 * Der wichtigste Punkt hier ist die Deckelung: Ein Handyfoto mit 48 Megapixel
 * wird beim Entpacken zu rund 190 MB rohen Bilddaten. Original, Maske und
 * Ergebnis gleichzeitig im Speicher – und iOS beendet die Seite kommentarlos.
 */

/**
 * Längste Kante, mit der wir ein Modell füttern.
 *
 * Hier stand 1024, mit der Begründung, die Modelle rechneten ohnehin intern
 * mit 256 bzw. 320 Bildpunkten. Das stimmte, bevor es „Hohe Qualität“ gab –
 * dessen Netz rechnet mit 1024.
 *
 * Und dabei zählt die Deckelung die **längere** Kante: Ein Hochformatfoto
 * wurde 768×1024. Beim Füttern eines 1024er Netzes hiesse das, die kurze
 * Kante von 768 auf 1024 **hoch**zurechnen – dem Netz würden Bildpunkte
 * serviert, die es nie gab. Deshalb 1536: Damit hat auch die kurze Kante
 * eines Hochformatfotos noch mehr als 1024 echte Punkte.
 *
 * Kosten: rund 9 MB rohe Bildpunkte statt 4. Gegenüber den 190 MB, die die
 * Deckelung verhindert, ist das nichts.
 */
export const MAX_KANTE = 1536;

export interface Vorlage {
  image: ImageData;
  /** Wie stark verkleinert wurde – zum Zurückrechnen angetippter Punkte. */
  faktor: number;
}

/**
 * Zeichnet das Bild in eine Arbeitsfläche und gibt die Bildpunkte zurück.
 *
 * Wirft, wenn kein 2D-Kontext zu bekommen ist – das passiert auf Geräten mit
 * ausgeschöpftem Grafikspeicher und ist ein echter Fehler, kein Randfall.
 */
export function vorlageAus(
  image: CanvasImageSource,
  breite: number,
  hoehe: number,
  maxKante = MAX_KANTE,
): Vorlage {
  const faktor = Math.min(1, maxKante / Math.max(breite, hoehe));
  const w = Math.max(1, Math.round(breite * faktor));
  const h = Math.max(1, Math.round(hoehe * faktor));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Die Arbeitsfläche liess sich nicht anlegen.');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0, w, h);
  return { image: ctx.getImageData(0, 0, w, h), faktor };
}

/** Ein Bild als blosse Zahlen – damit sich das ohne Browser prüfen lässt. */
export interface Bildpunkte {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/**
 * Verkleinert ein Bild auf eine feste Kantenlänge – als **Flächenmittel**.
 *
 * Der naheliegende Weg wäre, für jeden Zielpunkt den nächstgelegenen
 * Quellpunkt zu nehmen. Genau das ist hier falsch: Ein Modell rechnet mit
 * 320 Bildpunkten Kantenlänge, ein Handyfoto hat 3000. Beim Herausgreifen
 * einzelner Punkte werden 99 von 100 Bildpunkten **ungesehen weggeworfen** –
 * und mit ihnen genau die dünnen Strukturen, um die es beim Freistellen geht.
 * Eine Haarsträhne, die zwischen zwei Abtastpunkte fällt, existiert für das
 * Modell dann nicht.
 *
 * Das Flächenmittel sieht jeden Quellpunkt genau einmal. Es kostet nichts
 * Nennenswertes und ist die beste Investition an dieser Stelle.
 *
 * `zielHoehe` ist neu und steht standardmässig auf `zielBreite` – für die
 * Freisteller, die alle quadratisch rechnen, ändert sich damit nichts. Das
 * Tiefenmodell dagegen darf seitenrichtig rechnen: Ein gestauchtes Bild
 * ergibt eine gestauchte Tiefe, und ein Quadrat kostet bei 4:3 ein Drittel
 * mehr Rechenzeit, ohne dass mehr Bild darin steckt.
 */
export function flaechenMittel(
  image: Bildpunkte,
  zielBreite: number,
  zielHoehe: number = zielBreite,
): Bildpunkte {
  const { width, height, data } = image;
  const out = new Uint8ClampedArray(zielBreite * zielHoehe * 4);

  for (let ty = 0; ty < zielHoehe; ty += 1) {
    const y0 = Math.floor((ty * height) / zielHoehe);
    const y1 = Math.max(y0 + 1, Math.ceil(((ty + 1) * height) / zielHoehe));
    for (let tx = 0; tx < zielBreite; tx += 1) {
      const x0 = Math.floor((tx * width) / zielBreite);
      const x1 = Math.max(x0 + 1, Math.ceil(((tx + 1) * width) / zielBreite));

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let y = y0; y < Math.min(y1, height); y += 1) {
        for (let x = x0; x < Math.min(x1, width); x += 1) {
          const at = (y * width + x) * 4;
          r += data[at];
          g += data[at + 1];
          b += data[at + 2];
          a += data[at + 3];
          n += 1;
        }
      }
      if (n === 0) n = 1;
      const zielAt = (ty * zielBreite + tx) * 4;
      out[zielAt] = r / n;
      out[zielAt + 1] = g / n;
      out[zielAt + 2] = b / n;
      out[zielAt + 3] = a / n;
    }
  }

  return { width: zielBreite, height: zielHoehe, data: out };
}

/**
 * Glättet die Maskenkante.
 *
 * Ein Modell liefert oft eine Kante, die auf einen Bildpunkt genau springt.
 * Auf einem Sticker sieht das ausgefranst aus – ein leichter Weichzeichner
 * kostet nichts und macht den Unterschied zwischen „ausgeschnitten“ und
 * „ausgerissen“.
 */
export function kanteWeichzeichnen(
  alpha: Uint8Array,
  breite: number,
  hoehe: number,
  radius = 1,
): Uint8Array {
  if (radius < 1) return alpha;
  const fenster = radius * 2 + 1;
  const waagerecht = new Uint8Array(alpha.length);
  for (let y = 0; y < hoehe; y += 1) {
    const zeile = y * breite;
    let summe = 0;
    for (let x = -radius; x <= radius; x += 1) {
      summe += alpha[zeile + Math.min(breite - 1, Math.max(0, x))];
    }
    for (let x = 0; x < breite; x += 1) {
      waagerecht[zeile + x] = summe / fenster;
      summe -= alpha[zeile + Math.max(0, x - radius)];
      summe += alpha[zeile + Math.min(breite - 1, x + radius + 1)];
    }
  }

  const ergebnis = new Uint8Array(alpha.length);
  for (let x = 0; x < breite; x += 1) {
    let summe = 0;
    for (let y = -radius; y <= radius; y += 1) {
      summe += waagerecht[Math.min(hoehe - 1, Math.max(0, y)) * breite + x];
    }
    for (let y = 0; y < hoehe; y += 1) {
      ergebnis[y * breite + x] = summe / fenster;
      summe -= waagerecht[Math.max(0, y - radius) * breite + x];
      summe += waagerecht[Math.min(hoehe - 1, y + radius + 1) * breite + x];
    }
  }
  return ergebnis;
}

/**
 * Ob die Maske überhaupt etwas übrig lässt.
 *
 * Findet ein Modell nichts, liefert es eine fast leere Maske – und der Sticker
 * wäre durchsichtig. Dann lieber eine ehrliche Meldung als ein leeres Bild.
 */
export function maskeTraegt(alpha: Uint8Array): boolean {
  let sichtbar = 0;
  for (const wert of alpha) if (wert > 32) sichtbar += 1;
  // Ein Prozent der Fläche – darunter ist nichts Erkennbares übrig.
  return sichtbar > alpha.length * 0.01;
}

/**
 * Eine quadratische Modellmaske bilinear auf die Bildgrösse ziehen.
 *
 * Der naheliegende Weg wäre, jedem Ausgabepunkt den Wert seines
 * nächstgelegenen Modellpunkts zu geben. Genau das ist hier falsch: An jeder
 * schrägen Kante entsteht dabei eine Treppe, und aus einem weichen Übergang
 * wird eine Stufe – ausgerechnet an den Stellen, für die man ein grosses Netz
 * überhaupt lädt.
 *
 * Die Referenzimplementierung von BiRefNet macht es genauso: Sigmoid, dann
 * bilinear auf die Originalgrösse, und danach nichts mehr.
 *
 * `werte` sind Wahrscheinlichkeiten in 0…1 auf einem `kante`×`kante`-Gitter;
 * heraus kommt ein Byte je Bildpunkt.
 */
export function maskeSkalieren(
  werte: Float32Array,
  kante: number,
  breite: number,
  hoehe: number,
): Uint8Array {
  const skalaX = kante / breite;
  const skalaY = kante / hoehe;

  // Die Spaltenanteile hängen nicht von der Zeile ab – einmal vorrechnen.
  const links = new Int32Array(breite);
  const rechts = new Int32Array(breite);
  const anteilX = new Float32Array(breite);
  for (let x = 0; x < breite; x += 1) {
    // Auf Punktmitten rechnen (das „+ 0.5 … − 0.5“), sonst verschiebt sich
    // die ganze Maske um einen halben Punkt gegen das Bild.
    const genau = Math.min(kante - 1, Math.max(0, (x + 0.5) * skalaX - 0.5));
    const l = Math.floor(genau);
    links[x] = l;
    rechts[x] = Math.min(kante - 1, l + 1);
    anteilX[x] = genau - l;
  }

  const alpha = new Uint8Array(breite * hoehe);
  for (let y = 0; y < hoehe; y += 1) {
    const genau = Math.min(kante - 1, Math.max(0, (y + 0.5) * skalaY - 0.5));
    const oben = Math.floor(genau);
    const unten = Math.min(kante - 1, oben + 1);
    const ay = genau - oben;
    const zeileOben = oben * kante;
    const zeileUnten = unten * kante;
    const ziel = y * breite;

    for (let x = 0; x < breite; x += 1) {
      const l = links[x];
      const r = rechts[x];
      const ax = anteilX[x];
      const o = werte[zeileOben + l] + (werte[zeileOben + r] - werte[zeileOben + l]) * ax;
      const u = werte[zeileUnten + l] + (werte[zeileUnten + r] - werte[zeileUnten + l]) * ax;
      const wert = o + (u - o) * ay;
      alpha[ziel + x] = Math.max(0, Math.min(255, Math.round(wert * 255)));
    }
  }
  return alpha;
}

/** Ein auf 512 gebrachtes Bild samt der Masse, mit denen es entstanden ist. */
export interface Briefkasten {
  /** [1,3,kante,kante], Kanäle nacheinander, Werte 0…255. */
  tensor: Float32Array;
  /** Belegte Fläche in der Leinwand – der Rest ist Null. */
  breite: number;
  hoehe: number;
}

/**
 * Ein Bild oben links in eine quadratische Leinwand legen – **ohne** es zu
 * verzerren.
 *
 * Das ist der Unterschied zu `flaechenMittel`: Das quetscht auf ein Quadrat,
 * was für U²-Net und BiRefNet richtig ist, weil die so trainiert wurden. SAM
 * dagegen erwartet ein Bild, dessen **längere Kante** auf die Kantenlänge
 * gebracht wurde, oben links eingesetzt, Rest null. Wer hier `flaechenMittel`
 * nimmt, bekommt keine Fehlermeldung, sondern eine Maske, die um genau das
 * Seitenverhältnis danebenliegt – und hält dann das Netz für schlecht.
 *
 * Belegt wird nur `breite × hoehe`; die Werte werden gebraucht, um die
 * Antwort später wieder richtig zu beschneiden.
 */
export function briefkasten(image: Bildpunkte, kante: number): Briefkasten {
  const { width, height, data } = image;
  const faktor = kante / Math.max(width, height);
  const nw = Math.round(width * faktor);
  const nh = Math.round(height * faktor);

  const flaeche = kante * kante;
  const tensor = new Float32Array(3 * flaeche);

  // Bilinear, wie die Referenzimplementierung. Nächster Nachbar würde bei
  // einem Handyfoto vier Fünftel der Bildpunkte ungesehen wegwerfen.
  for (let y = 0; y < nh; y += 1) {
    const sy = Math.min(height - 1, Math.max(0, (y + 0.5) / faktor - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(height - 1, y0 + 1);
    const ay = sy - y0;

    for (let x = 0; x < nw; x += 1) {
      const sx = Math.min(width - 1, Math.max(0, (x + 0.5) / faktor - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(width - 1, x0 + 1);
      const ax = sx - x0;

      const a = (y0 * width + x0) * 4;
      const b = (y0 * width + x1) * 4;
      const c = (y1 * width + x0) * 4;
      const d = (y1 * width + x1) * 4;
      const ziel = y * kante + x;

      for (let k = 0; k < 3; k += 1) {
        const oben = data[a + k] + (data[b + k] - data[a + k]) * ax;
        const unten = data[c + k] + (data[d + k] - data[c + k]) * ax;
        tensor[k * flaeche + ziel] = oben + (unten - oben) * ay;
      }
    }
  }

  return { tensor, breite: nw, hoehe: nh };
}
