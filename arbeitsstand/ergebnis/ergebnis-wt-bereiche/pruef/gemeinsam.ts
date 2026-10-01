import { appendFileSync, writeFileSync } from 'node:fs';
import { expect, type Locator, type Page } from '@playwright/test';

export const SHOTS = '/tmp/claude-0/-home-user-Initiative/b3e47b8f-e30a-5e75-8af6-6e58f2fcbe7c/scratchpad/ergebnis-wt-bereiche/shots';

/**
 * Zwei Gegenstände auf blauem Grund, 320 x 240, zehn Bilder je Sekunde, 50 Bilder:
 *  A (grün, 40 x 40) wandert nach rechts: x = 10 + 8 n, y = 60; ab Bild 39 ist er draussen.
 *  B (orange, 40 x 40) wandert nach unten: x = 150, y = 10 + 4 n.
 *  Bei n = 13 … 22 kreuzen sie sich (B liegt oben).
 */
export async function blattMitZweiGegenstaenden(page: Page, farben: { a: string; b: string; bx?: number; muster?: boolean } = { a: '#20c040', b: '#e08020' }): Promise<boolean> {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  return page.evaluate(async ({ a, b, bx, muster }) => {
    const schreibenPfad = '/src/modules/video/schreiben.ts';
    const buehnePfad = '/e2e/buehne.ts';
    const schreiben = (await import(/* @vite-ignore */ schreibenPfad)) as typeof import('../../wt-bereiche/apps/web/src/modules/video/schreiben.js');
    if (!(await schreiben.videoTauglich(320, 240)).moeglich) return false;
    const leinwand = document.createElement('canvas');
    leinwand.width = 320;
    leinwand.height = 240;
    const ctx = leinwand.getContext('2d') as CanvasRenderingContext2D;
    // Ein nicht wiederholendes Muster, wie in objektFolge.test.ts: nur so sieht die Kamerabahn den ruhenden Grund.
    const grundBild = ctx.createImageData(320, 240);
    for (let y = 0; y < 240; y += 1) {
      for (let x = 0; x < 320; x += 1) {
        const g = 128 + 40 * Math.sin(x / 5.3 + Math.cos(y / 7.1)) * Math.cos(y / 4.7 - x / 13);
        const at = (y * 320 + x) * 4;
        grundBild.data[at] = muster ? g * 0.28 : 36;
        grundBild.data[at + 1] = muster ? g * 0.5 : 64;
        grundBild.data[at + 2] = muster ? g * 0.72 : 92;
        grundBild.data[at + 3] = 255;
      }
    }
    const datei = await schreiben.videoSchreiben(
      50,
      (n) => {
        ctx.putImageData(grundBild, 0, 0);
        ctx.fillStyle = a;
        ctx.fillRect(10 + 8 * n, 60, 40, 40);
        ctx.fillStyle = b;
        ctx.fillRect(bx ?? 150, 10 + 4 * n, 40, 40);
        return leinwand;
      },
      { breite: 320, hoehe: 240, bildrate: 10 },
    );
    const buehne = (await import(/* @vite-ignore */ buehnePfad)) as typeof import('../../wt-bereiche/apps/web/e2e/buehne.js');
    const blatt = buehne.videoBlattZeigen(datei);
    (window as unknown as { fertigerFilm: Promise<Blob> }).fertigerFilm = blatt.fertig;
    return true;
  }, { bx: undefined, muster: false, ...farben });
}

export async function editorOeffnen(page: Page): Promise<Locator> {
  const bearbeiten = page.getByRole('button', { name: /Bearbeiten und schneiden/ });
  await expect(bearbeiten).toBeEnabled({ timeout: 60_000 });
  await bearbeiten.click();
  const editor = page.locator('.bild-editor');
  await expect(editor.locator('.bild-wiedergabe')).toBeHidden({ timeout: 40_000 });
  return editor;
}

export async function reiterBereiche(editor: Locator) {
  await editor.locator('.bild-reiter').getByRole('button', { name: /Bereiche/ }).click();
}

