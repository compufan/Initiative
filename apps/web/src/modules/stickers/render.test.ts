import { describe, expect, it } from 'vitest';
import {
  dilateAlpha,
  texteMitbewegen,
  STICKER_SIZE,
  cloneDoc,
  createDoc,
  isEmptyDoc,
  flutmaske,
  formPfad,
  abziehenAlpha,
  freistellMaske,
  keepAtSeeds,
  MAX_SCALE,
  MIN_SCALE,
  lupeGrenzen,
  motivFuellen,
  normGrad,
  rasten,
  sourceRect,
  zurFlaeche,
  trifftText,
  textMass,
  zweiFingerZug,
  removeBackground,
  saatAufFlaeche,
  strichBloecke,
  toSourcePoint,
  vereinigeAlpha,
} from './render.js';
import type { StickerText, Stroke } from './render.js';

/** Minimal stand-in for `ImageData` – the pure pipeline never touches the DOM. */
function makeImage(
  size: number,
  paint: (x: number, y: number) => [number, number, number, number],
): ImageData {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = paint(x, y);
      const at = (y * size + x) * 4;
      data[at] = r;
      data[at + 1] = g;
      data[at + 2] = b;
      data[at + 3] = a;
    }
  }
  return { width: size, height: size, data, colorSpace: 'srgb' } as unknown as ImageData;
}

const alphaAt = (image: ImageData, size: number, x: number, y: number) =>
  image.data[(y * size + x) * 4 + 3];

describe('removeBackground', () => {
  it('clears the corner colour and keeps the subject', () => {
    const size = 32;
    const image = makeImage(size, (x, y) =>
      x >= 10 && x < 22 && y >= 10 && y < 22 ? [220, 20, 20, 255] : [10, 200, 10, 255],
    );

    removeBackground(image, 30);

    expect(alphaAt(image, size, 0, 0)).toBe(0);
    expect(alphaAt(image, size, size - 1, size - 1)).toBe(0);
    expect(alphaAt(image, size, 16, 16)).toBe(255);
  });

  it('keeps background coloured areas that are enclosed by the subject', () => {
    const size = 32;
    const image = makeImage(size, (x, y) => {
      const ring = x >= 6 && x < 26 && y >= 6 && y < 26;
      const hole = x >= 12 && x < 20 && y >= 12 && y < 20;
      if (!ring || hole) return [10, 200, 10, 255];
      return [220, 20, 20, 255];
    });

    removeBackground(image, 30);

    expect(alphaAt(image, size, 16, 16)).toBe(255);
    expect(alphaAt(image, size, 0, 0)).toBe(0);
  });

  it('leaves a fully transparent image untouched', () => {
    const image = makeImage(4, () => [0, 0, 0, 0]);
    removeBackground(image, 40);
    expect([...image.data].every((value) => value === 0)).toBe(true);
  });
});

describe('document helpers', () => {
  it('clones strokes and text layers instead of sharing them', () => {
    const doc = createDoc();
    doc.texte.push({
      id: 't1',
      value: 'Hallo',
      x: 0.5,
      y: 0.5,
      size: 68,
      color: '#fff',
      outline: true,
      drehung: 0,
    });
    const copy = cloneDoc(doc);
    copy.strokes.push({ size: 10, points: [1, 2], mode: 'weg' });
    copy.texte[0].value = 'Anders';
    copy.texte.push({ ...copy.texte[0], id: 't2' });

    expect(doc.strokes).toHaveLength(0);
    // Die Schriftzüge müssen EINZELN kopiert sein, nicht nur die Liste:
    // sonst schreibt ein Rückgängig-Schritt in den aktuellen Stand zurück.
    expect(doc.texte).toHaveLength(1);
    expect(doc.texte[0].value).toBe('Hallo');
  });

  it('knows when there is nothing to export yet', () => {
    const doc = createDoc();
    expect(isEmptyDoc(null, doc)).toBe(true);
    expect(isEmptyDoc({ kind: 'text' }, doc)).toBe(true);
    expect(isEmptyDoc({ kind: 'emoji', emoji: '🐱' }, doc)).toBe(false);
    expect(
      isEmptyDoc(null, {
        ...doc,
        texte: [
          {
            id: 't1',
            value: 'Moin',
            x: 0.5,
            y: 0.5,
            size: 68,
            color: '#fff',
            outline: true,
            drehung: 0,
          },
        ],
      }),
    ).toBe(false);
  });
});

describe('keepAtSeeds', () => {
  /** Roter Kreis auf blauem Grund – wie ein Motiv vor einem Hintergrund. */
  const motif = () =>
    makeImage(40, (x, y) => {
      const inside = (x - 20) ** 2 + (y - 20) ** 2 < 100;
      return inside ? [220, 40, 40, 255] : [40, 60, 220, 255];
    });

  const alphaAt = (image: ImageData, x: number, y: number) =>
    image.data[(y * image.width + x) * 4 + 3];

  it('behaelt das angetippte Motiv und entfernt den Rest', () => {
    const image = motif();
    keepAtSeeds(image, [{ x: 20, y: 20 }], 40);

    expect(alphaAt(image, 20, 20)).toBeGreaterThan(200); // Mitte des Motivs
    expect(alphaAt(image, 1, 1)).toBe(0); // Ecke im Hintergrund
    expect(alphaAt(image, 39, 39)).toBe(0);
  });

  it('setzt mehrere Antipper zusammen', () => {
    // Zwei getrennte Farbfelder nebeneinander.
    const image = makeImage(40, (x) => (x < 20 ? [10, 200, 10, 255] : [200, 200, 10, 255]));

    keepAtSeeds(image, [{ x: 5, y: 20 }], 30);
    expect(alphaAt(image, 5, 20)).toBeGreaterThan(200);
    expect(alphaAt(image, 35, 20)).toBe(0); // zweites Feld noch nicht angetippt

    const both = makeImage(40, (x) => (x < 20 ? [10, 200, 10, 255] : [200, 200, 10, 255]));
    keepAtSeeds(
      both,
      [
        { x: 5, y: 20 },
        { x: 35, y: 20 },
      ],
      30,
    );
    expect(alphaAt(both, 5, 20)).toBeGreaterThan(200);
    expect(alphaAt(both, 35, 20)).toBeGreaterThan(200);
  });

  it('laesst das Bild unveraendert, wenn nichts angetippt wurde', () => {
    const image = motif();
    keepAtSeeds(image, [], 40);
    expect(alphaAt(image, 1, 1)).toBe(255);
  });
});

describe('Pinselstriche', () => {
  const strich = (mode: Stroke['mode'], size = 10): Stroke => ({ size, points: [0, 0], mode });

  it('fasst zusammen, was hintereinander in dieselbe Richtung geht', () => {
    const bloecke = strichBloecke([strich('weg'), strich('weg'), strich('zurueck')]);
    expect(bloecke.map((block) => block.length)).toEqual([2, 1]);
    expect(bloecke.map((block) => block[0].mode)).toEqual(['weg', 'zurueck']);
  });

  it('lässt den letzten Strich gewinnen, wenn sich die Richtung abwechselt', () => {
    // Radiert, zurückgeholt, wieder radiert: drei Blöcke, in dieser Reihenfolge.
    // Würde man nach Richtung sortieren, bliebe am Ende das Zurückgeholte
    // stehen – also das Gegenteil dessen, was zuletzt gemacht wurde.
    const bloecke = strichBloecke([strich('weg'), strich('zurueck'), strich('weg')]);
    expect(bloecke).toHaveLength(3);
    expect(bloecke.map((block) => block[0].mode)).toEqual(['weg', 'zurueck', 'weg']);
  });

  it('kommt mit gar keinem Strich zurecht', () => {
    expect(strichBloecke([])).toEqual([]);
  });
});

