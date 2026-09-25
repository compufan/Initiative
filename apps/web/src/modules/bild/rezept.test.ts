import { describe, expect, it } from 'vitest';

import { neuesDoc, type BildDoc, type Maskenteil } from './doc.js';
import {
  REZEPT_FASSUNG,
  REZEPT_GRENZEN,
  docAusRoh,
  docNachRoh,
  entpacken,
  rezeptHindernis,
  rezeptLesen,
  rezeptLohnt,
  rezeptSchreiben,
} from './rezept.js';
import { BAENDER, BAENDER_NEUTRAL } from './fein.js';

function bild(): BildDoc {
  return neuesDoc(1200, 900);
}

function netzTeil(werte: Partial<Record<string, unknown>> = {}): Maskenteil {
  return {
    id: 'n1',
    modus: 'dazu',
    umkehren: false,
    art: 'netz',
    netz: 'person',
    breite: 8,
    hoehe: 4,
    alpha: new Uint8Array(32).fill(200),
    marke: 1,
    ...werte,
  } as Maskenteil;
}

describe('docNachRoh / docAusRoh', () => {
  it('bringt eine ganze Bearbeitung unverändert hin und zurück', () => {
    const doc = bild();
    doc.drehung = 90;
    doc.spiegel = true;
    doc.neigung = 3.5;
    doc.zuschnitt = { x: 10, y: 20, w: 400, h: 300 };
    doc.anpassung = { ...doc.anpassung, belichtung: 1.25, kontrast: -0.4, vignette: 0.3 };
    doc.striche.push({ farbe: '#ff0000', breite: 12, punkte: [1, 2, 3, 4], art: 'pixel' });
    doc.texte.push({
      id: 't1',
      text: 'Hallo',
      x: 100,
      y: 200,
      groesse: 48,
      farbe: '#ffffff',
      kontur: '#000000',
      schrift: 'serif',
      fett: true,
    });
    doc.bereiche.push({
      id: 'b1',
      name: 'Himmel',
      aktiv: true,
      teile: [
        {
          id: 'v1',
          modus: 'dazu',
          umkehren: false,
          art: 'verlauf',
          von: { x: 0, y: 0 },
          bis: { x: 0, y: 400 },
        },
        netzTeil(),
      ],
      anpassung: {
        belichtung: -0.5,
        kontrast: 0,
        lichter: 0,
        tiefen: 0,
        schwarz: 0,
        waerme: 0.2,
        toenung: 0,
        saettigung: 0,
        dynamik: 0,
        swRot: 0,
        swGruen: 0,
        unschaerfe: 0.75,
      },
    });

    const zurueck = docAusRoh(docNachRoh(doc), 1200, 900);

    expect(zurueck.drehung).toBe(90);
    expect(zurueck.spiegel).toBe(true);
    expect(zurueck.neigung).toBeCloseTo(3.5);
    expect(zurueck.zuschnitt).toEqual({ x: 10, y: 20, w: 400, h: 300 });
    expect(zurueck.anpassung.belichtung).toBeCloseTo(1.25);
    expect(zurueck.anpassung.kontrast).toBeCloseTo(-0.4);
    expect(zurueck.anpassung.vignette).toBeCloseTo(0.3);
    expect(zurueck.striche).toHaveLength(1);
    expect(zurueck.striche[0].art).toBe('pixel');
    expect(zurueck.striche[0].punkte).toEqual([1, 2, 3, 4]);
    expect(zurueck.texte[0].text).toBe('Hallo');
    expect(zurueck.texte[0].fett).toBe(true);
    expect(zurueck.bereiche).toHaveLength(1);
    expect(zurueck.bereiche[0].anpassung.unschaerfe).toBeCloseTo(0.75);
    expect(zurueck.bereiche[0].teile).toHaveLength(2);
  });

  it('bringt ein Rasterfeld Byte für Byte zurück', () => {
    const alpha = new Uint8Array(256);
    for (let i = 0; i < alpha.length; i += 1) alpha[i] = (i * 7) % 256;
    const doc = bild();
    doc.bereiche.push({
      id: 'b1',
      name: 'Motiv',
      aktiv: true,
      teile: [netzTeil({ breite: 16, hoehe: 16, alpha })],
      anpassung: { ...bereichNeutral() },
    });

    const zurueck = docAusRoh(docNachRoh(doc), 1200, 900);
    const teil = zurueck.bereiche[0].teile[0];
    expect(teil.art).toBe('netz');
    if (teil.art !== 'netz') return;
    expect(Array.from(teil.alpha)).toEqual(Array.from(alpha));
  });

  it('vergibt neue Marken, statt die fremden zu übernehmen', () => {
    const doc = bild();
    doc.bereiche.push({
      id: 'b1',
      name: 'Motiv',
      aktiv: true,
      teile: [netzTeil({ marke: 1 })],
      anpassung: { ...bereichNeutral() },
    });
    const a = docAusRoh(docNachRoh(doc), 1200, 900).bereiche[0].teile[0];
    const b = docAusRoh(docNachRoh(doc), 1200, 900).bereiche[0].teile[0];
    if (a.art !== 'netz' || b.art !== 'netz') throw new Error('kein Netzteil');
    /*
     * Zwei Läufe, zwei Marken. Die Marke ist die Ersatzidentität eines
     * `Uint8Array` für den Maskenspeicher: Käme die Eins aus der Datei,
     * hielte der Zwischenspeicher zwei verschiedene Masken für dieselbe und
     * zeigte für das zweite Bild die Maske des ersten.
     */
    expect(a.marke).not.toBe(b.marke);
  });
});

