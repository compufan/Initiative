import { expect, test } from '@playwright/test';

/**
 * Aus einem Video ein GIF – im echten Browser.
 *
 * # Warum das hier stehen MUSS und nicht in vitest
 *
 * Weil der ganze erste Abschnitt aus Dingen besteht, die es in Node nicht
 * gibt: ein `<video>`, ein Dekodierer, `currentTime`, `seeked`, `drawImage`.
 * Die Prüfungen in `src/modules/video/` decken das Rechenbare ab – die
 * Zielgrösse, die Zeitpunkte, die Bewegungsschätzung. Ob ein Sprung auf 0,4 s
 * wirklich das Bild von 0,4 s liefert, kann nur ein Browser beantworten.
 *
 * # Warum das Video hier entsteht
 *
 * Eine mitgelieferte Datei müsste in einem Format vorliegen, das Chromium
 * ohne Lizenz dekodiert – H.264 gehört nicht dazu. `MediaRecorder` schreibt
 * WebM, und das kann jeder Browser, der diese App überhaupt lädt.
 *
 * Nebenbei prüft das den unangenehmsten Fall gleich mit: Eine Datei aus
 * `MediaRecorder` hat im Kopf KEINE Länge. `duration` ist `Infinity`, und
 * ohne die Suche in `bilderLesen.ts` käme fünfzig Mal dasselbe Bild heraus.
 * Genau so entsteht auch jedes Video, das in dieser App aufgenommen wird.
 */

/** Ein Video, das seine Farbe wechselt – damit sich Bilder unterscheiden lassen. */
const AUFNEHMEN = `
  async (farben) => {
    const leinwand = document.createElement('canvas');
    leinwand.width = 160;
    leinwand.height = 120;
    const ctx = leinwand.getContext('2d');
    const malen = (farbe, ms) =>
      new Promise((auf) => {
        const ende = performance.now() + ms;
        const schritt = () => {
          ctx.fillStyle = farbe;
          ctx.fillRect(0, 0, leinwand.width, leinwand.height);
          if (performance.now() < ende) requestAnimationFrame(schritt);
          else auf();
        };
        schritt();
      });
    ctx.fillStyle = farben[0];
    ctx.fillRect(0, 0, leinwand.width, leinwand.height);
    const strom = leinwand.captureStream(25);
    const art = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((t) =>
      MediaRecorder.isTypeSupported(t),
    );
    const rekorder = new MediaRecorder(strom, art ? { mimeType: art } : undefined);
    const teile = [];
    rekorder.ondataavailable = (e) => { if (e.data.size > 0) teile.push(e.data); };
    const gestoppt = new Promise((auf) => { rekorder.onstop = () => auf(); });
    rekorder.start();
    for (const farbe of farben) await malen(farbe, 500);
    rekorder.stop();
    await gestoppt;
    strom.getTracks().forEach((spur) => spur.stop());
    return new Blob(teile, { type: art || 'video/webm' });
  }
`;

