import { expect, test } from '@playwright/test';

/**
 * Die Farbrechnung steht zweimal: in TypeScript (`ton.ts`) und in GLSL
 * (`tonGpu.ts`). Das ist die einzige Verdopplung im ganzen Vorhaben, und sie
 * hat einen Grund – ein Foto mit zwölf Millionen Bildpunkten sechzigmal in
 * der Sekunde durchzurechnen, kann kein Prozessor.
 *
 * Zwei Fassungen derselben Formel driften auseinander, meist an dem Tag, an
 * dem niemand hinsieht. Deshalb dieser Test: ein Testbild aus 4096 Farben
 * durch beide Wege, Bildpunkt für Bildpunkt verglichen. Er ist die
 * Rechtfertigung dafür, dass es die zweite Fassung überhaupt geben darf.
 *
 * Er braucht keinen Anmeldevorgang und keine Datenbank – nur eine Seite, auf
 * der die Bündel der App geladen sind.
 */

/** Elf Einstellungen: einzeln, in Kombination und an den Anschlägen. */
const FAELLE: Record<string, Record<string, number>>[] = [];

test('GLSL und TypeScript rechnen dieselben Farben', async ({ page }) => {
  void FAELLE;
  await page.goto('/');

  const ergebnis = await page.evaluate(async () => {
    /*
     * Über die Adresse und nicht über einen festen Import: Der Test läuft im
     * Browser gegen den Entwicklungsserver, der `/src/...` von sich aus
     * übersetzt. Der Pfad steht in einer Variablen, damit TypeScript ihn
     * nicht aufzulösen versucht – die Typen kommen aus dem `as` daneben.
     */
    const ladeTon = '/src/modules/bild/ton.ts';
    const ladeGpu = '/src/modules/bild/tonGpu.ts';
    const ton = (await import(
      /* @vite-ignore */ ladeTon
    )) as typeof import('../src/modules/bild/ton.js');
    const gpu = (await import(
      /* @vite-ignore */ ladeGpu
    )) as typeof import('../src/modules/bild/tonGpu.js');

    // Ein Testbild, das den Farbwürfel gleichmässig abtastet: 64 × 64
    // Bildpunkte, 4096 Farben, darunter alle acht Ecken.
    const kante = 64;
    const quelle = document.createElement('canvas');
    quelle.width = kante;
    quelle.height = kante;
    const qctx = quelle.getContext('2d');
    if (!qctx) return { fehler: 'keine Leinwand' };
    const bild = qctx.createImageData(kante, kante);
    for (let i = 0; i < kante * kante; i += 1) {
      // 16 Stufen je Kanal, im Zickzack über die Fläche verteilt.
      const r = (i % 16) * 17;
      const g = (Math.floor(i / 16) % 16) * 17;
      const b = (Math.floor(i / 256) % 16) * 17;
      bild.data[i * 4] = r;
      bild.data[i * 4 + 1] = g;
      bild.data[i * 4 + 2] = b;
      bild.data[i * 4 + 3] = 255;
    }
    qctx.putImageData(bild, 0, 0);

    const faelle: { name: string; a: import('../src/modules/bild/ton.js').Anpassung }[] = [
      { name: 'nur Belichtung +1', a: { ...ton.NEUTRAL, belichtung: 1 } },
      { name: 'nur Belichtung −2', a: { ...ton.NEUTRAL, belichtung: -2 } },
      { name: 'nur Kontrast +0,7', a: { ...ton.NEUTRAL, kontrast: 0.7 } },
      { name: 'nur Kontrast −0,7', a: { ...ton.NEUTRAL, kontrast: -0.7 } },
      { name: 'Lichter −1', a: { ...ton.NEUTRAL, lichter: -1 } },
      { name: 'Tiefen +1', a: { ...ton.NEUTRAL, tiefen: 1 } },
      { name: 'Schwarz +0,8', a: { ...ton.NEUTRAL, schwarz: 0.8 } },
      { name: 'Schwarz −0,8', a: { ...ton.NEUTRAL, schwarz: -0.8 } },
      { name: 'warm', a: { ...ton.NEUTRAL, waerme: 0.8, toenung: -0.4 } },
      { name: 'kühl', a: { ...ton.NEUTRAL, waerme: -0.8, toenung: 0.6 } },
      { name: 'Sättigung ±', a: { ...ton.NEUTRAL, saettigung: -0.6, dynamik: 0.9 } },
      {
        name: 'alles zusammen',
        a: {
          ...ton.NEUTRAL,
          belichtung: 0.6,
          kontrast: 0.35,
          lichter: -0.5,
          tiefen: 0.45,
          schwarz: 0.2,
          waerme: 0.3,
          toenung: -0.2,
          saettigung: 0.25,
          dynamik: 0.4,
        },
      },
      {
        name: 'alle Anschläge',
        a: {
          ...ton.NEUTRAL,
          belichtung: 3,
          kontrast: 1,
          lichter: 1,
          tiefen: 1,
          schwarz: -1,
          waerme: 1,
          toenung: 1,
          saettigung: 1,
          dynamik: 1,
        },
      },
    ];

    const berichte: { name: string; max: number; mittel: number }[] = [];
    const wege = new Set<string>();
    for (const fall of faelle) {
      const flaeche = gpu.getoentesBild(quelle, kante, kante, fall.a);
      wege.add(gpu.letzterWeg);
      if (flaeche === quelle) break;
      const zctx = document.createElement('canvas').getContext('2d', {
        willReadFrequently: true,
      });
      if (!zctx) return { fehler: 'keine Leinwand' };
      zctx.canvas.width = kante;
      zctx.canvas.height = kante;
      zctx.drawImage(flaeche as CanvasImageSource, 0, 0);
      const raus = zctx.getImageData(0, 0, kante, kante).data;

      let max = 0;
      let summe = 0;
      let n = 0;
      for (let i = 0; i < kante * kante; i += 1) {
        const soll = ton.tonPunkt(
          [bild.data[i * 4] / 255, bild.data[i * 4 + 1] / 255, bild.data[i * 4 + 2] / 255],
          fall.a,
        );
        for (let k = 0; k < 3; k += 1) {
          const fehler = Math.abs(raus[i * 4 + k] - soll[k] * 255);
          max = Math.max(max, fehler);
          summe += fehler;
          n += 1;
        }
      }
      berichte.push({ name: fall.name, max, mittel: summe / n });
    }
    return { wege: [...wege], berichte };
  });

  // Ohne WebGL2 sagt der Test das laut, statt still durchzugehen: Der
  // Rückfallweg würde die Grenze unten zwar ebenfalls reissen, aber die
  // Meldung hiesse dann „Formel weicht ab“ statt „hier gibt es keine
  // Grafikeinheit“.
  expect(ergebnis.fehler).toBeUndefined();
  expect(ergebnis.wege, 'es hat nicht die Grafikeinheit gerechnet').toEqual(['gpu']);
  expect(ergebnis.berichte?.length).toBe(13);

  for (const bericht of ergebnis.berichte ?? []) {
    /*
     * Zwei Stufen von 255 – das ist der Rundungsspielraum zwischen einer
     * Rechnung in `highp float` auf der Grafikeinheit und einer in `double`
     * im Prozessor, plus dem Weg durch acht Bit je Kanal. Alles darüber ist
     * ein echter Unterschied in der Formel.
     */
    expect(bericht.max, `${bericht.name}: grösster Fehler`).toBeLessThanOrEqual(2);
    expect(bericht.mittel, `${bericht.name}: mittlerer Fehler`).toBeLessThan(0.6);
  }
});

