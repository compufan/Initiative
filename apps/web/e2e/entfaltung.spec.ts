import { expect, test } from '@playwright/test';

/**
 * Die Entfaltung: holt sie wirklich etwas zurück – und rechnen beide Wege dasselbe?
 *
 * # Warum im Browser
 *
 * Weil der Weg, der in der App benutzt wird, WebGL 2 mit Gleitkommazielen
 * braucht. In Node gibt es davon nichts, und ihn nachzubauen hiesse, die
 * Nachbildung zu prüfen statt den Code.
 *
 * # Der Aufbau, und warum er so herum ist
 *
 * Geprüft wird nicht an einem unscharfen Foto – dann wüsste niemand, wie das
 * Ergebnis auszusehen hätte. Statt dessen wird ein scharfes Bild GEZIELT
 * unscharf gerechnet, mit genau dem Kern, den die Entfaltung hinterher
 * bekommt. Damit gibt es eine Wahrheit zum Vergleichen, und die Frage lautet:
 * Kommt das Ergebnis dem scharfen Bild näher als die Unschärfe, von der es
 * ausging?
 *
 * Das ist die Frage, auf die es ankommt. Zwei Verfahren, die dasselbe
 * rechnen, können beide falsch sein.
 */

interface Messung {
  unsymmetrisch: number;
  vorher: number;
  gpuGedreht: number;
  gpu: number;
  prozessor: number;
  abstand: number;
  abstandRand: number;
  msGpu: number;
  stuetzen: number;
  grenze: number;
}

