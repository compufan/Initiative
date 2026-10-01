import { expect, type CDPSession, type Locator, type Page } from '@playwright/test';

/**
 * Das Messgerät fürs Wischen durch die Zeitleiste – für `wischen.spec.ts`.
 *
 * # Was gemessen wird
 *
 * Ein Prüfvideo trägt in jedem Bild seine Nummer als Strichcode (zehn Felder
 * links oben, Schwarz = 0, Weiss = 1; dazu die Zahl gross im Bild). So lässt
 * sich aus jeder Leinwand nachlesen, WELCHES Bild wirklich zu sehen ist –
 * unabhängig davon, was die App über sich meldet.
 *
 * Gezogen wird mit ECHTEN Zeigerereignissen über das Protokoll des Browsers
 * (`Input.dispatchMouseEvent`, 60 Hz, ohne auf jede Antwort zu warten – wie
 * ein Finger). Je Zeigerereignis werden Zeit und Stelle, je Anzeigetakt die
 * Prüfhaken der Vorschau (`window.__vorschau`) mitgeschrieben.
 *
 * # Der Sprungschalter
 *
 * Headless Chromium springt in einem kleinen Video viel schneller als ein
 * Telefon. Der Schalter `window.__sprung.ms` (nur hier, nur im Testcode, über
 * `addInitScript`) setzt `currentTime` erst nach dieser Zeit wirklich und hält
 * `seeking` bis dahin auf `true`: wie ein Dekodierer, dessen Sprung so lange
 * dauert. Er gilt für alle Videoelemente der Seite, auch für den Leser.
 * Dazu zählt er je Element die Zuweisungen (`verteilung`) – daran lässt sich
 * ablesen, wie viele Dekodierer springen – und merkt sich alle Adressen, die
 * `URL.createObjectURL` ausgegeben und noch nicht freigegeben wurden.
 *
 * Die Auswertung (`auswerten`) ist dieselbe wie im Messgerüst, mit dem die
 * Zahlen von `messung-vorher.md` und `messung-nachher.md` entstanden sind.
 */

/** Der Schalter für langsame Sprünge und die Zähler – wird vor jedem Laden der Seite eingesetzt. */
export const SPRUNG_SCHALTER = `
(() => {
  const W = window;
  W.__sprung = { ms: 0, angefordert: 0, ausgefuehrt: 0, ersetzt: 0, protokoll: [], zaehlen: false, je: new Map() };
  const art = (el) =>
    el && el.closest && el.closest('.bild-editor') ? 'E'
    : el && el.className && String(el.className).indexOf('vg-quelle') >= 0 ? 'B' : 'L';
  for (const name of ['seeking', 'seeked']) {
    document.addEventListener(name, (e) => {
      const el = e.target;
      W.__sprung.protokoll.push({ t: performance.now(), w: name, e: art(el), ct: Math.round(el.currentTime * 1000) });
    }, true);
  }
  const zeit = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
  const suchend = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'seeking');
  const bereit = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'readyState');
  const stand = new WeakMap();
  const videos = new Set();
  const erzeugen = Document.prototype.createElement;
  Document.prototype.createElement = function (...args) {
    const el = erzeugen.apply(this, args);
    if (String(args[0]).toLowerCase() === 'video') videos.add(el);
    return el;
  };
  // Videoelemente, die je im Dokument hingen, gehören React und gehen mit dem Blatt; die DEKODIERER
  // (Leser, Verfolgung) hängen nie im Dokument – von ihnen darf nach dem Schliessen keiner übrig sein.
  const eingehaengt = new WeakSet();
  new MutationObserver((meldungen) => {
    for (const m of meldungen) {
      for (const knoten of m.addedNodes) {
        if (knoten.nodeType !== 1) continue;
        if (knoten.tagName === 'VIDEO') eingehaengt.add(knoten);
        knoten.querySelectorAll('video').forEach((v) => eingehaengt.add(v));
      }
    }
  }).observe(document, { childList: true, subtree: true });
  W.__lebende = () => [...videos].filter((v) => v.getAttribute('src') && !eingehaengt.has(v)).length;
  // Adressen, die noch nicht freigegeben sind.
  const urls = new Set();
  const anlegen = URL.createObjectURL.bind(URL);
  const freigeben = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = (obj) => { const u = anlegen(obj); urls.add(u); return u; };
  URL.revokeObjectURL = (u) => { urls.delete(u); freigeben(u); };
  W.__offeneAdressen = () => urls.size;
  /** Wie viele verschiedene Videoelemente haben seit \`zaehlen = true\` einen Sprung verlangt – und welche Art. */
  W.__sprung.verteilung = () => {
    const erg = { E: 0, B: 0, L: 0, elemente: 0 };
    for (const [el, n] of W.__sprung.je) { if (n > 0) { erg[art(el)] += n; erg.elemente += 1; } }
    return erg;
  };
  Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
    configurable: true,
    enumerable: true,
    get() {
      const z = stand.get(this);
      return z && z.zeitgeber !== null ? z.ziel : zeit.get.call(this);
    },
    set(wert) {
      const D = W.__sprung.ms;
      W.__sprung.protokoll.push({ t: performance.now(), w: 'set', e: art(this), v: Math.round(wert * 1000) });
      if (W.__sprung.zaehlen) W.__sprung.je.set(this, (W.__sprung.je.get(this) ?? 0) + 1);
      if (!(D > 0)) {
        zeit.set.call(this, wert);
        return;
      }
      W.__sprung.angefordert += 1;
      let z = stand.get(this);
      if (!z) {
        z = { ziel: null, zeitgeber: null };
        stand.set(this, z);
      }
      if (z.zeitgeber !== null) W.__sprung.ersetzt += 1;
      z.ziel = wert;
      if (z.zeitgeber !== null) return;
      z.zeitgeber = setTimeout(() => {
        z.zeitgeber = null;
        const t = z.ziel;
        z.ziel = null;
        W.__sprung.ausgefuehrt += 1;
        zeit.set.call(this, t);
      }, D);
    },
  });
  // Ein Sprung, der noch aussteht, lässt readyState fallen (HAVE_METADATA) – wie beim echten Sprung.
  Object.defineProperty(HTMLMediaElement.prototype, 'readyState', {
    configurable: true,
    enumerable: true,
    get() {
      const z = stand.get(this);
      return z && z.zeitgeber !== null ? 1 : bereit.get.call(this);
    },
  });
  Object.defineProperty(HTMLMediaElement.prototype, 'seeking', {
    configurable: true,
    enumerable: true,
    get() {
      const z = stand.get(this);
      return (z && z.zeitgeber !== null) || suchend.get.call(this);
    },
  });
})();
`;