describe('Lupe', () => {
  const mitte = STICKER_SIZE / 2;

  it('lässt sich nicht unter 1× oder über das Maximum drehen', () => {
    expect(lupeGrenzen({ zoom: 0.2, x: mitte, y: mitte }, 8).zoom).toBe(1);
    expect(lupeGrenzen({ zoom: 99, x: mitte, y: mitte }, 8).zoom).toBe(8);
  });

  it('hält den Ausschnitt im Bild, statt daneben zu geraten', () => {
    const links = lupeGrenzen({ zoom: 4, x: -500, y: -500 }, 8);
    // Bei 4× ist der sichtbare Ausschnitt ein Viertel breit; sein Mittelpunkt
    // kann also höchstens ein Achtel vom Rand entfernt stehen.
    expect(links.x).toBe(STICKER_SIZE / 8);
    expect(links.y).toBe(STICKER_SIZE / 8);

    const rechts = lupeGrenzen({ zoom: 4, x: 9999, y: 9999 }, 8);
    expect(rechts.x).toBe(STICKER_SIZE - STICKER_SIZE / 8);
  });

  it('gibt bei 1× die ganze Fläche frei – der Mittelpunkt ist dann die Mitte', () => {
    const ganz = lupeGrenzen({ zoom: 1, x: 0, y: STICKER_SIZE }, 8);
    expect(ganz).toEqual({ zoom: 1, x: mitte, y: mitte });
  });
});

/**
 * Der Fall, den der Anwender beschrieben hat: „Wenn eine Person neben einer
 * Säule steht und die Person freigestellt wurde (die Säule als weg radiert
 * wurde) sollte man mit Antippen die Säule antippen können und diese wird
 * zusätzlich freigestellt.“
 *
 * Vorher tat die App das Gegenteil, und zwar aus zwei Gründen zugleich: Die
 * Farbflutung lief auf dem BEREITS beschnittenen Bild – die Säule war dort
 * schon durchsichtig, und die Flutung bricht an durchsichtigen Punkten ab –
 * und sie multiplizierte am Ende alles Ungeflutete weg, also auch die Person.
 * Ein Tipp neben dem Motiv leerte den Sticker.
 */
describe('Antippen nimmt hinzu, statt zu überschreiben', () => {
  const B = 60;
  const H = 40;
  // Person links, Säule rechts, beide vor einem einheitlichen Grund.
  const person = (x: number, y: number) => x >= 5 && x < 20 && y >= 5 && y < 35;
  const saeule = (x: number, y: number) => x >= 35 && x < 50 && y >= 5 && y < 35;

  function vorlage(): ImageData {
    const data = new Uint8ClampedArray(B * H * 4);
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < B; x += 1) {
        const at = (y * B + x) * 4;
        const [r, g, b] = person(x, y)
          ? [220, 40, 40]
          : saeule(x, y)
            ? [40, 40, 220]
            : [20, 200, 20];
        data[at] = r;
        data[at + 1] = g;
        data[at + 2] = b;
        data[at + 3] = 255;
      }
    }
    return { width: B, height: H, data, colorSpace: 'srgb' } as unknown as ImageData;
  }

  /** Die Modellmaske: genau die Person, sonst nichts. */
  function modellmaske(): Uint8Array {
    const a = new Uint8Array(B * H);
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < B; x += 1) a[y * B + x] = person(x, y) ? 255 : 0;
    }
    return a;
  }

  const zaehle = (maske: Uint8Array, drin: (x: number, y: number) => boolean) => {
    let n = 0;
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < B; x += 1) if (drin(x, y) && maske[y * B + x] > 128) n += 1;
    }
    return n;
  };
  const flaeche = 15 * 30;

  it('behält die Person UND nimmt die angetippte Säule dazu', () => {
    const modell = modellmaske();
    // Die Flutung läuft auf dem UNBESCHNITTENEN Bild – das ist die halbe
    // Lösung. Auf dem beschnittenen wäre hier nichts mehr anzutippen.
    const flutung = flutmaske(vorlage(), [{ x: 42, y: 20 }], 40);
    const maske = freistellMaske([modell, flutung], []);

    expect(maske).not.toBeNull();
    expect(zaehle(maske!, person)).toBe(flaeche);
    expect(zaehle(maske!, saeule)).toBe(flaeche);
  });

  it('lässt den Grund weiterhin weg', () => {
    const maske = freistellMaske([modellmaske(), flutmaske(vorlage(), [{ x: 42, y: 20 }], 40)], []);
    // Mitten im Grund, weit weg von beiden Kanten – der weiche Saum aus
    // dilateAlpha/blurAlpha trägt ein paar Punkte über die Rechtecke hinaus,
    // deshalb wird ausdrücklich in der Mitte gemessen und nicht am Rand.
    expect(maske![20 * B + 28]).toBe(0);
    expect(maske![2 * B + 2]).toBe(0);
  });

  it('so lief es vorher: die Flutung auf dem beschnittenen Bild löscht beides', () => {
    // Die Gegenprobe zur alten Reihenfolge. Sie ist der eigentliche Beleg,
    // dass hier ein Fehler behoben wurde und nicht bloss etwas umgebaut.
    const bild = vorlage();
    const modell = modellmaske();
    for (let i = 0; i < modell.length; i += 1) {
      bild.data[i * 4 + 3] = modell[i];
    }
    keepAtSeeds(bild, [{ x: 42, y: 20 }], 40);

    let sichtbar = 0;
    for (let i = 0; i < modell.length; i += 1) if (bild.data[i * 4 + 3] > 128) sichtbar += 1;
    expect(sichtbar).toBe(0);
  });

  it('ohne Tipp bleibt es beim Modell, ohne Modell beim Tipp', () => {
    const nurModell = freistellMaske([modellmaske()], []);
    expect(zaehle(nurModell!, person)).toBe(flaeche);
    expect(zaehle(nurModell!, saeule)).toBe(0);

    const nurTipp = freistellMaske([flutmaske(vorlage(), [{ x: 42, y: 20 }], 40)], []);
    expect(zaehle(nurTipp!, saeule)).toBe(flaeche);
    expect(zaehle(nurTipp!, person)).toBe(0);
  });

  it('ohne alles gibt es nichts zu beschneiden', () => {
    // Wichtig: `null` heisst „gibt es nicht“, nicht „überall 0“. Sonst wäre
    // ein Sticker ohne Freistellen leer.
    expect(freistellMaske([null, null], [])).toBeNull();
  });

  it('die Vereinigung kann nie kleiner werden als ihre Teile', () => {
    // Das ist die Zusage „Antippen überschreibt das Freigestellte nicht“,
    // als Eigenschaft der Formel statt als Absichtserklärung.
    const a = new Uint8Array([0, 40, 128, 200, 255, 255]);
    const b = new Uint8Array([0, 200, 30, 10, 0, 255]);
    const v = vereinigeAlpha(a, b);
    for (let i = 0; i < a.length; i += 1) {
      expect(v[i]).toBeGreaterThanOrEqual(a[i]);
      expect(v[i]).toBeGreaterThanOrEqual(b[i]);
      expect(v[i]).toBeLessThanOrEqual(255);
    }
  });
});