function bereichNeutral() {
  return {
    belichtung: 0,
    kontrast: 0,
    lichter: 0,
    tiefen: 0,
    schwarz: 0,
    waerme: 0,
    toenung: 0,
    saettigung: 0,
    dynamik: 0,
    swRot: 0,
    swGruen: 0,
    unschaerfe: 0,
  };
}

describe('docAusRoh glaubt der Datei nichts', () => {
  it('klemmt Zahlen und wirft NaN weg', () => {
    const doc = docAusRoh(
      {
        drehung: 47,
        neigung: 9999,
        anpassung: { belichtung: 500, kontrast: Number.NaN, saettigung: 'viel' },
      },
      100,
      100,
    );
    // 47 ist keine Lage, die es gibt – gerundet wird auf die nächste.
    expect([0, 90, 180, 270]).toContain(doc.drehung);
    expect(doc.neigung).toBe(45);
    expect(doc.anpassung.belichtung).toBe(3);
    expect(doc.anpassung.kontrast).toBe(0);
    expect(doc.anpassung.saettigung).toBe(0);
  });

  it('hält den Zuschnitt im Bild, auch wenn die Datei anderes behauptet', () => {
    const doc = docAusRoh({ zuschnitt: { x: -500, y: 5000, w: 99999, h: -3 } }, 100, 80);
    expect(doc.zuschnitt.x).toBe(0);
    expect(doc.zuschnitt.y).toBe(79);
    expect(doc.zuschnitt.x + doc.zuschnitt.w).toBeLessThanOrEqual(100);
    expect(doc.zuschnitt.y + doc.zuschnitt.h).toBeLessThanOrEqual(80);
  });

  it('lehnt ein Raster ab, dessen Länge nicht zu seinen Massen passt', () => {
    const roh = docNachRoh(
      (() => {
        const d = bild();
        d.bereiche.push({
          id: 'b',
          name: 'x',
          aktiv: true,
          teile: [netzTeil({ breite: 8, hoehe: 4, alpha: new Uint8Array(32) })],
          anpassung: bereichNeutral(),
        });
        return d;
      })(),
    );
    // Die Masse aufblähen, das Feld lassen – das klassische „liest hinter dem
    // Ende" ohne jede Fehlermeldung.
    (roh.bereiche[0] as Record<string, unknown>).teile = [
      {
        ...(((roh.bereiche[0] as Record<string, unknown>).teile as unknown[])[0] as object),
        breite: 64,
      },
    ];
    const doc = docAusRoh(roh, 1200, 900);
    expect(doc.bereiche[0].teile).toHaveLength(0);
  });

  it('lehnt ein Raster ab, das grösser ist als jedes echte', () => {
    /*
     * Das Feld PASST zu den angegebenen Massen – nur eine Kante über der
     * Grenze. Mit einem leeren Feld bestünde der Test auch ohne die
     * Flächengrenze, denn dann griffe schon die Längenprüfung; geprüft wäre
     * dann nicht, was der Name sagt.
     */
    const kante = 1537;
    expect(kante * kante).toBeGreaterThan(REZEPT_GRENZEN.rasterPunkte);
    const feld = new Uint8Array(kante * kante);
    let roh = '';
    for (let i = 0; i < feld.length; i += 0x8000) {
      roh += String.fromCharCode(...feld.subarray(i, i + 0x8000));
    }
    const doc = docAusRoh(
      {
        bereiche: [
          {
            id: 'b',
            teile: [{ art: 'netz', breite: kante, hoehe: kante, alpha: btoa(roh) }],
          },
        ],
      },
      1200,
      900,
    );
    expect(doc.bereiche[0].teile).toHaveLength(0);
  });

  it('lehnt ein Raster ab, dessen Feld zu kurz für seine Masse ist', () => {
    /*
     * Der gefährlichere der beiden Fälle. Jeder Leser rechnet `y * breite +
     * x`; hinter dem Ende steht in JavaScript kein Absturz, sondern
     * `undefined`, das stumm zu 0 wird. Die Maske sähe aus, als hätte sie
     * unten einen schwarzen Rand – und niemand käme auf die Idee, die Datei
     * zu verdächtigen.
     */
    const doc = docAusRoh(
      {
        bereiche: [
          {
            id: 'b',
            // 16 × 16 angesagt, 32 Bytes geliefert.
            teile: [{ art: 'netz', breite: 16, hoehe: 16, alpha: btoa('x'.repeat(32)) }],
          },
        ],
      },
      1200,
      900,
    );
    expect(doc.bereiche[0].teile).toHaveLength(0);
  });

  it('begrenzt Bereiche, Teile und Striche', () => {
    const vieleTeile = Array.from({ length: 50 }, (_, i) => ({
      art: 'verlauf',
      id: `v${i}`,
      von: { x: 0, y: 0 },
      bis: { x: 10, y: 10 },
    }));
    const doc = docAusRoh(
      {
        bereiche: Array.from({ length: 20 }, (_, i) => ({ id: `b${i}`, teile: vieleTeile })),
        striche: Array.from({ length: 5000 }, () => ({ punkte: [0, 0, 1, 1] })),
        texte: Array.from({ length: 500 }, () => ({ text: 'x' })),
      },
      1200,
      900,
    );
    expect(doc.bereiche).toHaveLength(REZEPT_GRENZEN.bereiche);
    expect(doc.bereiche[0].teile).toHaveLength(REZEPT_GRENZEN.teileJeBereich);
    expect(doc.striche).toHaveLength(REZEPT_GRENZEN.striche);
    expect(doc.texte).toHaveLength(REZEPT_GRENZEN.texte);
  });

  it('begrenzt die Zahl der Rasterteile über das ganze Dokument', () => {
    const rasterTeil = {
      art: 'netz',
      breite: 2,
      hoehe: 2,
      /*
       * Vier Bytes als Escape-Folge und nicht als Zeichen.
       *
       * Mit den Steuerzeichen im Quelltext hielt git die ganze Datei fuer
       * eine Binaerdatei: kein Unterschied in der Durchsicht, kein Treffer
       * bei der Suche. Eine Testdatei, die man nicht lesen kann, ist die
       * Haelfte weniger wert.
       */
      alpha: btoa('\u0000\u0001\u0002\u0003'),
    };
    const doc = docAusRoh(
      {
        bereiche: Array.from({ length: 4 }, (_, i) => ({
          id: `b${i}`,
          teile: Array.from({ length: 6 }, () => rasterTeil),
        })),
      },
      1200,
      900,
    );
    const summe = doc.bereiche.reduce((n, b) => n + b.teile.length, 0);
    expect(summe).toBe(REZEPT_GRENZEN.rasterTeile);
  });

  it('macht aus Unsinn ein leeres Dokument statt eines Absturzes', () => {
    for (const unsinn of [null, 42, 'nein', [], { bereiche: 'viele', striche: 7 }]) {
      const doc = docAusRoh(unsinn, 100, 100);
      expect(doc.bereiche).toEqual([]);
      expect(doc.striche).toEqual([]);
      expect(doc.zuschnitt).toEqual({ x: 0, y: 0, w: 100, h: 100 });
    }
  });
});