test('ohne Grafikeinheit rechnet der Prozessor dasselbe', async ({ page }) => {
  /*
   * Der Rückfallweg. Er benutzt die Farbtabelle aus `ton.ts` und ist damit
   * etwas ungenauer als die Rechnung selbst – nachgemessen unter sechs
   * Stufen von 255 im schlimmsten Fall, im Mittel unter einer halben. Der
   * Test hält ihn dort fest: Wer die Tabelle verkleinert oder die Achse
   * begradigt, sieht es hier.
   */
  await page.goto('/');
  const ergebnis = await page.evaluate(async () => {
    const ladeTon = '/src/modules/bild/ton.ts';
    const ton = (await import(
      /* @vite-ignore */ ladeTon
    )) as typeof import('../src/modules/bild/ton.js');
    const a = { ...ton.NEUTRAL, belichtung: 0.6, kontrast: 0.35, tiefen: 0.45, saettigung: 0.25 };
    const lut = ton.lutBauen(a);
    let max = 0;
    let summe = 0;
    let n = 0;
    for (let r = 0; r <= 255; r += 15) {
      for (let g = 0; g <= 255; g += 15) {
        for (let b = 0; b <= 255; b += 15) {
          const soll = ton.tonPunkt([r / 255, g / 255, b / 255], a);
          const ist = ton.lutAnwenden(lut, r, g, b);
          for (let k = 0; k < 3; k += 1) {
            const fehler = Math.abs(ist[k] - soll[k] * 255);
            max = Math.max(max, fehler);
            summe += fehler;
            n += 1;
          }
        }
      }
    }
    return { max, mittel: summe / n };
  });
  expect(ergebnis.max).toBeLessThan(6);
  expect(ergebnis.mittel).toBeLessThan(0.5);
});

