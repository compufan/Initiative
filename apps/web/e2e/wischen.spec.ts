import {
  expect,
  test,
  type Browser,
  type CDPSession,
  type Locator,
  type Page,
} from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

import {
  abschnitteDazu,
  auswerten,
  editorOeffnen,
  lageLesen,
  bitmapEntfernen,
  maskeAnlegen,
  maskeFertig,
  maskeVerfolgt,
  median,
  pruefvideoSchreiben,
  schreiberEinsetzen,
  schwarzWeiss,
  seiteLaden,
  speicherWarten,
  sprungSetzen,
  wischStand,
  zugAufzeichnen,
  type Auswertung,
  type SeitenWahl,
  type VideoWahl,
} from './wischenHilfe.js';

/**
 * Flüssiges Wischen durch die Zeitleiste – im echten Browser, mit echten
 * Zeigerereignissen.
 *
 * Die Bitte war: „Beim Ziehen mit dem Finger durch die Zeitleiste sollte das
 * live Video flüssiger mitlaufen (das Bild anzeigen, auf dem der Finger
 * gerade liegt) und dabei auch die Masken anzeigen."
 *
 * # Was vorher war
 *
 * Gemessen (`messung-vorher.md`): Das Bild unter dem Finger kam im Mittel 6 –
 * 126 Filmbilder zu spät, 2 – 11-mal je Sekunde; die bearbeitete Vorschau
 * zeichnete beim Wischen GAR NICHT (an jedem Bildrückruf stand das Video im
 * Sprung), Masken erschienen erst, wenn der Finger ruhte.
 *
 * # Was hier geprüft wird
 *
 * Der Wischspeicher (`wischspeicher.ts`) füllt sich grob zu fein im
 * Hintergrund; beim Wischen kommt das Bild aus ihm statt aus Sprüngen des
 * Videos – mit Bearbeitung und Masken.
 *
 * # Warum die Schwellen so stehen
 *
 * Der Rechner ist geteilt (Streuung bis 1,5-fach, bei Last sinkt schon die
 * Zahl der Zeigerereignisse, die den Browser erreichen: gemessen 17 – 60 je
 * Sekunde statt 60), und die Grafik der Testumgebung ist Software – eine
 * bearbeitete Zeichnung kostet hier 30 – 230 ms, auf einem Telefon
 * einstellig. Darum stehen Raten im Verhältnis zu dem, was überhaupt
 * ankommt (Zeigerereignisse je Sekunde, Zeichenzeit), und Abstände in
 * Bildern dort, wo sie etwas messen (langsame Bewegung); beim schnellen
 * Wischen zählt das Alter des Bildes. Jede Schwelle liegt eine
 * Grössenordnung vom Wert vorher entfernt: Ein Rückfall auf den alten Weg
 * (2 – 3 Bilder je Sekunde, 0 Zeichnungen, Bildalter Ø 450 ms) fiele durch.
 *
 * # Wie die Prüfung aufgebaut ist
 *
 * Ein Prüfvideo mit Strichcode in jedem Bild (`wischenHilfe.ts`) und ein
 * Sprungschalter, der jeden Sprung auf 250 ms verlangsamt (nur im Testcode):
 * Headless Chromium springt in einem kleinen Video viel schneller als ein
 * Telefon. Der Speicher wird bei Sprungzeit 0 gefüllt – bei 250 ms dauerte es
 * anderthalb Minuten – und danach wird gewischt. Mit `WISCH_ROH=<Ordner>`
 * landen die Rohdaten jedes Laufs zum Nachsehen dort.
 */

const OHNE_KODIERER = 'Kein Videokodierer in diesem Browser';
const BILDER = 300;
const S = 40;
/** So lange dauert im Zug jeder Sprung des Videos (der Schalter verlangsamt jeden). */
const SPRUNG_MS = 250;

interface Aufbau {
  readonly page: Page;
  readonly cdp: CDPSession;
  readonly editor: Locator;
  readonly bilder: number;
}

interface AufbauWahl {
  bearbeitet: boolean;
  video?: VideoWahl;
  seite?: SeitenWahl;
  strichcode?: boolean;
  maske?: boolean;
  /** Wie viele Abschnitte dazu (4: 5 + 2 + 2 + 2 + 1 s bei 12 s). */
  abschnitte?: number;
}

/**
 * Das Blatt mit dem Prüfvideo öffnen, den Editor aufmachen, vier Abschnitte
 * dazu (5 + 2 + 2 + 2 + 1 s) – auf Wunsch mit Schwarz-Weiss, damit die
 * bearbeitete Vorschau über dem Video liegt. `null` ohne Videokodierer.
 */
async function aufbauen(page: Page, wahl: AufbauWahl): Promise<Aufbau | null> {
  await seiteLaden(page, wahl.seite);
  const bilder = wahl.video?.bilder ?? BILDER;
  const dauer = await pruefvideoSchreiben(page, 'film', {
    gop: 100,
    ...wahl.video,
    bilder,
    quadrat: wahl.maske ? true : wahl.video?.quadrat,
  });
  if (dauer < 0) return null;
  // Wann welche Stufe erreicht ist – vom ersten Füllauftrag an gerechnet.
  await page.evaluate(() => {
    const fe = window as unknown as {
      __stufenZeiten: Array<number | null>;
      __wisch?: { stufe: number; fertig: boolean };
    };
    fe.__stufenZeiten = [null, null, null, null, null];
    let t0: number | null = null;
    const uhr = setInterval(() => {
      const haken = fe.__wisch;
      if (!haken) return;
      t0 ??= performance.now();
      for (let stufe = 0; stufe < 5; stufe += 1) {
        if (haken.stufe >= stufe && fe.__stufenZeiten[stufe] === null) {
          fe.__stufenZeiten[stufe] = (performance.now() - t0) / 1000;
        }
      }
      if (haken.fertig) clearInterval(uhr);
    }, 20);
  });
  const editor = await editorOeffnen(page, 'film');
  if (wahl.bearbeitet) await schwarzWeiss(editor);
  const dazu = wahl.abschnitte ?? 4;
  if (dazu > 0) await abschnitteDazu(editor, dazu);
  await schreiberEinsetzen(page, { strichcode: wahl.strichcode ?? false, maske: wahl.maske });
  const cdp = await page.context().newCDPSession(page);
  return { page, cdp, editor, bilder };
}