test('ein Sprung im Video trifft das Bild, das dort steht', async ({ page }) => {
  await page.goto('/');

  const ergebnis = await page.evaluate(async (aufnehmenCode) => {
    const lesen = '/src/modules/video/bilderLesen.ts';
    const modul = (await import(
      /* @vite-ignore */ lesen
    )) as typeof import('../src/modules/video/bilderLesen.js');
    const aufnehmen = eval(aufnehmenCode) as (farben: string[]) => Promise<Blob>;

    // Drei Abschnitte à 500 ms: rot, grün, blau.
    const datei = await aufnehmen(['#ff0000', '#00ff00', '#0000ff']);

    /*
     * Die Mitte jedes Abschnitts – nicht der Rand. An der Grenze zwischen
     * Rot und Grün entscheidet die Kodierung, welches Bild dort steht, und
     * eine Prüfung, die auf ein Zehntel genau sein muss, misst am Ende die
     * Laune des Kodierers.
     */
    const gelesen = await modul.videoBilderLesen(datei, {
      zeitpunkte: [250, 750, 1250],
      kante: 64,
    });

    const mitte = (bild: ImageData) => {
      const at = (Math.floor(bild.height / 2) * bild.width + Math.floor(bild.width / 2)) * 4;
      return [bild.data[at], bild.data[at + 1], bild.data[at + 2]];
    };

    return {
      anzahl: gelesen.bilder.length,
      farben: gelesen.bilder.map((bild) => mitte(bild.daten)),
      breite: gelesen.breite,
      hoehe: gelesen.hoehe,
      quellBreite: gelesen.quellBreite,
      quellHoehe: gelesen.quellHoehe,
      dauerMs: gelesen.dauerMs,
      verschieden: new Set(gelesen.bilder.map((bild) => mitte(bild.daten).join(','))).size,
    };
  }, AUFNEHMEN);

  expect(ergebnis.anzahl).toBe(3);

  /*
   * Der eigentliche Prüfstein. Ohne die Längensuche stünde `duration` auf
   * `Infinity`, jeder Sprung landete am Anfang, und alle drei Bilder wären
   * ROT – die Zahl der verschiedenen Farben wäre eins statt drei.
   */
  expect(ergebnis.verschieden, 'alle drei Bilder sehen gleich aus').toBe(3);
  expect(ergebnis.farben[0][0], 'das erste Bild ist nicht rot').toBeGreaterThan(160);
  expect(ergebnis.farben[1][1], 'das zweite Bild ist nicht grün').toBeGreaterThan(160);
  expect(ergebnis.farben[2][2], 'das dritte Bild ist nicht blau').toBeGreaterThan(160);

  // Die Länge wurde gefunden, obwohl sie im Kopf fehlt.
  expect(ergebnis.dauerMs).toBeGreaterThan(1200);
  expect(ergebnis.quellBreite).toBe(160);
  expect(ergebnis.quellHoehe).toBe(120);
  // Längere Kante auf 64, Seitenverhältnis erhalten, beide Kanten gerade.
  expect([ergebnis.breite, ergebnis.hoehe]).toEqual([64, 48]);
});

test('aus einem Video wird ein GIF, das der eigene Leser als bewegt erkennt', async ({ page }) => {
  await page.goto('/');

  const ergebnis = await page.evaluate(async (aufnehmenCode) => {
    const bauenPfad = '/src/modules/video/gifBauen.ts';
    const bewegtPfad = '/src/modules/stickers/bewegt.ts';
    const bauen = (await import(
      /* @vite-ignore */ bauenPfad
    )) as typeof import('../src/modules/video/gifBauen.js');
    const bewegt = (await import(
      /* @vite-ignore */ bewegtPfad
    )) as typeof import('../src/modules/stickers/bewegt.js');
    const aufnehmen = eval(aufnehmenCode) as (farben: string[]) => Promise<Blob>;
    const datei = await aufnehmen(['#ff0000', '#00ff00', '#0000ff']);

    const abschnitte: string[] = [];
    const anteile: number[] = [];
    const fertig = await bauen.gifAusVideo({
      datei,
      vonMs: 0,
      bisMs: 1000,
      bildrate: 10,
      /*
       * Ohne Freistellen. Das Netz läuft hier absichtlich NICHT: Es lädt ein
       * Modell über die Leitung, und eine Prüfung, die daran hängt, prüft
       * beim ersten Netzausfall den Netzausfall. Was das Zusammenspiel mit
       * dem Netz angeht, steht in `folgeMaske.test.ts`.
       */
      guete: {
        key: 'schnell',
        titel: 'Schnell',
        beschreibung: 'Prüfung',
        netz: 'person',
        schluesselAbstand: 1,
        kante: 64,
        jeNetzlaufMs: 36,
        brauchtGrafik: false,
      },
      freistellen: false,
      fortschritt: (anteil, abschnitt) => {
        anteile.push(anteil);
        if (abschnitte.at(-1) !== abschnitt) abschnitte.push(abschnitt);
      },
    });

    const roh = new Uint8Array(await fertig.blob.arrayBuffer());
    const lage = bewegt.bildlageAus(roh);
    return {
      typ: fertig.blob.type,
      bilder: fertig.bilder,
      breite: fertig.breite,
      hoehe: fertig.hoehe,
      laufzeitMs: fertig.laufzeitMs,
      groesse: roh.length,
      kopf: String.fromCharCode(...roh.subarray(0, 6)),
      gelesen: lage.bewegt ? { format: lage.format, teilbilder: lage.bilder } : null,
      abschnitte,
      steigend: anteile.every((wert, i) => i === 0 || wert >= anteile[i - 1]),
      zuletzt: anteile.at(-1) ?? 0,
    };
  }, AUFNEHMEN);

  expect(ergebnis.typ).toBe('image/gif');
  expect(ergebnis.kopf).toBe('GIF89a');
  expect(ergebnis.bilder).toBe(10);
  expect(ergebnis.laufzeitMs).toBe(1000);
  /*
   * 160 × 120 – also unverändert, und das ist der Punkt.
   *
   * Ohne Freistellen läuft kein Netz, und damit hat die Güte nichts mehr zu
   * sagen: Gerechnet wird in `VOLLBILD_KANTE` (384), und das Video ist
   * kleiner. Hochgerechnet wird nie – ein grösseres Bild hätte keinen Punkt
   * mehr Inhalt, im GIF aber viermal so viele zu packen.
   *
   * Hier stand einmal [64, 48], weil `gifBauen` die Kante der Güte nahm.
   * Das war die Grösse des Ergebnisses an einer Einstellung, die in der
   * Oberfläche gar nicht mehr sichtbar ist.
   */
  expect([ergebnis.breite, ergebnis.hoehe]).toEqual([160, 120]);

  /*
   * Gelesen wird mit dem EIGENEN Leser aus `bewegt.ts`. Der wurde für
   * hereinkommende Dateien geschrieben und weiss nichts von diesem Weg –
   * kommt beim Durchlaufen die richtige Zahl heraus, stimmt jede Länge,
   * jede Erweiterung und jeder Unterblock.
   */
  expect(ergebnis.gelesen).not.toBeNull();
  expect(ergebnis.gelesen?.format).toBe('gif');
  expect(ergebnis.gelesen?.teilbilder).toBe(10);

  // Ohne Freistellen bleibt der mittlere Abschnitt aus – und der Balken läuft
  // trotzdem von vorn bis hinten durch.
  expect(ergebnis.abschnitte).toEqual(['lesen', 'schreiben']);
  expect(ergebnis.steigend, 'der Balken springt zurück').toBe(true);
  expect(ergebnis.zuletzt).toBeCloseTo(1, 5);
});