/**
 * „Das Wegnehmen bei Antippen funktioniert noch nicht. Auch das sollte
 * zusammen mit einer Freistellen-Auswahl funktionieren — wenn das Bild
 * bereits freigestellt ist, sollte man einzelne Elemente des Freigestellten
 * wieder ausblenden können.“
 *
 * Vorher wurde auch ein Minus-Tipp VEREINIGT, und eine Vereinigung kann nie
 * kleiner werden: Der Tipp war wirkungslos. Und gegen ein Modellergebnis
 * konnte er von vornherein nichts ausrichten.
 */
describe('Wegnehmen', () => {
  const N = 40;
  const links = (i: number) => i % N < 20;

  /** Zwei Hälften, damit sich Hinzunehmen und Wegnehmen trennen lassen. */
  function haelfte(linkeSeite: boolean): Uint8Array {
    const a = new Uint8Array(N * N);
    for (let i = 0; i < a.length; i += 1) a[i] = links(i) === linkeSeite ? 255 : 0;
    return a;
  }

  it('nimmt aus dem Ergebnis eines MODELLS etwas heraus', () => {
    // Das Modell hat alles gefunden, ein Minus-Tipp nimmt die rechte Hälfte
    // wieder heraus. Genau der Fall, den der Anwender beschrieben hat.
    const modell = new Uint8Array(N * N).fill(255);
    const maske = freistellMaske([modell], [haelfte(false)]);

    expect(maske![0]).toBe(255); // links bleibt
    expect(maske![25]).toBe(0); // rechts ist weg
  });

  it('war vorher wirkungslos: vereinigt statt abgezogen', () => {
    // Die Gegenprobe. So lief es, und deshalb tat der Knopf nichts.
    const modell = new Uint8Array(N * N).fill(255);
    const falsch = vereinigeAlpha(modell, haelfte(false));
    expect(falsch[25]).toBe(255);
  });

  it('ohne alles Positive heisst ein Minus-Tipp „alles ausser dem“', () => {
    // Wer auf einem unbeschnittenen Bild sagt „das da weg“, meint genau das.
    const maske = freistellMaske([], [haelfte(false)]);
    expect(maske![0]).toBe(255);
    expect(maske![25]).toBe(0);
  });

  it('wirkt auch gegen einen Plus-Tipp, nicht nur gegen das Modell', () => {
    const maske = freistellMaske([haelfte(true), haelfte(false)], [haelfte(false)]);
    expect(maske![0]).toBe(255);
    expect(maske![25]).toBe(0);
  });

  it('abziehenAlpha bleibt im Bereich und wird nie grösser', () => {
    const a = new Uint8Array([0, 40, 128, 200, 255]);
    const b = new Uint8Array([0, 200, 30, 255, 128]);
    const v = abziehenAlpha(a, b);
    for (let i = 0; i < a.length; i += 1) {
      expect(v[i]).toBeLessThanOrEqual(a[i]);
      expect(v[i]).toBeGreaterThanOrEqual(0);
    }
  });

  it('weiche Kanten bleiben weich', () => {
    // Ein halb deckender Punkt, halb weggenommen: das Ergebnis muss dazwischen
    // liegen und darf nicht auf 0 oder 255 springen.
    const v = abziehenAlpha(new Uint8Array([128]), new Uint8Array([128]));
    expect(v[0]).toBeGreaterThan(50);
    expect(v[0]).toBeLessThan(80);
  });
});

/**
 * Der Tipp muss dort ankommen, wo hingetippt wurde.
 *
 * Die Tipp-Punkte liegen im QUELLBILD – nur so überstehen sie Verschieben und
 * Zoomen, genau wie die Masken der Modelle. Die Farbflutung rechnet aber auf
 * der 512er Sticker-Fläche. Wer die Umrechnung dazwischen vergisst, bekommt
 * keinen Fehler, sondern einen leeren Sticker: `flutmaske` überspringt Saat
 * ausserhalb des Bildes, und die Zeichenkette multipliziert dann alles mit 0.
 *
 * Genau das ist passiert, und es traf ausgerechnet das einzige Verfahren, das
 * ohne einen einzigen Megabyte Download auskommt.
 */
describe('Saatpunkte zwischen Quellbild und Fläche', () => {
  const doc = { scale: 1, offsetX: 0, offsetY: 0, drehung: 0 };

  it('bringt einen Tipp aus einem Handyfoto zurück auf die Fläche', () => {
    // Hochkant, wie es aus einer Telefonkamera kommt.
    const quelle = { width: 3024, height: 4032 };
    // Der Anwender hat die Mitte getroffen; abgelegt wird das im Quellbild.
    const imBild = toSourcePoint({ x: 256, y: 256 }, quelle, doc);
    expect(Math.round(imBild.x)).toBe(1512);

    const [zurueck] = saatAufFlaeche([{ ...imBild }], quelle, doc);
    expect(Math.round(zurueck.x)).toBe(256);
    expect(Math.round(zurueck.y)).toBe(256);
  });

  it('bleibt auch bei Zoom und Verschiebung genau', () => {
    const quelle = { width: 1200, height: 800 };
    const verschoben = { scale: 2.4, offsetX: -70, offsetY: 35, drehung: 0 };
    for (const punkt of [
      { x: 10, y: 10 },
      { x: 256, y: 256 },
      { x: 500, y: 300 },
    ]) {
      const imBild = toSourcePoint(punkt, quelle, verschoben);
      const [zurueck] = saatAufFlaeche([imBild], quelle, verschoben);
      expect(zurueck.x).toBeCloseTo(punkt.x, 6);
      expect(zurueck.y).toBeCloseTo(punkt.y, 6);
    }
  });

  it('reicht Vorzeichen und Gruppe unverändert durch', () => {
    // Sonst verlöre die Flutung beim Umrechnen, ob ein Tipp dazu- oder
    // wegnimmt – und das Wegnehmen wäre wieder wirkungslos.
    const quelle = { width: 800, height: 600 };
    const [raus] = saatAufFlaeche(
      [{ x: 400, y: 300, mode: 'weg' as const, gruppe: 7, quelle: 'flutung' as const }],
      quelle,
      doc,
    );
    expect(raus.mode).toBe('weg');
    expect(raus.gruppe).toBe(7);
  });

  it('lässt einen hinausgeschobenen Tipp fallen, statt den Sticker zu leeren', () => {
    /*
     * Die Falle eine Handbewegung später: Wer sein Bild so weit verschiebt,
     * dass ein alter Tipp die Fläche verlässt, bekäme sonst wieder einen
     * schwarzen Sticker – eine leere Flutmaske heisst in der Vereinigung
     * nicht „trägt nichts bei“, sondern „behalte nichts“.
     */
    const quelle = { width: 800, height: 600 };
    const mitte = toSourcePoint({ x: 256, y: 256 }, quelle, doc);
    // Weit genug zur Seite geschoben, dass der Punkt hinausfällt.
    const weit = { scale: 1, offsetX: -900, offsetY: 0, drehung: 0 };

    expect(saatAufFlaeche([mitte], quelle, weit)).toHaveLength(0);
    // Und ohne Saat gibt es nichts zu beschneiden – statt einer Nullmaske.
    expect(freistellMaske([], [])).toBeNull();
  });

  it('so war es kaputt: die rohe Quellkoordinate liegt neben der Fläche', () => {
    // Die Gegenprobe. 1512 ist weit ausserhalb von 0…511, die Saat wurde
    // verworfen, und der Sticker blieb leer.
    const quelle = { width: 3024, height: 4032 };
    const imBild = toSourcePoint({ x: 256, y: 256 }, quelle, doc);
    expect(imBild.x).toBeGreaterThan(STICKER_SIZE);
    expect(
      flutmaske(
        makeImage(64, () => [10, 10, 10, 255]),
        [imBild],
        40,
      ).some((v) => v > 0),
    ).toBe(false);
  });
});