export interface SeitenWahl {
  /** Die Notstufe der Vorschau aus: In Software-Grafik (36 – 230 ms je Zeichnung) griffe sie immer. */
  readonly ohneNotstufe?: boolean;
  /** Der Wischspeicher wird weder benutzt noch gefüllt (`__wisch.aus`). */
  readonly speicherAus?: boolean;
  /** Ein kleineres Budget für den Wischspeicher in Bytes. */
  readonly budget?: number;
  /** `toBlob` der Leinwand liefert statt WebP ein PNG – wie Safari. */
  readonly pngStattWebp?: boolean;
  /** `toBlob` liefert für WebP und JPEG `null` – ein Browser, der keine kleinen Bilder kodiert. */
  readonly keineKleinenBilder?: boolean;
}

export async function seiteLaden(page: Page, wahl: SeitenWahl = {}) {
  await page.addInitScript({ content: SPRUNG_SCHALTER });
  const ohneNot = wahl.ohneNotstufe ?? true;
  if (ohneNot) {
    await page.addInitScript(() => {
      (window as unknown as { __vorschau: object }).__vorschau = { ohneNotstufe: true };
    });
  }
  if (wahl.speicherAus || wahl.budget !== undefined) {
    await page.addInitScript((w) => {
      (window as unknown as { __wisch: object }).__wisch = {
        ...(w.speicherAus ? { aus: true } : {}),
        ...(w.budget !== undefined ? { budget: w.budget } : {}),
      };
    }, wahl);
  }
  if (wahl.pngStattWebp) {
    await page.addInitScript(() => {
      const echt = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function (rueckruf, typ, guete) {
        return echt.call(this, rueckruf, typ === 'image/webp' ? 'image/png' : typ, guete);
      };
    });
  }
  if (wahl.keineKleinenBilder) {
    // PNG bleibt: Der Editor holt sein Standbild über `toBlob(…, 'image/png')`.
    await page.addInitScript(() => {
      const echt = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function (rueckruf, typ, guete) {
        if (typ === 'image/webp' || typ === 'image/jpeg') {
          setTimeout(() => rueckruf(null), 0);
          return;
        }
        echt.call(this, rueckruf, typ, guete);
      };
    });
  }
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  // Vite lädt beim ersten Mal nach – kurz warten, bis die Seite steht.
  await page.waitForTimeout(1500);
  await page.waitForLoadState('networkidle');
}

export interface VideoWahl {
  /** Bilder zwischen zwei Schlüsselbildern. */
  readonly gop?: number;
  readonly bilder?: number;
  readonly rate?: number;
  readonly breite?: number;
  readonly hoehe?: number;
  /** Ein grünes Quadrat wandert durchs Bild (für die Masken). */
  readonly quadrat?: boolean;
  /** Jedes Bild neues Zufallsrauschen – der schlimmste Fall für die Grösse der kleinen Bilder. */
  readonly rauschen?: boolean;
}

/**
 * Das Prüfvideo in der Seite schreiben (mit der App-eigenen Schreibfunktion)
 * und unter `window.__dateien[name]` ablegen. Gibt die Dauer in ms zurück,
 * `-1` ohne Videokodierer.
 */
export async function pruefvideoSchreiben(
  page: Page,
  name: string,
  wahl: VideoWahl = {},
): Promise<number> {
  return page.evaluate(
    async ({ name, wahl }) => {
      const schreibenPfad = '/src/modules/video/schreiben.ts';
      const schreiben = (await import(
        /* @vite-ignore */ schreibenPfad
      )) as typeof import('../src/modules/video/schreiben.js');
      const W = wahl.breite ?? 640;
      const H = wahl.hoehe ?? 360;
      if (!(await schreiben.videoTauglich(W, H)).moeglich) return -1;
      const faktor = W / 1280;
      const leinwand = document.createElement('canvas');
      leinwand.width = W;
      leinwand.height = H;
      const ctx = leinwand.getContext('2d') as CanvasRenderingContext2D;
      // Feine Textur, damit die Bilder nicht zu einfach zu packen sind.
      const textur = document.createElement('canvas');
      textur.width = 320;
      textur.height = 180;
      const tc = textur.getContext('2d') as CanvasRenderingContext2D;
      const daten = tc.createImageData(320, 180);
      let saat = 4711;
      const zufall = () => {
        saat = (saat * 16807) % 2147483647;
        return saat / 2147483647;
      };
      for (let i = 0; i < 320 * 180; i += 1) {
        const v = 90 + zufall() * 120;
        daten.data[i * 4] = v;
        daten.data[i * 4 + 1] = v * 0.9;
        daten.data[i * 4 + 2] = v * 0.8;
        daten.data[i * 4 + 3] = 255;
      }
      tc.putImageData(daten, 0, 0);
      const rausch = ctx.createImageData(W, H);
      const t0 = performance.now();
      const datei = await schreiben.videoSchreiben(
        wahl.bilder ?? 300,
        (n) => {
          if (wahl.rauschen) {
            for (let i = 0; i < W * H; i += 1) {
              rausch.data[i * 4] = Math.floor(Math.random() * 256);
              rausch.data[i * 4 + 1] = Math.floor(Math.random() * 256);
              rausch.data[i * 4 + 2] = Math.floor(Math.random() * 256);
              rausch.data[i * 4 + 3] = 255;
            }
            ctx.putImageData(rausch, 0, 0);
          } else {
            // Mit Quadrat kein Grün im Hintergrund: Die Probe soll die Maske prüfen, nicht die Verfolgung
            // auf einem Bild, auf dem ein grüner Hintergrund das grüne Quadrat verschluckt.
            const farbton = (h: number) => (wahl.quadrat && h >= 80 && h <= 180 ? h + 110 : h);
            ctx.fillStyle = `hsl(${farbton((n * 3) % 360)},70%,40%)`;
            ctx.fillRect(0, 0, W, H);
            ctx.globalAlpha = 0.3;
            ctx.imageSmoothingEnabled = true;
            ctx.drawImage(textur, -((n * 3) % 160), 0, W + 160, H);
            ctx.globalAlpha = 1;
            for (let k = 0; k < 40; k += 1) {
              ctx.fillStyle = `hsl(${farbton((n * 7 + k * 31) % 360)},80%,60%)`;
              ctx.fillRect(
                ((k * 97 + n * 13) % 1200) * faktor,
                (80 + ((k * 53 + n * 5) % 580)) * faktor,
                80 * faktor,
                60 * faktor,
              );
            }
            if (wahl.quadrat) {
              // Ein grünes Quadrat, 140 breit (bei 1280), wandert mit 3,3 Punkten je Bild nach rechts.
              ctx.fillStyle = '#20c040';
              ctx.fillRect((100 + 3.3 * n) * faktor, 300 * faktor, 140 * faktor, 140 * faktor);
            }
            ctx.fillStyle = '#fff';
            ctx.font = `${160 * faktor}px sans-serif`;
            ctx.fillText(String(n), 440 * faktor, (wahl.quadrat ? 600 : 420) * faktor);
          }
          // Strichcode: zehn Felder zu 1/20 der Breite, niedrigstes Bit links; Schwarz = 0, Weiss = 1.
          const feld = W / 20;
          for (let b = 0; b < 10; b += 1) {
            ctx.fillStyle = (n >> b) & 1 ? '#fff' : '#000';
            ctx.fillRect(b * feld, 0, feld, feld);
          }
          return leinwand;
        },
        {
          breite: W,
          hoehe: H,
          bildrate: wahl.rate ?? 25,
          schluesselAbstand: wahl.gop ?? 25,
        },
      );
      const fenster = window as unknown as { __dateien?: Record<string, Blob> };
      fenster.__dateien ??= {};
      fenster.__dateien[name] = datei;
      return Math.round(performance.now() - t0);
    },
    { name, wahl },
  );
}