async function stufenZeiten(page: Page): Promise<Array<number | null>> {
  return page.evaluate(
    () => (window as unknown as { __stufenZeiten: Array<number | null> }).__stufenZeiten,
  );
}

/** Einen Zug aufzeichnen und auswerten. */
async function lauf(
  aufbau: Aufbau,
  szene: string,
  sprungMs = 0,
  toleranz = 2,
  mittenImHalten?: () => Promise<unknown>,
  maskeBereich?: { vonK: number; bisK: number },
): Promise<{ a: Auswertung; roh: Awaited<ReturnType<typeof zugAufzeichnen>> }> {
  const roh = await zugAufzeichnen(aufbau.page, aufbau.cdp, szene, {
    sprungMs,
    bilder: aufbau.bilder,
    s: S,
    mittenImHalten,
  });
  // Zum Nachsehen: Mit WISCH_ROH=<Ordner> landen die Rohdaten jedes Laufs dort.
  if (process.env.WISCH_ROH) {
    mkdirSync(process.env.WISCH_ROH, { recursive: true });
    writeFileSync(
      `${process.env.WISCH_ROH}/${szene}-${sprungMs}-${Date.now()}.json`,
      JSON.stringify(roh),
    );
  }
  const a = auswerten(roh, toleranz, maskeBereich);
  if (!a) throw new Error(`Lauf ${szene} ohne Zeigerereignisse`);
  return { a, roh };
}

/** Eine Zeile für die Meldung eines fehlgeschlagenen Vergleichs. */
const zeige = (a: Auswertung) =>
  JSON.stringify(a, (_k, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v));

/**
 * Wie viele verschiedene Bilder je Sekunde mindestens erwartet werden: 25,
 * aber nie mehr als die Hälfte dessen, was an Zeigerereignissen überhaupt
 * ankam (bei Last 17 – 60 je Sekunde) – und nie weniger als 8, denn der
 * alte Weg schaffte 2 – 3.
 */
const mindestRate = (a: Auswertung) => Math.max(8, Math.min(25, 0.5 * a.ereignisseJeS));

/* ---------- Roh: ohne Bearbeitung ---------- */