/**
 * „Motiv füllen“: der Handgriff, den jede Sticker-App hat.
 *
 * Nach dem Freistellen sitzt das Motiv irgendwo im Bild, oft klein und aus
 * der Mitte. Von Hand passend zu schieben dauert länger als das Freistellen.
 */
describe('motivFuellen', () => {
  const B = 100;
  const H = 100;

  /** Eine Maske mit einem Rechteck an frei wählbarer Stelle. */
  function maske(x0: number, y0: number, x1: number, y1: number): Uint8Array {
    const a = new Uint8Array(B * H);
    for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) a[y * B + x] = 255;
    return a;
  }

  /** Wohin ein Quellpunkt auf der Fläche landet – die Rechnung aus sourceRect. */
  function aufFlaeche(p: { x: number; y: number }, q: { width: number; height: number }, d: any) {
    const cover = Math.max(STICKER_SIZE / q.width, STICKER_SIZE / q.height);
    const g = cover * d.scale;
    return {
      x: (STICKER_SIZE - q.width * g) / 2 + d.offsetX + p.x * g,
      y: (STICKER_SIZE - q.height * g) / 2 + d.offsetY + p.y * g,
    };
  }

  it('rückt die Mitte des Motivs in die Mitte der Fläche', () => {
    const quelle = { width: 400, height: 400 };
    // Ein kleines Motiv oben links, Mitte bei (20,20) von 100 -> (80,80) im Bild.
    const passend = motivFuellen(maske(10, 10, 30, 30), B, H, quelle);
    expect(passend).not.toBeNull();

    const mitte = aufFlaeche({ x: 80, y: 80 }, quelle, passend!);
    expect(mitte.x).toBeCloseTo(STICKER_SIZE / 2, 4);
    expect(mitte.y).toBeCloseTo(STICKER_SIZE / 2, 4);
  });

  it('lässt Luft am Rand, statt das Motiv anzuschneiden', () => {
    const quelle = { width: 400, height: 400 };
    const passend = motivFuellen(maske(10, 10, 30, 30), B, H, quelle)!;
    // Die Ecken des Motivs (40,40) und (120,120) im Bild müssen drin liegen.
    const oben = aufFlaeche({ x: 40, y: 40 }, quelle, passend);
    const unten = aufFlaeche({ x: 120, y: 120 }, quelle, passend);
    expect(oben.x).toBeGreaterThan(0);
    expect(unten.x).toBeLessThan(STICKER_SIZE);
    // Aber nicht zuviel Luft: mindestens 80 % der Fläche soll gefüllt sein.
    expect(unten.x - oben.x).toBeGreaterThan(STICKER_SIZE * 0.8);
  });

  it('hält die Zoomgrenzen ein', () => {
    // Ein winziges Motiv würde rechnerisch einen riesigen Zoom verlangen.
    const passend = motivFuellen(maske(50, 50, 51, 51), B, H, { width: 4000, height: 4000 })!;
    expect(passend.scale).toBeLessThanOrEqual(MAX_SCALE);
    expect(passend.scale).toBeGreaterThanOrEqual(MIN_SCALE);
  });

  it('gibt nichts zurück, wenn die Maske leer ist', () => {
    expect(motivFuellen(new Uint8Array(B * H), B, H, { width: 400, height: 400 })).toBeNull();
  });
});

/*
 * Drehung – Stufe 2.
 *
 * Der Punkt der ganzen Umstellung ist, dass es nur EINE Abbildung zwischen
 * Quellbild und Fläche gibt (`quellLage`). Diese Prüfungen halten sie gegen
 * die alte, drehungsfreie Rechnung und gegen sich selbst.
 */
describe('quellLage und die Drehung', () => {
  const quelle = { width: 1200, height: 800 };
  const grund = { scale: 1.4, offsetX: 30, offsetY: -20 };

  it('fällt ohne Drehung mit sourceRect zusammen', () => {
    const doc = { ...grund, drehung: 0 };
    const rect = sourceRect(quelle, doc);
    // Die linke obere Ecke des Bildes ist der Quellpunkt (0, 0).
    const ecke = zurFlaeche({ x: 0, y: 0 }, quelle, doc);
    expect(ecke.x).toBeCloseTo(rect.x, 9);
    expect(ecke.y).toBeCloseTo(rect.y, 9);
    // Und die rechte untere die Ecke plus Breite und Höhe.
    const unten = zurFlaeche({ x: quelle.width, y: quelle.height }, quelle, doc);
    expect(unten.x).toBeCloseTo(rect.x + rect.width, 9);
    expect(unten.y).toBeCloseTo(rect.y + rect.height, 9);
  });

  it('ist auch gedreht in beide Richtungen umkehrbar', () => {
    for (const drehung of [-180, -37, 0, 3, 90, 174]) {
      const doc = { ...grund, drehung };
      for (const punkt of [
        { x: 0, y: 0 },
        { x: 256, y: 256 },
        { x: 511, y: 40 },
      ]) {
        const imBild = toSourcePoint(punkt, quelle, doc);
        const zurueck = zurFlaeche(imBild, quelle, doc);
        expect(zurueck.x).toBeCloseTo(punkt.x, 6);
        expect(zurueck.y).toBeCloseTo(punkt.y, 6);
      }
    }
  });

  it('lässt die Bildmitte an ihrem Platz – die Drehung ist um sie herum', () => {
    const bildMitte = { x: quelle.width / 2, y: quelle.height / 2 };
    const ohne = zurFlaeche(bildMitte, quelle, { ...grund, drehung: 0 });
    for (const drehung of [17, 90, -145]) {
      const mit = zurFlaeche(bildMitte, quelle, { ...grund, drehung });
      expect(mit.x).toBeCloseTo(ohne.x, 9);
      expect(mit.y).toBeCloseTo(ohne.y, 9);
    }
  });

  it('dreht im Uhrzeigersinn, so wie die Leinwand es tut', () => {
    // 90° im Uhrzeigersinn: Was rechts der Bildmitte lag, liegt danach
    // darunter. (Die y-Achse zeigt auf einer Leinwand nach unten.)
    const doc = { scale: 1, offsetX: 0, offsetY: 0, drehung: 90 };
    const rechts = { x: quelle.width / 2 + 100, y: quelle.height / 2 };
    const auf = zurFlaeche(rechts, quelle, doc);
    expect(auf.x).toBeCloseTo(STICKER_SIZE / 2, 6);
    expect(auf.y).toBeGreaterThan(STICKER_SIZE / 2 + 10);
  });
});