describe('rezeptHindernis', () => {
  it('lässt eine reine Ton- und Bereichsbearbeitung durch', () => {
    const doc = bild();
    doc.anpassung = { ...doc.anpassung, belichtung: 0.8 };
    doc.drehung = 180;
    doc.spiegel = true;
    doc.bereiche.push({
      id: 'b',
      name: 'Motiv',
      aktiv: true,
      teile: [netzTeil()],
      /*
       * Licht und Farbe, KEINE Unschärfe.
       *
       * Hier stand `unschaerfe: 0.6` – und damit schrieb dieser Test das
       * Loch fest, das die Regel haben sollte: Ein weichgezeichneter Bereich
       * ist eine Anonymisierung, und das Rezept schickte das scharfe
       * Original mit. Ein Test, der das Gegenteil dessen festhält, was die
       * Regel bezweckt, ist schlimmer als gar keiner.
       */
      anpassung: { ...bereichNeutral(), belichtung: -1.2, saettigung: 0.5 },
    });
    expect(rezeptHindernis(doc, 1200, 900)).toBeNull();
  });

  it('hält jeden Strich zurück – auch einen gemalten', () => {
    for (const art of ['farbe', 'pixel', 'weich', 'klon'] as const) {
      const doc = bild();
      doc.striche.push({ farbe: '#000', breite: 20, punkte: [0, 0, 10, 10], art });
      expect(rezeptHindernis(doc, 1200, 900)).toMatch(/Bildinhalt/);
    }
  });

  it('hält einen Schriftzug zurück, einen leeren aber nicht', () => {
    const doc = bild();
    doc.texte.push({
      id: 't',
      text: '  ',
      x: 0,
      y: 0,
      groesse: 20,
      farbe: '#fff',
      kontur: null,
      schrift: 'system',
      fett: false,
    });
    expect(rezeptHindernis(doc, 1200, 900)).toBeNull();
    doc.texte[0].text = 'Hausnummer';
    expect(rezeptHindernis(doc, 1200, 900)).toMatch(/zu/);
  });

  it('hält Zuschnitt und Neigung zurück', () => {
    const zugeschnitten = bild();
    zugeschnitten.zuschnitt = { x: 0, y: 0, w: 600, h: 900 };
    expect(rezeptHindernis(zugeschnitten, 1200, 900)).toMatch(/Zuschnitt/);

    const geneigt = bild();
    geneigt.neigung = 1.5;
    expect(rezeptHindernis(geneigt, 1200, 900)).toMatch(/Ecken/);
  });

  it('erkennt einen verschobenen Zuschnitt gleicher Grösse', () => {
    /*
     * Ein Zuschnitt, der genauso gross ist wie das Bild, aber woanders liegt,
     * lässt trotzdem etwas weg – oben und links. Ein Vergleich nur der Masse
     * hätte ihn durchgelassen.
     */
    const doc = bild();
    doc.zuschnitt = { x: 20, y: 0, w: 1200, h: 900 };
    expect(rezeptHindernis(doc, 1200, 900)).toMatch(/Zuschnitt/);
  });
});

