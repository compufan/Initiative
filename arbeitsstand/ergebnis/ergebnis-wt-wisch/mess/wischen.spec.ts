import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

/**
 * Messgerüst: Wie läuft das Bild beim Ziehen durch die Zeitleiste des Editors?
 *
 * Ein Video von 1280 x 720, 25 Bildern/s, 12 s (300 Bilder) wird mit der
 * App-eigenen Schreibfunktion erzeugt. Jedes Bild trägt seine Nummer als
 * Strichcode (10 Felder, links oben) – so lässt sich aus der Leinwand
 * nachlesen, welches Bild wirklich zu sehen ist, unabhängig davon, was die App
 * über sich selbst meldet.
 *
 * Gezogen wird mit ECHTEN Zeigerereignissen (CDP `Input.dispatchMouseEvent`,
 * 60 Hz). Je Ereignis wird die Fingerstelle, je Anzeigetakt (requestAnimation
 * Frame) der Zähler der Vorschau (`window.__vorschau`) mitgeschrieben. Die
 * Auswertung steht in `auswerten.mjs`.
 *
 * Damit headless Chromium nicht viel schneller springt als ein Telefon, gibt
 * es einen Schalter NUR IM TESTCODE (`window.__sprung.ms`): Er setzt
 * `currentTime` erst nach dieser Zeit wirklich und hält `seeking` bis dahin auf
 * true – wie ein Dekodierer, dessen Sprung so lange dauert.
 *
 * Umgebung: WISCH_MARKE (Dateiname), WISCH_GOP (Bilder je Schlüsselbild),
 * WISCH_SPRUNG (kommagetrennt, ms), WISCH_SZENEN, WISCH_CPU (Drosselfaktor).
 */

const AUS = '/tmp/claude-0/-home-user-Initiative/b3e47b8f-e30a-5e75-8af6-6e58f2fcbe7c/scratchpad/ergebnis-wt-wisch/mess/roh';
const MARKE = process.env.WISCH_MARKE ?? 'vorher';
const GOP = Number(process.env.WISCH_GOP ?? 25);
const SPRUENGE = (process.env.WISCH_SPRUNG ?? '0').split(',').map(Number);
const SZENEN = (process.env.WISCH_SZENEN ?? 'schnell,langsam,hinher,stopp').split(',');
const CPU = Number(process.env.WISCH_CPU ?? 1);
const MIT_MASKE = process.env.WISCH_MASKE === '1';
const PRUEF_STRICHCODE = process.env.WISCH_STRICHCODE === '1';
const LOCKER = process.env.WISCH_LOCKER === '1';
/** Nach dem Umbau: erst warten, bis der Wischspeicher bis Stufe 3 (jedes 2. Bild) gefüllt ist – bei Sprung 0. */
const SPEICHER_WARTEN = (process.env.WISCH_SPEICHER_WARTEN ?? (process.env.WISCH_MARKE === 'vorher' ? '0' : '1')) === '1';
/** Die Notstufe der Vorschau aus: In Software-Grafik (36-230 ms je Zeichnung) würde sie immer greifen. */
const OHNE_NOT = (process.env.WISCH_OHNE_NOT ?? '1') === '1';
const SPEICHER_AUS = process.env.WISCH_SPEICHER_AUS === '1';
/** Mit WISCH_MASKE=1: ein grünes Quadrat wandert durchs Bild; eine angetippte Maske entsättigt es. */

const BILDER = 300;
const RATE = 25;
const S = 1000 / RATE;