describe('normGrad und rasten', () => {
  it('bringt Winkel auf (−180, 180]', () => {
    expect(normGrad(450)).toBe(90);
    expect(normGrad(-270)).toBe(90);
    expect(normGrad(180)).toBe(180);
    expect(normGrad(-180)).toBe(180);
    expect(normGrad(0)).toBe(0);
  });

  it('rastet nahe an einer Vierteldrehung ein, sonst nicht', () => {
    expect(rasten(89)).toBe(90);
    expect(rasten(-2)).toBe(0);
    expect(rasten(1.5)).toBe(0);
    expect(rasten(45)).toBe(45);
    expect(rasten(84)).toBe(84);
  });

  it('rastet auch das Ergebnis von 3 × 90° sauber ein', () => {
    expect(rasten(normGrad(270))).toBe(-90);
  });
});

describe('zweiFingerZug', () => {
  const start = {
    mitte: { x: 150, y: 380 },
    offsetX: 12,
    offsetY: -8,
    scale: 1.3,
    drehung: 10,
  };

  /** Wo ein Quellpunkt landet – die Rechnung aus `quellLage`, nachgebaut. */
  function auf(
    p: { x: number; y: number },
    doc: { scale: number; offsetX: number; offsetY: number; drehung: number },
    quelle: { width: number; height: number },
  ) {
    return zurFlaeche(p, quelle, doc);
  }

  it('hält den Punkt unter der Fingermitte fest – beim Zoomen wie beim Drehen', () => {
    const quelle = { width: 900, height: 1200 };
    const vorher = { ...start, drehung: start.drehung };
    // Welcher Bildpunkt liegt beim Aufsetzen unter der Fingermitte?
    const unterDenFingern = toSourcePoint(start.mitte, quelle, vorher);

    for (const [verhaeltnis, deltaGrad] of [
      [1, 0],
      [1.8, 0],
      [1, 35],
      [0.6, -70],
    ] as const) {
      const nachher = zweiFingerZug(start, {
        mitte: start.mitte,
        verhaeltnis,
        deltaGrad,
      });
      const jetzt = auf(unterDenFingern, nachher, quelle);
      expect(jetzt.x).toBeCloseTo(start.mitte.x, 4);
      expect(jetzt.y).toBeCloseTo(start.mitte.y, 4);
    }
  });

  it('folgt der Fingermitte, wenn sie wandert', () => {
    const quelle = { width: 900, height: 1200 };
    const unterDenFingern = toSourcePoint(start.mitte, quelle, start);
    const nachher = zweiFingerZug(start, {
      mitte: { x: 300, y: 200 },
      verhaeltnis: 1.4,
      deltaGrad: 22,
    });
    const jetzt = auf(unterDenFingern, nachher, quelle);
    expect(jetzt.x).toBeCloseTo(300, 4);
    expect(jetzt.y).toBeCloseTo(200, 4);
  });

  it('lässt den Versatz am Zoom-Anschlag stehen, statt weiterzuwandern', () => {
    // Mit dem gewünschten statt dem erreichten Verhältnis rutschte das Motiv
    // am Anschlag unter den Fingern weg.
    const quelle = { width: 900, height: 1200 };
    const amAnschlag = zweiFingerZug(start, {
      mitte: start.mitte,
      verhaeltnis: 100,
      deltaGrad: 0,
    });
    expect(amAnschlag.scale).toBe(MAX_SCALE);
    const unterDenFingern = toSourcePoint(start.mitte, quelle, amAnschlag);
    const jetzt = auf(unterDenFingern, amAnschlag, quelle);
    expect(jetzt.x).toBeCloseTo(start.mitte.x, 4);
    expect(jetzt.y).toBeCloseTo(start.mitte.y, 4);
  });

  it('summiert die Drehung und hält sie im Bereich', () => {
    expect(
      zweiFingerZug(
        { ...start, drehung: 170 },
        { mitte: start.mitte, verhaeltnis: 1, deltaGrad: 30 },
      ).drehung,
    ).toBe(-160);
  });
});

describe('motivFuellen mit Drehung', () => {
  const B = 100;
  const H = 100;
  function maske(x0: number, y0: number, x1: number, y1: number): Uint8Array {
    const alpha = new Uint8Array(B * H);
    for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) alpha[y * B + x] = 255;
    return alpha;
  }

  it('zoomt bei 45° weniger heran – das gedrehte Rechteck braucht mehr Platz', () => {
    const quelle = { width: 400, height: 400 };
    const gerade = motivFuellen(maske(20, 20, 60, 60), B, H, quelle)!;
    const schraeg = motivFuellen(maske(20, 20, 60, 60), B, H, quelle, 0.08, 45)!;
    expect(schraeg.scale).toBeLessThan(gerade.scale);
    // Ein Quadrat um 45° gedreht ist rund 1,41-mal so breit.
    expect(gerade.scale / schraeg.scale).toBeCloseTo(Math.SQRT2, 2);
  });

  it('setzt die Motivmitte auch gedreht in die Mitte der Fläche', () => {
    const quelle = { width: 400, height: 400 };
    for (const drehung of [0, 30, 90, -120]) {
      const passend = motivFuellen(maske(10, 10, 30, 30), B, H, quelle, 0.08, drehung)!;
      const doc = { ...passend, drehung };
      // Die Mitte der Maske in Quellpunkten – die Maske ist 100 Punkte breit,
      // das Bild 400, also mal vier.
      const mitte = { x: ((10 + 31) / 2) * 4, y: ((10 + 31) / 2) * 4 };
      const auf = zurFlaeche(mitte, quelle, doc);
      expect(auf.x).toBeCloseTo(STICKER_SIZE / 2, 4);
      expect(auf.y).toBeCloseTo(STICKER_SIZE / 2, 4);
    }
  });
});

/*
 * Die Formen – Stufe 2.
 *
 * Der eine Fehler, den man hier machen kann und der in keiner Rechnung
 * auffällt: zwei Teilpfade mit entgegengesetztem Umlaufsinn. Die Vorgabe-
 * Füllregel `nonzero` vereinigt gleichsinnige Pfade und LÖSCHT gegensinnige
 * in ihrer Überschneidung. Beim ersten Wurf der Sprechblase war der Zipfel
 * andersherum gewickelt – in Chromium nachgemessen war die Folge ein
 * sauberes Loch quer durch den unteren Rand der Blase.
 *
 * Deshalb wird hier nicht gezeichnet, sondern mitgeschrieben: ein Stift, der
 * nur festhält, wohin er ginge. Die Vorzeichen der Flächen sagen dann alles.
 */