describe('rezeptLohnt', () => {
  it('ist bei einem unberührten Dokument falsch', () => {
    expect(rezeptLohnt(bild())).toBe(false);
  });

  it('ist wahr, sobald ein Regler steht oder etwas gedreht ist', () => {
    const getont = bild();
    getont.anpassung = { ...getont.anpassung, saettigung: 0.3 };
    expect(rezeptLohnt(getont)).toBe(true);

    const gedreht = bild();
    gedreht.drehung = 270;
    expect(rezeptLohnt(gedreht)).toBe(true);
  });
});

describe('Datei schreiben und lesen', () => {
  it('geht durch gzip hin und zurück', async () => {
    const doc = bild();
    doc.anpassung = { ...doc.anpassung, belichtung: 1.5, vignette: -0.4 };
    doc.bereiche.push({
      id: 'b',
      name: 'Motiv',
      aktiv: true,
      teile: [netzTeil({ breite: 32, hoehe: 32, alpha: new Uint8Array(1024).fill(180) })],
      anpassung: { ...bereichNeutral(), unschaerfe: 0.5 },
    });

    const datei = await rezeptSchreiben(doc, 1200, 900);
    const zurueck = await rezeptLesen(datei, 1200, 900);
    expect(zurueck).not.toBeNull();
    expect(zurueck?.anpassung.belichtung).toBeCloseTo(1.5);
    expect(zurueck?.anpassung.vignette).toBeCloseTo(-0.4);
    expect(zurueck?.bereiche[0].anpassung.unschaerfe).toBeCloseTo(0.5);
  });

  it('packt ein glattes Rasterfeld klein', async () => {
    const doc = bild();
    doc.bereiche.push({
      id: 'b',
      name: 'Motiv',
      aktiv: true,
      // Eine echte Freistellmaske: aussen 0, innen 255, dazwischen eine Kante.
      teile: [netzTeil({ breite: 512, hoehe: 512, alpha: maskeMitKante(512, 512) })],
      anpassung: bereichNeutral(),
    });
    const datei = await rezeptSchreiben(doc, 1200, 900);
    /*
     * 262 144 Bytes roh, als Base64 rund 350 000 Zeichen. Gemessen bleiben
     * 14 053 übrig. Die Grenze steht bei 30 000 und nicht knapp daneben: Sie
     * soll melden, wenn das Packen AUSFÄLLT, nicht wenn eine Maskenkante
     * einen Punkt weicher wird.
     */
    expect(datei.size).toBeLessThan(30_000);
  });

  it('lehnt eine fremde Fassung ab, statt sie zu raten', async () => {
    const roh = JSON.stringify({ v: REZEPT_FASSUNG + 1, breite: 10, hoehe: 10, doc: {} });
    const gepackt = await new Response(
      new Blob([roh]).stream().pipeThrough(new CompressionStream('gzip')),
    ).blob();
    expect(await rezeptLesen(gepackt, 10, 10)).toBeNull();
  });

  it('gibt null zurück, wenn die Datei kein gzip ist', async () => {
    expect(await rezeptLesen(new Blob(['keine Datei']), 10, 10)).toBeNull();
  });

  it('entpackt keine Bombe', async () => {
    /*
     * Die Bombe ist GÜLTIG: richtige Fassung, richtiger Aufbau, nur mit
     * achtundsechzig Megabyte Leerzeichen im JSON aufgeblasen. Gepackt sind
     * das ein paar Zehntausend Bytes, sie fällt also weder durch die
     * Dateigrenze noch durch `JSON.parse`.
     *
     * Das ist der Punkt: Eine Bombe aus Unsinn hätte gar nichts bewiesen –
     * die wäre am Parser gescheitert, mit oder ohne Deckel. Nur eine Bombe,
     * die ohne Deckel DURCHKÄME, prüft den Deckel.
     */
    const fuellung = ' '.repeat(REZEPT_GRENZEN.textBytes + 4 * 1024 * 1024);
    const roh = `{"v":${REZEPT_FASSUNG},"breite":10,"hoehe":10,${fuellung}"doc":{}}`;
    const bombe = await new Response(
      new Blob([roh]).stream().pipeThrough(new CompressionStream('gzip')),
    ).blob();
    expect(bombe.size).toBeLessThan(REZEPT_GRENZEN.dateiBytes);
    expect(JSON.parse(roh)).toBeTruthy();
    expect(await rezeptLesen(bombe, 10, 10)).toBeNull();
  });

  it('lehnt eine zu grosse Datei ab, ohne sie zu öffnen', async () => {
    /*
     * „Ohne sie zu öffnen" ist hier der ganze Punkt, und ein Rückgabewert
     * beweist ihn nicht: Eine Datei aus Nullen ist kein gzip, also käme auch
     * ohne die Grenze `null` heraus – der Test bestünde und prüfte nichts.
     *
     * Gezählt wird deshalb der Griff zum Inhalt. Die Grenze soll greifen,
     * BEVOR der Entpacker läuft; sonst fängt eine Datei, die sich
     * tausendfach aufbläst, erst im Arbeitsspeicher an aufzufallen.
     */
    let geoeffnet = false;
    const falle = {
      size: REZEPT_GRENZEN.dateiBytes + 1,
      stream() {
        geoeffnet = true;
        return new Blob([]).stream();
      },
    } as unknown as Blob;
    expect(await rezeptLesen(falle, 10, 10)).toBeNull();
    expect(geoeffnet, 'die Datei wurde trotz Übergrösse geöffnet').toBe(false);

    // Und unter der Grenze wird sie geöffnet – sonst prüfte die Zeile
    // darüber nur, dass `stream` nie gerufen wird.
    const klein = { ...falle, size: 10, stream: falle.stream } as unknown as Blob;
    await rezeptLesen(klein, 10, 10);
    expect(geoeffnet).toBe(true);
  });

  it('zerschneidet kein Zeichen an der Häppchengrenze', async () => {
    /*
     * Entpackt wird häppchenweise, und die Häppchen fallen dorthin, wo der
     * Entpacker sie fallen lässt – nicht auf Zeichengrenzen. Dreibytige
     * Zeichen treffen das zuverlässig: Eine Häppchengrenze liegt nur dann
     * sauber, wenn sie durch drei teilbar ist.
     *
     * Ohne mitlaufenden Dekoder steht an jeder solchen Stelle ein
     * Ersatzzeichen. Der Schaden wäre still: Ein Rezept bliebe lesbar, nur
     * stünde im Bild ein Schriftzug mit Löchern.
     */
    const zeichen = 400_000;
    const text = 'あ'.repeat(zeichen);
    const gepackt = await new Response(
      new Blob([text]).stream().pipeThrough(new CompressionStream('gzip')),
    ).blob();
    const zurueck = await entpacken(gepackt, REZEPT_GRENZEN.textBytes);
    expect(zurueck.length).toBe(zeichen);
    expect(zurueck).toBe(text);
  });

  it('wirft am Deckel, statt weiterzulesen', async () => {
    const gepackt = await new Response(
      new Blob([' '.repeat(4 * 1024 * 1024)]).stream().pipeThrough(new CompressionStream('gzip')),
    ).blob();
    await expect(entpacken(gepackt, 1024)).rejects.toThrow();
    // Und unter dem Deckel geht es durch, sonst prüfte die Zeile darüber nur,
    // dass `entpacken` überhaupt wirft.
    expect((await entpacken(gepackt, 8 * 1024 * 1024)).length).toBe(4 * 1024 * 1024);
  });
});