test('ein Abbruch wirft nicht weg, was schon fertig war', async ({ page }) => {
  await page.goto('/');

  const ergebnis = await page.evaluate(async (aufnehmenCode) => {
    const bauenPfad = '/src/modules/video/gifBauen.ts';
    const bauen = (await import(
      /* @vite-ignore */ bauenPfad
    )) as typeof import('../src/modules/video/gifBauen.js');
    const aufnehmen = eval(aufnehmenCode) as (farben: string[]) => Promise<Blob>;
    const datei = await aufnehmen(['#ff0000', '#00ff00', '#0000ff']);

    const steuerung = new AbortController();
    try {
      await bauen.gifAusVideo({
        datei,
        vonMs: 0,
        bisMs: 1400,
        bildrate: 20,
        guete: {
          key: 'schnell',
          titel: 'Schnell',
          beschreibung: 'Prüfung',
          netz: 'person',
          schluesselAbstand: 1,
          kante: 64,
          jeNetzlaufMs: 36,
          brauchtGrafik: false,
        },
        freistellen: false,
        fortschritt: (anteil, abschnitt) => {
          // Mitten im Lesen abbrechen – dort ist noch etwas zu retten.
          if (abschnitt === 'lesen' && anteil > 0.25) steuerung.abort();
        },
        abbruch: steuerung.signal,
      });
      return { geworfen: false, abschnitt: '', fertigeBilder: -1 };
    } catch (ausfall) {
      const bau = ausfall as InstanceType<typeof bauen.BauAbbruch>;
      return {
        geworfen: bau instanceof bauen.BauAbbruch,
        abschnitt: bau.abschnitt ?? '',
        fertigeBilder: bau.fertigeBilder ?? -1,
      };
    }
  }, AUFNEHMEN);

  expect(ergebnis.geworfen, 'der Abbruch kam nicht als BauAbbruch an').toBe(true);
  expect(ergebnis.abschnitt).toBe('lesen');
  /*
   * Die Zahl ist der Punkt: Damit kann die Oberfläche „Aus den ersten n
   * Bildern trotzdem ein GIF?" anbieten, statt die Arbeit wegzuwerfen.
   */
  expect(ergebnis.fertigeBilder).toBeGreaterThan(0);
  expect(ergebnis.fertigeBilder).toBeLessThan(28);
});