interface Teilpfad {
  punkte: { x: number; y: number }[];
}

function mitschrift() {
  const teile: Teilpfad[] = [];
  let offen: { x: number; y: number }[] = [];
  const ablegen = () => {
    if (offen.length >= 3) teile.push({ punkte: offen });
    offen = [];
  };
  const stift = {
    beginPath() {
      teile.length = 0;
      offen = [];
    },
    moveTo(x: number, y: number) {
      ablegen();
      offen = [{ x, y }];
    },
    lineTo(x: number, y: number) {
      offen.push({ x, y });
    },
    // Die Rundung liegt im Dreieck aus Stützpunkt und Ziel – für die Frage
    // nach dem Umlaufsinn genügt der Streckenzug darüber.
    arcTo(x1: number, y1: number, x2: number, y2: number) {
      offen.push({ x: x1, y: y1 }, { x: x2, y: y2 });
    },
    arc(cx: number, cy: number, r: number, von: number, bis: number) {
      const schritte = 32;
      for (let i = 0; i <= schritte; i += 1) {
        const w = von + ((bis - von) * i) / schritte;
        offen.push({ x: cx + Math.cos(w) * r, y: cy + Math.sin(w) * r });
      }
    },
    closePath() {
      ablegen();
    },
    fertig() {
      ablegen();
      return teile;
    },
  };
  return stift;
}

/**
 * Die vorzeichenbehaftete Fläche.
 *
 * Positiv heisst im Uhrzeigersinn – auf einer Leinwand, deren y-Achse nach
 * unten zeigt. (In der Schulmathematik mit y nach oben wäre es umgekehrt;
 * genau diese Verwechslung war der Fehler.)
 */
function flaecheMitVorzeichen(teil: Teilpfad): number {
  let summe = 0;
  const p = teil.punkte;
  for (let i = 0; i < p.length; i += 1) {
    const a = p[i];
    const b = p[(i + 1) % p.length];
    summe += a.x * b.y - b.x * a.y;
  }
  return summe / 2;
}

describe('formPfad', () => {
  function zeichnen(shape: Parameters<typeof formPfad>[1]) {
    const stift = mitschrift();
    const gibtEs = formPfad(stift as unknown as CanvasRenderingContext2D, shape);
    return { gibtEs, teile: stift.fertig() };
  }

  it('schneidet bei Quadrat und Frei nichts weg', () => {
    expect(zeichnen('square').gibtEs).toBe(false);
    expect(zeichnen('free').gibtEs).toBe(false);
  });

  it('legt für Karte, Kreis und Sprechblase einen Pfad an', () => {
    for (const shape of ['rounded', 'circle', 'bubble'] as const) {
      const { gibtEs, teile } = zeichnen(shape);
      expect(gibtEs).toBe(true);
      expect(teile.length).toBeGreaterThan(0);
    }
  });

  it('wickelt alle Teilpfade gleichsinnig – sonst frisst der Zipfel die Blase', () => {
    for (const shape of ['rounded', 'circle', 'bubble'] as const) {
      const vorzeichen = zeichnen(shape).teile.map((teil) => Math.sign(flaecheMitVorzeichen(teil)));
      expect(vorzeichen.every((wert) => wert === vorzeichen[0])).toBe(true);
      // Und zwar im Uhrzeigersinn, wie `abgerundet` es vorgibt.
      expect(vorzeichen[0]).toBe(1);
    }
  });

  it('gibt der Sprechblase einen Zipfel, der unter dem Körper hervorschaut', () => {
    const { teile } = zeichnen('bubble');
    expect(teile).toHaveLength(2);
    const tiefsteR = Math.max(...teile[0].punkte.map((p) => p.y));
    const tiefsteZ = Math.max(...teile[1].punkte.map((p) => p.y));
    expect(tiefsteZ).toBeGreaterThan(tiefsteR + 40);
    // Er greift zugleich in den Körper hinein, sonst klaffte an der
    // Nahtstelle eine Kerbe.
    expect(Math.min(...teile[1].punkte.map((p) => p.y))).toBeLessThan(tiefsteR);
  });

  it('bleibt bei jeder Form innerhalb der Fläche', () => {
    for (const shape of ['rounded', 'circle', 'bubble'] as const) {
      for (const teil of zeichnen(shape).teile) {
        for (const punkt of teil.punkte) {
          expect(punkt.x).toBeGreaterThanOrEqual(0);
          expect(punkt.y).toBeGreaterThanOrEqual(0);
          expect(punkt.x).toBeLessThanOrEqual(STICKER_SIZE);
          expect(punkt.y).toBeLessThanOrEqual(STICKER_SIZE);
        }
      }
    }
  });
});