/**
 * Dem Browser `createImageBitmap` wegnehmen, NACHDEM das Prüfvideo
 * geschrieben ist (der Schreiber braucht es womöglich): Der Wischspeicher
 * entpackt dann über ein Bildelement.
 */
export async function bitmapEntfernen(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { createImageBitmap?: unknown }).createImageBitmap = undefined;
  });
}

/** Das Blatt mit der Datei öffnen, den Editor aufmachen. */
export async function editorOeffnen(page: Page, name: string): Promise<Locator> {
  await page.evaluate(async (dateiName) => {
    const buehnePfad = '/e2e/buehne.ts';
    const fenster = window as unknown as {
      __dateien: Record<string, Blob>;
      __blatt?: { weg: () => void };
    };
    fenster.__blatt?.weg();
    const buehne = (await import(/* @vite-ignore */ buehnePfad)) as {
      videoBlattZeigen: (v: Blob) => { fertig: Promise<Blob>; weg: () => void };
    };
    fenster.__blatt = buehne.videoBlattZeigen(fenster.__dateien[dateiName]);
  }, name);
  const bearbeiten = page.getByRole('button', { name: /Bearbeiten und schneiden/ });
  await expect(bearbeiten).toBeEnabled({ timeout: 90_000 });
  await bearbeiten.click();
  const editor = page.locator('.bild-editor');
  await expect(editor.locator('.bild-wiedergabe')).toBeHidden({ timeout: 40_000 });
  return editor;
}

/** Vier Abschnitte dazu: 5 + 2 + 2 + 2 + 1 s = 12 s, alle aus demselben Video hintereinander. */
export async function abschnitteDazu(editor: Locator, anzahl = 4, gesamt = '/ 0:12,00') {
  for (let i = 0; i < anzahl; i += 1) {
    await editor.getByRole('button', { name: 'Abschnitt hinzufügen' }).click();
    await expect(editor.locator('.bild-wiedergabe')).toBeHidden({ timeout: 40_000 });
  }
  await expect(editor.locator('.zl-zeit')).toContainText(gesamt, { timeout: 10_000 });
}

/** Schwarz-Weiss am gewählten Abschnitt – dann liegt die bearbeitete Vorschau über dem Video. */
export async function schwarzWeiss(editor: Locator) {
  await editor.getByRole('button', { name: /Ton/ }).first().click();
  await editor.getByRole('button', { name: 'Schwarz-Weiss', exact: true }).click();
}

/**
 * Eine Tipp-Maske auf das wandernde grüne Quadrat des Prüfvideos (`quadrat`),
 * Sättigung −1: Wo die Maske sitzt, ist das Quadrat grau. Das Stellbild liegt am
 * Anfang des fünften Abschnitts (Bild 275); dort wird getippt.
 */
export async function maskeAnlegen(page: Page, editor: Locator): Promise<void> {
  await editor
    .locator('.bild-reiter')
    .getByRole('button', { name: /Bereiche/ })
    .click();
  await editor.getByRole('button', { name: /Antippen aus/ }).click();
  const kasten = (await editor.locator('.bild-leinwand').boundingBox())!;
  const cx = 100 + 3.3 * 275 + 70;
  await page.mouse.click(
    kasten.x + (cx / 1280) * kasten.width,
    kasten.y + (370 / 720) * kasten.height,
  );
  await expect(editor.locator('.mb-zeile')).toHaveCount(1, { timeout: 30_000 });
  await editor.getByLabel('Sättigung').last().fill('-1');
}

/**
 * Wartet, bis die Verfolgung der Maske fertig ist (die Bahn sagt nicht mehr
 * „wird noch verfolgt“) – und gibt die Wartezeit in Sekunden zurück. Gibt die
 * Beschriftung der Bahn dazu zurück: Wo die Maske zu sehen ist, steht dort.
 */
export async function maskeVerfolgt(
  editor: Locator,
  timeoutMs = 300_000,
): Promise<{ sekunden: number; bahn: string }> {
  const t0 = Date.now();
  const bahn = editor.locator('.mb-leinwand').first();
  await expect(bahn).toHaveAttribute('aria-label', /^(?!.*wird noch verfolgt).*\S/, {
    timeout: timeoutMs,
  });
  return {
    sekunden: (Date.now() - t0) / 1000,
    bahn: (await bahn.getAttribute('aria-label')) ?? '',
  };
}

/** „Fertig“ der Maskenzeile: bringt die Knöpfe der Zeitleiste zurück. */
export async function maskeFertig(editor: Locator): Promise<void> {
  await editor
    .getByRole('toolbar', { name: /^Maske / })
    .getByRole('button', { name: 'Fertig' })
    .click();
  await expect(editor.locator('.bild-wiedergabe')).toBeHidden({ timeout: 40_000 });
}

/** Der Stand des Wischspeichers (`window.__wisch`) – ohne die Funktion. */
export interface WischStandAnsicht {
  verfuegbar: boolean;
  format: string | null;
  stufe: number;
  bilder: number;
  bytes: number;
  entpackt: number;
  fertig: boolean;
  ruhe: string[];
  zaehler: { gelesen: number; mitgeschnitten: number; kodiert: number; fehler: number };
  aus: boolean;
}

export async function wischStand(page: Page): Promise<WischStandAnsicht | null> {
  return page.evaluate(() => {
    const haken = (window as unknown as { __wisch?: Record<string, unknown> }).__wisch;
    if (!haken) return null;
    const { ruhen: _ruhen, ...ohne } = haken;
    return JSON.parse(JSON.stringify(ohne)) as WischStandAnsicht;
  });
}

/**
 * Warten, bis der Speicher bis `stufe` gefüllt ist (0 … 4) – und wie lange es
 * dauerte, in Sekunden. Der Test füllt bei Sprungzeit 0: Das Füllen bei 250 ms
 * dauerte anderthalb Minuten.
 */