test('die Tonwerte kommen im fertigen Bild an – auch unter einem Verpixel-Strich', async ({
  page,
}) => {
  /*
   * Der Weg vom Regler bis ins Ergebnis, ohne Bedienoberfläche.
   *
   * Drei Fallen stecken darin, und alle drei sind schon zugeschnappt:
   *
   * 1. Die Tonwerte müssen im fertigen Bild landen, nicht nur in der Vorschau.
   * 2. `unkenntlich` liest einen Ausschnitt aus dem Quellbild. Seit dort das
   *    getönte Bild steht – und das in Arbeitsgrösse, nicht in voller – muss
   *    der Ausschnitt umgerechnet werden. Deshalb ist das Testbild 4000
   *    Punkte breit: Die Ausgabe deckelt bei 2560, der Massstab ist also
   *    0,64, und ein nicht umgerechneter Ausschnitt läse anderthalb mal zu
   *    weit rechts – hier mitten in der hellen Hälfte.
   * 3. Der Weichzeichner merkt sich sein Ergebnis je Strich. Deshalb wird
   *    hier DERSELBE Strich zweimal gezeichnet, einmal ohne und einmal mit
   *    Belichtung. Fiele der Merkzettel nicht, verpixelte der zweite Durchgang
   *    weiter das dunkle Foto von vorhin.
   */
  await page.goto('/');
  const ergebnis = await page.evaluate(async () => {
    const ladeTon = '/src/modules/bild/ton.ts';
    const ladeDoc = '/src/modules/bild/doc.ts';
    const ladeZeichnen = '/src/modules/bild/zeichnen.ts';
    const ton = (await import(
      /* @vite-ignore */ ladeTon
    )) as typeof import('../src/modules/bild/ton.js');
    const doc = (await import(
      /* @vite-ignore */ ladeDoc
    )) as typeof import('../src/modules/bild/doc.js');
    const zeichnen = (await import(
      /* @vite-ignore */ ladeZeichnen
    )) as typeof import('../src/modules/bild/zeichnen.js');

    // Zwei klar getrennte Hälften: links dunkel, rechts hell. Breit genug,
    // dass die Ausgabe verkleinert – genau dann greift `quellSkala`.
    const W = 4000;
    const H = 1000;
    const quelle = document.createElement('canvas');
    quelle.width = W;
    quelle.height = H;
    const qctx = quelle.getContext('2d');
    if (!qctx) return { fehler: 'keine Leinwand' };
    qctx.fillStyle = 'rgb(60, 60, 60)';
    qctx.fillRect(0, 0, W / 2, H);
    qctx.fillStyle = 'rgb(200, 200, 200)';
    qctx.fillRect(W / 2, 0, W / 2, H);

    const lesen = (leinwand: HTMLCanvasElement, anteilX: number) => {
      const ctx = leinwand.getContext('2d', { willReadFrequently: true });
      const x = Math.round(leinwand.width * anteilX);
      const y = Math.round(leinwand.height / 2);
      const d = ctx?.getImageData(x, y, 1, 1).data;
      return d ? [d[0], d[1], d[2]] : [-1, -1, -1];
    };

    // EIN Strichobjekt, das in beiden Durchgängen dasselbe bleibt – nur so
    // wird der Merkzettel überhaupt befragt.
    const strich = {
      farbe: '#000000',
      breite: 300,
      punkte: [1200, 500, 1700, 500],
      art: 'pixel' as const,
    };

    const grund = { ...doc.neuesDoc(W, H), striche: [strich] };
    const ohne = zeichnen.zeichneAusgabe(quelle, W, H, grund);
    const hell = { ...grund, anpassung: { ...ton.NEUTRAL, belichtung: 1 } };
    const mit = zeichnen.zeichneAusgabe(quelle, W, H, hell);

    const sollDunkel = ton.tonPunkt([60 / 255, 60 / 255, 60 / 255], hell.anpassung);
    return {
      massstab: ohne.width / W,
      // 0,35 der Breite ist Quellpunkt 1400 – mitten im Strich (1050 … 1850)
      // und noch weit von der hellen Hälfte (ab 2000) entfernt. Wer den
      // Ausschnitt nicht umrechnet, liest bei 1400 / 0,64 = 2188 und damit
      // schon im Hellen.
      ohneUnterStrich: lesen(ohne, 0.35),
      ohneNeben: lesen(ohne, 0.8),
      mitUnterStrich: lesen(mit, 0.35),
      mitNeben: lesen(mit, 0.8),
      sollDunkel: sollDunkel.map((v) => Math.round(v * 255)),
    };
  });

  expect(ergebnis.fehler).toBeUndefined();
  // Die Ausgabe ist wirklich verkleinert – sonst prüfte Falle 2 nichts.
  expect(ergebnis.massstab).toBeLessThan(0.7);

  // Ohne Regler bleibt unter dem Strich das dunkle Grau stehen: Eine
  // gleichmässige Fläche bleibt beim Verpixeln gleichmässig.
  expect(Math.abs((ergebnis.ohneUnterStrich?.[0] ?? 0) - 60)).toBeLessThanOrEqual(3);
  expect(Math.abs((ergebnis.ohneNeben?.[0] ?? 0) - 200)).toBeLessThanOrEqual(3);

  // Mit einer Blende mehr steht dort der getönte Wert – rund 85, nicht 60
  // und nicht 120. Eine Blende ist doppeltes Licht, kein doppelter Zahlenwert.
  expect(ergebnis.sollDunkel?.[0]).toBeGreaterThan(80);
  expect(ergebnis.sollDunkel?.[0]).toBeLessThan(90);
  expect(
    Math.abs((ergebnis.mitUnterStrich?.[0] ?? 0) - (ergebnis.sollDunkel?.[0] ?? 0)),
  ).toBeLessThanOrEqual(3);
  expect(ergebnis.mitNeben?.[0]).toBeGreaterThan(230);
});