function maskeMitKante(breite: number, hoehe: number): Uint8Array {
  const feld = new Uint8Array(breite * hoehe);
  const mx = breite / 2;
  const my = hoehe / 2;
  const r = Math.min(breite, hoehe) * 0.35;
  for (let y = 0; y < hoehe; y += 1) {
    for (let x = 0; x < breite; x += 1) {
      const d = Math.hypot(x - mx, y - my);
      const w = Math.max(0, Math.min(1, (r + 8 - d) / 16));
      feld[y * breite + x] = Math.round(w * 255);
    }
  }
  return feld;
}

describe('Kurven und Bänder im Rezept', () => {
  it('bringt beide hin und zurück', () => {
    const doc = bild();
    doc.anpassung = {
      ...doc.anpassung,
      kurven: {
        gesamt: [
          { x: 0, y: 0 },
          { x: 0.4, y: 0.62 },
          { x: 1, y: 1 },
        ],
        rot: [],
        gruen: [],
        blau: [{ x: 0.25, y: 0.3 }],
      },
      baender: BAENDER.map((_, i) =>
        i === 3 ? { farbton: -0.4, saettigung: 0.8, helligkeit: -0.2 } : { ...BAENDER_NEUTRAL[i] },
      ),
    };

    const zurueck = docAusRoh(docNachRoh(doc), 1200, 900);
    expect(zurueck.anpassung.kurven.gesamt).toEqual([
      { x: 0, y: 0 },
      { x: 0.4, y: 0.62 },
      { x: 1, y: 1 },
    ]);
    expect(zurueck.anpassung.kurven.rot).toEqual([]);
    expect(zurueck.anpassung.kurven.blau).toEqual([{ x: 0.25, y: 0.3 }]);
    expect(zurueck.anpassung.baender[3]).toEqual({
      farbton: -0.4,
      saettigung: 0.8,
      helligkeit: -0.2,
    });
    expect(zurueck.anpassung.baender[0]).toEqual({ farbton: 0, saettigung: 0, helligkeit: 0 });
  });

  it('gibt immer genau acht Bänder zurück, egal was in der Datei steht', () => {
    /*
     * Die Zahl der Bänder ist eine Eigenschaft des Programms, nicht der
     * Datei: `bandGewichte` läuft über `BAENDER`, und ein Feld mit sieben
     * Einträgen läse beim achten daneben – in JavaScript kein Absturz,
     * sondern `undefined` und damit stumm `NaN` als Farbton.
     */
    const zuwenig = docAusRoh({ anpassung: { baender: [[1, 1, 1]] } }, 100, 100);
    expect(zuwenig.anpassung.baender).toHaveLength(BAENDER.length);
    expect(zuwenig.anpassung.baender[0].farbton).toBe(1);
    expect(zuwenig.anpassung.baender[7]).toEqual({ farbton: 0, saettigung: 0, helligkeit: 0 });

    const zuviel = docAusRoh(
      { anpassung: { baender: Array.from({ length: 50 }, () => [1, 1, 1]) } },
      100,
      100,
    );
    expect(zuviel.anpassung.baender).toHaveLength(BAENDER.length);
  });

  it('begrenzt und klemmt eine Kurve aus fremder Hand', () => {
    const doc = docAusRoh(
      {
        anpassung: {
          kurven: {
            gesamt: Array.from({ length: 500 }, (_, i) => [i / 500, 5]),
            rot: 'nein',
            gruen: [['x', null], [0.5]],
            blau: [[0.5, 0.5, 'extra']],
          },
        },
      },
      100,
      100,
    );
    expect(doc.anpassung.kurven.gesamt.length).toBeLessThanOrEqual(32);
    for (const p of doc.anpassung.kurven.gesamt) {
      expect(p.y).toBeLessThanOrEqual(1);
      expect(p.x).toBeGreaterThanOrEqual(0);
    }
    expect(doc.anpassung.kurven.rot).toEqual([]);
    // Ein Punkt mit zu wenigen Zahlen fällt weg, einer mit Unsinn wird zu 0.
    expect(doc.anpassung.kurven.gruen).toEqual([{ x: 0, y: 0 }]);
    expect(doc.anpassung.kurven.blau).toEqual([{ x: 0.5, y: 0.5 }]);
  });

  it('meldet eine Kurve als Bearbeitung, die ein Rezept sein darf', () => {
    const doc = bild();
    doc.anpassung = {
      ...doc.anpassung,
      kurven: { gesamt: [{ x: 0.5, y: 0.7 }], rot: [], gruen: [], blau: [] },
    };
    expect(rezeptLohnt(doc)).toBe(true);
    expect(rezeptHindernis(doc, 1200, 900)).toBeNull();
  });
});