/** Der Schalter für langsame Sprünge – wird vor jedem Laden der Seite eingesetzt. */
const SPRUNG_SCHALTER = `
(() => {
  const W = window;
  W.__sprung = { ms: 0, angefordert: 0, ausgefuehrt: 0, ersetzt: 0, protokoll: [] };
  for (const name of ['seeking', 'seeked']) {
    document.addEventListener(name, (e) => {
      const el = e.target;
      const im = el && el.closest && el.closest('.bild-editor') ? 'E' : el && el.className && String(el.className).indexOf('vg-quelle') >= 0 ? 'B' : 'L';
      W.__sprung.protokoll.push({ t: performance.now(), w: name, e: im, ct: Math.round(el.currentTime * 1000) });
    }, true);
  }
  const zeit = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
  const suchend = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'seeking');
  const bereit = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'readyState');
  const stand = new WeakMap();
  // Alle je angelegten Videoelemente merken – für „wie viele Dekodierer sind offen“.
  const videos = new Set();
  const erzeugen = Document.prototype.createElement;
  Document.prototype.createElement = function (...args) {
    const el = erzeugen.apply(this, args);
    if (String(args[0]).toLowerCase() === 'video') videos.add(el);
    return el;
  };
  W.__lebende = () => [...videos].filter((v) => v.getAttribute('src')).length;
  Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
    configurable: true,
    enumerable: true,
    get() {
      const z = stand.get(this);
      return z && z.zeitgeber !== null ? z.ziel : zeit.get.call(this);
    },
    set(wert) {
      const D = W.__sprung.ms;
      const im = this.closest && this.closest('.bild-editor') ? 'E' : this.className && String(this.className).indexOf('vg-quelle') >= 0 ? 'B' : 'L';
      W.__sprung.protokoll.push({ t: performance.now(), w: 'set', e: im, v: Math.round(wert * 1000) });
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
      const r = z && z.zeitgeber !== null ? 1 : bereit.get.call(this);
      // Versuch: den Wächter der Vorschau lockern (nur mit WISCH_LOCKER=1)
      if (W.__lockerRs && r === 1 && this.videoWidth > 0) return 2;
      return r;
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

async function seiteLaden(page: Page) {
  await page.addInitScript({ content: SPRUNG_SCHALTER });
  if (OHNE_NOT) {
    await page.addInitScript(() => {
      (window as unknown as { __vorschau: object }).__vorschau = { ohneNotstufe: true };
    });
  }
  if (SPEICHER_AUS) {
    await page.addInitScript(() => {
      (window as unknown as { __wisch: object }).__wisch = { aus: true };
    });
  }
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  // Vite lädt beim ersten Mal nach – kurz warten, bis die Seite steht.
  await page.waitForTimeout(1500);
  await page.waitForLoadState('networkidle');
}

/** Erzeugt die Prüfvideos in der Seite (einmal je GOP) und legt sie unter `window.__dateien` ab. */
async function videoMachen(page: Page, gop: number): Promise<number> {
  return page.evaluate(
    async ({ gop, bilder, rate, quadrat }) => {
      const schreibenPfad = '/src/modules/video/schreiben.ts';
      const schreiben = (await import(
        /* @vite-ignore */ schreibenPfad
      )) as typeof import('../../wt-wisch/apps/web/src/modules/video/schreiben.js');
      if (!(await schreiben.videoTauglich(1280, 720)).moeglich) return -1;
      const W = 1280;
      const H = 720;
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
      const t0 = performance.now();
      const datei = await schreiben.videoSchreiben(
        bilder,
        (n) => {
          ctx.fillStyle = `hsl(${(n * 3) % 360},70%,40%)`;
          ctx.fillRect(0, 0, W, H);
          ctx.globalAlpha = 0.3;
          ctx.imageSmoothingEnabled = true;
          ctx.drawImage(textur, -((n * 6) % 320), 0, 1280 + 320, 720);
          ctx.globalAlpha = 1;
          for (let k = 0; k < 40; k += 1) {
            ctx.fillStyle = `hsl(${(n * 7 + k * 31) % 360},80%,60%)`;
            ctx.fillRect((k * 97 + n * 13) % 1200, 80 + ((k * 53 + n * 5) % 580), 80, 60);
          }
          if (quadrat) {
            // Ein grünes Quadrat, 140 x 140, wandert mit 3,3 Punkten je Bild nach rechts.
            ctx.fillStyle = '#20c040';
            ctx.fillRect(100 + 3.3 * n, 300, 140, 140);
          }
          ctx.fillStyle = '#fff';
          ctx.font = '160px sans-serif';
          ctx.fillText(String(n), quadrat ? 440 : 440, quadrat ? 600 : 420);
          // Strichcode: 10 Felder zu 64 x 64, niedrigstes Bit links; Schwarz = 0, Weiss = 1.
          for (let b = 0; b < 10; b += 1) {
            ctx.fillStyle = (n >> b) & 1 ? '#fff' : '#000';
            ctx.fillRect(b * 64, 0, 64, 64);
          }
          return leinwand;
        },
        { breite: W, hoehe: H, bildrate: rate, schluesselAbstand: gop },
      );
      (window as unknown as { __dateien?: Record<string, Blob> }).__dateien ??= {};
      (window as unknown as { __dateien: Record<string, Blob> }).__dateien[`g${gop}`] = datei;
      return Math.round(performance.now() - t0);
    },
    { gop, bilder: BILDER, rate: RATE, quadrat: MIT_MASKE },
  );
}

/** Der Schreiber in der Seite: Zeigerereignisse, Anzeigetakt, Bildmeldungen des Videos. */
async function schreiberEinsetzen(page: Page) {
  await page.evaluate(([strichcode, maskeProbe]) => {
    type Fenster = Window & Record<string, unknown>;
    const fe = window as unknown as Fenster;
    if (fe.__m) return;
    const m = {
      an: false,
      ev: [] as Array<Record<string, number | string>>,
      pr: [] as Array<Record<string, number | string | null>>,
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
      const y = Math.min(flaeche.height - 1, Math.round((32 / 720) * flaeche.height));
      const reihe = c.getImageData(0, y, flaeche.width, 1).data;
      let n = 0;
      for (let b = 0; b < 10; b += 1) {
        const x = Math.round(((b * 64 + 32) / 1280) * flaeche.width);
        const v = (reihe[x * 4] + reihe[x * 4 + 1] + reihe[x * 4 + 2]) / 3;
        if (v > 128) n |= 1 << b;
      }
      return n;
    };
    fe.__strichcode = lesen;

    /** Die Sättigung (max - min) in der Mitte des Quadrats an dem Bild, das die Vorschau gerade meldet – oder -1. */
    const probe = (flaeche: HTMLCanvasElement | null, ms: number): number => {
      if (!flaeche || flaeche.hidden || flaeche.width < 100 || ms < 0) return -1;
      const c = flaeche.getContext('2d');
      if (!c) return -1;
      const n = Math.round(ms / 40);
      const x = Math.round(((100 + 3.3 * n + 70) / 1280) * flaeche.width);
      const y = Math.round((370 / 720) * flaeche.height);
      const d = c.getImageData(Math.min(flaeche.width - 1, Math.max(0, x)), y, 1, 1).data;
      return Math.max(d[0], d[1], d[2]) - Math.min(d[0], d[1], d[2]);
    };
    const sicht = (el: Element | null) => (el && !(el as HTMLElement).hidden ? 1 : 0);
    // Gelesen wird NACH dem Anzeigetakt (setTimeout 0 im Rückruf): Dann haben alle Rückrufe des Takts
    // – auch die der App – schon gezeichnet, und die Probe hängt nicht an der Reihenfolge der Anmeldung.
    const probeNehmen = (jetzt: number) => {
      if (m.an) {
        const v = (fe.__vorschau ?? {}) as { gezeichnet?: number; letzteMs?: number; guete?: number };
        const video = document.querySelector('.bild-editor video.bild-wiedergabe-video') as HTMLVideoElement | null;
        const leinwand = document.querySelector('.bild-editor canvas.bild-wiedergabe-bild') as HTMLCanvasElement | null;
        m.pr.push({
          t: jetzt,
          g: v.gezeichnet ?? -1,
          ms: v.letzteMs ?? -1,
          vt: video ? video.currentTime * 1000 : -1,
          sk: video ? (video.seeking ? 1 : 0) : -1,
          wh: sicht(document.querySelector('.bild-editor .bild-wiedergabe')),
          vn: Number(document.querySelector('.bild-editor .zl-bahn')?.getAttribute('aria-valuenow') ?? -1),
          vm: Number(document.querySelector('.bild-editor .zl-bahn')?.getAttribute('aria-valuemax') ?? -1),
          na: document.querySelectorAll('.bild-editor .zl-abschnitt').length,
          lw: sicht(leinwand),
          sc: strichcode && leinwand && !leinwand.hidden ? lesen(leinwand) : -2,
          px: maskeProbe ? probe(leinwand, v.letzteMs ?? -1) : -2,
          lv: typeof fe.__lebende === 'function' ? (fe.__lebende as () => number)() : -1,
        });
      }
    };
    const tick = (jetzt: number) => {
      requestAnimationFrame(tick);
      setTimeout(() => probeNehmen(jetzt), 0);
    };
    requestAnimationFrame(tick);

    // Jedes Bild, das das Video wirklich anzeigt (= jeder fertige Sprung).
    const rvfcAn = () => {
      const video = document.querySelector('.bild-editor video.bild-wiedergabe-video') as
        | (HTMLVideoElement & { requestVideoFrameCallback?: (f: (j: number, meta: { mediaTime: number; presentedFrames: number }) => void) => number })
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
    const beobachter = new MutationObserver(() => undefined);
    beobachter.disconnect();
  }, [PRUEF_STRICHCODE, MIT_MASKE] as const);
}

interface Lage {
  links: number;
  breite: number;
  y: number;
  gesamtMs: number;
  umfangMs: number;
}

async function lageLesen(page: Page): Promise<Lage> {
  const bahn = page.locator('.bild-editor .zl-bahn');
  const kasten = (await bahn.boundingBox())!;
  const text = (await page.locator('.bild-editor .zl-zeit').textContent()) ?? '';
  const teile = /\/\s*(\d+):(\d+),(\d+)/.exec(text);
  const gesamtMs = teile ? Number(teile[1]) * 60000 + Number(teile[2]) * 1000 + Number(teile[3]) * 10 : 0;
  return {
    links: kasten.x,
    breite: kasten.width,
    y: kasten.y + kasten.height / 2,
    gesamtMs,
    // Die Leiste rechnet so (Zeitleiste.tsx): max(1, gesamt * 1,25, gesamt + 1500).
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
  const griffe = await page
    .locator('.bild-editor .zl-griff')
    .evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return [r.left, r.right]; }));
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
  const film = lage.gesamtMs / lage.umfangMs; // Anteil der Leistenbreite, den der Film einnimmt
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
    params: { type: 'mousePressed', x: x(at(0)), y: lage.y, button: 'left', buttons: 1, clickCount: 1 },
  });
  for (let k = 1; k * (1000 / 60) <= ende; k += 1) {
    const t = k * (1000 / 60);
    ereignisse.push({ t, params: { type: 'mouseMoved', x: x(at(t)), y: lage.y, button: 'left', buttons: 1 } });
  }
  ereignisse.push({
    t: ende + halten,
    params: { type: 'mouseReleased', x: x(at(ende)), y: lage.y, button: 'left', buttons: 0, clickCount: 1 },
  });
  return ereignisse;
}

const SZENARIEN: Record<string, { wege: Stelle[]; halten: number; beschreibung: string }> = {
  schnell: {
    wege: [
      { t: 0, f: 0 },
      { t: 1000, f: 1 },
    ],
    halten: 0,
    beschreibung: '1 s über den ganzen Film, 60 Hz, sofort loslassen',
  },
  langsam: {
    wege: [
      { t: 0, f: 0 },
      { t: 6000, f: 0.93 },
    ],
    halten: 0,
    beschreibung: '6 s über 93 % des Films (endet auf einem anderen Bild als "schnell"), 60 Hz, sofort loslassen',
  },
  hinher: {
    wege: [
      { t: 0, f: 0 },
      { t: 1000, f: 1 },
      { t: 1800, f: 0.3 },
      { t: 2600, f: 0.9 },
      { t: 3200, f: 0.5 },
    ],
    halten: 0,
    beschreibung: 'Hin und her: 0 -> 1 -> 0,3 -> 0,9 -> 0,5 in 3,2 s',
  },
  stopp: {
    wege: [
      { t: 0, f: 0 },
      { t: 600, f: 0.6 },
    ],
    halten: 2000,
    beschreibung: '0,6 s bis 60 %, dann 2 s stillhalten (Finger liegt), loslassen',
  },
};

async function schlafen(ms: number) {
  await new Promise((weiter) => setTimeout(weiter, ms));
}

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

async function zumAnfang(page: Page, cdp: CDPSession) {
  await page.evaluate(() => {
    (window as unknown as { __sprung: { ms: number } }).__sprung.ms = 0;
  });
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
  ).map((e) => e);
  // Der Zug beginnt an `start` (frei von Griffen) und endet ganz links.
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
}

async function editorVorbereiten(page: Page, dateiName: string): Promise<void> {
  await page.evaluate(async (name) => {
    const buehnePfad = '/e2e/buehne.ts';
    const fe = window as unknown as {
      __dateien: Record<string, Blob>;
      __blatt?: { weg: () => void };
    };
    fe.__blatt?.weg();
    const buehne = (await import(/* @vite-ignore */ buehnePfad)) as {
      videoBlattZeigen: (v: Blob) => { fertig: Promise<Blob>; weg: () => void };
    };
    fe.__blatt = buehne.videoBlattZeigen(fe.__dateien[name]);
  }, dateiName);
  const bearbeiten = page.getByRole('button', { name: /Bearbeiten und schneiden/ });
  await expect(bearbeiten).toBeEnabled({ timeout: 90_000 });
  await bearbeiten.click();
  const editor = page.locator('.bild-editor');
  await expect(editor.locator('.bild-wiedergabe')).toBeHidden({ timeout: 40_000 });
  if (!MIT_MASKE) {
    // Bearbeitung: Schwarz-Weiss – dann liegt die bearbeitete Vorschau über dem Video.
    await editor.getByRole('button', { name: /Ton/ }).first().click();
    await editor.getByRole('button', { name: 'Schwarz-Weiss', exact: true }).click();
  }
  // Vier Abschnitte dazu: 5 + 2 + 2 + 2 + 1 s = 12 s, alle mit derselben Bearbeitung.
  for (let i = 0; i < 4; i += 1) {
    await editor.getByRole('button', { name: 'Abschnitt hinzufügen' }).click();
    await expect(editor.locator('.bild-wiedergabe')).toBeHidden({ timeout: 40_000 });
  }
  await expect(editor.locator('.zl-zeit')).toContainText('/ 0:12,00', { timeout: 10_000 });
  if (MIT_MASKE) {
    // Eine Maske auf das Quadrat: Bereiche -> Antippen -> tippen; Sättigung -1; warten, bis sie überall verfolgt ist.
    await editor.locator('.bild-reiter').getByRole('button', { name: /Bereiche/ }).click();
    await editor.getByRole('button', { name: /Antippen aus/ }).click();
    const kasten = (await editor.locator('.bild-leinwand').boundingBox())!;
    // Das Stellbild liegt am Anfang des fünften Abschnitts (Bild 275): Quadrat bei x = 100 + 3,3 * 275.
    const cx = 100 + 3.3 * 275 + 70;
    await page.mouse.click(kasten.x + (cx / 1280) * kasten.width, kasten.y + (370 / 720) * kasten.height);
    await expect(editor.locator('.mb-zeile')).toHaveCount(1, { timeout: 30_000 });
    await editor.getByLabel('Sättigung').last().fill('-1');
    const t0 = Date.now();
    await expect(editor.locator('.mb-leinwand').first()).toHaveAttribute('aria-label', /^sichtbar 0,0 s bis (11,9|12,0) s$/, {
      timeout: 1_200_000,
    });
    console.log(`Maske überall verfolgt nach ${Math.round((Date.now() - t0) / 1000)} s`);
    // „Fertig“ der Maskenzeile (nicht das des Editors): bringt die Knöpfe der Zeitleiste zurück.
    await editor.getByRole('toolbar', { name: /^Maske / }).getByRole('button', { name: 'Fertig' }).click();
    await expect(editor.locator('.bild-wiedergabe')).toBeHidden({ timeout: 40_000 });
  }
}

test('Wischen durch die Zeitleiste: Messung', async ({ page }) => {
  test.setTimeout(3_000_000);
  mkdirSync(AUS, { recursive: true });
  await page.setViewportSize({ width: 412, height: 880 });
  await seiteLaden(page);
  const dauer = await videoMachen(page, GOP);
  if (dauer < 0) {
    test.skip(true, 'Kein Videokodierer in diesem Browser');
    return;
  }
  console.log(`Video (GOP ${GOP}) in ${dauer} ms geschrieben`);
  await editorVorbereiten(page, `g${GOP}`);
  await schreiberEinsetzen(page);
  if (SPEICHER_WARTEN && !SPEICHER_AUS) {
    const t0 = Date.now();
    await page.waitForFunction(
      () => ((window as unknown as { __wisch?: { stufe: number } }).__wisch?.stufe ?? -1) >= 3,
      null,
      { timeout: 900_000, polling: 500 },
    );
    console.log(`Wischspeicher bis Stufe 3 gefüllt nach ${Math.round((Date.now() - t0) / 1000)} s`, JSON.stringify(await page.evaluate(() => (window as unknown as { __wisch: object }).__wisch)));
  }
  const cdp = await page.context().newCDPSession(page);
  if (CPU > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
  if (LOCKER) await page.evaluate(() => { (window as unknown as { __lockerRs: boolean }).__lockerRs = true; });

  for (const sprung of SPRUENGE) {
    for (const name of SZENEN) {
      const szene = SZENARIEN[name];
      if (!szene) throw new Error(`Unbekannte Szene ${name}`);
      await zumAnfang(page, cdp);
      const lage = await lageLesen(page);
      console.log('Lage', JSON.stringify(lage), await page.locator('.bild-editor .zl-bahn').evaluate((el) => ({ max: el.getAttribute('aria-valuemax'), jetzt: el.getAttribute('aria-valuenow'), abschnitte: el.querySelectorAll('.zl-abschnitt').length })));
      await page.evaluate((ms) => {
        const w = window as unknown as { __sprung: { ms: number; angefordert: number; ausgefuehrt: number; ersetzt: number }; __m: { an: boolean; ev: unknown[]; pr: unknown[]; rv: unknown[] }; __rvfcAn: () => void };
        w.__sprung.ms = ms;
        w.__sprung.angefordert = 0;
        w.__sprung.ausgefuehrt = 0;
        w.__sprung.ersetzt = 0;
        (w.__sprung as unknown as { protokoll: unknown[] }).protokoll = [];
        w.__m.ev = [];
        w.__m.pr = [];
        w.__m.rv = [];
        w.__m.an = true;
        (w as unknown as { __verfolger0: unknown }).__verfolger0 = { ...((w as unknown as { __verfolger?: object }).__verfolger ?? {}) };
      }, sprung);
      const f0 = await freiAb(page, lage, 0);
      const zeitplan = plan(szene.wege, szene.halten, lage, f0);
      const dauerMs = await abspielen(cdp, zeitplan);
      // Nach dem Loslassen: warten, bis der Editor das genaue Bild zeigt (oder 25 s).
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
      const erg = await page.evaluate(() => {
        const w = window as unknown as {
          __sprung: unknown;
          __m: { an: boolean; ev: unknown[]; pr: unknown[]; rv: unknown[] };
          __strichcode: (f: HTMLCanvasElement | null) => number;
          __vorschau?: unknown;
        };
        w.__m.an = false;
        const still = document.querySelector('.bild-editor canvas.bild-leinwand') as HTMLCanvasElement | null;
        return {
          ev: w.__m.ev,
          pr: w.__m.pr,
          rv: w.__m.rv,
          sprung: { ...(w.__sprung as object), protokoll: undefined },
          protokoll: (w.__sprung as unknown as { protokoll: unknown[] }).protokoll,
          vorschau: { ...(w.__vorschau as object) },
          wisch: { ...((window as unknown as { __wisch?: object }).__wisch ?? {}), ruhen: undefined },
          stillbild: w.__strichcode(still),
          verfolger: {
            vorher: (window as unknown as { __verfolger0?: unknown }).__verfolger0 ?? null,
            nachher: { ...((window as unknown as { __verfolger?: object }).__verfolger ?? {}) },
          },
        };
      });
      const datei = `${AUS}/${MARKE}-gop${GOP}-sprung${sprung}${CPU > 1 ? `-cpu${CPU}` : ''}-${name}.json`;
      writeFileSync(
        datei,
        JSON.stringify({
          marke: MARKE,
          szene: name,
          beschreibung: szene.beschreibung,
          gop: GOP,
          sprungMs: sprung,
          cpu: CPU,
          s: S,
          bilder: BILDER,
          lage,
          startAnteil: f0,
          dauerMs,
          ...erg,
        }),
      );
      console.log(
        `${name} gop=${GOP} sprung=${sprung}ms cpu=${CPU}: ${erg.ev.length} Ereignisse, ${erg.pr.length} Takte, ${erg.rv.length} Videobilder, Sprünge ${JSON.stringify(erg.sprung)}, Stillbild ${erg.stillbild}`,
      );
    }
  }
});