export async function speicherWarten(
  page: Page,
  stufe: number,
  timeoutMs = 240_000,
): Promise<number> {
  const t0 = Date.now();
  await page.waitForFunction(
    (soll) => {
      const haken = (window as unknown as { __wisch?: { stufe: number } }).__wisch;
      return (haken?.stufe ?? -1) >= soll;
    },
    stufe,
    { timeout: timeoutMs, polling: 250 },
  );
  return (Date.now() - t0) / 1000;
}

export async function sprungSetzen(page: Page, ms: number, zaehlen = false) {
  await page.evaluate(
    ([dauer, zaehlt]) => {
      const w = window as unknown as {
        __sprung: { ms: number; je: Map<unknown, number>; zaehlen: boolean };
      };
      w.__sprung.ms = dauer;
      w.__sprung.zaehlen = zaehlt;
      w.__sprung.je = new Map();
    },
    [ms, zaehlen] as const,
  );
}

/* ---------- Der Schreiber in der Seite ---------- */

/** Der Schreiber in der Seite: Zeigerereignisse, Anzeigetakt, Bildmeldungen des Videos. */
export async function schreiberEinsetzen(
  page: Page,
  optionen: { strichcode?: boolean; maske?: boolean } = {},
) {
  await page.evaluate(
    ([mitStrichcode, mitMaske]) => {
      type Fenster = Window & Record<string, unknown>;
      const fe = window as unknown as Fenster;
      if (fe.__m) {
        const vorhanden = fe.__m as { strichcode: boolean; maske: boolean };
        vorhanden.strichcode = mitStrichcode;
        vorhanden.maske = mitMaske;
        return;
      }
      const m = {
        an: false,
        strichcode: mitStrichcode,
        maske: mitMaske,
        ev: [] as Array<Record<string, number | string>>,
        pr: [] as Array<Record<string, number | string>>,
        rv: [] as Array<Record<string, number>>,
      };
      fe.__m = m;
      const ereignis = (art: string) => (e: PointerEvent) => {
        if (m.an) m.ev.push({ a: art, t: e.timeStamp, h: performance.now(), x: e.clientX });
      };
      document.addEventListener('pointerdown', ereignis('d'), true);
      document.addEventListener('pointermove', ereignis('m'), true);
      document.addEventListener('pointerup', ereignis('u'), true);

      /** Liest die Bildnummer aus dem Strichcode einer Leinwand – oder -1. */
      const lesen = (flaeche: HTMLCanvasElement | null): number => {
        if (!flaeche || flaeche.width < 100 || flaeche.height < 10) return -1;
        const c = flaeche.getContext('2d');
        if (!c) return -1;
        // Die Felder liegen links oben, jedes 1/20 der Breite gross; gelesen wird in ihrer Mitte.
        const feld = flaeche.width / 20;
        const reihe = c.getImageData(0, Math.floor(feld / 2), flaeche.width, 1).data;
        let n = 0;
        for (let b = 0; b < 10; b += 1) {
          const x = Math.floor((b + 0.5) * feld);
          const v = (reihe[x * 4] + reihe[x * 4 + 1] + reihe[x * 4 + 2]) / 3;
          if (v > 128) n |= 1 << b;
        }
        return n;
      };
      fe.__strichcode = lesen;

      /**
       * Die Sättigung (grösster minus kleinster Farbwert) in der Mitte des grünen
       * Quadrats an Bild `k` – klein, wo die Maske es entsättigt, gross ohne Maske.
       */
      const maskenProbe = (flaeche: HTMLCanvasElement, k: number): number => {
        const c = flaeche.getContext('2d');
        if (!c || k < 0 || flaeche.width < 100) return -1;
        const x = Math.round(((100 + 3.3 * k + 70) / 1280) * flaeche.width);
        const y = Math.round((370 / 720) * flaeche.height);
        const d = c.getImageData(Math.min(flaeche.width - 1, Math.max(0, x)), y, 1, 1).data;
        return Math.max(d[0], d[1], d[2]) - Math.min(d[0], d[1], d[2]);
      };

      fe.__maskenProbe = (wahl: string, k: number): number => {
        const flaeche = document.querySelector(wahl) as HTMLCanvasElement | null;
        return flaeche ? maskenProbe(flaeche, k) : -1;
      };

      const sicht = (el: Element | null) => (el && !(el as HTMLElement).hidden ? 1 : 0);
      let letztes = -1;
      // Gelesen wird NACH dem Anzeigetakt (setTimeout 0 im Rückruf): Dann haben alle Rückrufe des Takts
      // – auch die der App – schon gezeichnet, und die Probe hängt nicht an der Reihenfolge der Anmeldung.
      const probeNehmen = (jetzt: number) => {
        if (!m.an) return;
        const v = (fe.__vorschau ?? {}) as {
          gezeichnet?: number;
          letzteMs?: number;
          letzteK?: number;
          zielK?: number;
          aus?: string;
          speicherGezeichnet?: number;
          zeichenMs?: number;
          fehlend?: string[];
          bereiche?: number;
        };
        const video = document.querySelector(
          '.bild-editor video.bild-wiedergabe-video',
        ) as HTMLVideoElement | null;
        const leinwand = document.querySelector(
          '.bild-editor canvas.bild-wiedergabe-bild',
        ) as HTMLCanvasElement | null;
        const neu = (v.gezeichnet ?? -1) !== letztes;
        letztes = v.gezeichnet ?? -1;
        let grau = -2;
        let sc = -2;
        let px = -2;
        if (leinwand && !leinwand.hidden && leinwand.width > 20) {
          const c = leinwand.getContext('2d');
          if (c && neu) {
            // Grau, wenn die Bearbeitung (Schwarz-Weiss) sichtbar ist: die Ecke unten links.
            const d = c.getImageData(4, leinwand.height - 6, 1, 1).data;
            grau = Math.abs(d[0] - d[1]) < 25 && Math.abs(d[1] - d[2]) < 25 ? 1 : 0;
          }
          if (m.strichcode && neu) sc = lesen(leinwand);
          if (m.maske && neu) px = maskenProbe(leinwand, v.letzteK ?? -1);
        }
        m.pr.push({
          t: jetzt,
          g: v.gezeichnet ?? -1,
          sg: v.speicherGezeichnet ?? -1,
          ms: v.letzteMs ?? -1,
          k: v.letzteK ?? -1,
          zk: v.zielK ?? -1,
          aus: v.aus ?? '',
          zm: v.zeichenMs ?? -1,
          fe: (v.fehlend ?? []).length,
          be: v.bereiche ?? -1,
          vt: video ? video.currentTime * 1000 : -1,
          sk: video ? (video.seeking ? 1 : 0) : -1,
          wh: sicht(document.querySelector('.bild-editor .bild-wiedergabe')),
          lw: sicht(leinwand),
          gr: grau,
          sc,
          px,
          lv: typeof fe.__lebende === 'function' ? (fe.__lebende as () => number)() : -1,
        });
      };
      const tick = (jetzt: number) => {
        requestAnimationFrame(tick);
        setTimeout(() => probeNehmen(jetzt), 0);
      };
      requestAnimationFrame(tick);

      // Jedes Bild, das das Video wirklich anzeigt (= jeder fertige Sprung).
      const rvfcAn = () => {
        const video = document.querySelector('.bild-editor video.bild-wiedergabe-video') as
          | (HTMLVideoElement & {
              requestVideoFrameCallback?: (
                f: (j: number, meta: { mediaTime: number; presentedFrames: number }) => void,
              ) => number;
            })
          | null;
        if (!video?.requestVideoFrameCallback) return;
        const schritt = (jetzt: number, meta: { mediaTime: number; presentedFrames: number }) => {
          if (m.an) {
            m.rv.push({
              t: jetzt,
              mt: meta.mediaTime * 1000,
              pf: meta.presentedFrames,
              rs: video.readyState,
              sk: video.seeking ? 1 : 0,
            });
          }
          video.requestVideoFrameCallback!(schritt);
        };
        video.requestVideoFrameCallback(schritt);
      };
      fe.__rvfcAn = rvfcAn;
      rvfcAn();
    },
    [optionen.strichcode ?? false, optionen.maske ?? false] as const,
  );
}