describe('rezeptHindernis und die Unschärfe', () => {
  function mitBereich(unschaerfe: number): BildDoc {
    const doc = bild();
    doc.bereiche.push({
      id: 'b',
      name: 'Gesicht',
      aktiv: true,
      teile: [netzTeil()],
      anpassung: { ...bereichNeutral(), unschaerfe },
    });
    return doc;
  }

  it('hält einen weichgezeichneten Bereich zurück', () => {
    /*
     * Der Fall, den die erste Fassung der Regel übersehen hat – und der
     * gefährlichste von allen: Ein Gesicht mit einer Pinselmaske
     * weichzuzeichnen ist DER übliche Weg, es unkenntlich zu machen. Die
     * Regel sah nur Striche, Schrift, Zuschnitt und Neigung; ein Regler war
     * für sie harmlos.
     */
    expect(rezeptHindernis(mitBereich(0.6), 1200, 900)).toMatch(/unkenntlich/);
    expect(rezeptHindernis(mitBereich(1), 1200, 900)).toMatch(/unkenntlich/);
  });

  it('lässt einen Bereich ohne Unschärfe durch', () => {
    // Licht und Farbe ORDNEN Bildinhalt um, sie nehmen ihn nicht weg.
    const doc = mitBereich(0);
    doc.bereiche[0].anpassung.belichtung = -1.5;
    doc.bereiche[0].anpassung.saettigung = 0.8;
    expect(rezeptHindernis(doc, 1200, 900)).toBeNull();
  });
});