test('die Entfaltung holt Schärfe zurück – auf beiden Wegen dieselbe', async ({ page }) => {
  await page.goto('/');

  const ergebnis = await page.evaluate<Messung | { fehler: string }>(async () => {
    const ladeCpu = '/src/modules/bild/entfaltung.ts';
    const ladeGpu = '/src/modules/bild/entfaltungGpu.ts';
    const ladeTon = '/src/modules/bild/ton.ts';
    const cpu = (await import(
      /* @vite-ignore */ ladeCpu
    )) as typeof import('../src/modules/bild/entfaltung.js');
    const gpu = (await import(
      /* @vite-ignore */ ladeGpu
    )) as typeof import('../src/modules/bild/entfaltungGpu.js');
    const ton = (await import(
      /* @vite-ignore */ ladeTon
    )) as typeof import('../src/modules/bild/ton.js');

    const B = 96;
    const H = 96;

    /*
     * Ein Bild mit Struktur auf mehreren Grössen: eine harte Kante, ein
     * Streifenmuster und eine Fläche. Ein Bild aus nur einer Kante wäre zu
     * nachsichtig – dort sieht jedes Verfahren gut aus.
     */
    const scharf = new Float32Array(B * H);
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < B; x += 1) {
        let wert = 0.25;
        if (x > B / 2) wert = 0.8;
        if (y > H * 0.6) wert = x % 6 < 3 ? 0.15 : 0.85;
        if (y < H * 0.2 && x < B * 0.3) wert = 0.5;
        scharf[y * B + x] = wert;
      }
    }

    const kern = cpu.punktbildBauen({ art: 'linie', laenge: 9, winkel: 25 });
    const stuetzen = cpu
      .punktbildBauen({ art: 'linie', laenge: 9, winkel: 25 })
      .werte.filter((w) => w !== 0).length;
    const grenze = gpu.stuetzenGrenze();
    if (grenze === 0) return { fehler: 'keine Grafikeinheit' };

    // Die „Beobachtung": das scharfe Bild durch genau diese Unschärfe.
    const verwischt = new Float32Array(B * H);
    cpu.falten(scharf, verwischt, B, H, kern, false);

    // Als 8-Bit-Bild im Anzeigeraum – so, wie es in der App ankäme.
    const daten = new Uint8ClampedArray(B * H * 4);
    for (let i = 0; i < B * H; i += 1) {
      const s = Math.round(ton.zuSrgb(verwischt[i]) * 255);
      daten[i * 4] = s;
      daten[i * 4 + 1] = s;
      daten[i * 4 + 2] = s;
      daten[i * 4 + 3] = 255;
    }
    const beobachtet = new ImageData(daten, B, H);

    const t0 = performance.now();
    const ausGpu = await gpu.entfaltenAufGpu({
      quelle: beobachtet,
      kern,
      iterationen: 30,
      daempfung: 0,
      saumRadius: 0,
    });
    const msGpu = performance.now() - t0;

    // Derselbe Lauf auf dem Prozessor, aus denselben 8-Bit-Werten.
    const alsLinear = new Float32Array(B * H);
    for (let i = 0; i < B * H; i += 1) alsLinear[i] = ton.zuLinear(daten[i * 4] / 255);
    const ausCpu = cpu.richardsonLucy(alsLinear, B, H, kern, 30, 0);

    /*
     * Gemessen wird im ANZEIGERAUM und am Rand vorbei.
     *
     * Der Anzeigeraum, weil dort auch geschaut wird: Ein Unterschied im
     * tiefen Schatten ist in linearem Licht riesig und im Bild unsichtbar.
     * Und am Rand vorbei, weil dort beide Wege spiegeln und die Spiegelung
     * eine Kante erfindet, die es im scharfen Bild nicht gibt – das wäre ein
     * Fehler des Aufbaus, nicht des Verfahrens.
     */
    const RAND = 12;
    const abweichung = (hole: (i: number) => number) => {
      let summe = 0;
      let anzahl = 0;
      for (let y = RAND; y < H - RAND; y += 1) {
        for (let x = RAND; x < B - RAND; x += 1) {
          const i = y * B + x;
          const soll = ton.zuSrgb(scharf[i]);
          const ist = hole(i);
          summe += (ist - soll) * (ist - soll);
          anzahl += 1;
        }
      }
      return Math.sqrt(summe / anzahl);
    };

    /*
     * Wie weit die beiden Wege auseinanderliegen – wahlweise INNEN oder nur
     * am RAND.
     *
     * Der Rand hat einen eigenen Wert, weil dort etwas anderes geprüft wird:
     * Beide Wege spiegeln am Bildrand (`MIRRORED_REPEAT` beziehungsweise die
     * Spiegelung von Hand in `falten`). Wer eine der beiden Seiten auf
     * „klemmen" umstellt, sieht das INNEN überhaupt nicht – dort greift keine
     * Randbehandlung – und am Rand sofort.
     */
    const wegeVergleichen = (nurRand: boolean) => {
      let summe = 0;
      let anzahl = 0;
      for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < B; x += 1) {
          const drin = y >= RAND && y < H - RAND && x >= RAND && x < B - RAND;
          if (drin === nurRand) continue;
          const i = y * B + x;
          const a = ausGpu.data[i * 4] / 255;
          const b = ton.zuSrgb(Math.min(1, Math.max(0, ausCpu[i])));
          summe += (a - b) * (a - b);
          anzahl += 1;
        }
      }
      return Math.sqrt(summe / anzahl);
    };

    /*
     * Und derselbe Vergleich mit einem UNSYMMETRISCHEN Kern.
     *
     * Der Rückweg von Richardson-Lucy faltet mit dem um seine Mitte
     * GEDREHTEN Kern. Bei einem Linienkern ist das Drehen wirkungslos – eine
     * Linie ist punktsymmetrisch, gedreht ist sie sie selbst. Dieselbe Lücke
     * steht schon im Prozessortest; hier schliesst sie ein von Hand gebauter
     * Kern in L-Form, bei dem das Drehen wirklich etwas ändert.
     */
    const unsymmetrisch = (() => {
      const werte = new Float32Array(25);
      // Eine L-Form: vier Punkte nach rechts, drei nach unten.
      for (const [x, y] of [
        [2, 2],
        [3, 2],
        [4, 2],
        [2, 3],
        [2, 4],
      ] as const) {
        werte[y * 5 + x] = 1;
      }
      let summe = 0;
      for (const w of werte) summe += w;
      for (let i = 0; i < werte.length; i += 1) werte[i] /= summe;
      return { werte, breite: 5, hoehe: 5, mx: 2, my: 2 };
    })();

    const verwischtL = new Float32Array(B * H);
    cpu.falten(scharf, verwischtL, B, H, unsymmetrisch, false);
    const datenL = new Uint8ClampedArray(B * H * 4);
    for (let i = 0; i < B * H; i += 1) {
      const c = Math.round(ton.zuSrgb(verwischtL[i]) * 255);
      datenL[i * 4] = c;
      datenL[i * 4 + 1] = c;
      datenL[i * 4 + 2] = c;
      datenL[i * 4 + 3] = 255;
    }
    const gpuL = await gpu.entfaltenAufGpu({
      quelle: new ImageData(datenL, B, H),
      kern: unsymmetrisch,
      iterationen: 30,
      daempfung: 0,
      saumRadius: 0,
    });
    const linearL = new Float32Array(B * H);
    for (let i = 0; i < B * H; i += 1) linearL[i] = ton.zuLinear(datenL[i * 4] / 255);
    const cpuL = cpu.richardsonLucy(linearL, B, H, unsymmetrisch, 30, 0);
    let summeL = 0;
    let anzahlL = 0;
    for (let y = RAND; y < H - RAND; y += 1) {
      for (let x = RAND; x < B - RAND; x += 1) {
        const i = y * B + x;
        const a = gpuL.data[i * 4] / 255;
        const b = ton.zuSrgb(Math.min(1, Math.max(0, cpuL[i])));
        summeL += (a - b) * (a - b);
        anzahlL += 1;
      }
    }

    return {
      unsymmetrisch: Math.sqrt(summeL / anzahlL),
      vorher: abweichung((i) => daten[i * 4] / 255),
      gpu: abweichung((i) => ausGpu.data[i * 4] / 255),
      gpuGedreht: abweichung((i) => {
        const y = Math.floor(i / B);
        const x = i % B;
        return ausGpu.data[((H - 1 - y) * B + x) * 4] / 255;
      }),
      prozessor: abweichung((i) => ton.zuSrgb(Math.min(1, Math.max(0, ausCpu[i])))),
      abstand: wegeVergleichen(false),
      abstandRand: wegeVergleichen(true),
      msGpu,
      stuetzen,
      grenze,
    };
  });

  if ('fehler' in ergebnis) {
    test.skip(true, `Entfaltung nicht prüfbar: ${ergebnis.fehler}`);
    return;
  }

  /*
   * Die Frage, auf die es ankommt: Ist das Ergebnis dem scharfen Bild NÄHER
   * als die Unschärfe, von der es ausging?
   *
   * Gemessen: Die Unschärfe liegt rund 0,10 daneben, beide Wege kommen auf
   * gut 0,05 – also etwa die Hälfte. Die Schranke steht bei drei Vierteln:
   * eng genug, dass ein Verfahren, das nichts tut (oder das Bild nur
   * durchreicht), durchfällt, und weit genug, dass sie nicht an der dritten
   * Nachkommastelle einer Grafikeinheit hängt.
   */
  expect(ergebnis.vorher, 'das verwischte Bild ist zu nah am Original').toBeGreaterThan(0.04);
  expect(
    ergebnis.gpu,
    `die Entfaltung bringt nichts: vorher ${ergebnis.vorher.toFixed(3)}, nachher ${ergebnis.gpu.toFixed(3)}`,
  ).toBeLessThan(ergebnis.vorher * 0.75);
  expect(ergebnis.prozessor).toBeLessThan(ergebnis.vorher * 0.75);

  /*
   * Und beide Wege dasselbe.
   *
   * Die Schranke ist 0,02 und nicht null: Die Grafikeinheit rechnet die
   * Zwischenbilder in halber Gleitkommagenauigkeit (rund drei Dezimalstellen)
   * und gibt acht Bit aus, der Prozessor rechnet durchgehend in einfacher.
   * Über dreissig multiplikative Durchgänge summiert sich das. 0,02 sind
   * fünf von 255 Stufen – deutlich unter dem, was man sieht, und weit unter
   * dem Unterschied, den ein FEHLER machen würde (ein verdrehter Kern,
   * fehlende Spiegelung am Rand: dort stünde 0,1 und mehr).
   */
  /*
   * Und die LAGE. Steht das Bild auf dem Kopf, sieht das Ergebnis aus wie ein
   * Fehler im Verfahren – genau so ist es beim ersten Anlauf gewesen: 0,228
   * statt 0,089, also schlechter als die Unschärfe, von der es ausging. Die
   * Faustregel „WebGL liest von unten nach oben" gilt gegenüber einer
   * Leinwand; hier heben sich Hochladen und Auslesen gegenseitig auf.
   */
  expect(ergebnis.gpuGedreht, 'das Ergebnis steht auf dem Kopf').toBeGreaterThan(ergebnis.gpu);

  expect(
    ergebnis.abstand,
    `Grafikeinheit und Prozessor rechnen verschieden: ${ergebnis.abstand.toFixed(4)}`,
  ).toBeLessThan(0.02);

  /*
   * Und am RAND ebenso.
   *
   * Das ist eine eigene Aussage: Innen gibt es keine Randbehandlung, also
   * sieht man dort nicht, ob die Grafikeinheit spiegelt oder klemmt.
   * Gemessen sind beide Zahlen gleich klein; stellt man eine Seite auf
   * Klemmen um, bleibt die innere Zahl stehen und diese springt.
   */
  /*
   * Die Schranke steht auf 0,016, und sie steht auf Messungen: richtig
   * gespiegelt 0,0116, mit `CLAMP_TO_EDGE` statt `MIRRORED_REPEAT` 0,0207.
   * Der erste Anlauf hatte hier 0,03 – weit genug, dass die Umstellung auf
   * Klemmen anstandslos durchging.
   */
  expect(
    ergebnis.abstandRand,
    `am Rand rechnen die Wege verschieden: ${ergebnis.abstandRand.toFixed(4)}`,
  ).toBeLessThan(0.016);

  /*
   * Und der unsymmetrische Kern. Ohne ihn wäre das Drehen im Rückweg
   * ungeprüft: Eine Linie gedreht ist sie selbst, und ein fehlendes Minus im
   * zweiten Durchgang fiele nirgends auf.
   */
  expect(
    ergebnis.unsymmetrisch,
    `mit unsymmetrischem Kern rechnen die Wege verschieden: ${ergebnis.unsymmetrisch.toFixed(4)}`,
  ).toBeLessThan(0.02);

  // Zum Mitlesen im Protokoll – die Zahlen, auf denen die Schranken stehen.
  console.log(
    `Entfaltung: vorher ${ergebnis.vorher.toFixed(3)}, GPU ${ergebnis.gpu.toFixed(3)}, ` +
      `Prozessor ${ergebnis.prozessor.toFixed(3)}, Abstand ${ergebnis.abstand.toFixed(4)} ` +
      `(Rand ${ergebnis.abstandRand.toFixed(4)}, L-Kern ${ergebnis.unsymmetrisch.toFixed(4)}), ` +
      `${ergebnis.msGpu.toFixed(0)} ms, ${ergebnis.stuetzen} Stützstellen (Grenze ${ergebnis.grenze})`,
  );
});