/* ---------- Der Finger ---------- */

export interface Lage {
  links: number;
  breite: number;
  y: number;
  gesamtMs: number;
  umfangMs: number;
}

export async function lageLesen(page: Page): Promise<Lage> {
  const bahn = page.locator('.bild-editor .zl-bahn');
  const kasten = (await bahn.boundingBox())!;
  const text = (await page.locator('.bild-editor .zl-zeit').textContent()) ?? '';
  const teile = /\/\s*(\d+):(\d+),(\d+)/.exec(text);
  const gesamtMs = teile
    ? Number(teile[1]) * 60000 + Number(teile[2]) * 1000 + Number(teile[3]) * 10
    : 0;
  return {
    links: kasten.x,
    breite: kasten.width,
    y: kasten.y + kasten.height / 2,
    gesamtMs,
    // Die Leiste rechnet so (Zeitleiste.tsx): max(1, gesamt · 1,25, gesamt + 1500).
    umfangMs: Math.max(1, gesamtMs * 1.25, gesamtMs + 1500),
  };
}

interface Stelle {
  t: number;
  f: number;
}

/**
 * Die kleinste Stelle (Anteil am Film) ab `wunsch`, die nicht auf einem Griff
 * des gewählten Abschnitts liegt – ein Fingertipp auf einen Griff zieht nicht
 * die Wiedergabestelle, sondern kürzt den Abschnitt.
 */
async function freiAb(page: Page, lage: Lage, wunsch: number): Promise<number> {
  const griffe = await page.locator('.bild-editor .zl-griff').evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return [r.left, r.right];
    }),
  );
  const film = lage.gesamtMs / lage.umfangMs;
  let f = wunsch;
  for (let runde = 0; runde < 6; runde += 1) {
    const x = lage.links + 1 + f * film * (lage.breite - 2);
    const treffer = griffe.find(([l, r]) => x >= l - 4 && x <= r + 4);
    if (!treffer) return f;
    f = (treffer[1] + 6 - lage.links - 1) / (film * (lage.breite - 2));
  }
  return f;
}

/** Zeitplan der Zeigerereignisse: Wegpunkte (ms, Anteil am Film), 60 Hz, danach `halten` ms ohne Ereignis. */
function plan(wege: Stelle[], halten: number, lage: Lage, f0 = 0) {
  const film = lage.gesamtMs / lage.umfangMs;
  const x = (f: number) => lage.links + 1 + (f0 + f * (1 - f0)) * film * (lage.breite - 2);
  const at = (t: number): number => {
    if (t <= wege[0].t) return wege[0].f;
    for (let i = 1; i < wege.length; i += 1) {
      if (t <= wege[i].t) {
        const a = wege[i - 1];
        const b = wege[i];
        return a.f + ((b.f - a.f) * (t - a.t)) / (b.t - a.t);
      }
    }
    return wege[wege.length - 1].f;
  };
  const ende = wege[wege.length - 1].t;
  const ereignisse: Array<{ t: number; params: Record<string, unknown> }> = [];
  ereignisse.push({
    t: 0,
    params: {
      type: 'mousePressed',
      x: x(at(0)),
      y: lage.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    },
  });
  for (let k = 1; k * (1000 / 60) <= ende; k += 1) {
    const t = k * (1000 / 60);
    ereignisse.push({
      t,
      params: { type: 'mouseMoved', x: x(at(t)), y: lage.y, button: 'left', buttons: 1 },
    });
  }
  ereignisse.push({
    t: ende + halten,
    params: {
      type: 'mouseReleased',
      x: x(at(ende)),
      y: lage.y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    },
  });
  return ereignisse;
}

export const SZENEN: Record<string, { wege: Stelle[]; halten: number }> = {
  /** 1 s über den ganzen Film, sofort loslassen (300 Bilder/s Fingergeschwindigkeit). */
  schnell: {
    wege: [
      { t: 0, f: 0 },
      { t: 1000, f: 1 },
    ],
    halten: 0,
  },
  /** 6 s über 93 % des Films (46 Bilder/s), sofort loslassen. */
  langsam: {
    wege: [
      { t: 0, f: 0 },
      { t: 6000, f: 0.93 },
    ],
    halten: 0,
  },
  /** Hin und her: 0 → 1 → 0,3 → 0,9 → 0,5 in 3,2 s. */
  hinher: {
    wege: [
      { t: 0, f: 0 },
      { t: 1000, f: 1 },
      { t: 1800, f: 0.3 },
      { t: 2600, f: 0.9 },
      { t: 3200, f: 0.5 },
    ],
    halten: 0,
  },
  /** 0,6 s bis 60 %, dann 2 s stillhalten (der Finger liegt), loslassen. */
  stopp: {
    wege: [
      { t: 0, f: 0 },
      { t: 600, f: 0.6 },
    ],
    halten: 2000,
  },
};

const schlafen = (ms: number) => new Promise((weiter) => setTimeout(weiter, ms));

/** Schickt den Zeitplan an den Browser – ohne auf jede Antwort zu warten, wie ein echter Finger. */
async function abspielen(cdp: CDPSession, zeitplan: ReturnType<typeof plan>): Promise<number> {
  const offen: Array<Promise<unknown>> = [];
  const start = performance.now();
  for (const e of zeitplan) {
    const warte = start + e.t - performance.now();
    if (warte > 2) await schlafen(warte - 1);
    while (performance.now() < start + e.t) {
      /* genau abwarten */
    }
    offen.push(cdp.send('Input.dispatchMouseEvent', e.params as never));
  }
  await Promise.all(offen);
  return performance.now() - start;
}

