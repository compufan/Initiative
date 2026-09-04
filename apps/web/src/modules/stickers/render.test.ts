import { describe, expect, it } from 'vitest';
import {
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
  zweiFingerZug,
  removeBackground,
  saatAufFlaeche,
  strichBloecke,
  toSourcePoint,
  vereinigeAlpha,
} from './render.js';
import type { Stroke } from './render.js';

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
    const copy = cloneDoc(doc);
    copy.strokes.push({ size: 10, points: [1, 2], mode: 'weg' });
    copy.top.value = 'Hallo';

    expect(doc.strokes).toHaveLength(0);
    expect(doc.top.value).toBe('');
  });

  it('knows when there is nothing to export yet', () => {
    const doc = createDoc();
    expect(isEmptyDoc(null, doc)).toBe(true);
    expect(isEmptyDoc({ kind: 'text' }, doc)).toBe(true);
    expect(isEmptyDoc({ kind: 'emoji', emoji: '🐱' }, doc)).toBe(false);
    expect(isEmptyDoc(null, { ...doc, top: { ...doc.top, value: 'Moin' } })).toBe(false);
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