describe('Schriftzüge auf dem Sticker', () => {
  /**
   * Ein Messkontext, der sich wie `measureText` verhält, ohne einen Browser.
   *
   * Node hat kein Canvas. Gebraucht wird hier nur die Breite eines Textes,
   * und die darf für den Zweck eine schlichte Rechnung sein: Zeichenzahl mal
   * halbe Schrifthöhe. Wichtig ist nicht der genaue Wert, sondern dass
   * Zeichnen und Antippen DENSELBEN benutzen – das prüfen die Tests unten.
   */
  function messkontext(): CanvasRenderingContext2D {
    let groesse = 10;
    return {
      set font(wert: string) {
        groesse = Number(/([\d.]+)px/.exec(wert)?.[1] ?? 10);
      },
      get font() {
        return `800 ${groesse}px x`;
      },
      measureText: (wert: string) => ({ width: wert.length * groesse * 0.5 }),
    } as unknown as CanvasRenderingContext2D;
  }

  const text = (patch: Partial<Parameters<typeof trifftText>[1]> = {}) => ({
    id: 't1',
    value: 'Moin',
    x: 0.5,
    y: 0.5,
    size: 68,
    color: '#fff',
    outline: true,
    drehung: 0,
    ...patch,
  });

  it('trifft in der Mitte des Schriftzugs', () => {
    const mitte = { x: STICKER_SIZE / 2, y: STICKER_SIZE / 2 };
    expect(trifftText(messkontext(), text(), mitte, STICKER_SIZE)).toBe(true);
  });

  it('trifft nicht weit daneben', () => {
    const daneben = { x: STICKER_SIZE / 2, y: STICKER_SIZE * 0.05 };
    expect(trifftText(messkontext(), text(), daneben, STICKER_SIZE)).toBe(false);
  });

  it('wandert mit, wenn der Schriftzug woanders sitzt', () => {
    // Der ganze Sinn der freien Platzierung: Die Trefferfläche darf nicht an
    // einer festen Stelle kleben, sonst greift man ins Leere.
    const oben = text({ y: 0.15 });
    const beiIhm = { x: STICKER_SIZE / 2, y: STICKER_SIZE * 0.15 };
    const inDerMitte = { x: STICKER_SIZE / 2, y: STICKER_SIZE / 2 };
    expect(trifftText(messkontext(), oben, beiIhm, STICKER_SIZE)).toBe(true);
    expect(trifftText(messkontext(), oben, inDerMitte, STICKER_SIZE)).toBe(false);
  });

  it('dreht die Trefferfläche mit', () => {
    /*
     * Ein um 90° gedrehter Schriftzug steht senkrecht. Ein Punkt, der beim
     * ungedrehten weit rechts noch trifft, muss dann danebengehen – und ein
     * Punkt weit unten muss treffen. Ohne das Zurückdrehen in `trifftText`
     * bliebe die Fläche waagerecht liegen, und man griffe neben den Text,
     * den man sieht.
     */
    const gerade = text({ value: 'Langer Text hier' });
    const gedreht = text({ value: 'Langer Text hier', drehung: 90 });
    const rechts = { x: STICKER_SIZE / 2 + 120, y: STICKER_SIZE / 2 };
    const unten = { x: STICKER_SIZE / 2, y: STICKER_SIZE / 2 + 120 };
    expect(trifftText(messkontext(), gerade, rechts, STICKER_SIZE)).toBe(true);
    expect(trifftText(messkontext(), gerade, unten, STICKER_SIZE)).toBe(false);
    expect(trifftText(messkontext(), gedreht, rechts, STICKER_SIZE)).toBe(false);
    expect(trifftText(messkontext(), gedreht, unten, STICKER_SIZE)).toBe(true);
  });

  it('schrumpft die Schrift, bis sie auf die Fläche passt', () => {
    const lang = text({ value: 'Ein wirklich sehr langer Schriftzug', size: 140 });
    const mass = textMass(messkontext(), lang, STICKER_SIZE);
    expect(mass.groesse).toBeLessThan(140);
    expect(mass.breite).toBeLessThanOrEqual(STICKER_SIZE);
  });

  it('rechnet die Grösse auf die Kantenlänge um', () => {
    // Vorschau und Ausgabe haben verschiedene Kantenlängen. Ein Schriftzug,
    // der in beiden gleich gross gerechnet würde, säße in der Vorschau
    // richtig und in der Ausgabe falsch – oder umgekehrt.
    const gross = textMass(messkontext(), text(), STICKER_SIZE);
    const klein = textMass(messkontext(), text(), STICKER_SIZE / 2);
    expect(klein.groesse).toBeCloseTo(gross.groesse / 2, 6);
  });

  it('gibt auch einem leeren Schriftzug eine Trefferfläche', () => {
    /*
     * Sonst könnte man einen frisch angelegten Text nie anfassen, um ihn zu
     * verschieben – und er säße für immer dort, wo er entstanden ist.
     *
     * Gemessen wird bewusst NEBEN dem Mittelpunkt: Genau in der Mitte trifft
     * man auch mit einer Trefferfläche der Grösse null. Ein Finger landet
     * dort nie, und der erste Anlauf dieses Tests war damit wertlos – er
     * blieb grün, als ich die Toleranz zum Versuch auf 0 setzte.
     */
    const leer = text({ value: '' });
    const knappDaneben = { x: STICKER_SIZE / 2 + 9, y: STICKER_SIZE / 2 + 9 };
    expect(trifftText(messkontext(), leer, knappDaneben, STICKER_SIZE)).toBe(true);
  });
});

describe('dilateAlpha', () => {
  /**
   * Die vorige Fassung, Zeile für Zeile – als Massstab.
   *
   * Das laufende Maximum ist ein anderes Verfahren für dasselbe Ergebnis, und
   * „dasselbe" ist hier wörtlich zu nehmen: Byte für Byte. Ein Test, der nur
   * prüft, dass irgendetwas Grösseres herauskommt, würde einen
   * Vorzeichenfehler im Blockrand nicht bemerken – und der sähe im Bild aus
   * wie ein Saum, der an einer Stelle einen Punkt zu schmal ist.
   */
  function langsam(alpha: Uint8Array, width: number, height: number, radius: number): Uint8Array {
    const horizontal = new Uint8Array(alpha.length);
    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      for (let x = 0; x < width; x += 1) {
        let max = 0;
        for (let i = Math.max(0, x - radius); i <= Math.min(width - 1, x + radius); i += 1) {
          if (alpha[row + i] > max) max = alpha[row + i];
        }
        horizontal[row + x] = max;
      }
    }
    const result = new Uint8Array(alpha.length);
    for (let x = 0; x < width; x += 1) {
      for (let y = 0; y < height; y += 1) {
        let max = 0;
        for (let i = Math.max(0, y - radius); i <= Math.min(height - 1, y + radius); i += 1) {
          if (horizontal[i * width + x] > max) max = horizontal[i * width + x];
        }
        result[y * width + x] = max;
      }
    }
    return result;
  }

  /** Ein Zufallsfeld mit fester Folge – derselbe Fall bei jedem Lauf. */
  function feld(n: number, saat: number): Uint8Array {
    const raus = new Uint8Array(n);
    let z = saat;
    for (let i = 0; i < n; i += 1) {
      z = (z * 1103515245 + 12345) & 0x7fffffff;
      // Viele Nullen und viele Vollwerte – so sieht eine Freistellmaske aus,
      // und genau dort greift die Abkürzung „max === 255" der alten Fassung.
      const w = (z >>> 16) % 100;
      raus[i] = w < 40 ? 0 : w > 90 ? 255 : (z >>> 8) & 0xff;
    }
    return raus;
  }

  it('rechnet Byte für Byte dasselbe wie der Durchlauf über das Fenster', () => {
    const faelle: [number, number, number][] = [
      [16, 16, 1],
      [16, 16, 3],
      [17, 13, 4],
      [13, 17, 7],
      [33, 31, 5],
      [64, 48, 12],
      // Radius grösser als die Kante: Das Fenster ragt auf BEIDEN Seiten
      // hinaus, und jeder Punkt bekommt das Maximum des ganzen Bildes.
      [8, 8, 20],
      // Eine einzelne Zeile und eine einzelne Spalte.
      [40, 1, 6],
      [1, 40, 6],
    ];
    for (const [w, h, r] of faelle) {
      const a = feld(w * h, w * 7919 + h * 104729 + r);
      expect(Array.from(dilateAlpha(a, w, h, r)), `${w}x${h}, Radius ${r}`).toEqual(
        Array.from(langsam(a, w, h, r)),
      );
    }
  });

  it('trägt nichts aus dem waagerechten in den senkrechten Durchgang', () => {
    /*
     * Der Fall, den ein Zufallsfeld nicht findet.
     *
     * Beide Durchgänge teilen sich dieselben drei Hilfsfelder, und der
     * waagerechte läuft über die BREITE, der senkrechte über die HÖHE. Ist
     * das Bild breiter als hoch, steht im Hilfsfeld hinter der senkrechten
     * Linie noch, was der waagerechte Durchgang dort zuletzt abgelegt hat –
     * und ein Maximum zieht sich genau von dort nach vorn.
     *
     * Sichtbar wird das nur, wo das richtige Ergebnis NULL ist. In einem
     * Zufallsfeld voller Vollwerte ist das Fenstermaximum fast überall schon
     * 255, und der Fehler verschwindet darin. Deshalb hier: ein einzelner
     * heller Fleck oben links, alles andere leer, und breiter als hoch.
     */
    const w = 64;
    const h = 16;
    const r = 5;
    /*
     * Wo der Fleck liegt, ist nicht gleichgültig – er muss GENAU dort
     * stehen, wo der senkrechte Durchgang seine Polsterung erwartet.
     *
     * Der waagerechte Durchgang legt die Zeile bei Versatz r ab, also unter
     * [5, 69). Der senkrechte braucht nur [5, 21) und liest bis 25. Die fünf
     * Stellen [21, 26) schreibt er nie – dort steht noch die LETZTE Zeile des
     * waagerechten Durchgangs, also alpha[15 · 64 + 16 … 20]. Genau da hinein
     * kommt der Fleck. Ohne das Nullen zieht sich sein Wert danach durch
     * jede Spalte.
     */
    const a = new Uint8Array(w * h);
    for (let x = 16; x <= 20; x += 1) a[(h - 1) * w + x] = 255;
    const raus = dilateAlpha(a, w, h, r);
    expect(Array.from(raus)).toEqual(Array.from(langsam(a, w, h, r)));
    // Und ausdrücklich: eine Spalte weit weg vom Fleck bleibt ganz leer.
    for (let y = 0; y < h; y += 1) {
      expect(raus[y * w + (w - 1)], `Zeile ${y}, letzte Spalte`).toBe(0);
    }
  });

  it('lässt bei Radius 0 alles stehen', () => {
    const a = feld(64, 5);
    expect(Array.from(dilateAlpha(a, 8, 8, 0))).toEqual(Array.from(a));
  });

  it('gibt ein eigenes Feld zurück, nicht das hereingegebene', () => {
    // Ein Aufrufer schreibt sein Ergebnis über die Eingabe (siehe
    // „hereinziehen" in renderSticker). Käme dasselbe Feld zurück, läse er
    // beim Umkehren, was er gerade geschrieben hat.
    const a = feld(64, 9);
    const raus = dilateAlpha(a, 8, 8, 0);
    expect(raus).not.toBe(a);
    raus[0] = 7;
    expect(a[0]).not.toBe(7);
  });

  it('weitet einen einzelnen Punkt zu einem Quadrat aus', () => {
    // Der anschauliche Fall: Ein Punkt in der Mitte, Radius 2, ergibt ein
    // 5 × 5 grosses Quadrat – nicht einen Kreis. Rund wird es erst durch den
    // Weichzeichner danach.
    const a = new Uint8Array(81);
    a[4 * 9 + 4] = 255;
    const raus = dilateAlpha(a, 9, 9, 2);
    let gesetzt = 0;
    for (const wert of raus) if (wert === 255) gesetzt += 1;
    expect(gesetzt).toBe(25);
    expect(raus[2 * 9 + 2]).toBe(255);
    expect(raus[1 * 9 + 4]).toBe(0);
  });
});