/** Den Finger an den Anfang des Films bringen – mit abgeschaltetem Sprungschalter und abgewartetem Standbild. */
export async function zumAnfang(page: Page, cdp: CDPSession) {
  const vorher = await page.evaluate(
    () => (window as unknown as { __sprung: { ms: number } }).__sprung.ms,
  );
  await sprungSetzen(page, 0);
  const lage = await lageLesen(page);
  const start = await freiAb(page, lage, 0.66);
  const p = plan(
    [
      { t: 0, f: 1 },
      { t: 100, f: 0 },
    ],
    0,
    lage,
    0,
  );
  const film = lage.gesamtMs / lage.umfangMs;
  const xStart = lage.links + 1 + start * film * (lage.breite - 2);
  const xEnde = lage.links + 1;
  const n = p.length;
  p.forEach((e, i) => {
    const a = i === 0 ? 0 : i === n - 1 ? 1 : i / (n - 2);
    (e.params as { x: number }).x = xStart + (xEnde - xStart) * Math.min(1, a);
  });
  await abspielen(cdp, p);
  await expect(page.locator('.bild-editor .bild-wiedergabe')).toBeHidden({ timeout: 30_000 });
  await expect(page.locator('.bild-editor .zl-zeit')).toContainText('0:00,0', { timeout: 10_000 });
  await page.waitForTimeout(400);
  if (vorher > 0) await sprungSetzen(page, vorher);
}

export interface Lauf {
  szene: string;
  sprungMs: number;
  s: number;
  bilder: number;
  lage: Lage;
  dauerMs: number;
  ev: Array<{ a: string; t: number; h: number; x: number }>;
  pr: Array<Record<string, number | string>>;
  rv: Array<{ t: number; mt: number; pf: number; rs: number; sk: number }>;
  protokoll: Array<{ t: number; w: string; e: string; ct?: number; v?: number }>;
  vorschau: Record<string, unknown>;
  wisch: Record<string, unknown> | null;
  stillbild: number;
  verteilung: { E: number; B: number; L: number; elemente: number };
  verfolgerLesen: number | null;
  /** Was `mittenImHalten` zurückgab – ausgewertet, während der Finger liegt. */
  halten: unknown;
}

/**
 * Einen Zug aufzeichnen: den Finger an den Anfang, die Szene mit echten
 * Zeigerereignissen abspielen, nach dem Loslassen warten, bis der Editor sein
 * genaues Bild zeigt (oder 25 s), und alles einsammeln.
 */
export async function zugAufzeichnen(
  page: Page,
  cdp: CDPSession,
  name: string,
  optionen: {
    sprungMs?: number;
    bilder: number;
    s: number;
    warten?: boolean;
    /** Wird aufgerufen, wenn der Finger bei `stopp` anderthalb Sekunden still liegt. */
    mittenImHalten?: () => Promise<unknown>;
  } = {
    bilder: 300,
    s: 40,
  },
): Promise<Lauf> {
  const szene = SZENEN[name];
  if (!szene) throw new Error(`Unbekannte Szene ${name}`);
  await zumAnfang(page, cdp);
  const lage = await lageLesen(page);
  const sprungMs = optionen.sprungMs ?? 0;
  await page.evaluate((ms) => {
    const w = window as unknown as {
      __sprung: {
        ms: number;
        angefordert: number;
        ausgefuehrt: number;
        ersetzt: number;
        protokoll: unknown[];
        zaehlen: boolean;
        je: Map<unknown, number>;
      };
      __m: { an: boolean; ev: unknown[]; pr: unknown[]; rv: unknown[] };
      __verfolger0: unknown;
      __verfolger?: object;
    };
    w.__sprung.ms = ms;
    w.__sprung.angefordert = 0;
    w.__sprung.ausgefuehrt = 0;
    w.__sprung.ersetzt = 0;
    w.__sprung.protokoll = [];
    w.__sprung.zaehlen = true;
    w.__sprung.je = new Map();
    w.__m.ev = [];
    w.__m.pr = [];
    w.__m.rv = [];
    w.__m.an = true;
    w.__verfolger0 = { ...(w.__verfolger ?? {}) };
  }, sprungMs);
  const f0 = await freiAb(page, lage, 0);
  const wegeEnde = szene.wege[szene.wege.length - 1].t;
  const haltenErgebnis = optionen.mittenImHalten
    ? (async () => {
        await schlafen(wegeEnde + 1500);
        return optionen.mittenImHalten!();
      })()
    : Promise.resolve(null);
  const dauerMs = await abspielen(cdp, plan(szene.wege, szene.halten, lage, f0));
  const halten = await haltenErgebnis;
  // Nach dem Loslassen: warten, bis der Editor das genaue Bild zeigt (oder 25 s).
  if (optionen.warten !== false) {
    const frist = Date.now() + 25_000;
    let ruhigSeit = 0;
    while (Date.now() < frist) {
      const verborgen = await page
        .locator('.bild-editor .bild-wiedergabe')
        .evaluate((el) => (el as HTMLElement).hidden);
      if (verborgen) {
        ruhigSeit ||= Date.now();
        if (Date.now() - ruhigSeit > 500) break;
      } else ruhigSeit = 0;
      await schlafen(50);
    }
  }
  const erg = await page.evaluate(() => {
    const w = window as unknown as {
      __sprung: { protokoll: unknown[]; verteilung: () => Lauf['verteilung']; zaehlen: boolean };
      __m: { an: boolean; ev: unknown[]; pr: unknown[]; rv: unknown[] };
      __strichcode: (f: HTMLCanvasElement | null) => number;
      __vorschau?: object;
      __wisch?: Record<string, unknown>;
      __verfolger?: { lesen?: number };
      __verfolger0?: { lesen?: number };
    };
    w.__m.an = false;
    w.__sprung.zaehlen = false;
    const still = document.querySelector(
      '.bild-editor canvas.bild-leinwand',
    ) as HTMLCanvasElement | null;
    const { ruhen: _ruhen, ...wischOhne } = w.__wisch ?? {};
    return {
      ev: w.__m.ev,
      pr: w.__m.pr,
      rv: w.__m.rv,
      protokoll: w.__sprung.protokoll,
      vorschau: { ...(w.__vorschau as object) },
      wisch: w.__wisch ? JSON.parse(JSON.stringify(wischOhne)) : null,
      stillbild: w.__strichcode(still),
      verteilung: w.__sprung.verteilung(),
      verfolgerLesen:
        w.__verfolger && w.__verfolger0
          ? (w.__verfolger.lesen ?? 0) - (w.__verfolger0.lesen ?? 0)
          : null,
    };
  });
  return {
    szene: name,
    sprungMs,
    s: optionen.s,
    bilder: optionen.bilder,
    lage,
    dauerMs,
    halten,
    ...erg,
  } as Lauf;
}

/* ---------- Die Auswertung ---------- */