test.describe('Wischen aus dem Speicher – ohne Bearbeitung', () => {
  test.describe.configure({ mode: 'serial' });
  let aufbau: Aufbau | null = null;
  let page: Page;
  let heapVorher: number | null = null;

  test.beforeAll(async ({ browser }, info) => {
    test.setTimeout(420_000);
    page = await browser.newPage({
      baseURL: info.project.use.baseURL,
      viewport: { width: 412, height: 880 },
    });
    aufbau = await aufbauen(page, { bearbeitet: false });
    if (!aufbau) return;
    heapVorher = await page.evaluate(
      () =>
        (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
          ?.usedJSHeapSize ?? null,
    );
    // Alle Stufen: Die Tests unten setzen einen gefüllten Speicher voraus.
    await speicherWarten(page, 4, 300_000);
  });

  test.afterAll(async () => {
    await page?.close();
  });

  test.beforeEach(() => {
    test.skip(aufbau === null, OHNE_KODIERER);
  });

  test('der Wischspeicher füllt sich grob zu fein und bleibt unter seiner Grenze', async () => {
    /*
     * Stufe 0 (jedes 16. Bild) ist nach 1 – 3 s da, Stufe 2 (jedes 4.) nach
     * 4 – 10 s, alles nach 15 – 18 s (gemessen, GOP 25, 1280 × 720; GOP 100:
     * 2 – 2,4 / 8 – 10 / 42 s). Hier mit grosszügigem Abstand: Der Rechner ist
     * geteilt, und die Verfolgung teilt sich den Dekodierer mit dem Füllen.
     */
    const zeiten = await stufenZeiten(page);
    const stand = await wischStand(page);
    expect(stand?.verfuegbar, 'Speicher verfügbar').toBe(true);
    expect(stand?.format, 'Format der kleinen Bilder').toMatch(/^image\/(webp|jpeg)$/);
    expect(stand?.fertig).toBe(true);
    expect(stand?.bilder, 'alle Bilder des Films').toBe(BILDER);
    // Jede Stufe kommt nach der vorigen – grob zu fein.
    for (let stufe = 1; stufe < 5; stufe += 1) {
      expect(zeiten[stufe] ?? 0, `Stufe ${stufe} nach Stufe ${stufe - 1}`).toBeGreaterThanOrEqual(
        zeiten[stufe - 1] ?? 0,
      );
    }
    expect(zeiten[0], `Stufe 0 nach ${zeiten[0]} s`).toBeLessThanOrEqual(10);
    expect(zeiten[2], `Stufe 2 nach ${zeiten[2]} s`).toBeLessThanOrEqual(40);
    expect(zeiten[4], `alles nach ${zeiten[4]} s`).toBeLessThanOrEqual(150);
    // 300 Bilder des Prüfvideos wiegen rund 3 MB – höchstens 5; die Grenze selbst sind 24 MiB.
    expect(stand?.bytes, 'Bytes der kleinen Bilder').toBeLessThanOrEqual(5_000_000);
    expect(stand?.bytes).toBeLessThanOrEqual(24 * 1024 * 1024);
    expect(stand?.entpackt, 'entpackte Bilder').toBeLessThanOrEqual(8);
    // Der Heap der Seite (nur Chromium): Die kleinen Bilder liegen als Blobs, nicht im Heap.
    const heapNachher = await page.evaluate(
      () =>
        (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
          ?.usedJSHeapSize ?? null,
    );
    if (heapVorher !== null && heapNachher !== null) {
      expect(
        (heapNachher - heapVorher) / 1024 / 1024,
        'Zuwachs des JS-Heaps in MB',
      ).toBeLessThanOrEqual(40);
    }
  });

  test('beim schnellen Wischen wechselt das Bild mindestens 25-mal je Sekunde', async () => {
    test.setTimeout(240_000);
    if (!aufbau) return;
    /*
     * Vorher: 2 – 3 verschiedene Bilder je Sekunde bei Sprüngen von 250 ms
     * (`schnell`) und 2 – 2,5 bei `langsam`. Jetzt kommt jedes Bild aus dem
     * Speicher; erwartet sind 25 und mehr (bei 60 Zeigerereignissen je
     * Sekunde 45 – 59). Der Median von drei Läufen, weil der Rechner geteilt
     * ist; bei Last kommen weniger Ereignisse an (siehe `mindestRate`).
     */
    await sprungSetzen(page, SPRUNG_MS);
    const schnell: Auswertung[] = [];
    for (let i = 0; i < 3; i += 1) schnell.push((await lauf(aufbau, 'schnell', SPRUNG_MS)).a);
    const rate = median(schnell.map((a) => a.bilderJeS));
    const soll = median(schnell.map(mindestRate));
    expect(
      rate,
      `schnell: ${schnell.map((a) => `${a.bilderJeS.toFixed(1)} bei ${a.ereignisseJeS.toFixed(0)} Ereignissen`).join(' / ')}`,
    ).toBeGreaterThanOrEqual(soll);
    const langsam = (await lauf(aufbau, 'langsam', SPRUNG_MS)).a;
    expect(langsam.bilderJeS, `langsam: ${zeige(langsam)}`).toBeGreaterThanOrEqual(
      mindestRate(langsam),
    );
  });

  test('das Bild unter dem Finger ist höchstens zwei Filmbilder entfernt – und nicht alt', async () => {
    test.setTimeout(240_000);
    if (!aufbau) return;
    /*
     * Vorher: Verspätung Ø 6 – 126 Bilder (grösster 204), Bildalter Ø 120 –
     * 580 ms, 95 % bis 843 ms. Bei 300 Bildern in der Sekunde (`schnell`)
     * sind zwei Bilder 7 ms – weniger als ein Anzeigetakt; dort zählt das
     * Alter, nicht der Abstand in Bildern (gemessen Ø 15 – 40 ms). Bei `langsam`
     * (46 Bilder/s) zählt der Abstand: gemessen Ø 0,9, 95 % ≤ 2 – die Schwellen sind weit genug
     * für einen geteilten Rechner (ein einzelner Ausreisser nach einer
     * Verzögerung des Rechners zählt nicht: kein Höchstwert) und immer noch
     * eine Grössenordnung unter dem Vorher (Ø 23 / 95 % bei 31).
     */
    const langsam = await lauf(aufbau, 'langsam', SPRUNG_MS);
    expect(langsam.a.spaetP95, `langsam: ${zeige(langsam.a)}`).toBeLessThanOrEqual(6);
    expect(langsam.a.spaetMittel, `langsam: ${zeige(langsam.a)}`).toBeLessThanOrEqual(4);
    for (const name of ['schnell', 'hinher']) {
      const l = await lauf(aufbau, name, SPRUNG_MS);
      // Das Alter misst vom Eintreffen des Ereignisses im Browser an – ein belasteter Rechner
      // verzögert schon die Zustellung: Ø und 95 % mit Abstand, beides weit unter dem Vorher.
      expect(l.a.alterMittelMs ?? 9999, `${name}: ${zeige(l.a)}`).toBeLessThanOrEqual(100);
      expect(l.a.alterP95Ms ?? 9999, `${name}: ${zeige(l.a)}`).toBeLessThanOrEqual(250);
    }
    // Deterministisch, für jede Zeichnung: Bei vollem Speicher ist es genau das Bild unter dem Finger.
    const hin = await lauf(aufbau, 'hinher', SPRUNG_MS);
    expect(hin.a.speicherZeichnungen, zeige(hin.a)).toBeGreaterThan(20);
    expect(hin.a.zielAbweichungMax, `hinher: ${zeige(hin.a)}`).toBe(0);
  });

  test('das sichtbare Video springt beim Wischen nicht – und kein dritter Dekodierer öffnet sich', async () => {
    test.setTimeout(240_000);
    if (!aufbau) return;
    /*
     * Während des Zugs sprang genau ein Videoelement (das sichtbare), beim
     * Loslassen kam der Leser dazu: zwei Dekodierer. Mit gefülltem Speicher
     * springt das sichtbare Video im Zug gar nicht, der Leser nicht (das
     * Füllen ruht und die Verfolgung hat nichts zu lesen), und es kommt
     * kein dritter dazu.
     */
    for (const name of ['schnell', 'langsam']) {
      const l = await lauf(aufbau, name, SPRUNG_MS);
      expect(l.a.videoSpruenge, `${name}: Sprünge des sichtbaren Videos im Zug`).toBe(0);
      expect(l.a.elemente, `${name}: Videoelemente, die springen`).toBeLessThanOrEqual(2);
      expect(l.a.verfolgerLesen ?? 0, `${name}: Lesungen der Verfolgung im Zug`).toBe(0);
    }
  });

  test('nach dem Loslassen steht das genaue Bild', async () => {
    test.setTimeout(240_000);
    if (!aufbau) return;
    /*
     * (a) Das Bild der Loslassstelle (±2 Filmbilder) steht sofort da – vorher
     * 120 – 687 ms bis irgendein richtiges Bild. (b) Der Editor zeigt sein
     * Standbild mit dem Strichcode der Loslassstelle – vorher in 1 von 20
     * Läufen das falsche – binnen D + 800 ms bei GOP 100 (gemessen vorher
     * 369 – 687 ms inklusive D).
     */
    const nachUp: number[] = [];
    for (const name of ['schnell', 'langsam', 'hinher']) {
      const l = await lauf(aufbau, name, SPRUNG_MS);
      expect(l.a.bisNachUpMs, `${name}: Loslassen → Bild: ${zeige(l.a)}`).not.toBeNull();
      expect(l.a.bisNachUpMs ?? 9999, `${name}: Loslassen → Bild`).toBeLessThanOrEqual(250);
      nachUp.push(l.a.bisNachUpMs ?? 9999);
      expect(
        l.a.stillbildRichtig,
        `${name}: Standbild ${l.a.stillbild} statt ${l.a.sollStillbild}`,
      ).toBe(true);
      expect(l.a.bisEditorMs ?? 99999, `${name}: Loslassen → Editor`).toBeLessThanOrEqual(
        SPRUNG_MS + 800,
      );
    }
    expect(median(nachUp), `Loslassen → Bild: ${nachUp.join(' / ')}`).toBeLessThanOrEqual(120);
  });

  test('bleibt der Finger liegen, wird das Bild scharf', async () => {
    test.setTimeout(240_000);
    if (!aufbau) return;
    /*
     * Der Finger liegt still: (a) das Bild der Fingerstelle steht binnen
     * 250 ms da (vorher 67 – 892 ms), (b) danach wird das Videobild scharf:
     * Der Sprung beginnt 100 ms nach der letzten Bewegung, das Bild kommt
     * D später und wird gezeichnet.
     */
    const l = await lauf(aufbau, 'stopp', SPRUNG_MS);
    expect(l.a.bisRichtigStillMs, `stopp: ${zeige(l.a)}`).not.toBeNull();
    expect(l.a.bisRichtigStillMs ?? 9999, 'Stillstand → richtiges Bild').toBeLessThanOrEqual(250);
    expect(l.a.schaerfeMs, `scharfes Bild nach dem Nachschärfen: ${zeige(l.a)}`).not.toBeNull();
    expect(l.a.schaerfeMs ?? 99999, 'Stillstand → scharfes Bild').toBeLessThanOrEqual(
      100 + SPRUNG_MS + 800,
    );
    expect(l.a.stillbildRichtig, `Standbild ${l.a.stillbild} statt ${l.a.sollStillbild}`).toBe(
      true,
    );
  });

  test('die Vorschau friert beim Wischen nicht ein', async () => {
    test.setTimeout(240_000);
    if (!aufbau) return;
    /*
     * Vorher: In einem von zwei belasteten Läufen zeigte die Leinwand 3 s
     * lang EIN Bild, während der Finger über den Film zog (Bildalter Ø
     * 1571 ms). Jetzt in keinem von vier Läufen mit Bildalter Ø über 300 ms.
     */
    for (let i = 0; i < 4; i += 1) {
      const l = await lauf(aufbau, 'hinher', 0);
      expect(l.a.alterMittelMs ?? 9999, `Lauf ${i}: ${zeige(l.a)}`).toBeLessThanOrEqual(300);
    }
  });

  test('Schliessen räumt alles', async () => {
    test.setTimeout(120_000);
    if (!aufbau) return;
    const hakenVorher = await wischStand(page);
    expect(hakenVorher?.bilder).toBeGreaterThan(0);
    await page.evaluate(() =>
      (window as unknown as { __blatt: { weg: () => void } }).__blatt.weg(),
    );
    await page.waitForTimeout(2000);
    const nachher = await wischStand(page);
    expect(nachher?.bilder, 'Bilder').toBe(0);
    expect(nachher?.bytes, 'Bytes').toBe(0);
    expect(nachher?.entpackt, 'entpackte Bilder').toBe(0);
    const rest = await page.evaluate(() => {
      const w = window as unknown as {
        __lebende: () => number;
        __offeneAdressen: () => number;
        __sprung: { protokoll: Array<{ w: string; t: number }> };
      };
      const jetzt = performance.now();
      return {
        videos: w.__lebende(),
        adressen: w.__offeneAdressen(),
        // Nach dem Schliessen darf nichts mehr springen.
        spaetereSprunge: w.__sprung.protokoll.filter((x) => x.w === 'seeking' && x.t > jetzt - 1800)
          .length,
      };
    });
    expect(rest.videos, 'Dekodierer (Videoelemente ausserhalb des Dokuments) mit Quelle').toBe(0);
    expect(rest.adressen, 'nicht freigegebene Adressen').toBe(0);
    expect(rest.spaetereSprunge, 'Sprünge nach dem Schliessen').toBe(0);
  });
});

/* ---------- Mit Bearbeitung ---------- */

test.describe('Wischen aus dem Speicher – mit Bearbeitung', () => {
  test.describe.configure({ mode: 'serial' });
  let aufbau: Aufbau | null = null;
  let page: Page;

  test.beforeAll(async ({ browser }, info) => {
    test.setTimeout(420_000);
    page = await browser.newPage({
      baseURL: info.project.use.baseURL,
      viewport: { width: 412, height: 880 },
    });
    aufbau = await aufbauen(page, { bearbeitet: true, strichcode: true });
    // Stufe 3 (jedes 2. Bild) genügt: Dann liegt zu jeder Stelle ein Bild höchstens eines daneben.
    if (aufbau) await speicherWarten(page, 3, 300_000);
  });

  test.afterAll(async () => {
    await page?.close();
  });

  test.beforeEach(() => {
    test.skip(aufbau === null, OHNE_KODIERER);
  });

  test('beim Wischen ist die Bearbeitung zu sehen, nicht das rohe Video', async () => {
    test.setTimeout(240_000);
    if (!aufbau) return;
    /*
     * Vorher: 0 % der Takte, 0,0 Zeichnungen je Sekunde – an jedem
     * Bildrückruf stand das Video im Sprung, der Anwender sah das ROHE Video.
     * Jetzt liegt die bearbeitete Leinwand im Zug in (fast) jedem Takt über
     * dem Video, und sie ist grau (Schwarz-Weiss). Wie viele Zeichnungen es
     * je Sekunde werden, hängt an der Zeichenzeit (`__vorschau.zeichenMs`,
     * hier Software-Grafik) und daran, wie viele Zeigerereignisse
     * ankommen: je Ereignis höchstens eine Zeichnung.
     */
    await sprungSetzen(page, SPRUNG_MS);
    for (const [name, anteil] of [
      ['langsam', 0.95],
      ['schnell', 0.9],
    ] as const) {
      const l = await lauf(aufbau, name, SPRUNG_MS, 2);
      const zeichenMs = Number(l.roh.vorschau.zeichenMs ?? 100);
      const soll = Math.max(4, 0.5 * Math.min(l.a.ereignisseJeS, 1000 / Math.max(1, zeichenMs)));
      expect(l.a.bearbeitetAnteil ?? 0, `${name}: ${zeige(l.a)}`).toBeGreaterThanOrEqual(anteil);
      expect(l.a.grauAnteil ?? 0, `${name}: grau – ${zeige(l.a)}`).toBeGreaterThanOrEqual(0.95);
      expect(
        l.a.gezeichnetJeS,
        `${name}: Zeichnungen je Sekunde bei ${zeichenMs.toFixed(0)} ms – ${zeige(l.a)}`,
      ).toBeGreaterThanOrEqual(soll);
      // Und es ist das richtige Bild: Der Strichcode der Leinwand ist das gemeldete Bild.
      expect(l.a.falschAnteil ?? 0, `${name}: falsches Bild – ${zeige(l.a)}`).toBeLessThanOrEqual(
        0.02,
      );
    }
  });

  test('mit Bearbeitung ist das Bild unter dem Finger nahe und nicht alt', async () => {
    test.setTimeout(240_000);
    if (!aufbau) return;
    const l = await lauf(aufbau, 'langsam', SPRUNG_MS, 2);
    const zeichenMs = Number(l.roh.vorschau.zeichenMs ?? 100);
    // Bearbeitet: das Alter darf die Zeichenzeit kosten – vorher Ø 120 – 580 ms bei Sprüngen von 250 ms.
    expect(l.a.alterP95Ms ?? 9999, `langsam: ${zeige(l.a)}`).toBeLessThanOrEqual(
      100 + 3 * zeichenMs,
    );
    // Stufe ≥ 3: höchstens ein Bild daneben, in JEDER Zeichnung.
    expect(l.a.zielAbweichungMax ?? 99, zeige(l.a)).toBeLessThanOrEqual(1);
    expect(l.a.naheAnteil ?? 0, `Strichcode nahe am Finger – ${zeige(l.a)}`).toBeGreaterThanOrEqual(
      0.7,
    );
  });
});

/* ---------- Mit Masken ---------- */

test.describe('Wischen aus dem Speicher – mit Masken', () => {
  test.describe.configure({ mode: 'serial' });
  let aufbau: Aufbau | null = null;
  let page: Page;

  test.beforeAll(async ({ browser }, info) => {
    test.setTimeout(420_000);
    page = await browser.newPage({
      baseURL: info.project.use.baseURL,
      viewport: { width: 412, height: 880 },
    });
    // 1280 × 720 wie in der Messung: Bei der halben Auflösung verlor die Verfolgung das Quadrat zeitweise.
    aufbau = await aufbauen(page, {
      bearbeitet: false,
      maske: true,
      video: { gop: 25, breite: 1280, hoehe: 720 },
    });
    if (!aufbau) return;
    await speicherWarten(page, 3, 300_000);
    // Eine Maske auf das Quadrat, noch nicht überall verfolgt: Das ist der Zustand der ersten Sekunden.
    await maskeAnlegen(page, aufbau.editor);
    await maskeFertig(aufbau.editor);
  });

  test.afterAll(async () => {
    await page?.close();
  });

  test.beforeEach(() => {
    test.skip(aufbau === null, OHNE_KODIERER);
  });

  test('wo die Maske noch nicht verfolgt ist, sagt die Zeile es', async () => {
    test.setTimeout(240_000);
    if (!aufbau) return;
    /*
     * Der Finger liegt bei 60 % des Films, weit vom Stellbild (Bild 275),
     * an dem die Maske angelegt wurde – dorthin hat die Verfolgung in den
     * ersten Sekunden noch nicht gefunden. Es wird nichts erfunden: Dort
     * erscheint das Bild ohne Maske, und die Zeile nennt sie mit Namen.
     */
    const l = await lauf(aufbau, 'stopp', 0, 2, async () =>
      page.evaluate(() => ({
        zeile: document.querySelector('.bild-editor .bild-wiedergabe-zeile')?.textContent ?? null,
        fehlend:
          (window as unknown as { __vorschau?: { fehlend?: string[] } }).__vorschau?.fehlend ?? [],
        bahn: document.querySelector('.bild-editor .mb-leinwand')?.getAttribute('aria-label'),
      })),
    );
    const halten = l.roh.halten as { zeile: string | null; fehlend: string[] } | null;
    expect(halten?.zeile ?? '', `Zeile über dem Bild: ${JSON.stringify(halten)}`).toMatch(
      /wird an diesem Bild noch verfolgt und erscheint kurz nach dem Loslassen/,
    );
    expect(halten?.fehlend.length, 'fehlende Masken am gezeigten Bild').toBe(1);
  });

  test('beim Wischen ist die Maske zu sehen, wo sie verfolgt wurde – und die Verfolgung bleibt ungebremst', async () => {
    test.setTimeout(420_000);
    if (!aufbau) return;
    /*
     * Vorher: 0 % der Takte beim Wischen, Masken erst, wenn der Finger ruhte.
     * Jetzt zeigt jedes gezeichnete Bild die Maske seines Rasterbildes: Das
     * Quadrat ist entsättigt. Und dass das Füllen die Verfolgung bremst, wäre
     * der Preis: Vorher war sie nach 27 – 33 s überall, erlaubt sind hier
     * zwei Minuten (geteilter Rechner, Füllen und Verfolgung teilen sich
     * den Dekodierer).
     */
    const { sekunden, bahn } = await maskeVerfolgt(aufbau.editor, 300_000);
    console.log(`Maske überall verfolgt nach ${sekunden.toFixed(0)} s (mit Füllen): ${bahn}`);
    expect(sekunden, 'Zeit bis die Maske überall verfolgt ist').toBeLessThanOrEqual(120);
    /*
     * Gemessen wird dort, wo die Verfolgung das Quadrat sicher hat: nahe am
     * Stellbild (Bild 275), an dem die Maske angetippt wurde. Weit davon
     * läuft sie auf diesem künstlichen Film zeitweise an einem Nachbarn
     * davon – das sieht man gleich am Standbild des Editors und ist Sache
     * der Verfolgung, nicht des Wischens. Hier zählt, dass der Zug die Maske
     * zeigt, wo sie da ist.
     */
    const bereich = { vonK: 190, bisK: 296 };
    await sprungSetzen(page, SPRUNG_MS);
    for (const name of ['langsam', 'schnell']) {
      const l = await lauf(aufbau, name, SPRUNG_MS, 2, undefined, bereich);
      // Das schnelle Wischen dauert eine Sekunde: Bei einem überlasteten Rechner (7 Ereignisse je
      // Sekunde gemessen) fällt dort gar keine Probe in den Bereich – dann gibt es nichts zu zählen.
      if (name === 'langsam') expect(l.a.maskeAnteil, `${name}: ${zeige(l.a)}`).not.toBeNull();
      if (l.a.maskeAnteil !== null) {
        expect(l.a.maskeAnteil, `${name}: Maske sichtbar – ${zeige(l.a)}`).toBeGreaterThanOrEqual(
          0.9,
        );
      }
      expect(l.a.verfolgerLesen ?? 0, `${name}: Lesungen der Verfolgung im Zug`).toBe(0);
    }
  });
  test('im Zug sitzt die Maske wie am Standbild – an denselben Bildern', async () => {
    test.setTimeout(240_000);
    if (!aufbau) return;
    /*
     * Bild und Maske gehören zum selben Rasterbild: Was der Zug an Bild k
     * zeigt, ist dieselbe Zeichnung wie das Standbild des Editors an Bild k –
     * mit der Maske, wo die Verfolgung sie hat, ohne sie, wo nicht (auf
     * diesem Film läuft die Verfolgung zwischen Bild 30 und 160 an dem
     * Quadrat vorbei: Beides kommt vor). Verglichen wird die Sättigung in
     * der Mitte des Quadrats.
     */
    await maskeVerfolgt(aufbau.editor, 300_000);
    await sprungSetzen(page, 0);
    const lage = await lageLesen(page);
    const film = lage.gesamtMs / lage.umfangMs;
    const xFuer = (k: number) =>
      lage.links + 1 + ((k * S + S / 2) / lage.gesamtMs) * film * (lage.breite - 2);
    const probe = (wahl: string) =>
      page.evaluate((w) => {
        const f = window as unknown as {
          __maskenProbe: (w: string, k: number) => number;
          __vorschau: { letzteK: number; aus: string };
        };
        return {
          k: f.__vorschau.letzteK,
          aus: f.__vorschau.aus,
          px: f.__maskenProbe(w, f.__vorschau.letzteK),
        };
      }, wahl);
    const gesehen: Array<{ k: number; zug: number; still: number }> = [];
    for (const k of [60, 110, 150, 210, 250]) {
      await page.mouse.move(xFuer(Math.max(2, k - 40)), lage.y);
      await page.mouse.down();
      for (let i = 1; i <= 8; i += 1) {
        await page.mouse.move(
          xFuer(Math.max(2, k - 40) + ((k - Math.max(2, k - 40)) * i) / 8),
          lage.y,
        );
        await page.waitForTimeout(20);
      }
      // Kurz nach dem letzten Ereignis: das Bild aus dem Speicher – oder, wenn der Treiber länger
      // brauchte, schon das scharfe aus dem Video; die Maske muss an beiden sitzen.
      await page.waitForTimeout(50);
      const zug = await probe('.bild-editor canvas.bild-wiedergabe-bild');
      await page.mouse.up();
      await expect(aufbau.editor.locator('.bild-wiedergabe')).toBeHidden({ timeout: 30_000 });
      await page.waitForTimeout(300);
      const still = await page.evaluate(
        ([w, bild]) =>
          (window as unknown as { __maskenProbe: (w: string, k: number) => number }).__maskenProbe(
            w as string,
            bild as number,
          ),
        ['.bild-editor canvas.bild-leinwand', zug.k] as const,
      );
      gesehen.push({ k: zug.k, zug: zug.px, still });
    }
    const text = JSON.stringify(gesehen);
    /*
     * Dreimal Sättigung: unter 40 ist das Quadrat entsättigt (Maske da), ab 140
     * ist es grün (keine Maske), dazwischen liegt der Rand der weichen Maske
     * – dort entscheidet die Auflösung (der Zug zeichnet kleiner), und es
     * wird nichts verglichen. Klar verschieden darf es nicht sein.
     */
    const klar = (px: number) => (px < 40 ? 'mit' : px >= 140 ? 'ohne' : 'rand');
    const vergleichbar = gesehen.filter((g) => klar(g.zug) !== 'rand' && klar(g.still) !== 'rand');
    for (const g of vergleichbar) {
      expect(klar(g.zug), `Bild ${g.k}: Zug ${g.zug}, Standbild ${g.still} – ${text}`).toBe(
        klar(g.still),
      );
    }
    // Verglichen wurde etwas, und es war auch eine Maske dabei – sonst prüfte der Vergleich nichts.
    expect(vergleichbar.length, text).toBeGreaterThanOrEqual(2);
    expect(
      vergleichbar.some((g) => klar(g.still) === 'mit'),
      text,
    ).toBe(true);
  });
});

/* ---------- Ohne Speicher: wie bisher, aber ohne Einfrieren ---------- */

test.describe('Wischen ohne Speicher – wie bisher, aber ohne Einfrieren', () => {
  test.describe.configure({ mode: 'serial' });
  let aufbau: Aufbau | null = null;
  let page: Page;

  test.beforeAll(async ({ browser }, info) => {
    test.setTimeout(420_000);
    page = await browser.newPage({
      baseURL: info.project.use.baseURL,
      viewport: { width: 412, height: 880 },
    });
    // Der Speicher bleibt leer (`__wisch.aus`): Das ist der Zustand der ersten Sekunden nach dem Öffnen.
    aufbau = await aufbauen(page, {
      bearbeitet: true,
      seite: { speicherAus: true },
      video: { gop: 25 },
    });
  });

  test.afterAll(async () => {
    await page?.close();
  });

  test.beforeEach(() => {
    test.skip(aufbau === null, OHNE_KODIERER);
  });

  test('vor dem Füllen wischt es wie bisher: das Video läuft mit', async () => {
    test.setTimeout(240_000);
    if (!aufbau) return;
    /*
     * Kein Rückschritt: Deckt der Speicher nicht, springt das Video wie
     * früher. Vorher (GOP 25, Sprünge 250 ms, langsam): 2,5 Bilder je
     * Sekunde, Bildalter Ø 509 ms – hier dasselbe, nicht schlechter als das
     * Doppelte.
     */
    await sprungSetzen(page, SPRUNG_MS);
    const l = await lauf(aufbau, 'langsam', SPRUNG_MS);
    expect((await wischStand(page))?.bilder, 'Bilder im Speicher').toBe(0);
    expect(l.a.videoSpruenge, `Sprünge des Videos im Zug: ${zeige(l.a)}`).toBeGreaterThanOrEqual(5);
    expect(l.a.bilderJeS, `Bilder je Sekunde: ${zeige(l.a)}`).toBeGreaterThanOrEqual(1);
    expect(l.a.alterMittelMs ?? 9999, `Bildalter: ${zeige(l.a)}`).toBeLessThanOrEqual(1100);
    expect(l.a.stillbildRichtig, `Standbild ${l.a.stillbild} statt ${l.a.sollStillbild}`).toBe(
      true,
    );
  });

  test('die Vorschau friert auch ohne Speicher nicht ein', async () => {
    test.setTimeout(240_000);
    if (!aufbau) return;
    /*
     * Vorher blieb die bearbeitete Leinwand in einem von zwei belasteten
     * Läufen 3 s lang auf EINEM Bild (Bildalter Ø 1571 ms), während der
     * Finger über den Film zog. Jetzt weicht die Leinwand dem rohen Video,
     * wenn das gezeigte Bild nicht mehr zum Finger gehört: ohne
     * Einfrieren, Bildalter Ø wie das rohe Video (vorher 135 ms bei GOP 25).
     */
    await sprungSetzen(page, 0);
    for (let i = 0; i < 4; i += 1) {
      const l = await lauf(aufbau, 'hinher', 0);
      expect(l.a.alterMittelMs ?? 9999, `Lauf ${i}: ${zeige(l.a)}`).toBeLessThanOrEqual(400);
    }
  });
});

/* ---------- Ausweichen: wo der Browser etwas nicht kann ---------- */

/** Ein kurzes Prüfvideo, das Blatt offen, im Editor – nach `vorher` mit der entfernten Fähigkeit. */
async function kurz(
  browser: Browser,
  baseURL: string | undefined,
  seite: SeitenWahl,
  vorher?: (page: Page) => Promise<void>,
): Promise<{ page: Page; aufbau: Aufbau } | null> {
  const page = await browser.newPage({ baseURL, viewport: { width: 412, height: 880 } });
  await seiteLaden(page, seite);
  const dauer = await pruefvideoSchreiben(page, 'film', { gop: 25, bilder: 60 });
  if (dauer < 0) {
    await page.close();
    return null;
  }
  await vorher?.(page);
  const editor = await editorOeffnen(page, 'film');
  await schreiberEinsetzen(page, { strichcode: false });
  const cdp = await page.context().newCDPSession(page);
  return { page, aufbau: { page, cdp, editor, bilder: 60 } };
}

test.describe('Wischen, wo der Browser kleine Bilder nicht kodiert', () => {
  test('liefert die Leinwand statt WebP ein PNG, nimmt der Speicher JPEG', async ({
    browser,
  }, info) => {
    test.setTimeout(180_000);
    const rig = await kurz(browser, info.project.use.baseURL, { pngStattWebp: true });
    test.skip(rig === null, OHNE_KODIERER);
    if (!rig) return;
    try {
      await speicherWarten(rig.page, 0, 60_000);
      const stand = await wischStand(rig.page);
      expect(stand?.verfuegbar).toBe(true);
      expect(stand?.format, 'Format der kleinen Bilder').toBe('image/jpeg');
      expect(stand?.bilder).toBeGreaterThan(0);
    } finally {
      await rig.page.close();
    }
  });

  test('kodiert der Browser keine kleinen Bilder, wischt es wie bisher – ohne Fehler', async ({
    browser,
  }, info) => {
    test.setTimeout(180_000);
    const rig = await kurz(browser, info.project.use.baseURL, { keineKleinenBilder: true });
    test.skip(rig === null, OHNE_KODIERER);
    if (!rig) return;
    const fehler: string[] = [];
    rig.page.on('pageerror', (e) => fehler.push(String(e)));
    try {
      await rig.page.waitForFunction(
        () =>
          (window as unknown as { __wisch?: { verfuegbar: boolean } }).__wisch?.verfuegbar ===
          false,
        null,
        { timeout: 60_000 },
      );
      const stand = await wischStand(rig.page);
      expect(stand?.bilder, 'Bilder im Speicher').toBe(0);
      const l = await lauf(rig.aufbau, 'langsam', 0);
      expect(
        l.a.videoSpruenge,
        `das Video springt wie bisher: ${zeige(l.a)}`,
      ).toBeGreaterThanOrEqual(3);
      expect(l.a.stillbildRichtig, `Standbild ${l.a.stillbild} statt ${l.a.sollStillbild}`).toBe(
        true,
      );
      expect(fehler, 'Fehler der Seite').toEqual([]);
    } finally {
      await rig.page.close();
    }
  });

  test('ohne createImageBitmap entpackt ein Bildelement – das Wischen kommt trotzdem aus dem Speicher', async ({
    browser,
  }, info) => {
    test.setTimeout(240_000);
    const rig = await kurz(browser, info.project.use.baseURL, {}, bitmapEntfernen);
    test.skip(rig === null, OHNE_KODIERER);
    if (!rig) return;
    try {
      await speicherWarten(rig.page, 4, 120_000);
      const l = await lauf(rig.aufbau, 'langsam', 0);
      expect(
        l.a.speicherZeichnungen,
        `Zeichnungen aus dem Speicher: ${zeige(l.a)}`,
      ).toBeGreaterThan(5);
      expect(l.a.zielAbweichungMax ?? 99, zeige(l.a)).toBe(0);
    } finally {
      await rig.page.close();
    }
  });
});

/* ---------- Die Grenze in Bytes ---------- */

test.describe('Der Wischspeicher bleibt unter seiner Grenze', () => {
  test('Rauschen: die Bilder wiegen ein Vielfaches – es wird verdrängt, das Wischen geht weiter', async ({
    browser,
  }, info) => {
    test.setTimeout(300_000);
    const budget = 1.5 * 1024 * 1024;
    const page = await browser.newPage({
      baseURL: info.project.use.baseURL,
      viewport: { width: 412, height: 880 },
    });
    try {
      /*
       * Jedes Bild neues Zufallsrauschen: 30 – 80 KB je kleinem Bild, 120 Bilder
       * wögen 4 – 10 MB. Mit einer Grenze von 1,5 MB (`__wisch.budget`, nur im
       * Test) muss verdrängt werden – nach Nutzen für die Abdeckung, nicht
       * nach „zuletzt gebraucht" –, und das Wischen geht weiter.
       */
      const aufbau = await aufbauen(page, {
        bearbeitet: false,
        seite: { budget },
        video: { rauschen: true, bilder: 120, gop: 25 },
        abschnitte: 0,
      });
      test.skip(aufbau === null, OHNE_KODIERER);
      if (!aufbau) return;
      await speicherWarten(page, 0, 120_000);
      let hoechstens = 0;
      for (let i = 0; i < 12; i += 1) {
        await page.waitForTimeout(500);
        hoechstens = Math.max(hoechstens, (await wischStand(page))?.bytes ?? 0);
      }
      const stand = await wischStand(page);
      expect(hoechstens, 'Bytes der kleinen Bilder').toBeLessThanOrEqual(budget);
      expect(stand?.bilder, 'Bilder im Speicher').toBeLessThan(120);
      expect(stand?.bilder, 'Bilder im Speicher').toBeGreaterThan(5);
      // Die groben Stufen bleiben, die feinen weichen: Der Film bleibt grob abgedeckt.
      expect(stand?.stufe, 'Stufe, bis zu der alles da ist').toBeGreaterThanOrEqual(0);
      const l = await lauf(aufbau, 'schnell', 0);
      expect(
        l.a.speicherZeichnungen,
        `Zeichnungen aus dem Speicher: ${zeige(l.a)}`,
      ).toBeGreaterThan(3);
      expect(l.a.bilderJeS, `schnell: ${zeige(l.a)}`).toBeGreaterThanOrEqual(mindestRate(l.a));
    } finally {
      await page.close();
    }
  });
});