describe('das Punktebudget über das ganze Dokument', () => {
  /** Zählt alle Strichzahlen im Dokument – Malstriche und Pinselstriche. */
  function punkteImDoc(doc: BildDoc): number {
    let summe = 0;
    for (const s of doc.striche) summe += s.punkte.length;
    for (const b of doc.bereiche) {
      for (const t of b.teile) {
        if (t.art === 'pinsel') for (const s of t.striche) summe += s.punkte.length;
      }
    }
    return summe;
  }

  it('lässt eine echte Bearbeitung unangetastet durch', () => {
    const doc = bild();
    doc.striche.push({ farbe: '#fff', breite: 8, punkte: [10, 10, 20, 20, 30, 25], art: 'farbe' });
    doc.bereiche.push({
      id: 'b1',
      name: 'Bereich',
      aktiv: true,
      teile: [
        {
          id: 'p1',
          modus: 'dazu',
          umkehren: false,
          art: 'pinsel',
          striche: [{ punkte: [4, 4, 8, 9], breite: 40, haerte: 0.5, abziehen: false }],
        },
      ],
      anpassung: { belichtung: 0, kontrast: 0, saettigung: 0, waerme: 0, unschaerfe: 0 },
    } as unknown as BildDoc['bereiche'][number]);

    const zurueck = docAusRoh(docNachRoh(doc), 1200, 900);
    expect(punkteImDoc(zurueck)).toBe(10);
    expect(zurueck.striche[0].punkte).toEqual([10, 10, 20, 20, 30, 25]);
  });

  it('deckelt die Summe, auch wenn jede einzelne Liste im Rahmen bleibt', () => {
    /*
     * Keine Liste sprengt hier eine der Einzelgrenzen: zwanzig Zahlen je
     * Strich, vierhundert Striche je Teil, zwölf Teile, vier Bereiche. Erst
     * das Produkt – 384 000 Zahlen – liegt über dem Budget. Genau darum geht
     * es: Die Einzelgrenzen sind ein Rechenweg, solange sie sich
     * multiplizieren lassen.
     */
    const punkte = Array.from({ length: 20 }, (_, i) => i);
    const strich = { punkte, breite: 40, haerte: 0.5, abziehen: false };
    const teil = {
      id: 'p',
      modus: 'dazu',
      umkehren: false,
      art: 'pinsel',
      striche: Array.from({ length: REZEPT_GRENZEN.pinselstriche }, () => strich),
    };
    const roh = {
      ...docNachRoh(bild()),
      bereiche: Array.from({ length: REZEPT_GRENZEN.bereiche }, (_, i) => ({
        id: `b${i}`,
        name: 'Bereich',
        aktiv: true,
        teile: Array.from({ length: REZEPT_GRENZEN.teileJeBereich }, () => teil),
        anpassung: {},
      })),
    };

    const angeboten =
      REZEPT_GRENZEN.bereiche *
      REZEPT_GRENZEN.teileJeBereich *
      REZEPT_GRENZEN.pinselstriche *
      punkte.length;
    expect(angeboten, 'der Versuch muss das Budget überhaupt reissen').toBeGreaterThan(
      REZEPT_GRENZEN.punkteGesamt,
    );

    const doc = docAusRoh(roh, 1200, 900);
    expect(punkteImDoc(doc)).toBeLessThanOrEqual(REZEPT_GRENZEN.punkteGesamt);
  });

  it('teilt das Budget zwischen Malstrichen und Pinselstrichen', () => {
    // Ein einzelner Malstrich frisst das ganze Budget; für die Maske bleibt
    // nichts. Zwei getrennte Töpfe wären doppelt so viel Arbeit beim
    // Empfänger.
    const lang = Array.from({ length: REZEPT_GRENZEN.strichZahlen }, () => 5);
    const roh = {
      ...docNachRoh(bild()),
      striche: Array.from({ length: 20 }, () => ({
        farbe: '#fff',
        breite: 8,
        punkte: lang,
        art: 'farbe',
      })),
      bereiche: [
        {
          id: 'b1',
          name: 'Bereich',
          aktiv: true,
          teile: [
            {
              id: 'p1',
              modus: 'dazu',
              umkehren: false,
              art: 'pinsel',
              striche: [{ punkte: [1, 2, 3, 4], breite: 40, haerte: 0.5, abziehen: false }],
            },
          ],
          anpassung: {},
        },
      ],
    };

    const doc = docAusRoh(roh, 1200, 900);
    expect(punkteImDoc(doc)).toBeLessThanOrEqual(REZEPT_GRENZEN.punkteGesamt);
    const pinsel = doc.bereiche[0].teile[0];
    expect(pinsel.art === 'pinsel' && pinsel.striche.length).toBe(0);
  });

  it('schneidet keinen halben Punkt ab', () => {
    // Eine ungerade Liste wäre ein y ohne x. `punkte.length >> 1` übersähe
    // die letzte Zahl, und das Dokument trüge sie trotzdem mit sich herum.
    const roh = {
      ...docNachRoh(bild()),
      striche: [{ farbe: '#fff', breite: 8, punkte: [1, 2, 3, 4, 5], art: 'farbe' }],
    };
    const doc = docAusRoh(roh, 1200, 900);
    expect(doc.striche[0].punkte).toEqual([1, 2, 3, 4]);
  });
});