export interface Auswertung {
  dauerS: number;
  ereignisseJeS: number;
  /** Wie oft wechselt das SICHTBARE Bild je Sekunde. */
  bilderJeS: number;
  verschiedene: number;
  videoBilderJeS: number;
  /** Zeichnungen der Vorschau je Sekunde. */
  gezeichnetJeS: number;
  /** Zeichnungen aus dem Speicher je Sekunde. */
  speicherJeS: number;
  spaetMittel: number | null;
  spaetP95: number | null;
  spaetMax: number | null;
  alterMittelMs: number | null;
  alterP95Ms: number | null;
  alterMaxMs: number | null;
  /** Anteil der Takte im Zug, in denen die bearbeitete Leinwand zu sehen war. */
  bearbeitetAnteil: number | null;
  /** Anteil der neu gezeichneten Takte, deren Ecke grau war (nur mit Schwarz-Weiss aussagekräftig). */
  grauAnteil: number | null;
  erstesBildMs: number | null;
  /** Vom letzten Ereignis bis das Bild der Fingerstelle da ist (bei liegendem Finger). */
  bisRichtigStillMs: number | null;
  /** Vom Loslassen bis die Überlagerung weg ist und der Editor sein genaues Standbild zeigt. */
  bisEditorMs: number | null;
  /** Vom Loslassen bis irgendein Bild höchstens `toleranz` Bilder vom Loslassbild entfernt steht. */
  bisNachUpMs: number | null;
  stillbildRichtig: boolean;
  stillbild: number;
  sollStillbild: number;
  /** Die grösste Abweichung zwischen Ziel und gezeichnetem Bild bei Zeichnungen aus dem Speicher. */
  zielAbweichungMax: number | null;
  /** Wie viele Zeichnungen aus dem Speicher im Zug kamen. */
  speicherZeichnungen: number;
  /** Wie viele Sprünge des sichtbaren Videos (`seeked`) im Zug lagen. */
  videoSpruenge: number;
  spruengeJeS: number;
  /** Wie viele verschiedene Videoelemente im Zug einen Sprung verlangten. */
  elemente: number;
  /** Anteil der Strichcode-Proben im Zug, die dem Bild unter dem Finger auf höchstens `toleranz` entsprachen. */
  naheAnteil: number | null;
  /** Der Anteil der Takte im Zug, in denen die Leinwand ein anderes Bild zeigte als gemeldet (Strichcode). */
  falschAnteil: number | null;
  /** Anteil der Proben im Zug mit Maske, deren Quadrat entsättigt war (nur mit `maske`). */
  maskeAnteil: number | null;
  /** Vom Stillstand des Fingers bis das Video das scharfe Bild der Fingerstelle meldet (bei liegendem Finger). */
  schaerfeMs: number | null;
  verfolgerLesen: number | null;
}

const mittel = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const quantil = (a: number[], q: number) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

/**
 * Wertet einen Lauf aus – dieselbe Rechnung wie das Messgerüst (`mess/auswerten.mjs`).
 * `toleranz`: wie viele Filmbilder neben dem Finger noch als „nahe" zählen.
 */