test('das Foto geht einmal auf die Grafikeinheit, nicht bei jeder Reglerraste', async ({
  page,
}) => {
  /*
   * Ein Bestandsfehler, gefunden beim Entwurf von Stufe 4.
   *
   * `aufGpu` lud bei JEDEM Bild das ganze Foto neu in die Textur. Bei
   * 4000 × 3000 sind das zwölf Megapixel, also rund 48 MB über den Bus – je
   * Reglerraste, und ein Reglerzug macht davon Dutzende. Der Merkzettel eine
   * Ebene darüber half nicht: Er verfehlt ja gerade dann, wenn sich der
   * Regler bewegt.
   *
   * Gezählt statt gemessen: Eine Zeitmessung an dieser Stelle wäre auf einem
   * ausgelasteten Bauserver launisch, ein Zähler ist es nie.
   */
  await page.goto('/');
  const ergebnis = await page.evaluate(async () => {
    const ladeTon = '/src/modules/bild/ton.ts';
    const ladeGpu = '/src/modules/bild/tonGpu.ts';
    const ton = (await import(
      /* @vite-ignore */ ladeTon
    )) as typeof import('../src/modules/bild/ton.js');
    const gpu = (await import(
      /* @vite-ignore */ ladeGpu
    )) as typeof import('../src/modules/bild/tonGpu.js');

    const quelle = document.createElement('canvas');
    quelle.width = 4000;
    quelle.height = 3000;
    const qctx = quelle.getContext('2d');
    if (!qctx) return { fehler: 'keine Leinwand' };
    qctx.fillStyle = '#5a5a5a';
    qctx.fillRect(0, 0, 4000, 3000);

    // Arbeitsgrösse wie in der Ansicht: 1200 lange Kante.
    const bw = 1200;
    const bh = 900;
    // Einmal vorweg, damit der Zähler nur den Reglerzug misst.
    gpu.getoentesBild(quelle, bw, bh, { ...ton.NEUTRAL, belichtung: 0.01 });
    const vorher = gpu.zaehler.quellHochladen;
    for (let i = 1; i <= 20; i += 1) {
      gpu.getoentesBild(quelle, bw, bh, { ...ton.NEUTRAL, belichtung: i / 20 });
    }
    const nachRegler = gpu.zaehler.quellHochladen - vorher;

    // Eine andere Arbeitsgrösse (das Speichern) muss dagegen neu hochladen.
    gpu.getoentesBild(quelle, 2560, 1920, { ...ton.NEUTRAL, belichtung: 0.5 });
    const nachGroesse = gpu.zaehler.quellHochladen - vorher - nachRegler;

    return { weg: gpu.letzterWeg, nachRegler, nachGroesse };
  });

  expect(ergebnis.fehler).toBeUndefined();
  expect(ergebnis.weg, 'ohne Grafikeinheit zählt der Test nichts').toBe('gpu');
  // Zwanzig Reglerrasten, ein Hochladen.
  expect(ergebnis.nachRegler).toBe(0);
  // Aber eine neue Arbeitsgrösse braucht wirklich eine neue Textur.
  expect(ergebnis.nachGroesse).toBe(1);
});