/** Bildschirmfoto der ganzen Seite. */
export async function foto(page: Page, name: string) {
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/** Ein Punkt der Leinwand in Filmkoordinaten (320 x 240) → Bildschirm. */
export async function leinwandPunkt(editor: Locator, x: number, y: number) {
  const kasten = await editor.locator('.bild-leinwand').boundingBox();
  if (!kasten) throw new Error('keine Leinwand');
  return { x: kasten.x + (x / 320) * kasten.width, y: kasten.y + (y / 240) * kasten.height };
}

export async function antippen(page: Page, editor: Locator, x: number, y: number) {
  const p = await leinwandPunkt(editor, x, y);
  await page.mouse.click(p.x, p.y);
}

export function bereichsKnoepfe(editor: Locator): Locator {
  return editor.getByRole('group', { name: 'Bereiche' }).getByRole('button');
}

export function einstellungen(editor: Locator): Locator {
  return editor.getByRole('toolbar', { name: /^Maske / });
}

/** Ein Protokoll, das neben die Bilder geschrieben wird. */
export const protokoll: string[] = [];
export function notiere(zeile: string) {
  protokoll.push(zeile);
  appendFileSync(`${SHOTS}/../protokoll.log`, `${zeile}\n`);
}

/** Was der Anwender an Auswahl sieht: Bereichsknöpfe im Editor, die gewählte Maske in der Zeitleiste. */
export async function zustand(editor: Locator) {
  const knoepfe = await bereichsKnoepfe(editor).evaluateAll((els) =>
    els.map((e) => ({ text: (e.textContent ?? '').trim(), gedrueckt: e.getAttribute('aria-pressed') })),
  );
  const leiste = einstellungen(editor);
  const leisteName = (await leiste.count()) > 0 ? ((await leiste.locator('.mb-name').first().textContent()) ?? '').trim() : null;
  const bahnen = await editor.locator('.mb-zeile').evaluateAll((els) =>
    els.map((e) => ({ gewaehlt: e.classList.contains('ist-gewaehlt'), sammel: e.classList.contains('ist-sammel'), label: e.getAttribute('aria-label') })),
  );
  const teile = await editor.getByRole('group', { name: 'Masken des Bereichs' }).getByRole('button').allTextContents().catch(() => []);
  return { knoepfe, leisteName, bahnen, teile };
}

export async function warteAufFertig(editor: Locator, zeit = 120_000) {
  // Die Zeile „fertig verfolgt" steht in der Einstellungsleiste; ohne gewählte Maske: die Bahnen tragen kein „grau".
  await editor.locator('.mb-name .mb-stand').filter({ hasText: /fertig verfolgt/ }).first().waitFor({ timeout: zeit });
}


/**
 * Den gebauten Film (window.fertigerFilm) an mehreren Zeiten abtasten.
 * Gegenstand A: Mitte bei (30 + 8 n, 80); B: Mitte bei (170, 30 + 4 n); n = Quellbild.
 * Je Zeit: Farbe im Kern und nahe der Ecke jedes Gegenstands, dazu Grund.
 * Bilder der Zeiten in `bilder` werden als PNG unter SHOTS abgelegt.
 */
export async function filmAbtasten(page: Page, zeiten: number[], bilder: { zeit: number; datei: string }[] = [], bxPar = 150) {
  const erg = await page.evaluate(
    async ({ zeiten, bilderZeiten, bxPar }) => {
      const blob = await (window as unknown as { fertigerFilm: Promise<Blob> }).fertigerFilm;
      const video = document.createElement('video');
      video.muted = true;
      video.src = URL.createObjectURL(blob);
      await new Promise((auf) => {
        video.onloadedmetadata = auf;
      });
      const probe = document.createElement('canvas');
      probe.width = video.videoWidth;
      probe.height = video.videoHeight;
      const pctx = probe.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
      const faktor = probe.width / 320;
      const px = (x: number, y: number) => {
        const d = pctx.getImageData(Math.round(x * faktor), Math.round(y * faktor), 1, 1).data;
        return [d[0], d[1], d[2]];
      };
      const reihe: unknown[] = [];
      const pngs: Record<string, string> = {};
      const alle = [...new Set([...zeiten, ...bilderZeiten])].sort((a, b) => a - b);
      for (const t of alle) {
        await new Promise<void>((auf) => {
          video.onseeked = () => auf();
          video.currentTime = t;
        });
        pctx.drawImage(video, 0, 0);
        const n = Math.floor(t * 10 + 1e-6);
        const ax = 10 + 8 * n;
        const by = 10 + 4 * n;
        reihe.push({
          t,
          n,
          aKern: px(ax + 20, 80),
          aEcke: px(ax + 5, 65),
          aSichtbar: ax + 20 < 318,
          bKern: px(bxPar + 20, by + 20),
          bEcke: px(bxPar + 5, by + 5),
          grund1: px(300, 230),
          grund2: px(10, 230),
        });
        if (bilderZeiten.includes(t)) pngs[String(t)] = probe.toDataURL('image/png');
      }
      return { reihe, pngs, breite: probe.width, hoehe: probe.height };
    },
    { zeiten, bilderZeiten: bilder.map((b) => b.zeit), bxPar },
  );
  for (const b of bilder) {
    const url = erg.pngs[String(b.zeit)];
    if (url) writeFileSync(`${SHOTS}/${b.datei}.png`, Buffer.from(url.split(',')[1], 'base64'));
  }
  return erg;
}

export const grau = (p: number[]) => Math.abs(p[0] - p[1]) < 30 && Math.abs(p[1] - p[2]) < 30;

/** Beide Gegenstände in zwei Bereichen anlegen (A = „Antippen", B = „Bereich 2"), beide fertig verfolgt. */
export async function zweiBereiche(page: Page, editor: Locator) {
  await reiterBereiche(editor);
  await editor.getByRole('button', { name: /Antippen aus/ }).click();
  await antippen(page, editor, 30, 80);
  await warteAufFertig(editor);
  await editor.getByRole('button', { name: '＋ Bereich' }).click();
  await page.waitForTimeout(1200);
  await antippen(page, editor, 170, 30);
  await page.waitForTimeout(2000);
  await warteAufFertig(editor);
}

/** Wiedergabestelle um n Sprünge zu je 10 Bildern (400 ms) bewegen. */
export async function springe(page: Page, editor: Locator, n: number) {
  const leiste = editor.getByRole('slider', { name: 'Wiedergabestelle' });
  await leiste.focus();
  const taste = n >= 0 ? 'Shift+ArrowRight' : 'Shift+ArrowLeft';
  for (let i = 0; i < Math.abs(n); i += 1) await leiste.press(taste);
  await page.waitForTimeout(2500);
}

/** Ein Kontaktbogen des gebauten Films: die Bilder an `zeiten`, je 160 x 120, in `spalten` Spalten, mit Zeitmarke. */
export async function filmBogen(page: Page, zeiten: number[], datei: string, spalten = 5) {
  const url = await page.evaluate(
    async ({ zeiten, spalten }) => {
      const blob = await (window as unknown as { fertigerFilm: Promise<Blob> }).fertigerFilm;
      const video = document.createElement('video');
      video.muted = true;
      video.src = URL.createObjectURL(blob);
      await new Promise((auf) => {
        video.onloadedmetadata = auf;
      });
      const zeilen = Math.ceil(zeiten.length / spalten);
      const bogen = document.createElement('canvas');
      bogen.width = spalten * 164;
      bogen.height = zeilen * 124;
      const c = bogen.getContext('2d') as CanvasRenderingContext2D;
      c.fillStyle = '#fff';
      c.fillRect(0, 0, bogen.width, bogen.height);
      for (const [i, t] of zeiten.entries()) {
        await new Promise<void>((auf) => {
          video.onseeked = () => auf();
          video.currentTime = t;
        });
        const x = (i % spalten) * 164 + 2;
        const y = Math.floor(i / spalten) * 124 + 2;
        c.drawImage(video, x, y, 160, 120);
        c.fillStyle = '#000';
        c.font = '11px sans-serif';
        c.fillText(`t=${t}`, x + 3, y + 12);
      }
      return bogen.toDataURL('image/png');
    },
    { zeiten, spalten },
  );
  writeFileSync(`${SHOTS}/${datei}.png`, Buffer.from(url.split(',')[1], 'base64'));
}