export function auswerten(
  d: Lauf,
  toleranz = 2,
  /** Nur Bilder in `[vonK, bisK)` zählen für `maskeAnteil` – dort, wo die Verfolgung die Maske fand. */
  maskeBereich?: { readonly vonK: number; readonly bisK: number },
): Auswertung | null {
  const s = d.s;
  const letztes = d.bilder - 1;
  const frame = (ms: number) => Math.max(0, Math.min(letztes, Math.floor(ms / s + 1e-7)));
  const { links, breite, gesamtMs, umfangMs } = d.lage;
  const filmMs = (x: number) =>
    Math.min(gesamtMs, Math.round(Math.min(1, Math.max(0, (x - links) / breite)) * umfangMs));

  const ev = d.ev.map((e) => ({ a: e.a, t: e.t, F: frame(filmMs(e.x)) }));
  const down = ev.find((e) => e.a === 'd');
  const up = [...ev].reverse().find((e) => e.a === 'u');
  const moves = ev.filter((e) => e.a === 'm');
  if (!down || !up) return null;
  const dauerS = (up.t - down.t) / 1000;

  const gesehen = new Set<number>();
  const rv = d.rv
    .filter((r) => {
      if (gesehen.has(r.pf)) return false;
      gesehen.add(r.pf);
      return true;
    })
    .sort((a, b) => a.t - b.t);

  // Was sieht der Anwender zu jedem Anzeigetakt?
  //  - bearbeitete Leinwand sichtbar (lw = 1): das Rasterbild der letzten Zeichnung (k, sonst ms)
  //  - sonst das rohe Video: das zuletzt gemeldete Bild
  let ri = 0;
  const vorDown = [...d.pr]
    .filter((p) => (p.t as number) < down.t - 1 && (p.vt as number) >= 0)
    .pop();
  let letztesRoh: number | null = vorDown ? frame(vorDown.vt as number) : null;
  interface Probe {
    t: number;
    bild: number | null;
    wh: number;
    lw: number;
    gr: number;
    sc: number;
    px: number;
    aus: string;
    k: number;
    zk: number;
    g: number;
    F: number | null;
  }
  const proben: Probe[] = [];
  for (const p of d.pr) {
    const t = p.t as number;
    while (ri < rv.length && rv[ri].t <= t) {
      if (rv[ri].t >= down.t - 5) letztesRoh = frame(rv[ri].mt);
      ri += 1;
    }
    if (t < down.t - 20) continue;
    let bild: number | null = null;
    if (p.lw === 1 && (p.k as number) >= 0) bild = p.k as number;
    else if (p.lw === 1 && (p.ms as number) >= 0) bild = frame(p.ms as number);
    else if (p.wh === 1) bild = letztesRoh;
    proben.push({
      t,
      bild,
      wh: p.wh as number,
      lw: p.lw as number,
      gr: p.gr as number,
      sc: p.sc as number,
      px: p.px as number,
      aus: p.aus as string,
      k: p.k as number,
      zk: p.zk as number,
      g: p.g as number,
      F: null,
    });
  }

  // Fingerstand je Takt: das zuletzt gelieferte Ereignis
  let ei = 0;
  let aktuell: (typeof ev)[number] | null = null;
  for (const p of proben) {
    while (ei < ev.length && ev[ei].t <= p.t) {
      if (ev[ei].a !== 'u') aktuell = ev[ei];
      ei += 1;
    }
    p.F = aktuell ? aktuell.F : null;
  }

  const imZug = proben.filter(
    (p) => p.t >= down.t + 30 && p.t <= up.t && p.bild !== null && p.F !== null,
  );
  const spaet = imZug.map((p) => Math.abs((p.F as number) - (p.bild as number)));

  // Bildalter: wie lange ist her, dass der Finger dort war, wo das gezeigte Bild herkommt (± 1 Bild)?
  const weg = ev.filter((e) => e.a !== 'u');
  const zuletztBei = (ziel: number, bis: number): number | null => {
    let n = weg.length - 1;
    while (n >= 0 && weg[n].t > bis) n -= 1;
    if (n < 0) return null;
    if (Math.abs(weg[n].F - ziel) <= 1) return bis;
    for (let i = n - 1; i >= 0; i -= 1) {
      const a = weg[i];
      const b = weg[i + 1];
      const lo = Math.max(ziel - 1, Math.min(a.F, b.F));
      const hi = Math.min(ziel + 1, Math.max(a.F, b.F));
      if (lo > hi) continue;
      if (a.F === b.F) return b.t;
      const g = b.F > a.F ? hi : lo;
      return a.t + ((g - a.F) / (b.F - a.F)) * (b.t - a.t);
    }
    return null;
  };
  const alter: number[] = [];
  for (const p of imZug) {
    const z = zuletztBei(p.bild as number, p.t);
    if (z !== null) alter.push(Math.max(0, p.t - z));
  }

  // Wechsel des gezeigten Bildes im Zug
  let wechsel = 0;
  let vor: number | null = null;
  const inFenster = proben.filter((p) => p.t >= down.t && p.t <= up.t);
  const verschieden = new Set<number>();
  for (const p of inFenster) {
    if (p.bild === null) continue;
    if (vor !== null && p.bild !== vor) wechsel += 1;
    verschieden.add(p.bild);
    vor = p.bild;
  }
  const ersteres = inFenster.find(
    (p) => p.bild !== null && p.bild !== (inFenster[0]?.bild ?? null),
  );
  const erstesBildMs = ersteres ? ersteres.t - down.t : null;

  const letzteBewegung = moves.length ? moves[moves.length - 1] : down;
  const richtigStill = proben.find(
    (p) => p.t >= letzteBewegung.t && p.bild !== null && Math.abs(p.bild - letzteBewegung.F) <= 0,
  );
  const bisRichtigStillMs = richtigStill ? richtigStill.t - letzteBewegung.t : null;

  const nachUp = proben.filter((p) => p.t >= up.t);
  const editorDa = nachUp.find((p) => p.wh === 0);
  const bisEditorMs = editorDa ? editorDa.t - up.t : null;
  const nahNachUp = nachUp.find((p) => p.bild !== null && Math.abs(p.bild - up.F) <= toleranz);
  // Steht das Standbild des Editors schon (Überlagerung weg, Strichcode stimmt), ist das Bild da – und genau.
  const bisNachUpMs = nahNachUp
    ? nahNachUp.t - up.t
    : bisEditorMs !== null && d.stillbild === up.F
      ? bisEditorMs
      : null;

  // Sprünge des sichtbaren Videos im Zug
  const prot = d.protokoll ?? [];
  const eSprung = prot.filter((x) => x.e === 'E' || x.e === 'B');
  const spruenge = eSprung.filter((x) => x.w === 'set' && x.t >= down.t && x.t <= up.t).length;

  const gz = (() => {
    const a = d.pr.find((p) => (p.t as number) >= down.t);
    const b = [...d.pr].reverse().find((p) => (p.t as number) <= up.t);
    return a && b ? (b.g as number) - (a.g as number) : null;
  })();
  const sg = (() => {
    const a = d.pr.find((p) => (p.t as number) >= down.t);
    const b = [...d.pr].reverse().find((p) => (p.t as number) <= up.t);
    return a && b ? (b.sg as number) - (a.sg as number) : null;
  })();
  const abw = imZug
    .filter((p) => p.aus === 'speicher' && p.zk >= 0 && p.k >= 0)
    .map((p) => Math.abs(p.zk - p.k));
  const mitStrich = imZug.filter((p) => p.lw === 1 && p.sc >= 0);
  const naheStrich = mitStrich.filter((p) => Math.abs(p.sc - (p.F as number)) <= toleranz);
  const falsch = mitStrich.filter((p) => p.k >= 0 && p.sc !== p.k);
  const graue = imZug.filter((p) => p.lw === 1 && p.gr >= 0);
  const mitMaske = imZug.filter(
    (p) =>
      p.lw === 1 &&
      p.px >= 0 &&
      (!maskeBereich || (p.k >= maskeBereich.vonK && p.k < maskeBereich.bisK)),
  );
  // Das scharfe Videobild beim Nachschärfen: Das Video meldet das Bild der Fingerstelle, nachdem der Finger stand.
  const scharf = rv.find((r) => r.t >= letzteBewegung.t && frame(r.mt) === letzteBewegung.F);
  const roh = rv.filter((r) => r.t >= down.t && r.t <= up.t);

  return {
    dauerS,
    ereignisseJeS: moves.length / dauerS,
    bilderJeS: wechsel / dauerS,
    verschiedene: verschieden.size,
    videoBilderJeS: roh.length / dauerS,
    gezeichnetJeS: gz === null ? 0 : gz / dauerS,
    speicherJeS: sg === null ? 0 : sg / dauerS,
    spaetMittel: mittel(spaet),
    spaetP95: quantil(spaet, 0.95),
    spaetMax: spaet.length ? Math.max(...spaet) : null,
    alterMittelMs: mittel(alter),
    alterP95Ms: quantil(alter, 0.95),
    alterMaxMs: alter.length ? Math.max(...alter) : null,
    bearbeitetAnteil: imZug.length ? imZug.filter((p) => p.lw === 1).length / imZug.length : null,
    grauAnteil: graue.length ? graue.filter((p) => p.gr === 1).length / graue.length : null,
    erstesBildMs,
    bisRichtigStillMs,
    bisEditorMs,
    bisNachUpMs,
    stillbildRichtig: d.stillbild === up.F,
    stillbild: d.stillbild,
    sollStillbild: up.F,
    zielAbweichungMax: abw.length ? Math.max(...abw) : null,
    speicherZeichnungen: abw.length,
    videoSpruenge: spruenge,
    spruengeJeS: spruenge / dauerS,
    elemente: d.verteilung?.elemente ?? 0,
    naheAnteil: mitStrich.length ? naheStrich.length / mitStrich.length : null,
    falschAnteil: mitStrich.length ? falsch.length / mitStrich.length : null,
    maskeAnteil: mitMaske.length
      ? mitMaske.filter((p) => p.px < 40).length / mitMaske.length
      : null,
    schaerfeMs: scharf ? scharf.t - letzteBewegung.t : null,
    verfolgerLesen: d.verfolgerLesen,
  };
}

/** Der Median einer Kenngrösse über mehrere Läufe – Zahlen, nicht `null`. */
export function median(werte: Array<number | null | undefined>): number {
  const zahlen = werte.filter((w): w is number => typeof w === 'number' && !Number.isNaN(w));
  if (zahlen.length === 0) return Number.NaN;
  const s = [...zahlen].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