describe('texteMitbewegen', () => {
  const text = (werte: Partial<StickerText> = {}): StickerText =>
    ({
      id: 't1',
      value: 'Hallo',
      x: 0.7,
      y: 0.3,
      size: 80,
      color: '#ffffff',
      outline: true,
      drehung: 0,
      schrift: 'system',
      ...werte,
    }) as StickerText;

  const lage = (scale: number, offsetX = 0, offsetY = 0, drehung = 0) => ({
    scale,
    offsetX,
    offsetY,
    drehung,
  });

  it('lässt alles stehen, wenn sich nichts geändert hat', () => {
    const vorher = [text()];
    expect(texteMitbewegen(vorher, lage(1), lage(1))).toBe(vorher);
  });

  it('schiebt den Schriftzug mit, wenn das Motiv geschoben wird', () => {
    const [raus] = texteMitbewegen([text({ x: 0.5, y: 0.5 })], lage(1), lage(1, 64, -32));
    expect(raus.x).toBeCloseTo(0.5 + 64 / STICKER_SIZE, 6);
    expect(raus.y).toBeCloseTo(0.5 - 32 / STICKER_SIZE, 6);
    // Reines Schieben ändert weder Grösse noch Winkel.
    expect(raus.size).toBeCloseTo(80, 6);
    expect(raus.drehung).toBe(0);
  });

  it('skaliert Abstand zur Motivmitte UND Schriftgrösse', () => {
    // Motivmitte liegt bei Versatz 0 in der Flächenmitte (0,5 / 0,5).
    const [raus] = texteMitbewegen([text({ x: 0.75, y: 0.5, size: 80 })], lage(1), lage(2));
    // 0,25 Abstand wird zu 0,5.
    expect(raus.x).toBeCloseTo(1.0, 6);
    expect(raus.y).toBeCloseTo(0.5, 6);
    expect(raus.size).toBeCloseTo(160, 6);
  });

  it('dreht den Schriftzug um die Motivmitte und um sich selbst', () => {
    const [raus] = texteMitbewegen(
      [text({ x: 0.75, y: 0.5, drehung: 10 })],
      lage(1),
      lage(1, 0, 0, 90),
    );
    // Eine Vierteldrehung um die Mitte: rechts wird unten.
    expect(raus.x).toBeCloseTo(0.5, 6);
    expect(raus.y).toBeCloseTo(0.75, 6);
    expect(raus.drehung).toBeCloseTo(100, 6);
  });

  it('ist umkehrbar – hin und zurück landet genau wieder am Anfang', () => {
    /*
     * Die wichtigste Eigenschaft, und der Grund, warum hier nicht geklemmt
     * wird. Würde `x`/`y` auf 0 … 1 gehalten, bliebe ein weit
     * hinausgeschobener Schriftzug am Rand kleben und käme beim Zurückzoomen
     * nicht an seine Stelle zurück. Nach einmal Hin und Her stünde er
     * woanders – ein Fehler, der schlimmer wäre als der behobene.
     */
    const anfang = [text({ x: 0.82, y: 0.17, size: 96, drehung: 23 })];
    const a = lage(1, 10, -5, 15);
    const b = lage(3.7, -80, 120, 200);
    const hin = texteMitbewegen(anfang, a, b);
    const zurueck = texteMitbewegen(hin, b, a);
    expect(zurueck[0].x).toBeCloseTo(anfang[0].x, 9);
    expect(zurueck[0].y).toBeCloseTo(anfang[0].y, 9);
    expect(zurueck[0].size).toBeCloseTo(anfang[0].size, 9);
    expect(((zurueck[0].drehung % 360) + 360) % 360).toBeCloseTo(
      ((anfang[0].drehung % 360) + 360) % 360,
      9,
    );
  });

  it('lässt den Schriftzug aus der Fläche hinauswandern, statt ihn zu klemmen', () => {
    const [raus] = texteMitbewegen([text({ x: 0.9, y: 0.9 })], lage(1), lage(8));
    expect(raus.x).toBeGreaterThan(1);
    expect(raus.y).toBeGreaterThan(1);
  });

  it('verträgt einen Massstab von null, ohne NaN zu erzeugen', () => {
    // Aus einem fremden oder halb gebauten Dokument erreichbar; ohne den
    // Wächter wäre das Verhältnis Unendlich und jede Koordinate NaN.
    const [raus] = texteMitbewegen([text()], lage(0), lage(2));
    expect(Number.isFinite(raus.x)).toBe(true);
    expect(Number.isFinite(raus.y)).toBe(true);
    expect(Number.isFinite(raus.size)).toBe(true);
  });
});
